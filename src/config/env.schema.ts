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
  // Access token süresi (sn); Supabase'in varsayılanı 3600.
  JWT_EXPIRY_SEC: z.coerce.number().int().min(60).max(86_400).default(3600),
  // Access token'ın `iss` claim'i (Supabase: <proje>/auth/v1). Doğrulamada
  // bakılmaz; yalnızca kimin ürettiğini söyler.
  JWT_ISSUER: z.string().min(1).default('mobil-spor-okulu-api'),
  // Kullanılmış (dönmüş) bir refresh token'ın kabul edildiği süre (sn):
  // eşzamanlı yenilemeler ve yanıtı ağda kaybolan yenileme için (GoTrue: 10).
  AUTH_REFRESH_REUSE_INTERVAL_SEC: z.coerce
    .number()
    .int()
    .min(0)
    .max(300)
    .default(10),
  // Kaba kuvvet koruması (POST /auth/token?grant_type=password):
  //   IP başına 5 dakikada en fazla AUTH_LOGIN_IP_LIMIT deneme (Supabase: 30);
  //   IP + e-posta başına 15 dakikada AUTH_LOGIN_FAILURE_LIMIT yanlış şifre;
  //   e-posta başına (tüm IP'ler) 1 saatte AUTH_LOGIN_EMAIL_FAILURE_LIMIT.
  AUTH_LOGIN_IP_LIMIT: z.coerce.number().int().min(1).default(30),
  AUTH_LOGIN_FAILURE_LIMIT: z.coerce.number().int().min(1).default(10),
  AUTH_LOGIN_EMAIL_FAILURE_LIMIT: z.coerce.number().int().min(1).default(20),
  // Kodlu akışlar (S06). Şifre sıfırlama / kayıt kodunun süresi (sn): e-posta
  // metni "Kod 10 dakika geçerlidir" diyor. Davet bağlantısı: "24 saat".
  AUTH_OTP_EXPIRY_SEC: z.coerce.number().int().min(60).max(86_400).default(600),
  AUTH_INVITE_EXPIRY_SEC: z.coerce
    .number()
    .int()
    .min(600)
    .max(7 * 86_400)
    .default(86_400),
  // Bir kod için en çok kaç yanlış deneme; aşılınca kod geçersiz olur.
  AUTH_OTP_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(5),
  // E-posta gönderen uçlar (recover, signup, resend), hesap var mı bakılmadan:
  //   aynı adrese en sık AUTH_EMAIL_SEND_INTERVAL_SEC'de bir (Supabase: 60),
  //   adres başına saatte AUTH_EMAIL_HOURLY_LIMIT, IP başına saatte
  //   AUTH_EMAIL_IP_HOURLY_LIMIT. Kod doğrulama: IP başına 5 dk'da
  //   AUTH_VERIFY_IP_LIMIT (Supabase: 30).
  AUTH_EMAIL_SEND_INTERVAL_SEC: z.coerce.number().int().min(0).default(60),
  AUTH_EMAIL_HOURLY_LIMIT: z.coerce.number().int().min(1).default(5),
  AUTH_EMAIL_IP_HOURLY_LIMIT: z.coerce.number().int().min(1).default(30),
  AUTH_VERIFY_IP_LIMIT: z.coerce.number().int().min(1).default(30),
  // Marka başına SMTP posta kutusu (yönetim send-email'iyle aynı anahtarlar).
  // Bir markanın kullanıcı adı ya da parolası boşsa o markanın e-postası
  // GİTMEZ, hata olur — başka markanın adresinden göndermek yok.
  SMTP_HOST: z.string().min(1).default('smtp.hostinger.com'),
  SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(465),
  SMTP_USER_DEV_ADIM: z.string().default(''),
  SMTP_PASS_DEV_ADIM: z.string().default(''),
  SMTP_USER_PUBLIC: z.string().default(''),
  SMTP_PASS_PUBLIC: z.string().default(''),
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
