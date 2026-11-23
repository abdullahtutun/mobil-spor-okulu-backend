import { Injectable } from '@nestjs/common';
import bcrypt from 'bcryptjs';

/** GoTrue'nun (Go `bcrypt.DefaultCost`) maliyeti. */
export const BCRYPT_COST = 10;

/**
 * Bilinmeyen e-postada da bir bcrypt karşılaştırması yapılır; yanıt süresi
 * hesabın var olup olmadığını söylemesin. Sonuç her zaman atılır; hash'in
 * kendisi önemsiz (Go bcrypt'in test vektörü), maliyeti gerçek hash'lerle
 * aynı (10).
 */
const DUMMY_HASH =
  '$2a$10$XajjQvNhvvRt5GSeFk1xFeyqRrsxkhBkUiQeg0dt.wU1qD4aFDcga';

/** bcrypt tek seferde en fazla 72 bayt okur; GoTrue da uzununu reddeder. */
export const MAX_PASSWORD_BYTES = 72;

/**
 * Şifre hash'i — Supabase'teki `auth.users.encrypted_password` ile aynı
 * biçim (PLAN.md K8). Canlıdaki hash'ler `$2a$` (GoTrue maliyet 10; elle
 * eklenmiş demo hesapları pgcrypto, maliyet 6); hepsi doğrulanır. `$2b$` ve
 * `$2y$` de kabul edilir (aynı algoritma).
 *
 * Yeni hash'ler `$2a$` önekiyle yazılır: bcryptjs `$2b$` üretir, ikisi
 * 72 bayttan kısa şifrelerde bit bit aynıdır; `$2a$` hem GoTrue'nun hem
 * pgcrypto'nun (seed ve veri betikleri `extensions.crypt`) okuduğu biçim —
 * gerekirse Supabase'e geri dönüş de hash'e dokunmadan olur.
 *
 * bcryptjs saf JS (yerel derleme yok, Docker imajı sade); maliyet 10'da
 * bir karşılaştırma ~60–80 ms, olay döngüsünü bloklamamak için asenkron.
 */
@Injectable()
export class PasswordHasher {
  async verify(password: string, hash: string | null): Promise<boolean> {
    if (!isBcryptHash(hash)) {
      // Hash yoksa da (davetle açılıp şifresi konmamış hesap) aynı süre.
      await bcrypt.compare(password, DUMMY_HASH);
      return false;
    }
    return bcrypt.compare(password, hash);
  }

  /** Hesap bulunamadığında harcanacak süre (bkz. DUMMY_HASH). */
  async burn(password: string): Promise<void> {
    await bcrypt.compare(password, DUMMY_HASH);
  }

  async hash(password: string): Promise<string> {
    const hash = await bcrypt.hash(password, BCRYPT_COST);
    return hash.replace(/^\$2b\$/, '$2a$');
  }
}

export function isBcryptHash(value: string | null): value is string {
  return (
    typeof value === 'string' &&
    /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/.test(value)
  );
}
