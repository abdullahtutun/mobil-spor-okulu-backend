import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type { Brand } from '../mail/brand';

/** `app_ok` / `app_err` zarfı (SQL fonksiyonlarının dönüşü). */
export interface Envelope {
  success?: boolean;
  code?: string;
  message?: string | null;
  data?: unknown;
}

export interface StaffProfileParams {
  profileId: string | null;
  fullName: unknown;
  email: unknown;
  phoneNumber: unknown;
  birthOfDate: unknown;
  status: unknown;
  roleId: unknown;
  branchIds: string[] | null;
  permissions: string[] | null;
  validateOnly: boolean;
  classIds: string[] | null;
}

export interface ParentProfileRow {
  schoolId: unknown;
  fullName: unknown;
  email?: unknown;
  phoneNumber: unknown;
  birthOfDate: unknown;
  status: unknown;
}

/**
 * Hesap fonksiyonlarının SQL'i. Her metot verilen bağlantıda çalışır;
 * rolü (çağıran `authenticated` mı, `service_role` mı) servis
 * `DbContextService` ile seçer. Edge Function'ların PostgREST'e attığı
 * isteklerin aynısı: RLS ve SQL fonksiyonları karar verir, burada kural yok.
 *
 * Değerler PostgREST'teki gibi metinden çevrilir (`$n::uuid` …): geçersiz
 * bir uuid `22P02` olur, Edge Function'da da öyleydi.
 */
@Injectable()
export class AccountsRepository {
  /** `.from('profiles').select('role_id, school_id').eq('id', uid).eq('is_deleted', false).single()` */
  async callerProfile(
    c: PoolClient,
    userId: string,
  ): Promise<{ role_id: number; school_id: string | null } | null> {
    const { rows } = await c.query<{
      role_id: string;
      school_id: string | null;
    }>(
      `select role_id, school_id from public.profiles
        where id = $1::uuid and is_deleted = false`,
      [userId],
    );
    if (rows.length !== 1) return null;
    return { role_id: Number(rows[0].role_id), school_id: rows[0].school_id };
  }

  async hasPermission(c: PoolClient, permission: string): Promise<boolean> {
    const { rows } = await c.query<{ ok: boolean | null }>(
      `select public.has_permission($1::text) as ok`,
      [permission],
    );
    return rows[0]?.ok === true;
  }

  async hasBranchAccess(c: PoolClient, branchId: unknown): Promise<boolean> {
    const { rows } = await c.query<{ ok: boolean | null }>(
      `select public.has_branch_access($1::uuid) as ok`,
      [branchId],
    );
    return rows[0]?.ok === true;
  }

  async canManageParent(c: PoolClient, parentId: unknown): Promise<boolean> {
    const { rows } = await c.query<{ ok: boolean | null }>(
      `select public.can_manage_parent($1::uuid) as ok`,
      [parentId],
    );
    return rows[0]?.ok === true;
  }

  async saveStaffProfile(
    c: PoolClient,
    p: StaffProfileParams,
  ): Promise<Envelope> {
    const { rows } = await c.query<{ r: Envelope }>(
      `select public.save_staff_profile(
                p_profile_id     => $1::uuid,
                p_full_name      => $2::text,
                p_email          => $3::text,
                p_phone_number   => $4::text,
                p_birth_of_date  => $5::date,
                p_status         => $6::text,
                p_role_id        => $7::bigint,
                p_branch_ids     => $8::uuid[],
                p_permissions    => $9::text[],
                p_validate_only  => $10::boolean,
                p_class_ids      => $11::uuid[]) as r`,
      [
        p.profileId,
        p.fullName ?? null,
        p.email ?? null,
        p.phoneNumber ?? null,
        p.birthOfDate ?? null,
        p.status ?? 'active',
        p.roleId ?? null,
        p.branchIds,
        p.permissions,
        p.validateOnly,
        p.classIds,
      ],
    );
    return rows[0].r ?? {};
  }

  /**
   * `_shared/brand.ts` → `schoolBrand` (service_role). Okul yoksa `null`
   * (çağıran hata verir: yanlış alan adına giden davet sessizce bozulur).
   */
  async schoolBrand(c: PoolClient, schoolId: unknown): Promise<Brand | null> {
    const { rows } = await c.query<{ brand: string }>(
      `select brand from public.schools where id = $1::uuid`,
      [schoolId],
    );
    if (rows.length !== 1) return null;
    // brand.ts gibi: bilinmeyen değer public sayılır (sütun CHECK'li).
    return rows[0].brand === 'dev_adim' ? 'dev_adim' : 'public';
  }

  /** `.from('profiles').select('email, role_id, school_id').eq('id', id).single()` */
  async profileOf(
    c: PoolClient,
    id: unknown,
  ): Promise<{
    email: string | null;
    role_id: number;
    school_id: string | null;
  } | null> {
    const { rows } = await c.query<{
      email: string | null;
      role_id: string;
      school_id: string | null;
    }>(
      `select email, role_id, school_id from public.profiles where id = $1::uuid`,
      [id],
    );
    if (rows.length !== 1) return null;
    return { ...rows[0], role_id: Number(rows[0].role_id) };
  }

  /**
   * Veli profili (rol 8), çağıranın rolüyle: `profiles_insert_policy` rol
   * 8'i, çağıranın okulunu ve `registration.manage`'i şart koşar.
   * `RETURNING` yok (PostgREST'in `return=minimal`'ı).
   */
  async insertParentProfile(
    c: PoolClient,
    id: string,
    row: ParentProfileRow,
  ): Promise<void> {
    await c.query(
      `insert into public.profiles
              (id, school_id, full_name, email, phone_number, birth_of_date, status, role_id)
       values ($1::uuid, $2::uuid, $3::text, $4::text, $5::text, $6::date,
               $7::public.approval_status, 8)`,
      [
        id,
        row.schoolId ?? null,
        row.fullName ?? null,
        row.email ?? null,
        row.phoneNumber ?? null,
        row.birthOfDate ?? null,
        statusOrActive(row.status),
      ],
    );
  }

  /**
   * Veli profilinin güncellemesi, çağıranın rolüyle (`profiles_update_policy`).
   * Politika satırı gizlerse 0 satır güncellenir ve hata yoktur — PostgREST'te
   * de öyleydi.
   */
  async updateParentProfile(
    c: PoolClient,
    id: unknown,
    row: ParentProfileRow,
  ): Promise<void> {
    await c.query(
      `update public.profiles
          set school_id     = $2::uuid,
              full_name     = $3::text,
              phone_number  = $4::text,
              birth_of_date = $5::date,
              status        = $6::public.approval_status,
              role_id       = 8,
              -- E-posta yalnızca değiştiğinde verilir (update-parent).
              email         = coalesce($7::text, email)
        where id = $1::uuid`,
      [
        id,
        row.schoolId ?? null,
        row.fullName ?? null,
        row.phoneNumber ?? null,
        row.birthOfDate ?? null,
        statusOrActive(row.status),
        row.email ?? null,
      ],
    );
  }

  /**
   * 20261123: velinin auth hesabının e-postasını değiştirir ve hesabı
   * davetli hâle döndürür (onaysız, şifresiz, oturumsuz). service_role'e
   * açık SECURITY DEFINER fonksiyon — çağıran bağlantının rolü önce
   * `service_role`'e geçirilmiş olmalı (`DbContextService.switchRole`).
   */
  async resetParentLoginEmail(
    c: PoolClient,
    parentId: string,
    email: string,
  ): Promise<Envelope> {
    const { rows } = await c.query<{ r: Envelope | null }>(
      `select public.reset_parent_login_email($1::uuid, $2::text) as r`,
      [parentId, email],
    );
    return rows[0].r ?? {};
  }

  async syncProfileBranchLinks(
    c: PoolClient,
    profileId: unknown,
    branchIds: unknown[],
  ): Promise<Envelope> {
    const { rows } = await c.query<{ r: Envelope | null }>(
      `select public.sync_profile_branch_links($1::uuid, $2::uuid[]) as r`,
      [profileId, branchIds],
    );
    return rows[0].r ?? {};
  }

  async syncParentAthleteLinks(
    c: PoolClient,
    profileId: unknown,
    athleteIds: unknown[],
  ): Promise<Envelope> {
    const { rows } = await c.query<{ r: Envelope | null }>(
      `select public.sync_parent_athlete_links($1::uuid, $2::uuid[]) as r`,
      [profileId, athleteIds],
    );
    return rows[0].r ?? {};
  }

  /** Yalnızca service_role'e açık (20261023_account_deletion.sql). */
  async deleteOwnAccount(
    c: PoolClient,
    userId: string,
    validateOnly: boolean,
  ): Promise<Envelope> {
    const { rows } = await c.query<{ r: Envelope | null }>(
      `select public.delete_own_account($1::uuid, $2::boolean) as r`,
      [userId, validateOnly],
    );
    return rows[0].r ?? {};
  }
}

/** Edge Function: `status: status || 'active'`. */
function statusOrActive(status: unknown): unknown {
  return status === undefined ||
    status === null ||
    status === '' ||
    status === false
    ? 'active'
    : status;
}
