import {
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
  randomInt,
  timingSafeEqual,
} from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG } from '../../config/config.module';
import type { AppConfig } from '../../config/env.schema';

/** Kodun hangi akışa ait olduğu (GoTrue'nun `one_time_token_type` adları). */
export type OtpKind = 'recovery_token' | 'confirmation_token';

/** 6 haneli kod, kriptografik rastgele (GoTrue gibi; önde sıfır olabilir). */
export function newOtpCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

export const OTP_CODE_PATTERN = /^\d{6}$/;

/**
 * Davet bağlantısının token'ı: 32 rastgele bayt (base64url). Bağlantıya
 * token gider (`?token_hash=<token>&type=invite` — ad bugünkü sayfanın
 * okuduğu parametre), veritabanına SHA-256'sı: veritabanı sızsa da
 * bağlantı kurulamaz.
 */
export function newInviteToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: hashInviteToken(token) };
}

export function hashInviteToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * Supabase'in (GoTrue) gönderdiği davet bağlantısı: `token_hash` =
 * `confirmation_token`'ın kendisi (sha224 hex, 56 karakter). Geçiş gecesi
 * yolda olan davetler (24 saat) çalışsın diye yalnızca bu biçimdeki saklı
 * değer düz karşılaştırılır; bizim ürettiğimiz değerler 64 karakter ve
 * yalnızca hash'le eşleşir.
 */
export const LEGACY_INVITE_HASH = /^[0-9a-f]{56}$/;

/**
 * 6 haneli kodların saklanan biçimi: HMAC-SHA256(anahtar, `tür:kullanıcı:kod`).
 * Anahtar `JWT_SECRET`'tan HKDF ile türetilir (ayrı bir sır yönetmeyelim);
 * JWT_SECRET değişirse bekleyen kodlar geçersiz olur — 10 dakikalık
 * kodlar için kabul. Kullanıcı ve tür girdide olduğu için aynı kod iki
 * hesapta ya da iki akışta aynı hash'i vermez.
 */
@Injectable()
export class OtpHasher {
  private readonly key: Buffer;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.key = Buffer.from(
      hkdfSync(
        'sha256',
        config.JWT_SECRET,
        'mobil-spor-okulu',
        'auth-otp-v1',
        32,
      ),
    );
  }

  hash(kind: OtpKind, userId: string, code: string): string {
    return createHmac('sha256', this.key)
      .update(`${kind}:${userId}:${code}`)
      .digest('hex');
  }

  /** Sabit süreli karşılaştırma. */
  matches(
    kind: OtpKind,
    userId: string,
    code: string,
    stored: string,
  ): boolean {
    const expected = Buffer.from(this.hash(kind, userId, code), 'utf8');
    const actual = Buffer.from(stored, 'utf8');
    return (
      expected.length === actual.length && timingSafeEqual(expected, actual)
    );
  }
}
