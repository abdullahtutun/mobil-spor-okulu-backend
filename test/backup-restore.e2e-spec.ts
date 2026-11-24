import type { INestApplication } from '@nestjs/common';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';
import request from 'supertest';
import type { App } from 'supertest/types';
import { createTestApp } from './support/app';
import {
  buildImage,
  IMAGE,
  setApiPassword,
  startTestDatabase,
  TEST_API_PASSWORD,
  type TestDatabase,
} from './support/database';
import { SEED_PASSWORD } from './fixtures/seed-ids';

/**
 * S16 kabul kriteri: "Bir yedek alınıp boş bir veritabanına geri yüklendi."
 * Üretimdeki yolun aynısı: kaynakta `pg_dump -Fc` (Coolify'ın planlı yedeği
 * ve scripts/backup/backup.sh bu biçimi alır), hedef projenin imajından
 * migration'sız yeni bir küme, yükleme `scripts/backup/restore-db.sh`.
 */
const ROOT = join(__dirname, '..');

async function query<T extends object>(url: string, sql: string): Promise<T[]> {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    return (await client.query<T>(sql)).rows;
  } finally {
    await client.end();
  }
}

/** Şema parmak izi + her tablonun satır sayısı + cron işleri + migration'lar. */
async function snapshot(url: string): Promise<Record<string, unknown>> {
  const fingerprint = await query<{ k: string; md5: string }>(
    url,
    readFileSync(join(ROOT, 'scripts', 'schema-fingerprint.sql'), 'utf8'),
  );
  const tables = await query<{ name: string }>(
    url,
    `select schemaname || '.' || tablename as name from pg_tables
      where schemaname in ('public', 'auth', 'storage', 'cron')
      order by 1`,
  );
  const counts: Record<string, number> = {};
  for (const { name } of tables) {
    const [row] = await query<{ n: string }>(
      url,
      `select count(*) as n from ${name}`,
    );
    counts[name] = Number(row.n);
  }
  const cron = await query(
    url,
    'select jobname, schedule, command, active from cron.job order by jobname',
  );
  const migrations = await query(
    url,
    'select version from public.schema_migrations order by version',
  );
  // Küme rolleri pg_dump'ta yok; roles.sql'in eksiği burada görünür.
  const roles = await query(
    url,
    `select r.rolname, r.rolcanlogin, r.rolinherit, r.rolbypassrls,
            array(select g.rolname from pg_auth_members m
                    join pg_roles g on g.oid = m.roleid
                   where m.member = r.oid order by 1) as member_of
       from pg_roles r
      where r.rolname !~ '^pg_' and r.rolname <> 'postgres'
      order by 1`,
  );
  return { fingerprint, counts, cron, migrations, roles };
}

async function exec(
  container: StartedPostgreSqlContainer,
  cmd: string[],
): Promise<string> {
  const res = await container.exec(cmd);
  if (res.exitCode !== 0) {
    throw new Error(`${cmd.join(' ')} → ${res.exitCode}\n${res.output}`);
  }
  return res.output;
}

describe('Yedek → boş veritabanına geri yükleme (S16)', () => {
  let source: TestDatabase;
  let target: StartedPostgreSqlContainer;
  let targetUrl: string;
  let app: INestApplication<App> | undefined;

  beforeAll(async () => {
    source = await startTestDatabase({ seed: true });
    await buildImage();
    target = await new PostgreSqlContainer(IMAGE)
      .withDatabase('postgres')
      .withUsername('postgres')
      .withPassword('postgres')
      .start();
    targetUrl = `${target.getConnectionUri()}?sslmode=disable`;
  });

  afterAll(async () => {
    await app?.close();
    await source?.stop();
    await target?.stop();
  });

  it('pg_dump -Fc yedeği restore-db.sh ile birebir geri gelir ve API açılır', async () => {
    // 1. Yedek (kaynak konteynerin içinde, ikili güvenli taşınsın diye base64).
    await exec(source.container, [
      'pg_dump',
      '-U',
      'postgres',
      '-d',
      'postgres',
      '-Fc',
      '-f',
      '/tmp/yedek.dump',
    ]);
    const b64 = await exec(source.container, [
      'base64',
      '-w0',
      '/tmp/yedek.dump',
    ]);
    const dump = Buffer.from(b64.trim(), 'base64');
    expect(dump.subarray(0, 5).toString()).toBe('PGDMP');

    // 2. Hedefe betik + roller + yedek; geri yükle.
    await target.copyContentToContainer([
      { content: dump, target: '/restore/yedek.dump' },
      {
        content: readFileSync(join(ROOT, 'scripts', 'backup', 'restore-db.sh')),
        target: '/restore/restore-db.sh',
      },
      {
        content: readFileSync(join(ROOT, 'scripts', 'backup', 'roles.sql')),
        target: '/restore/roles.sql',
      },
    ]);
    const out = await exec(target, [
      'sh',
      '/restore/restore-db.sh',
      '/restore/yedek.dump',
    ]);
    expect(out).toContain('Geri yükleme bitti');

    // 3. Şema, veri, cron işleri ve migration geçmişi aynı.
    const [before, after] = await Promise.all([
      snapshot(source.url),
      snapshot(targetUrl),
    ]);
    expect(after).toEqual(before);
    expect(
      (before.counts as Record<string, number>)['auth.users'],
    ).toBeGreaterThan(0);

    // 4. Dolu veritabanına ikinci yükleme reddedilir.
    const again = await target.exec([
      'sh',
      '/restore/restore-db.sh',
      '/restore/yedek.dump',
    ]);
    expect(again.exitCode).not.toBe(0);
    expect(again.output).toContain('Hedef boş değil');

    // 5. API geri yüklenen veritabanında açılır, seed kullanıcısı giriş yapar
    //    (rol parolası dump'ta yok; üretimde giriş betiği yazar).
    await setApiPassword(targetUrl);
    const api = new URL(targetUrl);
    api.username = 'api_authenticator';
    api.password = TEST_API_PASSWORD;
    app = await createTestApp({
      container: target,
      url: targetUrl,
      apiUrl: api.toString(),
      stop: async () => {},
    });
    await request(app.getHttpServer()).get('/health').expect(200);
    const login = await request(app.getHttpServer())
      .post('/auth/token?grant_type=password')
      .send({ email: 'genel.mudur@a.test', password: SEED_PASSWORD })
      .expect(200);
    expect(login.body).toHaveProperty('access_token');
  });
});
