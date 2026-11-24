import type { NestExpressApplication } from '@nestjs/platform-express';
import type { NextFunction, Request, Response } from 'express';
import { rawTextBody } from './common/http/raw-text-body';
import type { AppConfig } from './config/env.schema';

/**
 * Gövdesini kendisi okuyan oturumsuz fonksiyonlar (S10). Supabase'te Edge
 * Function'lardı ve bozuk/büyük gövdeye kendi zarflarıyla cevap veriyordu.
 */
export const RAW_BODY_ROUTES = {
  submitPreRegistration: '/functions/submit-pre-registration',
  siteLead: '/functions/site-lead',
} as const;

/** `site-lead`'in gövde sınırı (Edge Function'ın `MAX_BODY_BYTES`). */
export const SITE_LEAD_MAX_BODY_BYTES = 16 * 1024;

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
  app.use(securityHeaders);

  // JSON ayrıştırıcısından ÖNCE: bu yollar gövdeyi metin olarak alır.
  const bodyLimit = parseByteSize(config.BODY_LIMIT);
  app.use(
    RAW_BODY_ROUTES.submitPreRegistration,
    rawTextBody(bodyLimit, bodyLimit),
  );
  app.use(
    RAW_BODY_ROUTES.siteLead,
    rawTextBody(SITE_LEAD_MAX_BODY_BYTES, bodyLimit),
  );

  app.useBodyParser('json', { limit: config.BODY_LIMIT });

  // `site-lead` kendi CORS'unu taşır (yalnızca site kökenleri, Edge
  // Function'daki gibi; `SiteLeadController`). Geri kalan her yol
  // CORS_ORIGINS'e göre; boşsa CORS kapalı.
  app.enableCors((req: Request, callback) => {
    const path = (req.originalUrl ?? req.url ?? '').split('?')[0];
    if (config.CORS_ORIGINS.length === 0 || path === RAW_BODY_ROUTES.siteLead) {
      callback(null, { origin: false });
      return;
    }
    callback(null, {
      origin: config.CORS_ORIGINS,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      // supabase-dart'ın gönderdikleri de (apikey, x-client-info) geçsin.
      allowedHeaders: [
        'Authorization',
        'Content-Type',
        'apikey',
        'x-client-info',
        'Prefer',
        // storage_client (S08): yükleme ve koşullu indirme başlıkları.
        'x-upsert',
        'x-metadata',
        'cache-control',
        'If-None-Match',
      ],
      credentials: false,
      maxAge: 600,
    });
  });
}

/**
 * Her yanıta eklenen güvenlik başlıkları (S16). API JSON ve dosya döndürür;
 * HTML sunmaz. `Cross-Origin-Resource-Policy` bilerek yok: okul logoları
 * e-postalarda ve web paketlerinde başka kökenden `<img>` ile açılır. HSTS
 * yalnızca HTTPS üzerinden gelen istekte anlamlıdır, tarayıcı HTTP'de yok
 * sayar; Coolify'ın vekili TLS'i sonlandırdığı için burada konur.
 */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Strict-Transport-Security': 'max-age=31536000',
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
};

function securityHeaders(
  _req: Request,
  res: Response,
  next: NextFunction,
): void {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    res.setHeader(name, value);
  }
  next();
}

/** body-parser biçimindeki boyut (`1mb`, `512kb`, `100b`) → bayt. */
export function parseByteSize(value: string): number {
  const m = /^(\d+)(b|kb|mb)$/.exec(value);
  if (!m) throw new Error(`Geçersiz boyut: ${value}`);
  const n = Number(m[1]);
  return m[2] === 'mb' ? n * 1024 * 1024 : m[2] === 'kb' ? n * 1024 : n;
}
