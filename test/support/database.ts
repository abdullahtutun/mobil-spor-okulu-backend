import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { Client } from 'pg';
import { GenericContainer } from 'testcontainers';

const execFileAsync = promisify(execFile);

const ROOT = join(__dirname, '..', '..');
const IMAGE = 'mobil-spor-okulu-postgres:test';

export interface TestDatabase {
  container: StartedPostgreSqlContainer;
  /** dbmate ve `pg` için hazır bağlantı adresi (`sslmode=disable`). */
  url: string;
  stop(): Promise<void>;
}

let imageBuilt: Promise<void> | undefined;

/**
 * Projenin kendi Postgres imajını (`docker/postgres/Dockerfile`, pg_cron'lu)
 * build eder. Docker katman önbelleği sayesinde ikinci seferden sonra
 * saniyeler sürer; aynı süreçte yalnızca bir kez çağrılır.
 */
function buildImage(): Promise<void> {
  imageBuilt ??= GenericContainer.fromDockerfile(
    join(ROOT, 'docker', 'postgres'),
  )
    .build(IMAGE, { deleteOnExit: false })
    .then(() => undefined);
  return imageBuilt;
}

/** `db/migrations/`'ı verilen veritabanına uygular (`npm run db:migrate` ile aynı). */
export async function migrate(url: string): Promise<void> {
  await execFileAsync(
    join(ROOT, 'node_modules', '.bin', 'dbmate'),
    [
      '--url',
      url,
      '--migrations-dir',
      join(ROOT, 'db', 'migrations'),
      '--no-dump-schema',
      '--wait',
      'up',
    ],
    { cwd: ROOT, env: { ...process.env, DATABASE_URL: url } },
  );
}

/** `test/fixtures/seed.sql`'i (uydurma iki okul) verilen veritabanına yükler. */
export async function seed(url: string): Promise<void> {
  const sql = readFileSync(join(ROOT, 'test', 'fixtures', 'seed.sql'), 'utf8');
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    await client.query(sql);
  } finally {
    await client.end();
  }
}

export interface StartOptions {
  /** Migration'lardan sonra `test/fixtures/seed.sql`'i yükle. */
  seed?: boolean;
}

/**
 * Projenin imajından taze bir Postgres başlatır ve migration'ları uygular.
 * Veritabanı adı Supabase'teki gibi `postgres` (pg_cron orada çalışır).
 */
export async function startTestDatabase(
  options: StartOptions = {},
): Promise<TestDatabase> {
  await buildImage();
  const container = await new PostgreSqlContainer(IMAGE)
    .withDatabase('postgres')
    .withUsername('postgres')
    .withPassword('postgres')
    .start();
  const url = `${container.getConnectionUri()}?sslmode=disable`;
  await migrate(url);
  if (options.seed) await seed(url);
  return {
    container,
    url,
    stop: async () => {
      await container.stop();
    },
  };
}
