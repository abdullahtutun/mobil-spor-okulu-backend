import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  Logger,
} from '@nestjs/common';
import type { Response } from 'express';
import { toApiError } from '../common/errors/all-exceptions.filter';
import { StorageError } from './storage-errors';

/**
 * `/storage/*` uçlarının hata gövdesi storage-api'ninki (bkz.
 * `storage-errors.ts`), API'nin genel `{code, message}`'ı değil: uygulamalar
 * `storage_client`'ın `StorageException`'ını okuyor.
 *
 *   - StorageError → kendi gövdesi, HTTP 400 (500 ise 500).
 *   - Token hatası (RequestAuthGuard, 401 PGRST301/PGRST303) → HTTP 401 ve
 *     gövdede `code: PGRST30x`: yönetim uygulamasının SessionRetryClient'ı
 *     bunu görünce token'ı yenileyip tekrar dener.
 *   - Diğer HTTP hataları (429 hız sınırı, gövde ayrıştırma) → kendi durumu.
 */
@Catch()
export class StorageExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(StorageExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    if (res.headersSent) {
      // Akış ortasında hata: gövde yazılamaz, bağlantı kapanır.
      this.logger.error({ err: exception }, 'Dosya akışı yarıda kesildi');
      res.destroy();
      return;
    }

    if (exception instanceof StorageError) {
      res.status(exception.httpStatus).json(exception.toBody());
      return;
    }

    const { status, body } = toApiError(exception);
    if (status >= 500) {
      this.logger.error(
        { err: exception },
        'Dosya isteği sunucu hatasıyla bitti',
      );
      res.status(500).json(StorageError.internal().toBody());
      return;
    }
    res.status(status).json({
      statusCode: String(status),
      code: body.code,
      error: status === 401 ? 'InvalidJWT' : body.code,
      message: body.message,
    });
  }
}
