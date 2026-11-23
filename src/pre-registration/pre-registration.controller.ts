import {
  Body,
  Controller,
  HttpCode,
  Post,
  Req,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import {
  appFailure,
  type AppOk,
  FunctionsExceptionFilter,
} from '../accounts/function-response';
import { AuthorizationHeaderGuard } from '../accounts/functions.controller';
import type { RequestAuth } from '../auth/request/jwt-verifier.service';
import { ReqAuth, RequestAuthGuard } from '../auth/request/request-auth.guard';
import { bodyTooLarge } from '../common/http/raw-text-body';
import { IpHasher } from '../common/http/ip-hash';
import { PreRegistrationConversionService } from './pre-registration-conversion.service';
import { PublicPreRegistrationService } from './public-pre-registration.service';

/**
 * Ön kaydın kesin kayda aktarılması: ex `convert-pre-registration`,
 * `bulk-convert-pre-registrations` (Supabase'te `verify_jwt: true`):
 * başlık zorunlu, token `RequestAuthGuard`'dan, çağıran `CallerResolver`'dan
 * — S09'un hesap fonksiyonlarıyla aynı kapı. Sözleşme `docs/api/functions.md`.
 */
@Controller('functions')
@UseGuards(AuthorizationHeaderGuard, RequestAuthGuard)
@UseFilters(FunctionsExceptionFilter)
export class PreRegistrationConversionController {
  constructor(private readonly conversion: PreRegistrationConversionService) {}

  @Post('convert-pre-registration')
  @HttpCode(200)
  convert(@ReqAuth() auth: RequestAuth, @Body() body: unknown): Promise<AppOk> {
    return this.conversion.convertSingle(auth, body);
  }

  @Post('bulk-convert-pre-registrations')
  @HttpCode(200)
  convertBulk(
    @ReqAuth() auth: RequestAuth,
    @Body() body: unknown,
  ): Promise<AppOk> {
    return this.conversion.convertBulk(auth, body);
  }
}

/**
 * Online ön kayıt formu: ex `submit-pre-registration`. Oturumsuz — Supabase'te
 * `verify_jwt: true` idi ama istemci herkese açık anon anahtarını taşıyordu;
 * burada başlık istenmez, gelirse de bakılmaz (yazım service_role ile ve
 * yalnızca token'ın okuluna). Gövde metin olarak gelir (`RAW_BODY_ROUTES`).
 */
@Controller('functions')
@UseFilters(FunctionsExceptionFilter)
export class PublicPreRegistrationController {
  constructor(
    private readonly service: PublicPreRegistrationService,
    private readonly ip: IpHasher,
  ) {}

  @Post('submit-pre-registration')
  @HttpCode(200)
  submit(@Req() req: Request): Promise<AppOk> {
    if (bodyTooLarge(req)) {
      throw appFailure('İstek çok büyük.', 'validation', 413);
    }
    const ip = this.ip.clientIp(req);
    return this.service.submit(req.body, ip ? this.ip.hash(ip) : null);
  }
}
