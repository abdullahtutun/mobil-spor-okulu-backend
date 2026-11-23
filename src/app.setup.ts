import type { NestExpressApplication } from '@nestjs/platform-express';
import type { AppConfig } from './config/env.schema';

/**
 * Uygulamanın HTTP ayarları; `main.ts` ve e2e testleri aynısını kullanır.
 * Nest'i `bodyParser: false` ile oluşturun: gövde sınırı burada konur.
 */
export function configureApp(
  app: NestExpressApplication,
  config: AppConfig,
): void {
  // Coolify'ın vekili arkasında istemci IP'si X-Forwarded-For'dan okunur;
  // hız sınırı IP başına olduğu için bu sayı doğru olmalı (S16).
  app.set('trust proxy', config.TRUST_PROXY);
  app.disable('x-powered-by');

  app.useBodyParser('json', { limit: config.BODY_LIMIT });

  if (config.CORS_ORIGINS.length > 0) {
    app.enableCors({
      origin: config.CORS_ORIGINS,
      methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
      // supabase-dart'ın gönderdikleri de (apikey, x-client-info) geçsin.
      allowedHeaders: [
        'Authorization',
        'Content-Type',
        'apikey',
        'x-client-info',
        'Prefer',
      ],
      credentials: false,
      maxAge: 600,
    });
  }
}
