import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client, type Notification } from 'pg';
import { ATHLETES, SCHOOL_A, USERS } from './fixtures/seed-ids';
import { startTestDatabase, type TestDatabase } from './support/database';

/**
 * S03 — boş veritabanına `dbmate up` ile kurulan şema canlı Supabase'tekiyle
 * aynı mı?
 *
 * Beklenen değerler canlıdan SALT OKUNUR alındı (2026-11-23, Supabase MCP
 * `execute_sql`, Postgres 17.6; 20261027_app_min_versions canlıda):
 *   - sayılar: pg_class / pg_proc / pg_policies / pg_trigger / pg_indexes /
 *     pg_constraint / pg_type (public), pg_policies (storage), cron.job,
 *     storage.buckets — sorgular aşağıdaki `count` ifadeleriyle aynı;
 *   - parmak izleri: scripts/schema-fingerprint.sql canlıda çalıştırıldı.
 * dbmate'in schema_migrations tablosu hiçbir sayıya girmez.
 *
 * Yönetim reposundan canlıya henüz uygulanmamış bir migration taşındığında
 * (AGENTS.md → "Schema sync") nesneleri `NOT_YET_LIVE`'a eklenir; canlıya
 * uygulanınca değerler canlıdan yeniden alınır ve `NOT_YET_LIVE` sıfırlanır.
 */
const LIVE = {
  tables: 34,
  functions: 167,
  policies: 73,
  triggers: 28,
  indexes: 93,
  constraints: 152,
  enums: 18,
  storagePolicies: 8,
  cronJobs: 9,
  buckets: 2,
} as const;

const NOT_YET_LIVE: Partial<Record<keyof typeof LIVE, number>> = {};

/** scripts/schema-fingerprint.sql'in canlıdaki sonucu (2026-11-23). */
const LIVE_FINGERPRINT: Record<string, string> = {
  cols: '31fbd54f69f58118ac7fe60736dd3456',
  con: '55812830fd429742ecd1ef1336a519f8',
  cron: 'af4b1bd8f12d1abbc0f8af65b184c7ea',
  fn: 'f37698fa72d1df177de671acd550465d',
  idx: '6ce934c874e41e88cd16ce566ad7b833',
  pol: 'ade9207d99f4929fec22d341a782333b',
  spol: '9008b210f0980c9209dc3409564eb9b3',
  tblacl: '6ba99a62f28fbdcfa5f48b6fd3639de0',
  trg: 'dfc48be47646f1eeaab9ce55a2117c91',
};

describe('Veritabanı tabanı (S03, gerçek Postgres)', () => {
  let db: TestDatabase;
  let client: Client;

  beforeAll(async () => {
    db = await startTestDatabase({ seed: true });
    client = new Client({ connectionString: db.url });
    await client.connect();
  });

  afterAll(async () => {
    await client?.end();
    await db?.stop();
  });

  /** Tek değer döndüren sorgu. */
  async function scalar<T>(sql: string): Promise<T> {
    const { rows } = await client.query<{ v: T }>(sql);
    return rows[0].v;
  }

  /**
   * API'nin her istekte yapacağının aynısı (K5): transaction, `set local
   * role`, `request.jwt.claims`. Sonunda geri alınır.
   */
  async function asRole<T>(
    role: 'anon' | 'authenticated' | 'service_role',
    claims: Record<string, unknown>,
    sql: string,
  ): Promise<T> {
    await client.query('begin');
    try {
      await client.query(`set local role ${role}`);
      await client.query("select set_config('request.jwt.claims', $1, true)", [
        JSON.stringify(claims),
      ]);
      const { rows } = await client.query<{ v: T }>(sql);
      return rows[0].v;
    } finally {
      await client.query('rollback');
    }
  }

  const asUser = <T>(id: string, sql: string) =>
    asRole<T>('authenticated', { sub: id, role: 'authenticated' }, sql);

  describe('canlıyla karşılaştırma', () => {
    it.each([
      [
        'tables',
        "select count(*)::int as v from pg_class where relnamespace = 'public'::regnamespace and relkind in ('r','p') and relname <> 'schema_migrations'",
      ],
      [
        'functions',
        "select count(*)::int as v from pg_proc where pronamespace = 'public'::regnamespace",
      ],
      [
        'policies',
        "select count(*)::int as v from pg_policies where schemaname = 'public'",
      ],
      [
        'triggers',
        "select count(*)::int as v from pg_trigger t join pg_class c on c.oid = t.tgrelid where c.relnamespace = 'public'::regnamespace and not t.tgisinternal",
      ],
      [
        'indexes',
        "select count(*)::int as v from pg_indexes where schemaname = 'public' and tablename <> 'schema_migrations'",
      ],
      [
        'constraints',
        "select count(*)::int as v from pg_constraint where connamespace = 'public'::regnamespace and conrelid::regclass::text <> 'schema_migrations'",
      ],
      [
        'enums',
        "select count(*)::int as v from pg_type where typnamespace = 'public'::regnamespace and typtype = 'e'",
      ],
      [
        'storagePolicies',
        "select count(*)::int as v from pg_policies where schemaname = 'storage'",
      ],
      ['cronJobs', 'select count(*)::int as v from cron.job where active'],
      ['buckets', 'select count(*)::int as v from storage.buckets'],
    ] as const)('%s sayısı canlıyla aynı', async (key, sql) => {
      const extra = NOT_YET_LIVE[key] ?? 0;
      expect(await scalar<number>(sql)).toBe(LIVE[key] + extra);
    });

    it('parmak izleri (fonksiyon gövdeleri + yetkileri, politikalar, trigger, sütun, index, kısıt, storage, cron) canlıyla aynı', async () => {
      const sql = readFileSync(
        join(__dirname, '..', 'scripts', 'schema-fingerprint.sql'),
        'utf8',
      );
      const { rows } = await client.query<{ k: string; md5: string }>(sql);
      expect(Object.fromEntries(rows.map((r) => [r.k, r.md5]))).toEqual(
        LIVE_FINGERPRINT,
      );
    });

    it('sıralama canlıdaki gibi ICU en-US, saat dilimi UTC', async () => {
      const { rows } = await client.query<{
        provider: string;
        locale: string;
        tz: string;
      }>(
        "select datlocprovider as provider, datlocale as locale, current_setting('TimeZone') as tz from pg_database where datname = current_database()",
      );
      expect(rows[0]).toEqual({ provider: 'i', locale: 'en-US', tz: 'UTC' });
    });

    it('bucket ayarları canlıdaki gibi', async () => {
      const { rows } = await client.query(
        'select id, public, file_size_limit::int as limit, allowed_mime_types as mimes from storage.buckets order by id',
      );
      expect(rows).toEqual([
        {
          id: 'athlete-photos',
          public: false,
          limit: 1048576,
          mimes: ['image/jpeg'],
        },
        {
          id: 'school-logos',
          public: true,
          limit: 2097152,
          mimes: ['image/png'],
        },
      ]);
    });

    it('rol yetki matrisi yüklü (8 rol, 38 satır)', async () => {
      expect(
        await scalar<number>('select count(*)::int as v from public.roles'),
      ).toBe(8);
      expect(
        await scalar<number>(
          'select count(*)::int as v from public.role_permissions',
        ),
      ).toBe(38);
    });
  });

  describe('uyumluluk katmanı', () => {
    it("auth.uid() claim verilince o uuid'yi döner", async () => {
      const id = USERS.a.coach;
      expect(await asUser<string>(id, 'select auth.uid() as v')).toBe(id);
      expect(await asUser<string>(id, "select auth.jwt() ->> 'sub' as v")).toBe(
        id,
      );
      expect(await asUser<string>(id, 'select auth.role() as v')).toBe(
        'authenticated',
      );
    });

    it('anon isteğinde auth.uid() null', async () => {
      expect(
        await asRole<string | null>(
          'anon',
          { role: 'anon' },
          'select auth.uid() as v',
        ),
      ).toBeNull();
    });

    it('api_authenticator yalnızca üç istek rolüne ve auth_service’e geçebilir, kendisi yetkisiz', async () => {
      const { rows } = await client.query<{ rolname: string }>(
        "select r.rolname from pg_auth_members m join pg_roles r on r.oid = m.roleid join pg_roles u on u.oid = m.member where u.rolname = 'api_authenticator' order by 1",
      );
      expect(rows.map((r) => r.rolname)).toEqual([
        'anon',
        'auth_service',
        'authenticated',
        'service_role',
      ]);
      const { rows: flags } = await client.query(
        "select rolcanlogin, rolinherit, rolsuper, rolbypassrls from pg_roles where rolname = 'api_authenticator'",
      );
      expect(flags[0]).toEqual({
        rolcanlogin: true,
        rolinherit: false,
        rolsuper: false,
        rolbypassrls: false,
      });
    });

    it('auth_service: yalnızca auth tabloları (0005 + 0006), public’e erişimi yok, bypassrls değil', async () => {
      const { rows } = await client.query<{ t: string; p: string }>(
        `select table_schema || '.' || table_name as t,
                string_agg(privilege_type, ',' order by privilege_type) as p
           from information_schema.role_table_grants
          where grantee = 'auth_service' group by 1 order by 1`,
      );
      expect(rows).toEqual([
        { t: 'auth.identities', p: 'INSERT,SELECT,UPDATE' },
        { t: 'auth.one_time_tokens', p: 'DELETE,INSERT,SELECT,UPDATE' },
        { t: 'auth.otp_attempts', p: 'DELETE,INSERT,SELECT,UPDATE' },
        { t: 'auth.refresh_tokens', p: 'DELETE,INSERT,SELECT,UPDATE' },
        { t: 'auth.sessions', p: 'DELETE,INSERT,SELECT,UPDATE' },
        // S06 (0006): kayıt/davet satır açar, admin deleteUser siler.
        { t: 'auth.users', p: 'DELETE,INSERT,SELECT' },
      ]);
      const { rows: cols } = await client.query<{ c: string }>(
        `select column_name as c from information_schema.column_privileges
          where grantee = 'auth_service' and table_name = 'users'
            and privilege_type = 'UPDATE' order by 1`,
      );
      expect(cols.map((r) => r.c)).toEqual([
        'banned_until',
        'confirmation_sent_at',
        'confirmation_token',
        'email',
        'email_confirmed_at',
        'encrypted_password',
        'invited_at',
        'last_sign_in_at',
        'raw_user_meta_data',
        'recovery_sent_at',
        'recovery_token',
        'updated_at',
      ]);
      const { rows: flags } = await client.query(
        "select rolcanlogin, rolbypassrls from pg_roles where rolname = 'auth_service'",
      );
      expect(flags[0]).toEqual({ rolcanlogin: false, rolbypassrls: false });
    });

    it('request_push_dispatch() pg_notify ile push_dispatch kanalına dürter', async () => {
      const listener = new Client({ connectionString: db.url });
      await listener.connect();
      try {
        await listener.query('listen push_dispatch');
        const received = new Promise<Notification>((resolve) =>
          listener.once('notification', resolve),
        );
        await client.query('select public.request_push_dispatch()');
        const note = await received;
        expect(note.channel).toBe('push_dispatch');
      } finally {
        await listener.end();
      }
    });

    it("auth.users trigger'ı: kurucu kaydı profil açar", async () => {
      await client.query('begin');
      try {
        await client.query(
          `insert into auth.users (id, email, raw_user_meta_data)
           values ('c0000000-0000-4000-8000-000000000001', 'kurucu@c.test',
                   '{"is_creator": "true", "full_name": "Kurucu Deneme"}')`,
        );
        const { rows } = await client.query(
          "select role_id::int, full_name from public.profiles where id = 'c0000000-0000-4000-8000-000000000001'",
        );
        expect(rows).toEqual([{ role_id: 9, full_name: 'Kurucu Deneme' }]);
      } finally {
        await client.query('rollback');
      }
    });
  });

  describe('RLS ve iş kuralları seed verisiyle', () => {
    it('veli yalnızca kendi çocuğunu görür, tabloyu doğrudan okuyamaz', async () => {
      expect(
        await asUser<string[]>(
          USERS.a.parent,
          "select jsonb_path_query_array(public.parent_get_athletes() -> 'data', '$[*].id') as v",
        ),
      ).toEqual([ATHLETES.deniz]);
      expect(
        await asUser<number>(
          USERS.a.parent,
          'select count(*)::int as v from public.athletes',
        ),
      ).toBe(0);
    });

    it("pasif hesap: oturum verisi pasif ve yetkisiz, veli RPC'si reddeder", async () => {
      const session = await asUser<{
        data: { status: string; permissions: string[] };
      }>(USERS.a.passiveParent, 'select public.get_session_data() as v');
      expect(session.data.status).toBe('passive');
      expect(session.data.permissions).toEqual([]);
      expect(
        await asUser<string>(
          USERS.a.passiveParent,
          "select public.parent_get_athletes() ->> 'code' as v",
        ),
      ).toBe('forbidden');
    });

    it('antrenör yalnızca kendi şubesinin sporcularını görür', async () => {
      expect(
        await asUser<number>(
          USERS.a.coach,
          'select count(*)::int as v from public.athletes',
        ),
      ).toBe(2);
      expect(
        await asUser<number>(
          USERS.a.generalManager,
          'select count(*)::int as v from public.athletes',
        ),
      ).toBe(3);
    });

    it("okul markası oturum verisinde ve auth.users metadata'sında", async () => {
      expect(
        await asUser<string>(
          USERS.a.coach,
          "select public.get_session_data() -> 'data' -> 'school' ->> 'brand' as v",
        ),
      ).toBe('dev_adim');
      expect(
        await scalar<string>(
          `select raw_user_meta_data ->> 'brand' as v from auth.users where id = '${USERS.b.parent}'`,
        ),
      ).toBe('public');
    });

    it('anon: zorunlu güncelleme kapısını okur, okul verisini okuyamaz', async () => {
      expect(
        await asRole<{ min_build: number }>(
          'anon',
          { role: 'anon' },
          "select public.get_min_app_version('management', 'ios', 'public') -> 'data' as v",
        ),
      ).toEqual({ min_build: 0, store_url: null });
      expect(
        await asRole<number>(
          'anon',
          { role: 'anon' },
          'select count(*)::int as v from public.schools',
        ),
      ).toBe(0);
    });

    it('okul A finans kayıtları muhasebeciye açık, antrenöre kapalı', async () => {
      const sql = `select count(*)::int as v from public.financial_records where school_id = '${SCHOOL_A}'`;
      expect(await asUser<number>(USERS.a.accountant, sql)).toBe(3);
      expect(await asUser<number>(USERS.a.coach, sql)).toBe(0);
    });
  });
});
