import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';

/** `auth.users`'ın auth modülünün okuduğu sütunları. */
export interface UserRow {
  id: string;
  aud: string | null;
  role: string | null;
  email: string | null;
  encrypted_password: string | null;
  email_confirmed_at: Date | null;
  invited_at: Date | null;
  confirmation_sent_at: Date | null;
  recovery_sent_at: Date | null;
  last_sign_in_at: Date | null;
  raw_app_meta_data: Record<string, unknown> | null;
  raw_user_meta_data: Record<string, unknown> | null;
  created_at: Date | null;
  updated_at: Date | null;
  phone: string | null;
  phone_confirmed_at: Date | null;
  confirmed_at: Date | null;
  banned_until: Date | null;
  deleted_at: Date | null;
  is_anonymous: boolean;
}

export interface IdentityRow {
  id: string;
  provider_id: string;
  user_id: string;
  identity_data: Record<string, unknown>;
  provider: string;
  last_sign_in_at: Date | null;
  created_at: Date | null;
  updated_at: Date | null;
  email: string | null;
}

export interface SessionRow {
  id: string;
  user_id: string;
  created_at: Date;
  not_after: Date | null;
}

export interface RefreshTokenRow {
  id: string;
  token: string;
  revoked: boolean;
  updated_at: Date;
  parent: string | null;
  session_id: string | null;
  user_id: string;
}

export interface ClientInfo {
  ip: string | null;
  userAgent: string | null;
}

const USER_COLUMNS = `
  id, aud, role, email, encrypted_password, email_confirmed_at, invited_at,
  confirmation_sent_at, recovery_sent_at, last_sign_in_at, raw_app_meta_data,
  raw_user_meta_data, created_at, updated_at, phone, phone_confirmed_at,
  confirmed_at, banned_until, deleted_at, is_anonymous`;

/** GoTrue'nun `instance_id`'si; Supabase'teki satırların hepsinde bu. */
const INSTANCE_ID = '00000000-0000-0000-0000-000000000000';

/**
 * Auth tablolarına tek kapı. Her metot çağıranın açtığı transaction'ın
 * istemcisini alır (`DbContextService.asAuthService`); birden çok adım tek
 * transaction'da kalsın diye.
 */
@Injectable()
export class AuthRepository {
  /**
   * GoTrue'nun `FindUserByEmailAndAudience`'ı: küçük harfle, SSO ve anonim
   * olmayan, `aud = authenticated`.
   */
  async findUserByEmail(c: PoolClient, email: string): Promise<UserRow | null> {
    const { rows } = await c.query<UserRow>(
      `select ${USER_COLUMNS} from auth.users
        where lower(email) = $1 and is_sso_user = false and is_anonymous = false
          and aud = 'authenticated'
        limit 1`,
      [email],
    );
    return rows[0] ?? null;
  }

  async findUserById(c: PoolClient, id: string): Promise<UserRow | null> {
    const { rows } = await c.query<UserRow>(
      `select ${USER_COLUMNS} from auth.users where id = $1`,
      [id],
    );
    return rows[0] ?? null;
  }

  async identitiesOf(c: PoolClient, userId: string): Promise<IdentityRow[]> {
    const { rows } = await c.query<IdentityRow>(
      `select id, provider_id, user_id, identity_data, provider,
              last_sign_in_at, created_at, updated_at, email
         from auth.identities where user_id = $1 order by created_at, id`,
      [userId],
    );
    return rows;
  }

  async touchLastSignIn(c: PoolClient, userId: string): Promise<Date> {
    const { rows } = await c.query<{ last_sign_in_at: Date }>(
      `update auth.users set last_sign_in_at = now(), updated_at = now()
        where id = $1 returning last_sign_in_at`,
      [userId],
    );
    return rows[0].last_sign_in_at;
  }

  async createSession(
    c: PoolClient,
    userId: string,
    client: ClientInfo,
  ): Promise<SessionRow> {
    const { rows } = await c.query<SessionRow>(
      `insert into auth.sessions (id, user_id, created_at, updated_at, aal, user_agent, ip)
       values (gen_random_uuid(), $1, now(), now(), 'aal1', $2, $3::inet)
       returning id, user_id, created_at, not_after`,
      [userId, client.userAgent, client.ip],
    );
    return rows[0];
  }

  /** Oturumu kilitler (aynı oturumda eşzamanlı yenilemeler sıraya girer). */
  async lockSession(c: PoolClient, id: string): Promise<SessionRow | null> {
    const { rows } = await c.query<SessionRow>(
      `select id, user_id, created_at, not_after from auth.sessions
        where id = $1 for update`,
      [id],
    );
    return rows[0] ?? null;
  }

  async findSession(
    c: PoolClient,
    id: string,
    userId: string,
  ): Promise<SessionRow | null> {
    const { rows } = await c.query<SessionRow>(
      `select id, user_id, created_at, not_after from auth.sessions
        where id = $1 and user_id = $2`,
      [id, userId],
    );
    return rows[0] ?? null;
  }

  async touchSession(
    c: PoolClient,
    id: string,
    client: ClientInfo,
  ): Promise<void> {
    await c.query(
      `update auth.sessions
          set refreshed_at = (now() at time zone 'utc'), updated_at = now(),
              user_agent = coalesce($2, user_agent), ip = coalesce($3::inet, ip)
        where id = $1`,
      [id, client.userAgent, client.ip],
    );
  }

  async insertRefreshToken(
    c: PoolClient,
    args: {
      hash: string;
      userId: string;
      sessionId: string;
      parent: string | null;
    },
  ): Promise<void> {
    await c.query(
      `insert into auth.refresh_tokens
         (instance_id, token, user_id, revoked, created_at, updated_at, parent, session_id)
       values ($1, $2, $3, false, now(), now(), $4, $5)`,
      [INSTANCE_ID, args.hash, args.userId, args.parent, args.sessionId],
    );
  }

  async findRefreshToken(
    c: PoolClient,
    hash: string,
  ): Promise<RefreshTokenRow | null> {
    const { rows } = await c.query<RefreshTokenRow>(
      `select id::text, token, coalesce(revoked, false) as revoked, updated_at,
              parent, session_id, user_id
         from auth.refresh_tokens where token = $1`,
      [hash],
    );
    return rows[0] ?? null;
  }

  /** Oturumun geçerli (iptal edilmemiş, en yeni) token'ı. */
  async activeRefreshToken(
    c: PoolClient,
    sessionId: string,
  ): Promise<RefreshTokenRow | null> {
    const { rows } = await c.query<RefreshTokenRow>(
      `select id::text, token, coalesce(revoked, false) as revoked, updated_at,
              parent, session_id, user_id
         from auth.refresh_tokens
        where session_id = $1 and revoked is not true
        order by id desc limit 1`,
      [sessionId],
    );
    return rows[0] ?? null;
  }

  async revokeRefreshToken(c: PoolClient, id: string): Promise<void> {
    await c.query(
      `update auth.refresh_tokens set revoked = true, updated_at = now() where id = $1`,
      [id],
    );
  }

  /** Oturumu siler; refresh token'ları `on delete cascade` ile gider. */
  async deleteSession(c: PoolClient, id: string): Promise<void> {
    await c.query(`delete from auth.sessions where id = $1`, [id]);
  }

  async deleteSessions(
    c: PoolClient,
    userId: string,
    scope: 'global' | 'local' | 'others',
    sessionId: string | null,
  ): Promise<number> {
    if (scope === 'global') {
      const r = await c.query(`delete from auth.sessions where user_id = $1`, [
        userId,
      ]);
      return r.rowCount ?? 0;
    }
    if (sessionId === null) return 0;
    const r = await c.query(
      scope === 'local'
        ? `delete from auth.sessions where user_id = $1 and id = $2`
        : `delete from auth.sessions where user_id = $1 and id <> $2`,
      [userId, sessionId],
    );
    return r.rowCount ?? 0;
  }

  async updatePassword(
    c: PoolClient,
    userId: string,
    hash: string,
  ): Promise<void> {
    await c.query(
      `update auth.users set encrypted_password = $2, updated_at = now() where id = $1`,
      [userId, hash],
    );
  }

  /**
   * GoTrue'nun `UpdateUserMetaData`'sı: anahtarlar birleştirilir, `null`
   * değerli anahtar silinir.
   */
  async mergeUserMetadata(
    c: PoolClient,
    userId: string,
    data: Record<string, unknown>,
  ): Promise<void> {
    const removed = Object.keys(data).filter((k) => data[k] === null);
    const merged = Object.fromEntries(
      Object.entries(data).filter(([, v]) => v !== null),
    );
    await c.query(
      `update auth.users
          set raw_user_meta_data =
                (coalesce(raw_user_meta_data, '{}'::jsonb) || $2::jsonb) - $3::text[],
              updated_at = now()
        where id = $1`,
      [userId, JSON.stringify(merged), removed],
    );
  }
}
