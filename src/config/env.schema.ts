import { z } from 'zod';

/**
 * Ortam değişkenlerinin tek şeması. Sonraki oturumlar kendi anahtarlarını
 * buraya ve `.env.example`'a birlikte ekler.
 */
/** Tanıtım sitesinin kökenleri (ex `site-lead` Edge Function'ının varsayılanı). */
export const DEFAULT_SITE_ORIGINS = [
  'https://mobilsporokulu.com',
  'https://www.mobilsporokulu.com',
  'http://localhost:4321',
] as const;

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
  // S10: oturumsuz formlarda (online ön kayıt, site lead) IP'nin özeti
  // sha256("<tuz>:<ip>"). Supabase secrets'taki IP_HASH_SALT ile aynı değer
  // verilirse özetler aynı çıkar. Boşsa JWT_SECRET'tan türetilir (uyarı).
  IP_HASH_SALT: z.string().default(''),
  // Tanıtım sitesi formunun (site-lead) CORS kökenleri, virgülle; ex Edge
  // Function'ın varsayılanı.
  // Boş değer de varsayılan (Edge: `env(...) || DEFAULT`).
  SITE_ALLOWED_ORIGINS: z
    .string()
    .default('')
    .transform((value) => {
      const list = value
        .split(',')
        .map((origin) => origin.trim())
        .filter((origin) => origin.length > 0);
      return list.length > 0 ? list : [...DEFAULT_SITE_ORIGINS];
    }),
  // Site talebinin bildirim e-postasının gideceği adres; boşsa e-posta atlanır
  // (talep yine kaydedilir). Gönderen: public markanın kutusu (SMTP_*_PUBLIC).
  SITE_LEAD_NOTIFY_TO: z.string().default(''),
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
  // Dosya deposu (S08, K9): baytlar STORAGE_ROOT/<bucket>/<ad>. Docker'da
  // kalıcı bir volume olmalı (Coolify: /data/storage). Kişisel veri (çocuk
  // fotoğrafları) — repoya girmez (.gitignore: /storage-data/).
  STORAGE_ROOT: z.string().min(1).default('./storage-data'),
  // Bir dosyanın genel üst sınırı (bayt); bucket'ın file_size_limit'i daha
  // küçükse o geçerli (athlete-photos 1 MB, school-logos 2 MB).
  STORAGE_MAX_FILE_SIZE: z.coerce
    .number()
    .int()
    .min(1024)
    .max(50 * 1024 * 1024)
    .default(5 * 1024 * 1024),
  // S11 push (ex send-push): Firebase servis hesabı JSON'u, tek satır. Boşsa
  // push kapalı — kuyruk bekler, gelen kutusu çalışır (Edge Function gibi).
  // Geçersiz JSON da kapalı sayılır ve açılışta hata loglanır; API'yi
  // durdurmaz.
  FCM_SERVICE_ACCOUNT: z.string().default(''),
  // Kuyruğun API içinden periyodik süpürülmesi (ms; 0 = kapalı). Asıl dürtme
  // veritabanından gelir (trigger + 5 dakikalık sweep_push_queue cron'u);
  // bu, LISTEN bağlantısının koptuğu anlarda kaçanlar için.
  PUSH_SWEEP_INTERVAL_MS: z.coerce
    .number()
    .int()
    .min(0)
    .default(5 * 60_000),
  // S11 realtime (`GET /realtime`, WebSocket): bağlandıktan sonra auth
  // mesajının en geç gelmesi gereken süre, sunucunun ping aralığı (pong
  // gelmezse bağlantı düşürülür), oturumun (çıkış / hesap silme) yeniden
  // denetlenme aralığı ve bir kullanıcının aynı anda açık bağlantı sayısı
  // (aşılınca en eskisi kapanır).
  REALTIME_AUTH_TIMEOUT_MS: z.coerce.number().int().min(100).default(5_000),
  REALTIME_HEARTBEAT_MS: z.coerce.number().int().min(100).default(30_000),
  REALTIME_SESSION_CHECK_MS: z.coerce.number().int().min(100).default(60_000),
  REALTIME_MAX_SOCKETS_PER_USER: z.coerce
    .number()
    .int()
    .min(1)
    .max(100)
    .default(10),
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
