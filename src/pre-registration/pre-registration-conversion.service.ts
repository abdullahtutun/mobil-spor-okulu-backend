import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import {
  AccountsRepository,
  type Envelope,
} from '../accounts/accounts.repository';
import { CallerResolver } from '../accounts/caller';
import {
  appFailure,
  appOk,
  type AppOk,
  FunctionFailure,
  messageOf,
} from '../accounts/function-response';
import { AuthAdminService } from '../auth/admin/auth-admin.service';
import type { RequestAuth } from '../auth/request/jwt-verifier.service';
import { DbContextService } from '../db/db-context.service';
import type { Brand } from '../mail/brand';
import { RpcService, ServerRpcNotFoundError } from '../rpc/rpc.service';
import {
  escapeLikePattern,
  PreRegistrationRepository,
  type PreRegistrationRow,
} from './pre-registration.repository';

/**
 * Tek istekte aktarılabilecek en fazla kayıt (Edge Function'ın `MAX_BATCH`).
 * İstemci aynı değeri `PreRegistrationService.bulkConvertLimit` olarak tutar.
 */
export const MAX_BATCH = 50;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const PARENT_ROLE_ID = 8;

const NOT_VISIBLE =
  'Ön kayıt bulunamadı veya bu kayıt üzerinde işlem yetkiniz yok.';

/** Edge'in `AppError`'ı: iş kuralı hatası, `code` RpcErrorCode'la eşleşir. */
const appError = (message: string, code: string, status = 400) =>
  appFailure(message, code, status);

interface ConversionContext {
  auth: RequestAuth;
  schoolId: string;
  /** Okulun markası: davet bağlantısının alan adı. İstek başına bir kez. */
  brand: Brand;
  /** Aynı istekte açılan/bulunan veliler (e-posta → profil id). */
  parentIdByEmail: Map<string, string>;
}

interface ParentInput {
  fullName: string;
  email: string;
  phone: string | null;
}

export interface BulkFailure {
  id: string;
  full_name: string | null;
  code: string;
  message: string;
}

/**
 * Ex `convert-pre-registration` ve `bulk-convert-pre-registrations`
 * (yönetim reposu `supabase/functions/_shared/pre_registration_conversion.ts`).
 *
 * İş bölümü aynı: burada veli hesapları (davet + profil, service_role);
 * `convert_pre_registration` RPC'si geri kalan her şeyi — sporcu, bağlar,
 * durum, kilit — çağıranın rolüyle tek transaction'da yapar. Denetim sırası
 * bire bir: çağıran → profili → `registration.manage` → marka → (tekli:
 * okul uyuşmazlığı → form kaydı) → kayıt RLS'le okunur → ucuz ön kontroller
 * (aktarılmış, sınıfsız) → veliler → RPC. Hata yanıtları Edge'in
 * `errorResponse`'u: `AppError` kendi kodu/durumu, beklenmeyen hata 400
 * `internal`.
 */
@Injectable()
export class PreRegistrationConversionService {
  private readonly logger = new Logger(PreRegistrationConversionService.name);

  constructor(
    private readonly db: DbContextService,
    private readonly repo: PreRegistrationRepository,
    private readonly accounts: AccountsRepository,
    private readonly caller: CallerResolver,
    private readonly admin: AuthAdminService,
    private readonly rpc: RpcService,
  ) {}

  /** `convert-pre-registration`: formu kaydet, sonra aktar. */
  async convertSingle(auth: RequestAuth, rawBody: unknown): Promise<AppOk> {
    return this.guard(async () => {
      const body = objectOf(rawBody);
      const id = body.id;
      if (typeof id !== 'string' || !id) {
        throw appError(
          "İşlem için 'id' (pre_registration_id) parametresi zorunludur.",
          'validation',
        );
      }

      const ctx = await this.openContext(auth);

      // `school_id` yalnızca uyuşmazlığı reddetmek için; okul oturumdan.
      if (body.school_id && body.school_id !== ctx.schoolId) {
        throw appError(
          'Bu okul üzerinde işlem yapma yetkiniz yok.',
          'forbidden',
          HttpStatus.FORBIDDEN,
        );
      }

      // 1. Formdaki düzenlemeler (ön kayıt ekranının "Kaydet"iyle aynı RPC).
      let saved: Envelope;
      try {
        saved =
          (await this.rpc.callAs(
            { role: 'authenticated', claims: auth.claims },
            'update_pre_registration',
            {
              p_id: id,
              p_full_name: body.full_name,
              p_gender: body.gender,
              p_date_of_birth: body.date_of_birth,
              p_branch_id: body.branch_id,
              p_class_id: body.class_id,
              p_interviewer_name: body.interviewer_name,
              p_interview_type: body.interview_type,
              p_interview_date: body.interview_date,
              p_parent_full_name: body.parent_full_name,
              p_parent_phone: body.parent_phone,
              p_parent_email: body.parent_email,
              p_national_id: body.national_id ?? null,
              p_phone: body.phone ?? null,
              p_address: body.address ?? null,
              p_height: body.height ?? null,
              p_weight: body.weight ?? null,
              p_health_problems: body.health_problems ?? null,
              p_has_health_report: body.has_health_report ?? null,
              p_has_sports_history: body.has_sports_history ?? null,
              p_parent2_full_name: body.parent2_full_name ?? null,
              p_parent2_phone: body.parent2_phone ?? null,
              p_parent2_email: body.parent2_email ?? null,
              p_contract_possibility: body.contract_possibility ?? null,
              p_referral_source: body.referral_source ?? null,
              // Üç değerli (20261021): null = rıza değişmez.
              p_health_consent: body.health_consent ?? null,
            },
          )) ?? {};
      } catch (error) {
        throw appError(rpcErrorMessage(error), 'internal');
      }
      if (!saved.success) {
        throw appError(
          saved.message ?? 'Bilinmeyen bir hata oluştu.',
          saved.code ?? 'internal',
        );
      }

      // 2. Aktar (veliler kaydedilmiş satırdan okunur).
      const row = (await this.read(ctx, [id])).get(id);
      if (!row) throw appError(NOT_VISIBLE, 'not_found', HttpStatus.NOT_FOUND);
      const athleteId = await this.convertOne(ctx, row);

      return appOk(
        'Ön kayıt kesin kayda aktarıldı. Veli hesapları ve davetleri tamamlandı.',
        { athlete_id: athleteId },
      );
    });
  }

  /**
   * `bulk-convert-pre-registrations`: kısmi başarı bilinçli — her kayıt davet
   * e-postası gönderir, gönderilmiş e-posta geri alınamaz. Her kayıt kendi
   * içinde bütündür; yanıt hangisinin neden aktarılamadığını söyler.
   */
  async convertBulk(auth: RequestAuth, rawBody: unknown): Promise<AppOk> {
    return this.guard(async () => {
      const rawIds = objectOf(rawBody).ids;
      if (!Array.isArray(rawIds) || rawIds.length === 0) {
        throw appError('Aktarılacak kayıt seçilmedi.', 'validation');
      }
      const ids = [...new Set(rawIds.map(String))];
      if (ids.some((id) => !UUID_RE.test(id))) {
        throw appError('Geçersiz kayıt kimliği gönderildi.', 'validation');
      }
      if (ids.length > MAX_BATCH) {
        throw appError(
          `Tek seferde en fazla ${MAX_BATCH} kayıt aktarılabilir.`,
          'validation',
        );
      }

      const ctx = await this.openContext(auth);
      const rowById = await this.read(ctx, ids);

      const converted: { id: string; athlete_id: string }[] = [];
      const failed: BulkFailure[] = [];

      // Sırayla: kardeşlerin ortak velisi ancak böyle tek hesap olur, davetler
      // e-posta sınırına aynı anda yüklenmez.
      for (const id of ids) {
        const row = rowById.get(id);
        if (!row) {
          failed.push({
            id,
            full_name: null,
            code: 'not_found',
            message: NOT_VISIBLE,
          });
          continue;
        }
        try {
          converted.push({ id, athlete_id: await this.convertOne(ctx, row) });
        } catch (error) {
          const failure = toFailure(error);
          failed.push({
            id,
            full_name: row.full_name,
            code: failure.code,
            message: failure.message,
          });
        }
      }

      const message =
        failed.length === 0
          ? `${converted.length} ön kayıt kesin kayda aktarıldı.`
          : `${converted.length} ön kayıt aktarıldı, ${failed.length} kayıt aktarılamadı.`;
      return appOk(message, {
        converted_count: converted.length,
        converted,
        failed,
      });
    });
  }

  /**
   * Edge'in `openConversionContext`'i. Rol burada **erken ret** içindir —
   * davetler gitmeden önce; asıl denetim `convert_pre_registration`'da.
   */
  private async openContext(auth: RequestAuth): Promise<ConversionContext> {
    const user = await this.caller.resolve(auth);
    if (!user) {
      throw appError(
        'Oturum doğrulanamadı. Lütfen tekrar giriş yapın.',
        'forbidden',
        HttpStatus.UNAUTHORIZED,
      );
    }

    let profile: { school_id: string | null } | null = null;
    try {
      profile = await this.db.withRole('service_role', (c) =>
        this.repo.profileForConversion(c, user.id),
      );
    } catch {
      profile = null;
    }
    if (!profile?.school_id) {
      throw appError(
        'Kullanıcı profili bulunamadı.',
        'not_found',
        HttpStatus.NOT_FOUND,
      );
    }

    let canConvert = false;
    try {
      canConvert = await this.db.withUser(auth.claims, (c) =>
        this.accounts.hasPermission(c, 'registration.manage'),
      );
    } catch {
      canConvert = false;
    }
    if (!canConvert) {
      throw appError(
        'Bu işlemi gerçekleştirmek için yetkiniz yok.',
        'forbidden',
        HttpStatus.FORBIDDEN,
      );
    }

    const schoolId = profile.school_id;
    let brand: Brand | null = null;
    let reason = 'okul yok';
    try {
      brand = await this.db.withRole('service_role', (c) =>
        this.accounts.schoolBrand(c, schoolId),
      );
    } catch (error) {
      reason = messageOf(error);
    }
    if (!brand)
      throw appError(`Okulun markası okunamadı: ${reason}`, 'internal');

    return { auth, schoolId, brand, parentIdByEmail: new Map() };
  }

  private async read(
    ctx: ConversionContext,
    ids: readonly string[],
  ): Promise<Map<string, PreRegistrationRow>> {
    try {
      return await this.db.withUser(ctx.auth.claims, (c) =>
        this.repo.readPreRegistrations(c, ids),
      );
    } catch (error) {
      throw appError(messageOf(error), 'internal');
    }
  }

  /**
   * Tek kaydı aktarır, sporcunun id'sini döner. RPC başarısız olursa bu kayıt
   * için açılan veli hesapları silinir (profil `on delete cascade`; şube ve
   * sporcu bağları RPC'nin transaction'ında olduğu için hiç yazılmamıştır).
   * Önceden var olan ya da aynı istekte başka kayıt için açılmış veliye
   * dokunulmaz.
   */
  private async convertOne(
    ctx: ConversionContext,
    row: PreRegistrationRow,
  ): Promise<string> {
    // Ucuz ön kontroller: davetten önce. RPC aynısını kilit altında yineler.
    if (row.status === 'converted') {
      throw appError('Bu ön kayıt zaten kesin kayda aktarılmış.', 'conflict');
    }
    if (!row.class_id) {
      throw appError('Ön kaydın sınıfı seçilmemiş.', 'validation');
    }

    const createdAuthUserIds: string[] = [];
    try {
      const parentIds: string[] = [];
      for (const parent of parentsOf(row)) {
        parentIds.push(
          await this.resolveParent(ctx, parent, createdAuthUserIds),
        );
      }

      let envelope: Envelope;
      try {
        envelope = await this.db.withUser(ctx.auth.claims, (c) =>
          this.repo.convert(c, row.id, parentIds),
        );
      } catch (error) {
        throw appError(messageOf(error), 'internal');
      }
      if (!envelope.success) {
        throw appError(
          envelope.message ?? 'Bilinmeyen bir hata oluştu.',
          envelope.code ?? 'internal',
        );
      }
      return (envelope.data as { id?: string } | null)?.id as string;
    } catch (error) {
      for (const userId of createdAuthUserIds) {
        await this.deleteQuietly(userId);
        for (const [email, pid] of ctx.parentIdByEmail) {
          if (pid === userId) ctx.parentIdByEmail.delete(email);
        }
      }
      throw error;
    }
  }

  /**
   * Velinin profil id'si; gerekirse davet gönderip hesap açar.
   * - Bu okulda aynı e-postayla canlı bir veli varsa o kullanılır (kardeş).
   * - Adres başka okulda ya da veli olmayan bir hesaptaysa kayıt reddedilir:
   *   o hesabı bu sporcuya bağlamak, başka birine çocuğun verisini açardı.
   */
  private async resolveParent(
    ctx: ConversionContext,
    parent: ParentInput,
    createdAuthUserIds: string[],
  ): Promise<string> {
    const cached = ctx.parentIdByEmail.get(parent.email);
    if (cached) return cached;

    let existing: Awaited<
      ReturnType<PreRegistrationRepository['profileByEmailPattern']>
    >;
    try {
      existing = await this.db.withRole('service_role', (c) =>
        this.repo.profileByEmailPattern(c, escapeLikePattern(parent.email)),
      );
    } catch (error) {
      throw appError(messageOf(error), 'internal');
    }

    if (existing) {
      if (
        existing.role_id === PARENT_ROLE_ID &&
        existing.school_id === ctx.schoolId &&
        existing.is_deleted !== true
      ) {
        ctx.parentIdByEmail.set(parent.email, existing.id);
        return existing.id;
      }
      throw appError(
        `${parent.email} adresi başka bir hesapta kullanılıyor.`,
        'conflict',
      );
    }

    let userId: string;
    try {
      userId = (
        await this.admin.inviteUser(
          parent.email,
          // parentInviteOptions: created_by_manager + name (+ brand).
          { created_by_manager: true, name: parent.fullName },
          ctx.brand,
        )
      ).id;
    } catch (error) {
      throw appError(
        `${parent.email} için davet gönderilemedi: ${messageOf(error)}`.trim(),
        'internal',
      );
    }
    createdAuthUserIds.push(userId);

    try {
      await this.db.withRole('service_role', (c) =>
        this.repo.insertParentProfile(c, {
          id: userId,
          schoolId: ctx.schoolId,
          fullName: parent.fullName,
          email: parent.email,
          phone: parent.phone,
        }),
      );
    } catch (error) {
      throw appError(
        `Veli profili oluşturulamadı: ${messageOf(error)}`,
        'internal',
      );
    }

    ctx.parentIdByEmail.set(parent.email, userId);
    return userId;
  }

  /** Edge'in `errorResponse`'u: beklenmeyen hata da zarfla, 400 `internal`. */
  private async guard<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof FunctionFailure) throw error;
      this.logger.error({ err: error }, 'Ön kayıt aktarımı beklenmeyen hata');
      throw appError(messageOf(error), 'internal');
    }
  }

  private async deleteQuietly(userId: string): Promise<void> {
    try {
      await this.admin.deleteUser(userId);
    } catch (error) {
      this.logger.error(
        { userId, err: messageOf(error) },
        'Geri alma: aktarım için açılan veli hesabı silinemedi',
      );
    }
  }
}

/** E-postası ve adı olan veliler; aynı adres iki kez yazılmışsa tek hesap. */
export function parentsOf(row: PreRegistrationRow): ParentInput[] {
  const result: ParentInput[] = [];
  const add = (
    name: string | null,
    email: string | null,
    phone: string | null,
  ) => {
    const trimmedName = name?.trim();
    const normalizedEmail = email?.trim().toLowerCase();
    if (!trimmedName || !normalizedEmail) return;
    if (result.some((p) => p.email === normalizedEmail)) return;
    result.push({
      fullName: trimmedName,
      email: normalizedEmail,
      phone: phone?.trim() || null,
    });
  };
  add(row.parent_full_name, row.parent_email, row.parent_phone);
  add(row.parent2_full_name, row.parent2_email, row.parent2_phone);
  return result;
}

function objectOf(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** supabase-js'in `error.message`'ı: PostgREST'in imza ya da SQL metni. */
function rpcErrorMessage(error: unknown): string {
  return error instanceof ServerRpcNotFoundError
    ? error.message
    : messageOf(error);
}

function toFailure(error: unknown): { code: string; message: string } {
  if (error instanceof FunctionFailure) {
    const { code, message } = error.body;
    return {
      code: typeof code === 'string' ? code : 'internal',
      message:
        typeof message === 'string' ? message : 'Bilinmeyen bir hata oluştu.',
    };
  }
  return { code: 'internal', message: messageOf(error) };
}
