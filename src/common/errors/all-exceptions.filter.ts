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
  if (typeof raw.hint === 'string') body.hint = raw.hint;
  return { status, body };
}

function messageOf(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(String).join('; ');
  return undefined;
}
