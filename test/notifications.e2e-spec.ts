import type { Server } from 'node:http';
import type { INestApplication } from '@nestjs/common';
import jwt from 'jsonwebtoken';
import { Client, type Notification } from 'pg';
import request from 'supertest';
import type { App } from 'supertest/types';
import {
  LISTEN_APPLICATION_NAME,
  PgListener,
} from '../src/db/pg-listener.service';
import { PushWorker } from '../src/push/push.worker';
import { RealtimeServer } from '../src/realtime/realtime.server';
import {
  ATHLETES,
  SCHOOL_A,
  SCHOOL_B,
  SEED_PASSWORD,
  USERS,
} from './fixtures/seed-ids';
import { createTestApp, fcmOf, TEST_JWT_SECRET } from './support/app';
import { startTestDatabase, type TestDatabase } from './support/database';
import { fcmErrorBody, type FakeFcm } from './support/fake-fcm';
import { supabaseAnonKey, supabaseServiceRoleKey } from './support/tokens';
import { TestWs } from './support/ws-client';
import { WebSocket } from 'ws';

/**
 * S11 — gelen kutusunun canlı akışı (`GET /realtime`), push kuyruğu (ex
 * send-push) ve cron işleri, gerçek Postgres'e karşı.
 */
describe('Bildirimler: realtime, push, cron (gerçek Postgres)', () => {
  let db: TestDatabase;
  let app: INestApplication<App>;
  let pg: Client;
  let fcm: FakeFcm;
  let worker: PushWorker;
  let baseUrl: string;
  const sockets: TestWs[] = [];

  const PARENT_A = USERS.a.parent;
  const COACH_A = USERS.a.coach;
  const PARENT_B = USERS.b.parent;
  const EMAIL: Record<string, string> = {
    [PARENT_A]: 'veli@a.test',
    [COACH_A]: 'antrenor@a.test',
    [PARENT_B]: 'veli@b.test',
    [USERS.a.passiveParent]: 'pasif.veli@a.test',
    [USERS.a.branchManager]: 'sube.muduru@a.test',
  };
  const channelOf = (id: string) => `notifications:${id}`;

  beforeAll(async () => {
    db = await startTestDatabase({ seed: true });
    pg = new Client({ connectionString: db.url });
    await pg.connect();
    app = await createTestApp(db, {
      REALTIME_AUTH_TIMEOUT_MS: '500',
      REALTIME_SESSION_CHECK_MS: '300',
      REALTIME_HEARTBEAT_MS: '300',
      REALTIME_MAX_SOCKETS_PER_USER: '3',
      PUSH_SWEEP_INTERVAL_MS: '0',
    });
    await app.listen(0);
    const address = (app.getHttpServer() as unknown as Server).address() as {
      port: number;
    };
    baseUrl = `ws://127.0.0.1:${address.port}`;
    fcm = fcmOf(app);
    worker = app.get(PushWorker);
    await app.get(PgListener).ready();
  });

  afterEach(async () => {
    await Promise.all(sockets.splice(0).map((s) => s.close()));
    fcm.reset();
    await worker.idle();
  });

  afterAll(async () => {
    await app?.close();
    await pg?.end();
    await db?.stop();
  });

  // ------------------------------------------------------------ yardımcılar

  const http = () => request(app.getHttpServer());

  async function login(userId: string): Promise<string> {
    const res = await http()
      .post('/auth/token?grant_type=password')
      .send({ email: EMAIL[userId], password: SEED_PASSWORD })
      .expect(200);
    return (res.body as { access_token: string }).access_token;
  }

  /** Aynı oturumun token'ı, başka bir bitişle (yenilenmiş token gibi). */
  function withExpiry(token: string, expiresInSec: number): string {
    const claims = jwt.decode(token) as Record<string, unknown>;
    return jwt.sign(
      { ...claims, exp: Math.floor(Date.now() / 1000) + expiresInSec },
      TEST_JWT_SECRET,
      { algorithm: 'HS256' },
    );
  }

  function connect(options: { origin?: string } = {}): TestWs {
    const ws = new TestWs(`${baseUrl}/realtime`, options);
    sockets.push(ws);
    return ws;
  }

  async function subscribed(userId: string, token?: string): Promise<TestWs> {
    const ws = connect();
    await ws.opened;
    await ws.auth(token ?? (await login(userId)));
    await ws.subscribe(channelOf(userId));
    return ws;
  }

  async function insertNotification(
    recipient: string,
    options: {
      type?: string;
      params?: Record<string, unknown>;
      school?: string;
      createdAt?: string;
    } = {},
  ): Promise<string> {
    const { rows } = await pg.query<{ id: string }>(
      `insert into public.notifications (school_id, recipient_id, type, params, created_at)
       values ($1, $2, $3, $4, coalesce($5::timestamptz, now())) returning id`,
      [
        options.school ?? (recipient === PARENT_B ? SCHOOL_B : SCHOOL_A),
        recipient,
        options.type ?? 'announcement',
        JSON.stringify(options.params ?? { title: 'Duyuru', body: 'Metin' }),
        options.createdAt ?? null,
      ],
    );
    return rows[0].id;
  }

  /** Sonraki mesajın şu satırın olayı olduğunu doğrular. */
  async function expectNextEvent(
    ws: TestWs,
    id: string,
    event: 'INSERT' | 'UPDATE' = 'INSERT',
  ) {
    const msg = await ws.next();
    expect(msg).toMatchObject({ type: 'event', event });
    expect((msg.record as { id: string }).id).toBe(id);
    return msg;
  }

  async function waitFor(
    sql: string,
    params: unknown[],
    predicate: (row: Record<string, unknown>) => boolean,
    timeoutMs = 5_000,
  ): Promise<Record<string, unknown>> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const { rows } = await pg.query<Record<string, unknown>>(sql, params);
      if (rows[0] && predicate(rows[0])) return rows[0];
      if (Date.now() > deadline) {
        throw new Error(`koşul gelmedi: ${JSON.stringify(rows[0])}`);
      }
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  const rowOf = (id: string) =>
    waitFor(
      'select push_status, push_attempts, pushed_at from public.notifications where id = $1',
      [id],
      () => true,
    );

  // ========================================================== realtime

  describe('realtime: bağlantı ve kimlik', () => {
    it('kendi kanalına abone olan veli INSERT olayını satırın tamamıyla alır', async () => {
      const ws = await subscribed(PARENT_A);
      const id = await insertNotification(PARENT_A, {
        type: 'attendance_result',
        params: { athlete_id: ATHLETES.deniz, status: 'present' },
      });
      const msg = await expectNextEvent(ws, id);
      expect(msg.channel).toBe(channelOf(PARENT_A));
      const record = msg.record as Record<string, unknown>;
      // get_notification = to_jsonb(row): bütün sütunlar.
      expect(record).toMatchObject({
        id,
        recipient_id: PARENT_A,
        type: 'attendance_result',
        read_at: null,
        push_status: 'pending',
        is_deleted: false,
      });
      expect(Object.keys(record).sort()).toEqual(
        [
          'announcement_id',
          'created_at',
          'dedupe_key',
          'direct_message_id',
          'id',
          'is_deleted',
          'params',
          'push_attempts',
          'push_claimed_at',
          'push_status',
          'pushed_at',
          'read_at',
          'recipient_id',
          'school_id',
          'type',
        ].sort(),
      );
    });

    it('ready token bitişini, ping pong’u döner', async () => {
      const ws = connect();
      await ws.opened;
      const token = await login(PARENT_A);
      const ready = await ws.auth(token);
      expect(ready).toEqual({
        type: 'ready',
        user_id: PARENT_A,
        expires_at: (jwt.decode(token) as { exp: number }).exp,
      });
      ws.send({ type: 'ping' });
      expect(await ws.next()).toEqual({ type: 'pong' });
    });

    it('başka kullanıcının olayı gitmez (okul içi ve okullar arası)', async () => {
      const coach = await subscribed(COACH_A);
      const parentB = await subscribed(PARENT_B);
      await insertNotification(PARENT_A);
      const ownCoach = await insertNotification(COACH_A);
      const ownB = await insertNotification(PARENT_B);
      // İlk gelen kendi satırları: PARENT_A'nınki hiçbirine gitmedi.
      await expectNextEvent(coach, ownCoach);
      await expectNextEvent(parentB, ownB);
      expect(coach.pending).toBe(0);
      expect(parentB.pending).toBe(0);
    });

    it('başkasının kanalına abonelik (kanal sahteciliği) 4003 ile kapanır', async () => {
      const ws = connect();
      await ws.opened;
      await ws.auth(await login(COACH_A));
      ws.send({ type: 'subscribe', channel: channelOf(PARENT_A) });
      expect(await ws.closed).toEqual({
        code: 4003,
        reason: 'channel_forbidden',
      });
    });

    it.each([
      ['büyük harfli başka kimlik', () => channelOf(PARENT_A.toUpperCase())],
      ['önekli', () => `realtime:${channelOf(COACH_A)}`],
      ['joker', () => 'notifications:*'],
    ])('geçersiz kanal 4003: %s', async (_, channel) => {
      const ws = connect();
      await ws.opened;
      await ws.auth(await login(COACH_A));
      ws.send({ type: 'subscribe', channel: channel() });
      expect((await ws.closed).code).toBe(4003);
    });

    it('auth olmadan abonelik 4001; hiç mesaj göndermeyen bağlantı süre dolunca 4001', async () => {
      const early = connect();
      await early.opened;
      early.send({ type: 'subscribe', channel: channelOf(PARENT_A) });
      expect(await early.closed).toEqual({
        code: 4001,
        reason: 'auth_required',
      });

      const silent = connect();
      await silent.opened;
      expect(await silent.closed).toEqual({
        code: 4001,
        reason: 'auth_timeout',
      });
      expect(silent.messages).toEqual([]);
    });

    it.each([
      ['anon anahtarı', () => supabaseAnonKey()],
      ['service_role anahtarı', () => supabaseServiceRoleKey()],
      [
        'başka anahtarla imzalı',
        () =>
          jwt.sign(
            { sub: PARENT_A, role: 'authenticated', aud: 'authenticated' },
            'x'.repeat(40),
          ),
      ],
      ['bozuk', () => 'a.b.c'],
    ])('geçersiz token reddedilir: %s', async (_, token) => {
      const ws = connect();
      await ws.opened;
      ws.send({ type: 'auth', token: token() });
      expect(await ws.closed).toEqual({ code: 4001, reason: 'invalid_token' });
    });

    it('süresi geçmiş token ve kapalı oturumun token’ı reddedilir', async () => {
      const token = await login(PARENT_A);
      const expired = connect();
      await expired.opened;
      expired.send({ type: 'auth', token: withExpiry(token, -10) });
      expect((await expired.closed).code).toBe(4001);

      await http()
        .post('/auth/logout?scope=local')
        .set('Authorization', `Bearer ${token}`)
        .expect(204);
      const loggedOut = connect();
      await loggedOut.opened;
      loggedOut.send({ type: 'auth', token });
      expect(await loggedOut.closed).toEqual({
        code: 4001,
        reason: 'session_ended',
      });
    });

    it('bozuk mesaj 4000', async () => {
      const ws = connect();
      await ws.opened;
      ws.send('{değil json');
      expect((await ws.closed).code).toBe(4000);
    });

    it('yanlış yol 404, izinsiz Origin 403; izinli Origin bağlanır', async () => {
      const wrong = connect();
      const wrongPath = new TestWs(`${baseUrl}/realtime/x`);
      sockets.push(wrongPath);
      await expect(wrongPath.opened).rejects.toThrow('404');
      await wrong.opened;
      const evil = connect({ origin: 'https://kotu.example' });
      await expect(evil.opened).rejects.toThrow('403');
      const allowed = connect({ origin: 'https://yonetim.mobilsporokulu.com' });
      await allowed.opened;
    });
  });

  describe('realtime: olay kuralları', () => {
    it('UPDATE yalnızca satır yeniden canlanınca gider (veli isRevived)', async () => {
      const ws = await subscribed(PARENT_A);
      const id = await insertNotification(PARENT_A);
      await expectNextEvent(ws, id);

      // Okundu işareti ve push durumu yazımları olay üretmez.
      await pg.query(
        `update public.notifications set read_at = now(), push_status = 'sent' where id = $1`,
        [id],
      );
      // Yoklama düzeltmesi: okunmamış + push yeniden kuyrukta.
      await pg.query(
        `update public.notifications set read_at = null, push_status = 'pending',
                params = params || '{"status":"absent"}' where id = $1`,
        [id],
      );
      const msg = await expectNextEvent(ws, id, 'UPDATE');
      expect(msg.record).toMatchObject({
        read_at: null,
        push_status: 'pending',
      });
      expect(ws.pending).toBe(0);
    });

    it('uydurma NOTIFY başkasının satırını getirmez (yetki RLS’te)', async () => {
      const ws = await subscribed(PARENT_A);
      const foreign = await insertNotification(PARENT_B);
      // Yük PARENT_A'ya yönlendiriyor ama satır PARENT_B'nin.
      await pg.query(`select pg_notify('notifications_changed', $1)`, [
        JSON.stringify({ op: 'INSERT', id: foreign, recipient_id: PARENT_A }),
      ]);
      await pg.query(`select pg_notify('notifications_changed', 'çöp')`);
      const own = await insertNotification(PARENT_A);
      await expectNextEvent(ws, own);
      expect(ws.pending).toBe(0);
    });

    it('bağlantı açıkken hesap pasif ya da silinmiş olursa olay gitmez', async () => {
      const ws = await subscribed(PARENT_A);
      // Yetki olay teslim edilirken denetlenir: hesap durumu, kuyruktaki
      // teslim bitmeden geri alınmasın (ping'in pong'u kuyrukta sonra gelir).
      const settle = async () => {
        await new Promise((r) => setTimeout(r, 300));
        ws.send({ type: 'ping' });
        expect(await ws.next()).toEqual({ type: 'pong' });
      };
      try {
        await pg.query(
          `update public.profiles set status = 'passive' where id = $1`,
          [PARENT_A],
        );
        await insertNotification(PARENT_A);
        await settle();
        await pg.query(
          `update public.profiles set status = 'active', is_deleted = true where id = $1`,
          [PARENT_A],
        );
        await insertNotification(PARENT_A);
        await settle();
      } finally {
        await pg.query(
          `update public.profiles set status = 'active', is_deleted = false where id = $1`,
          [PARENT_A],
        );
      }
      const after = await insertNotification(PARENT_A);
      await expectNextEvent(ws, after);
      expect(ws.pending).toBe(0);
    });

    it('silinmiş satır gitmez', async () => {
      const ws = await subscribed(PARENT_A);
      await pg.query(
        `insert into public.notifications (school_id, recipient_id, type, params, is_deleted)
         values ($1, $2, 'announcement', '{}', true)`,
        [SCHOOL_A, PARENT_A],
      );
      const visible = await insertNotification(PARENT_A);
      await expectNextEvent(ws, visible);
    });

    it('unsubscribe sonrası olay gitmez', async () => {
      const ws = await subscribed(PARENT_A);
      ws.send({ type: 'unsubscribe', channel: channelOf(PARENT_A) });
      expect(await ws.next()).toEqual({
        type: 'unsubscribed',
        channel: channelOf(PARENT_A),
      });
      await insertNotification(PARENT_A);
      ws.send({ type: 'ping' });
      expect(await ws.next()).toEqual({ type: 'pong' });
    });
  });

  describe('realtime: bağlantı süresince kimlik', () => {
    it('token süresi dolunca 4001 token_expired; dolmadan yenilenirse açık kalır', async () => {
      const token = await login(PARENT_A);
      const expiring = await subscribed(PARENT_A, withExpiry(token, 2));
      expect(await expiring.closed).toEqual({
        code: 4001,
        reason: 'token_expired',
      });

      const renewed = await subscribed(PARENT_A, withExpiry(token, 2));
      const ready = await renewed.auth(withExpiry(token, 3600));
      expect(ready.type).toBe('ready');
      await new Promise((r) => setTimeout(r, 2_500));
      const id = await insertNotification(PARENT_A);
      await expectNextEvent(renewed, id);
    });

    it('yenilemede başka kullanıcının token’ı 4003', async () => {
      const ws = await subscribed(PARENT_A);
      ws.send({ type: 'auth', token: await login(COACH_A) });
      expect(await ws.closed).toEqual({ code: 4003, reason: 'user_changed' });
    });

    it('oturum kapanınca (çıkış, hesap silme) bağlantı 4001 session_ended ile kapanır', async () => {
      const token = await login(PARENT_A);
      const ws = await subscribed(PARENT_A, token);
      await http()
        .post('/auth/logout?scope=local')
        .set('Authorization', `Bearer ${token}`)
        .expect(204);
      expect(await ws.closed).toEqual({ code: 4001, reason: 'session_ended' });
    });

    it('kullanıcı başına bağlantı sınırı: en eskisi 4029 ile kapanır', async () => {
      // Başka testin kapanmakta olan soketi sayıyı bozmasın: yalnızca burada
      // kullanılan hesap.
      const manager = USERS.a.branchManager;
      const token = await login(manager);
      const first = await subscribed(manager, token);
      await subscribed(manager, token);
      await subscribed(manager, token);
      const fourth = await subscribed(manager, token);
      expect(await first.closed).toEqual({
        code: 4029,
        reason: 'too_many_connections',
      });
      const id = await insertNotification(manager);
      await expectNextEvent(fourth, id);
    });

    it('pong vermeyen bağlantı heartbeat ile düşürülür', async () => {
      const server = app.get(RealtimeServer);
      const raw = new WebSocket(`${baseUrl}/realtime`, { autoPong: false });
      raw.on('error', () => undefined);
      await new Promise((r) => raw.once('open', r));
      // Auth süresi (500 ms) heartbeat'ten (300 ms × 2) sonra dolmasın diye
      // kimlik verilir; bağlantı yalnızca pong vermediği için düşmeli.
      raw.send(JSON.stringify({ type: 'auth', token: await login(COACH_A) }));
      const before = server.connectionCount;
      const code = await new Promise<number>((r) =>
        raw.once('close', (c) => r(c)),
      );
      expect(code).toBe(1006);
      expect(server.connectionCount).toBeLessThan(before);
    });
  });

  describe('realtime: LISTEN bağlantısı koparsa', () => {
    it('abonelere resync gider, sonra olaylar yine akar', async () => {
      const ws = await subscribed(PARENT_A);
      const { rows } = await pg.query<{ n: number }>(
        `select count(pg_terminate_backend(pid))::int as n from pg_stat_activity
          where application_name = $1`,
        [LISTEN_APPLICATION_NAME],
      );
      expect(rows[0].n).toBe(1);
      expect(await ws.next(10_000)).toEqual({
        type: 'resync',
        channel: channelOf(PARENT_A),
      });
      const id = await insertNotification(PARENT_A);
      await expectNextEvent(ws, id);
    });
  });

  // ============================================================== push

  describe('push kuyruğu', () => {
    const TOKEN_A = 'fcm-token-veli-a';

    beforeAll(async () => {
      await pg.query(
        `insert into public.push_tokens (token, profile_id, app, platform, locale)
         values ($1, $2, 'parent', 'android', 'tr'), ('fcm-token-veli-b', $3, 'parent', 'ios', 'en')`,
        [TOKEN_A, PARENT_A, PARENT_B],
      );
    });

    it('dürtme gelince kuyruk boşalır: satır sent, mesaj token dilinde ve kişisel verisiz', async () => {
      fcm.configured = true;
      const id = await insertNotification(PARENT_A, {
        type: 'attendance_result',
        params: {
          athlete_id: ATHLETES.deniz,
          athlete_name: 'Deniz Deneme',
          class_name: 'Mini A',
          status: 'absent',
        },
      });
      const row = await waitFor(
        'select push_status, push_attempts, pushed_at from public.notifications where id = $1',
        [id],
        (r) => r.push_status === 'sent',
      );
      expect(row.push_attempts).toBe(1);
      expect(row.pushed_at).not.toBeNull();
      const message = fcm.sent.find((m) => m.data.notification_id === id);
      expect(message).toEqual({
        token: TOKEN_A,
        notification: {
          title: 'Yoklama sonucu',
          body: 'Çocuğunuz antrenmana katılmadı.',
        },
        data: {
          notification_id: id,
          type: 'attendance_result',
          params: JSON.stringify({ athlete_id: ATHLETES.deniz }),
        },
        android: { priority: 'HIGH' },
        apns: { payload: { aps: { sound: 'default' } } },
      });
      expect(JSON.stringify(message)).not.toMatch(/Deniz|Mini A/);
    });

    it('İngilizce token İngilizce metin alır', async () => {
      fcm.configured = true;
      const id = await insertNotification(PARENT_B, {
        type: 'payment_overdue',
        params: { athlete_id: ATHLETES.mina },
      });
      await waitFor(
        'select push_status from public.notifications where id = $1',
        [id],
        (r) => r.push_status === 'sent',
      );
      expect(
        fcm.sent.find((m) => m.data.notification_id === id)?.notification,
      ).toEqual({
        title: 'Overdue payment',
        body: 'You have a payment past its due date.',
      });
    });

    it('çok satırlı tek insert tek dürtme (statement trigger)', async () => {
      const listener = new Client({ connectionString: db.url });
      await listener.connect();
      try {
        const received: Notification[] = [];
        listener.on('notification', (n) => received.push(n));
        await listener.query('listen push_dispatch');
        await pg.query(
          `insert into public.notifications (school_id, recipient_id, type, params)
           select $1, $2, 'announcement', jsonb_build_object('title', 'T' || g, 'body', 'B')
             from generate_series(1, 50) g`,
          [SCHOOL_A, PARENT_A],
        );
        await insertNotification(PARENT_A);
        await new Promise((r) => setTimeout(r, 500));
        expect(received.map((n) => n.payload)).toEqual(['', '']);
      } finally {
        await listener.end();
      }
    });

    it('FCM tanımlı değilse kuyruğa dokunulmaz', async () => {
      const id = await insertNotification(PARENT_A);
      await new Promise((r) => setTimeout(r, 300));
      await worker.idle();
      expect(await rowOf(id)).toMatchObject({
        push_status: 'pending',
        push_attempts: 0,
      });
      // Tanımlanınca kuyruk boşalır (sonraki dürtmeyle).
      fcm.configured = true;
      worker.kick();
      await waitFor(
        'select push_status from public.notifications where id = $1',
        [id],
        (r) => r.push_status === 'sent',
      );
    });

    it('erişim token’ı alınamazsa satır talep edilmez', async () => {
      await worker.idle();
      fcm.configured = true;
      fcm.prepareError = new Error('google kapalı');
      const id = await insertNotification(PARENT_A);
      await new Promise((r) => setTimeout(r, 300));
      await worker.idle();
      expect(await rowOf(id)).toMatchObject({
        push_status: 'pending',
        push_attempts: 0,
      });
      fcm.prepareError = null;
      worker.kick();
      await waitFor(
        'select push_status from public.notifications where id = $1',
        [id],
        (r) => r.push_status === 'sent',
      );
    });

    it('geçici hata en çok 5 deneme, sonra failed; token silinmez', async () => {
      fcm.configured = true;
      let calls = 0;
      const target = { id: '' };
      fcm.respond = (m) => {
        if (m.data.notification_id === target.id) calls += 1;
        return {
          ok: false,
          status: 503,
          body: fcmErrorBody('UNAVAILABLE', 'down', 'UNAVAILABLE'),
        };
      };
      const id = await insertNotification(PARENT_A);
      target.id = id;
      for (let attempt = 1; attempt <= 5; attempt++) {
        const expected = attempt < 5 ? 'pending' : 'failed';
        await waitFor(
          'select push_status, push_attempts from public.notifications where id = $1',
          [id],
          (r) => r.push_attempts === attempt && r.push_status === expected,
        );
        // claim_push_batch yeniden denemeyi 2 dakika bekletir; zamanı geri al.
        await pg.query(
          `update public.notifications set push_claimed_at = now() - interval '3 minutes' where id = $1`,
          [id],
        );
        await worker.idle();
        worker.kick();
      }
      await worker.idle();
      expect(await rowOf(id)).toMatchObject({
        push_status: 'failed',
        push_attempts: 5,
      });
      expect(calls).toBe(5);
      const { rowCount } = await pg.query(
        'select 1 from public.push_tokens where token = $1',
        [TOKEN_A],
      );
      expect(rowCount).toBe(1);
    });

    it('ağ hatası da yeniden deneme (satır sending’de kalmaz)', async () => {
      fcm.configured = true;
      fcm.respond = () => new Error('ECONNRESET');
      const id = await insertNotification(PARENT_A);
      await waitFor(
        'select push_status, push_attempts from public.notifications where id = $1',
        [id],
        (r) => r.push_status === 'pending' && r.push_attempts === 1,
      );
    });

    it('UNREGISTERED token silinir; diğer cihaza ulaşan bildirim sent', async () => {
      fcm.configured = true;
      await pg.query(
        `insert into public.push_tokens (token, profile_id, app, platform, locale)
         values ('olu-token', $1, 'parent', 'ios', 'tr')`,
        [PARENT_A],
      );
      fcm.respond = (m) =>
        m.token === 'olu-token'
          ? {
              ok: false,
              status: 404,
              body: fcmErrorBody(
                'NOT_FOUND',
                'Requested entity was not found.',
                'UNREGISTERED',
              ),
            }
          : { ok: true };
      const id = await insertNotification(PARENT_A);
      await waitFor(
        'select push_status from public.notifications where id = $1',
        [id],
        (r) => r.push_status === 'sent',
      );
      const { rowCount } = await pg.query(
        `select 1 from public.push_tokens where token = 'olu-token'`,
      );
      expect(rowCount).toBe(0);
    });

    it('tek token’ı ölü olan alıcının satırı sonraki talepte skipped olur', async () => {
      fcm.configured = true;
      await pg.query(
        `insert into public.push_tokens (token, profile_id, app, platform, locale)
         values ('tek-olu-token', $1, 'dev_adim', 'android', 'tr')`,
        [COACH_A],
      );
      fcm.respond = () => ({
        ok: false,
        status: 400,
        body: fcmErrorBody(
          'INVALID_ARGUMENT',
          'The registration token is not a valid FCM registration token',
          'INVALID_ARGUMENT',
        ),
      });
      const id = await insertNotification(COACH_A);
      await waitFor(
        'select push_status, push_attempts from public.notifications where id = $1',
        [id],
        (r) => r.push_status === 'pending' && r.push_attempts === 1,
      );
      await waitFor(
        'select count(*)::int as n from public.push_tokens where profile_id = $1',
        [COACH_A],
        (r) => r.n === 0,
      );
      await pg.query(
        `update public.notifications set push_claimed_at = now() - interval '3 minutes' where id = $1`,
        [id],
      );
      await worker.idle();
      worker.kick();
      await waitFor(
        'select push_status from public.notifications where id = $1',
        [id],
        (r) => r.push_status === 'skipped',
      );
    });

    it('24 saatten eski, tercihi kapalı ve pasif alıcılı satırlar gönderilmez (skipped); duyuru tercihten etkilenmez', async () => {
      fcm.configured = true;
      await pg.query(
        `insert into public.push_tokens (token, profile_id, app, platform, locale)
         values ('pasif-token', $1, 'parent', 'android', 'tr')`,
        [USERS.a.passiveParent],
      );
      await pg.query(
        `insert into public.notification_preferences (profile_id, type, push_enabled)
         values ($1, 'payment_overdue', false), ($1, 'announcement', false)`,
        [PARENT_A],
      );
      try {
        const stale = await insertNotification(PARENT_A, {
          createdAt: new Date(Date.now() - 25 * 3600_000).toISOString(),
        });
        const muted = await insertNotification(PARENT_A, {
          type: 'payment_overdue',
          params: { athlete_id: ATHLETES.deniz },
        });
        const passive = await insertNotification(USERS.a.passiveParent);
        const announcement = await insertNotification(PARENT_A);
        for (const id of [stale, muted, passive]) {
          await waitFor(
            'select push_status from public.notifications where id = $1',
            [id],
            (r) => r.push_status === 'skipped',
          );
        }
        await waitFor(
          'select push_status from public.notifications where id = $1',
          [announcement],
          (r) => r.push_status === 'sent',
        );
        const sentIds = fcm.sent.map((m) => m.data.notification_id);
        expect(sentIds).toContain(announcement);
        for (const id of [stale, muted, passive])
          expect(sentIds).not.toContain(id);
      } finally {
        await pg.query(
          'delete from public.notification_preferences where profile_id = $1',
          [PARENT_A],
        );
      }
    });

    it('LISTEN bağlantısı dönünce kuyruğa bakılır (arada kaçan dürtme)', async () => {
      await worker.idle();
      const id = await insertNotification(PARENT_A);
      await new Promise((r) => setTimeout(r, 300));
      await worker.idle();
      fcm.configured = true;
      await pg.query(
        'select pg_terminate_backend(pid) from pg_stat_activity where application_name = $1',
        [LISTEN_APPLICATION_NAME],
      );
      await waitFor(
        'select push_status from public.notifications where id = $1',
        [id],
        (r) => r.push_status === 'sent',
        10_000,
      );
    });
  });

  describe('push kuyruğu: istemciye kapalı ve eşzamanlı güvenli', () => {
    const QUEUE_FUNCTIONS = [
      'claim_push_batch',
      'complete_push_batch',
      'sweep_push_queue',
      'request_push_dispatch',
      'notifications_realtime_notify',
    ];

    it.each(QUEUE_FUNCTIONS)(
      '/rpc/%s 404 (allow-list’te yok)',
      async (name) => {
        const token = await login(COACH_A);
        for (const auth of [`Bearer ${token}`, `Bearer ${supabaseAnonKey()}`]) {
          const res = await http()
            .post(`/rpc/${name}`)
            .set('Authorization', auth)
            .send({});
          expect(res.status).toBe(404);
          expect((res.body as { code: string }).code).toBe('PGRST202');
        }
      },
    );

    it.each(QUEUE_FUNCTIONS)(
      '%s: anon ve authenticated EXECUTE edemez',
      async (name) => {
        const { rows } = await pg.query<{
          anon: boolean;
          authed: boolean;
          svc: boolean;
        }>(
          `select bool_or(has_function_privilege('anon', p.oid, 'execute')) as anon,
                bool_or(has_function_privilege('authenticated', p.oid, 'execute')) as authed,
                bool_or(has_function_privilege('service_role', p.oid, 'execute')) as svc
           from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = $1`,
          [name],
        );
        expect(rows[0]).toMatchObject({ anon: false, authed: false });
        expect(rows[0].svc).toBe(name !== 'notifications_realtime_notify');
      },
    );

    it('iki eşzamanlı talep aynı satırı almaz (for update skip locked)', async () => {
      await worker.idle();
      await pg.query(
        `insert into public.notifications (school_id, recipient_id, type, params)
         select $1, $2, 'announcement', '{}' from generate_series(1, 300)`,
        [SCHOOL_A, PARENT_A],
      );
      const pending = await pg.query<{ n: number }>(
        `select count(*)::int as n from public.notifications where push_status = 'pending'`,
      );
      const a = new Client({ connectionString: db.url });
      const b = new Client({ connectionString: db.url });
      await Promise.all([a.connect(), b.connect()]);
      try {
        const claim = async (c: Client) => {
          await c.query('begin');
          await c.query('set local role service_role');
          const { rows } = await c.query<{ r: { data: { id: string }[] } }>(
            'select public.claim_push_batch(200) as r',
          );
          return rows[0].r.data.map((x) => x.id);
        };
        // Birincinin transaction'ı açıkken ikincisi talep eder.
        const first = await claim(a);
        const second = await claim(b);
        await Promise.all([a.query('commit'), b.query('commit')]);
        expect(first.length).toBe(200);
        const overlap = first.filter((id) => second.includes(id));
        expect(overlap).toEqual([]);
        expect(second.length).toBeGreaterThanOrEqual(
          Math.min(100, pending.rows[0].n - 200 - 5),
        );
      } finally {
        await Promise.all([a.end(), b.end()]);
        await pg.query(
          `update public.notifications set push_status = 'skipped' where push_status in ('pending', 'sending')`,
        );
      }
    });
  });

  // ============================================================== cron

  describe('cron', () => {
    // Sıra jobname'e göre (ICU en-US: `_` harflerden önce).
    const JOBS = [
      ['athletes_sensitive_data_purge', '35 0 * * *'],
      // 0010: 5651 erişim kaydı saklaması (yalnızca yeni backend'de).
      ['backend_access_log_purge', '15 1 * * *'],
      ['expire_trials_job', '0 3 * * *'],
      ['notifications_attendance_reminder', '*/15 * * * *'],
      ['notifications_birthday_upcoming', '0 6 * * *'],
      ['notifications_morning', '0 6 * * *'],
      ['notifications_parent_payments', '0 6 * * *'],
      ['notifications_push_sweep', '*/5 * * * *'],
      ['pre_registrations_retention_purge', '30 0 * * *'],
      ['site_leads_retention_purge', '45 0 * * *'],
    ];

    it('on iş kurulu (canlının dokuzu + backend_access_log_purge), etkin, postgres veritabanında', async () => {
      const { rows } = await pg.query<{
        jobname: string;
        schedule: string;
        active: boolean;
        database: string;
        username: string;
      }>(
        'select jobname, schedule, active, database, username from cron.job order by jobname',
      );
      expect(rows.map((r) => [r.jobname, r.schedule])).toEqual(JOBS);
      for (const r of rows) {
        expect(r).toMatchObject({
          active: true,
          database: 'postgres',
          username: 'postgres',
        });
      }
    });

    it.each(JOBS.map(([name]) => name))(
      '%s komutu hatasız çalışır',
      async (name) => {
        const { rows } = await pg.query<{ command: string }>(
          'select command from cron.job where jobname = $1',
          [name],
        );
        await pg.query('begin');
        try {
          await pg.query(rows[0].command);
        } finally {
          await pg.query('rollback');
        }
      },
    );

    it('push süpürmesi bekleyen satır varken push_dispatch dürter', async () => {
      const listener = new Client({ connectionString: db.url });
      await listener.connect();
      try {
        const received: string[] = [];
        listener.on('notification', (n) => received.push(n.channel));
        await listener.query('listen push_dispatch');
        await pg.query(
          `update public.notifications set push_status = 'skipped' where push_status in ('pending', 'sending')`,
        );
        await pg.query('select public.sweep_push_queue()');
        await new Promise((r) => setTimeout(r, 200));
        expect(received).toEqual([]);
        await insertNotification(PARENT_A);
        await new Promise((r) => setTimeout(r, 200));
        received.length = 0;
        await pg.query('select public.sweep_push_queue()');
        await new Promise((r) => setTimeout(r, 200));
        expect(received).toEqual(['push_dispatch']);
      } finally {
        await listener.end();
      }
    });
  });
});
