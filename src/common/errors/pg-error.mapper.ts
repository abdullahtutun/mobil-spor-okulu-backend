import { HttpStatus } from '@nestjs/common';
import { DatabaseError } from 'pg';
import { ApiException } from './api-error';

/**
 * Postgres hatasını PostgREST'in döndürdüğü HTTP durumuna ve gövdesine
 * çevirir (PostgREST 12, `Error.hs` → `pgErrorStatus`).
 *
 * Uygulamalar bugün PostgREST'in hatasını `PostgrestException` olarak okur:
 * `code` (SQLSTATE ya da `PGRST…`), `message`, `details`, `hint`. Yönetim
 * uygulamasının `network_error.dart`'ı bir kodun HTTP durumu (502, 503 …)
 * gibi görünmesini "gateway hatası" sayar; SQLSTATE ve `PGRST…` kodları
 * öyle görünmez, bu yüzden kod alanına her zaman SQLSTATE yazılır.
 *
 * İş kuralı hataları zaten 200 + `{success: false, code, message}` zarfıyla
 * döner (`app_err`); buraya yalnızca `raise exception` ve gerçek SQL
 * hataları gelir.
 */
export function pgErrorStatus(
  sqlState: string,
  authenticated: boolean,
): number {
  switch (sqlState) {
    case '42501': // insufficient_privilege
      // PostgREST: oturumsuz istekse 401 (giriş yapınca geçebilir), değilse 403.
      return authenticated ? HttpStatus.FORBIDDEN : HttpStatus.UNAUTHORIZED;
    case '23503': // foreign_key_violation
    case '23505': // unique_violation
      return HttpStatus.CONFLICT;
    case '25006': // read_only_sql_transaction
      return HttpStatus.METHOD_NOT_ALLOWED;
    case '42883': // undefined_function
    case '42P01': // undefined_table
      return HttpStatus.NOT_FOUND;
    case '42P17': // infinite_recursion (RLS)
      return HttpStatus.INTERNAL_SERVER_ERROR;
    case 'P0001': // raise exception
      return HttpStatus.BAD_REQUEST;
  }
  const cls = sqlState.slice(0, 2);
  switch (cls) {
    case '08': // connection_exception
    case '53': // insufficient_resources
      return HttpStatus.SERVICE_UNAVAILABLE;
    case '0L': // invalid_grantor
    case '0P': // invalid_role_specification
    case '28': // invalid_authorization_specification
      return HttpStatus.FORBIDDEN;
    case '09':
    case '25':
    case '2D':
    case '38':
    case '39':
    case '3B':
    case '40':
    case '54':
    case '55':
    case '57': // 57014: statement_timeout
    case '58':
    case 'F0':
    case 'HV':
    case 'P0':
    case 'XX':
      return HttpStatus.INTERNAL_SERVER_ERROR;
    default:
      // 22 (veri), 23 (diğer kısıtlar), 42 (sözdizimi/erişim) …
      return HttpStatus.BAD_REQUEST;
  }
}

export function isPgError(error: unknown): error is DatabaseError {
  return (
    error instanceof DatabaseError ||
    (error instanceof Error &&
      typeof (error as Partial<DatabaseError>).code === 'string' &&
      typeof (error as Partial<DatabaseError>).severity === 'string')
  );
}

/** Postgres hatasını API hatasına çevirir; gövde PostgREST'inkiyle aynı alanlar. */
export function pgErrorToApiException(
  error: DatabaseError,
  authenticated: boolean,
): ApiException {
  const sqlState = error.code ?? 'XX000';
  return ApiException.of(
    pgErrorStatus(sqlState, authenticated),
    sqlState,
    error.message,
    { details: error.detail ?? null, hint: error.hint ?? null },
  );
}
