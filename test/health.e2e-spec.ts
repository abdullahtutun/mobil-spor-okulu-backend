import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Client, type Pool } from 'pg';
import { DB_POOL } from '../src/db/db.tokens';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { createTestApp } from './support/app';
import { startTestDatabase, type TestDatabase } from './support/database';

describe('Sağlık uçları (gerçek Postgres)', () => {
  let db: TestDatabase;
  let app: INestApplication<App>;

  beforeAll(async () => {
    db = await startTestDatabase();
    app = await createTestApp(db);
  });

  afterAll(async () => {
    await app?.close();
    await db?.stop();
  });

  it('uygulama kapanınca veritabanı havuzu kapanır', async () => {
    // Ayrı bir örnek: paylaşılan `app` sonraki testlerde açık kalmalı.
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    const other = moduleRef.createNestApplication();
    await other.init();
    const pool = other.get<Pool>(DB_POOL);
    await pool.query('select 1');
    await other.close();
    expect(pool.ended).toBe(true);
  });

  it('GET /health veritabanına ulaşıp 200 döner', async () => {
    await request(app.getHttpServer())
      .get('/health')
      .expect(200)
      .expect({ status: 'ok', database: 'ok' });
  });

  it('GET /health/live 200 döner', async () => {
    await request(app.getHttpServer())
      .get('/health/live')
      .expect(200)
      .expect({ status: 'ok' });
  });

  it('bilinmeyen yol tek hata gövdesiyle 404 döner', async () => {
    const res = await request(app.getHttpServer()).get('/yok').expect(404);
    expect(res.body).toEqual({
      code: 'not_found',
      message: expect.any(String) as string,
    });
  });

  it('pg_cron kurulu (0001_baseline, db/compat/01_extensions.sql)', async () => {
    const client = new Client({ connectionString: db.url });
    await client.connect();
    try {
      const { rows } = await client.query<{ extname: string }>(
        "select extname from pg_extension where extname = 'pg_cron'",
      );
      expect(rows).toHaveLength(1);
    } finally {
      await client.end();
    }
  });

  it("Supabase'te kurulu contrib eklentileri (pgcrypto, uuid-ossp) mevcut", async () => {
    const client = new Client({ connectionString: db.url });
    await client.connect();
    try {
      const { rows } = await client.query<{ name: string }>(
        "select name from pg_available_extensions where name in ('pgcrypto', 'uuid-ossp') order by name",
      );
      expect(rows.map((r) => r.name)).toEqual(['pgcrypto', 'uuid-ossp']);
    } finally {
      await client.end();
    }
  });

  it('migration tablosu oluşmuş (dbmate çalıştı)', async () => {
    const client = new Client({ connectionString: db.url });
    await client.connect();
    try {
      const { rows } = await client.query<{ version: string }>(
        'select version from schema_migrations order by version',
      );
      expect(rows.map((r) => r.version)).toContain('0000');
    } finally {
      await client.end();
    }
  });
});
