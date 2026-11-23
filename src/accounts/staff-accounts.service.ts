import { Injectable, Logger } from '@nestjs/common';
import { AuthAdminService } from '../auth/admin/auth-admin.service';
import type { RequestAuth } from '../auth/request/jwt-verifier.service';
import { DbContextService } from '../db/db-context.service';
import {
  AccountsRepository,
  type Envelope,
  type StaffProfileParams,
} from './accounts.repository';
import type { StaffBody } from './accounts.schemas';
import { CallerResolver } from './caller';
import {
  edgeFailure,
  edgeOk,
  type EdgeOk,
  messageOf,
} from './function-response';

const NO_SESSION = 'Oturum doğrulanamadı. Lütfen tekrar giriş yapın.';

/**
 * Ex `create-user` / `update-user` (yönetim reposu
 * `supabase/functions/{create-user,update-user}/index.ts`): personel hesabı
 * açma ve düzenleme — kullanıcı formu ve eğitmen formu.
 *
 * Yetkinin hepsi `save_staff_profile`'da (hiyerarşi, sahip olmadığın yetki,
 * şube kapsamı, kendi hesabın): RPC çağıranın rolüyle çalışır. Burada yalnızca
 * Postgres'in yapamadığı iş var — auth kullanıcısı. Sıra bire bir:
 * önce doğrulama (`p_validate_only`), sonra auth, sonra profil. Reddedilecek
 * bir istek için auth kullanıcısı açılmaz, e-posta ya da şifre değişmez.
 */
@Injectable()
export class StaffAccountsService {
  private readonly logger = new Logger(StaffAccountsService.name);

  constructor(
    private readonly db: DbContextService,
    private readonly repo: AccountsRepository,
    private readonly caller: CallerResolver,
    private readonly admin: AuthAdminService,
  ) {}

  async createUser(auth: RequestAuth, body: StaffBody): Promise<EdgeOk> {
    const user = await this.caller.resolve(auth);
    if (!user) throw edgeFailure(NO_SESSION);

    // `school_id` yok sayılır — okul çağıranın oturumundan. `class_ids`
    // yalnızca eğitmen formundan; gönderilmezse sınıfa dokunulmaz.
    const params = (
      profileId: string | null,
      validateOnly: boolean,
    ): StaffProfileParams => ({
      ...common(body),
      profileId,
      branchIds: body.branch_ids ?? [],
      permissions: body.permissions ?? [],
      validateOnly,
      classIds: body.class_ids ?? null,
    });

    // Adım 1: doğrula.
    const check = await this.save(auth, params(null, true));
    if (check.success === false) throw edgeFailure(String(check.message));

    if (!body.password) throw edgeFailure('Parola zorunludur.');

    // Adım 2: auth kullanıcısı. `created_by` = çağıran: RPC yalnızca
    // çağıranın az önce açtığı auth hesabına profil yazar.
    let newUserId: string;
    try {
      const created = await this.admin.createUser({
        email: String(body.email ?? ''),
        password: body.password,
        emailConfirm: true,
        userMetadata: {
          created_by_manager: true, // handle_new_user'ı durduran bayrak
          created_by: user.id,
          name: body.full_name,
        },
      });
      newUserId = created.id;
    } catch (error) {
      throw edgeFailure(messageOf(error));
    }

    // Adım 3: profil + şubeler + yetkiler (+ sınıflar) tek transaction'da.
    // Başarısız olursa auth kullanıcısı silinir; yarım hesap kalmaz.
    let saved: Envelope | undefined;
    let saveError: unknown;
    try {
      saved = await this.db.withUser(auth.claims, (c) =>
        this.repo.saveStaffProfile(c, params(newUserId, false)),
      );
    } catch (error) {
      saveError = error;
    }
    if (saveError !== undefined || saved?.success === false) {
      await this.rollback(newUserId);
      throw edgeFailure(
        saved?.message ??
          (saveError !== undefined ? messageOf(saveError) : undefined) ??
          'Kullanıcı oluşturulamadı.',
      );
    }
    return edgeOk('Kullanıcı başarıyla oluşturuldu');
  }

  async updateUser(auth: RequestAuth, body: StaffBody): Promise<EdgeOk> {
    const id = body.id;
    if (!id)
      throw edgeFailure("Güncellenecek kullanıcının 'id' bilgisi eksik.");

    const user = await this.caller.resolve(auth);
    if (!user) throw edgeFailure(NO_SESSION);

    // `permissions` / `branch_ids` / `class_ids` gönderilmezse dokunulmaz:
    // bu alanları tanımayan eski bir istemci verilmiş yetkileri silmesin.
    const params = (validateOnly: boolean): StaffProfileParams => ({
      ...common(body),
      profileId: id,
      branchIds: body.branch_ids ?? null,
      permissions: body.permissions ?? null,
      validateOnly,
      classIds: body.class_ids ?? null,
    });

    // Adım 1: doğrula — mevcut hesap olmalı. Şifre servis yetkisiyle bu
    // denetimden geçmeden değişmez (şube müdürü genel müdürün şifresini
    // sıfırlayıp hesabı ele geçiremesin).
    const check = await this.save(auth, params(true));
    if (check.success === false) throw edgeFailure(String(check.message));
    const isNew = (check.data as { is_new?: unknown } | null | undefined)
      ?.is_new;
    if (isNew !== false) {
      throw edgeFailure('Kullanıcı bulunamadı veya yetkiniz yok.');
    }

    // Adım 2: auth (e-posta / şifre). Başarısız olursa DB'ye bir şey yazılmadı.
    const updates: { email?: string; password?: string } = {};
    if (body.email) updates.email = body.email;
    if (body.password) updates.password = body.password;
    if (Object.keys(updates).length > 0) {
      try {
        await this.admin.updateUserById(id, updates);
      } catch (error) {
        throw edgeFailure(messageOf(error));
      }
    }

    // Adım 3: profil + şubeler + yetkiler + sınıflar, tek transaction.
    const saved = await this.save(auth, params(false));
    if (saved.success === false) {
      throw edgeFailure(
        `Giriş bilgileri güncellendi ama profil kaydedilemedi: ${String(saved.message)}`,
      );
    }
    return edgeOk('Kullanıcı bilgileri başarıyla güncellendi');
  }

  /** `save_staff_profile` çağıranın rolüyle; SQL hatası → 400 metniyle. */
  private async save(
    auth: RequestAuth,
    params: StaffProfileParams,
  ): Promise<Envelope> {
    try {
      return await this.db.withUser(auth.claims, (c) =>
        this.repo.saveStaffProfile(c, params),
      );
    } catch (error) {
      throw edgeFailure(messageOf(error));
    }
  }

  private async rollback(userId: string): Promise<void> {
    try {
      await this.admin.deleteUser(userId);
    } catch (error) {
      this.logger.error(
        { userId, err: messageOf(error) },
        'Yarım kalan personel hesabı silinemedi',
      );
    }
  }
}

function common(body: StaffBody) {
  return {
    fullName: body.full_name,
    email: body.email,
    phoneNumber: body.phone_number ?? null,
    birthOfDate: body.birth_of_date ?? null,
    status: body.status ?? 'active',
    roleId: body.role_id,
  };
}
