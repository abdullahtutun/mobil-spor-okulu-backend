import { createHash, randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import type { RequestAuth } from '../auth/request/jwt-verifier.service';
import { isPgError } from '../common/errors/pg-error.mapper';
import { APP_CONFIG } from '../config/config.module';
import type { AppConfig } from '../config/env.schema';
import { DiskStore } from './disk-store';
import { checkUploadType } from './mime';
import { parseMultipart } from './multipart';
import { isValidObjectKey } from './object-key';
import { StorageError } from './storage-errors';
import { type BucketRow, StorageRepository } from './storage.repository';

/** Controller'ın okuduğu, ayrıştırılmamış yükleme isteği. */
export interface UploadRequest {
  body: Readable;
  headers: Record<string, string | string[] | undefined>;
}

export interface UploadResult {
  Id: string;
  Key: string;
}

export interface DownloadResult {
  status: 200 | 304;
  headers: Record<string, string>;
  stream?: Readable;
}

/** Multipart gövdesindeki alanlar ve sınır satırları için pay. */
const MULTIPART_OVERHEAD = 64 * 1024;
const MAX_DELETE_NAMES = 1000;
const MAX_USER_METADATA_BYTES = 8 * 1024;
/** Açılış temizliği yalnızca bundan eski yarım kalanlara dokunur. */
export const SWEEP_AGE_MS = 10 * 60 * 1000;

/**
 * Supabase storage-api'nin uygulamaların kullandığı dört işi (K9):
 * yükleme (`x-upsert`), indirme (oturumlu / public), toplu silme.
 *
 * Her işte sıra aynı: önce `storage.objects` satırı isteğin rolüyle
 * (politikalar karar verir), sonra disk. Yükleme: gövde → doğrulama →
 * geçici dosya → satır INSERT + dosyayı yerine taşıma (aynı transaction;
 * taşıma düşerse satır geri alınır) → commit. Silme: satır DELETE + dosyayı
 * çöpe taşıma → commit → çöpü boşalt (geri alınırsa dosya yerine döner).
 */
@Injectable()
export class StorageService implements OnModuleInit {
  private readonly logger = new Logger(StorageService.name);
  readonly store: DiskStore;

  constructor(
    private readonly repository: StorageRepository,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {
    this.store = new DiskStore(config.STORAGE_ROOT);
  }

  async onModuleInit(): Promise<void> {
    await this.store.init();
    try {
      const result = await this.store.sweep(
        (bucket, key) => this.repository.objectExists(bucket, key),
        SWEEP_AGE_MS,
      );
      if (result.tmpRemoved + result.trashPurged + result.trashRestored > 0) {
        this.logger.warn(result, 'Yarım kalan dosya işlemleri temizlendi');
      }
    } catch (err) {
      // Veritabanı henüz hazır değilse açılış durmasın; sonraki açılışta.
      this.logger.warn({ err }, 'Dosya deposu temizliği yapılamadı');
    }
  }

  async upload(
    auth: RequestAuth,
    bucketId: string,
    name: string,
    request: UploadRequest,
    upsert: boolean,
  ): Promise<UploadResult> {
    const bucket = await this.bucketOrThrow(bucketId);
    const maxSize = Math.min(
      this.config.STORAGE_MAX_FILE_SIZE,
      bucket.file_size_limit ?? Number.POSITIVE_INFINITY,
    );
    const parsed = await this.parseUpload(request, maxSize);
    const mimeType = checkUploadType(
      parsed.mimeType,
      bucket.allowed_mime_types,
      parsed.file,
    );

    const size = parsed.file.length;
    const metadata = {
      eTag: `"${createHash('md5').update(parsed.file).digest('hex')}"`,
      size,
      mimetype: mimeType,
      cacheControl: parsed.cacheControl,
      lastModified: new Date().toISOString(),
      contentLength: size,
      httpStatusCode: 200,
    };
    const owner =
      auth.role === 'authenticated' && typeof auth.claims.sub === 'string'
        ? auth.claims.sub
        : null;

    const tmpPath = await this.store.writeTemp(parsed.file);
    let placed = false;
    try {
      const id = await this.repository.insertObject(
        auth,
        {
          id: randomUUID(),
          bucketId,
          name,
          owner,
          metadata,
          userMetadata: parsed.userMetadata,
          version: randomUUID(),
        },
        upsert,
        async () => {
          await this.store.place(tmpPath, bucketId, name);
          placed = true;
        },
      );
      return { Id: id, Key: `${bucketId}/${name}` };
    } catch (error) {
      if (placed) {
        // Dosya yerine kondu ama commit olmadı.
        if (upsert) {
          this.logger.error(
            { err: error, bucketId },
            'Üzerine yazılan dosyanın satırı commit olmadı',
          );
        } else {
          await this.store.remove(bucketId, name).catch((err: unknown) => {
            this.logger.error({ err, bucketId }, 'Yarım yükleme silinemedi');
          });
        }
      }
      throw this.mapError(error);
    } finally {
      if (!placed) {
        await this.store.discardTemp(tmpPath).catch((err: unknown) => {
          this.logger.warn({ err }, 'Geçici dosya silinemedi');
        });
      }
    }
  }

  async download(
    auth: RequestAuth,
    bucketId: string,
    name: string,
    options: { publicRoute: boolean; ifNoneMatch?: string },
  ): Promise<DownloadResult> {
    const bucket = await this.bucketOrThrow(bucketId);
    // Public uç yalnızca public bucket; oturumsuz istek private bucket'ta
    // "bucket yok" alır (storage-api'nin davranışı — varlık belli olmasın).
    if (options.publicRoute && !bucket.public)
      throw StorageError.noSuchBucket();
    const effective: RequestAuth = options.publicRoute
      ? { role: 'anon', claims: { role: 'anon' } }
      : auth;
    if (effective.role === 'anon' && !bucket.public) {
      throw StorageError.noSuchBucket();
    }

    const row = await this.repository
      .findObject(effective, bucketId, name)
      .catch((error: unknown) => {
        throw this.mapError(error);
      });
    if (!row) throw StorageError.noSuchKey();

    const metadata = row.metadata ?? {};
    const headers = responseHeaders(metadata);
    if (
      headers.ETag !== undefined &&
      options.ifNoneMatch !== undefined &&
      etagMatches(options.ifNoneMatch, headers.ETag)
    ) {
      return {
        status: 304,
        headers: pick(headers, ['ETag', 'Cache-Control', 'Last-Modified']),
      };
    }

    const file = await this.store.open(bucketId, name);
    if (!file) {
      this.logger.error(
        { bucketId, id: row.id },
        'Satırı olan nesnenin dosyası yok',
      );
      throw StorageError.noSuchKey();
    }
    headers['Content-Length'] = String(file.size);
    return { status: 200, headers, stream: file.stream };
  }

  async remove(
    auth: RequestAuth,
    bucketId: string,
    body: unknown,
  ): Promise<Record<string, unknown>[]> {
    const prefixes = (body as { prefixes?: unknown } | null)?.prefixes;
    if (
      !Array.isArray(prefixes) ||
      prefixes.length === 0 ||
      !prefixes.every((p) => typeof p === 'string')
    ) {
      throw StorageError.invalidRequest(
        'body/prefixes must be a non-empty array of strings',
      );
    }
    if (prefixes.length > MAX_DELETE_NAMES) {
      throw StorageError.invalidRequest(
        `Bulk object requests are limited to ${MAX_DELETE_NAMES} objects per request.`,
      );
    }
    await this.bucketOrThrow(bucketId);
    // Geçersiz bir ad hiç yazılamaz, demek ki yoktur: sorguya da girmez.
    const names = [...new Set(prefixes)].filter(isValidObjectKey);
    if (names.length === 0) return [];

    const trashed: string[] = [];
    let rows: Record<string, unknown>[];
    try {
      rows = await this.repository.deleteObjects(
        auth,
        bucketId,
        names,
        async (deleted) => {
          for (const row of deleted) {
            const entry = await this.store.moveToTrash(
              bucketId,
              String(row.name),
            );
            if (entry) trashed.push(entry);
          }
        },
      );
    } catch (error) {
      for (const entry of trashed) {
        await this.store.restore(entry).catch((err: unknown) => {
          this.logger.error(
            { err },
            'Silme geri alınırken dosya yerine konamadı',
          );
        });
      }
      throw this.mapError(error);
    }
    for (const entry of trashed) {
      await this.store.purge(entry).catch((err: unknown) => {
        this.logger.warn({ err }, 'Çöpteki dosya silinemedi (açılışta tekrar)');
      });
    }
    return rows;
  }

  private async bucketOrThrow(bucketId: string): Promise<BucketRow> {
    const bucket = await this.repository.findBucket(bucketId);
    if (!bucket) throw StorageError.noSuchBucket();
    return bucket;
  }

  private async parseUpload(
    request: UploadRequest,
    maxSize: number,
  ): Promise<{
    file: Buffer;
    mimeType: string | undefined;
    cacheControl: string;
    userMetadata: Record<string, unknown>;
  }> {
    const contentType = header(request.headers, 'content-type') ?? '';
    const multipart = /^multipart\/form-data\b/i.test(contentType);
    const limit = multipart ? maxSize + MULTIPART_OVERHEAD : maxSize;

    const declared = Number(header(request.headers, 'content-length'));
    if (Number.isFinite(declared) && declared > limit) {
      discardRest(request.body);
      throw StorageError.entityTooLarge();
    }
    const body = await readLimited(request.body, limit);

    if (multipart) {
      const parts = parseMultipart(body, contentType);
      if (parts.file.length > maxSize) throw StorageError.entityTooLarge();
      return {
        file: parts.file,
        mimeType: parts.mimeType,
        // storage_client `cacheControl` alanını saniye olarak yollar.
        cacheControl: /^\d{1,10}$/.test(parts.fields.cacheControl ?? '')
          ? `max-age=${parts.fields.cacheControl}`
          : 'no-cache',
        userMetadata: parseUserMetadata(
          parts.fields.metadata ?? parts.fields.userMetadata,
          false,
        ),
      };
    }
    const cacheControl = header(request.headers, 'cache-control');
    return {
      file: body,
      mimeType: contentType === '' ? 'application/octet-stream' : contentType,
      cacheControl:
        cacheControl && /^[A-Za-z0-9=, -]{1,100}$/.test(cacheControl)
          ? cacheControl
          : 'no-cache',
      userMetadata: parseUserMetadata(
        header(request.headers, 'x-metadata'),
        true,
      ),
    };
  }

  /** SQL hatası → storage-api'nin hatası; bilinmeyen → loglanır, 500. */
  private mapError(error: unknown): Error {
    if (error instanceof StorageError) return error;
    if (isPgError(error)) {
      if (error.code === '23505') return StorageError.duplicate();
      if (error.code === '42501') return StorageError.accessDenied();
    }
    this.logger.error({ err: error }, 'Dosya işlemi beklenmedik hatayla bitti');
    return StorageError.internal();
  }
}

function header(
  headers: UploadRequest['headers'],
  name: string,
): string | undefined {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
}

/** Gövdeyi en çok `limit` bayt okur; aşılırsa okumayı bırakır. */
function readLimited(stream: Readable, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let done = false;
    const finish = (error?: Error) => {
      if (done) return;
      done = true;
      stream.off('data', onData);
      stream.off('end', onEnd);
      stream.off('error', onError);
      if (error) {
        discardRest(stream);
        reject(error);
      } else {
        resolve(Buffer.concat(chunks, total));
      }
    };
    const onData = (chunk: Buffer) => {
      total += chunk.length;
      if (total > limit) {
        finish(StorageError.entityTooLarge());
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => finish();
    const onError = (error: Error) => finish(error);
    stream.on('data', onData);
    stream.on('end', onEnd);
    stream.on('error', onError);
  });
}

/**
 * Sınırı aşan gövdenin kalanı okunup atılır (bellekte tutulmadan): istemci
 * gönderimi bitirip 413 yanıtını okuyabilsin — bağlantı kapansaydı uygulama
 * "çok büyük" yerine ağ hatası görürdü. Atılan kısım da sınırlı; aşılırsa
 * bağlantı kesilir.
 */
const DISCARD_LIMIT = 16 * 1024 * 1024;
function discardRest(stream: Readable): void {
  let discarded = 0;
  stream.on('data', (chunk: Buffer) => {
    discarded += chunk.length;
    if (discarded > DISCARD_LIMIT) stream.destroy();
  });
  stream.resume();
}

function parseUserMetadata(
  raw: string | undefined,
  base64: boolean,
): Record<string, unknown> {
  if (raw === undefined || raw === '') return {};
  const text = base64 ? Buffer.from(raw, 'base64').toString('utf8') : raw;
  if (Buffer.byteLength(text) > MAX_USER_METADATA_BYTES) {
    throw StorageError.invalidRequest('metadata is too large');
  }
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
  } catch {
    // aşağıda
  }
  throw StorageError.invalidRequest('metadata must be a JSON object');
}

/** storage-api'nin yanıt başlıkları (renderer.ts), metadata'dan. */
function responseHeaders(
  metadata: Record<string, unknown>,
): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/octet-stream',
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
    'X-Robots-Tag': 'none',
  };
  const mimetype = metadata.mimetype;
  if (typeof mimetype === 'string' && mimetype !== '') {
    // storage-api gibi: HTML düz metin olarak verilir.
    headers['Content-Type'] =
      mimetype === 'text/html' ? 'text/plain' : mimetype;
  }
  if (
    typeof metadata.cacheControl === 'string' &&
    metadata.cacheControl !== ''
  ) {
    headers['Cache-Control'] = metadata.cacheControl;
  }
  if (
    typeof metadata.eTag === 'string' &&
    /^"?[\w-]{1,128}"?$/.test(metadata.eTag)
  ) {
    headers.ETag = metadata.eTag;
  }
  if (typeof metadata.lastModified === 'string') {
    const date = new Date(metadata.lastModified);
    if (!Number.isNaN(date.getTime()))
      headers['Last-Modified'] = date.toUTCString();
  }
  return headers;
}

function etagMatches(ifNoneMatch: string, etag: string): boolean {
  if (ifNoneMatch.trim() === '*') return true;
  const strip = (value: string) => value.trim().replace(/^W\//, '');
  return ifNoneMatch
    .split(',')
    .some((candidate) => strip(candidate) === strip(etag));
}

function pick(
  headers: Record<string, string>,
  keys: string[],
): Record<string, string> {
  return Object.fromEntries(
    keys
      .filter((key) => headers[key] !== undefined)
      .map((key) => [key, headers[key]]),
  );
}
