-- migrate:up
-- =============================================================================
-- 0006 — Kodlu auth akışları (S06): şifre sıfırlama, kayıt, davet
-- =============================================================================
-- `auth_service` rolüne (0005) S06'nın ihtiyaç duyduğu yetkiler ve kod
-- denemelerini sayan küçük bir tablo.
--
-- Kodlar GoTrue'nun yerlerinde durur: `auth.users.recovery_token` /
-- `confirmation_token` (+ `*_sent_at`) ve `auth.one_time_tokens` satırı.
-- Değer düz kod değil, hash'i (src/auth/otp/otp-codes.ts):
--   * 6 haneli kod → HMAC-SHA256(JWT_SECRET'tan türetilmiş anahtar,
--     tür:kullanıcı:kod). GoTrue'nun tuzsuz sha224(e-posta+kod)'u veritabanı
--     sızarsa 10^6 denemeyle çözülür; anahtarsız HMAC çözülemez.
--   * davet bağlantısı → 32 rastgele bayt; veritabanında SHA-256'sı.
--
-- `auth.otp_attempts`: GoTrue'da karşılığı yok (Supabase yanlış kod
-- denemesini yalnızca IP başına sınırlar). Bir kod için AUTH_OTP_MAX_ATTEMPTS
-- yanlış denemeden sonra kod silinir; sayaç veritabanında, API yeniden
-- başlasa da sıfırlanmaz. Yeni kod gönderilince sayaç sıfırlanır.
--
-- Canlıya karşılığı yok (Supabase'te auth şemasının sahibi GoTrue);
-- şema parmak izleri yalnızca public ve storage'ı kapsar.
-- =============================================================================

create table if not exists auth.otp_attempts (
  user_id      uuid not null references auth.users (id) on delete cascade,
  token_type   auth.one_time_token_type not null,
  failed_count integer not null default 0,
  updated_at   timestamptz not null default now(),
  primary key (user_id, token_type)
);
comment on table auth.otp_attempts is
  'Kod başına yanlış deneme sayısı (S06). Yazan yalnızca auth modülü (auth_service).';
revoke all on auth.otp_attempts from public, anon, authenticated;

-- Kullanıcı: kayıt ve davet satır açar; S09'un admin işlemleri (createUser,
-- deleteUser) için silme. Güncellenen sütunlar akışların yazdıklarıyla sınırlı.
grant insert, delete on auth.users to auth_service;
grant update (
  email, email_confirmed_at, invited_at,
  confirmation_token, confirmation_sent_at,
  recovery_token, recovery_sent_at,
  banned_until
) on auth.users to auth_service;

-- Kimlik: kayıt/davet açar; onay ve e-posta değişikliği identity_data'yı günceller.
grant insert, update on auth.identities to auth_service;

grant select, insert, update, delete on auth.one_time_tokens to auth_service;
grant select, insert, update, delete on auth.otp_attempts to auth_service;

-- migrate:down
revoke all on auth.otp_attempts, auth.one_time_tokens from auth_service;
revoke insert, update on auth.identities from auth_service;
revoke update (
  email, email_confirmed_at, invited_at,
  confirmation_token, confirmation_sent_at,
  recovery_token, recovery_sent_at,
  banned_until
) on auth.users from auth_service;
revoke insert, delete on auth.users from auth_service;
drop table if exists auth.otp_attempts;
