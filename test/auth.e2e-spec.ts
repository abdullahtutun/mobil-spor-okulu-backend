import { createHash } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import jwt from 'jsonwebtoken';
import { Client } from 'pg';
import request from 'supertest';
import type { App } from 'supertest/types';
import { ATHLETES, SCHOOL_A, SEED_PASSWORD, USERS } from './fixtures/seed-ids';
import { createTestApp, TEST_JWT_SECRET } from './support/app';
import { startTestDatabase, type TestDatabase } from './support/database';

interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  expires_at: number;
  refresh_token: string;
  user: Record<string, unknown> & { id: string; user_metadata: object };
}

/** golang.org/x/crypto/bcrypt test vektörü: GoTrue'nun yazdığı biçim ($2a$10$). */
const GOTRUE_HASH =
  '$2a$10$XajjQvNhvvRt5GSeFk1xFeyqRrsxkhBkUiQeg0dt.wU1qD4aFDcga';
const GOTRUE_PASSWORD = 'allmine';

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/**
 * Auth çekirdeği uçtan uca (S05): gerçek Postgres, seed, API
 * api_authenticator → auth_service ile auth tablolarına yazıyor.
 */
describe('Auth (gerçek Postgres)', () => {
  let db: TestDatabase;
  let app: INestApplication<App>;
  let pg: Client;
  let counter = 0;

  const http = () => request(app.getHttpServer());
  const password = (email: string, pw: string) =>
    http()
      .post('/auth/token?grant_type=password')
      .set('User-Agent', 'e2e-test/1.0')
      .send({ email, password: pw });
  const refresh = (token: string) =>
    http()
      .post('/auth/token?grant_type=refresh_token')
      .send({ refresh_token: token });
  const login = async (email: string, pw: string) =>
    (await password(email, pw).expect(200)).body as TokenResponse;

  /** Test başına ayrı hesap (şifre değiştiren testler başkasını bozmasın). */
  async function createUser(
    opts: {
      password?: string;
      hash?: string;
      confirmed?: boolean;
      bannedUntil?: string;
      deleted?: boolean;
    } = {},
  ): Promise<{ id: string; email: string }> {
    counter += 1;
    const email = `auth.test${counter}@a.test`;
    const { rows } = await pg.query<{ id: string }>(
      `insert into auth.users (
         instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
         raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
         banned_until, deleted_at, is_sso_user, is_anonymous)
       values ('00000000-0000-0000-0000-000000000000', gen_random_uuid(),
         'authenticated', 'authenticated', $1,
         coalesce($2, extensions.crypt($3, extensions.gen_salt('bf', 4))),
         case when $4 then now() end,
         '{"provider":"email","providers":["email"]}', '{"brand":"public","name":"Test"}',
         now(), now(), $5::timestamptz, case when $6 then now() end, false, false)
       returning id`,
      [
        email,
        opts.hash ?? null,
        opts.password ?? SEED_PASSWORD,
        opts.confirmed ?? true,
        opts.bannedUntil ?? null,
        opts.deleted ?? false,
      ],
    );
    return { id: rows[0].id, email };
  }

  const sessionCount = async (userId: string) =>
    Number(
      (
        await pg.query<{ n: string }>(
          'select count(*) as n from auth.sessions where user_id = $1',
          [userId],
        )
      ).rows[0].n,
    );

  /** Token'ın yükünü koruyup süresini geçmiş yapar (aynı anahtarla). */
  const expire = (token: string) => {
    const payload = jwt.decode(token) as Record<string, number>;
    return jwt.sign(
      { ...payload, iat: payload.iat - 7200, exp: payload.iat - 3600 },
      TEST_JWT_SECRET,
      { algorithm: 'HS256' },
    );
  };

  beforeAll(async () => {
    db = await startTestDatabase({ seed: true });
    app = await createTestApp(db);
    pg = new Client({ connectionString: db.url });
    await pg.connect();
  });

  afterAll(async () => {
    await pg?.end();
    await app?.close();
    await db?.stop();
  });

  describe('kabul kriteri: veli giriş yapar ve RPC çağırır', () => {
    it('veli@a.test → get_session_data ve parent_get_athletes', async () => {
      const session = await login('veli@a.test', SEED_PASSWORD);
      const bearer = `Bearer ${session.access_token}`;

      const s = await http()
        .post('/rpc/get_session_data')
        .set('Authorization', bearer)
        .send({})
        .expect(200);
      expect(s.body).toMatchObject({
        success: true,
        data: { role: 'parent', school: { id: SCHOOL_A, brand: 'dev_adim' } },
      });

      const a = await http()
        .post('/rpc/parent_get_athletes')
        .set('Authorization', bearer)
        .send({})
        .expect(200);
      const body = a.body as { success: boolean; data: { id: string }[] };
      expect(body.success).toBe(true);
      expect(body.data.map((x) => x.id)).toEqual([ATHLETES.deniz]);
    });
  });

  describe('grant_type=password', () => {
    it('yanıt GoTrue şeklinde; token Supabase claim adlarını taşır', async () => {
      const r = await login('veli@a.test', SEED_PASSWORD);
      expect(r).toMatchObject({
        token_type: 'bearer',
        expires_in: 3600,
        user: {
          id: USERS.a.parent,
          aud: 'authenticated',
          role: 'authenticated',
          email: 'veli@a.test',
          app_metadata: { provider: 'email' },
          is_anonymous: false,
        },
      });
      expect(r.refresh_token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(r.expires_at - Math.floor(Date.now() / 1000)).toBeGreaterThan(
        3500,
      );
      expect(r.user.identities).toEqual([
        expect.objectContaining({ provider: 'email', user_id: USERS.a.parent }),
      ]);
      const claims = jwt.verify(r.access_token, TEST_JWT_SECRET, {
        algorithms: ['HS256'],
      }) as Record<string, unknown>;
      expect(claims).toMatchObject({
        sub: USERS.a.parent,
        role: 'authenticated',
        aud: 'authenticated',
        email: 'veli@a.test',
        aal: 'aal1',
        is_anonymous: false,
      });
      expect(claims.session_id).toEqual(expect.any(String));
      expect(claims.user_metadata).toEqual(r.user.user_metadata);
    });

    it('oturum satırı: IP ve user-agent; refresh token yalnızca hash olarak; last_sign_in_at', async () => {
      const u = await createUser();
      const r = await login(u.email, SEED_PASSWORD);
      const sid = (jwt.decode(r.access_token) as { session_id: string })
        .session_id;
      const { rows } = await pg.query(
        `select s.user_agent, host(s.ip) as ip, s.aal::text, rt.token, rt.revoked,
                rt.user_id, u.last_sign_in_at is not null as signed
           from auth.sessions s join auth.refresh_tokens rt on rt.session_id = s.id
           join auth.users u on u.id = s.user_id where s.id = $1`,
        [sid],
      );
      expect(rows).toEqual([
        {
          user_agent: 'e2e-test/1.0',
          ip: '127.0.0.1',
          aal: 'aal1',
          token: sha256(r.refresh_token),
          revoked: false,
          user_id: u.id,
          signed: true,
        },
      ]);
      const plain = await pg.query(
        'select 1 from auth.refresh_tokens where token = $1',
        [r.refresh_token],
      );
      expect(plain.rowCount).toBe(0);
    });

    it('e-posta büyük/küçük harf ve boşluk duyarsız', async () => {
      await login('  VELI@A.Test ', SEED_PASSWORD);
    });

    it('Supabase (GoTrue) bcrypt hash’iyle giriş — kimse şifre sıfırlamaz', async () => {
      const u = await createUser({ hash: GOTRUE_HASH });
      const r = await login(u.email, GOTRUE_PASSWORD);
      expect(r.user.id).toBe(u.id);
      await password(u.email, 'allmine!').expect(400);
    });

    it('yanlış şifre ve bilinmeyen e-posta aynı yanıt: invalid_credentials', async () => {
      const wrong = await password('veli@a.test', 'yanlis-sifre').expect(400);
      const unknown = await password('yok@a.test', 'yanlis-sifre').expect(400);
      expect(wrong.body).toEqual({
        code: 'invalid_credentials',
        message: 'Invalid login credentials',
      });
      expect(unknown.body).toEqual(wrong.body);
    });

    it('e-posta onaysız: doğru şifreyle email_not_confirmed, yanlışla invalid_credentials', async () => {
      const u = await createUser({ confirmed: false });
      const r = await password(u.email, SEED_PASSWORD).expect(400);
      expect(r.body).toMatchObject({ code: 'email_not_confirmed' });
      const w = await password(u.email, 'yanlis').expect(400);
      expect(w.body).toMatchObject({ code: 'invalid_credentials' });
      expect(await sessionCount(u.id)).toBe(0);
    });

    it('yasaklı ya da silinmiş hesap doğru şifreyle de invalid_credentials', async () => {
      const banned = await createUser({ bannedUntil: '2999-01-01' });
      const deleted = await createUser({ deleted: true });
      for (const u of [banned, deleted]) {
        const r = await password(u.email, SEED_PASSWORD).expect(400);
        expect(r.body).toEqual({
          code: 'invalid_credentials',
          message: 'Invalid login credentials',
        });
        expect(await sessionCount(u.id)).toBe(0);
      }
      const expiredBan = await createUser({ bannedUntil: '2020-01-01' });
      await login(expiredBan.email, SEED_PASSWORD);
    });

    it('şifresiz hesap (davet edilmiş, şifre konmamış) giremez', async () => {
      const u = await createUser({ hash: '' });
      await password(u.email, '').expect(400);
      await password(u.email, 'herhangi').expect(400);
    });

    it('bilinmeyen e-posta da bcrypt süresi harcar (hesap taraması zamanlamadan)', async () => {
      const time = async (email: string) => {
        const t = process.hrtime.bigint();
        await password(email, 'yanlis-sifre').expect(400);
        return Number(process.hrtime.bigint() - t) / 1e6;
      };
      // GoTrue maliyeti 10 olan bir hesap; seed'dekiler maliyet 6.
      const u = await createUser({ hash: GOTRUE_HASH });
      const known: number[] = [];
      const unknown: number[] = [];
      for (let i = 0; i < 4; i++) {
        known.push(await time(u.email));
        unknown.push(await time(`yok${i}@a.test`));
      }
      const median = (xs: number[]) => xs.sort((a, b) => a - b)[2];
      // bcrypt(10) onlarca ms; bilinmeyen e-posta da en az bunun yarısı.
      expect(median(unknown)).toBeGreaterThan(median(known) * 0.5);
    });

    it('eksik alan → validation_failed; bilinmeyen grant_type → unsupported_grant_type', async () => {
      const r = await http()
        .post('/auth/token?grant_type=password')
        .send({ email: 'veli@a.test' })
        .expect(400);
      expect(r.body).toMatchObject({ code: 'validation_failed' });
      const g = await http()
        .post('/auth/token?grant_type=id_token')
        .send({})
        .expect(400);
      expect(g.body).toMatchObject({ code: 'unsupported_grant_type' });
      await http().post('/auth/token').send({}).expect(400);
    });
  });

  describe('grant_type=refresh_token', () => {
    it('her kullanımda döner; yeni access token aynı oturum', async () => {
      const u = await createUser();
      const r0 = await login(u.email, SEED_PASSWORD);
      const r1 = (await refresh(r0.refresh_token).expect(200))
        .body as TokenResponse;
      expect(r1.refresh_token).not.toBe(r0.refresh_token);
      const s0 = jwt.decode(r0.access_token) as Record<string, unknown>;
      const s1 = jwt.decode(r1.access_token) as Record<string, unknown>;
      expect(s1.session_id).toBe(s0.session_id);
      expect(s1.sub).toBe(u.id);
      expect(r1.user.id).toBe(u.id);
      const { rows } = await pg.query(
        `select token, revoked, parent from auth.refresh_tokens
          where session_id = $1 order by id`,
        [s0.session_id],
      );
      expect(rows).toEqual([
        { token: sha256(r0.refresh_token), revoked: true, parent: null },
        {
          token: sha256(r1.refresh_token),
          revoked: false,
          parent: sha256(r0.refresh_token),
        },
      ]);
    });

    it('bilinmeyen token → refresh_token_not_found', async () => {
      const r = await refresh('olmayan-token').expect(400);
      expect(r.body).toEqual({
        code: 'refresh_token_not_found',
        message: 'Invalid Refresh Token: Refresh Token Not Found',
      });
    });

    it('yanıtı kaybolan yenileme: geçerli token’ın ebeveyni saatler sonra da kabul (çevrimdışı salon)', async () => {
      const u = await createUser();
      const r0 = await login(u.email, SEED_PASSWORD);
      const r1 = (await refresh(r0.refresh_token).expect(200))
        .body as TokenResponse;
      // r1'in yanıtı cihaza ulaşmadı; cihaz bir saat sonra r0 ile gelir.
      await pg.query(
        `update auth.refresh_tokens set updated_at = now() - interval '1 hour' where token = $1`,
        [sha256(r0.refresh_token)],
      );
      const r2 = (await refresh(r0.refresh_token).expect(200))
        .body as TokenResponse;
      // r1 de bu arada başka bir istekte kullanılmış olsaydı: r2'nin ebeveyni.
      await refresh(r1.refresh_token).expect(200);
      // r0 artık geçerli token'ın ebeveyni değil ve eski → çalınma şüphesi.
      const stolen = await refresh(r0.refresh_token).expect(400);
      expect(stolen.body).toMatchObject({ code: 'refresh_token_already_used' });
      // Oturum bütünüyle kapandı: en yeni token da ölü.
      expect(await sessionCount(u.id)).toBe(0);
      await refresh(r2.refresh_token).expect(400);
    });

    it('eski bir token yeniden kullanılırsa (pencere dışında) oturumun bütün token’ları iptal', async () => {
      const u = await createUser();
      const r0 = await login(u.email, SEED_PASSWORD);
      const r1 = (await refresh(r0.refresh_token).expect(200))
        .body as TokenResponse;
      const r2 = (await refresh(r1.refresh_token).expect(200))
        .body as TokenResponse;
      await pg.query(
        `update auth.refresh_tokens set updated_at = now() - interval '1 minute' where token = $1`,
        [sha256(r0.refresh_token)],
      );
      const res = await refresh(r0.refresh_token).expect(400);
      expect(res.body).toEqual({
        code: 'refresh_token_already_used',
        message: 'Invalid Refresh Token: Already Used',
      });
      const after = await refresh(r2.refresh_token).expect(400);
      expect(after.body).toMatchObject({ code: 'refresh_token_not_found' });
      await http()
        .get('/auth/user')
        .set('Authorization', `Bearer ${r2.access_token}`)
        .expect(403);
    });

    it('yeniden deneme penceresinde eski token kabul (eşzamanlı/tekrarlanan yenileme)', async () => {
      const u = await createUser();
      const r0 = await login(u.email, SEED_PASSWORD);
      const r1 = (await refresh(r0.refresh_token).expect(200))
        .body as TokenResponse;
      await refresh(r1.refresh_token).expect(200);
      // r0 büyük ebeveyn ama 10 sn içinde: kabul.
      await refresh(r0.refresh_token).expect(200);
      expect(await sessionCount(u.id)).toBe(1);
    });

    it('aynı token’la eşzamanlı iki yenileme ikisi de geçer, tek oturum kalır', async () => {
      const u = await createUser();
      const r0 = await login(u.email, SEED_PASSWORD);
      const [a, b] = await Promise.all([
        refresh(r0.refresh_token),
        refresh(r0.refresh_token),
      ]);
      expect([a.status, b.status]).toEqual([200, 200]);
      const { rows } = await pg.query<{ n: string }>(
        `select count(*) filter (where not revoked) as n from auth.refresh_tokens rt
           join auth.sessions s on s.id = rt.session_id where s.user_id = $1`,
        [u.id],
      );
      expect(rows[0].n).toBe('1');
    });

    it('yasaklanan kullanıcı yenileyemez: user_banned; silinen: refresh_token_not_found', async () => {
      const banned = await createUser();
      const rb = await login(banned.email, SEED_PASSWORD);
      await pg.query(
        `update auth.users set banned_until = now() + interval '1 day' where id = $1`,
        [banned.id],
      );
      const b = await refresh(rb.refresh_token).expect(403);
      expect(b.body).toMatchObject({ code: 'user_banned' });

      const deleted = await createUser();
      const rd = await login(deleted.email, SEED_PASSWORD);
      await pg.query(`update auth.users set deleted_at = now() where id = $1`, [
        deleted.id,
      ]);
      const d = await refresh(rd.refresh_token).expect(400);
      expect(d.body).toMatchObject({ code: 'refresh_token_not_found' });
      expect(await sessionCount(deleted.id)).toBe(0);
    });

    it('delete_own_account’un yaptığı (oturumlar silinir) sonrası yenileme ölü', async () => {
      const u = await createUser();
      const r = await login(u.email, SEED_PASSWORD);
      await pg.query('delete from auth.sessions where user_id = $1', [u.id]);
      const res = await refresh(r.refresh_token).expect(400);
      expect(res.body).toMatchObject({ code: 'refresh_token_not_found' });
    });
  });

  describe('logout', () => {
    async function threeSessions() {
      const u = await createUser();
      const s = [
        await login(u.email, SEED_PASSWORD),
        await login(u.email, SEED_PASSWORD),
        await login(u.email, SEED_PASSWORD),
      ];
      expect(await sessionCount(u.id)).toBe(3);
      return { u, s };
    }
    const logout = (token: string, scope?: string) =>
      http()
        .post(`/auth/logout${scope ? `?scope=${scope}` : ''}`)
        .set('Authorization', `Bearer ${token}`)
        .send();

    it('local: yalnızca bu oturum', async () => {
      const { u, s } = await threeSessions();
      await logout(s[0].access_token, 'local').expect(204);
      expect(await sessionCount(u.id)).toBe(2);
      await refresh(s[0].refresh_token).expect(400);
      await refresh(s[1].refresh_token).expect(200);
      const me = await http()
        .get('/auth/user')
        .set('Authorization', `Bearer ${s[0].access_token}`)
        .expect(403);
      expect(me.body).toMatchObject({ code: 'session_not_found' });
    });

    it('global (varsayılan): bütün oturumlar', async () => {
      const { u, s } = await threeSessions();
      await logout(s[0].access_token).expect(204);
      expect(await sessionCount(u.id)).toBe(0);
      for (const x of s) await refresh(x.refresh_token).expect(400);
    });

    it('others: bu oturum kalır, gövdeyle de verilebilir', async () => {
      const { u, s } = await threeSessions();
      await http()
        .post('/auth/logout')
        .set('Authorization', `Bearer ${s[1].access_token}`)
        .send({ scope: 'others' })
        .expect(204);
      expect(await sessionCount(u.id)).toBe(1);
      await refresh(s[1].refresh_token).expect(200);
      await refresh(s[0].refresh_token).expect(400);
    });

    it('süresi geçmiş access token’la da çıkılır; tekrar çıkış 204', async () => {
      const u = await createUser();
      const r = await login(u.email, SEED_PASSWORD);
      const old = expire(r.access_token);
      await logout(old, 'local').expect(204);
      expect(await sessionCount(u.id)).toBe(0);
      await logout(old, 'local').expect(204);
    });

    it('token’sız, sahte imzalı ya da bilinmeyen kapsam reddedilir', async () => {
      await http().post('/auth/logout').send().expect(401);
      const forged = jwt.sign(
        { sub: USERS.a.parent, role: 'authenticated', aud: 'authenticated' },
        'x'.repeat(40),
      );
      await logout(forged).expect(401);
      const r = await login('veli@a.test', SEED_PASSWORD);
      const bad = await logout(r.access_token, 'everyone').expect(400);
      expect(bad.body).toMatchObject({ code: 'validation_failed' });
    });
  });

  describe('/auth/user', () => {
    it('GET kendi kullanıcısını döner', async () => {
      const r = await login('veli@a.test', SEED_PASSWORD);
      const me = await http()
        .get('/auth/user')
        .set('Authorization', `Bearer ${r.access_token}`)
        .expect(200);
      expect(me.body).toMatchObject({
        id: USERS.a.parent,
        email: 'veli@a.test',
        aud: 'authenticated',
      });
      expect(me.body).not.toHaveProperty('encrypted_password');
    });

    it('tokensız ya da anon → 401 no_authorization', async () => {
      const r = await http().get('/auth/user').expect(401);
      expect(r.body).toMatchObject({ code: 'no_authorization' });
    });

    it('süresi geçmiş token: /auth/user ve RPC kapısı 401 PGRST303 "JWT expired"', async () => {
      const r = await login('veli@a.test', SEED_PASSWORD);
      const old = expire(r.access_token);
      const me = await http()
        .get('/auth/user')
        .set('Authorization', `Bearer ${old}`)
        .expect(401);
      expect(me.body).toMatchObject({
        code: 'PGRST303',
        message: 'JWT expired',
      });
      const rpc = await http()
        .post('/rpc/get_session_data')
        .set('Authorization', `Bearer ${old}`)
        .send({})
        .expect(401);
      // SessionRetryClient bu gövdeyi "yenile ve tekrar dene" diye okur.
      expect(rpc.body).toMatchObject({
        code: 'PGRST303',
        message: 'JWT expired',
      });
      // Yeniledikten sonra aynı istek geçer.
      const fresh = (await refresh(r.refresh_token).expect(200))
        .body as TokenResponse;
      await http()
        .post('/rpc/get_session_data')
        .set('Authorization', `Bearer ${fresh.access_token}`)
        .send({})
        .expect(200);
    });

    it('PUT password: kural, aynı şifre, değişim; diğer oturumlar kapanır', async () => {
      const u = await createUser();
      const me = await login(u.email, SEED_PASSWORD);
      const other = await login(u.email, SEED_PASSWORD);
      const put = (body: object) =>
        http()
          .put('/auth/user')
          .set('Authorization', `Bearer ${me.access_token}`)
          .send(body);

      expect((await put({ password: '12345' }).expect(422)).body).toMatchObject(
        { code: 'weak_password' },
      );
      expect(
        (await put({ password: SEED_PASSWORD }).expect(422)).body,
      ).toMatchObject({ code: 'same_password' });

      await put({ password: '123456' }).expect(200);
      const { rows } = await pg.query<{ h: string }>(
        'select encrypted_password as h from auth.users where id = $1',
        [u.id],
      );
      expect(rows[0].h).toMatch(/^\$2a\$10\$/);
      // pgcrypto da (seed ve veri betikleri) yeni hash'i okur.
      const check = await pg.query<{ ok: boolean }>(
        `select extensions.crypt('123456', $1) = $1 as ok`,
        [rows[0].h],
      );
      expect(check.rows[0].ok).toBe(true);

      await password(u.email, SEED_PASSWORD).expect(400);
      await login(u.email, '123456');
      await refresh(other.refresh_token).expect(400);
      await refresh(me.refresh_token).expect(200);
    });

    it('PUT data: birleşir, null siler; korunan anahtar ve e-posta değişimi reddedilir', async () => {
      const u = await createUser();
      const r = await login(u.email, SEED_PASSWORD);
      const put = (body: object) =>
        http()
          .put('/auth/user')
          .set('Authorization', `Bearer ${r.access_token}`)
          .send(body);
      const ok = await put({ data: { theme: 'dark', name: null } }).expect(200);
      expect((ok.body as { user_metadata: object }).user_metadata).toEqual({
        brand: 'public',
        theme: 'dark',
      });
      for (const key of ['brand', 'created_by', 'is_creator']) {
        const res = await put({ data: { [key]: 'x' } }).expect(422);
        expect(res.body).toMatchObject({ code: 'validation_failed' });
      }
      await put({ email: 'baska@a.test' }).expect(400);
      const { rows } = await pg.query<{ m: object; e: string }>(
        'select raw_user_meta_data as m, email as e from auth.users where id = $1',
        [u.id],
      );
      expect(rows[0]).toEqual({
        m: { brand: 'public', theme: 'dark' },
        e: u.email,
      });
    });
  });

  describe('kaba kuvvet koruması', () => {
    let limited: INestApplication<App>;

    beforeAll(async () => {
      limited = await createTestApp(db, {
        TRUST_PROXY: '1',
        AUTH_LOGIN_IP_LIMIT: '8',
        AUTH_LOGIN_FAILURE_LIMIT: '3',
        AUTH_LOGIN_EMAIL_FAILURE_LIMIT: '5',
      });
    });
    afterAll(async () => {
      await limited?.close();
    });

    const attempt = (ip: string, email: string, pw: string) =>
      request(limited.getHttpServer())
        .post('/auth/token?grant_type=password')
        .set('X-Forwarded-For', ip)
        .send({ email, password: pw });

    it('IP + e-posta: 3 yanlış şifreden sonra doğru şifre de 429 + Retry-After', async () => {
      for (let i = 0; i < 3; i++) {
        await attempt('10.1.0.1', 'veli@a.test', 'yanlis').expect(400);
      }
      const r = await attempt('10.1.0.1', 'veli@a.test', SEED_PASSWORD).expect(
        429,
      );
      expect(r.body).toMatchObject({ code: 'over_request_rate_limit' });
      expect(Number(r.headers['retry-after'])).toBeGreaterThan(0);
      // Başka IP'den aynı hesap girer.
      await attempt('10.1.0.2', 'veli@a.test', SEED_PASSWORD).expect(200);
    });

    it('bilinmeyen e-posta da aynı sınıra takılır (varlık sızmaz)', async () => {
      for (let i = 0; i < 3; i++) {
        await attempt('10.2.0.1', 'yok@a.test', 'yanlis').expect(400);
      }
      const r = await attempt('10.2.0.1', 'yok@a.test', 'yanlis').expect(429);
      expect(r.body).toMatchObject({ code: 'over_request_rate_limit' });
    });

    it('dağıtık tahmin: e-posta başına 5 yanlış (farklı IP’ler) → kilit', async () => {
      for (let i = 0; i < 5; i++) {
        await attempt(`10.3.0.${i}`, 'antrenor@a.test', 'yanlis').expect(400);
      }
      await attempt('10.3.0.99', 'antrenor@a.test', SEED_PASSWORD).expect(429);
    });

    it('IP başına deneme sınırı (doğrular dahil)', async () => {
      const emails = [
        'genel.mudur@a.test',
        'sube.muduru@a.test',
        'mudur.yardimcisi@a.test',
        'muhasebe@a.test',
        'antrenor2@a.test',
        'genel.mudur@b.test',
        'antrenor@b.test',
        'veli@b.test',
      ];
      for (const e of emails) {
        await attempt('10.4.0.1', e, SEED_PASSWORD).expect(200);
      }
      await attempt('10.4.0.1', 'diyetisyen@a.test', SEED_PASSWORD).expect(429);
      await attempt('10.4.0.2', 'diyetisyen@a.test', SEED_PASSWORD).expect(200);
    });
  });
});
