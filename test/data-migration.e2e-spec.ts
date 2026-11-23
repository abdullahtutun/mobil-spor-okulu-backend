import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { Client } from 'pg';
import request from 'supertest';
import type { App } from 'supertest/types';
import { exportData } from '../src/data-migration/export';
import { importData, resumeCron } from '../src/data-migration/import';
import { SupabaseStorageSource } from '../src/data-migration/storage-source';
import { verifyData } from '../src/data-migration/verify';
import {
  ATHLETES,
  SCHOOL_A,
  SCHOOL_B,
  SEED_PASSWORD,
  USERS,
} from './fixtures/seed-ids';
import { createTestApp } from './support/app';
import { startTestDatabase, type TestDatabase } from './support/database';

/**
 * S12 provası: kaynak = canlıyla aynı şema + Supabase'e özgü storage
 * sütunları + uydurma veri (seed), hedef = boş, migrate edilmiş veritabanı.
 * Export → import → verify uçtan uca; giriş eski şifreyle; dosyalar API'den.
 */
const OLD = 'https://gcmeltwnryjscinptecb.supabase.co/storage/v1/';
const NEW = 'https://api.test/storage/';
const SERVICE_KEY = 'sahte-service-role-anahtari';
const PLAIN_REFRESH = 'abcdefghijkl'; // Supabase biçimi: 12 karakter düz metin
const SESSION_ID = 'c0000000-0000-4000-8000-00000000e001';

const jpeg = (n: number) =>
  Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), randomBytes(n)]);
const png = (n: number) =>
  Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    randomBytes(n),
  ]);
const md5 = (b: Buffer) => createHash('md5').update(b).digest('hex');

async function sql<T extends object = Record<string, unknown>>(
  url: string,
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  const c = new Client({ connectionString: url });
  await c.connect();
  try {
    return (await c.query<T>(text, params)).rows;
  } finally {
    await c.end();
  }
}

/** Kaynağın bütün verisinin tek parmak izi (export kaynağa yazmadı mı?). */
const sourceState = (url: string) =>
  sql<{ fp: string }>(
    url,
    `select md5(string_agg(t, '' order by t)) as fp from (
       select md5(to_jsonb(u)::text) t from auth.users u
       union all select md5(to_jsonb(s)::text) from auth.sessions s
       union all select md5(to_jsonb(r)::text) from auth.refresh_tokens r
       union all select md5(to_jsonb(o)::text) from storage.objects o
       union all select md5(to_jsonb(p)::text) from public.profiles p
       union all select md5(to_jsonb(x)::text) from public.schools x) s`,
  ).then((r) => r[0].fp);

describe('veri taşıma (S12 provası)', () => {
  let source: TestDatabase;
  let target: TestDatabase;
  let files: Map<string, Buffer>;
  let server: Server;
  let storageUrl: string;
  const methods: string[] = [];
  const work = mkdtempSync(join(tmpdir(), 'mso-s12-'));
  const storageRoot = join(work, 'storage-root');

  beforeAll(async () => {
    [source, target] = await Promise.all([
      startTestDatabase({ seed: true }),
      startTestDatabase(),
    ]);

    // Supabase'in storage.objects'inde olup bizde olmayan sütunlar.
    files = new Map([
      [`athlete-photos/${SCHOOL_A}/a1/p1.jpg`, jpeg(3000)],
      [`athlete-photos/${SCHOOL_A}/a1/p1_thumb.jpg`, jpeg(500)],
      [`athlete-photos/${SCHOOL_B}/b1/p 2 (1).jpg`, jpeg(1200)],
      [`school-logos/${SCHOOL_A}/logo.png`, png(4000)],
      [`school-logos/${SCHOOL_B}/logo.png`, png(800)],
    ]);
    const c = new Client({ connectionString: source.url });
    await c.connect();
    await c.query(`alter table storage.objects
      add column archived_at timestamptz,
      add column is_delete_marker boolean default false,
      add column is_versioned boolean default true`);
    for (const [key, body] of files) {
      const [bucket, ...rest] = key.split('/');
      await c.query(
        `insert into storage.objects (bucket_id, name, owner, owner_id, metadata, version)
         values ($1, $2, $3::uuid, $3::text, $4, 'v1')`,
        [
          bucket,
          rest.join('/'),
          USERS.a.generalManager,
          {
            eTag: `"${md5(body)}"`,
            size: body.length,
            mimetype: bucket === 'school-logos' ? 'image/png' : 'image/jpeg',
            cacheControl: 'max-age=3600',
          },
        ],
      );
    }
    // Disk kuralından geçmeyen ad: taşınmaz, raporlanır.
    await c.query(
      `insert into storage.objects (bucket_id, name, metadata) values ('athlete-photos', 'x/../kaçak.jpg', '{}')`,
    );
    await c.query(
      `update public.schools set logo_url = $1 || 'object/public/school-logos/' || id || '/logo.png?v=1' where id = $2`,
      [OLD, SCHOOL_A],
    );
    // Açık oturum (Supabase biçimi).
    await c.query(
      `insert into auth.sessions (id, user_id, created_at, updated_at, aal) values ($1, $2, now(), now(), 'aal1')`,
      [SESSION_ID, USERS.a.coach],
    );
    await c.query(
      `insert into auth.refresh_tokens (token, user_id, revoked, created_at, updated_at, parent, session_id)
       values ('oldparentxyz', $2, true, now(), now(), null, $1), ($3, $2, false, now(), now(), 'oldparentxyz', $1)`,
      [SESSION_ID, USERS.a.coach, PLAIN_REFRESH],
    );
    await c.end();

    // Supabase storage-api taklidi: yalnızca GET, service role anahtarıyla.
    server = createServer((req, res) => {
      methods.push(req.method ?? '');
      const prefix = '/storage/v1/object/authenticated/';
      const ok =
        req.headers.authorization === `Bearer ${SERVICE_KEY}` &&
        req.headers.apikey === SERVICE_KEY;
      const key = (req.url ?? '').startsWith(prefix)
        ? (req.url ?? '')
            .slice(prefix.length)
            .split('/')
            .map(decodeURIComponent)
            .join('/')
        : '';
      const body = files.get(key);
      if (req.method !== 'GET' || !ok || !body) {
        res.writeHead(ok ? 404 : 403).end();
        return;
      }
      res
        .writeHead(200, { 'Content-Type': 'application/octet-stream' })
        .end(body);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    storageUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    server?.close();
    await Promise.all([source?.stop(), target?.stop()]);
  });

  const storage = () => new SupabaseStorageSource(storageUrl, SERVICE_KEY);
  const timings: Record<string, number> = {};
  const timed = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
    const t = Date.now();
    try {
      return await fn();
    } finally {
      timings[name] = Date.now() - t;
    }
  };

  it('export → import → verify: sıfır fark, kaynak değişmedi', async () => {
    const before = await sourceState(source.url);
    const dir = join(work, 'export-1');
    const manifest = await timed('export', () =>
      exportData({ sourceUrl: source.url, outDir: dir, storage: storage() }),
    );
    expect(await sourceState(source.url)).toBe(before);
    expect(new Set(methods)).toEqual(new Set(['GET']));
    expect(manifest.objects).toHaveLength(files.size);
    expect(manifest.rejectedObjects).toEqual([
      {
        bucket: 'athlete-photos',
        name: 'x/../kaçak.jpg',
        reason: 'invalid_key',
      },
    ]);
    expect(manifest.tables.map((t) => t.name)).not.toContain('auth.sessions');
    expect(
      manifest.tables.find((t) => t.name === 'auth.users')?.generated,
    ).toEqual(['confirmed_at']);
    expect(statSync(join(dir, 'manifest.json')).mode & 0o777).toBe(0o600);

    const result = await timed('import', () =>
      importData({
        targetUrl: target.url,
        exportDir: dir,
        storageRoot,
        newStoragePrefix: NEW,
      }),
    );
    expect(result.notes.join('\n')).toContain(
      'archived_at, is_delete_marker, is_versioned',
    );

    const report = await timed('verify', () =>
      verifyData({
        targetUrl: target.url,
        exportDir: dir,
        storageRoot,
        newStoragePrefix: NEW,
      }),
    );
    expect(report.differences).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.authUsers.target).toBe(report.authUsers.source);
    expect(report.storage.sampled).toBe(files.size);
    expect(
      report.tables.find((t) => t.name === 'storage.objects'),
    ).toMatchObject({
      sourceRows: files.size + 1,
      targetRows: files.size,
    });

    // Dönüşümler ve dosyalar
    const [school] = await sql<{ logo_url: string }>(
      target.url,
      `select logo_url from public.schools where id = $1`,
      [SCHOOL_A],
    );
    expect(school.logo_url).toBe(
      `${NEW}object/public/school-logos/${SCHOOL_A}/logo.png?v=1`,
    );
    const photo = join(
      storageRoot,
      'athlete-photos',
      SCHOOL_B,
      'b1',
      'p 2 (1).jpg',
    );
    expect(
      readFileSync(photo).equals(
        files.get(`athlete-photos/${SCHOOL_B}/b1/p 2 (1).jpg`)!,
      ),
    ).toBe(true);
    expect(statSync(photo).mode & 0o777).toBe(0o600);
    expect(
      statSync(join(storageRoot, 'athlete-photos', SCHOOL_B)).mode & 0o777,
    ).toBe(0o700);
    expect(await sql(target.url, `select 1 from auth.sessions`)).toHaveLength(
      0,
    );
    // Yükleme sırasında trigger çalışmadı: bildirim/handle_new_user yan etkisi yok.
    const rowsOf = (t: string) =>
      String(manifest.tables.find((x) => x.name === t)?.rows);
    const counts = {
      s: rowsOf('public.profiles'),
      t: rowsOf('public.notifications'),
    };
    const [targetCounts] = await sql<{ s: string; t: string }>(
      target.url,
      `select (select count(*) from public.profiles) s, (select count(*) from public.notifications) t`,
    );
    expect(targetCounts).toEqual(counts);
    // Cron yükleme ve verify boyunca kapalı; resume-cron açar.
    expect(
      await sql(target.url, `select 1 from cron.job where active`),
    ).toHaveLength(0);
    const resumed = await resumeCron(target.url, dir);
    expect(resumed.length).toBeGreaterThan(0);
    expect(
      await sql(target.url, `select 1 from cron.job where not active`),
    ).toHaveLength(0);
    console.log(`S12 prova süreleri (ms): ${JSON.stringify(timings)}`);
  });

  it("taşınan hesaplar eski şifreyle girer; get_session_data ve dosyalar API'den", async () => {
    const app: INestApplication<App> = await createTestApp(target, {
      STORAGE_ROOT: storageRoot,
    });
    try {
      await app.listen(0, '127.0.0.1');
      const apiUrl = await app.getUrl();
      // Seed e-postası tablodan alınır (sabit varsayılmasın).
      const [gm] = await sql<{ email: string }>(
        target.url,
        `select email from auth.users where id = $1`,
        [USERS.a.generalManager],
      );
      const real = await verifyData({
        targetUrl: target.url,
        exportDir: join(work, 'export-1'),
        storageRoot,
        newStoragePrefix: NEW,
        login: { apiUrl, email: gm.email, password: SEED_PASSWORD },
      });
      expect(real.login).toEqual({
        ok: true,
        detail: 'giriş ve get_session_data başarılı',
      });
      expect(real.ok).toBe(true);

      const logo = await request(app.getHttpServer()).get(
        `/storage/object/public/school-logos/${SCHOOL_A}/logo.png`,
      );
      expect(logo.status).toBe(200);
      expect(
        Buffer.from(logo.body as Buffer).equals(
          files.get(`school-logos/${SCHOOL_A}/logo.png`)!,
        ),
      ).toBe(true);
      expect(logo.headers.etag).toBe(
        `"${md5(files.get(`school-logos/${SCHOOL_A}/logo.png`)!)}"`,
      );
      // Oturumlar taşınmadı: eski refresh token geçmez.
      const refresh = await request(app.getHttpServer())
        .post('/auth/token?grant_type=refresh_token')
        .send({ refresh_token: PLAIN_REFRESH });
      expect(refresh.status).toBe(400);
    } finally {
      await app.close();
    }
  });

  it('tekrar çalıştırma: dolu hedef reddedilir, --replace aynı sonucu verir; verify farkı yakalar', async () => {
    const dir = join(work, 'export-1');
    await expect(
      importData({
        targetUrl: target.url,
        exportDir: dir,
        storageRoot,
        newStoragePrefix: NEW,
      }),
    ).rejects.toThrow(/hedef boş değil/);

    // Bozulma: bir satır silinir, bir dosya değişir, bir sequence geriler → verify görür.
    await sql(
      target.url,
      `set session_replication_role = replica; delete from public.athletes where id = '${ATHLETES.deniz}'`,
    );
    const photo = join(storageRoot, 'athlete-photos', SCHOOL_A, 'a1', 'p1.jpg');
    writeFileSync(photo, jpeg(3000));
    const broken = await verifyData({
      targetUrl: target.url,
      exportDir: dir,
      storageRoot,
      newStoragePrefix: NEW,
    });
    expect(broken.ok).toBe(false);
    expect(broken.differences.join('\n')).toMatch(
      /public\.athletes: hedef beklenenden farklı/,
    );
    expect(broken.differences.join('\n')).toMatch(
      /hash farkı: athlete-photos\//,
    );
    expect(broken.differences.join('\n')).toMatch(/yetim satır/);

    await importData({
      targetUrl: target.url,
      exportDir: dir,
      storageRoot,
      newStoragePrefix: NEW,
      replace: true,
    });
    const again = await verifyData({
      targetUrl: target.url,
      exportDir: dir,
      storageRoot,
      newStoragePrefix: NEW,
    });
    expect(again.differences).toEqual([]);
    await resumeCron(target.url, dir);
  });

  it('--with-sessions: refresh token SHA-256 ile taşınır, eski token yenilenir, sequence ileride', async () => {
    const dir = join(work, 'export-sessions');
    const manifest = await exportData({
      sourceUrl: source.url,
      outDir: dir,
      storage: storage(),
      withSessions: true,
    });
    expect(manifest.tables.map((t) => t.name)).toEqual(
      expect.arrayContaining(['auth.sessions', 'auth.refresh_tokens']),
    );
    await importData({
      targetUrl: target.url,
      exportDir: dir,
      storageRoot,
      newStoragePrefix: NEW,
      replace: true,
    });
    const report = await verifyData({
      targetUrl: target.url,
      exportDir: dir,
      storageRoot,
      newStoragePrefix: NEW,
    });
    expect(report.differences).toEqual([]);
    const stored = await sql<{ token: string; parent: string | null }>(
      target.url,
      `select token, parent from auth.refresh_tokens where session_id = $1 and not revoked`,
      [SESSION_ID],
    );
    expect(stored).toEqual([
      {
        token: createHash('sha256').update(PLAIN_REFRESH).digest('hex'),
        parent: createHash('sha256').update('oldparentxyz').digest('hex'),
      },
    ]);
    await resumeCron(target.url, dir);

    const app: INestApplication<App> = await createTestApp(target, {
      STORAGE_ROOT: storageRoot,
    });
    try {
      const refresh = await request(app.getHttpServer())
        .post('/auth/token?grant_type=refresh_token')
        .send({ refresh_token: PLAIN_REFRESH });
      expect(refresh.status).toBe(200);
      expect((refresh.body as { user: { id: string } }).user.id).toBe(
        USERS.a.coach,
      );
    } finally {
      await app.close();
    }
    const [{ max, last }] = await sql<{ max: string; last: string }>(
      target.url,
      `select (select max(id) from auth.refresh_tokens) max, (select last_value from auth.refresh_tokens_id_seq) last`,
    );
    expect(Number(last)).toBeGreaterThanOrEqual(Number(max));
  });
});
