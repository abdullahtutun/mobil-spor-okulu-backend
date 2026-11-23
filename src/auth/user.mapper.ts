import type { IdentityRow, UserRow } from './auth.repository';
import type { TokenSubject } from './token/tokens';

/** Supabase'in `User` JSON'u (GoTrue `/user` ve token yanıtındaki `user`). */
export interface UserJson {
  id: string;
  aud: string;
  role: string;
  email: string;
  email_confirmed_at?: string;
  phone: string;
  phone_confirmed_at?: string;
  confirmation_sent_at?: string;
  recovery_sent_at?: string;
  invited_at?: string;
  confirmed_at?: string;
  last_sign_in_at?: string;
  app_metadata: Record<string, unknown>;
  user_metadata: Record<string, unknown>;
  identities: IdentityJson[];
  created_at: string;
  updated_at: string;
  is_anonymous: boolean;
}

export interface IdentityJson {
  identity_id: string;
  id: string;
  user_id: string;
  identity_data: Record<string, unknown>;
  provider: string;
  last_sign_in_at?: string;
  created_at?: string;
  updated_at?: string;
  email?: string;
}

const iso = (d: Date | null | undefined): string | undefined =>
  d ? d.toISOString() : undefined;

/**
 * GoTrue gibi: boş tarih alanları yanıta hiç girmez (Go'nun `omitempty`'si),
 * `phone` boşsa `""`. supabase-dart'ın `User.fromJson`'u da bu şekli okur.
 */
export function toUserJson(user: UserRow, identities: IdentityRow[]): UserJson {
  const json: UserJson = {
    id: user.id,
    aud: user.aud ?? 'authenticated',
    role: user.role ?? 'authenticated',
    email: user.email ?? '',
    email_confirmed_at: iso(user.email_confirmed_at),
    phone: user.phone ?? '',
    phone_confirmed_at: iso(user.phone_confirmed_at),
    confirmation_sent_at: iso(user.confirmation_sent_at),
    recovery_sent_at: iso(user.recovery_sent_at),
    invited_at: iso(user.invited_at),
    confirmed_at: iso(user.confirmed_at),
    last_sign_in_at: iso(user.last_sign_in_at),
    app_metadata: user.raw_app_meta_data ?? {},
    user_metadata: user.raw_user_meta_data ?? {},
    identities: identities.map(toIdentityJson),
    created_at: iso(user.created_at) ?? new Date(0).toISOString(),
    updated_at: iso(user.updated_at) ?? new Date(0).toISOString(),
    is_anonymous: user.is_anonymous,
  };
  for (const key of Object.keys(json) as (keyof UserJson)[]) {
    if (json[key] === undefined) delete json[key];
  }
  return json;
}

function toIdentityJson(identity: IdentityRow): IdentityJson {
  const json: IdentityJson = {
    identity_id: identity.id,
    id: identity.provider_id,
    user_id: identity.user_id,
    identity_data: identity.identity_data,
    provider: identity.provider,
    last_sign_in_at: iso(identity.last_sign_in_at),
    created_at: iso(identity.created_at),
    updated_at: iso(identity.updated_at),
    email: identity.email ?? undefined,
  };
  for (const key of Object.keys(json) as (keyof IdentityJson)[]) {
    if (json[key] === undefined) delete json[key];
  }
  return json;
}

export function toTokenSubject(user: UserRow): TokenSubject {
  return {
    id: user.id,
    email: user.email,
    phone: user.phone,
    app_metadata: user.raw_app_meta_data ?? {},
    user_metadata: user.raw_user_meta_data ?? {},
    is_anonymous: user.is_anonymous,
  };
}

/** Giriş ve yenileme kapalı mı: silinmiş ya da yasağı sürüyor. */
export function isLockedOut(user: UserRow, now: Date = new Date()): boolean {
  if (user.deleted_at !== null) return true;
  return user.banned_until !== null && user.banned_until > now;
}
