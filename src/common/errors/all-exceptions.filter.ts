import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { ApiErrorBody, codeForStatus } from './api-error';

/**
 * Her hatayı `{ code, message, details?, hint? }` gövdesine çevirir.
 * Beklenmeyen hatalar (HttpException olmayanlar) 500 `internal` olur ve
 * ayrıntıları yalnızca loga gider; istemciye iç hata metni sızmaz.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  constructor(private readonly adapterHost: HttpAdapterHost) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const { httpAdapter } = this.adapterHost;
    const ctx = host.switchToHttp();
    const { status, body } = toApiError(exception);

    if (status >= 500) {
      this.logger.error(
        { err: exception, code: body.code },
        'İstek sunucu hatasıyla bitti',
      );
    }

    httpAdapter.reply(ctx.getResponse(), body, status);
  }
}

export function toApiError(exception: unknown): {
  status: number;
  body: ApiErrorBody;
} {
  const parserError = bodyParserError(exception);
  if (parserError) return parserError;

  if (!(exception instanceof HttpException)) {
    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      body: { code: 'internal', message: 'Beklenmeyen bir sunucu hatası.' },
    };
  }

  const status = exception.getStatus();
  const response = exception.getResponse();
  const fallbackCode = codeForStatus(status);

  if (typeof response === 'string') {
    return { status, body: { code: fallbackCode, message: response } };
  }

  const raw = response as Record<string, unknown>;
  const body: ApiErrorBody = {
    code: typeof raw.code === 'string' ? raw.code : fallbackCode,
    message: messageOf(raw.message) ?? exception.message,
  };
  if (raw.details !== undefined) body.details = raw.details;
  // Nest'in kendi doğrulama hataları mesajı dizi olarak verir; ayrıntı olarak korunur.
  else if (Array.isArray(raw.message)) body.details = raw.message;
  if (typeof raw.hint === 'string' || raw.hint === null) body.hint = raw.hint;
  return { status, body };
}

/**
 * Express'in gövde ayrıştırıcısının (body-parser) hataları HttpException
 * değildir ama `status` ve `type` taşır: sınırı aşan gövde 413, diğerleri
 * 400. Bunlar istemci hatasıdır; 500 sayılmaz. (Bozuk JSON'un SyntaxError'ını
 * Nest buraya gelmeden BadRequestException'a çevirir → `bad_request`.)
 */
function bodyParserError(
  exception: unknown,
): { status: number; body: ApiErrorBody } | undefined {
  if (!(exception instanceof Error)) return undefined;
  const { type, status } = exception as Error & {
    type?: unknown;
    status?: unknown;
  };
  if (typeof type !== 'string' || !type.startsWith('entity.')) return undefined;
  if (typeof status !== 'number' || status < 400 || status >= 500) {
    return undefined;
  }
  if (type === 'entity.too.large') {
    return {
      status: HttpStatus.PAYLOAD_TOO_LARGE,
      body: { code: 'payload_too_large', message: 'İstek gövdesi çok büyük.' },
    };
  }
  // PostgREST bozuk JSON'a PGRST102 der.
  return {
    status: HttpStatus.BAD_REQUEST,
    body: { code: 'PGRST102', message: 'Geçersiz ya da boş JSON gövdesi.' },
  };
}

function messageOf(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(String).join('; ');
  return undefined;
}
