import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Response } from 'express';
import { toApiError } from '../common/errors/all-exceptions.filter';
import { ApiException } from '../common/errors/api-error';
import { isPgError } from '../common/errors/pg-error.mapper';

/**
 * Eski Edge Function'ların yanıt gövdeleri. Uygulamalar bunları
 * `RpcEnvelope.fromEdge` / `fromFunctionException` ile okuyor (yönetim
 * `lib/core/data/remote/rpc_envelope.dart`), bu yüzden şekil bire bir:
 *
 * - personel ve veli fonksiyonları: başarı 200 `{success: true, message}`,
 *   hata **400** `{success: false, error}` (`code` yok; istemci "yetkiniz yok"
 *   metninden `forbidden` çıkarıyor);
 * - `delete-account`: `app_ok`/`app_err` zarfı + `reason`
 *   (`{success, code, reason, message, data: null, error}`).
 */
export class FunctionFailure extends Error {
  constructor(
    readonly httpStatus: number,
    readonly body: Record<string, unknown>,
  ) {
    super(typeof body.error === 'string' ? body.error : 'function failure');
    this.name = 'FunctionFailure';
  }
}

/** Personel/veli fonksiyonlarının hata yolu: HTTP 400 `{success:false, error}`. */
export function edgeFailure(message: string): FunctionFailure {
  return new FunctionFailure(HttpStatus.BAD_REQUEST, {
    success: false,
    error: message,
  });
}

export interface EdgeOk {
  success: true;
  message: string;
}

export const edgeOk = (message: string): EdgeOk => ({ success: true, message });

/** `delete-account`'ın `err(...)`'u. */
export function envelopeFailure(
  message: string,
  code = 'internal',
  status: number = HttpStatus.BAD_REQUEST,
  reason: string | null = null,
): FunctionFailure {
  return new FunctionFailure(status, {
    success: false,
    code,
    reason,
    message,
    data: null,
    error: message,
  });
}

/**
 * Edge Function'ın `error.message`'ı: supabase-js'in hata nesnelerinin
 * metni. SQL hatasında Postgres'in metni (PostgREST de onu verirdi), auth
 * hatasında GoTrue uyumlu metin; beklenmeyen hata metni dışarı çıkmaz.
 */
export function messageOf(error: unknown): string {
  if (error instanceof ApiException) return error.message;
  if (isPgError(error)) return error.message;
  if (error instanceof FunctionFailure) {
    const { error: e, message: m } = error.body;
    return typeof e === 'string' ? e : typeof m === 'string' ? m : '';
  }
  if (error instanceof Error && error.name === 'MailboxNotConfiguredError') {
    return error.message;
  }
  return 'Beklenmeyen bir sunucu hatası.';
}

/**
 * `/functions/*` uçlarının hata filtresi.
 *
 * - `FunctionFailure` → kendi durumu ve gövdesi.
 * - Token reddi (`RequestAuthGuard`: 401 `PGRST301`/`PGRST303`) → 401
 *   `{code, message}`. Supabase'te bu fonksiyonlar `verify_jwt: true` ile
 *   dağıtılmıştı; geçersiz/süresi geçmiş token'ı fonksiyon değil ağ geçidi
 *   401'le reddediyordu. Yönetim uygulamasının `SessionRetryClient`'ı bunu
 *   gövdedeki `PGRST30x`/`jwt` metninden tanıyıp token yeniliyor.
 * - Diğer HTTP hataları (429 hız sınırı, gövde ayrıştırma) → kendi durumu.
 * - Beklenmeyen hata → 500, iç metin loga.
 */
@Catch()
export class FunctionsExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(FunctionsExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    if (exception instanceof FunctionFailure) {
      res.status(exception.httpStatus).json(exception.body);
      return;
    }
    const { status, body } = toApiError(exception);
    if (status >= 500) {
      this.logger.error({ err: exception }, 'Fonksiyon sunucu hatasıyla bitti');
    }
    res.status(status).json(body);
  }
}

/**
 * Ön kayıt ve site fonksiyonlarının (S10) zarfı: `app_ok` / `app_err`'in
 * Edge Function karşılığı. Başarı `{success: true, code: 'ok', message,
 * data}`; hata `{success: false, code, message, data: null, error}` (`error`
 * app_err'in geriye uyumluluk kopyası; `reason` yok — delete-account'tan
 * farkı bu).
 */
export interface AppOk {
  success: true;
  code: 'ok';
  message: string | null;
  data: unknown;
}

export const appOk = (message: string | null, data: unknown = null): AppOk => ({
  success: true,
  code: 'ok',
  message,
  data,
});

export function appFailure(
  message: string,
  code = 'internal',
  status: number = HttpStatus.BAD_REQUEST,
): FunctionFailure {
  return new FunctionFailure(status, {
    success: false,
    code,
    message,
    data: null,
    error: message,
  });
}
