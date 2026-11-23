import type { INestApplication } from '@nestjs/common';
import { Client, DatabaseError, type Pool } from 'pg';
import type { App } from 'supertest/types';
import { DbContextService } from '../src/db/db-context.service';
import { DB_POOL } from '../src/db/db.tokens';
import { buildCallSql } from '../src/rpc/rpc-call';
import type { RpcSignature } from '../src/rpc/rpc-catalog.service';
import { USERS } from './fixtures/seed-ids';
import { createTestApp } from './support/app';
import { startTestDatabase, type TestDatabase } from './support/database';

/**
 * DbContextService: her çağrı kendi rolünde ve kimliğinde, tek
 * transaction'da; bağlantı havuza temiz döner.
 */
describe('DbContextService (gerçek Postgres)', () => {
  let db: TestDatabase;
  let app: INestApplication<App>;
  let ctx: DbContextService;
  let pool: Pool;

  beforeAll(async () => {
    db = await startTestDatabase({ seed: true });
    // set-returning / void / composite yolları için allow-list dışı yardımcılar.
    const admin = new Client({ connectionString: db.url });
    await admin.connect();
    await admin.query(`
      create function public.s04_setof(p_n int) returns setof int
        language sql as 'select generate_series(1, p_n)';
      create function public.s04_empty() returns setof int
        language sql as 'select 1 where false';
      create function public.s04_void(p_x text default null) returns void
        language sql as 'select null';
      create function public.s04_row(p_a int, p_b text default 'b',
                                     out a int, out b text)
        language sql as 'select p_a, p_b';
      grant execute on function public.s04_setof(int), public.s04_empty(),
        public.s04_void(text), public.s04_row(int, text) to service_role;
    `);
    await admin.end();
    app = await createTestApp(db);
    ctx = app.get(DbContextService);
    pool = app.get<Pool>(DB_POOL);
  });

  afterAll(async () => {
    await app?.close();
    await db?.stop();
  });

  const whoAmI = (c: { query: Pool['query'] }) =>
    c
      .query<{ usr: string; uid: string | null; role: string | null }>(
        'select current_user as usr, auth.uid()::text as uid, auth.role() as role',
      )
      .then((r) => r.rows[0]);

  it('API api_authenticator olarak bağlanır ve kendi başına tablo okuyamaz', async () => {
    const { rows } = await pool.query<{ u: string }>(
      'select current_user as u',
    );
    expect(rows[0].u).toBe('api_authenticator');
    await expect(pool.query('select 1 from public.athletes')).rejects.toThrow(
      /permission denied/,
    );
  });

  it('withUser: authenticated rolü, auth.uid() ve auth.jwt() token’ın yükü', async () => {
    const claims = {
      sub: USERS.a.parent,
      role: 'authenticated',
      email: 'veli@a.test',
      user_metadata: { brand: 'dev_adim' },
    };
    const result = await ctx.withUser(claims, async (c) => ({
      ...(await whoAmI(c)),
      jwt: (await c.query<{ j: unknown }>('select auth.jwt() as j')).rows[0].j,
      email: (await c.query<{ e: string }>('select auth.email() as e')).rows[0]
        .e,
    }));
    expect(result).toEqual({
      usr: 'authenticated',
      uid: USERS.a.parent,
      role: 'authenticated',
      jwt: claims,
      email: 'veli@a.test',
    });
  });

  it('withRole(anon): auth.uid() null, rol anon', async () => {
    expect(await ctx.withRole('anon', whoAmI)).toEqual({
      usr: 'anon',
      uid: null,
      role: 'anon',
    });
  });

  it('RLS işler: veli okulun tablolarını doğrudan okuyamaz, müdür okur', async () => {
    const count = (sub: string) =>
      ctx.withUser({ sub, role: 'authenticated' }, async (c) => {
        const { rows } = await c.query<{ n: number }>(
          'select count(*)::int as n from public.athletes',
        );
        return rows[0].n;
      });
    expect(await count(USERS.a.parent)).toBe(0);
    expect(await count(USERS.a.generalManager)).toBeGreaterThan(0);
  });

  it('bağlantı havuza temiz döner: rol, kimlik ve süre sınırı sızmaz', async () => {
    // Havuzu tek bağlantıya indirmeden: aynı anda bütün bağlantıları kullan.
    await Promise.all(
      Array.from({ length: 10 }, () =>
        ctx.run(
          {
            role: 'authenticated',
            claims: { sub: USERS.a.parent, role: 'authenticated' },
            statementTimeoutMs: 1234,
          },
          async (c) => c.query('select 1'),
        ),
      ),
    );
    const clients = await Promise.all(
      Array.from({ length: 10 }, () => pool.connect()),
    );
    try {
      for (const c of clients) {
        const { rows } = await c.query<{
          usr: string;
          claims: string | null;
          sub: string | null;
          timeout: string;
        }>(
          `select current_user as usr,
                  nullif(current_setting('request.jwt.claims', true), '') as claims,
                  nullif(current_setting('request.jwt.claim.sub', true), '') as sub,
                  current_setting('statement_timeout') as timeout`,
        );
        expect(rows[0]).toEqual({
          usr: 'api_authenticator',
          claims: null,
          sub: null,
          timeout: '0',
        });
      }
    } finally {
      clients.forEach((c) => c.release());
    }
  });

  it('iş hata verirse transaction geri alınır', async () => {
    const token = 'rollback-test-token-'.padEnd(64, 'x');
    await expect(
      ctx.withUser(
        { sub: USERS.a.parent, role: 'authenticated' },
        async (c) => {
          await c.query(
            "select public.register_push_token($1, 'parent', 'android')",
            [token],
          );
          throw new Error('iş yarıda kaldı');
        },
      ),
    ).rejects.toThrow('iş yarıda kaldı');

    const admin = new Client({ connectionString: db.url });
    await admin.connect();
    try {
      const { rows } = await admin.query(
        'select 1 from public.push_tokens where token = $1',
        [token],
      );
      expect(rows).toHaveLength(0);
    } finally {
      await admin.end();
    }
  });

  it('statement_timeout uygulanır (57014)', async () => {
    const error = await ctx
      .run({ role: 'service_role', statementTimeoutMs: 100 }, (c) =>
        c.query('select pg_sleep(1)'),
      )
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DatabaseError);
    expect((error as DatabaseError).code).toBe('57014');
  });

  it('bilinmeyen rol reddedilir (SQL’e metin girmez)', async () => {
    await expect(
      ctx.run({ role: 'postgres' as never }, (c) => c.query('select 1')),
    ).rejects.toThrow(/Bilinmeyen veritabanı rolü/);
  });

  describe('çağrı SQL’i: setof / void / out parametreleri', () => {
    const sig = (
      s: Partial<RpcSignature> & { name: string },
    ): RpcSignature => ({
      params: [],
      returnsSet: false,
      returnsVoid: false,
      ...s,
    });
    const call = (signature: RpcSignature, args: Record<string, unknown>) =>
      ctx.withRole('service_role', async (c) => {
        const keys = Object.keys(args);
        const { rows } = await c.query<{ result: unknown }>(
          buildCallSql(signature, keys),
          keys.length ? [JSON.stringify(args)] : [],
        );
        return rows[0]?.result;
      });

    it('setof → dizi, boşsa []', async () => {
      const setof = sig({
        name: 's04_setof',
        returnsSet: true,
        params: [{ name: 'p_n', type: 'integer', hasDefault: false }],
      });
      expect(await call(setof, { p_n: 3 })).toEqual([1, 2, 3]);
      expect(
        await call(sig({ name: 's04_empty', returnsSet: true }), {}),
      ).toEqual([]);
    });

    it('void → null (parametreli ve parametresiz)', async () => {
      const v = sig({
        name: 's04_void',
        returnsVoid: true,
        params: [{ name: 'p_x', type: 'text', hasDefault: true }],
      });
      expect(await call(v, {})).toBeNull();
      expect(await call(v, { p_x: 'a' })).toBeNull();
    });

    it('out parametreli tek satır → nesne; varsayılan kullanılır', async () => {
      const row = sig({
        name: 's04_row',
        params: [
          { name: 'p_a', type: 'integer', hasDefault: false },
          { name: 'p_b', type: 'text', hasDefault: true },
        ],
      });
      expect(await call(row, { p_a: 7 })).toEqual({ a: 7, b: 'b' });
    });
  });
});
