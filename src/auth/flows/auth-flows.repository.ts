import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type { UserRow } from '../auth.repository';
import type { OtpKind } from '../otp/otp-codes';

const USER_COLUMNS = `
  id, aud, role, email, encrypted_password, email_confirmed_at, invited_at,
  confirmation_sent_at, recovery_sent_at, last_sign_in_at, raw_app_meta_data,
  raw_user_meta_data, created_at, updated_at, phone, phone_confirmed_at,
  confirmed_at, banned_until, deleted_at, is_anonymous`;

/** GoTrue'nun `instance_id`'si; Supabase'teki satırların hepsinde bu. */
const INSTANCE_ID = '00000000-0000-0000-0000-000000000000';

/** Kod/davet akışlarının okuduğu ek sütunlar. */
export interface TokenUserRow extends UserRow {
  confirmation_token: string | null;
  recovery_token: string | null;
}

/** Hangi sütun çifti: kod türü → (token, gönderilme zamanı). */
const TOKEN_COLUMNS: Record<OtpKind, { token: string; sentAt: string }> = {
  recovery_token: { token: 'recovery_token', sentAt: 'recovery_sent_at' },
  confirmation_token: {
    token: 'confirmation_token',
    sentAt: 'confirmation_sent_at',
  },
};

export interface NewUser {
  email: string;
  /** bcrypt hash'i; davet edilen hesapta `''` (GoTrue gibi). */
  encryptedPassword: string;
  userMetadata: Record<string, unknown>;
  confirmed: boolean;
  invited: boolean;
}

/**
 * Kayıt, davet, kod ve admin işlemlerinin SQL'i (S06). Hepsi çağıranın
 * `asAuthService` transaction'ında çalışır.
 */
@Injectable()
export class AuthFlowsRepository {
  /**
   * E-postayla kullanıcıyı kilitler (aynı adrese eşzamanlı kayıt/doğrulama
   * sıraya girer). `AuthRepository.findUserByEmail` ile aynı süzgeç.
   */
  async lockUserByEmail(
    c: PoolClient,
    email: string,
  ): Promise<TokenUserRow | null> {
    const { rows } = await c.query<TokenUserRow>(
      `select ${USER_COLUMNS}, confirmation_token, recovery_token
         from auth.users
        where lower(email) = $1 and is_sso_user = false and is_anonymous = false
          and aud = 'authenticated'
        limit 1
        for update`,
      [email],
    );
    return rows[0] ?? null;
  }

  async lockUserById(c: PoolClient, id: string): Promise<TokenUserRow | null> {
    const { rows } = await c.query<TokenUserRow>(
      `select ${USER_COLUMNS}, confirmation_token, recovery_token
         from auth.users where id = $1 for update`,
      [id],
    );
    return rows[0] ?? null;
  }

  /**
   * Davet token'ıyla kullanıcı. `legacy`: Supabase'in gönderdiği bağlantı
   * (saklı değerin kendisi, 56 karakter sha224 hex) — yalnızca o biçimdeki
   * satırlar düz karşılaştırılır.
   */
  async lockUserByInviteToken(
    c: PoolClient,
    hash: string,
    legacy: string | null,
  ): Promise<TokenUserRow | null> {
    const { rows } = await c.query<TokenUserRow>(
      `select ${USER_COLUMNS}, confirmation_token, recovery_token
         from auth.users
        where confirmation_token = $1
           or ($2::text is not null and length(confirmation_token) = 56
               and confirmation_token = $2)
        limit 1
        for update`,
      [hash, legacy],
    );
    return rows[0] ?? null;
  }

  /**
   * GoTrue'nun yazdığı biçimde yeni kullanıcı + e-posta kimliği.
   * `user_metadata` = verilen veri + GoTrue'nun kimlik alanları (`sub`,
   * `email`, `email_verified`, `phone_verified`) — canlıdaki kayıtlarda da
   * böyle. Insert `handle_new_user` trigger'ını tetikler (kurucu kaydı
   * profil açar).
   */
  async insertUser(c: PoolClient, user: NewUser): Promise<TokenUserRow> {
    const id = randomUUID();
    const identityData = {
      ...user.userMetadata,
      sub: id,
      email: user.email,
      email_verified: user.confirmed,
      phone_verified: false,
    };
    const { rows } = await c.query<TokenUserRow>(
      `insert into auth.users (
         instance_id, id, aud, role, email, encrypted_password,
         email_confirmed_at, invited_at, raw_app_meta_data, raw_user_meta_data,
         created_at, updated_at, confirmation_token, recovery_token,
         email_change_token_new, email_change, email_change_token_current,
         phone_change, phone_change_token, reauthentication_token,
         is_sso_user, is_anonymous)
       values ($1, $7, 'authenticated', 'authenticated', $2, $3,
         case when $4 then now() end, case when $5 then now() end,
         '{"provider":"email","providers":["email"]}'::jsonb, $6::jsonb,
         now(), now(), '', '', '', '', '', '', '', '', false, false)
       returning ${USER_COLUMNS}, confirmation_token, recovery_token`,
      [
        INSTANCE_ID,
        user.email,
        user.encryptedPassword,
        user.confirmed,
        user.invited,
        JSON.stringify(identityData),
        id,
      ],
    );
    const row = rows[0];
    // GoTrue'nun e-posta kimliği: provider_id = kullanıcı id'si.
    await c.query(
      `insert into auth.identities (provider_id, user_id, identity_data, provider,
                                    last_sign_in_at, created_at, updated_at)
       values ($1::text, $1::uuid, $2::jsonb, 'email', now(), now(), now())`,
      [row.id, JSON.stringify(identityData)],
    );
    return row;
  }

  /**
   * Yeni kod/davet token'ını yazar: `auth.users`'taki GoTrue sütunu +
   * `auth.one_time_tokens` satırı; eski kod geçersiz, deneme sayacı sıfır.
   */
  async setToken(
    c: PoolClient,
    userId: string,
    email: string,
    kind: OtpKind,
    hash: string,
  ): Promise<void> {
    const col = TOKEN_COLUMNS[kind];
    await c.query(
      `update auth.users set ${col.token} = $2, ${col.sentAt} = now(), updated_at = now()
        where id = $1`,
      [userId, hash],
    );
    await c.query(
      `insert into auth.one_time_tokens (id, user_id, token_type, token_hash, relates_to)
       values (gen_random_uuid(), $1, $2::auth.one_time_token_type, $3, $4)
       on conflict (user_id, token_type) do update
         set token_hash = excluded.token_hash, relates_to = excluded.relates_to,
             created_at = now(), updated_at = now()`,
      [userId, kind, hash, email],
    );
    await c.query(
      `delete from auth.otp_attempts where user_id = $1 and token_type = $2::auth.one_time_token_type`,
      [userId, kind],
    );
  }

  /** Kodu siler (kullanıldı, süresi doldu ya da çok yanlış deneme). */
  async clearToken(
    c: PoolClient,
    userId: string,
    kind: OtpKind,
  ): Promise<void> {
    const col = TOKEN_COLUMNS[kind];
    await c.query(
      `update auth.users set ${col.token} = '', updated_at = now() where id = $1`,
      [userId],
    );
    await c.query(
      `delete from auth.one_time_tokens where user_id = $1 and token_type = $2::auth.one_time_token_type`,
      [userId, kind],
    );
    await c.query(
      `delete from auth.otp_attempts where user_id = $1 and token_type = $2::auth.one_time_token_type`,
      [userId, kind],
    );
  }

  /** Yanlış denemeyi sayar; toplam sayıyı döner. */
  async recordFailure(
    c: PoolClient,
    userId: string,
    kind: OtpKind,
  ): Promise<number> {
    const { rows } = await c.query<{ failed_count: number }>(
      `insert into auth.otp_attempts (user_id, token_type, failed_count, updated_at)
       values ($1, $2::auth.one_time_token_type, 1, now())
       on conflict (user_id, token_type) do update
         set failed_count = auth.otp_attempts.failed_count + 1, updated_at = now()
       returning failed_count`,
      [userId, kind],
    );
    return rows[0].failed_count;
  }

  /**
   * E-postayı onaylar (GoTrue: kod/davet doğrulanınca). `email_verified`
   * metadata'da ve kimlikte de `true` olur.
   */
  async confirmEmail(c: PoolClient, userId: string): Promise<void> {
    await c.query(
      `update auth.users
          set email_confirmed_at = coalesce(email_confirmed_at, now()),
              raw_user_meta_data = case
                when raw_user_meta_data ? 'email_verified'
                  then raw_user_meta_data || '{"email_verified": true}'::jsonb
                else raw_user_meta_data end,
              updated_at = now()
        where id = $1`,
      [userId],
    );
    await c.query(
      `update auth.identities
          set identity_data = identity_data || '{"email_verified": true}'::jsonb,
              updated_at = now()
        where user_id = $1 and provider = 'email'`,
      [userId],
    );
  }

  /** Onaysız kayıt yeniden yapılınca: yeni şifre, metadata birleşir. */
  async updateUnconfirmedSignup(
    c: PoolClient,
    userId: string,
    encryptedPassword: string,
    data: Record<string, unknown>,
  ): Promise<void> {
    await c.query(
      `update auth.users
          set encrypted_password = $2,
              raw_user_meta_data = coalesce(raw_user_meta_data, '{}'::jsonb) || $3::jsonb,
              updated_at = now()
        where id = $1`,
      [userId, encryptedPassword, JSON.stringify(data)],
    );
  }

  /** Yeniden davet: metadata birleşir, `invited_at` yenilenir. */
  async markInvited(
    c: PoolClient,
    userId: string,
    data: Record<string, unknown>,
  ): Promise<void> {
    await c.query(
      `update auth.users
          set invited_at = now(),
              raw_user_meta_data = coalesce(raw_user_meta_data, '{}'::jsonb) || $2::jsonb,
              updated_at = now()
        where id = $1`,
      [userId, JSON.stringify(data)],
    );
  }

  // ── admin (S09) ─────────────────────────────────────────────────────────

  async updateEmail(
    c: PoolClient,
    userId: string,
    email: string,
  ): Promise<void> {
    await c.query(
      `update auth.users set email = $2, updated_at = now() where id = $1`,
      [userId, email],
    );
    await c.query(
      `update auth.identities
          set identity_data = identity_data || jsonb_build_object('email', $2::text),
              updated_at = now()
        where user_id = $1 and provider = 'email'`,
      [userId, email],
    );
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

  async setBannedUntil(
    c: PoolClient,
    userId: string,
    until: Date | null,
  ): Promise<void> {
    await c.query(
      `update auth.users set banned_until = $2, updated_at = now() where id = $1`,
      [userId, until],
    );
  }

  /** Satırı siler; kimlikler, oturumlar, token'lar ve profil cascade ile gider. */
  async deleteUser(c: PoolClient, userId: string): Promise<boolean> {
    const r = await c.query(`delete from auth.users where id = $1`, [userId]);
    return (r.rowCount ?? 0) > 0;
  }
}
