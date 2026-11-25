import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { ApiException } from '../common/errors/api-error';
import { APP_CONFIG } from '../config/config.module';
import type { AppConfig } from '../config/env.schema';
import { DbContextService } from '../db/db-context.service';
import {
  authError,
  invalidCredentials,
  rateLimited,
  refreshTokenNotFound,
} from './auth.errors';
import {
  AuthRepository,
  type ClientInfo,
  type UserRow,
} from './auth.repository';
import { PasswordHasher } from './password/password-hasher';
import { passwordPolicyError } from './password/password-policy';
import { LoginRateLimiter } from './rate-limit/login-rate-limiter';
import { SessionOpener, type SessionResponse } from './session/session-opener';
import { hashRefreshToken, newRefreshToken } from './token/tokens';
import { isLockedOut, toUserJson, type UserJson } from './user.mapper';

export type { SessionResponse } from './session/session-opener';

export type LogoutScope = 'global' | 'local' | 'others';

/** Access token'dan gelen, auth uçlarının ihtiyaç duyduğu kimlik. */
export interface TokenIdentity {
  userId: string;
  sessionId: string | null;
}

/**
 * Kullanıcının kendi değiştiremeyeceği `user_metadata` anahtarları. Supabase
 * bunları da istemciye açıktı; bizde sunucu/trigger yazar ve SQL bunlara
 * güvenir: `brand` (sync_user_brand — e-postanın markası),
 * `created_by` (save_staff_profile yeni hesabın sahibini buradan doğrular),
 * `is_creator` / `full_name` / `phone_number` / `privacy_notice_version`
 * (handle_new_user), `email_verified`/`sub`/`email` (GoTrue'nun kendi
 * alanları). Uygulamalar `updateUser(data:)` çağırmıyor (yalnızca şifre).
 */
const PROTECTED_METADATA_KEYS = new Set([
  'brand',
  'created_by',
  'is_creator',
  'full_name',
  'phone_number',
  'privacy_notice_version',
  'email_verified',
  'phone_verified',
  'sub',
  'email',
]);

/**
 * GoTrue'nun parola girişi, refresh token rotasyonu, çıkış ve `/user` uçları
 * (S05). Kurallar `docs/api/auth.md`'de.
 */
@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly db: DbContextService,
    private readonly repo: AuthRepository,
    private readonly hasher: PasswordHasher,
    private readonly limiter: LoginRateLimiter,
    private readonly sessions: SessionOpener,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  // ── grant_type=password ────────────────────────────────────────────────

  async signInWithPassword(
    rawEmail: string,
    password: string,
    client: ClientInfo,
  ): Promise<SessionResponse> {
    const email = rawEmail.trim().toLowerCase();
    const ipKey = client.ip ?? 'unknown';

    const retryAfter = this.limiter.tryAttempt(ipKey, email);
    if (retryAfter > 0)
      throw rateLimited('over_request_rate_limit', retryAfter);

    const user = await this.db.asAuthService((c) =>
      this.repo.findUserByEmail(c, email),
    );
    // Bilinmeyen e-postada da aynı bcrypt süresi harcanır (hesap taraması).
    const passwordOk = user
      ? await this.hasher.verify(password, user.encrypted_password)
      : (await this.hasher.burn(password), false);

    // Yasaklı / silinmiş hesap, doğru şifreyle bile, yanlış şifreyle aynı.
    if (!user || !passwordOk || isLockedOut(user)) {
      this.limiter.recordFailure(ipKey, email);
      await this.logFailedSignIn(user?.id ?? null, client);
      throw invalidCredentials();
    }
    this.limiter.recordSuccess(ipKey, email);

    // GoTrue sırası: şifre doğruysa onay sorulur (onaysız olduğu ancak doğru
    // şifreyle öğrenilir).
    if (user.email_confirmed_at === null) {
      throw authError(
        HttpStatus.BAD_REQUEST,
        'email_not_confirmed',
        'Email not confirmed',
      );
    }

    return this.db.asAuthService((c) =>
      this.sessions.open(c, user, client, 'password'),
    );
  }

  /**
   * Başarısız parola girişinin 5651 kaydı. Bilinmeyen e-postada kullanıcı
   * null (e-posta yazılmaz). Kayıt düşerse giriş yanıtı değişmez: yanlış
   * şifreye "sunucu hatası" denmez, yalnızca loglanır.
   */
  private async logFailedSignIn(
    userId: string | null,
    client: ClientInfo,
  ): Promise<void> {
    try {
      await this.db.asAuthService((c) =>
        this.repo.insertAccessLog(c, {
          event: 'password_failed',
          userId,
          sessionId: null,
          client,
        }),
      );
    } catch (error) {
      this.logger.error(
        { err: error },
        'Başarısız giriş erişim kaydına yazılamadı',
      );
    }
  }

  /**
   * Oturum açmadan şifre denetimi (hesap silme, S09). Girişin kaba kuvvet
   * sınırları aynen uygulanır ve aynı sayaçları kullanır: silme ekranı
   * girişin yanında ikinci bir tahmin kapısı olmasın. Sınır aşılırsa 429
   * `over_request_rate_limit` fırlar. Edge Function bunu GoTrue'nun giriş
   * ucuyla yapıyordu (bir oturum açıp kapatarak); burada oturum hiç açılmaz.
   */
  async verifyPassword(
    rawEmail: string,
    password: string,
    client: ClientInfo,
  ): Promise<boolean> {
    const email = rawEmail.trim().toLowerCase();
    const ipKey = client.ip ?? 'unknown';
    const retryAfter = this.limiter.tryAttempt(ipKey, email);
    if (retryAfter > 0)
      throw rateLimited('over_request_rate_limit', retryAfter);

    const user = await this.db.asAuthService((c) =>
      this.repo.findUserByEmail(c, email),
    );
    const ok = user
      ? await this.hasher.verify(password, user.encrypted_password)
      : (await this.hasher.burn(password), false);
    if (!user || !ok || isLockedOut(user)) {
      this.limiter.recordFailure(ipKey, email);
      return false;
    }
    this.limiter.recordSuccess(ipKey, email);
    return true;
  }

  // ── grant_type=refresh_token ──────────────────────────────────────────

  /**
   * Rotasyon (GoTrue'nun kuralları, hash'li token'larla):
   *
   * - Geçerli token → iptal edilir, yerine yenisi (parent = eskinin hash'i).
   * - İptal edilmiş token, ama **oturumun geçerli token'ının ebeveyni** →
   *   kabul: yanıtı ağda kaybolan bir yenileme (salon Wi-Fi'ı, uçak modu).
   *   GoTrue burada geçerli token'ı geri verir; biz token'ı hash'li
   *   tuttuğumuz için geri veremeyiz, onu da döndürüp yenisini veririz.
   *   Süre sınırı yok (GoTrue gibi): cihaz saatlerce çevrimdışı kalabilir.
   * - İptal edilmiş başka bir token, iptalinden `AUTH_REFRESH_REUSE_INTERVAL_SEC`
   *   içinde → kabul, aynı şekilde (eşzamanlı yenilemeler).
   * - Diğer her yeniden kullanım → çalınma şüphesi: oturum silinir (bütün
   *   token'ları ile), `refresh_token_already_used`.
   *
   * Aynı oturumdaki eşzamanlı yenilemeler oturum satırının kilidinde sıraya
   * girer; ikincisi birincinin sonucunu görür.
   */
  async refresh(
    refreshToken: string,
    client: ClientInfo,
  ): Promise<SessionResponse> {
    const hash = hashRefreshToken(refreshToken);
    const result = await this.db.asAuthService(async (c) => {
      const found = await this.repo.findRefreshToken(c, hash);
      if (!found || found.session_id === null) return refreshTokenNotFound();

      const session = await this.repo.lockSession(c, found.session_id);
      if (!session) return refreshTokenNotFound();
      // Kilitten sonra yeniden oku: bekleyen istek arada dönmüş olabilir.
      const token = await this.repo.findRefreshToken(c, hash);
      if (!token) return refreshTokenNotFound();

      if (session.not_after !== null && session.not_after <= new Date()) {
        await this.repo.deleteSession(c, session.id);
        return refreshTokenNotFound();
      }

      const user = await this.repo.findUserById(c, session.user_id);
      if (!user || user.deleted_at !== null) {
        await this.repo.deleteSession(c, session.id);
        return refreshTokenNotFound();
      }
      if (isLockedOut(user)) {
        return authError(HttpStatus.FORBIDDEN, 'user_banned', 'User is banned');
      }

      let parentHash = token.token;
      if (token.revoked) {
        const active = await this.repo.activeRefreshToken(c, session.id);
        const isParentOfActive =
          active !== null && active.parent === token.token;
        const withinReuse =
          Date.now() - token.updated_at.getTime() <=
          this.config.AUTH_REFRESH_REUSE_INTERVAL_SEC * 1000;
        if (!active || (!isParentOfActive && !withinReuse)) {
          this.logger.warn(
            { sessionId: session.id, userId: user.id },
            'İptal edilmiş refresh token yeniden kullanıldı; oturum kapatıldı',
          );
          await this.repo.deleteSession(c, session.id);
          return authError(
            HttpStatus.BAD_REQUEST,
            'refresh_token_already_used',
            'Invalid Refresh Token: Already Used',
          );
        }
        await this.repo.revokeRefreshToken(c, active.id);
        parentHash = active.token;
      } else {
        await this.repo.revokeRefreshToken(c, token.id);
      }

      const next = newRefreshToken();
      await this.repo.insertRefreshToken(c, {
        hash: next.hash,
        userId: user.id,
        sessionId: session.id,
        parent: parentHash,
      });
      await this.repo.touchSession(c, session.id, client);
      await this.repo.insertAccessLog(c, {
        event: 'refresh',
        userId: user.id,
        sessionId: session.id,
        client,
      });
      return this.sessions.respond(c, user, session, next.token);
    });
    // Reddi transaction'ın içinden fırlatmak yapılanı (oturumun silinmesini)
    // geri alırdı; hata dönüş değeri olarak çıkar, commit'ten sonra fırlar.
    if (result instanceof ApiException) throw result;
    return result;
  }

  // ── /logout ───────────────────────────────────────────────────────────

  async logout(identity: TokenIdentity, scope: LogoutScope): Promise<void> {
    await this.db.asAuthService((c) =>
      this.repo.deleteSessions(c, identity.userId, scope, identity.sessionId),
    );
  }

  // ── /user ─────────────────────────────────────────────────────────────

  async getUser(identity: TokenIdentity): Promise<UserJson> {
    return this.db.asAuthService(async (c) => {
      const user = await this.currentUser(c, identity);
      return toUserJson(user, await this.repo.identitiesOf(c, user.id));
    });
  }

  async updateUser(
    identity: TokenIdentity,
    changes: { password?: string; data?: Record<string, unknown> },
  ): Promise<UserJson> {
    if (changes.data) {
      const blocked = Object.keys(changes.data).filter((k) =>
        PROTECTED_METADATA_KEYS.has(k),
      );
      if (blocked.length > 0) {
        throw authError(
          HttpStatus.UNPROCESSABLE_ENTITY,
          'validation_failed',
          `Bu alanlar değiştirilemez: ${blocked.join(', ')}`,
        );
      }
    }
    if (changes.password !== undefined) {
      const weak = passwordPolicyError(changes.password);
      if (weak) {
        throw authError(HttpStatus.UNPROCESSABLE_ENTITY, 'weak_password', weak);
      }
    }

    const current = await this.db.asAuthService((c) =>
      this.currentUser(c, identity),
    );
    let newHash: string | undefined;
    if (changes.password !== undefined) {
      if (
        await this.hasher.verify(changes.password, current.encrypted_password)
      ) {
        throw authError(
          HttpStatus.UNPROCESSABLE_ENTITY,
          'same_password',
          'New password should be different from the old password.',
        );
      }
      newHash = await this.hasher.hash(changes.password);
    }

    return this.db.asAuthService(async (c) => {
      const user = await this.currentUser(c, identity);
      if (newHash !== undefined) {
        await this.repo.updatePassword(c, user.id, newHash);
        // Şifre değişince bu cihaz dışındaki oturumlar kapanır (GoTrue gibi):
        // şifreyi bilen eski bir cihaz içeride kalmasın.
        await this.repo.deleteSessions(
          c,
          user.id,
          'others',
          identity.sessionId,
        );
      }
      if (changes.data) {
        await this.repo.mergeUserMetadata(c, user.id, changes.data);
      }
      const updated = (await this.repo.findUserById(c, user.id)) as UserRow;
      return toUserJson(updated, await this.repo.identitiesOf(c, user.id));
    });
  }

  /**
   * Token'ın oturumu hâlâ açık mı ve kullanıcı duruyor mu (GoTrue'nun
   * `requireAuthentication` + oturum kontrolü). Çıkıştan ya da hesap
   * silindikten sonra `/user` `session_not_found` der.
   */
  private async currentUser(
    c: PoolClient,
    identity: TokenIdentity,
  ): Promise<UserRow> {
    if (identity.sessionId === null) {
      throw authError(
        HttpStatus.FORBIDDEN,
        'session_not_found',
        'Session from session_id claim in JWT does not exist',
      );
    }
    const session = await this.repo.findSession(
      c,
      identity.sessionId,
      identity.userId,
    );
    if (!session) {
      throw authError(
        HttpStatus.FORBIDDEN,
        'session_not_found',
        'Session from session_id claim in JWT does not exist',
      );
    }
    const user = await this.repo.findUserById(c, identity.userId);
    if (!user || user.deleted_at !== null) {
      throw authError(
        HttpStatus.FORBIDDEN,
        'user_not_found',
        'User from sub claim in JWT does not exist',
      );
    }
    if (isLockedOut(user)) {
      throw authError(HttpStatus.FORBIDDEN, 'user_banned', 'User is banned');
    }
    return user;
  }
}
