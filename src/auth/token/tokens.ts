import { createHash, randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import jwt from 'jsonwebtoken';
import { APP_CONFIG } from '../../config/config.module';
import type { AppConfig } from '../../config/env.schema';

/** Token'a girecek kullanıcı alanları (auth.users satırından). */
export interface TokenSubject {
  id: string;
  email: string | null;
  phone: string | null;
  app_metadata: Record<string, unknown>;
  user_metadata: Record<string, unknown>;
  is_anonymous: boolean;
}

export interface IssuedAccessToken {
  token: string;
  expiresIn: number;
  /** Unix saniye. */
  expiresAt: number;
}

/**
 * Access token: HS256, `JWT_SECRET` — GoTrue'nun claim adlarıyla (K8). SQL
 * `auth.uid()`/`auth.jwt()` ve `JwtVerifier` bunu Supabase'in token'ı gibi
 * okur. `amr` girişin yöntemini ve zamanını taşır (refresh'te ilk girişinki
 * korunur, GoTrue gibi).
 */
@Injectable()
export class AccessTokenIssuer {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  issue(
    subject: TokenSubject,
    sessionId: string,
    signedInAt: number,
    now: number = Math.floor(Date.now() / 1000),
  ): IssuedAccessToken {
    const expiresIn = this.config.JWT_EXPIRY_SEC;
    const expiresAt = now + expiresIn;
    const payload = {
      iss: this.config.JWT_ISSUER,
      sub: subject.id,
      aud: 'authenticated',
      exp: expiresAt,
      iat: now,
      email: subject.email ?? '',
      phone: subject.phone ?? '',
      app_metadata: subject.app_metadata,
      user_metadata: subject.user_metadata,
      role: 'authenticated',
      aal: 'aal1',
      amr: [{ method: 'password', timestamp: signedInAt }],
      session_id: sessionId,
      is_anonymous: subject.is_anonymous,
    };
    const token = jwt.sign(payload, this.config.JWT_SECRET, {
      algorithm: 'HS256',
      header: { alg: 'HS256', typ: 'JWT' },
    });
    return { token, expiresIn, expiresAt };
  }
}

/**
 * Refresh token: 32 rastgele bayt (base64url, 43 karakter). Veritabanına
 * yalnızca SHA-256'sı (hex) yazılır — `auth.refresh_tokens.token` ve
 * `parent` sütunları hash taşır; veritabanı sızsa da token'lar kullanılamaz.
 * Token 256 bit rastgele olduğu için tuzsuz, hızlı hash yeterli (şifre
 * değil, tahmin edilemez).
 */
export function newRefreshToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: hashRefreshToken(token) };
}

export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}
