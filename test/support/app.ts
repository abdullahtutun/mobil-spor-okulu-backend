import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Test } from '@nestjs/testing';
import type { App } from 'supertest/types';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/app.setup';
import { APP_CONFIG } from '../../src/config/config.module';
import type { AppConfig } from '../../src/config/env.schema';
import { MAIL_TRANSPORT_FACTORY } from '../../src/mail/mail.service';
import { FCM_TRANSPORT } from '../../src/push/fcm.transport';
import type { TestDatabase } from './database';
import { FakeFcm } from './fake-fcm';
import { FakeMailbox } from './fake-mail';

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
    // Testler aynı IP'den çok giriş yapar; sınırı sınayan test kendi değerini verir.
    AUTH_LOGIN_IP_LIMIT: '100000',
    AUTH_LOGIN_FAILURE_LIMIT: '100000',
    AUTH_LOGIN_EMAIL_FAILURE_LIMIT: '100000',
    AUTH_REFRESH_REUSE_INTERVAL_SEC: '10',
    AUTH_EMAIL_SEND_INTERVAL_SEC: '0',
    AUTH_EMAIL_HOURLY_LIMIT: '100000',
    AUTH_EMAIL_IP_HOURLY_LIMIT: '100000',
    AUTH_VERIFY_IP_LIMIT: '100000',
    // Sahte kutu (FakeMailbox) kullanılır; değerler yalnızca "tanımlı" olsun diye.
    SMTP_HOST: 'smtp.invalid',
    SMTP_PORT: '465',
    SMTP_USER_DEV_ADIM: 'gonder@devadim.test',
    SMTP_PASS_DEV_ADIM: 'test-parola',
    SMTP_USER_PUBLIC: 'noreply@mobilsporokulu.test',
    SMTP_PASS_PUBLIC: 'test-parola',
    // Her uygulama kendi geçici dosya deposunda (repodaki storage-data değil).
    STORAGE_ROOT: mkdtempSync(join(tmpdir(), 'mso-e2e-storage-')),
    ...extra,
  });
}

/**
 * `main.ts` ile aynı kurulumla (gövde sınırı, CORS) bir uygulama açar.
 * E-postalar gerçek SMTP'ye değil `FakeMailbox`'a gider: `mailboxOf(app)`;
 * push'lar `FakeFcm`'e: `fcmOf(app)`.
 */
export async function createTestApp(
  db: TestDatabase,
  extra: Record<string, string> = {},
): Promise<INestApplication<App>> {
  setTestEnv(db, extra);
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  })
    .overrideProvider(MAIL_TRANSPORT_FACTORY)
    .useValue(new FakeMailbox())
    // Gerçek FCM'e hiçbir test gitmez (S11); varsayılan "yapılandırılmamış".
    .overrideProvider(FCM_TRANSPORT)
    .useValue(new FakeFcm())
    .compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({
    bodyParser: false,
  });
  configureApp(app, app.get<AppConfig>(APP_CONFIG));
  app.enableShutdownHooks();
  await app.init();
  return app;
}

/** Uygulamanın sahte posta kutusu. */
export function mailboxOf(app: INestApplication): FakeMailbox {
  return app.get<FakeMailbox>(MAIL_TRANSPORT_FACTORY);
}

/** Uygulamanın sahte FCM'i. */
export function fcmOf(app: INestApplication): FakeFcm {
  return app.get<FakeFcm>(FCM_TRANSPORT);
}
