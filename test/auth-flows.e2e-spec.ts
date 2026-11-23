import { createHash } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Client } from 'pg';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AuthAdminService } from '../src/auth/admin/auth-admin.service';
import { MailboxNotConfiguredError } from '../src/mail/mail.service';
import { SEED_PASSWORD, USERS } from './fixtures/seed-ids';
import { createTestApp, mailboxOf } from './support/app';
import { startTestDatabase, type TestDatabase } from './support/database';
import { codeOf, type FakeMailbox, inviteLinkOf } from './support/fake-mail';

interface SessionBody {
  access_token: string;
  refresh_token: string;
  user: { id: string; email: string; email_confirmed_at?: string } & Record<
    string,
    unknown
  >;
}

const DEV_ADIM_FROM = 'gonder@devadim.test';
const PUBLIC_FROM = 'noreply@mobilsporokulu.test';

/** Nesnenin anahtar ağacı (değerler değil): sahte ve gerçek yanıt aynı şekilde mi. */
function shape(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(shape);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, shape((value as Record<string, unknown>)[k])]),
    );
  }
  return typeof value;
}

/**
 * Kodlu auth akışları uçtan uca (S06): gerçek Postgres + seed, e-postalar
 * sahte kutuya (FakeMailbox) gider; kodlar ve bağlantılar oradan okunur.
 */
describe('Auth akışları: sıfırlama, kayıt, davet (gerçek Postgres)', () => {
  let db: TestDatabase;
  let app: INestApplication<App>;
  let mail: FakeMailbox;
  let pg: Client;
  let counter = 0;

  const http = () => request(app.getHttpServer());
  const nextEmail = (prefix = 'akis') => `${prefix}${++counter}@akis.test`;

  const recover = (email: string) =>
    http().post('/auth/recover').send({ email });
  const verify = (body: Record<string, unknown>) =>
    http().post('/auth/verify').send(body);
  const login = (email: string, password: string) =>
    http().post('/auth/token?grant_type=password').send({ email, password });

  /** Seed biçiminde onaylı bir hesap (marka metadata'da). */
  async function createUser(
    brand: 'dev_adim' | 'public',
    opts: { bannedUntil?: string } = {},
  ): Promise<{ id: string; email: string }> {
    const email = nextEmail('hesap');
    const { rows } = await pg.query<{ id: string }>(
      `insert into auth.users (instance_id, id, aud, role, email, encrypted_password,
         email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at,
         updated_at, banned_until, is_sso_user, is_anonymous)
       values ('00000000-0000-0000-0000-000000000000', gen_random_uuid(),
         'authenticated', 'authenticated', $1,
         extensions.crypt($2, extensions.gen_salt('bf', 4)), now(),
         '{"provider":"email","providers":["email"]}',
         jsonb_build_object('brand', $3::text, 'name', 'Deneme Kişi'),
         now(), now(), $4::timestamptz, false, false)
       returning id`,
      [email, SEED_PASSWORD, brand, opts.bannedUntil ?? null],
    );
    return { id: rows[0].id, email };
  }

  const userRow = async (email: string) =>
    (
      await pg.query<{
        id: string;
        recovery_token: string | null;
        confirmation_token: string | null;
        email_confirmed_at: Date | null;
        encrypted_password: string | null;
        invited_at: Date | null;
        raw_user_meta_data: Record<string, unknown>;
      }>(
        `select id, recovery_token, confirmation_token, email_confirmed_at,
                encrypted_password, invited_at, raw_user_meta_data
           from auth.users where email = $1`,
        [email],
      )
    ).rows[0];

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

  // ── şifre sıfırlama ────────────────────────────────────────────────────

  describe('kodla şifre sıfırlama', () => {
    it('uçtan uca: kod e-postası → verify → PUT /auth/user → yeni şifreyle giriş', async () => {
      const { email } = await createUser('dev_adim');
      const res = await recover(email).expect(200);
      expect(res.body).toEqual({});

      const sent = await mail.waitFor(email);
      expect(sent.message.subject).toBe(
        'Dev Adım Yönetim — şifre sıfırlama kodu',
      );
      const code = codeOf(sent);

      const session = (
        await verify({ type: 'recovery', email, token: code }).expect(200)
      ).body as SessionBody;
      expect(session.access_token).toBeTruthy();
      expect(session.user.email).toBe(email);

      await http()
        .put('/auth/user')
        .set('Authorization', `Bearer ${session.access_token}`)
        .send({ password: 'yeni-sifre-1' })
        .expect(200);
      await login(email, 'yeni-sifre-1').expect(200);
      await login(email, SEED_PASSWORD).expect(400);
    });

    it('e-posta büyük harf/boşlukla da bulunur; kod DB’de düz metin değil', async () => {
      const { email } = await createUser('public');
      await recover(`  ${email.toUpperCase()} `).expect(200);
      const code = codeOf(await mail.waitFor(email));
      const row = await userRow(email);
      expect(row.recovery_token).toMatch(/^[0-9a-f]{64}$/);
      expect(row.recovery_token).not.toContain(code);
      // GoTrue'nun tuzsuz biçimi de değil (sha224(e-posta + kod)).
      expect(row.recovery_token).not.toBe(
        createHash('sha224')
          .update(email + code)
          .digest('hex'),
      );
      const { rows } = await pg.query(
        `select token_type::text as t, token_hash = $2 as same from auth.one_time_tokens where user_id = $1`,
        [row.id, row.recovery_token],
      );
      expect(rows).toEqual([{ t: 'recovery_token', same: true }]);
    });

    it('bilinmeyen e-posta: aynı 200 {} ve e-posta gitmez (hesap taraması yok)', async () => {
      const email = nextEmail('yok');
      const res = await recover(email).expect(200);
      expect(res.body).toEqual({});
      await mail.settle();
      expect(mail.to(email)).toHaveLength(0);
      // Doğrulama da aynı ret.
      const v = await verify({ type: 'recovery', email, token: '123456' });
      expect(v.status).toBe(403);
      expect(v.body).toEqual({
        code: 'otp_expired',
        message: 'Token has expired or is invalid',
      });
    });

    it('yanlış kod → 403 otp_expired; doğru kod sonra yine geçer', async () => {
      const { email } = await createUser('public');
      await recover(email).expect(200);
      const code = codeOf(await mail.waitFor(email));
      const wrong = code === '000000' ? '111111' : '000000';
      const r = await verify({ type: 'recovery', email, token: wrong });
      expect(r.status).toBe(403);
      expect((r.body as { code: string }).code).toBe('otp_expired');
      await verify({ type: 'recovery', email, token: 'abc' }).expect(403);
      await verify({ type: 'recovery', email, token: code }).expect(200);
    });

    it('kullanılmış kod ikinci kez geçmez', async () => {
      const { email } = await createUser('public');
      await recover(email).expect(200);
      const code = codeOf(await mail.waitFor(email));
      await verify({ type: 'recovery', email, token: code }).expect(200);
      await verify({ type: 'recovery', email, token: code }).expect(403);
    });

    it('süresi dolmuş kod (10 dk) reddedilir ve silinir', async () => {
      const { email } = await createUser('public');
      await recover(email).expect(200);
      const code = codeOf(await mail.waitFor(email));
      await pg.query(
        `update auth.users set recovery_sent_at = now() - interval '601 seconds' where email = $1`,
        [email],
      );
      await verify({ type: 'recovery', email, token: code }).expect(403);
      expect((await userRow(email)).recovery_token).toBe('');
    });

    it('5 yanlış denemeden sonra doğru kod da geçmez (kod silinir)', async () => {
      const { email } = await createUser('public');
      await recover(email).expect(200);
      const code = codeOf(await mail.waitFor(email));
      const wrong = code === '000000' ? '111111' : '000000';
      for (let i = 0; i < 5; i++) {
        await verify({ type: 'recovery', email, token: wrong }).expect(403);
      }
      await verify({ type: 'recovery', email, token: code }).expect(403);
      expect((await userRow(email)).recovery_token).toBe('');
      // Yeni kod istenince sayaç sıfırlanır.
      await recover(email).expect(200);
      const code2 = codeOf(await mail.waitFor(email, 2));
      await verify({ type: 'recovery', email, token: code2 }).expect(200);
    });

    it('yeni kod istenince eskisi geçersiz', async () => {
      const { email } = await createUser('public');
      await recover(email).expect(200);
      const first = codeOf(await mail.waitFor(email));
      await recover(email).expect(200);
      const second = codeOf(await mail.waitFor(email, 2));
      if (first !== second) {
        await verify({ type: 'recovery', email, token: first }).expect(403);
      }
      await verify({ type: 'recovery', email, token: second }).expect(200);
    });

    it('kod başka hesabın sıfırlamasında ya da kayıt doğrulamasında geçmez', async () => {
      const a = await createUser('public');
      const b = await createUser('public');
      await recover(a.email).expect(200);
      await recover(b.email).expect(200);
      const codeA = codeOf(await mail.waitFor(a.email));
      await verify({ type: 'recovery', email: b.email, token: codeA }).expect(
        403,
      );
      await verify({ type: 'signup', email: a.email, token: codeA }).expect(
        403,
      );
      await verify({ type: 'recovery', email: a.email, token: codeA }).expect(
        200,
      );
    });

    it('yasaklı hesaba kod gitmez, var olan kodu da geçmez', async () => {
      const { email, id } = await createUser('public');
      await recover(email).expect(200);
      const code = codeOf(await mail.waitFor(email));
      await pg.query(
        `update auth.users set banned_until = now() + interval '1 day' where id = $1`,
        [id],
      );
      await verify({ type: 'recovery', email, token: code }).expect(403);
      await recover(email).expect(200);
      await mail.settle();
      expect(mail.to(email)).toHaveLength(1);
    });

    it('marka: Dev Adım velisi Dev Adım kutusundan, public velisi kendi kutusundan', async () => {
      await recover('veli@a.test').expect(200);
      await recover('veli@b.test').expect(200);
      const dev = await mail.waitFor('veli@a.test');
      const pub = await mail.waitFor('veli@b.test');

      expect(dev.brand).toBe('dev_adim');
      expect(dev.message.from).toEqual({
        name: 'Dev Adım Yönetim',
        address: DEV_ADIM_FROM,
      });
      expect(dev.message.html).toContain('>Dev Adım Yönetim</span>');
      expect(dev.message.html).toContain('Merhaba Aylin Deneme,');
      expect(dev.message.attachments?.[0]).toMatchObject({
        cid: 'brand-logo',
        contentType: 'image/png',
      });

      expect(pub.brand).toBe('public');
      expect(pub.message.from).toEqual({
        name: 'Mobil Spor Okulu',
        address: PUBLIC_FROM,
      });
      expect(pub.message.subject).toBe(
        'Mobil Spor Okulu — şifre sıfırlama kodu',
      );
      expect(pub.message.html).not.toContain('Dev Adım');
      // Seed kullanıcılarının parolasını bozmamak için doğrulanmadı.
    });

    it('hatalı e-posta biçimi → 400 email_address_invalid', async () => {
      const r = await recover('bu-bir-eposta-degil').expect(400);
      expect((r.body as { code: string }).code).toBe('email_address_invalid');
      await http().post('/auth/recover').send({}).expect(400);
    });
  });

  // ── kayıt ──────────────────────────────────────────────────────────────

  describe('açık kayıt + doğrulama + yeniden gönderme', () => {
    const data = (name: string) => ({
      full_name: name,
      phone_number: '5551112233',
      is_creator: 'true',
      privacy_notice_version: '2026-10-01',
    });

    it('uçtan uca: kayıt → onaysız giriş reddi → kod → oturum, kurucu profili açılır', async () => {
      const email = nextEmail('kayit');
      const res = await http()
        .post('/auth/signup')
        .send({ email, password: 'kayit-sifre1', data: data('Kurucu Bir') })
        .expect(200);
      const user = res.body as {
        id: string;
        email: string;
        email_confirmed_at?: string;
        confirmation_sent_at?: string;
        user_metadata: Record<string, unknown>;
        identities: unknown[];
      };
      expect(user.email).toBe(email);
      expect(user.email_confirmed_at).toBeUndefined();
      expect(user.confirmation_sent_at).toBeDefined();
      expect(user.user_metadata).toMatchObject({
        full_name: 'Kurucu Bir',
        is_creator: 'true',
        sub: user.id,
        email_verified: false,
      });
      expect(user.identities).toHaveLength(1);

      const { rows: prof } = await pg.query(
        'select role_id::int as r, full_name from public.profiles where id = $1',
        [user.id],
      );
      expect(prof).toEqual([{ r: 9, full_name: 'Kurucu Bir' }]);

      const sent = await mail.waitFor(email);
      expect(sent.brand).toBe('public');
      expect(sent.message.from.address).toBe(PUBLIC_FROM);
      expect(sent.message.subject).toBe(
        'Mobil Spor Okulu — e-posta doğrulama kodu',
      );
      expect(sent.message.html).toContain('Merhaba Kurucu Bir,');

      const l = await login(email, 'kayit-sifre1').expect(400);
      expect((l.body as { code: string }).code).toBe('email_not_confirmed');

      const session = (
        await verify({ type: 'signup', email, token: codeOf(sent) }).expect(200)
      ).body as SessionBody;
      expect(session.user.id).toBe(user.id);
      expect(session.user.email_confirmed_at).toBeDefined();
      expect(
        (session.user.user_metadata as Record<string, unknown>).email_verified,
      ).toBe(true);
      await login(email, 'kayit-sifre1').expect(200);
      // Onaylanmış hesabın kodu yeniden geçmez.
      await verify({ type: 'signup', email, token: codeOf(sent) }).expect(403);
    });

    it('resend: yeni kod, eskisi geçersiz; onaylı ya da bilinmeyen adreste de 200 {}', async () => {
      const email = nextEmail('kayit');
      await http()
        .post('/auth/signup')
        .send({ email, password: 'kayit-sifre1', data: data('Kurucu İki') })
        .expect(200);
      const first = codeOf(await mail.waitFor(email));
      const r = await http()
        .post('/auth/resend')
        .send({ type: 'signup', email })
        .expect(200);
      expect(r.body).toEqual({});
      const second = codeOf(await mail.waitFor(email, 2));
      if (first !== second) {
        await verify({ type: 'signup', email, token: first }).expect(403);
      }
      await verify({ type: 'signup', email, token: second }).expect(200);

      // Onaylı hesap ve bilinmeyen adres: aynı yanıt, e-posta yok.
      const unknown = nextEmail('yok');
      for (const target of [email, unknown]) {
        const res = await http()
          .post('/auth/resend')
          .send({ type: 'signup', email: target })
          .expect(200);
        expect(res.body).toEqual({});
      }
      await mail.settle();
      expect(mail.to(email)).toHaveLength(2);
      expect(mail.to(unknown)).toHaveLength(0);
      await http()
        .post('/auth/resend')
        .send({ type: 'recovery', email })
        .expect(400);
    });

    it('var olan onaylı adres: aynı şekilde yanıt, e-posta yok, hesap değişmez', async () => {
      const fresh = nextEmail('kayit');
      const real = (
        await http()
          .post('/auth/signup')
          .send({ email: fresh, password: 'kayit-sifre1', data: data('X') })
          .expect(200)
      ).body as Record<string, unknown>;

      const { email, id } = await createUser('dev_adim');
      const fake = (
        await http()
          .post('/auth/signup')
          .send({ email, password: 'baska-sifre1', data: data('X') })
          .expect(200)
      ).body as { id: string; identities: unknown[] };

      expect(shape(fake)).toEqual(shape(real));
      expect(fake.id).not.toBe(id);
      expect(fake.identities).toHaveLength(1);
      await mail.settle();
      expect(mail.to(email)).toHaveLength(0);
      await login(email, SEED_PASSWORD).expect(200);
      await login(email, 'baska-sifre1').expect(400);
      expect((await userRow(email)).raw_user_meta_data).toMatchObject({
        brand: 'dev_adim',
      });
    });

    it('onaysız adrese yeniden kayıt: son kaydın şifresi geçerli, önceki kod geçersiz', async () => {
      const email = nextEmail('kayit');
      await http()
        .post('/auth/signup')
        .send({ email, password: 'ilk-sifre-1', data: data('Önce') })
        .expect(200);
      const first = codeOf(await mail.waitFor(email));
      await http()
        .post('/auth/signup')
        .send({ email, password: 'son-sifre-1', data: data('Sonra') })
        .expect(200);
      const second = codeOf(await mail.waitFor(email, 2));
      if (first !== second) {
        await verify({ type: 'signup', email, token: first }).expect(403);
      }
      await verify({ type: 'signup', email, token: second }).expect(200);
      await login(email, 'son-sifre-1').expect(200);
      await login(email, 'ilk-sifre-1').expect(400);
    });

    it('sunucunun metadata anahtarları (brand, created_by …) gönderilemez; zayıf şifre 422', async () => {
      for (const key of ['brand', 'created_by', 'created_by_manager']) {
        const r = await http()
          .post('/auth/signup')
          .send({
            email: nextEmail('kayit'),
            password: 'kayit-sifre1',
            data: { ...data('X'), [key]: 'dev_adim' },
          })
          .expect(422);
        expect((r.body as { code: string }).code).toBe('validation_failed');
      }
      const weak = await http()
        .post('/auth/signup')
        .send({ email: nextEmail('kayit'), password: '12345', data: data('X') })
        .expect(422);
      expect((weak.body as { code: string }).code).toBe('weak_password');
    });
  });

  // ── davet ──────────────────────────────────────────────────────────────

  describe('davet (AuthAdminService) ve davet bağlantısıyla şifre belirleme', () => {
    const admin = () => app.get(AuthAdminService);

    it('uçtan uca: Dev Adım daveti → mobil.devadim.com bağlantısı → verify → şifre → giriş', async () => {
      const email = nextEmail('davet');
      const user = await admin().inviteUser(
        email,
        { created_by_manager: true, name: 'Veli Davetli' },
        'dev_adim',
      );
      expect(user.invited_at).toBeDefined();
      expect(user.user_metadata).toMatchObject({
        brand: 'dev_adim',
        name: 'Veli Davetli',
      });

      const sent = mail.to(email)[0];
      expect(sent.brand).toBe('dev_adim');
      expect(sent.message.from).toEqual({
        name: 'Dev Adım Yönetim',
        address: DEV_ADIM_FROM,
      });
      expect(sent.message.subject).toBe('Dev Adım Veli — şifrenizi oluşturun');
      const link = inviteLinkOf(sent);
      expect(link.origin + link.pathname).toBe(
        'https://mobil.devadim.com/sifre-olusturma/',
      );
      expect(link.searchParams.get('type')).toBe('invite');
      const tokenHash = link.searchParams.get('token_hash') as string;
      // DB'de bağlantının token'ı değil, hash'i.
      const row = await userRow(email);
      expect(row.confirmation_token).toBe(
        createHash('sha256').update(tokenHash).digest('hex'),
      );

      // Davetli hesap şifresiz: giriş yok.
      await login(email, 'herhangi1').expect(400);

      const session = (
        await verify({ type: 'invite', token_hash: tokenHash }).expect(200)
      ).body as SessionBody;
      expect(session.user.id).toBe(user.id);
      const bearer = `Bearer ${session.access_token}`;
      await http()
        .put('/auth/user')
        .set('Authorization', bearer)
        .send({ password: 'veli-sifre1' })
        .expect(200);
      await http()
        .post('/auth/logout?scope=local')
        .set('Authorization', bearer)
        .expect(204);
      await login(email, 'veli-sifre1').expect(200);

      // Bağlantı ikinci kez çalışmaz.
      const again = await verify({ type: 'invite', token_hash: tokenHash });
      expect(again.status).toBe(403);
      expect((again.body as { code: string }).code).toBe('otp_expired');
    });

    it('public daveti yonetim.mobilsporokulu.com’a, public kutusundan', async () => {
      const email = nextEmail('davet');
      await admin().inviteUser(email, { name: 'Ali' }, 'public');
      const sent = mail.to(email)[0];
      expect(sent.message.from.address).toBe(PUBLIC_FROM);
      expect(sent.message.subject).toBe(
        'Mobil Spor Okulu Veli — şifrenizi oluşturun',
      );
      expect(inviteLinkOf(sent).origin).toBe(
        'https://yonetim.mobilsporokulu.com',
      );
      expect(sent.message.html).not.toContain('Dev Adım');
    });

    it('süresi dolmuş (24 saat) ve uydurma bağlantı reddedilir', async () => {
      const email = nextEmail('davet');
      await admin().inviteUser(email, {}, 'public');
      const token = inviteLinkOf(mail.to(email)[0]).searchParams.get(
        'token_hash',
      ) as string;
      await pg.query(
        `update auth.users set confirmation_sent_at = now() - interval '25 hours' where email = $1`,
        [email],
      );
      await verify({ type: 'invite', token_hash: token }).expect(403);
      await verify({ type: 'invite', token_hash: 'uydurma' }).expect(403);
      // Hash'in kendisi (DB'den sızmış olsa) bağlantı yerine geçmez.
      await admin().inviteUser(email, {}, 'public');
      const row = await userRow(email);
      await verify({
        type: 'invite',
        token_hash: row.confirmation_token,
      }).expect(403);
    });

    it('yeniden davet: yeni bağlantı, eskisi geçersiz; onaylı adrese davet email_exists', async () => {
      const email = nextEmail('davet');
      const first = await admin().inviteUser(email, {}, 'public');
      const t1 = inviteLinkOf(mail.to(email)[0]).searchParams.get('token_hash');
      const second = await admin().inviteUser(email, {}, 'public');
      expect(second.id).toBe(first.id);
      const t2 = inviteLinkOf(mail.to(email)[1]).searchParams.get('token_hash');
      await verify({ type: 'invite', token_hash: t1 }).expect(403);
      await verify({ type: 'invite', token_hash: t2 }).expect(200);

      await expect(
        admin().inviteUser(email, {}, 'public'),
      ).rejects.toMatchObject({ code: 'email_exists' });
      await expect(
        admin().inviteUser('veli@a.test', {}, 'dev_adim'),
      ).rejects.toMatchObject({ code: 'email_exists' });
    });

    it('Supabase’in gönderdiği eski biçimli davet (56 karakter sha224) geçişte çalışır', async () => {
      const email = nextEmail('davet');
      const user = await admin().inviteUser(email, {}, 'public');
      const legacy = createHash('sha224')
        .update(`${email}123456`)
        .digest('hex');
      await pg.query(
        `update auth.users set confirmation_token = $2 where id = $1`,
        [user.id, legacy],
      );
      await verify({ type: 'invite', token_hash: legacy }).expect(200);
    });

    it('davet kodu kayıt doğrulamasında, kayıt kodu davet yolunda geçmez', async () => {
      const email = nextEmail('davet');
      await admin().inviteUser(email, {}, 'public');
      await verify({ type: 'signup', email, token: '123456' }).expect(403);
      // Davetli (onaysız) adrese kayıt: dokunulmaz, kod gitmez.
      await http()
        .post('/auth/signup')
        .send({ email, password: 'saldirgan1', data: {} })
        .expect(200);
      await mail.settle();
      expect(mail.to(email)).toHaveLength(1);
      expect((await userRow(email)).encrypted_password).toBe('');
    });

    it('SMTP reddederse yeni açılan kullanıcı silinir, hata fırlar', async () => {
      const email = nextEmail('davet');
      mail.failNext();
      await expect(admin().inviteUser(email, {}, 'public')).rejects.toThrow(
        /sahte SMTP/,
      );
      expect(await userRow(email)).toBeUndefined();
    });

    it('admin: createUser, updateUserById, banUser, deleteUser', async () => {
      const email = nextEmail('admin');
      const user = await admin().createUser({
        email,
        password: 'personel-1',
        emailConfirm: true,
        userMetadata: { created_by: USERS.a.generalManager, name: 'P' },
      });
      await login(email, 'personel-1').expect(200);
      await expect(
        admin().createUser({
          email,
          password: 'personel-1',
          emailConfirm: true,
          userMetadata: {},
        }),
      ).rejects.toMatchObject({ code: 'email_exists' });

      const newEmail = nextEmail('admin');
      await admin().updateUserById(user.id, {
        email: newEmail,
        password: 'personel-2',
      });
      await login(newEmail, 'personel-2').expect(200);
      await expect(
        admin().updateUserById(user.id, { email: 'veli@a.test' }),
      ).rejects.toMatchObject({ code: 'email_exists' });

      await admin().banUser(user.id, new Date(Date.now() + 3600_000));
      await login(newEmail, 'personel-2').expect(400);
      await admin().banUser(user.id, null);
      await login(newEmail, 'personel-2').expect(200);

      await admin().deleteUser(user.id);
      await login(newEmail, 'personel-2').expect(400);
      await expect(admin().deleteUser(user.id)).rejects.toMatchObject({
        code: 'user_not_found',
      });
    });
  });

  // ── hız sınırları ve eksik posta kutusu ────────────────────────────────

  describe('hız sınırları ve posta kutusu (ayrı uygulama)', () => {
    let limited: INestApplication<App>;
    let limitedMail: FakeMailbox;
    const lhttp = () => request(limited.getHttpServer());

    beforeAll(async () => {
      limited = await createTestApp(db, {
        AUTH_EMAIL_SEND_INTERVAL_SEC: '60',
        AUTH_EMAIL_HOURLY_LIMIT: '5',
        AUTH_EMAIL_IP_HOURLY_LIMIT: '8',
        AUTH_VERIFY_IP_LIMIT: '3',
        // public markanın kutusu yok.
        SMTP_USER_PUBLIC: '',
      });
      limitedMail = mailboxOf(limited);
    });

    afterAll(async () => {
      await limited?.close();
    });

    it('aynı adrese 60 sn içinde ikinci istek 429 — bilinen ve bilinmeyen adreste aynı', async () => {
      const known = await createUser('dev_adim');
      const unknown = nextEmail('yok');
      for (const email of [known.email, unknown]) {
        await lhttp().post('/auth/recover').send({ email }).expect(200);
        const r = await lhttp().post('/auth/recover').send({ email });
        expect(r.status).toBe(429);
        expect(r.body).toEqual({
          code: 'over_email_send_rate_limit',
          message: 'Email rate limit exceeded',
        });
        expect(Number(r.headers['retry-after'])).toBeGreaterThan(0);
      }
      expect(limitedMail.to(known.email)).toHaveLength(1);
    });

    it('IP başına saatlik gönderim sınırı (farklı adreslerle tarama)', async () => {
      const statuses: number[] = [];
      for (let i = 0; i < 10; i++) {
        statuses.push(
          (
            await lhttp()
              .post('/auth/recover')
              .send({ email: nextEmail('ip') })
          ).status,
        );
      }
      // Önceki testin 2 kabulü + bunlar: toplam 8'den sonrası 429.
      expect(statuses.filter((s) => s === 200)).toHaveLength(6);
      expect(statuses.slice(6)).toEqual([429, 429, 429, 429]);
    });

    it('doğrulama: IP başına 5 dk’da 3 deneme, sonra 429', async () => {
      const email = nextEmail('yok');
      for (let i = 0; i < 3; i++) {
        await lhttp()
          .post('/auth/verify')
          .send({ type: 'recovery', email, token: '123456' })
          .expect(403);
      }
      const r = await lhttp()
        .post('/auth/verify')
        .send({ type: 'recovery', email, token: '123456' });
      expect(r.status).toBe(429);
      expect((r.body as { code: string }).code).toBe('over_request_rate_limit');
    });

    it('kutusu olmayan marka: davet hiçbir şey yazmadan hata; başka markanın kutusuna düşmez', async () => {
      const email = nextEmail('davet');
      await expect(
        limited.get(AuthAdminService).inviteUser(email, {}, 'public'),
      ).rejects.toBeInstanceOf(MailboxNotConfiguredError);
      expect(await userRow(email)).toBeUndefined();
      expect(limitedMail.to(email)).toHaveLength(0);
    });
  });
});
