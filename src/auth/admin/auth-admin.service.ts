import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { isPgError } from '../../common/errors/pg-error.mapper';
import type { PoolClient } from 'pg';
import {
  AUTH_SERVICE_ROLE,
  DbContextService,
} from '../../db/db-context.service';
import { type Brand, isBrand, passwordSetupUrl } from '../../mail/brand';
import { MailService } from '../../mail/mail.service';
import { authError } from '../auth.errors';
import { AuthRepository, type UserRow } from '../auth.repository';
import { normalizeEmail } from '../flows/auth-flows.service';
import { AuthFlowsRepository } from '../flows/auth-flows.repository';
import { newInviteToken } from '../otp/otp-codes';
import { PasswordHasher } from '../password/password-hasher';
import { passwordPolicyError } from '../password/password-policy';
import { toUserJson, type UserJson } from '../user.mapper';

export interface CreateUserInput {
  email: string;
  password: string;
  /** `true`: onaylı açılır (GoTrue `email_confirm`). */
  emailConfirm: boolean;
  userMetadata: Record<string, unknown>;
}

export interface UpdateUserInput {
  email?: string;
  password?: string;
}

const emailExists = () =>
  authError(
    HttpStatus.UNPROCESSABLE_ENTITY,
    'email_exists',
    'A user with this email address has already been registered',
  );

const userNotFound = () =>
  authError(HttpStatus.NOT_FOUND, 'user_not_found', 'User not found');

/**
 * GoTrue'nun admin uçlarının (`auth.admin.*`) karşılığı — **yalnızca sunucu
 * içi**. Hiçbir HTTP ucu yok; ex Edge Function modülleri (S09 hesaplar,
 * S10 ön kayıt aktarımı) yetkiyi SQL'e sorduktan sonra bunu çağırır.
 */
@Injectable()
export class AuthAdminService {
  private readonly logger = new Logger(AuthAdminService.name);

  constructor(
    private readonly db: DbContextService,
    private readonly repo: AuthRepository,
    private readonly flows: AuthFlowsRepository,
    private readonly hasher: PasswordHasher,
    private readonly mail: MailService,
  ) {}

  /**
   * `inviteUserByEmail`: onaysız kullanıcı + davet token'ı + davet e-postası.
   * Bağlantı **okulun markasının** şifre sayfasına:
   * `<marka kökeni>/sifre-olusturma/?token_hash=<token>&type=invite`;
   * `brand` metadata'ya da yazılır (`parentInviteOptions` gibi — profil
   * satırı davetten sonra açılır, `sync_user_brand` ilk e-postaya yetişmez).
   *
   * - Adres onaylı bir hesapta → 422 `email_exists`.
   * - Onaysız hesap → yeniden davet (yeni token, eskisi geçersiz).
   * - Markanın posta kutusu yoksa hiçbir şey yazılmadan
   *   `MailboxNotConfiguredError`. Gönderim başarısız olursa yeni açılan
   *   kullanıcı silinir ve hata fırlar (GoTrue'da hook hatası kaydı geri
   *   alıyordu): gitmeyen davet görünür olmalı.
   */
  async inviteUser(
    rawEmail: string,
    metadata: Record<string, unknown>,
    brand: Brand,
  ): Promise<UserJson> {
    if (!isBrand(brand)) throw new Error(`Bilinmeyen marka: ${String(brand)}`);
    const email = normalizeEmail(rawEmail);
    this.mail.assertMailbox(brand);
    const data = { ...metadata, brand };
    const invite = newInviteToken();

    const { user, created } = await this.db.asAuthService(async (c) => {
      const existing = await this.flows.lockUserByEmail(c, email);
      if (existing && existing.email_confirmed_at !== null) throw emailExists();
      let row: UserRow;
      if (existing) {
        await this.flows.markInvited(c, existing.id, data);
        row = existing;
      } else {
        row = await this.flows.insertUser(c, {
          email,
          encryptedPassword: '',
          userMetadata: data,
          confirmed: false,
          invited: true,
        });
      }
      await this.flows.setToken(
        c,
        row.id,
        email,
        'confirmation_token',
        invite.hash,
      );
      const fresh = (await this.repo.findUserById(c, row.id)) as UserRow;
      return {
        user: toUserJson(fresh, await this.repo.identitiesOf(c, row.id)),
        created: !existing,
      };
    });

    try {
      const name = metadata.name ?? metadata.full_name;
      await this.mail.sendAuthEmail({
        brand,
        type: 'invite',
        to: email,
        name: typeof name === 'string' ? name : undefined,
        tokenHash: invite.token,
        redirectTo: passwordSetupUrl(brand),
      });
    } catch (error) {
      this.logger.error(
        { brand, userId: user.id, err: (error as Error).message },
        'Davet e-postası gönderilemedi',
      );
      if (created) await this.deleteUser(user.id);
      throw error;
    }
    return user;
  }

  /**
   * Var olan, **davetli hâle döndürülmüş** hesaba (onaysız, adresi zaten yeni
   * adres — `reset_parent_login_email`) davet: token + e-posta. Açık bir
   * transaction'ın içinde çalışır ve bağlantının rolünü `auth_service`'e
   * geçirir; e-posta commit'ten **önce** gider, gönderim düşerse çağıranın
   * transaction'ı bütünüyle geri alınır (update-parent'ın e-posta
   * değişikliği: profil, bağlar, adres ve davet ya hep birlikte olur ya hiç).
   * Bağlantı `<marka kökeni>/sifre-olusturma/?token_hash=…&type=invite`,
   * `inviteUser`'ınkiyle aynı.
   */
  async reinviteWithin(
    c: PoolClient,
    userId: string,
    rawEmail: string,
    metadata: Record<string, unknown>,
    brand: Brand,
  ): Promise<void> {
    if (!isBrand(brand)) throw new Error(`Bilinmeyen marka: ${String(brand)}`);
    const email = normalizeEmail(rawEmail);
    this.mail.assertMailbox(brand);
    await this.db.switchRole(c, AUTH_SERVICE_ROLE);
    const user = await this.flows.lockUserById(c, userId);
    if (
      !user ||
      user.deleted_at !== null ||
      user.email_confirmed_at !== null ||
      (user.email ?? '').toLowerCase() !== email
    ) {
      // Önce adres değişmiş ve hesap onaysız olmalı; onaylı bir hesaba davet
      // GoTrue'da da `email_exists` ile reddedilir.
      throw emailExists();
    }
    const invite = newInviteToken();
    await this.flows.markInvited(c, userId, { ...metadata, brand });
    await this.flows.setToken(
      c,
      userId,
      email,
      'confirmation_token',
      invite.hash,
    );
    const name = metadata.name ?? metadata.full_name;
    await this.mail.sendAuthEmail({
      brand,
      type: 'invite',
      to: email,
      name: typeof name === 'string' ? name : undefined,
      tokenHash: invite.token,
      redirectTo: passwordSetupUrl(brand),
    });
  }

  /** `admin.createUser`: e-posta + şifreyle hesap (personel formu, S09). */
  async createUser(input: CreateUserInput): Promise<UserJson> {
    const email = normalizeEmail(input.email);
    const weak = passwordPolicyError(input.password);
    if (weak) {
      throw authError(HttpStatus.UNPROCESSABLE_ENTITY, 'weak_password', weak);
    }
    const encrypted = await this.hasher.hash(input.password);
    return this.db.asAuthService(async (c) => {
      if (await this.flows.lockUserByEmail(c, email)) throw emailExists();
      const row = await this.flows.insertUser(c, {
        email,
        encryptedPassword: encrypted,
        userMetadata: input.userMetadata,
        confirmed: input.emailConfirm,
        invited: false,
      });
      return toUserJson(row, await this.repo.identitiesOf(c, row.id));
    });
  }

  /**
   * `admin.updateUserById` (`email`, `password`): yönetici değiştirdiği için
   * yeni e-posta onaylı sayılır (GoTrue'nun admin davranışı). Şifre
   * değişince açık oturumlar kapanır.
   */
  async updateUserById(id: string, input: UpdateUserInput): Promise<UserJson> {
    const email =
      input.email !== undefined ? normalizeEmail(input.email) : undefined;
    let hash: string | undefined;
    if (input.password !== undefined) {
      const weak = passwordPolicyError(input.password);
      if (weak) {
        throw authError(HttpStatus.UNPROCESSABLE_ENTITY, 'weak_password', weak);
      }
      hash = await this.hasher.hash(input.password);
    }
    try {
      return await this.db.asAuthService(async (c) => {
        const user = await this.flows.lockUserById(c, id);
        if (!user || user.deleted_at !== null) throw userNotFound();
        if (email !== undefined && email !== user.email) {
          await this.flows.updateEmail(c, id, email);
        }
        if (hash !== undefined) {
          await this.flows.updatePassword(c, id, hash);
          await this.repo.deleteSessions(c, id, 'global', null);
        }
        const fresh = (await this.repo.findUserById(c, id)) as UserRow;
        return toUserJson(fresh, await this.repo.identitiesOf(c, id));
      });
    } catch (error) {
      // users_email_partial_key
      if (isPgError(error) && error.code === '23505') throw emailExists();
      throw error;
    }
  }

  /**
   * Yasak (`ban_duration`): `until` geleceğe kadar giriş/yenileme kapalı;
   * `null` yasağı kaldırır. Açık oturumlar kapanır.
   */
  async banUser(id: string, until: Date | null): Promise<void> {
    await this.db.asAuthService(async (c) => {
      const user = await this.flows.lockUserById(c, id);
      if (!user) throw userNotFound();
      await this.flows.setBannedUntil(c, id, until);
      if (until !== null) await this.repo.deleteSessions(c, id, 'global', null);
    });
  }

  /**
   * `admin.deleteUser` (kalıcı): satır, kimlikler, oturumlar ve — cascade
   * ile — `profiles` satırı gider. Yalnızca yeni açılmış, kaydı olmayan
   * hesaplar için (Edge Function'ların geri alma adımı); kayıtları olan bir
   * profil yabancı anahtarlarda reddedilir. Hesap silme (KVKK) bu değil:
   * `delete_own_account` mezar taşı bırakır (S09).
   */
  async deleteUser(id: string): Promise<void> {
    const deleted = await this.db.asAuthService((c) =>
      this.flows.deleteUser(c, id),
    );
    if (!deleted) throw userNotFound();
  }
}
