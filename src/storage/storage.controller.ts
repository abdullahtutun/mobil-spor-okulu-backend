import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  Req,
  Res,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import type { RequestAuth } from '../auth/request/jwt-verifier.service';
import { ReqAuth, RequestAuthGuard } from '../auth/request/request-auth.guard';
import { decodeObjectKey, isValidBucketId } from './object-key';
import { StorageError } from './storage-errors';
import { StorageExceptionFilter } from './storage-exception.filter';
import { StorageService } from './storage.service';

const ANON: RequestAuth = { role: 'anon', claims: { role: 'anon' } };

/**
 * Supabase storage-api'nin uygulamaların kullandığı uçları, aynı yollarla
 * (`/storage/v1` yerine `/storage`): `storage_client` bu köke
 * (`<api>/storage`) yönlendirilince değişmeden çalışır (S13–S15).
 * Sözleşme: `docs/api/storage.md`.
 *
 *   GET    /storage/object/public/:bucket/*        oturumsuz, yalnızca public bucket
 *   GET    /storage/object/authenticated/:bucket/* oturumlu okuma
 *   GET    /storage/object/:bucket/*               aynısı (supabase-dart download)
 *   POST   /storage/object/:bucket/*               yükleme (`x-upsert: true` → üzerine yaz)
 *   PUT    /storage/object/:bucket/*               üzerine yazarak yükleme
 *   DELETE /storage/object/:bucket                 { prefixes: [ad, …] }
 *
 * Nesne adı Express'in çözdüğü parametreden değil, ham yoldan alınır
 * (`object-key.ts`): `%2F` ve bozuk kodlama reddedilsin diye.
 */
@Controller('storage/object')
@UseFilters(StorageExceptionFilter)
export class StorageController {
  constructor(private readonly storage: StorageService) {}

  @Get('public/:bucket/*path')
  async getPublic(@Req() req: Request, @Res() res: Response): Promise<void> {
    const { bucket, key } = objectRef(req, 'public');
    await this.send(res, ANON, bucket, key, true, req);
  }

  @Get('authenticated/:bucket/*path')
  @UseGuards(RequestAuthGuard)
  async getAuthenticated(
    @Req() req: Request,
    @Res() res: Response,
    @ReqAuth() auth: RequestAuth,
  ): Promise<void> {
    const { bucket, key } = objectRef(req, 'authenticated');
    await this.send(res, auth, bucket, key, false, req);
  }

  @Get(':bucket/*path')
  @UseGuards(RequestAuthGuard)
  async get(
    @Req() req: Request,
    @Res() res: Response,
    @ReqAuth() auth: RequestAuth,
  ): Promise<void> {
    const { bucket, key } = objectRef(req, 'plain');
    await this.send(res, auth, bucket, key, false, req);
  }

  @Post(':bucket/*path')
  @HttpCode(200)
  @UseGuards(RequestAuthGuard)
  upload(@Req() req: Request, @ReqAuth() auth: RequestAuth) {
    const { bucket, key } = objectRef(req, 'plain');
    return this.storage.upload(
      auth,
      bucket,
      key,
      { body: req, headers: req.headers },
      req.headers['x-upsert'] === 'true',
    );
  }

  @Put(':bucket/*path')
  @HttpCode(200)
  @UseGuards(RequestAuthGuard)
  update(@Req() req: Request, @ReqAuth() auth: RequestAuth) {
    const { bucket, key } = objectRef(req, 'plain');
    return this.storage.upload(
      auth,
      bucket,
      key,
      { body: req, headers: req.headers },
      true,
    );
  }

  @Delete(':bucket')
  @HttpCode(200)
  @UseGuards(RequestAuthGuard)
  remove(
    @Param('bucket') bucket: string,
    @Body() body: unknown,
    @ReqAuth() auth: RequestAuth,
  ) {
    if (!isValidBucketId(bucket)) throw StorageError.noSuchBucket();
    return this.storage.remove(auth, bucket, body);
  }

  private async send(
    res: Response,
    auth: RequestAuth,
    bucket: string,
    key: string,
    publicRoute: boolean,
    req: Request,
  ): Promise<void> {
    const ifNoneMatch = req.headers['if-none-match'];
    const result = await this.storage.download(auth, bucket, key, {
      publicRoute,
      ifNoneMatch,
    });
    res.status(result.status).set(result.headers);
    if (!result.stream) {
      res.end();
      return;
    }
    const stream = result.stream;
    stream.on('error', () => res.destroy());
    res.on('close', () => stream.destroy());
    stream.pipe(res);
  }
}

const PREFIX = {
  public: /^\/storage\/object\/public\/([^/]+)\/(.+)$/,
  authenticated: /^\/storage\/object\/authenticated\/([^/]+)\/(.+)$/,
  plain: /^\/storage\/object\/([^/]+)\/(.+)$/,
} as const;

/** Ham (yüzde kodlu) yoldan bucket ve doğrulanmış nesne adı. */
function objectRef(
  req: Request,
  kind: keyof typeof PREFIX,
): { bucket: string; key: string } {
  const rawPath = req.originalUrl.split('?')[0];
  const match = PREFIX[kind].exec(rawPath);
  if (!match) throw StorageError.invalidKey(rawPath);
  const bucket = match[1];
  if (!isValidBucketId(bucket)) throw StorageError.noSuchBucket();
  return { bucket, key: decodeObjectKey(match[2]) };
}
