import type { INestApplication } from '@nestjs/common';
import { Client } from 'pg';
import request from 'supertest';
import type { App } from 'supertest/types';
import {
  ATHLETES,
  BRANCH_A1,
  BRANCH_A2,
  SCHOOL_A,
  SCHOOL_B,
  SEED_PASSWORD,
  USERS,
} from './fixtures/seed-ids';
import { createTestApp, mailboxOf } from './support/app';
import { startTestDatabase, type TestDatabase } from './support/database';
import { type FakeMailbox, inviteLinkOf } from './support/fake-mail';
import { supabaseAnonKey, supabaseUserToken } from './support/tokens';

const EMAIL = {
  gmA: 'genel.mudur@a.test',
  bmA: 'sube.muduru@a.test',
  assistantA: 'mudur.yardimcisi@a.test',
  coachA: 'antrenor@a.test',
  coach2A: 'antrenor2@a.test',
  accountantA: 'muhasebe@a.test',
  parentA: 'veli@a.test',
  gmB: 'genel.mudur@b.test',
  coachB: 'antrenor@b.test',
  parentB: 'veli@b.test',
} as const;

/** Fonksiyon yanıtlarının (ve auth hatalarının) okunan alanları. */
interface FnBody {
  success?: boolean;
  error?: string;
  code?: string;
  message?: string;
  reason?: string | null;
  access_token?: string;
}

interface Session {
  access_token: string;
  refresh_token: string;
}

/**
 * S09: hesap işlemleri (ex Edge Function'lar) gerçek Postgres + seed'le.
 * Her uç için başarı, yetkisiz çağıran ve doğrulama hatası; yanıt gövdeleri
 * uygulamaların okuduğu şekilde (`RpcEnvelope.fromEdge` /
 * `fromFunctionException`, `mapDeleteAccountFailure` → `reason`).
 *
 * Testler seed'i değiştirir; sıraları önemlidir (her blok kendi hesaplarını
 * açar, seed hesaplarından yalnızca bozmadıklarını kullanır).
 */
describe('Hesap işlemleri: /functions/* (gerçek Postgres)', () => {
  let db: TestDatabase;
  let app: INestApplication<App>;
  let mail: FakeMailbox;
  let pg: Client;
  let counter = 0;

  const http = () => request(app.getHttpServer());
  const nextEmail = (prefix: string) => `${prefix}${++counter}@hesap.test`;

  const login = async (email: string, password = SEED_PASSWORD) =>
    (
      await http()
        .post('/auth/token?grant_type=password')
        .send({ email, password })
        .expect(200)
    ).body as Session;
  const tokenOf = async (email: string) => (await login(email)).access_token;

  const fn = (name: string, token: string | null, body: unknown) => {
    const req = http().post(`/functions/${name}`);
    if (token !== null) req.set('Authorization', `Bearer ${token}`);
    return req.send(body as object);
  };

  const authUser = async (email: string) =>
    (
      await pg.query<{
        id: string;
        email_confirmed_at: Date | null;
        invited_at: Date | null;
        raw_user_meta_data: Record<string, unknown>;
      }>(
        `select id, email_confirmed_at, invited_at, raw_user_meta_data
           from auth.users where lower(email) = lower($1)`,
        [email],
      )
    ).rows[0];

  const profile = async (id: string) =>
    (
      await pg.query<{
        full_name: string;
        email: string;
        role_id: string;
        school_id: string;
        status: string;
        is_deleted: boolean;
      }>(
        `select full_name, email, role_id, school_id, status, is_deleted
           from public.profiles where id = $1`,
        [id],
      )
    ).rows[0];

  const liveLinks = async (table: string, column: string, profileId: string) =>
    (
      await pg.query<{ id: string }>(
        `select ${column} as id from public.${table}
          where profile_id = $1 and is_deleted is not true order by 1`,
        [profileId],
      )
    ).rows.map((r) => r.id);

  beforeAll(async () => {
    db = await startTestDatabase({ seed: true });
    app = await createTestApp(db);
    mail = mailboxOf(app);
    pg = new Client({ connectionString: db.url });
    await pg.connect();
  });

  afterAll(async () => {
    await pg?.end();
    await app?.close();
    await db?.stop();
  });

  // ── ağ geçidi (Supabase: verify_jwt) ────────────────────────────────────

  describe('token', () => {
    const names = [
      'create-user',
      'update-user',
      'create-parent',
      'update-parent',
      'delete-account',
    ];

    it.each(names)('%s: başlıksız istek 401, fonksiyon çalışmaz', async (n) => {
      const res = await fn(n, null, { password: 'x' }).expect(401);
      expect(res.body).toEqual({
        code: 'UNAUTHORIZED_NO_AUTH_HEADER',
        message: 'Missing authorization header',
      });
    });

    it.each(names)(
      '%s: süresi geçmiş token 401 PGRST303 (uygulama yeniler)',
      async (n) => {
        const res = await fn(
          n,
          supabaseUserToken(USERS.a.generalManager, { expiresInSec: -60 }),
          {},
        ).expect(401);
        expect((res.body as FnBody).code).toBe('PGRST303');
      },
    );

    it('anon anahtarı fonksiyonun kendi "oturum" hatasını alır', async () => {
      const anon = supabaseAnonKey();
      expect(
        (await fn('create-user', anon, { email: 'x@y.test' }).expect(400)).body,
      ).toEqual({
        success: false,
        error: 'Oturum doğrulanamadı. Lütfen tekrar giriş yapın.',
      });
      expect((await fn('create-parent', anon, {}).expect(400)).body).toEqual({
        success: false,
        error: 'Admin girişi yapılmamış.',
      });
      expect(
        (await fn('delete-account', anon, { password: 'x' }).expect(401)).body,
      ).toEqual({
        success: false,
        code: 'forbidden',
        reason: null,
        message: 'Oturumunuz doğrulanamadı. Lütfen yeniden giriş yapın.',
        data: null,
        error: 'Oturumunuz doğrulanamadı. Lütfen yeniden giriş yapın.',
      });
    });

    it("çıkış yapılmış oturumun token'ı reddedilir (oturumu kapalı)", async () => {
      const session = await login(EMAIL.gmA);
      await http()
        .post('/auth/logout?scope=local')
        .set('Authorization', `Bearer ${session.access_token}`)
        .expect(204);
      const res = await fn('create-user', session.access_token, {}).expect(400);
      expect((res.body as FnBody).error).toBe(
        'Oturum doğrulanamadı. Lütfen tekrar giriş yapın.',
      );
    });
  });

  // ── create-user ─────────────────────────────────────────────────────────

  describe('create-user', () => {
    const coachBody = (email: string, extra: Record<string, unknown> = {}) => ({
      school_id: SCHOOL_A,
      email,
      password: 'Antrenor123',
      full_name: 'Yeni Antrenör',
      phone_number: '5551112233',
      birth_of_date: '1990-05-01',
      status: 'active',
      branch_ids: [BRANCH_A1],
      role_id: 4,
      permissions: [],
      ...extra,
    });

    it('genel müdür antrenör açar: onaylı auth hesabı + profil + şube; şifreyle girer', async () => {
      const email = nextEmail('antrenor');
      const res = await fn(
        'create-user',
        await tokenOf(EMAIL.gmA),
        coachBody(email, { class_ids: [] }),
      ).expect(200);
      expect(res.body).toEqual({
        success: true,
        message: 'Kullanıcı başarıyla oluşturuldu',
      });

      const user = await authUser(email);
      expect(user.email_confirmed_at).not.toBeNull();
      expect(user.raw_user_meta_data).toMatchObject({
        created_by_manager: true,
        created_by: USERS.a.generalManager,
        name: 'Yeni Antrenör',
      });
      expect(await profile(user.id)).toMatchObject({
        full_name: 'Yeni Antrenör',
        role_id: '4',
        school_id: SCHOOL_A,
        status: 'active',
      });
      expect(
        await liveLinks('profile_branch_links', 'branch_id', user.id),
      ).toEqual([BRANCH_A1]);
      await login(email, 'Antrenor123');
      // Personel davet e-postası almaz.
      expect(mail.to(email)).toHaveLength(0);
    });

    it('şube müdürü kendi şubesine antrenör açar', async () => {
      const email = nextEmail('antrenor');
      await fn(
        'create-user',
        await tokenOf(EMAIL.bmA),
        coachBody(email),
      ).expect(200);
      expect(await authUser(email)).toBeDefined();
    });

    it.each([
      [
        'şube müdürü genel müdür açamaz (hiyerarşi)',
        EMAIL.bmA,
        { role_id: 9, branch_ids: [] },
        'Bu rolü atama yetkiniz yok.',
      ],
      [
        'şube müdürü başka şubeye hesap açamaz (şube kapsamı)',
        EMAIL.bmA,
        { branch_ids: [BRANCH_A2] },
        'Seçilen şubelerden birine erişiminiz yok.',
      ],
      [
        'antrenör hesap açamaz (users.manage yok)',
        EMAIL.coachA,
        {},
        'Bu işlemi gerçekleştirmek için yetkiniz yok.',
      ],
      [
        'muhasebeci hesap açamaz',
        EMAIL.accountantA,
        {},
        'Bu işlemi gerçekleştirmek için yetkiniz yok.',
      ],
      [
        'başka okulun genel müdürü bu okulun şubesine açamaz',
        EMAIL.gmB,
        {},
        'Geçersiz veya yetkiniz olmayan bir şube seçildi.',
      ],
      [
        'ad soyad zorunlu (SQL doğrulaması)',
        EMAIL.gmA,
        { full_name: '  ' },
        'Ad soyad zorunludur.',
      ],
      [
        'rolün sunmadığı yetki verilemez',
        EMAIL.gmA,
        { permissions: ['school.manage'] },
        undefined,
      ],
    ])('%s → 400, auth kullanıcısı açılmaz', async (_, caller, extra, msg) => {
      const email = nextEmail('red');
      const res = await fn(
        'create-user',
        await tokenOf(caller),
        coachBody(email, extra),
      ).expect(400);
      expect((res.body as FnBody).success).toBe(false);
      if (msg) expect((res.body as FnBody).error).toBe(msg);
      else expect(typeof (res.body as FnBody).error).toBe('string');
      expect(Object.keys(res.body as FnBody).sort()).toEqual([
        'error',
        'success',
      ]);
      expect(await authUser(email)).toBeUndefined();
    });

    it("sahip olmadığın yetkiyi içeren rol atanamaz (finance'ı olmayan genel müdür → muhasebeci)", async () => {
      await pg.query(
        `update public.profile_permissions set is_deleted = true
          where profile_id = $1 and permission like 'finance.%'`,
        [USERS.a.generalManager],
      );
      try {
        const email = nextEmail('muhasebe');
        const res = await fn(
          'create-user',
          await tokenOf(EMAIL.gmA),
          coachBody(email, { role_id: 5, branch_ids: [BRANCH_A1] }),
        ).expect(400);
        expect((res.body as FnBody).error).toBe(
          'Sizde olmayan yetkileri içeren bir rol atanamaz.',
        );
        expect(await authUser(email)).toBeUndefined();
      } finally {
        await pg.query(
          `update public.profile_permissions set is_deleted = false
            where profile_id = $1 and permission like 'finance.%'`,
          [USERS.a.generalManager],
        );
      }
    });

    it('şifre yoksa doğrulamadan sonra "Parola zorunludur."', async () => {
      const email = nextEmail('sifresiz');
      const res = await fn(
        'create-user',
        await tokenOf(EMAIL.gmA),
        coachBody(email, { password: null }),
      ).expect(400);
      expect(res.body).toEqual({ success: false, error: 'Parola zorunludur.' });
      expect(await authUser(email)).toBeUndefined();
    });

    it('zayıf şifre ve kayıtlı e-posta GoTrue metniyle reddedilir', async () => {
      const token = await tokenOf(EMAIL.gmA);
      const weak = nextEmail('zayif');
      const r1 = await fn(
        'create-user',
        token,
        coachBody(weak, { password: '123' }),
      ).expect(400);
      expect((r1.body as FnBody).success).toBe(false);
      expect(await authUser(weak)).toBeUndefined();

      const r2 = await fn(
        'create-user',
        token,
        coachBody(EMAIL.coach2A),
      ).expect(400);
      expect((r2.body as FnBody).error).toBe(
        'A user with this email address has already been registered',
      );
    });

    it('tip hatası 400 aynı şekilde (gövde doğrulaması)', async () => {
      const res = await fn('create-user', await tokenOf(EMAIL.gmA), {
        branch_ids: 'tek-sube',
      }).expect(400);
      expect((res.body as FnBody).success).toBe(false);
      expect((res.body as FnBody).error).toMatch(/^Geçersiz istek/);
    });

    it('profil yazımı düşerse auth kullanıcısı silinir (yarım hesap kalmaz)', async () => {
      // Yazım adımını düşürmek için auth kullanıcısının `created_by`'ı
      // bozulur: doğrulama geçer, save_staff_profile yazımda "Hesap
      // doğrulanamadı." der (yalnızca çağıranın az önce açtığı hesap).
      const email = nextEmail('yarim');
      await pg.query(
        `create function public.s09_break_created_by() returns trigger
           language plpgsql security definer as $$ begin
             new.raw_user_meta_data := new.raw_user_meta_data
               || '{"created_by":"00000000-0000-0000-0000-000000000000"}';
             return new; end $$`,
      );
      await pg.query(
        `create trigger s09_break before insert on auth.users
           for each row execute function public.s09_break_created_by()`,
      );
      try {
        const res = await fn(
          'create-user',
          await tokenOf(EMAIL.gmA),
          coachBody(email),
        ).expect(400);
        expect(res.body).toEqual({
          success: false,
          error: 'Hesap doğrulanamadı.',
        });
        expect(await authUser(email)).toBeUndefined();
      } finally {
        await pg.query(`drop trigger s09_break on auth.users`);
        await pg.query(`drop function public.s09_break_created_by()`);
      }
    });
  });

  // ── update-user ─────────────────────────────────────────────────────────

  describe('update-user', () => {
    let coachId: string;
    let coachEmail: string;

    beforeAll(async () => {
      coachEmail = nextEmail('duzenle');
      await fn('create-user', await tokenOf(EMAIL.gmA), {
        email: coachEmail,
        password: 'Ilk12345',
        full_name: 'Düzenlenecek Antrenör',
        role_id: 4,
        branch_ids: [BRANCH_A1],
        permissions: [],
      }).expect(200);
      coachId = (await authUser(coachEmail)).id;
    });

    const editBody = (extra: Record<string, unknown> = {}) => ({
      id: coachId,
      school_id: SCHOOL_A,
      email: coachEmail,
      password: null,
      full_name: 'Düzenlenmiş Antrenör',
      phone_number: '5559998877',
      birth_of_date: null,
      branch_ids: [BRANCH_A1],
      role_id: 4,
      permissions: [],
      ...extra,
    });

    it('şube müdürü kendi şubesindeki antrenörü düzenler; yeni şifre ve e-posta', async () => {
      const newEmail = nextEmail('duzenlendi');
      const res = await fn(
        'update-user',
        await tokenOf(EMAIL.bmA),
        editBody({ email: newEmail, password: 'Yeni12345' }),
      ).expect(200);
      expect(res.body).toEqual({
        success: true,
        message: 'Kullanıcı bilgileri başarıyla güncellendi',
      });
      expect(await profile(coachId)).toMatchObject({
        full_name: 'Düzenlenmiş Antrenör',
        email: newEmail,
      });
      await login(newEmail, 'Yeni12345');
      await http()
        .post('/auth/token?grant_type=password')
        .send({ email: newEmail, password: 'Ilk12345' })
        .expect(400);
      coachEmail = newEmail;
    });

    it("şube müdürü genel müdürün şifresini/e-postasını değiştiremez — auth'a hiç dokunulmaz", async () => {
      const res = await fn('update-user', await tokenOf(EMAIL.bmA), {
        id: USERS.a.generalManager,
        email: 'ele.gecirildi@a.test',
        password: 'EleGecir1',
        full_name: 'Selin Deneme',
        role_id: 9,
        branch_ids: [],
        permissions: null,
      }).expect(400);
      expect(res.body).toEqual({
        success: false,
        error: 'Bu kullanıcıyı yönetme yetkiniz yok.',
      });
      // Eski şifre ve e-posta geçerli.
      await login(EMAIL.gmA);
      expect(await authUser('ele.gecirildi@a.test')).toBeUndefined();
    });

    it('şube müdürü başka şubedeki antrenörü düzenleyemez', async () => {
      const res = await fn('update-user', await tokenOf(EMAIL.bmA), {
        id: USERS.a.coach2,
        email: EMAIL.coach2A,
        password: 'Baska1234',
        full_name: 'Pelin Deneme',
        role_id: 4,
        branch_ids: [BRANCH_A2],
      }).expect(400);
      expect((res.body as FnBody).error).toBe(
        'Bu kullanıcı yetkiniz olmayan bir şubede çalışıyor.',
      );
      await login(EMAIL.coach2A);
    });

    it('kendi hesabı: rol ve durum değişmez', async () => {
      const token = await tokenOf(EMAIL.bmA);
      const own = {
        id: USERS.a.branchManager,
        email: EMAIL.bmA,
        full_name: 'Kemal Deneme',
        role_id: 2,
        branch_ids: [BRANCH_A1],
      };
      expect(
        (
          (await fn('update-user', token, { ...own, role_id: 9 }).expect(400))
            .body as FnBody
        ).error,
      ).toBe('Kendi rolünüzü değiştiremezsiniz.');
      expect(
        (
          (
            await fn('update-user', token, {
              ...own,
              status: 'passive',
            }).expect(400)
          ).body as FnBody
        ).error,
      ).toBe('Kendi hesabınızın durumunu değiştiremezsiniz.');
    });

    it('antrenör kimseyi düzenleyemez; şifre değişmez', async () => {
      const res = await fn(
        'update-user',
        await tokenOf(EMAIL.coachA),
        editBody({ password: 'Antrenor999' }),
      ).expect(400);
      expect((res.body as FnBody).error).toBe(
        'Bu işlemi gerçekleştirmek için yetkiniz yok.',
      );
      await login(coachEmail, 'Yeni12345');
    });

    it('id yoksa ve hesap yoksa', async () => {
      const token = await tokenOf(EMAIL.gmA);
      expect(
        (await fn('update-user', token, editBody({ id: null })).expect(400))
          .body,
      ).toEqual({
        success: false,
        error: "Güncellenecek kullanıcının 'id' bilgisi eksik.",
      });
      expect(
        (
          (
            await fn(
              'update-user',
              token,
              editBody({ id: '00000000-0000-4000-8000-00000000dead' }),
            ).expect(400)
          ).body as FnBody
        ).error,
      ).toBe('Kullanıcı bulunamadı veya yetkiniz yok.');
    });

    it('veli hesabı bu uçtan düzenlenmez', async () => {
      const res = await fn('update-user', await tokenOf(EMAIL.gmA), {
        id: USERS.a.parent,
        email: 'veli.yeni@a.test',
        password: 'Veli12345',
        full_name: 'Aylin Deneme',
        role_id: 8,
      }).expect(400);
      expect((res.body as FnBody).error).toBe(
        'Kullanıcı bulunamadı veya yetkiniz yok.',
      );
      await login(EMAIL.parentA);
    });

    it('`permissions` gönderilmezse verilmiş yetkiler kalır', async () => {
      await fn(
        'update-user',
        await tokenOf(EMAIL.gmA),
        editBody({ email: coachEmail, permissions: ['communication.message'] }),
      ).expect(200);
      await fn(
        'update-user',
        await tokenOf(EMAIL.gmA),
        editBody({ email: coachEmail, permissions: undefined }),
      ).expect(200);
      expect(
        await liveLinks('profile_permissions', 'permission', coachId),
      ).toEqual(['communication.message']);
    });
  });

  // ── create-parent ───────────────────────────────────────────────────────

  describe('create-parent', () => {
    const parentBody = (
      email: string,
      extra: Record<string, unknown> = {},
    ) => ({
      school_id: SCHOOL_A,
      email,
      full_name: 'Yeni Veli',
      phone_number: '5553334455',
      birth_of_date: null,
      status: 'active',
      branch_id: BRANCH_A1,
      athlete_ids: [ATHLETES.deniz],
      ...extra,
    });

    it('şube müdürü veli açar: davet (Dev Adım alan adı) + rol 8 profil + şube + sporcu', async () => {
      const email = nextEmail('veli');
      const res = await fn(
        'create-parent',
        await tokenOf(EMAIL.bmA),
        parentBody(email),
      ).expect(200);
      expect(res.body).toEqual({
        success: true,
        message:
          'Veli başarıyla oluşturuldu, şube ve sporcu bağlantıları tanımlandı. Davet e-postası gönderildi.',
      });
      const user = await authUser(email);
      expect(user.invited_at).not.toBeNull();
      expect(user.email_confirmed_at).toBeNull();
      expect(user.raw_user_meta_data).toMatchObject({
        created_by_manager: true,
        name: 'Yeni Veli',
        brand: 'dev_adim',
      });
      expect(await profile(user.id)).toMatchObject({
        role_id: '8',
        school_id: SCHOOL_A,
      });
      expect(
        await liveLinks('profile_branch_links', 'branch_id', user.id),
      ).toEqual([BRANCH_A1]);
      expect(
        await liveLinks('parent_athlete_links', 'athlete_id', user.id),
      ).toEqual([ATHLETES.deniz]);

      const sent = await mail.waitFor(email);
      expect(sent.brand).toBe('dev_adim');
      expect(inviteLinkOf(sent).origin).toBe('https://mobil.devadim.com');
    });

    it('public okulun velisine yonetim.mobilsporokulu.com bağlantısı', async () => {
      const email = nextEmail('veli');
      await fn('create-parent', await tokenOf(EMAIL.gmB), {
        ...parentBody(email),
        school_id: SCHOOL_B,
        branch_id: 'b0000000-0000-4000-8000-0000000000b1',
        athlete_ids: [ATHLETES.mina],
      }).expect(200);
      const sent = await mail.waitFor(email);
      expect(sent.brand).toBe('public');
      expect(inviteLinkOf(sent).origin).toBe(
        'https://yonetim.mobilsporokulu.com',
      );
    });

    it.each([
      [
        'antrenör veli açamaz (registration.manage yok)',
        EMAIL.coachA,
        {},
        'Bu işlemi gerçekleştirmek için yetkiniz yok.',
      ],
      [
        'muhasebeci veli açamaz',
        EMAIL.accountantA,
        {},
        'Bu işlemi gerçekleştirmek için yetkiniz yok.',
      ],
      [
        'gövdedeki okul çağıranın okulu değil',
        EMAIL.bmA,
        { school_id: SCHOOL_B },
        'Bu okul üzerinde işlem yapma yetkiniz yok.',
      ],
      [
        'şube seçilmemiş',
        EMAIL.bmA,
        { branch_id: null },
        'Velinin şubesi seçilmelidir.',
      ],
      [
        'şube müdürü başka şubeye veli açamaz (davetten önce)',
        EMAIL.bmA,
        { branch_id: BRANCH_A2 },
        'Seçilen şubeye erişiminiz yok.',
      ],
      [
        'veli uygulamasının velisi çağıramaz',
        EMAIL.parentA,
        {},
        'Admin profili bulunamadı.',
      ],
    ])(
      '%s → 400, davet gitmez, hesap açılmaz',
      async (_, caller, extra, msg) => {
        const email = nextEmail('red');
        const res = await fn(
          'create-parent',
          await tokenOf(caller),
          parentBody(email, extra),
        ).expect(400);
        expect(res.body).toEqual({ success: false, error: msg });
        await mail.settle();
        expect(mail.to(email)).toHaveLength(0);
        expect(await authUser(email)).toBeUndefined();
      },
    );

    it('başka okulun sporcusu bağlanamaz: geri alınır (auth kullanıcısı ve profil yok)', async () => {
      const email = nextEmail('veli');
      const res = await fn(
        'create-parent',
        await tokenOf(EMAIL.bmA),
        parentBody(email, { athlete_ids: [ATHLETES.mina] }),
      ).expect(400);
      expect((res.body as FnBody).success).toBe(false);
      expect(await authUser(email)).toBeUndefined();
      const { rows } = await pg.query(
        `select 1 from public.profiles where email = $1`,
        [email],
      );
      expect(rows).toHaveLength(0);
    });

    it('kayıtlı (onaylı) adrese davet: GoTrue metni', async () => {
      const res = await fn(
        'create-parent',
        await tokenOf(EMAIL.bmA),
        parentBody(EMAIL.coachA),
      ).expect(400);
      expect((res.body as FnBody).error).toBe(
        'A user with this email address has already been registered',
      );
    });
  });

  // ── update-parent ───────────────────────────────────────────────────────

  describe('update-parent', () => {
    /** Okul A'da, A2 şubesinde bir veli (genel müdür açar). */
    let parentA2: { id: string; email: string };

    beforeAll(async () => {
      const email = nextEmail('veli-a2');
      await fn('create-parent', await tokenOf(EMAIL.gmA), {
        school_id: SCHOOL_A,
        email,
        full_name: 'Sahil Velisi',
        branch_id: BRANCH_A2,
        athlete_ids: [ATHLETES.ada],
      }).expect(200);
      parentA2 = { id: (await authUser(email)).id, email };
    });

    /** Bağı hiç olmayan bir veli (doğrudan SQL; e-posta değişikliğinin başarı yolu için). */
    async function linklessParent(): Promise<{ id: string; email: string }> {
      const email = nextEmail('bagsiz');
      const { rows } = await pg.query<{ id: string }>(
        `insert into auth.users (instance_id, id, aud, role, email, encrypted_password,
           email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at,
           updated_at, is_sso_user, is_anonymous)
         values ('00000000-0000-0000-0000-000000000000', gen_random_uuid(),
           'authenticated', 'authenticated', $1,
           extensions.crypt($2, extensions.gen_salt('bf', 4)), now(),
           '{"provider":"email","providers":["email"]}',
           '{"created_by_manager":true}', now(), now(), false, false)
         returning id`,
        [email, SEED_PASSWORD],
      );
      await pg.query(
        `insert into public.profiles (id, school_id, full_name, email, status, role_id)
         values ($1, $2, 'Bağsız Veli', $3, 'active', 8)`,
        [rows[0].id, SCHOOL_A, email],
      );
      return { id: rows[0].id, email };
    }

    const body = (
      target: { id: string; email: string },
      extra: Record<string, unknown> = {},
    ) => ({
      id: target.id,
      school_id: SCHOOL_A,
      email: target.email,
      full_name: 'Güncel Veli',
      phone_number: '5557776655',
      birth_of_date: null,
      branch_id: BRANCH_A1,
      status: 'active',
      athlete_ids: [ATHLETES.deniz],
      ...extra,
    });

    it('e-posta aynı: profil, şube ve sporcu bağları güncellenir', async () => {
      const res = await fn(
        'update-parent',
        await tokenOf(EMAIL.gmA),
        body(parentA2, { branch_id: BRANCH_A1 }),
      ).expect(200);
      expect(res.body).toEqual({
        success: true,
        message: 'Veli bilgileri ve bağlantıları başarıyla güncellendi.',
      });
      expect(await profile(parentA2.id)).toMatchObject({
        full_name: 'Güncel Veli',
        role_id: '8',
      });
      expect(
        await liveLinks('profile_branch_links', 'branch_id', parentA2.id),
      ).toEqual([BRANCH_A1]);
      expect(
        await liveLinks('parent_athlete_links', 'athlete_id', parentA2.id),
      ).toEqual([ATHLETES.deniz]);
      // Geri: A2'ye.
      await fn(
        'update-parent',
        await tokenOf(EMAIL.gmA),
        body(parentA2, {
          branch_id: BRANCH_A2,
          athlete_ids: [ATHLETES.ada],
          full_name: 'Sahil Velisi',
        }),
      ).expect(200);
    });

    it('şube müdürü başka şubenin velisini düzenleyemez — e-posta değişikliği de, davet de yok', async () => {
      const newEmail = nextEmail('calinan');
      const res = await fn(
        'update-parent',
        await tokenOf(EMAIL.bmA),
        body(parentA2, { email: newEmail }),
      ).expect(400);
      expect(res.body).toEqual({
        success: false,
        error: 'Güncellenecek veli profili bulunamadı veya yetkiniz yok.',
      });
      await mail.settle();
      expect(mail.to(newEmail)).toHaveLength(0);
      expect(await authUser(newEmail)).toBeUndefined();
      expect(await authUser(parentA2.email)).toBeDefined();
    });

    it('hedef personel (genel müdür) olamaz: hesabı silinmez', async () => {
      const newEmail = nextEmail('gm');
      const res = await fn('update-parent', await tokenOf(EMAIL.gmA), {
        ...body({ id: USERS.a.generalManager, email: newEmail }),
      }).expect(400);
      expect((res.body as FnBody).error).toBe(
        'Güncellenecek veli profili bulunamadı veya yetkiniz yok.',
      );
      await login(EMAIL.gmA);
      expect(await authUser(newEmail)).toBeUndefined();
    });

    it('şube müdürü veliyi kendi kapsamı dışındaki şubeye taşıyamaz', async () => {
      const res = await fn(
        'update-parent',
        await tokenOf(EMAIL.bmA),
        body(
          { id: USERS.a.parent, email: EMAIL.parentA },
          { branch_id: BRANCH_A2 },
        ),
      ).expect(400);
      expect((res.body as FnBody).error).toBe('Seçilen şubeye erişiminiz yok.');
    });

    it.each([
      [
        'id yok',
        EMAIL.gmA,
        { id: null },
        "Güncelleme işlemi için veliye ait 'id' parametresi zorunludur.",
      ],
      [
        'antrenör',
        EMAIL.coachA,
        {},
        'Bu işlemi gerçekleştirmek için yetkiniz yok.',
      ],
      [
        'başka okul',
        EMAIL.gmB,
        { school_id: SCHOOL_B },
        'Güncellenecek veli profili bulunamadı veya yetkiniz yok.',
      ],
      [
        'şube yok',
        EMAIL.gmA,
        { branch_id: null },
        'Velinin şubesi seçilmelidir.',
      ],
    ])('%s → 400', async (_, caller, extra, msg) => {
      const res = await fn(
        'update-parent',
        await tokenOf(caller),
        body({ id: USERS.a.parent, email: EMAIL.parentA }, extra),
      ).expect(400);
      expect(res.body).toEqual({ success: false, error: msg });
    });

    it('e-posta değişti (bağsız veli): yeni adrese davet, yeni profil + bağlar, eski auth hesabı silinir', async () => {
      const old = await linklessParent();
      const newEmail = nextEmail('yeni-adres');
      const res = await fn(
        'update-parent',
        await tokenOf(EMAIL.bmA),
        body(old, { email: newEmail }),
      ).expect(200);
      expect(res.body).toEqual({
        success: true,
        message:
          'Veli e-postası değiştiği için eski hesap silindi, yeni hesaba davet gönderildi ve tüm bağlantılar aktarıldı.',
      });
      expect(await authUser(old.email)).toBeUndefined();
      const fresh = await authUser(newEmail);
      expect(fresh.raw_user_meta_data).toMatchObject({ brand: 'dev_adim' });
      expect(await profile(fresh.id)).toMatchObject({ role_id: '8' });
      expect(
        await liveLinks('profile_branch_links', 'branch_id', fresh.id),
      ).toEqual([BRANCH_A1]);
      expect(
        await liveLinks('parent_athlete_links', 'athlete_id', fresh.id),
      ).toEqual([ATHLETES.deniz]);
      expect(inviteLinkOf(await mail.waitFor(newEmail)).origin).toBe(
        'https://mobil.devadim.com',
      );
    });

    it('e-posta değişti (bağlı veli): eski hesap bağ satırları yüzünden silinemez → 400; eski hesap yerinde (canlıdaki davranış)', async () => {
      const newEmail = nextEmail('bagli-yeni');
      const res = await fn(
        'update-parent',
        await tokenOf(EMAIL.gmA),
        body(parentA2, {
          email: newEmail,
          branch_id: BRANCH_A2,
          athlete_ids: [ATHLETES.ada],
        }),
      ).expect(400);
      expect(res.body).toEqual({
        success: false,
        error:
          'Yeni hesap açıldı ancak eski hesap temizlenirken hata oluştu: Database error deleting user',
      });
      // Eski hesap ve bağları duruyor.
      expect(await authUser(parentA2.email)).toBeDefined();
      expect(
        await liveLinks('parent_athlete_links', 'athlete_id', parentA2.id),
      ).toEqual([ATHLETES.ada]);
    });
  });

  // ── delete-account ──────────────────────────────────────────────────────

  describe('delete-account', () => {
    const errBody = (
      message: string,
      code: string,
      reason: string | null = null,
    ) => ({
      success: false,
      code,
      reason,
      message,
      data: null,
      error: message,
    });

    async function throwawayCoach(): Promise<{ id: string; email: string }> {
      const email = nextEmail('silinecek');
      await fn('create-user', await tokenOf(EMAIL.gmA), {
        email,
        password: 'Silinecek1',
        full_name: 'Silinecek Antrenör',
        role_id: 4,
        branch_ids: [BRANCH_A1],
        permissions: [],
      }).expect(200);
      return { id: (await authUser(email)).id, email };
    }

    it('şifre yok → password_required', async () => {
      const token = await tokenOf(EMAIL.coachB);
      expect((await fn('delete-account', token, {}).expect(400)).body).toEqual(
        errBody('Şifrenizi girin.', 'validation', 'password_required'),
      );
      expect(
        (
          (await fn('delete-account', token, { password: 42 }).expect(400))
            .body as FnBody
        ).reason,
      ).toBe('password_required');
    });

    it('yanlış şifre → wrong_password, hesap duruyor', async () => {
      const res = await fn('delete-account', await tokenOf(EMAIL.coachB), {
        password: 'yanlis',
      }).expect(400);
      expect(res.body).toEqual(
        errBody('Şifre hatalı.', 'validation', 'wrong_password'),
      );
      await login(EMAIL.coachB);
    });

    it('okulun son genel müdürü: şifre sorulmadan conflict (self-service değil / self-service metni)', async () => {
      const a = await fn('delete-account', await tokenOf(EMAIL.gmA), {
        password: 'yanlis-bile-olsa',
      }).expect(400);
      expect(a.body).toEqual(
        errBody(
          'Okulun tek genel müdürü sizsiniz. Hesabınızı silmeden önce başka bir kullanıcıyı genel müdür yapın.',
          'conflict',
        ),
      );
      const b = await fn('delete-account', await tokenOf(EMAIL.gmB), {
        password: SEED_PASSWORD,
      }).expect(400);
      expect((b.body as FnBody).code).toBe('conflict');
      expect((b.body as FnBody).message).toContain('Okul Bilgileri');
      await login(EMAIL.gmA);
      await login(EMAIL.gmB);
    });

    it("doğru şifre: silinir; bütün oturumlar ve refresh token'lar düşer, giriş yok, profil mezar taşı", async () => {
      const coach = await throwawayCoach();
      const other = await login(coach.email, 'Silinecek1'); // ikinci cihaz
      const session = await login(coach.email, 'Silinecek1');

      // Gövdedeki başka bir kimlik yok sayılır: silinen yalnızca çağıran.
      const res = await fn('delete-account', session.access_token, {
        password: 'Silinecek1',
        user_id: USERS.a.coach,
        p_user_id: USERS.a.coach,
      }).expect(200);
      expect(res.body).toEqual({
        success: true,
        code: 'ok',
        message: 'Hesabınız silindi.',
        data: null,
      });

      for (const s of [session, other]) {
        const r = await http()
          .post('/auth/token?grant_type=refresh_token')
          .send({ refresh_token: s.refresh_token })
          .expect(400);
        expect((r.body as FnBody).code).toBe('refresh_token_not_found');
      }
      const me = await http()
        .get('/auth/user')
        .set('Authorization', `Bearer ${session.access_token}`)
        .expect(403);
      expect((me.body as FnBody).code).toBe('session_not_found');
      const relogin = await http()
        .post('/auth/token?grant_type=password')
        .send({ email: coach.email, password: 'Silinecek1' })
        .expect(400);
      expect((relogin.body as FnBody).code).toBe('invalid_credentials');

      expect(await profile(coach.id)).toMatchObject({
        full_name: 'Silinmiş kullanıcı',
        email: `silinmis-${coach.id}@silinmis.invalid`,
        status: 'passive',
        is_deleted: true,
      });
      // Gövdede verilen hesap yerinde.
      await login(EMAIL.coachA);

      // Silinmiş hesabın (süresi geçmemiş) token'ı ikinci kez silemez.
      const again = await fn('delete-account', session.access_token, {
        password: 'Silinecek1',
      }).expect(401);
      expect((again.body as FnBody).code).toBe('forbidden');
    });

    it('veli de kendi hesabını siler (veli uygulaması)', async () => {
      const res = await fn('delete-account', await tokenOf(EMAIL.parentB), {
        password: SEED_PASSWORD,
      }).expect(200);
      expect((res.body as FnBody).success).toBe(true);
      expect(await profile(USERS.b.parent)).toMatchObject({ is_deleted: true });
    });

    it('POST dışı yöntem 405', async () => {
      const res = await http()
        .get('/functions/delete-account')
        .set('Authorization', `Bearer ${await tokenOf(EMAIL.coachB)}`)
        .expect(405);
      expect(res.body).toEqual(errBody('Desteklenmeyen istek.', 'validation'));
    });
  });

  // ── hız sınırı ──────────────────────────────────────────────────────────

  describe('delete-account hız sınırı (girişle ortak sayaç)', () => {
    let limited: INestApplication<App>;

    beforeAll(async () => {
      limited = await createTestApp(db, { AUTH_LOGIN_FAILURE_LIMIT: '2' });
    });
    afterAll(async () => {
      await limited?.close();
    });

    it('iki yanlış şifreden sonra doğru şifre de 429 rate_limited; hesap silinmez', async () => {
      const h = () => request(limited.getHttpServer());
      const token = (
        (
          await h()
            .post('/auth/token?grant_type=password')
            .send({ email: EMAIL.assistantA, password: SEED_PASSWORD })
            .expect(200)
        ).body as FnBody
      ).access_token as string;
      const del = (password: string) =>
        h()
          .post('/functions/delete-account')
          .set('Authorization', `Bearer ${token}`)
          .send({ password });
      await del('yanlis1').expect(400);
      await del('yanlis2').expect(400);
      const res = await del(SEED_PASSWORD).expect(429);
      expect(res.body).toEqual({
        success: false,
        code: 'conflict',
        reason: 'rate_limited',
        message:
          'Çok fazla deneme yapıldı. Lütfen birkaç dakika sonra tekrar deneyin.',
        data: null,
        error:
          'Çok fazla deneme yapıldı. Lütfen birkaç dakika sonra tekrar deneyin.',
      });
      expect(await profile(USERS.a.assistant)).toMatchObject({
        is_deleted: false,
      });
    });
  });
});
