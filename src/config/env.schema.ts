import { z } from 'zod';

/**
 * Ortam değişkenlerinin tek şeması. Sonraki oturumlar kendi anahtarlarını
 * buraya ve `.env.example`'a birlikte ekler.
 */
export const envSchema = z.object({
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_URL: z
    .string()
    .min(1)
    .refine(
      (value) => /^postgres(ql)?:\/\//.test(value),
      'postgres:// ya da postgresql:// ile başlamalı',
    ),
  // API'nin kendi bağlantısı: `api_authenticator` olarak (K5). Bu rol tek
  // başına hiçbir şeye yetkili değil; her istekte anon / authenticated /
  // service_role'e geçer. DATABASE_URL (postgres) yalnızca dbmate içindir.
  API_DATABASE_URL: z
    .string()
    .min(1)
    .refine(
      (value) => /^postgres(ql)?:\/\//.test(value),
      'postgres:// ya da postgresql:// ile başlamalı',
    ),
  // HS256 imza anahtarı; Supabase'in JWT secret'ı gibi en az 32 karakter.
  JWT_SECRET: z.string().min(32, 'en az 32 karakter olmalı'),
  // Tarayıcıdan çağırabilecek kökenler, virgülle. Boşsa CORS kapalı
  // (mobil uygulamaların CORS'a ihtiyacı yok).
  CORS_ORIGINS: z
    .string()
    .default('')
    .transform((value) =>
      value
        .split(',')
        .map((origin) => origin.trim())
        .filter((origin) => origin.length > 0),
    )
    .pipe(z.array(z.url())),
  // JSON gövdesinin üst sınırı (body-parser biçimi: 1mb, 512kb …).
  BODY_LIMIT: z
    .string()
    .regex(/^\d+(b|kb|mb)$/, '1mb, 512kb gibi olmalı')
    .default('1mb'),
  // IP başına hız sınırı: THROTTLE_TTL_MS içinde en fazla THROTTLE_LIMIT istek.
  // Bir salonun Wi-Fi'ı arkasında birçok antrenör aynı IP'den gelir; cömert.
  THROTTLE_LIMIT: z.coerce.number().int().min(1).default(600),
  THROTTLE_TTL_MS: z.coerce.number().int().min(1000).default(60_000),
  // Önde kaç vekil (proxy) var: Coolify'da 1. 0 = istemci IP'si doğrudan soket.
  TRUST_PROXY: z.coerce.number().int().min(0).max(5).default(0),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),
});

export type AppConfig = z.infer<typeof envSchema>;

export class InvalidConfigError extends Error {
  constructor(readonly issues: string[]) {
    super(
      `Geçersiz ortam değişkenleri (.env.example'a bakın):\n  - ${issues.join('\n  - ')}`,
    );
    this.name = 'InvalidConfigError';
  }
}

/**
 * Ortamı doğrular; eksik ya da hatalı bir anahtar varsa hepsini tek
 * mesajda sayan bir hata fırlatır. Değerler mesaja yazılmaz (sır olabilir).
 */
export function loadConfig(env: Record<string, string | undefined>): AppConfig {
  const result = envSchema.safeParse(env);
  if (!result.success) {
    throw new InvalidConfigError(
      result.error.issues.map(
        (issue) => `${issue.path.join('.') || '(kök)'}: ${issue.message}`,
      ),
    );
  }
  return result.data;
}
