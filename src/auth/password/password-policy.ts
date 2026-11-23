import { MAX_PASSWORD_BYTES } from './password-hasher';

/**
 * Sunucunun şifre kuralı — Supabase projesindekiyle aynı: en az 6 karakter,
 * karakter türü şartı yok (yönetim AGENTS.md → "Password rule": rakam şartı
 * yalnızca istemcide yol gösterici, `123456` bilerek kabul). Üst sınır
 * bcrypt'in 72 baytı (GoTrue da daha uzununu reddeder).
 *
 * Supabase'in auth ayarları veritabanında değil, panelde; canlı değer salt
 * okunur SQL ile görülemedi — 6, Supabase'in varsayılanı ve yönetim
 * uygulamasının `PasswordPolicy`'siyle sınanan değer (S05 günlüğü).
 */
export const MIN_PASSWORD_LENGTH = 6;

/** Kurala uymuyorsa nedeni (GoTrue'nun `weak_password` mesajı gibi), uyuyorsa null. */
export function passwordPolicyError(password: string): string | null {
  if ([...password].length < MIN_PASSWORD_LENGTH) {
    return `Password should be at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  if (Buffer.byteLength(password, 'utf8') > MAX_PASSWORD_BYTES) {
    return `Password cannot be longer than ${MAX_PASSWORD_BYTES} bytes.`;
  }
  return null;
}
