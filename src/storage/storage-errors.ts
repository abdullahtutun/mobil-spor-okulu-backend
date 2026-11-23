/**
 * Storage hataları Supabase storage-api'nin gövdesiyle döner, çünkü
 * uygulamalar `storage_client` paketiyle okuyor (`StorageException.fromJson`:
 * `message`, `error`, `statusCode` — gövdedeki `statusCode` HTTP durumundan
 * önce gelir):
 *
 *   { "statusCode": "404", "code": "NoSuchKey", "error": "not_found",
 *     "message": "Object not found" }
 *
 * HTTP durumu da storage-api'deki gibi: 500 dışındaki her hata **400**
 * (`userStatusCode`); gerçek sınıf gövdedeki `statusCode`'da. Yönetim
 * uygulamasının `SessionRetryClient`'ı da storage reddini 400/403 olarak
 * bekliyor. Metinler storage-api'ninkiyle aynı (İngilizce) — uygulamalar
 * bugün bu metinleri görüyor.
 *
 * İstisna: token hataları (RequestAuthGuard) 401 ve PostgREST kodu
 * (`PGRST301`/`PGRST303`) ile kalır; uygulamalar bu kodu görünce token
 * yeniler (bkz. `storage-exception.filter.ts`).
 */
export class StorageError extends Error {
  constructor(
    /** Gövdedeki sınıf: '400', '403', '404', '409', '413', '415', '500'. */
    readonly statusCode: string,
    readonly code: string,
    readonly error: string,
    message: string,
  ) {
    super(message);
    this.name = 'StorageError';
  }

  get httpStatus(): number {
    return this.statusCode === '500' ? 500 : 400;
  }

  toBody(): Record<string, string> {
    return {
      statusCode: this.statusCode,
      code: this.code,
      error: this.error,
      message: this.message,
    };
  }

  static noSuchKey(): StorageError {
    return new StorageError(
      '404',
      'NoSuchKey',
      'not_found',
      'Object not found',
    );
  }

  static noSuchBucket(): StorageError {
    return new StorageError(
      '404',
      'NoSuchBucket',
      'Bucket not found',
      'Bucket not found',
    );
  }

  static duplicate(): StorageError {
    return new StorageError(
      '409',
      'KeyAlreadyExists',
      'Duplicate',
      'The resource already exists',
    );
  }

  static accessDenied(): StorageError {
    return new StorageError(
      '403',
      'AccessDenied',
      'Unauthorized',
      'new row violates row-level security policy',
    );
  }

  static entityTooLarge(): StorageError {
    return new StorageError(
      '413',
      'EntityTooLarge',
      'Payload too large',
      'The object exceeded the maximum allowed size',
    );
  }

  static invalidMimeType(mimeType: string): StorageError {
    return new StorageError(
      '415',
      'InvalidMimeType',
      'invalid_mime_type',
      `mime type ${mimeType} is not supported`,
    );
  }

  /** Bildirilen tür izinli ama baytlar o türde değil (Supabase'te yok). */
  static contentMismatch(mimeType: string): StorageError {
    return new StorageError(
      '415',
      'InvalidMimeType',
      'invalid_mime_type',
      `file content does not match mime type ${mimeType}`,
    );
  }

  static invalidKey(key: string): StorageError {
    // Anahtarın kendisi loglara/yanıta sınırlı uzunlukta girer.
    return new StorageError(
      '400',
      'InvalidKey',
      'InvalidKey',
      `Invalid key: ${key.slice(0, 200)}`,
    );
  }

  static invalidRequest(message: string): StorageError {
    return new StorageError('400', 'InvalidRequest', 'InvalidRequest', message);
  }

  static internal(): StorageError {
    return new StorageError(
      '500',
      'InternalError',
      'internal',
      'Internal Server Error',
    );
  }
}
