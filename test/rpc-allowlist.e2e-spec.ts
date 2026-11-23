import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';
import { RPC_ALLOWLIST, type RpcApp } from '../src/rpc/rpc-allowlist';
import { startTestDatabase, type TestDatabase } from './support/database';

const ROOT = join(__dirname, '..', '..');
const APPS: Record<RpcApp, string> = {
  Y: join(ROOT, 'mobil_spor_okulu', 'lib'),
  V: join(ROOT, 'mobil_spor_okulu_veli', 'lib'),
};

function dartFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return dartFiles(path);
    return name.endsWith('.dart') ? [path] : [];
  });
}

function endpointConstants(lib: string): Map<string, string> {
  const endpoint = readFileSync(
    join(lib, 'core', 'data', 'remote', 'endpoint.dart'),
    'utf8',
  );
  const constants = new Map<string, string>();
  for (const m of endpoint.matchAll(
    /const String (\w+)\s*=\s*['"]([a-z0-9_]+)['"]/g,
  )) {
    constants.set(m[1], m[2]);
  }
  return constants;
}

/**
 * Bir uygulamanın gerçekten çağırdığı RPC adları: `.rpc(` çağrısının ilk
 * argümanı olan sabitler, `endpoint.dart`'taki değerleriyle.
 */
function rpcNamesOf(lib: string): string[] {
  const constants = endpointConstants(lib);
  const names = new Set<string>();
  for (const file of dartFiles(lib)) {
    const source = readFileSync(file, 'utf8');
    for (const m of source.matchAll(/\.rpc\(\s*(\w+|'[^']+'|"[^"]+")/g)) {
      const arg = m[1];
      const literal = /^['"](.*)['"]$/.exec(arg);
      const name = literal ? literal[1] : constants.get(arg);
      if (!name) throw new Error(`${file}: .rpc(${arg}) çözülemedi`);
      names.add(name);
    }
  }
  return [...names].sort();
}

/**
 * Uygulamanın PostgREST'ten doğrudan okuduğu tablolar: `.from(<x>Table)`
 * (storage'ın `.from(<x>Bucket)`'ı ve Dart'ın `Map.from(...)`'ı sayılmaz).
 */
function fromTablesOf(lib: string): string[] {
  const constants = endpointConstants(lib);
  const tables = new Set<string>();
  for (const file of dartFiles(lib)) {
    // Yorum satırlarındaki örnekler (paged_query.dart) sayılmaz.
    const source = readFileSync(file, 'utf8')
      .split('\n')
      .map((line) => line.replace(/\/\/.*$/, ''))
      .join('\n');
    for (const m of source.matchAll(/\.from\(\s*(\w+Table)\s*\)/g)) {
      const table = constants.get(m[1]);
      if (!table) throw new Error(`${file}: .from(${m[1]}) çözülemedi`);
      tables.add(table);
    }
  }
  return [...tables].sort();
}

const entriesFor = (app: RpcApp) =>
  Object.entries(RPC_ALLOWLIST).filter(([, entry]) => entry.apps.includes(app));

describe('RPC allow-list', () => {
  describe.each(Object.keys(APPS) as RpcApp[])(
    "uygulamanın endpoint.dart'ıyla aynı (%s)",
    (app) => {
      const lib = APPS[app];
      const present = existsSync(lib);
      // Kardeş repo yoksa (ör. CI) atlanır; geliştirici makinesinde koşar.
      const run = present ? it : it.skip;

      run(
        'uygulamanın çağırdığı her RPC listede, listedeki her RPC çağrılıyor',
        () => {
          const called = rpcNamesOf(lib);
          const rpcs = entriesFor(app)
            .filter(([, entry]) => !entry.reads)
            .map(([name]) => name)
            .sort();
          const reads = entriesFor(app)
            .filter(([, entry]) => entry.reads)
            .map(([name]) => name);
          expect(called.filter((name) => !reads.includes(name))).toEqual(rpcs);
        },
      );

      run('her .from() okumasının bir okuma fonksiyonu var (S07)', () => {
        const covered = new Set(
          entriesFor(app).flatMap(([, entry]) => entry.reads ?? []),
        );
        expect(fromTablesOf(lib).filter((t) => !covered.has(t))).toEqual([]);
      });

      run(
        'her okuma fonksiyonu ya çağrılıyor ya da yerine geçtiği .from() hâlâ duruyor',
        () => {
          const called = new Set(rpcNamesOf(lib));
          const tables = new Set(fromTablesOf(lib));
          const orphans = entriesFor(app)
            .filter(([, entry]) => entry.reads)
            .filter(
              ([name, entry]) =>
                !called.has(name) &&
                !(entry.reads ?? []).some((t) => tables.has(t)),
            )
            .map(([name]) => name);
          expect(orphans).toEqual([]);
        },
      );
    },
  );

  it("her okuma fonksiyonu docs/migration/read-mapping.md'de", () => {
    const doc = readFileSync(
      join(__dirname, '..', 'docs', 'migration', 'read-mapping.md'),
      'utf8',
    );
    const missing = Object.entries(RPC_ALLOWLIST)
      .filter(([name, entry]) => entry.reads && !doc.includes(`\`${name}(`))
      .map(([name]) => name);
    expect(missing).toEqual([]);
  });

  describe('veritabanıyla tutarlı', () => {
    let db: TestDatabase;
    let client: Client;

    beforeAll(async () => {
      db = await startTestDatabase();
      client = new Client({ connectionString: db.url });
      await client.connect();
    });

    afterAll(async () => {
      await client?.end();
      await db?.stop();
    });

    it("her fonksiyon public şemasında var ve tek overload'lu", async () => {
      const { rows } = await client.query<{ proname: string; n: number }>(
        `select proname, count(*)::int as n from pg_proc
          where pronamespace = 'public'::regnamespace and proname = any($1)
          group by proname`,
        [Object.keys(RPC_ALLOWLIST)],
      );
      expect(rows.map((r) => r.proname).sort()).toEqual(
        Object.keys(RPC_ALLOWLIST).sort(),
      );
      expect(rows.filter((r) => r.n !== 1)).toEqual([]);
    });

    it('callers, veritabanındaki EXECUTE yetkileriyle aynı', async () => {
      const { rows } = await client.query<{
        proname: string;
        anon: boolean;
        authenticated: boolean;
      }>(
        `select proname,
                has_function_privilege('anon', oid, 'execute') as anon,
                has_function_privilege('authenticated', oid, 'execute') as authenticated
           from pg_proc
          where pronamespace = 'public'::regnamespace and proname = any($1)`,
        [Object.keys(RPC_ALLOWLIST)],
      );
      for (const row of rows) {
        const callers = RPC_ALLOWLIST[row.proname].callers;
        expect({ fn: row.proname, anon: callers.includes('anon') }).toEqual({
          fn: row.proname,
          anon: row.anon,
        });
        expect({ fn: row.proname, auth: row.authenticated }).toEqual({
          fn: row.proname,
          auth: true,
        });
      }
    });
  });
});
