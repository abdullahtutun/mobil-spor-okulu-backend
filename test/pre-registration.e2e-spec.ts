import { createHash, randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Client } from 'pg';
import request from 'supertest';
import type { App } from 'supertest/types';
import {
  BRANCH_A1,
  BRANCH_A2,
  SCHOOL_A,
  SCHOOL_B,
  SEED_PASSWORD,
} from './fixtures/seed-ids';
import { createTestApp, mailboxOf } from './support/app';
import { startTestDatabase, type TestDatabase } from './support/database';
import { type FakeMailbox, inviteLinkOf } from './support/fake-mail';
import { supabaseAnonKey } from './support/tokens';

const CLASS_A1 = 'a0000000-0000-4000-8000-0000000000d1'; // U10 Futbol, şube A1
const CLASS_A2 = 'a0000000-0000-4000-8000-0000000000d2'; // U12 Basketbol, şube A2
const CLASS_B = 'b0000000-0000-4000-8000-0000000000d1';
const BRANCH_B = 'b0000000-0000-4000-8000-0000000000b1';
const TOKEN_A = 'tokA2026abcd';
const TOKEN_B = 'tokB2026wxyz';
const SALT = 'e2e-ip-tuzu';

interface Envelope {
  success?: boolean;
  code?: string;
  message?: string | null;
  data?: unknown;
  error?: string;
}

interface BulkData {
  converted_count: number;
  converted: { id: string; athlete_id: string }[];
  failed: {
    id: string;
    full_name: string | null;
    code: string;
    message: string;
  }[];
}

const ipHashOf = (ip: string) =>
  createHash('sha256').update(`${SALT}:${ip}`).digest('hex');

/**
 * S10: online ön kayıt, aktarım ve site lead (ex Edge Function'lar) gerçek
 * Postgres + seed'le. Yanıt gövdeleri Edge'inkiyle aynı alanlarla; güvenlik
 * kuralları (anon'a kapalı RPC'ler, IP/telefon sınırları, kopya, bal küpü,
 * token çözümü, okul/şube kapsamı, yetki, çift aktarım, başka hesabın
 * e-postası, ILIKE kaçışı, parti sınırı) tek tek.
 *
 * Uygulama `TRUST_PROXY=1` ile açılır: her istek kendi X-Forwarded-For'unu
 * taşır, IP sayaçları testler arasında karışmaz.
 */
describe('Ön kayıt ve site lead: /functions/* (gerçek Postgres)', () => {
  let db: TestDatabase;
  let app: INestApplication<App>;
  let mail: FakeMailbox;
  let pg: Client;
  let ipCounter = 0;
  let counter = 0;

  const http = () => request(app.getHttpServer());
  const nextIp = () => `198.51.100.${++ipCounter}`;
  const uniq = (prefix: string) => `${prefix}${++counter}`;

  const login = async (email: string) =>
    (
      (
        await http()
          .post('/auth/token?grant_type=password')
          .send({ email, password: SEED_PASSWORD })
          .expect(200)
      ).body as { access_token: string }
    ).access_token;

  beforeAll(async () => {
    db = await startTestDatabase({ seed: true });
    app = await createTestApp(db, {
      TRUST_PROXY: '1',
      IP_HASH_SALT: SALT,
      SITE_LEAD_NOTIFY_TO: 'satis@mobilsporokulu.test',
      SITE_ALLOWED_ORIGINS: '',
    });
    mail = mailboxOf(app);
    pg = new Client({ connectionString: db.url });
    await pg.connect();
    await pg.query(
      `insert into public.pre_registration_links (token, school_id)
       values ($1, $2), ($3, $4)`,
      [TOKEN_A, SCHOOL_A, TOKEN_B, SCHOOL_B],
    );
  });

  afterAll(async () => {
    await pg?.end();
    await app?.close();
    await db?.stop();
  });

  // ══ submit-pre-registration ═════════════════════════════════════════════

  describe('submit-pre-registration (oturumsuz)', () => {
    const form = (overrides: Record<string, unknown> = {}) => ({
      p_token: TOKEN_A,
      p_full_name: uniq('Çocuk '),
      p_gender: 'female',
      p_date_of_birth: '2017-05-04',
      p_branch_id: BRANCH_A1,
      p_class_id: CLASS_A1,
      p_parent_full_name: 'Veli Deneme',
      p_parent_phone: uniq('55512'),
      p_parent_email: 'form.velisi@a.test',
      p_interview_date: '2026-11-30',
      p_kvkk_approved: true,
      p_health_consent: true,
      p_health_problems: 'Astım',
      p_photo_consent: true,
      ...overrides,
    });
    const submit = (body: unknown, ip = nextIp()) =>
      http()
        .post('/functions/submit-pre-registration')
        .set('X-Forwarded-For', ip)
        .set('Content-Type', 'application/json')
        .send(typeof body === 'string' ? body : JSON.stringify(body));

    const preRegistration = async (id: string) =>
      (
        await pg.query<{
          school_id: string;
          status: string;
          interview_type: string;
          health_problems: string | null;
          photo_consent_at: Date | null;
          promo_photo_consent_at: Date | null;
        }>(
          `select school_id, status::text, interview_type::text, health_problems,
                  photo_consent_at, promo_photo_consent_at
             from public.pre_registrations where id = $1`,
          [id],
        )
      ).rows[0];

    it('geçerli token: 200 app_ok zarfı, kayıt token’ın okuluna; başlık gerekmez', async () => {
      const res = await submit(
        form({ turnstile_token: 'eski-istemci' }),
      ).expect(200);
      const body = res.body as Envelope;
      expect(body).toEqual({
        success: true,
        code: 'ok',
        message: 'Ön kayıt başarıyla alındı.',
        data: { id: expect.any(String) as string },
      });
      const row = await preRegistration((body.data as { id: string }).id);
      expect(row).toMatchObject({
        school_id: SCHOOL_A,
        status: 'not_converted',
        interview_type: 'online',
        health_problems: 'Astım',
      });
      expect(row.photo_consent_at).not.toBeNull();
      expect(row.promo_photo_consent_at).toBeNull();
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
    });

    it('CORS genel kökenlerle (ön kayıt paketi yönetim alan adında)', async () => {
      const res = await http()
        .options('/functions/submit-pre-registration')
        .set('Origin', 'https://yonetim.mobilsporokulu.com')
        .set('Access-Control-Request-Method', 'POST')
        .expect(204);
      expect(res.headers['access-control-allow-origin']).toBe(
        'https://yonetim.mobilsporokulu.com',
      );
    });

    it('herhangi bir Authorization başlığı (bozuk token dahil) yok sayılır', async () => {
      await submit(form())
        .set('Authorization', 'Bearer bozuk.token')
        .expect(200);
    });

    it('token yoksa 400 validation, hiçbir şey sayılmaz', async () => {
      const ip = nextIp();
      const res = await submit(form({ p_token: '' }), ip).expect(400);
      expect(res.body).toEqual({
        success: false,
        code: 'validation',
        message: 'Bağlantı bilgisi eksik.',
        data: null,
        error: 'Bağlantı bilgisi eksik.',
      });
      const { rows } = await pg.query(
        'select 1 from public.pre_registration_attempts where ip_hash = $1',
        [ipHashOf(ip)],
      );
      expect(rows).toHaveLength(0);
    });

    it('bilinmeyen token: 400 not_found', async () => {
      const res = await submit(form({ p_token: 'olmayan-token' })).expect(400);
      expect(res.body).toMatchObject({
        success: false,
        code: 'not_found',
        message:
          'Bağlantı geçersiz ya da süresi dolmuş. Lütfen kurumla iletişime geçin.',
      });
    });

    it('silinmiş bağlantının token’ı artık çözülmez', async () => {
      await pg.query(
        `insert into public.pre_registration_links (token, school_id, is_deleted)
         values ('eski-silinmis-tok', $1, true)`,
        [SCHOOL_A],
      );
      const res = await submit(form({ p_token: 'eski-silinmis-tok' })).expect(
        400,
      );
      expect((res.body as Envelope).code).toBe('not_found');
    });

    it('eski QR: okulun kimliği de kabul edilir (geçiş dönemi)', async () => {
      const res = await submit(form({ p_token: SCHOOL_A })).expect(200);
      const row = await preRegistration(
        ((res.body as Envelope).data as { id: string }).id,
      );
      expect(row.school_id).toBe(SCHOOL_A);
      // Var olmayan bir uuid not_found.
      const missing = await submit(form({ p_token: randomUUID() })).expect(400);
      expect((missing.body as Envelope).code).toBe('not_found');
    });

    it('başka okulun sınıfı/şubesi: 400 validation (okullar arası yazım yok)', async () => {
      for (const overrides of [
        { p_branch_id: BRANCH_B, p_class_id: CLASS_B },
        { p_branch_id: BRANCH_A2, p_class_id: CLASS_A1 },
      ]) {
        const res = await submit(form(overrides)).expect(400);
        expect(res.body).toMatchObject({
          code: 'validation',
          message: 'Seçilen şube/sınıf bu okula ait değil.',
        });
      }
      // Okul B'nin token'ıyla kendi sınıfı geçer.
      await submit(
        form({ p_token: TOKEN_B, p_branch_id: BRANCH_B, p_class_id: CLASS_B }),
      ).expect(200);
    });

    it('KVKK onayı yoksa 400 validation', async () => {
      const res = await submit(form({ p_kvkk_approved: false })).expect(400);
      expect((res.body as Envelope).code).toBe('validation');
    });

    it('aynı sporcu 24 saat içinde ikinci kez: 409 conflict', async () => {
      const body = form({ p_full_name: 'Kopya Çocuk' });
      await submit(body).expect(200);
      const res = await submit({
        ...body,
        p_full_name: '  kopya ÇOCUK ',
      }).expect(409);
      expect(res.body).toMatchObject({ success: false, code: 'conflict' });
    });

    it('aynı veli telefonundan saatte 5: altıncısı 409 conflict', async () => {
      const phone = uniq('55599');
      for (let i = 0; i < 5; i++) {
        await submit(form({ p_parent_phone: phone })).expect(200);
      }
      const res = await submit(form({ p_parent_phone: phone })).expect(409);
      expect(res.body).toMatchObject({
        code: 'conflict',
        message:
          'Kısa sürede çok fazla ön kayıt gönderildi. Lütfen bir süre sonra tekrar deneyin.',
      });
    });

    it('IP başına saatte 15: on altıncısı 429, numara değiştirmek işe yaramaz', async () => {
      const ip = nextIp();
      for (let i = 0; i < 15; i++) {
        await submit(form(), ip).expect(200);
      }
      const res = await submit(form(), ip).expect(429);
      expect(res.body).toEqual({
        success: false,
        code: 'conflict',
        message:
          'Kısa sürede çok fazla ön kayıt gönderildi. Lütfen bir süre sonra tekrar deneyin.',
        data: null,
        error:
          'Kısa sürede çok fazla ön kayıt gönderildi. Lütfen bir süre sonra tekrar deneyin.',
      });
      // IP ham hâliyle saklanmaz: sha256("<tuz>:<ip>").
      const { rows } = await pg.query<{ n: number }>(
        'select count(*)::int as n from public.pre_registration_attempts where ip_hash = $1',
        [ipHashOf(ip)],
      );
      expect(rows[0].n).toBe(16);
      // Başka bir IP etkilenmez.
      await submit(form()).expect(200);
    });

    it('istemcinin yazdığı X-Forwarded-For değerine güvenilmez (yalnızca vekilin eklediği)', async () => {
      const real = nextIp();
      for (let i = 0; i < 15; i++) {
        // İstemci her seferinde başka bir "ilk" IP uyduruyor; vekil gerçeğini ekliyor.
        await submit(form(), `203.0.113.${i}, ${real}`).expect(200);
      }
      await submit(form(), `203.0.113.200, ${real}`).expect(429);
    });

    it('bilinmeyen parametre ya da tipe uymayan değer: 500 "Kayıt sırasında…"', async () => {
      for (const overrides of [
        { p_bilinmeyen: 1 },
        { p_date_of_birth: 'dün' },
      ]) {
        const res = await submit(form(overrides)).expect(500);
        expect(res.body).toEqual({
          success: false,
          code: 'internal',
          message: 'Kayıt sırasında bir hata oluştu.',
          data: null,
          error: 'Kayıt sırasında bir hata oluştu.',
        });
      }
    });

    it('bozuk JSON: 500 "Beklenmeyen…" (Edge’in req.json() hatası)', async () => {
      const res = await submit('{"p_token": ').expect(500);
      expect(res.body).toMatchObject({
        success: false,
        code: 'internal',
        message: 'Beklenmeyen bir hata oluştu.',
      });
    });

    it('anon RPC’yi doğrudan çağıramaz: gateway 404, veritabanı EXECUTE yok', async () => {
      for (const name of [
        'create_public_pre_registration_by_token',
        'create_public_pre_registration',
        'record_pre_registration_attempt',
        'resolve_pre_registration_token',
        'submit_site_lead',
        'convert_pre_registration',
      ]) {
        const res = await http()
          .post(`/rpc/${name}`)
          .set('Authorization', `Bearer ${supabaseAnonKey()}`)
          .send({ p_token: TOKEN_A })
          .expect(404);
        expect(res.body).toMatchObject({ code: 'PGRST202' });
      }
      const { rows } = await pg.query<{
        fn: string;
        anon: boolean;
        auth: boolean;
      }>(
        `select p.proname as fn,
                has_function_privilege('anon', p.oid, 'execute') as anon,
                has_function_privilege('authenticated', p.oid, 'execute') as auth
           from pg_proc p
          where p.pronamespace = 'public'::regnamespace
            and p.proname in ('create_public_pre_registration_by_token',
                              'create_public_pre_registration',
                              'record_pre_registration_attempt',
                              'resolve_pre_registration_token',
                              'submit_site_lead')
          order by 1`,
      );
      expect(rows).toHaveLength(5);
      for (const row of rows)
        expect(row).toMatchObject({ anon: false, auth: false });
    });

    it('formun okumaları (public_get_*_by_token) anon olarak çalışır', async () => {
      const anon = supabaseAnonKey();
      const branches = await http()
        .post('/rpc/public_get_branches_by_token')
        .set('Authorization', `Bearer ${anon}`)
        .send({ p_token: TOKEN_A })
        .expect(200);
      expect(branches.body).toMatchObject({ success: true });
      expect(JSON.stringify(branches.body)).toContain(BRANCH_A1);
      expect(JSON.stringify(branches.body)).not.toContain(BRANCH_B);

      const classes = await http()
        .post('/rpc/public_get_classes_by_token')
        .send({ p_token: TOKEN_A })
        .expect(200);
      expect(classes.body).toMatchObject({ success: true });
      expect(JSON.stringify(classes.body)).toContain(CLASS_A1);

      const branding = await http()
        .post('/rpc/public_get_school_branding_by_token')
        .send({ p_token: TOKEN_B })
        .expect(200);
      expect(JSON.stringify(branding.body)).toContain('Örnek Spor Akademisi');
    });
  });

  // ══ convert-pre-registration / bulk-convert-pre-registrations ═══════════

  describe('aktarım', () => {
    let gmA: string;
    let bmA: string; // şube müdürü, yalnızca A1
    let coachA: string;
    let accountantA: string;

    beforeAll(async () => {
      gmA = await login('genel.mudur@a.test');
      bmA = await login('sube.muduru@a.test');
      coachA = await login('antrenor@a.test');
      accountantA = await login('muhasebe@a.test');
    });

    /** Doğrudan (postgres) bir ön kayıt satırı. */
    const insertPre = async (o: {
      branch?: string;
      classId?: string | null;
      school?: string;
      name?: string;
      parentEmail: string;
      parentName?: string;
      parent2Email?: string | null;
      parent2Name?: string | null;
      status?: string;
    }) => {
      const { rows } = await pg.query<{ id: string }>(
        `insert into public.pre_registrations (
           school_id, full_name, gender, date_of_birth, class_id, interviewer_name,
           interview_type, branch_id, interview_date, parent_full_name,
           parent_phone, parent_email, parent2_full_name, parent2_email, status)
         values ($1, $2, 'male', '2016-01-01', $3, 'Görüşmeci', 'face_to_face',
                 $4, '2026-11-20', $5, '5551112233', $6, $7, $8,
                 $9::public.registration_status)
         returning id`,
        [
          o.school ?? SCHOOL_A,
          o.name ?? uniq('Aday '),
          o.classId === undefined ? CLASS_A1 : o.classId,
          o.branch ?? BRANCH_A1,
          o.parentName ?? 'Yeni Veli',
          o.parentEmail,
          o.parent2Name ?? null,
          o.parent2Email ?? null,
          o.status ?? 'not_converted',
        ],
      );
      return rows[0].id;
    };

    const fn = (name: string, token: string | null, body: unknown) => {
      const req = http().post(`/functions/${name}`);
      if (token !== null) req.set('Authorization', `Bearer ${token}`);
      return req.send(body as object);
    };
    const bulk = (token: string, ids: unknown) =>
      fn('bulk-convert-pre-registrations', token, { ids });
    const bulkData = async (token: string, ids: unknown) =>
      ((await bulk(token, ids).expect(200)).body as Envelope).data as BulkData;

    /** Uygulamanın tekli aktarım gövdesi (`pre_registration_data_source.dart`). */
    const formOf = async (id: string) => {
      const { rows } = await pg.query<Record<string, unknown>>(
        `select id, school_id, full_name, gender::text, to_char(date_of_birth, 'YYYY-MM-DD') as date_of_birth,
                branch_id, class_id, interviewer_name, interview_type::text,
                to_char(interview_date, 'YYYY-MM-DD') as interview_date,
                parent_full_name, parent_phone, parent_email,
                parent2_full_name, parent2_phone, parent2_email
           from public.pre_registrations where id = $1`,
        [id],
      );
      return rows[0];
    };

    const statusOf = async (id: string) =>
      (
        await pg.query<{ status: string }>(
          'select status::text from public.pre_registrations where id = $1',
          [id],
        )
      ).rows[0].status;
    const authUserCount = async (email: string) =>
      (
        await pg.query<{ n: number }>(
          'select count(*)::int as n from auth.users where lower(email) = lower($1)',
          [email],
        )
      ).rows[0].n;
    const profileByEmail = async (email: string) =>
      (
        await pg.query<{ id: string; role_id: string; school_id: string }>(
          'select id, role_id, school_id from public.profiles where lower(email) = lower($1)',
          [email],
        )
      ).rows;
    const parentsOfAthlete = async (athleteId: string) =>
      (
        await pg.query<{ profile_id: string }>(
          `select profile_id from public.parent_athlete_links
            where athlete_id = $1 and is_deleted is not true order by 1`,
          [athleteId],
        )
      ).rows.map((r) => r.profile_id);

    describe('kapı ve yetki', () => {
      it.each(['convert-pre-registration', 'bulk-convert-pre-registrations'])(
        '%s: başlıksız 401, geçersiz token 401 PGRST, anon anahtarı fonksiyonun 401’i',
        async (name) => {
          await fn(name, null, { id: randomUUID() }).expect(401);
          const bad = await fn(name, 'bozuk.token.x', {
            ids: [randomUUID()],
          }).expect(401);
          expect(String((bad.body as { code: string }).code)).toMatch(
            /^PGRST30/,
          );
          const anon = await fn(name, supabaseAnonKey(), {
            id: randomUUID(),
            ids: [randomUUID()],
          }).expect(401);
          expect(anon.body).toEqual({
            success: false,
            code: 'forbidden',
            message: 'Oturum doğrulanamadı. Lütfen tekrar giriş yapın.',
            data: null,
            error: 'Oturum doğrulanamadı. Lütfen tekrar giriş yapın.',
          });
        },
      );

      it('registration.manage olmayan (antrenör, muhasebeci): 403, davet gitmez, kayıt değişmez', async () => {
        const email = `${uniq('yetkisiz')}@veli.test`;
        const id = await insertPre({ parentEmail: email });
        for (const token of [coachA, accountantA]) {
          const single = await fn(
            'convert-pre-registration',
            token,
            await formOf(id),
          ).expect(403);
          expect(single.body).toMatchObject({
            success: false,
            code: 'forbidden',
            message: 'Bu işlemi gerçekleştirmek için yetkiniz yok.',
          });
          await bulk(token, [id]).expect(403);
        }
        await mail.settle();
        expect(mail.to(email)).toHaveLength(0);
        expect(await authUserCount(email)).toBe(0);
        expect(await statusOf(id)).toBe('not_converted');
      });

      it('gövdedeki school_id başka okul: 403', async () => {
        const id = await insertPre({
          parentEmail: `${uniq('okul')}@veli.test`,
        });
        const res = await fn('convert-pre-registration', gmA, {
          ...(await formOf(id)),
          school_id: SCHOOL_B,
        }).expect(403);
        expect(res.body).toMatchObject({
          code: 'forbidden',
          message: 'Bu okul üzerinde işlem yapma yetkiniz yok.',
        });
      });

      it('id yoksa 400 validation', async () => {
        const res = await fn('convert-pre-registration', gmA, {}).expect(400);
        expect(res.body).toEqual({
          success: false,
          code: 'validation',
          message:
            "İşlem için 'id' (pre_registration_id) parametresi zorunludur.",
          data: null,
          error:
            "İşlem için 'id' (pre_registration_id) parametresi zorunludur.",
        });
      });
    });

    describe('tekli aktarım', () => {
      it('formu kaydeder, aktarır, veliyi okulun markasıyla davet eder', async () => {
        const email = `${uniq('tekli')}@veli.test`;
        const id = await insertPre({
          parentEmail: email,
          parentName: 'Eski Ad',
        });
        const form = {
          ...(await formOf(id)),
          parent_full_name: 'Yeni Ad Soyad',
        };
        const res = await fn('convert-pre-registration', bmA, form).expect(200);
        const body = res.body as Envelope;
        expect(body).toEqual({
          success: true,
          code: 'ok',
          message:
            'Ön kayıt kesin kayda aktarıldı. Veli hesapları ve davetleri tamamlandı.',
          data: { athlete_id: expect.any(String) as string },
        });
        const athleteId = (body.data as { athlete_id: string }).athlete_id;
        expect(await statusOf(id)).toBe('converted');

        const [parent] = await profileByEmail(email);
        expect(parent).toMatchObject({ role_id: '8', school_id: SCHOOL_A });
        expect(await parentsOfAthlete(athleteId)).toEqual([parent.id]);
        const { rows } = await pg.query<{ full_name: string }>(
          'select full_name from public.profiles where id = $1',
          [parent.id],
        );
        expect(rows[0].full_name).toBe('Yeni Ad Soyad');

        const invite = await mail.waitFor(email);
        expect(invite.brand).toBe('dev_adim');
        expect(inviteLinkOf(invite).origin).toBe('https://mobil.devadim.com');
      });

      it('ikinci kez aktarım: 400 conflict, ikinci sporcu açılmaz', async () => {
        const email = `${uniq('cift')}@veli.test`;
        const id = await insertPre({ parentEmail: email });
        const form = await formOf(id);
        await fn('convert-pre-registration', gmA, form).expect(200);
        const again = await fn('convert-pre-registration', gmA, form).expect(
          400,
        );
        expect(again.body).toMatchObject({ success: false, code: 'conflict' });
        const viaBulk = (await bulk(gmA, [id]).expect(200)).body as Envelope;
        expect((viaBulk.data as BulkData).failed[0]).toMatchObject({
          code: 'conflict',
          message: 'Bu ön kayıt zaten kesin kayda aktarılmış.',
        });
        const { rows } = await pg.query<{ n: number }>(
          `select count(*)::int as n from public.athletes a
             join public.parent_athlete_links l on l.athlete_id = a.id
             join public.profiles p on p.id = l.profile_id
            where p.email = $1`,
          [email],
        );
        expect(rows[0].n).toBe(1);
      });

      it('şube kapsamı dışındaki kayıt: reddedilir, davet gitmez', async () => {
        const email = `${uniq('kapsam')}@veli.test`;
        const id = await insertPre({
          parentEmail: email,
          branch: BRANCH_A2,
          classId: CLASS_A2,
        });
        const res = await fn('convert-pre-registration', bmA, await formOf(id));
        expect(res.status).toBeGreaterThanOrEqual(400);
        expect((res.body as Envelope).success).toBe(false);
        await mail.settle();
        expect(mail.to(email)).toHaveLength(0);
        expect(await statusOf(id)).toBe('not_converted');
      });

      it('form alanı eksikse PostgREST’in imza hatası 400 internal', async () => {
        const id = await insertPre({
          parentEmail: `${uniq('eksik')}@veli.test`,
        });
        const form = await formOf(id);
        delete form.full_name;
        const res = await fn('convert-pre-registration', gmA, form).expect(400);
        expect(res.body).toMatchObject({ success: false, code: 'internal' });
        expect(String((res.body as Envelope).message)).toContain(
          'Could not find the function public.update_pre_registration',
        );
      });
    });

    describe('toplu aktarım', () => {
      it('kısmi başarı: bir kaydın hatası diğerlerini durdurmaz; her hata nedeniyle', async () => {
        const okEmail = `${uniq('toplu')}@veli.test`;
        const ok = await insertPre({
          parentEmail: okEmail,
          name: 'Başarılı Aday',
        });
        const staff = await insertPre({
          parentEmail: 'ANTRENOR@a.test',
          name: 'Personel E-postalı',
        });
        const otherSchool = await insertPre({
          parentEmail: 'veli@b.test',
          name: 'Başka Okul Velili',
        });
        const missing = randomUUID();
        const res = await bulk(gmA, [
          ok,
          staff,
          ok,
          otherSchool,
          missing,
        ]).expect(200);
        const body = res.body as Envelope;
        expect(body).toMatchObject({
          success: true,
          code: 'ok',
          message: '1 ön kayıt aktarıldı, 3 kayıt aktarılamadı.',
        });
        const data = body.data as BulkData;
        expect(data.converted_count).toBe(1);
        expect(data.converted).toEqual([
          { id: ok, athlete_id: expect.any(String) as string },
        ]);
        expect(data.failed).toEqual([
          {
            id: staff,
            full_name: 'Personel E-postalı',
            code: 'conflict',
            message: 'antrenor@a.test adresi başka bir hesapta kullanılıyor.',
          },
          {
            id: otherSchool,
            full_name: 'Başka Okul Velili',
            code: 'conflict',
            message: 'veli@b.test adresi başka bir hesapta kullanılıyor.',
          },
          {
            id: missing,
            full_name: null,
            code: 'not_found',
            message:
              'Ön kayıt bulunamadı veya bu kayıt üzerinde işlem yetkiniz yok.',
          },
        ]);
        expect(await statusOf(staff)).toBe('not_converted');
        expect(await statusOf(otherSchool)).toBe('not_converted');
        // Personelin ve okul B velisinin hesabına dokunulmadı.
        expect(await authUserCount('antrenor@a.test')).toBe(1);
        expect(await authUserCount('veli@b.test')).toBe(1);
      });

      it('hepsi başarılı: mesaj "N ön kayıt kesin kayda aktarıldı."', async () => {
        const ids = [
          await insertPre({ parentEmail: `${uniq('hep')}@veli.test` }),
          await insertPre({ parentEmail: `${uniq('hep')}@veli.test` }),
        ];
        const body = (await bulk(bmA, ids).expect(200)).body as Envelope;
        expect(body.message).toBe('2 ön kayıt kesin kayda aktarıldı.');
      });

      it('kardeşler aynı veliyi paylaşır: tek davet, tek hesap; sonraki kardeş var olan veliyi kullanır', async () => {
        const email = `${uniq('kardes')}@veli.test`;
        const a = await insertPre({ parentEmail: email, name: 'Kardeş Bir' });
        const b = await insertPre({
          parentEmail: `  ${email.toUpperCase()} `,
          name: 'Kardeş İki',
        });
        const data = await bulkData(gmA, [a, b]);
        expect(data.converted_count).toBe(2);
        await mail.settle();
        expect(mail.to(email)).toHaveLength(1);
        const parents = await profileByEmail(email);
        expect(parents).toHaveLength(1);
        for (const c of data.converted) {
          expect(await parentsOfAthlete(c.athlete_id)).toEqual([parents[0].id]);
        }

        // Ayrı bir istekte üçüncü kardeş: davet yok, aynı veli.
        const c = await insertPre({ parentEmail: email, name: 'Kardeş Üç' });
        const third = await bulkData(gmA, [c]);
        expect(third.converted_count).toBe(1);
        await mail.settle();
        expect(mail.to(email)).toHaveLength(1);
        expect(await parentsOfAthlete(third.converted[0].athlete_id)).toEqual([
          parents[0].id,
        ]);
      });

      it('anne ve baba aynı adresi yazmışsa tek hesap', async () => {
        const email = `${uniq('ayni')}@veli.test`;
        const id = await insertPre({
          parentEmail: email,
          parent2Email: email,
          parent2Name: 'İkinci Veli',
        });
        const data = await bulkData(gmA, [id]);
        expect(data.converted_count).toBe(1);
        expect(
          await parentsOfAthlete(data.converted[0].athlete_id),
        ).toHaveLength(1);
      });

      it('ILIKE jokerleri kaçışlanır: a_b@… başka birinin axb@… hesabıyla eşleşmez', async () => {
        const tag = uniq('');
        const victim = `ax${tag}b@ilike.test`;
        const victimPct = `yy${tag}zz@ilike.test`;
        // Okul A'da var olan veliler.
        for (const email of [victim, victimPct]) {
          const pid = randomUUID();
          await pg.query(
            `insert into auth.users (id, aud, role, email, encrypted_password, raw_user_meta_data)
             values ($1, 'authenticated', 'authenticated', $2, '', '{}')`,
            [pid, email],
          );
          await pg.query(
            `insert into public.profiles (id, school_id, full_name, email, status, role_id)
             values ($1, $2, 'Var Olan Veli', $3, 'active', 8)`,
            [pid, SCHOOL_A, email],
          );
        }
        const underscore = `a_${tag}b@ilike.test`;
        const percent = `yy${tag}%@ilike.test`;
        const id1 = await insertPre({ parentEmail: underscore });
        const id2 = await insertPre({ parentEmail: percent });
        const data = await bulkData(gmA, [id1, id2]);
        expect(data.converted_count).toBe(2);
        const [victimProfile] = await profileByEmail(victim);
        const [victimPctProfile] = await profileByEmail(victimPct);
        for (const c of data.converted) {
          const parents = await parentsOfAthlete(c.athlete_id);
          expect(parents).not.toContain(victimProfile.id);
          expect(parents).not.toContain(victimPctProfile.id);
        }
        // Joker içeren adreslere yeni hesap açıldı ve davet gitti.
        expect(await authUserCount(underscore)).toBe(1);
        expect(await authUserCount(percent)).toBe(1);
        await mail.waitFor(underscore);
        await mail.waitFor(percent);
      });

      it('davet geri alma: ikinci veli reddedilirse ilk veli için açılan hesap silinir', async () => {
        const first = `${uniq('geri')}@veli.test`;
        const id = await insertPre({
          parentEmail: first,
          parent2Email: 'veli@b.test',
          parent2Name: 'Başka Okul',
        });
        const data = await bulkData(gmA, [id]);
        expect(data.failed[0]).toMatchObject({ id, code: 'conflict' });
        expect(await authUserCount(first)).toBe(0);
        expect(await profileByEmail(first)).toHaveLength(0);
        expect(await statusOf(id)).toBe('not_converted');
      });

      it('RPC reddederse (sınıf başka şubede) açılan veli hesabı silinir', async () => {
        const email = `${uniq('rpc')}@veli.test`;
        const id = await insertPre({ parentEmail: email, classId: CLASS_A2 });
        const data = await bulkData(gmA, [id]);
        expect(data.converted_count).toBe(0);
        expect(data.failed[0].code).not.toBe('ok');
        expect(await authUserCount(email)).toBe(0);
        expect(await statusOf(id)).toBe('not_converted');
      });

      it('davet e-postası gitmezse kayıt aktarılmaz, hesap kalmaz', async () => {
        const email = `${uniq('smtp')}@veli.test`;
        const id = await insertPre({ parentEmail: email });
        mail.failNext();
        const data = await bulkData(gmA, [id]);
        expect(data.failed[0]).toMatchObject({ code: 'internal' });
        expect(data.failed[0].message).toContain(
          `${email} için davet gönderilemedi`,
        );
        expect(await authUserCount(email)).toBe(0);
        expect(await statusOf(id)).toBe('not_converted');
      });

      it('sınıfsız kayıt: davetten önce validation', async () => {
        const email = `${uniq('sinifsiz')}@veli.test`;
        // class_id NOT NULL; sınıfsız kayıt silinmiş sınıfın SET NULL'ından
        // gelemez, ama ön kontrol yine Edge'deki gibi.
        const id = await insertPre({ parentEmail: email });
        await pg.query(
          'alter table public.pre_registrations alter column class_id drop not null',
        );
        try {
          await pg.query(
            'update public.pre_registrations set class_id = null where id = $1',
            [id],
          );
          const data = await bulkData(gmA, [id]);
          expect(data.failed[0]).toMatchObject({
            code: 'validation',
            message: 'Ön kaydın sınıfı seçilmemiş.',
          });
          await mail.settle();
          expect(mail.to(email)).toHaveLength(0);
        } finally {
          await pg.query('delete from public.pre_registrations where id = $1', [
            id,
          ]);
          await pg.query(
            'alter table public.pre_registrations alter column class_id set not null',
          );
        }
      });

      it('şube müdürü başka şubenin kaydını göremez: not_found, davet yok', async () => {
        const email = `${uniq('a2')}@veli.test`;
        const id = await insertPre({
          parentEmail: email,
          branch: BRANCH_A2,
          classId: CLASS_A2,
        });
        const data = await bulkData(bmA, [id]);
        expect(data.failed).toEqual([
          {
            id,
            full_name: null,
            code: 'not_found',
            message:
              'Ön kayıt bulunamadı veya bu kayıt üzerinde işlem yetkiniz yok.',
          },
        ]);
        await mail.settle();
        expect(mail.to(email)).toHaveLength(0);
      });

      it.each([
        [[], 'Aktarılacak kayıt seçilmedi.'],
        ['tek-id', 'Aktarılacak kayıt seçilmedi.'],
        [['uuid-degil'], 'Geçersiz kayıt kimliği gönderildi.'],
        [
          Array.from({ length: 51 }, () => randomUUID()),
          'Tek seferde en fazla 50 kayıt aktarılabilir.',
        ],
      ])('geçersiz ids → 400 validation (%#)', async (ids, message) => {
        const res = await bulk(gmA, ids).expect(400);
        expect(res.body).toEqual({
          success: false,
          code: 'validation',
          message,
          data: null,
          error: message,
        });
      });

      it('50 kayıt (yinelenenler tekilleşince) sınırın içinde', async () => {
        const one = randomUUID();
        const ids = [
          ...Array.from({ length: 49 }, () => randomUUID()),
          one,
          one,
        ];
        const data = await bulkData(gmA, ids);
        expect(data.failed).toHaveLength(50);
      });
    });
  });

  // ══ site-lead ════════════════════════════════════════════════════════════

  describe('site-lead (oturumsuz, tanıtım sitesi)', () => {
    const SITE = 'https://mobilsporokulu.com';
    const NOTIFY = 'satis@mobilsporokulu.test';
    const lead = (overrides: Record<string, unknown> = {}) => ({
      kind: 'demo',
      full_name: '  Ayşe   Yılmaz ',
      phone: `0532 ${String(1000000 + ++counter).slice(-7)}`,
      email: 'ayse@okul.test',
      school_name: 'Yıldızlar Spor Okulu',
      city: null,
      athlete_count: '51-150',
      message: null,
      privacy_notice_ack: true,
      source_page: '/demo/',
      utm_source: 'instagram',
      utm_medium: null,
      utm_campaign: 'ekim',
      website: '',
      elapsed_ms: 8124,
      ...overrides,
    });
    const phoneOf = (body: { phone: string }) =>
      body.phone.replace(/\D/g, '').replace(/^0/, '');
    const send = (body: unknown, ip = nextIp()) =>
      http()
        .post('/functions/site-lead')
        .set('Origin', SITE)
        .set('X-Forwarded-For', ip)
        .set('Content-Type', 'application/json')
        .send(typeof body === 'string' ? body : JSON.stringify(body));
    const leadRows = async (phone: string) =>
      (
        await pg.query<{
          kind: string;
          full_name: string;
          ip_hash: string | null;
        }>(
          'select kind, full_name, ip_hash from public.site_leads where phone = $1',
          [phone],
        )
      ).rows;
    const OK = { success: true, code: 'ok', message: null, data: null };

    it('geçerli talep: 200, satır (IP özetiyle), bildirim e-postası arka planda', async () => {
      const body = lead();
      const ip = nextIp();
      const res = await send(body, ip).expect(200);
      expect(res.body).toEqual(OK);
      expect(res.headers['access-control-allow-origin']).toBe(SITE);
      expect(res.headers.vary).toContain('Origin');
      expect(await leadRows(phoneOf(body))).toEqual([
        { kind: 'demo', full_name: 'Ayşe Yılmaz', ip_hash: ipHashOf(ip) },
      ]);
      const sent = await mail.waitFor(NOTIFY);
      expect(sent.brand).toBe('public');
      expect(sent.message).toMatchObject({
        from: {
          name: 'Mobil Spor Okulu',
          address: 'noreply@mobilsporokulu.test',
        },
        replyTo: 'ayse@okul.test',
        subject: 'Demo talebi: Ayşe Yılmaz',
      });
      expect(sent.message.text).toContain('Okul: Yıldızlar Spor Okulu');
      expect(sent.message.html).toBeUndefined();
    });

    it('CORS yalnızca site kökenleri: ön uçuş 204; yabancı ve yönetim kökeni başlıksız', async () => {
      const pre = await http()
        .options('/functions/site-lead')
        .set('Origin', 'https://www.mobilsporokulu.com')
        .set('Access-Control-Request-Method', 'POST')
        .expect(204);
      expect(pre.headers).toMatchObject({
        'access-control-allow-origin': 'https://www.mobilsporokulu.com',
        'access-control-allow-headers': 'content-type',
        'access-control-allow-methods': 'POST, OPTIONS',
        'access-control-max-age': '86400',
      });
      for (const origin of [
        'https://kotu.example',
        'https://yonetim.mobilsporokulu.com',
      ]) {
        const res = await http()
          .options('/functions/site-lead')
          .set('Origin', origin)
          .set('Access-Control-Request-Method', 'POST')
          .expect(204);
        expect(res.headers['access-control-allow-origin']).toBeUndefined();
      }
    });

    it('bal küpü ya da 3 sn’den hızlı: sahte başarı, satır ve e-posta yok', async () => {
      for (const overrides of [
        { website: 'http://spam' },
        { elapsed_ms: 900 },
      ]) {
        const body = lead(overrides);
        const res = await send(body).expect(200);
        expect(res.body).toEqual(OK);
        expect(await leadRows(phoneOf(body))).toHaveLength(0);
      }
      await mail.settle();
      expect(
        mail.to(NOTIFY).filter((m) => m.message.text.includes('spam')),
      ).toHaveLength(0);
    });

    it('doğrulama: 400 validation ve metni', async () => {
      const res = await send(lead({ phone: '0212 123 45 67' })).expect(400);
      expect(res.body).toEqual({
        success: false,
        code: 'validation',
        message: 'Geçerli bir cep telefonu girin.',
        data: null,
        error: 'Geçerli bir cep telefonu girin.',
      });
    });

    it('bozuk JSON 400 "İstek okunamadı.", 16 KB üstü 413, GET 405', async () => {
      const bad = await send('{"kind":').expect(400);
      expect(bad.body).toMatchObject({
        code: 'validation',
        message: 'İstek okunamadı.',
      });
      const arr = await send('[1,2]').expect(400);
      expect(arr.body).toMatchObject({ message: 'İstek okunamadı.' });
      const big = await send(lead({ message: 'x'.repeat(17 * 1024) })).expect(
        413,
      );
      expect(big.body).toMatchObject({
        code: 'validation',
        message: 'İstek çok büyük.',
      });
      expect(big.headers['access-control-allow-origin']).toBe(SITE);
      const get = await http().get('/functions/site-lead').expect(405);
      expect(get.body).toMatchObject({
        code: 'validation',
        message: 'POST bekleniyor.',
      });
    });

    it('çift gönderim (10 dk, aynı telefon + tür): 200, tek satır, tek e-posta', async () => {
      const body = lead({ full_name: 'Çift Gönderen' });
      const before = mail.to(NOTIFY).length;
      await send(body).expect(200);
      await send(body).expect(200);
      expect(await leadRows(phoneOf(body))).toHaveLength(1);
      await mail.waitFor(NOTIFY, before + 1);
      await mail.settle();
      expect(mail.to(NOTIFY)).toHaveLength(before + 1);
    });

    it('telefon başına 24 saatte 3: dördüncüsü 429 conflict', async () => {
      const body = lead();
      const phone = phoneOf(body);
      await pg.query(
        `insert into public.site_leads (kind, full_name, phone, school_name, athlete_count, created_at)
         select 'demo', 'Eski', $1, 'Okul', '1-50', now() - interval '2 hours'
           from generate_series(1, 3)`,
        [phone],
      );
      const res = await send(body).expect(429);
      expect(res.body).toMatchObject({
        success: false,
        code: 'conflict',
        message:
          'Bu numaradan bugün yeterince talep aldık; size en kısa sürede dönüş yapacağız.',
      });
    });

    it('IP başına saatte 5: altıncısı 429 (numara değiştirse de)', async () => {
      const ip = nextIp();
      for (let i = 0; i < 5; i++) await send(lead(), ip).expect(200);
      const res = await send(lead(), ip).expect(429);
      expect(res.body).toMatchObject({
        code: 'conflict',
        message:
          'Kısa sürede çok fazla talep gönderildi. Lütfen daha sonra tekrar deneyin.',
      });
    });

    it('anon site_leads’i okuyamaz/yazamaz (RLS açık, politika ve yetki yok)', async () => {
      const { rows } = await pg.query<{
        sel: boolean;
        ins: boolean;
        rls: boolean;
      }>(
        `select has_table_privilege('anon', 'public.site_leads', 'select') as sel,
                has_table_privilege('authenticated', 'public.site_leads', 'insert') as ins,
                relrowsecurity as rls
           from pg_class where oid = 'public.site_leads'::regclass`,
      );
      expect(rows[0]).toEqual({ sel: false, ins: false, rls: true });
    });
  });
});
