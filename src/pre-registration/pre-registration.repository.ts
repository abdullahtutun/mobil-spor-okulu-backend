import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type { Envelope } from '../accounts/accounts.repository';

/** `_shared/pre_registration_conversion.ts` → `PreRegistrationRow`. */
export interface PreRegistrationRow {
  id: string;
  full_name: string;
  status: string;
  class_id: string | null;
  branch_id: string;
  parent_full_name: string | null;
  parent_phone: string | null;
  parent_email: string | null;
  parent2_full_name: string | null;
  parent2_phone: string | null;
  parent2_email: string | null;
}

export interface ProfileByEmail {
  id: string;
  school_id: string | null;
  role_id: number;
  is_deleted: boolean | null;
}

/**
 * Ön kayıt fonksiyonlarının SQL'i; rol (çağıran mı service_role mı) servis
 * tarafından `DbContextService` ile seçilir. Edge Function'ın PostgREST
 * istekleriyle aynı sorgular.
 */
@Injectable()
export class PreRegistrationRepository {
  /**
   * `admin.from('profiles').select('role_id, school_id').eq('id', uid)
   *   .not('is_deleted', 'is', true).single()` (service_role).
   */
  async profileForConversion(
    c: PoolClient,
    userId: string,
  ): Promise<{ role_id: number; school_id: string | null } | null> {
    const { rows } = await c.query<{
      role_id: string;
      school_id: string | null;
    }>(
      `select role_id, school_id from public.profiles
        where id = $1::uuid and is_deleted is not true`,
      [userId],
    );
    if (rows.length !== 1) return null;
    return { role_id: Number(rows[0].role_id), school_id: rows[0].school_id };
  }

  /**
   * Çağıranın rolüyle (`caller.from('pre_registrations')...in('id', ids)`):
   * RLS okul ve şube kapsamını uygular; görünmeyen kayıt için hiçbir davet
   * gitmez.
   */
  async readPreRegistrations(
    c: PoolClient,
    ids: readonly string[],
  ): Promise<Map<string, PreRegistrationRow>> {
    const { rows } = await c.query<PreRegistrationRow>(
      `select id, full_name, status::text as status, class_id, branch_id,
              parent_full_name, parent_phone, parent_email,
              parent2_full_name, parent2_phone, parent2_email
         from public.pre_registrations
        where id = any($1::uuid[])`,
      [ids],
    );
    return new Map(rows.map((r) => [r.id, r]));
  }

  /**
   * `admin.from('profiles').select('id, school_id, role_id, is_deleted')
   *   .ilike('email', <kaçışlı>).limit(1).maybeSingle()` (service_role).
   * Desen çağırandan kaçışlı gelir (`escapeLikePattern`).
   */
  async profileByEmailPattern(
    c: PoolClient,
    pattern: string,
  ): Promise<ProfileByEmail | null> {
    const { rows } = await c.query<{
      id: string;
      school_id: string | null;
      role_id: string;
      is_deleted: boolean | null;
    }>(
      `select id, school_id, role_id, is_deleted from public.profiles
        where email ilike $1::text limit 1`,
      [pattern],
    );
    if (rows.length === 0) return null;
    return { ...rows[0], role_id: Number(rows[0].role_id) };
  }

  /** Davetli velinin profili (service_role), Edge'deki insert'in aynısı. */
  async insertParentProfile(
    c: PoolClient,
    row: {
      id: string;
      schoolId: string;
      fullName: string;
      email: string;
      phone: string | null;
    },
  ): Promise<void> {
    await c.query(
      `insert into public.profiles
              (id, school_id, full_name, email, phone_number, status, role_id)
       values ($1::uuid, $2::uuid, $3::text, $4::text, $5::text, 'active', 8)`,
      [row.id, row.schoolId, row.fullName, row.email, row.phone],
    );
  }

  /** Çağıranın rolüyle: rol, okul, şube, kilit ve yazım RPC'de. */
  async convert(
    c: PoolClient,
    preRegistrationId: string,
    parentIds: readonly string[],
  ): Promise<Envelope> {
    const { rows } = await c.query<{ r: Envelope | null }>(
      `select public.convert_pre_registration($1::uuid, $2::uuid[]) as r`,
      [preRegistrationId, parentIds],
    );
    return rows[0].r ?? {};
  }

  /** Sayma + kaydetme tek çağrıda (service_role). */
  async recordAttempt(c: PoolClient, ipHash: string): Promise<Envelope> {
    const { rows } = await c.query<{ r: Envelope | null }>(
      `select public.record_pre_registration_attempt(
                p_ip_hash => $1::text, p_school_id => null::uuid) as r`,
      [ipHash],
    );
    return rows[0].r ?? {};
  }
}

/**
 * ILIKE deseninde `\`, `%`, `_` kaçışlanır: e-postalarda geçerler ve
 * jokerdir; kaçırılmazsa `a_b@x.com` başka birinin `axb@x.com` hesabıyla
 * eşleşip çocuğu yanlış veliye bağlardı.
 */
export function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}
