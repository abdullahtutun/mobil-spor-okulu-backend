import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import type { ClientInfo } from '../auth/auth.repository';
import { AuthService } from '../auth/auth.service';
import type { RequestAuth } from '../auth/request/jwt-verifier.service';
import { ApiException } from '../common/errors/api-error';
import { DbContextService } from '../db/db-context.service';
import { AccountsRepository, type Envelope } from './accounts.repository';
import { CallerResolver } from './caller';
import { envelopeFailure } from './function-response';

const TRY_AGAIN = 'Hesabınız şu anda silinemiyor. Lütfen tekrar deneyin.';

export interface DeletionOk {
  success: true;
  code: 'ok';
  message: string | null;
  data: null;
}

/**
 * Ex `delete-account` (yönetim reposu `supabase/functions/delete-account/`),
 * yönetim ve veli uygulaması ortak. Akış bire bir:
 *
 *   1. Çağıran token'dan (oturumu açık olmalı). Silinecek hesap gövdeden
 *      **alınmaz**.
 *   2. Kural denetimi `delete_own_account(p_validate_only := true)`: okulun
 *      son genel müdürüne şifre sorulmadan "önce başka bir genel müdür
 *      atayın" denir.
 *   3. Şifre (girişin kaba kuvvet sınırlarıyla; oturum açılmaz).
 *   4. `delete_own_account` tek transaction'da profili mezar taşına çevirir,
 *      auth kaydını boşaltır, **bütün oturumları ve refresh token'ları
 *      siler**. Fonksiyon yalnızca service_role'e açık; istemciye açık olsaydı
 *      şifre adımı atlanabilirdi.
 */
@Injectable()
export class AccountDeletionService {
  private readonly logger = new Logger(AccountDeletionService.name);

  constructor(
    private readonly db: DbContextService,
    private readonly repo: AccountsRepository,
    private readonly caller: CallerResolver,
    private readonly auth: AuthService,
  ) {}

  async deleteAccount(
    request: RequestAuth,
    body: unknown,
    client: ClientInfo,
  ): Promise<DeletionOk> {
    // 1. Çağıran.
    const user = await this.caller.resolve(request);
    if (!user) {
      throw envelopeFailure(
        'Oturumunuz doğrulanamadı. Lütfen yeniden giriş yapın.',
        'forbidden',
        HttpStatus.UNAUTHORIZED,
      );
    }

    const raw = (body as { password?: unknown } | null | undefined)?.password;
    const password = typeof raw === 'string' ? raw : '';
    if (!password) {
      throw envelopeFailure(
        'Şifrenizi girin.',
        'validation',
        HttpStatus.BAD_REQUEST,
        'password_required',
      );
    }

    // 2. Kural.
    let verdict: Envelope;
    try {
      verdict = await this.db.withRole('service_role', (c) =>
        this.repo.deleteOwnAccount(c, user.id, true),
      );
    } catch (error) {
      this.logger.error(
        { err: error },
        'delete_own_account (denetim) çağrılamadı',
      );
      throw envelopeFailure(
        TRY_AGAIN,
        'internal',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
    if (verdict.success !== true) {
      throw envelopeFailure(
        verdict.message ?? 'Hesabınız silinemedi.',
        verdict.code ?? 'internal',
      );
    }

    // 3. Şifre.
    if (!user.email) {
      throw envelopeFailure(
        'Bu hesabın e-posta adresi yok; silme talebinizi e-posta ile iletin.',
        'validation',
      );
    }
    let passwordOk: boolean;
    try {
      passwordOk = await this.auth.verifyPassword(user.email, password, client);
    } catch (error) {
      if (
        error instanceof ApiException &&
        error.getStatus() === Number(HttpStatus.TOO_MANY_REQUESTS)
      ) {
        throw envelopeFailure(
          'Çok fazla deneme yapıldı. Lütfen birkaç dakika sonra tekrar deneyin.',
          'conflict',
          HttpStatus.TOO_MANY_REQUESTS,
          'rate_limited',
        );
      }
      this.logger.error({ err: error }, 'Şifre doğrulanamadı');
      throw envelopeFailure(
        TRY_AGAIN,
        'internal',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
    if (!passwordOk) {
      throw envelopeFailure(
        'Şifre hatalı.',
        'validation',
        HttpStatus.BAD_REQUEST,
        'wrong_password',
      );
    }

    // 4. Silme.
    let outcome: Envelope | undefined;
    let failed = false;
    try {
      outcome = await this.db.withRole('service_role', (c) =>
        this.repo.deleteOwnAccount(c, user.id, false),
      );
    } catch (error) {
      failed = true;
      this.logger.error({ err: error }, 'delete_own_account başarısız');
    }
    if (failed || outcome?.success !== true) {
      if (!failed)
        this.logger.error({ outcome }, 'delete_own_account başarısız');
      throw envelopeFailure(
        outcome?.message ?? TRY_AGAIN,
        outcome?.code ?? 'internal',
        failed ? HttpStatus.INTERNAL_SERVER_ERROR : HttpStatus.BAD_REQUEST,
      );
    }

    // Kimlik loga girer (Edge Function'da da öyleydi), e-posta girmez.
    this.logger.log({ userId: user.id }, 'Hesap silindi');
    return {
      success: true,
      code: 'ok',
      message: outcome.message ?? 'Hesabınız silindi.',
      data: null,
    };
  }
}
