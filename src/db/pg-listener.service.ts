import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { Client, type Notification } from 'pg';
import { APP_CONFIG } from '../config/config.module';
import type { AppConfig } from '../config/env.schema';

/** Veritabanının API'yi dürttüğü kanallar (K10). */
export const LISTEN_CHANNELS = [
  'push_dispatch',
  'notifications_changed',
] as const;
export type ListenChannel = (typeof LISTEN_CHANNELS)[number];

export type NotifyHandler = (payload: string) => void;
/** `reconnected`: ilk bağlantı değil, kopan bağlantının dönüşü. */
export type ConnectedHandler = (event: { reconnected: boolean }) => void;

/** `pg_stat_activity`'de bu bağlantının adı (testler bununla koparır). */
export const LISTEN_APPLICATION_NAME = 'mobil-spor-okulu-listen';

const KEEPALIVE_MS = 30_000;
const MAX_BACKOFF_MS = 30_000;

/**
 * Havuz dışı tek bir bağlantıyla `LISTEN` (S11). Havuzdaki bağlantılar her
 * istekte rol değiştirip geri dönüyor; LISTEN ise bağlantıya bağlı ve sürekli
 * açık kalmalı, bu yüzden ayrı.
 *
 * Bağlantı `api_authenticator` olarak açılır: LISTEN yetki istemez, rol
 * geçişi gerekmez, tabloya da dokunulmaz. Kanallardaki yükler kimlik
 * taşımaz (push: boş; gelen kutusu: satır kimliği) — okuma her zaman
 * DbContextService üzerinden, doğru rolle yapılır.
 *
 * Bağlantı koparsa (Postgres yeniden başladı, ağ gitti, 30 sn'lik
 * `select 1` cevapsız kaldı) üstel bekleyişle yeniden bağlanır ve
 * `onConnected` dinleyicilerine `reconnected: true` der. Arada kaçan
 * bildirimler geri gelmez; dinleyiciler bunu kendisi telafi eder (push:
 * kuyruğa bakar, realtime: istemcilere "yeniden oku" der).
 */
@Injectable()
export class PgListener
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(PgListener.name);
  private readonly handlers = new Map<ListenChannel, Set<NotifyHandler>>();
  private readonly connectedHandlers = new Set<ConnectedHandler>();
  private client: Client | null = null;
  private stopped = false;
  private connectedOnce = false;
  private attempt = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private keepaliveTimer: NodeJS.Timeout | null = null;
  private readyWaiters: (() => void)[] = [];

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  /** Bir kanala dinleyici ekler; dönen fonksiyon çıkarır. */
  on(channel: ListenChannel, handler: NotifyHandler): () => void {
    let set = this.handlers.get(channel);
    if (!set) {
      set = new Set();
      this.handlers.set(channel, set);
    }
    set.add(handler);
    return () => set.delete(handler);
  }

  /** Her başarılı bağlantıda (ilk ve sonrakiler) çağrılır. */
  onConnected(handler: ConnectedHandler): () => void {
    this.connectedHandlers.add(handler);
    return () => this.connectedHandlers.delete(handler);
  }

  /** Şu anda LISTEN ediyor mu. */
  get listening(): boolean {
    return this.client !== null;
  }

  /** LISTEN bağlantısı açılınca çözülür (testler ve açılış sırası için). */
  ready(): Promise<void> {
    if (this.client) return Promise.resolve();
    return new Promise((resolve) => this.readyWaiters.push(resolve));
  }

  onApplicationBootstrap(): void {
    // Açılışı veritabanına bağlamaz: bağlanamazsa arka planda yeniden dener.
    void this.connect();
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.stopKeepalive();
    const client = this.client;
    this.client = null;
    if (client) await client.end().catch(() => undefined);
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    const client = new Client({
      connectionString: this.config.API_DATABASE_URL,
      application_name: LISTEN_APPLICATION_NAME,
      keepAlive: true,
      connectionTimeoutMillis: 5_000,
    });
    let failed = false;
    const onLost = (err?: Error) => {
      if (failed) return;
      failed = true;
      if (this.client === client) {
        this.client = null;
        this.stopKeepalive();
      }
      if (this.stopped) return;
      this.logger.warn(
        { err },
        'LISTEN bağlantısı koptu; yeniden bağlanılacak',
      );
      client.end().catch(() => undefined);
      this.scheduleReconnect();
    };
    client.on('error', onLost);
    client.on('end', () => onLost());
    client.on('notification', (msg) => this.dispatch(msg));

    try {
      await client.connect();
      for (const channel of LISTEN_CHANNELS) {
        // Kanal adları sabit tanımlayıcı (yukarıdaki liste); kullanıcı girdisi değil.
        await client.query(`listen ${channel}`);
      }
    } catch (err) {
      onLost(err as Error);
      return;
    }
    if (failed || this.stopped) {
      await client.end().catch(() => undefined);
      return;
    }

    this.client = client;
    this.attempt = 0;
    const reconnected = this.connectedOnce;
    this.connectedOnce = true;
    this.startKeepalive(client);
    if (reconnected) this.logger.log('LISTEN bağlantısı yeniden kuruldu');
    const waiters = this.readyWaiters;
    this.readyWaiters = [];
    waiters.forEach((w) => w());
    for (const handler of this.connectedHandlers) {
      try {
        handler({ reconnected });
      } catch (err) {
        this.logger.error({ err }, 'LISTEN bağlantı dinleyicisi hata verdi');
      }
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    const delay = Math.min(MAX_BACKOFF_MS, 500 * 2 ** this.attempt);
    this.attempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, delay);
    this.reconnectTimer.unref();
  }

  private startKeepalive(client: Client): void {
    this.stopKeepalive();
    // TCP keepalive'ın göremediği "açık ama cevapsız" bağlantı için.
    this.keepaliveTimer = setInterval(() => {
      const timeout = setTimeout(
        () => client.emit('error', new Error('keepalive zaman aşımı')),
        10_000,
      );
      timeout.unref();
      client
        .query('select 1')
        .catch((err: Error) => client.emit('error', err))
        .finally(() => clearTimeout(timeout));
    }, KEEPALIVE_MS);
    this.keepaliveTimer.unref();
  }

  private stopKeepalive(): void {
    if (this.keepaliveTimer) clearInterval(this.keepaliveTimer);
    this.keepaliveTimer = null;
  }

  private dispatch(msg: Notification): void {
    const set = this.handlers.get(msg.channel as ListenChannel);
    if (!set) return;
    for (const handler of set) {
      try {
        handler(msg.payload ?? '');
      } catch (err) {
        this.logger.error(
          { err, channel: msg.channel },
          'NOTIFY dinleyicisi hata verdi',
        );
      }
    }
  }
}
