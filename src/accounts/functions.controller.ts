import {
  All,
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Injectable,
  Post,
  Req,
  UseFilters,
  UseGuards,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import type { Request } from 'express';
import { clientInfo } from '../auth/auth.http';
import { type RequestAuth } from '../auth/request/jwt-verifier.service';
import { ReqAuth, RequestAuthGuard } from '../auth/request/request-auth.guard';
import { ApiException } from '../common/errors/api-error';
import {
  AccountDeletionService,
  type DeletionOk,
} from './account-deletion.service';
import { parentBody, parseFunctionBody, staffBody } from './accounts.schemas';
import {
  envelopeFailure,
  type EdgeOk,
  FunctionsExceptionFilter,
} from './function-response';
import { ParentAccountsService } from './parent-accounts.service';
import { StaffAccountsService } from './staff-accounts.service';

/**
 * Supabase'te bu fonksiyonlar `verify_jwt: true` ile dağıtılmıştı: ağ geçidi
 * `Authorization` başlığı olmayan isteği fonksiyona hiç ulaştırmıyordu
 * (401). Token'ın kendisini `RequestAuthGuard` doğrular (geçersiz/süresi
 * geçmiş → 401 `PGRST301`/`PGRST303`); anon anahtarı geçer ve fonksiyonun
 * kendi "oturum doğrulanamadı" yanıtını alır — Supabase'teki gibi.
 */
@Injectable()
export class AuthorizationHeaderGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const header = context.switchToHttp().getRequest<Request>()
      .headers.authorization;
    if (typeof header !== 'string' || header.trim() === '') {
      throw ApiException.of(
        HttpStatus.UNAUTHORIZED,
        'UNAUTHORIZED_NO_AUTH_HEADER',
        'Missing authorization header',
      );
    }
    return true;
  }
}

/**
 * Eski Edge Function'lar, aynı adlarla: `POST /functions/<ad>`
 * (Supabase'te `/functions/v1/<ad>`). Gövdeler, yanıtlar, HTTP kodları ve
 * `reason` değerleri bugünküyle aynı; sözleşme `docs/api/functions.md`.
 * Ön kayıt aktarımı `src/pre-registration/`, site formu `src/site-lead/` (S10).
 */
@Controller('functions')
@UseGuards(AuthorizationHeaderGuard, RequestAuthGuard)
@UseFilters(FunctionsExceptionFilter)
export class FunctionsController {
  constructor(
    private readonly staff: StaffAccountsService,
    private readonly parents: ParentAccountsService,
    private readonly deletion: AccountDeletionService,
  ) {}

  @Post('create-user')
  @HttpCode(200)
  createUser(
    @ReqAuth() auth: RequestAuth,
    @Body() body: unknown,
  ): Promise<EdgeOk> {
    return this.staff.createUser(auth, parseFunctionBody(staffBody, body));
  }

  @Post('update-user')
  @HttpCode(200)
  updateUser(
    @ReqAuth() auth: RequestAuth,
    @Body() body: unknown,
  ): Promise<EdgeOk> {
    return this.staff.updateUser(auth, parseFunctionBody(staffBody, body));
  }

  @Post('create-parent')
  @HttpCode(200)
  createParent(
    @ReqAuth() auth: RequestAuth,
    @Body() body: unknown,
  ): Promise<EdgeOk> {
    return this.parents.createParent(auth, parseFunctionBody(parentBody, body));
  }

  @Post('update-parent')
  @HttpCode(200)
  updateParent(
    @ReqAuth() auth: RequestAuth,
    @Body() body: unknown,
  ): Promise<EdgeOk> {
    return this.parents.updateParent(auth, parseFunctionBody(parentBody, body));
  }

  @Post('delete-account')
  @HttpCode(200)
  deleteAccount(
    @ReqAuth() auth: RequestAuth,
    @Body() body: unknown,
    @Req() req: Request,
  ): Promise<DeletionOk> {
    return this.deletion.deleteAccount(auth, body, clientInfo(req));
  }

  /** Edge Function: POST dışı her yöntem 405 (OPTIONS'ı CORS karşılar). */
  @All('delete-account')
  deleteAccountMethod(): never {
    throw envelopeFailure(
      'Desteklenmeyen istek.',
      'validation',
      HttpStatus.METHOD_NOT_ALLOWED,
    );
  }
}
