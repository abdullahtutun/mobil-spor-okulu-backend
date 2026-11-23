import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import type { App } from 'supertest/types';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/app.setup';
import { APP_CONFIG } from '../../src/config/config.module';
import type { AppConfig } from '../../src/config/env.schema';
import type { TestDatabase } from './database';

/** e2e testlerinde token imzalayan anahtar (yalnızca test). */
export const TEST_JWT_SECRET = 'e2e-test-icin-en-az-otuz-iki-karakter';

/**
 * Testin ortamını kurar: API `api_authenticator` olarak bağlanır (üretimdeki
 * gibi), migration'lar postgres ile. `extra` ile anahtar ezilebilir.
 */
export function setTestEnv(
  db: TestDatabase,
  extra: Record<string, string> = {},
): void {
  Object.assign(process.env, {
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DATABASE_URL: db.url,
    API_DATABASE_URL: db.apiUrl,
    JWT_SECRET: TEST_JWT_SECRET,
    CORS_ORIGINS: 'https://yonetim.mobilsporokulu.com',
    BODY_LIMIT: '1mb',
    THROTTLE_LIMIT: '10000',
    THROTTLE_TTL_MS: '60000',
    TRUST_PROXY: '0',
    ...extra,
  });
}

/** `main.ts` ile aynı kurulumla (gövde sınırı, CORS) bir uygulama açar. */
export async function createTestApp(
  db: TestDatabase,
  extra: Record<string, string> = {},
): Promise<INestApplication<App>> {
  setTestEnv(db, extra);
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({
    bodyParser: false,
  });
  configureApp(app, app.get<AppConfig>(APP_CONFIG));
  app.enableShutdownHooks();
  await app.init();
  return app;
}
