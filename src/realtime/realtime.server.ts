import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import { AuthService } from '../auth/auth.service';
import { JwtVerifier } from '../auth/request/jwt-verifier.service';
import { APP_CONFIG } from '../config/config.module';
import type { AppConfig } from '../config/env.schema';
import type { JwtClaims } from '../db/db-context.service';
import { PgListener } from '../db/pg-listener.service';
import {
  CLOSE,
  isUuid,
  MAX_MESSAGE_BYTES,
  NOTIFICATIONS_CHANNEL_PREFIX,
  parseClientMessage,
  parseNotificationChange,
  REALTIME_PATH,
  type ClientMessage,
  type NotificationChange,
  type ServerMessage,
} from './realtime.protocol';
import { RealtimeRepository } from './realtime.repository';

interface Identity {
  userId: string;
  sessionId: string | null;
  claims: JwtClaims;
  /** Token'ın bitişi (ms). */
  expiresAt: number;
}

/**
 * Tek bir WebSocket bağlantısı. Mesajları ve olayları sırayla işler
 * (`enqueue`): auth bitmeden gelen subscribe, ya da aynı satırın INSERT ve
 * UPDATE'i karışmaz.
 */
class Connection {
  identity: Identity | null = null;
  readonly channels = new Set<string>();
  alive = true;
  readonly openedAt = Date.now();
  private chain: Promise<void> = Promise.resolve();
  private authTimer: NodeJS.Timeout | null = null;
  private expiryTimer: NodeJS.Timeout | null = null;
  private sessionTimer: NodeJS.Timeout | null = null;
  closed = false;

  constructor(readonly ws: WebSocket) {}

  enqueue(work: () => Promise<void>): void {
    this.chain = this.chain
      .then(async () => {
        if (this.closed) return;
        await work();
      })
      // Beklenmeyen hata zinciri kırmasın; bağlantı kapanır, istemci
      // yeniden bağlanıp gelen kutusunu okur.
      .catch(() => this.close(1011, 'internal_error'));
  }

  send(message: ServerMessage): void {
    if (this.closed || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(message));
  }

  close(code: number, reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.clearTimers();
    this.ws.close(code, reason);
  }

  setAuthTimer(ms: number, onTimeout: () => void): void {
    this.authTimer = setTimeout(onTimeout, ms);
  }

  setExpiry(ms: number, onExpire: () => void): void {
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    // setTimeout'un üst sınırı ~24,8 gün; token en çok 1 gün.
    this.expiryTimer = setTimeout(
      onExpire,
      Math.max(0, Math.min(ms, 2 ** 31 - 1)),
    );
  }

  setSessionCheck(ms: number, onCheck: () => void): void {
    if (this.sessionTimer) clearInterval(this.sessionTimer);
    this.sessionTimer = setInterval(onCheck, ms);
  }

  clearAuthTimer(): void {
    if (this.authTimer) clearTimeout(this.authTimer);
    this.authTimer = null;
  }

  clearTimers(): void {
    this.clearAuthTimer();
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    if (this.sessionTimer) clearInterval(this.sessionTimer);
    this.expiryTimer = null;
    this.sessionTimer = null;
  }
}

/**
 * `GET /realtime` — gelen kutusunun canlı akışı (S11, K11). Supabase
 * Realtime'ın `postgres_changes` aboneliğinin yerine; sözleşme
 * `docs/api/realtime.md`.
 *
 * Güvenlik kuralları:
 * - Kimlik bağlandıktan sonraki ilk mesajla (`{type:'auth', token}`),
 *   `REALTIME_AUTH_TIMEOUT_MS` içinde. Yalnızca kullanıcı token'ı
 *   (`authenticated`); anon ve service_role 4001. Token'ın oturumu
 *   `/auth/user` kuralıyla denetlenir (çıkış yapılmış, silinmiş, yasaklı →
 *   4001) ve bu denetim `REALTIME_SESSION_CHECK_MS`'de bir tekrarlanır.
 *   Token süresi dolunca 4001; istemci dolmadan yeni token'ı aynı mesajla
 *   gönderir (aynı kullanıcı olmalı, değilse 4003).
 * - Yalnızca kendi kanalına abone olunur: `notifications:<token.sub>`;
 *   başkasınınki 4003.
 * - Her olayda satır abonenin kimliğiyle ve RLS'iyle okunur
 *   (`get_notification`); göremediği satır (başkasının, silinmiş, hesabı
 *   pasif) gitmez. NOTIFY yükü yalnızca yönlendirme içindir.
 * - Tarayıcıdan gelen bağlantının `Origin`'i `CORS_ORIGINS`'te olmalı.
 *
 * Birden fazla API süreci: her süreç kendi LISTEN'ı ve kendi soketleriyle
 * çalışır; bir NOTIFY bütün süreçlere gider, her biri yalnızca kendi
 * soketlerine yollar. Ortak durum yok.
 */
@Injectable()
export class RealtimeServer
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(RealtimeServer.name);
  private readonly wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_MESSAGE_BYTES,
    perMessageDeflate: false,
  });
  private readonly connections = new Set<Connection>();
  /** Kimliği doğrulanmış bağlantılar, kullanıcıya göre. */
  private readonly byUser = new Map<string, Set<Connection>>();
  private heartbeat: NodeJS.Timeout | null = null;
  private httpServer: Server | null = null;
  private readonly unsubscribe: (() => void)[] = [];

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly adapterHost: HttpAdapterHost,
    private readonly verifier: JwtVerifier,
    private readonly auth: AuthService,
    private readonly repo: RealtimeRepository,
    private readonly listener: PgListener,
  ) {}

  onApplicationBootstrap(): void {
    this.httpServer = this.adapterHost.httpAdapter.getHttpServer() as Server;
    this.httpServer.on('upgrade', this.onUpgrade);
    this.unsubscribe.push(
      this.listener.on('notifications_changed', (payload) =>
        this.onNotify(payload),
      ),
      this.listener.onConnected(({ reconnected }) => {
        if (reconnected) this.resyncAll();
      }),
    );
    this.heartbeat = setInterval(
      () => this.beat(),
      this.config.REALTIME_HEARTBEAT_MS,
    );
    this.heartbeat.unref();
  }

  onApplicationShutdown(): void {
    this.unsubscribe.forEach((u) => u());
    this.httpServer?.off('upgrade', this.onUpgrade);
    if (this.heartbeat) clearInterval(this.heartbeat);
    for (const conn of this.connections) {
      conn.close(CLOSE.goingAway, 'server_shutdown');
      conn.ws.terminate();
    }
    this.connections.clear();
    this.byUser.clear();
    this.wss.close();
  }

  /** Açık bağlantı sayısı (testler için). */
  get connectionCount(): number {
    return this.connections.size;
  }

  // ------------------------------------------------------------- bağlantı

  private readonly onUpgrade = (
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): void => {
    const path = (req.url ?? '').split('?')[0];
    if (path !== REALTIME_PATH) {
      reject(socket, 404, 'Not Found');
      return;
    }
    const origin = req.headers.origin;
    if (origin !== undefined && !this.config.CORS_ORIGINS.includes(origin)) {
      reject(socket, 403, 'Forbidden');
      return;
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => this.accept(ws));
  };

  private accept(ws: WebSocket): void {
    const conn = new Connection(ws);
    this.connections.add(conn);
    conn.setAuthTimer(this.config.REALTIME_AUTH_TIMEOUT_MS, () =>
      conn.close(CLOSE.unauthorized, 'auth_timeout'),
    );
    ws.on('pong', () => {
      conn.alive = true;
    });
    ws.on('message', (data: RawData, isBinary: boolean) => {
      conn.alive = true;
      if (isBinary) {
        conn.close(CLOSE.badMessage, 'bad_message');
        return;
      }
      const message = parseClientMessage(rawToString(data));
      if (!message) {
        conn.close(CLOSE.badMessage, 'bad_message');
        return;
      }
      conn.enqueue(() => this.handle(conn, message));
    });
    ws.on('close', () => this.forget(conn));
    ws.on('error', () => this.forget(conn));
  }

  private forget(conn: Connection): void {
    conn.closed = true;
    conn.clearTimers();
    this.connections.delete(conn);
    if (conn.identity) {
      const set = this.byUser.get(conn.identity.userId);
      set?.delete(conn);
      if (set && set.size === 0) this.byUser.delete(conn.identity.userId);
    }
  }

  private async handle(
    conn: Connection,
    message: ClientMessage,
  ): Promise<void> {
    if (message.type === 'auth') {
      await this.authenticate(conn, message.token);
      return;
    }
    if (!conn.identity) {
      conn.close(CLOSE.unauthorized, 'auth_required');
      return;
    }
    switch (message.type) {
      case 'subscribe': {
        if (!this.ownsChannel(conn.identity, message.channel)) {
          conn.close(CLOSE.forbidden, 'channel_forbidden');
          return;
        }
        const channel = message.channel.toLowerCase();
        conn.channels.add(channel);
        conn.send({ type: 'subscribed', channel });
        return;
      }
      case 'unsubscribe': {
        const channel = message.channel.toLowerCase();
        conn.channels.delete(channel);
        conn.send({ type: 'unsubscribed', channel });
        return;
      }
      case 'ping':
        conn.send({ type: 'pong' });
        return;
    }
  }

  private ownsChannel(identity: Identity, channel: string): boolean {
    if (!channel.startsWith(NOTIFICATIONS_CHANNEL_PREFIX)) return false;
    const id = channel.slice(NOTIFICATIONS_CHANNEL_PREFIX.length);
    return isUuid(id) && id.toLowerCase() === identity.userId;
  }

  private async authenticate(conn: Connection, token: string): Promise<void> {
    let identity: Identity;
    try {
      const auth = this.verifier.verify(token);
      if (auth.role !== 'authenticated') throw new Error('anon');
      const exp = auth.claims.exp;
      const sessionId = auth.claims.session_id;
      identity = {
        userId: String(auth.claims.sub).toLowerCase(),
        sessionId:
          typeof sessionId === 'string' && isUuid(sessionId) ? sessionId : null,
        claims: auth.claims,
        // `exp` yoksa token sonsuz değildir: JWT_EXPIRY_SEC kadar sayılır.
        expiresAt:
          typeof exp === 'number'
            ? exp * 1000
            : Date.now() + this.config.JWT_EXPIRY_SEC * 1000,
      };
    } catch {
      conn.close(CLOSE.unauthorized, 'invalid_token');
      return;
    }
    if (conn.identity && conn.identity.userId !== identity.userId) {
      conn.close(CLOSE.forbidden, 'user_changed');
      return;
    }
    if (!(await this.sessionOpen(identity))) {
      conn.close(CLOSE.unauthorized, 'session_ended');
      return;
    }
    if (conn.closed) return;

    const first = conn.identity === null;
    conn.identity = identity;
    conn.clearAuthTimer();
    conn.setExpiry(identity.expiresAt - Date.now(), () =>
      conn.close(CLOSE.unauthorized, 'token_expired'),
    );
    conn.setSessionCheck(this.config.REALTIME_SESSION_CHECK_MS, () =>
      conn.enqueue(async () => {
        const current = conn.identity;
        if (current && !(await this.sessionOpen(current))) {
          conn.close(CLOSE.unauthorized, 'session_ended');
        }
      }),
    );
    if (first) this.register(conn, identity.userId);
    conn.send({
      type: 'ready',
      user_id: identity.userId,
      expires_at: Math.floor(identity.expiresAt / 1000),
    });
  }

  private register(conn: Connection, userId: string): void {
    let set = this.byUser.get(userId);
    if (!set) {
      set = new Set();
      this.byUser.set(userId, set);
    }
    set.add(conn);
    // Kopmuş ama heartbeat'in henüz düşürmediği eski bağlantılar yenisini
    // engellemesin: sınır aşılınca en eskisi kapanır.
    while (set.size > this.config.REALTIME_MAX_SOCKETS_PER_USER) {
      const oldest = [...set].sort((a, b) => a.openedAt - b.openedAt)[0];
      set.delete(oldest);
      oldest.close(CLOSE.tooManyConnections, 'too_many_connections');
    }
  }

  private async sessionOpen(identity: Identity): Promise<boolean> {
    try {
      await this.auth.getUser({
        userId: identity.userId,
        sessionId: identity.sessionId,
      });
      return true;
    } catch {
      return false;
    }
  }

  // ---------------------------------------------------------------- olaylar

  private onNotify(payload: string): void {
    const change = parseNotificationChange(payload);
    if (!change) {
      this.logger.warn('Tanınmayan notifications_changed yükü atlandı');
      return;
    }
    const conns = this.byUser.get(change.recipientId);
    if (!conns) return;
    const channel = NOTIFICATIONS_CHANNEL_PREFIX + change.recipientId;
    for (const conn of conns) {
      if (!conn.channels.has(channel)) continue;
      conn.enqueue(() => this.deliver(conn, channel, change));
    }
  }

  private async deliver(
    conn: Connection,
    channel: string,
    change: NotificationChange,
  ): Promise<void> {
    const identity = conn.identity;
    if (!identity) return;
    let record: Record<string, unknown> | null;
    try {
      record = await this.repo.getNotification(identity.claims, change.id);
    } catch (err) {
      // Okunamadı: olay kaybolmasın, istemci listeyi yeniden okusun.
      this.logger.warn({ err }, 'Gelen kutusu olayı okunamadı; resync');
      conn.send({ type: 'resync', channel });
      return;
    }
    if (!record || !conn.channels.has(channel)) return;
    conn.send({ type: 'event', channel, event: change.op, record });
  }

  /** LISTEN koptu ve döndü: arada kaçan olaylar için "yeniden oku". */
  private resyncAll(): void {
    for (const conn of this.connections) {
      for (const channel of conn.channels) {
        conn.enqueue(() => {
          conn.send({ type: 'resync', channel });
          return Promise.resolve();
        });
      }
    }
  }

  private beat(): void {
    for (const conn of this.connections) {
      if (!conn.alive) {
        conn.ws.terminate();
        this.forget(conn);
        continue;
      }
      conn.alive = false;
      try {
        conn.ws.ping();
      } catch {
        // Kapanmakta olan soket; close olayı temizler.
      }
    }
  }
}

function reject(socket: Duplex, status: number, text: string): void {
  socket.write(
    `HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
  );
  socket.destroy();
}

function rawToString(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  return data.toString('utf8');
}
