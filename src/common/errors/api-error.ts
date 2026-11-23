import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * API'den çıkan her hatanın tek gövdesi (AGENTS.md → K-ilkesi 8).
 * SQL hataları PostgREST'in kodlarıyla (`P0001`, `42501`, `PGRST202` …) bu
 * gövdeye çevrilir (`pg-error.mapper.ts`); uygulamaların `AppException`
 * eşlemesi buna dayanır.
 */
export interface ApiErrorBody {
  code: string;
  message: string;
  details?: unknown;
  /** SQL hatalarında PostgREST gibi `null` olabilir. */
  hint?: string | null;
}

/** HTTP durumundan, hata kendi kodunu vermediğinde kullanılan kod. */
const CODE_BY_STATUS: Partial<Record<number, string>> = {
  [HttpStatus.BAD_REQUEST]: 'bad_request',
  [HttpStatus.UNAUTHORIZED]: 'unauthorized',
  [HttpStatus.FORBIDDEN]: 'forbidden',
  [HttpStatus.NOT_FOUND]: 'not_found',
  [HttpStatus.METHOD_NOT_ALLOWED]: 'method_not_allowed',
  [HttpStatus.CONFLICT]: 'conflict',
  [HttpStatus.PAYLOAD_TOO_LARGE]: 'payload_too_large',
  [HttpStatus.UNPROCESSABLE_ENTITY]: 'validation',
  [HttpStatus.TOO_MANY_REQUESTS]: 'too_many_requests',
  [HttpStatus.SERVICE_UNAVAILABLE]: 'service_unavailable',
};

export function codeForStatus(status: number): string {
  return CODE_BY_STATUS[status] ?? (status >= 500 ? 'internal' : 'bad_request');
}

/** Kodu ve gövdesi bilinçli seçilmiş bir hata fırlatmak için. */
export class ApiException extends HttpException {
  constructor(status: number, body: ApiErrorBody) {
    super(body, status);
  }

  /** Gövdedeki `code` (sunucu içi çağıranlar — ör. AuthAdminService — için). */
  get code(): string {
    return (this.getResponse() as ApiErrorBody).code;
  }

  static of(
    status: number,
    code: string,
    message: string,
    extra: Pick<ApiErrorBody, 'details' | 'hint'> = {},
  ): ApiException {
    return new ApiException(status, { code, message, ...extra });
  }
}
