import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';
import { ATHLETES, SCHOOL_A, USERS } from './fixtures/seed-ids';
import { createTestApp } from './support/app';
import { startTestDatabase, type TestDatabase } from './support/database';
import {
  supabaseAnonKey,
  supabaseServiceRoleKey,
  supabaseUserToken,
} from './support/tokens';

interface Envelope {
  success: boolean;
  code: string;
  message: string;
  data: unknown;
}

/**
 * `POST /rpc/:name` uçtan uca: gerçek Postgres, S03 seed'i, API
 * `api_authenticator` olarak bağlı. Veli uygulamasının çağırdığı on RPC'nin
 * (endpoint.dart; S02'nin get_min_app_version'ı dahil) hepsi burada.
 */
describe('RPC kapısı (gerçek Postgres)', () => {
  let db: TestDatabase;
  let app: INestApplication<App>;

  const parent = supabaseUserToken(USERS.a.parent);
  const passiveParent = supabaseUserToken(USERS.a.passiveParent);
  const manager = supabaseUserToken(USERS.a.generalManager);
  const coach = supabaseUserToken(USERS.a.coach);

  const rpc = (name: string, body: unknown = {}, token?: string) => {
    const req = request(app.getHttpServer()).post(`/rpc/${name}`);
    if (token) req.set('Authorization', `Bearer ${token}`);
    return req.send(body as object);
  };
  const ok = async (name: string, body: unknown, token?: string) => {
    const res = await rpc(name, body, token).expect(200);
    return res.body as Envelope;
  };

  beforeAll(async () => {
    db = await startTestDatabase({ seed: true });
    app = await createTestApp(db);
  });

  afterAll(async () => {
    await app?.close();
    await db?.stop();
  });

  describe('veli uygulamasının RPC’leri', () => {
    it('get_min_app_version oturumsuz çağrılır (zorunlu güncelleme kapısı)', async () => {
      const env = await ok('get_min_app_version', {
        p_app: 'parent',
        p_platform: 'android',
        p_brand: 'dev_adim',
      });
      expect(env.success).toBe(true);
    });

    it('get_session_data velinin oturumunu Supabase’teki şekliyle döner', async () => {
      const env = await ok('get_session_data', {}, parent);
      expect(env).toMatchObject({ success: true, code: 'ok' });
      expect(env.data).toMatchObject({
        role: 'parent',
        status: 'active',
        permissions: [],
        school: { id: SCHOOL_A, brand: 'dev_adim' },
      });
    });

    it('acknowledge_privacy_notice kendi profiline yazar', async () => {
      const env = await ok(
        'acknowledge_privacy_notice',
        { p_version: '2026-10-01' },
        parent,
      );
      expect(env.success).toBe(true);
    });

    it('parent_get_athletes yalnızca kendi çocuğunu döner', async () => {
      const env = await ok('parent_get_athletes', {}, parent);
      expect(env.success).toBe(true);
      const ids = (env.data as { id: string }[]).map((a) => a.id);
      expect(ids).toEqual([ATHLETES.deniz]);
    });

    it('parent_get_attendance kendi çocuğu için ok, başkasınınki not_found', async () => {
      const range = { p_from: '2026-09-01', p_to: '2026-09-30' };
      const own = await ok(
        'parent_get_attendance',
        { p_athlete_id: ATHLETES.deniz, ...range },
        parent,
      );
      expect(own.success).toBe(true);
      expect(Array.isArray(own.data)).toBe(true);

      for (const other of [ATHLETES.ege, ATHLETES.ada, ATHLETES.mina]) {
        const env = await ok(
          'parent_get_attendance',
          { p_athlete_id: other, ...range },
          parent,
        );
        expect(env).toMatchObject({ success: false, code: 'not_found' });
      }
    });

    it('parent_get_payments kendi çocuğu için ok, başka okulunki not_found', async () => {
      expect(
        (
          await ok(
            'parent_get_payments',
            { p_athlete_id: ATHLETES.deniz },
            parent,
          )
        ).success,
      ).toBe(true);
      expect(
        await ok(
          'parent_get_payments',
          { p_athlete_id: ATHLETES.mina },
          parent,
        ),
      ).toMatchObject({ success: false, code: 'not_found' });
    });

    it('parent_set_consents gönderilmeyen rızaları varsayılana (null) bırakır', async () => {
      const env = await ok(
        'parent_set_consents',
        { p_athlete_id: ATHLETES.deniz, p_photo: true },
        parent,
      );
      expect(env.success).toBe(true);
      expect(
        await ok(
          'parent_set_consents',
          { p_athlete_id: ATHLETES.ege, p_photo: true },
          parent,
        ),
      ).toMatchObject({ success: false, code: 'not_found' });
    });

    it('register_push_token / mark_notifications_read / unregister_push_token', async () => {
      const token = 'fcm-test-token-'.padEnd(64, 'x');
      // p_locale gönderilmedi: varsayılanı ('tr') kullanılır.
      expect(
        (
          await ok(
            'register_push_token',
            { p_token: token, p_app: 'parent', p_platform: 'android' },
            parent,
          )
        ).success,
      ).toBe(true);
      // p_ids gönderilmedi: hepsini okundu yap.
      expect((await ok('mark_notifications_read', {}, parent)).success).toBe(
        true,
      );
      expect(
        (await ok('mark_notifications_read', { p_ids: [] }, parent)).success,
      ).toBe(true);
      expect(
        (await ok('unregister_push_token', { p_token: token }, parent)).success,
      ).toBe(true);
    });

    it('pasif veli forbidden alır', async () => {
      expect(await ok('parent_get_athletes', {}, passiveParent)).toMatchObject({
        success: false,
        code: 'forbidden',
      });
      expect(
        await ok(
          'parent_get_attendance',
          {
            p_athlete_id: ATHLETES.ege,
            p_from: '2026-09-01',
            p_to: '2026-09-30',
          },
          passiveParent,
        ),
      ).toMatchObject({ success: false, code: 'forbidden' });
    });
  });

  describe('yönetim uygulamasından örnekler', () => {
    it('genel müdürün oturumu okulun şubeleriyle gelir', async () => {
      const env = await ok('get_session_data', {}, manager);
      expect(env.success).toBe(true);
    });

    it('veli yönetim RPC’sinde forbidden alır (rol kontrolü SQL’de)', async () => {
      const env = await ok('get_setup_progress', {}, parent);
      expect(env).toMatchObject({ success: false, code: 'forbidden' });
    });

    it('antrenör günün yoklama listesini alır (p_branch_id varsayılan)', async () => {
      const env = await ok(
        'get_daily_attendance',
        { p_school_id: SCHOOL_A, p_attendance_date: '2026-09-15' },
        coach,
      );
      expect(env.success).toBe(true);
    });
  });

  describe('rol ve allow-list', () => {
    it('oturumsuz istek oturum isteyen fonksiyonda 401 42501 alır', async () => {
      const res = await rpc('get_session_data').expect(401);
      expect(res.body).toMatchObject({ code: '42501' });
    });

    it('Supabase anon anahtarı oturumsuz istek sayılır', async () => {
      await rpc('get_session_data', {}, supabaseAnonKey()).expect(401);
      const res = await rpc(
        'get_min_app_version',
        { p_app: 'management', p_platform: 'ios', p_brand: 'public' },
        supabaseAnonKey(),
      ).expect(200);
      expect((res.body as Envelope).success).toBe(true);
    });

    it('anon yalnızca allow-list’teki anon fonksiyonları çağırabilir', async () => {
      const res = await rpc('public_get_branches_by_token', {
        p_token: 'olmayan-token',
      }).expect(200);
      expect((res.body as Envelope).success).toBe(false);
      for (const name of ['parent_get_athletes', 'create_school']) {
        await rpc(name).expect(401);
      }
    });

    it.each([
      'delete_own_account',
      'claim_push_batch',
      'convert_pre_registration',
      'create_public_pre_registration_by_token',
      'save_attendances',
      'rotate_pre_registration_link',
      'app_ok',
      'olmayan_fonksiyon',
      '__proto__',
      'constructor',
    ])(
      'allow-list dışındaki %s 404 PGRST202 (oturumlu da oturumsuz da)',
      async (name) => {
        for (const token of [undefined, manager]) {
          const res = await rpc(name, {}, token).expect(404);
          expect(res.body).toMatchObject({ code: 'PGRST202' });
        }
      },
    );

    it('service_role token’ı dışarıdan kabul edilmez', async () => {
      const res = await rpc(
        'get_session_data',
        {},
        supabaseServiceRoleKey(),
      ).expect(401);
      expect(res.body).toMatchObject({ code: 'PGRST303' });
    });

    it('süresi geçmiş token 401 PGRST303 "JWT expired"', async () => {
      const res = await rpc(
        'get_session_data',
        {},
        supabaseUserToken(USERS.a.parent, { expiresInSec: -60 }),
      ).expect(401);
      expect(res.body).toMatchObject({
        code: 'PGRST303',
        message: 'JWT expired',
      });
    });

    it('başka anahtarla imzalı token 401 PGRST301', async () => {
      const res = await rpc(
        'get_session_data',
        {},
        supabaseUserToken(USERS.a.parent, {
          secret: 'baska-bir-anahtar-en-az-otuz-iki-karakter',
        }),
      ).expect(401);
      expect(res.body).toMatchObject({ code: 'PGRST301' });
    });

    it('aud authenticated olmayan kullanıcı token’ı 401', async () => {
      await rpc(
        'get_session_data',
        {},
        supabaseUserToken(USERS.a.parent, { overrides: { aud: 'baska' } }),
      ).expect(401);
    });

    it('alg none token 401', async () => {
      const [, payload] = supabaseUserToken(USERS.a.parent).split('.');
      const header = Buffer.from('{"alg":"none","typ":"JWT"}').toString(
        'base64url',
      );
      await rpc('get_session_data', {}, `${header}.${payload}.`).expect(401);
    });
  });

  describe('parametreler ve hatalar (PostgREST ile aynı)', () => {
    it('bilinmeyen parametre 404 PGRST202', async () => {
      const res = await rpc(
        'parent_get_payments',
        { p_athlete_id: ATHLETES.deniz, p_fazla: 1 },
        parent,
      ).expect(404);
      expect(res.body).toMatchObject({
        code: 'PGRST202',
        message:
          'Could not find the function public.parent_get_payments(p_athlete_id, p_fazla) in the schema cache',
      });
    });

    it('eksik zorunlu parametre 404 PGRST202', async () => {
      await rpc('parent_get_payments', {}, parent).expect(404);
    });

    it('tipe uymayan değer 400 + SQLSTATE (22P02)', async () => {
      const res = await rpc(
        'parent_get_payments',
        { p_athlete_id: 'uuid-degil' },
        parent,
      ).expect(400);
      expect(res.body).toMatchObject({
        code: '22P02',
        details: null,
        hint: null,
      });
    });

    it('nesne olmayan gövde 400 PGRST102', async () => {
      await rpc('get_session_data', [1, 2], parent).expect(400);
    });

    // Nest, body-parser'ın SyntaxError'ını BadRequestException'a çevirir
    // (routes-resolver mapExternalException); kod bad_request kalır.
    it('bozuk JSON 400 (500 değil)', async () => {
      const res = await request(app.getHttpServer())
        .post('/rpc/get_session_data')
        .set('Authorization', `Bearer ${parent}`)
        .set('Content-Type', 'application/json')
        .send('{"bozuk":')
        .expect(400);
      expect(res.body).toMatchObject({ code: 'bad_request' });
    });

    it('sınırı aşan gövde 413', async () => {
      const res = await rpc(
        'get_session_data',
        { p_x: 'a'.repeat(1024 * 1024 + 10) },
        parent,
      ).expect(413);
      expect(res.body).toMatchObject({ code: 'payload_too_large' });
    });

    it('dizi parametresi (uuid[]) JSON dizisinden çevrilir', async () => {
      const env = await ok(
        'mark_notifications_read',
        { p_ids: ['00000000-0000-4000-8000-000000000000'] },
        parent,
      );
      expect(env.success).toBe(true);
    });
  });

  describe('HTTP', () => {
    it('izinli web kökenine CORS cevabı verilir, diğerine verilmez', async () => {
      const allowed = await request(app.getHttpServer())
        .options('/rpc/get_session_data')
        .set('Origin', 'https://yonetim.mobilsporokulu.com')
        .set('Access-Control-Request-Method', 'POST')
        .set(
          'Access-Control-Request-Headers',
          'authorization,content-type,apikey',
        );
      expect(allowed.status).toBe(204);
      expect(allowed.headers['access-control-allow-origin']).toBe(
        'https://yonetim.mobilsporokulu.com',
      );

      const other = await request(app.getHttpServer())
        .options('/rpc/get_session_data')
        .set('Origin', 'https://kotu.example.com')
        .set('Access-Control-Request-Method', 'POST');
      expect(other.headers['access-control-allow-origin']).toBeUndefined();
    });

    it('x-powered-by başlığı yok', async () => {
      const res = await request(app.getHttpServer()).get('/health/live');
      expect(res.headers['x-powered-by']).toBeUndefined();
    });
  });
});

describe('Hız sınırı', () => {
  let db: TestDatabase;
  let app: INestApplication<App>;

  beforeAll(async () => {
    db = await startTestDatabase();
    app = await createTestApp(db, { THROTTLE_LIMIT: '3' });
  });

  afterAll(async () => {
    await app?.close();
    await db?.stop();
  });

  it('sınırı aşan IP 429 alır; sağlık uçları sayılmaz', async () => {
    const body = { p_app: 'parent', p_platform: 'ios', p_brand: 'public' };
    for (let i = 0; i < 5; i++) {
      await request(app.getHttpServer()).get('/health/live').expect(200);
    }
    for (let i = 0; i < 3; i++) {
      await request(app.getHttpServer())
        .post('/rpc/get_min_app_version')
        .send(body)
        .expect(200);
    }
    const res = await request(app.getHttpServer())
      .post('/rpc/get_min_app_version')
      .send(body)
      .expect(429);
    expect(res.body).toMatchObject({ code: 'too_many_requests' });
  });
});
