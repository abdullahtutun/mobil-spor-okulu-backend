import { HttpStatus } from '@nestjs/common';
import { ApiException } from '../common/errors/api-error';

/**
 * `/auth/*` uçlarının hata kodları: GoTrue'nun `error_code` değerleri,
 * bizim tek hata gövdemizde (`{ code, message }`, AGENTS.md K-ilkesi 8).
 * İstemci (S13/S14) `code`'a bakar; yönetim uygulamasının
 * `localizeAuthError`'ı ve `LoginRepository` bugün de bu adları tanıyor.
 */
export type AuthErrorCode =
  | 'invalid_credentials'
  | 'email_not_confirmed'
  | 'refresh_token_not_found'
  | 'refresh_token_already_used'
  | 'session_not_found'
  | 'user_not_found'
  | 'user_banned'
  | 'no_authorization'
  | 'bad_jwt'
  | 'validation_failed'
  | 'unsupported_grant_type'
  | 'weak_password'
  | 'same_password'
  | 'over_request_rate_limit'
  | 'over_email_send_rate_limit'
  | 'otp_expired'
  | 'email_exists'
  | 'email_address_invalid';

export function authError(
  status: HttpStatus,
  code: AuthErrorCode,
  message: string,
): ApiException {
  return ApiException.of(status, code, message);
}

/**
 * Yanlış e-posta, yanlış şifre, yasaklı ya da silinmiş hesap: hepsi aynı
 * yanıt (hesabın varlığı sızmasın). Mesaj GoTrue'nunkiyle aynı.
 */
export const invalidCredentials = () =>
  authError(
    HttpStatus.BAD_REQUEST,
    'invalid_credentials',
    'Invalid login credentials',
  );

/** Refresh token yok, iptal edilmiş ya da oturumu kapanmış. */
export const refreshTokenNotFound = () =>
  authError(
    HttpStatus.BAD_REQUEST,
    'refresh_token_not_found',
    'Invalid Refresh Token: Refresh Token Not Found',
  );

/**
 * Sınır aşıldı (429). `retryAfterSec` controller'da `Retry-After` başlığına
 * yazılır.
 */
export function rateLimited(
  code: 'over_request_rate_limit' | 'over_email_send_rate_limit',
  retryAfterSec: number,
): ApiException {
  const error = authError(
    HttpStatus.TOO_MANY_REQUESTS,
    code,
    code === 'over_email_send_rate_limit'
      ? 'Email rate limit exceeded'
      : 'Request rate limit reached',
  );
  (error as ApiException & { retryAfterSec?: number }).retryAfterSec =
    retryAfterSec;
  return error;
}

/**
 * Yanlış, süresi dolmuş, kullanılmış ya da hiç olmayan kod / davet
 * bağlantısı: hepsi aynı yanıt (GoTrue gibi `otp_expired`, 403). Uygulamalar
 * bu kodu tanıyor (`localizeAuthError`, `PasswordSetupLink`); hesabın
 * varlığı da sızmaz.
 */
export const otpExpired = () =>
  authError(
    HttpStatus.FORBIDDEN,
    'otp_expired',
    'Token has expired or is invalid',
  );
