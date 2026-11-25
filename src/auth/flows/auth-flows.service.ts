import { randomUUID } from 'node:crypto';
import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { ApiException } from '../../common/errors/api-error';
import { APP_CONFIG } from '../../config/config.module';
import type { AppConfig } from '../../config/env.schema';
import { DbContextService } from '../../db/db-context.service';
import { brandOf } from '../../mail/email-content';
import { type AuthEmailType, MailService } from '../../mail/mail.service';
import { authError, otpExpired, rateLimited } from '../auth.errors';
import {
  AuthRepository,
  type ClientInfo,
  type UserRow,
} from '../auth.repository';
import {
  hashInviteToken,
  LEGACY_INVITE_HASH,
  newOtpCode,
  OTP_CODE_PATTERN,
  OtpHasher,
  type OtpKind,
} from '../otp/otp-codes';
import { PasswordHasher } from '../password/password-hasher';
import { passwordPolicyError } from '../password/password-policy';
import { EmailRateLimiter } from '../rate-limit/email-rate-limiter';
import { SessionOpener, type SessionResponse } from '../session/session-opener';
import { isLockedOut, toUserJson, type UserJson } from '../user.mapper';
import {
  AuthFlowsRepository,
  type TokenUserRow,
} from './auth-flows.repository';

export type VerifyRequest =
  | { type: 'recovery' | 'signup'; email: string; token: string }
  | { type: 'invite'; token_hash: string };

/**
 * Kayıtta istemcinin yazamayacağı `user_metadata` anahtarları: sunucu ya da
 * trigger yazar ve SQL bunlara güvenir (`brand` → e-postanın markası,
 * `created_by` → save_staff_profile, `created_by_manager` → yönetimin açtığı
 * hesap). GoTrue'nun kendi alanları da (`sub`, `email`, `email_verified`,
 * `phone_verified`). Uygulamanın gönderdikleri (`full_name`, `phone_number`,
 * `is_creator`, `privacy_notice_version`) serbest.
 */
const SIGNUP_PROTECTED_KEYS = new Set([
  'brand',
  'created_by',
  'created_by_manager',
  'sub',
  'email',
  'email_verified',
  'phone_verified',
]);

/** RFC'nin tamamı değil; GoTrue'nun da yaptığı gibi kaba bir biçim denetimi. */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface PendingEmail {
  type: AuthEmailType;
  user: UserRow;
  token: string;
}

/**
 * Kodlu auth akışları (S06): şifre sıfırlama kodu, açık kayıt + doğrulama
 * kodu, yeniden gönderme ve davet bağlantısıyla doğrulama. Kurallar
 * `docs/api/auth.md`.
 *
 * Hesap taraması (enumeration) kapalı:
 * - `recover` ve `resend` her zaman `{}`; `signup` var olan hesapta da aynı
 *   biçimde bir kullanıcı döner (rastgele id, e-posta gitmez).
 * - Sınırlar adres var mı bakılmadan sayılır.
 * - E-posta yanıttan sonra gönderilir (SMTP süresi yanıt süresine girmez);
 *   gönderim hatası loglanır. Hatayı yanıta koymak da hesabın varlığını
 *   söylerdi.
 * - Doğrulamada her ret (bilinmeyen adres, yanlış/süresi dolmuş/kullanılmış
 *   kod, yasaklı hesap) aynı `otp_expired`.
 */
@Injectable()
export class AuthFlowsService {
  private readonly logger = new Logger(AuthFlowsService.name);

  constructor(
    private readonly db: DbContextService,
    private readonly repo: AuthRepository,
    private readonly flows: AuthFlowsRepository,
    private readonly hasher: PasswordHasher,
    private readonly otp: OtpHasher,
    private readonly limiter: EmailRateLimiter,
    private readonly sessions: SessionOpener,
    private readonly mail: MailService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  // ── POST /auth/recover ─────────────────────────────────────────────────

  async recover(rawEmail: string, client: ClientInfo): Promise<void> {
    const email = normalizeEmail(rawEmail);
    this.checkSendLimit(client, email);

    const code = newOtpCode();
    const pending = await this.db.asAuthService(async (c) => {
      const user = await this.flows.lockUserByEmail(c, email);
      // Yasaklı/silinmiş hesaba kod gitmez; yanıt yine aynı.
      if (!user || isLockedOut(user)) return null;
      await this.issueCode(c, user, 'recovery_token', code);
      return { type: 'recovery', user, token: code } satisfies PendingEmail;
    });
    if (pending) this.sendInBackground(pending);
  }

  // ── POST /auth/signup ──────────────────────────────────────────────────

  /**
   * Yeni onaysız hesap + kayıt kodu. Var olan adreste:
   * - onaysız ve davetle açılmamış → şifre ve metadata yenilenir, yeni kod
   *   (GoTrue gibi; son kayıt kazanır, önceki kod geçersiz);
   * - onaylı, davetli ya da yasaklı → dokunulmaz, e-posta gitmez, aynı
   *   biçimde sahte bir kullanıcı döner.
   */
  async signup(
    rawEmail: string,
    password: string,
    data: Record<string, unknown>,
    client: ClientInfo,
  ): Promise<UserJson> {
    const email = normalizeEmail(rawEmail);
    const weak = passwordPolicyError(password);
    if (weak) {
      throw authError(HttpStatus.UNPROCESSABLE_ENTITY, 'weak_password', weak);
    }
    const blocked = Object.keys(data).filter((k) =>
      SIGNUP_PROTECTED_KEYS.has(k),
    );
    if (blocked.length > 0) {
      throw authError(
        HttpStatus.UNPROCESSABLE_ENTITY,
        'validation_failed',
        `Bu alanlar gönderilemez: ${blocked.join(', ')}`,
      );
    }
    this.checkSendLimit(client, email);

    // Var olan hesapta da hash'lenir: yanıt süresi farkı kalmasın.
    const encrypted = await this.hasher.hash(password);
    const code = newOtpCode();

    type Outcome =
      { fake: UserJson } | { user: UserJson; pending: PendingEmail };
    const outcome = await this.db.asAuthService(async (c): Promise<Outcome> => {
      const existing = await this.flows.lockUserByEmail(c, email);
      let user: TokenUserRow;
      if (!existing) {
        user = await this.flows.insertUser(c, {
          email,
          encryptedPassword: encrypted,
          userMetadata: data,
          confirmed: false,
          invited: false,
        });
      } else if (
        existing.email_confirmed_at === null &&
        existing.invited_at === null &&
        !isLockedOut(existing)
      ) {
        user = existing;
        await this.flows.updateUnconfirmedSignup(c, user.id, encrypted, data);
      } else {
        return { fake: fakeSignupUser(email, data) };
      }
      await this.issueCode(c, user, 'confirmation_token', code);
      const fresh = (await this.repo.findUserById(c, user.id)) as UserRow;
      return {
        user: toUserJson(fresh, await this.repo.identitiesOf(c, user.id)),
        pending: { type: 'signup', user: fresh, token: code },
      };
    });
    if ('fake' in outcome) return outcome.fake;
    this.sendInBackground(outcome.pending);
    return outcome.user;
  }

  // ── POST /auth/resend ──────────────────────────────────────────────────

  /** Yalnızca `signup`: onaysız, davetsiz hesaba yeni kod. Yanıt hep `{}`. */
  async resendSignup(rawEmail: string, client: ClientInfo): Promise<void> {
    const email = normalizeEmail(rawEmail);
    this.checkSendLimit(client, email);
    const code = newOtpCode();
    const pending = await this.db.asAuthService(async (c) => {
      const user = await this.flows.lockUserByEmail(c, email);
      if (
        !user ||
        user.email_confirmed_at !== null ||
        user.invited_at !== null ||
        isLockedOut(user)
      ) {
        return null;
      }
      await this.issueCode(c, user, 'confirmation_token', code);
      return { type: 'signup', user, token: code } satisfies PendingEmail;
    });
    if (pending) this.sendInBackground(pending);
  }

  // ── POST /auth/verify ──────────────────────────────────────────────────

  async verify(
    request: VerifyRequest,
    client: ClientInfo,
  ): Promise<SessionResponse> {
    const retryAfter = this.limiter.tryVerify(client.ip ?? 'unknown');
    if (retryAfter > 0)
      throw rateLimited('over_request_rate_limit', retryAfter);

    const result =
      request.type === 'invite'
        ? await this.verifyInvite(request.token_hash, client)
        : await this.verifyCode(request, client);
    // Ret, transaction commit edildikten sonra fırlar: yanlış deneme sayacı
    // ve silinen kod geri alınmasın.
    if (result instanceof ApiException) throw result;
    return result;
  }

  private verifyCode(
    request: { type: 'recovery' | 'signup'; email: string; token: string },
    client: ClientInfo,
  ): Promise<SessionResponse | ApiException> {
    const email = normalizeEmail(request.email);
    const code = request.token.trim();
    const kind: OtpKind =
      request.type === 'recovery' ? 'recovery_token' : 'confirmation_token';

    return this.db.asAuthService(async (c) => {
      if (!OTP_CODE_PATTERN.test(code)) return otpExpired();
      const user = await this.flows.lockUserByEmail(c, email);
      if (!user || isLockedOut(user)) return otpExpired();
      if (request.type === 'signup' && user.email_confirmed_at !== null) {
        return otpExpired();
      }

      const stored =
        kind === 'recovery_token'
          ? user.recovery_token
          : user.confirmation_token;
      const sentAt =
        kind === 'recovery_token'
          ? user.recovery_sent_at
          : user.confirmation_sent_at;
      if (!stored || !sentAt) return otpExpired();
      if (isExpired(sentAt, this.config.AUTH_OTP_EXPIRY_SEC)) {
        await this.flows.clearToken(c, user.id, kind);
        return otpExpired();
      }
      if (!this.otp.matches(kind, user.id, code, stored)) {
        const failures = await this.flows.recordFailure(c, user.id, kind);
        if (failures >= this.config.AUTH_OTP_MAX_ATTEMPTS) {
          this.logger.warn(
            { userId: user.id, kind },
            'Kod çok kez yanlış girildi; kod silindi',
          );
          await this.flows.clearToken(c, user.id, kind);
        }
        return otpExpired();
      }

      await this.flows.clearToken(c, user.id, kind);
      await this.flows.confirmEmail(c, user.id);
      const fresh = (await this.repo.findUserById(c, user.id)) as UserRow;
      return this.sessions.open(c, fresh, client, 'otp');
    });
  }

  private verifyInvite(
    tokenHash: string,
    client: ClientInfo,
  ): Promise<SessionResponse | ApiException> {
    const presented = tokenHash.trim();
    return this.db.asAuthService(async (c) => {
      if (presented === '') return otpExpired();
      const legacy = LEGACY_INVITE_HASH.test(presented) ? presented : null;
      const user = await this.flows.lockUserByInviteToken(
        c,
        hashInviteToken(presented),
        legacy,
      );
      if (!user || user.invited_at === null || isLockedOut(user)) {
        return otpExpired();
      }
      const sentAt = user.confirmation_sent_at ?? user.invited_at;
      if (isExpired(sentAt, this.config.AUTH_INVITE_EXPIRY_SEC)) {
        await this.flows.clearToken(c, user.id, 'confirmation_token');
        return otpExpired();
      }
      await this.flows.clearToken(c, user.id, 'confirmation_token');
      await this.flows.confirmEmail(c, user.id);
      const fresh = (await this.repo.findUserById(c, user.id)) as UserRow;
      return this.sessions.open(c, fresh, client, 'invite');
    });
  }

  // ── yardımcılar ────────────────────────────────────────────────────────

  private checkSendLimit(client: ClientInfo, email: string): void {
    const retryAfter = this.limiter.trySend(client.ip ?? 'unknown', email);
    if (retryAfter > 0) {
      throw rateLimited('over_email_send_rate_limit', retryAfter);
    }
  }

  private async issueCode(
    c: Parameters<AuthFlowsRepository['setToken']>[0],
    user: TokenUserRow,
    kind: OtpKind,
    code: string,
  ): Promise<void> {
    await this.flows.setToken(
      c,
      user.id,
      user.email ?? '',
      kind,
      this.otp.hash(kind, user.id, code),
    );
  }

  /**
   * Yanıt döndükten sonra gönderir (`EdgeRuntime.waitUntil`'in karşılığı).
   * Marka kullanıcının `user_metadata.brand`'inden; posta kutusu yoksa ya da
   * SMTP reddederse hata loglanır — başka markanın adresine düşülmez.
   */
  private sendInBackground(pending: PendingEmail): void {
    const meta = pending.user.raw_user_meta_data ?? {};
    const brand = brandOf(meta);
    const name = (meta.name ?? meta.full_name) as string | undefined;
    this.mail
      .sendAuthEmail({
        brand,
        type: pending.type,
        to: pending.user.email ?? '',
        name: typeof name === 'string' ? name : undefined,
        token: pending.token,
      })
      .catch((error: unknown) => {
        this.logger.error(
          {
            type: pending.type,
            brand,
            userId: pending.user.id,
            err: (error as Error).message,
          },
          'Auth e-postası gönderilemedi',
        );
      });
  }
}

export function normalizeEmail(raw: string): string {
  const email = raw.trim().toLowerCase();
  if (!EMAIL_PATTERN.test(email) || email.length > 255) {
    throw authError(
      HttpStatus.BAD_REQUEST,
      'email_address_invalid',
      'Email address is invalid',
    );
  }
  return email;
}

function isExpired(sentAt: Date, ttlSec: number): boolean {
  return sentAt.getTime() + ttlSec * 1000 < Date.now();
}

/**
 * Var olan adrese kayıt denemesinin yanıtı: gerçek yanıtla aynı alanlar
 * (bir sahte kimlik de dahil — Supabase'in boş `identities`'i hesabın var
 * olduğunu söylüyordu), rastgele id. Bu id'yle hiçbir şey yapılamaz.
 */
function fakeSignupUser(
  email: string,
  data: Record<string, unknown>,
): UserJson {
  const id = randomUUID();
  const now = new Date().toISOString();
  const metadata = {
    ...data,
    sub: id,
    email,
    email_verified: false,
    phone_verified: false,
  };
  return {
    id,
    aud: 'authenticated',
    role: 'authenticated',
    email,
    phone: '',
    confirmation_sent_at: now,
    app_metadata: { provider: 'email', providers: ['email'] },
    user_metadata: metadata,
    identities: [
      {
        identity_id: randomUUID(),
        id,
        user_id: id,
        identity_data: metadata,
        provider: 'email',
        last_sign_in_at: now,
        created_at: now,
        updated_at: now,
        email,
      },
    ],
    created_at: now,
    updated_at: now,
    is_anonymous: false,
  };
}
