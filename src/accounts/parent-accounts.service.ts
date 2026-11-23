import { Injectable, Logger } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { AuthAdminService } from '../auth/admin/auth-admin.service';
import type { RequestAuth } from '../auth/request/jwt-verifier.service';
import { DbContextService } from '../db/db-context.service';
import type { Brand } from '../mail/brand';
import { AccountsRepository, type Envelope } from './accounts.repository';
import type { ParentBody } from './accounts.schemas';
import { CallerResolver } from './caller';
import {
  edgeFailure,
  edgeOk,
  type EdgeOk,
  FunctionFailure,
  messageOf,
} from './function-response';

/** PostgREST'in `.single()` 0 satırda verdiği metin. */
const NOT_SINGLE = 'Cannot coerce the result to a single JSON object';

/**
 * Ex `create-parent` / `update-parent` (yönetim reposu
 * `supabase/functions/{create-parent,update-parent}/index.ts`).
 *
 * Denetim sırası bire bir: çağıran → profili → `registration.manage` →
 * gövdedeki okul = çağıranın okulu → şube seçili ve kapsamda
 * (update'te önce `can_manage_parent`) — hepsi davet e-postası gitmeden,
 * hiçbir şey yazılmadan ve silinmeden önce. Profil satırı çağıranın rolüyle
 * yazılır (`profiles_insert/update_policy`: yalnızca rol 8), bağlar
 * `sync_*` RPC'leriyle.
 *
 * Farklar: profil + şube + sporcu yazımları Edge Function'da ayrı
 * isteklerdi (biri düşerse öncekiler kalıyordu); burada tek transaction.
 * E-posta değişikliği (20261123, yönetim reposunda da aynı karar) eski hesabı
 * silip yeni hesap açmaz: **aynı** hesabın adresi değişir, hesap davetli hâle
 * döner ve yeni adrese şifre oluşturma daveti gider; o da aynı transaction'da.
 */
@Injectable()
export class ParentAccountsService {
  private readonly logger = new Logger(ParentAccountsService.name);

  constructor(
    private readonly db: DbContextService,
    private readonly repo: AccountsRepository,
    private readonly caller: CallerResolver,
    private readonly admin: AuthAdminService,
  ) {}

  async createParent(auth: RequestAuth, body: ParentBody): Promise<EdgeOk> {
    const { school_id: schoolId, branch_id: branchId } = body;
    await this.authorize(auth, schoolId);

    // Şube: davet e-postası gitmeden önce (gönderilmiş e-posta geri alınamaz).
    // Şubesiz veli herkesin kapsamına düşer (20261017).
    if (!branchId) throw edgeFailure('Velinin şubesi seçilmelidir.');
    if (
      !(await this.ask(auth, (c) => this.repo.hasBranchAccess(c, branchId)))
    ) {
      throw edgeFailure('Seçilen şubeye erişiminiz yok.');
    }

    // Adım 1: davet (bağlantının alan adı okulun markasından).
    const brand = await this.schoolBrand(schoolId);
    let newUserId: string;
    try {
      newUserId = (
        await this.admin.inviteUser(
          String(body.email ?? ''),
          { created_by_manager: true, name: body.full_name },
          brand,
        )
      ).id;
    } catch (error) {
      throw edgeFailure(messageOf(error));
    }

    // Adım 2–4: profil, şube bağı, sporcu bağları. Hata → auth kullanıcısı silinir.
    try {
      await this.db.withUser(auth.claims, async (c) => {
        try {
          await this.repo.insertParentProfile(c, newUserId, {
            schoolId,
            fullName: body.full_name,
            email: body.email,
            phoneNumber: body.phone_number,
            birthOfDate: body.birth_of_date,
            status: body.status,
          });
        } catch (error) {
          throw edgeFailure(`Profil oluşturulurken hata: ${messageOf(error)}`);
        }

        const branchSync = await this.envelopeOrFail(
          () => this.repo.syncProfileBranchLinks(c, newUserId, [branchId]),
          (m) => `Veli şube ataması yapılırken hata oluştu: ${m}`,
        );
        if (branchSync.success === false) {
          throw edgeFailure(String(branchSync.message));
        }

        const athleteIds = body.athlete_ids ?? [];
        if (athleteIds.length > 0) {
          const athleteSync = await this.envelopeOrFail(
            () => this.repo.syncParentAthleteLinks(c, newUserId, athleteIds),
            (m) => `Veli sporcu eşleştirmesi yapılırken hata oluştu: ${m}`,
          );
          if (athleteSync.success === false) {
            throw edgeFailure(String(athleteSync.message));
          }
        }
      });
    } catch (error) {
      await this.deleteQuietly(newUserId);
      throw error instanceof FunctionFailure
        ? error
        : edgeFailure(messageOf(error));
    }

    return edgeOk(
      'Veli başarıyla oluşturuldu, şube ve sporcu bağlantıları tanımlandı. Davet e-postası gönderildi.',
    );
  }

  async updateParent(auth: RequestAuth, body: ParentBody): Promise<EdgeOk> {
    const { id, school_id: schoolId, branch_id: branchId } = body;
    if (!id) {
      throw edgeFailure(
        "Güncelleme işlemi için veliye ait 'id' parametresi zorunludur.",
      );
    }
    const callerProfile = await this.authorize(auth, schoolId);

    // Kapsam: hiçbir şey yazılmadan ve silinmeden önce. E-posta değişikliği
    // eski auth hesabını siliyor; bu denetim olmadan başka şubenin velisi
    // (ya da bir personel) silinebilirdi.
    if (!branchId) throw edgeFailure('Velinin şubesi seçilmelidir.');
    if (!(await this.ask(auth, (c) => this.repo.canManageParent(c, id)))) {
      throw edgeFailure(
        'Güncellenecek veli profili bulunamadı veya yetkiniz yok.',
      );
    }
    if (
      !(await this.ask(auth, (c) => this.repo.hasBranchAccess(c, branchId)))
    ) {
      throw edgeFailure('Seçilen şubeye erişiminiz yok.');
    }

    // Adım 1: velinin mevcut e-postası (çağıranın rolüyle, RLS).
    let current: Awaited<ReturnType<AccountsRepository['profileOf']>>;
    try {
      current = await this.db.withUser(auth.claims, (c) =>
        this.repo.profileOf(c, id),
      );
    } catch (error) {
      throw edgeFailure(
        `Güncellenecek veli profili bulunamadı: ${messageOf(error)}`,
      );
    }
    if (!current) {
      throw edgeFailure(`Güncellenecek veli profili bulunamadı: ${NOT_SINGLE}`);
    }
    // Hedef bir veli olmalı (personelin auth hesabı silinemesin).
    if (
      current.role_id !== 8 ||
      current.school_id !== callerProfile.school_id
    ) {
      throw edgeFailure('Güncellenecek veli profili bulunamadı.');
    }

    if (typeof body.email !== 'string') {
      throw edgeFailure('E-posta zorunludur.');
    }
    const emailChanged =
      (current.email ?? '').toLowerCase() !== body.email.toLowerCase();

    // E-posta değiştiyse marka değişiklikten önce okunur (okunamazsa hiçbir
    // şey yazılmadan hata).
    const brand = emailChanged ? await this.schoolBrand(schoolId) : null;
    const newEmail = body.email;

    // Hepsi tek transaction'da: profil ve bağlar çağıranın rolüyle; e-posta
    // değiştiyse ardından aynı hesabın adresi (service_role,
    // `reset_parent_login_email`) ve davet token'ı + e-postası
    // (`AuthAdminService.reinviteWithin`, auth_service). Bir adım düşerse —
    // davet e-postasının gönderimi dahil — hepsi geri alınır.
    //
    // Eskiden (Edge Function, 20261123'e kadar) eski auth hesabı silinip yeni
    // adrese yeni hesap açılıyordu; velinin bağ satırları `profiles`'a NO
    // ACTION ile bağlı olduğu için silme bağı olan her velide düşüyordu. Artık
    // profil kimliği, bağlar ve geçmiş yerinde kalır.
    await this.db.withUser(auth.claims, async (c) => {
      // Adım 2: profil. updated_at'i trigger yazar.
      try {
        await this.repo.updateParentProfile(c, id, {
          schoolId,
          fullName: body.full_name,
          email: emailChanged ? newEmail : undefined,
          phoneNumber: body.phone_number,
          birthOfDate: body.birth_of_date,
          status: body.status,
        });
      } catch (error) {
        throw edgeFailure(`Profil güncellenirken hata: ${messageOf(error)}`);
      }

      // Adım 3: şube bağları (soft delete, RPC).
      const branchSync = await this.envelopeOrFail(
        () => this.repo.syncProfileBranchLinks(c, id, [branchId]),
        (m) => `Şube ataması güncellenirken hata: ${m}`,
      );
      if (branchSync.success === false) {
        throw edgeFailure(String(branchSync.message));
      }

      // Adım 4: sporcu bağları.
      const athleteSync = await this.envelopeOrFail(
        () => this.repo.syncParentAthleteLinks(c, id, body.athlete_ids ?? []),
        (m) => `Sporcu eşleştirmesi güncellenirken hata: ${m}`,
      );
      if (athleteSync.success === false) {
        throw edgeFailure(String(athleteSync.message));
      }

      // Adım 5: e-posta değiştiyse aynı hesap: yeni adres, davetli hâl
      // (onaysız, şifresiz, oturumsuz), yeni adrese davet.
      if (emailChanged && brand) {
        const invitePrefix = 'Yeni e-posta için davet oluşturulamadı';
        let reset: Envelope;
        try {
          await this.db.switchRole(c, 'service_role');
          reset = await this.repo.resetParentLoginEmail(c, id, newEmail);
        } catch (error) {
          throw edgeFailure(`${invitePrefix}: ${messageOf(error)}`);
        }
        if (reset.success === false) {
          throw edgeFailure(`${invitePrefix}: ${String(reset.message)}`);
        }
        try {
          await this.admin.reinviteWithin(
            c,
            id,
            newEmail,
            { created_by_manager: true, name: body.full_name },
            brand,
          );
        } catch (error) {
          throw edgeFailure(`${invitePrefix}: ${messageOf(error)}`);
        }
      }
    });

    return edgeOk(
      emailChanged
        ? 'Veli e-postası değiştirildi; yeni adrese şifre oluşturma daveti gönderildi.'
        : 'Veli bilgileri ve bağlantıları başarıyla güncellendi.',
    );
  }

  /**
   * İki fonksiyonun ortak başı: çağıran, profili, `registration.manage`,
   * gövdedeki `school_id` = çağıranın okulu.
   */
  private async authorize(
    auth: RequestAuth,
    schoolId: string | null | undefined,
  ): Promise<{ role_id: number; school_id: string | null }> {
    const user = await this.caller.resolve(auth);
    if (!user) throw edgeFailure('Admin girişi yapılmamış.');

    let profile: { role_id: number; school_id: string | null } | null = null;
    try {
      profile = await this.db.withUser(auth.claims, (c) =>
        this.repo.callerProfile(c, user.id),
      );
    } catch {
      profile = null;
    }
    if (!profile) throw edgeFailure('Admin profili bulunamadı.');

    const canManage = await this.ask(auth, (c) =>
      this.repo.hasPermission(c, 'registration.manage'),
    );
    if (!canManage) {
      throw edgeFailure('Bu işlemi gerçekleştirmek için yetkiniz yok.');
    }

    // Okulsuz çağıran da reddedilir (Edge'de `null !== null` geçerdi; yine de
    // `has_permission` okulsuz hesapta zaten false).
    if (profile.school_id === null || profile.school_id !== schoolId) {
      throw edgeFailure('Bu okul üzerinde işlem yapma yetkiniz yok.');
    }
    return profile;
  }

  /** Çağıranın rolüyle evet/hayır sorusu; SQL hatası "hayır" (Edge'de de öyle). */
  private async ask(
    auth: RequestAuth,
    question: (c: PoolClient) => Promise<boolean>,
  ): Promise<boolean> {
    try {
      return await this.db.withUser(auth.claims, question);
    } catch {
      return false;
    }
  }

  /** `_shared/brand.ts` → `schoolBrand`: okunamazsa hata, varsayılan yok. */
  private async schoolBrand(
    schoolId: string | null | undefined,
  ): Promise<Brand> {
    let brand: Brand | null = null;
    let reason = 'okul yok';
    try {
      brand = await this.db.withRole('service_role', (c) =>
        this.repo.schoolBrand(c, schoolId),
      );
    } catch (error) {
      reason = messageOf(error);
    }
    if (!brand) throw edgeFailure(`Okulun markası okunamadı: ${reason}`);
    return brand;
  }

  /**
   * Bir `sync_*` RPC'si. SQL hatasında transaction bozulur; hata metinli
   * `FunctionFailure` olarak fırlar ve transaction geri alınır. Zarf
   * `success: false` dönerse çağıran fırlatır (yine geri alınır).
   */
  private async envelopeOrFail(
    call: () => Promise<Envelope>,
    onError: (message: string) => string,
  ): Promise<Envelope> {
    try {
      return await call();
    } catch (error) {
      throw edgeFailure(onError(messageOf(error)));
    }
  }

  private async deleteQuietly(userId: string): Promise<void> {
    try {
      await this.admin.deleteUser(userId);
    } catch (error) {
      this.logger.error(
        { userId, err: messageOf(error) },
        'Geri alma: yeni açılan veli hesabı silinemedi',
      );
    }
  }
}
