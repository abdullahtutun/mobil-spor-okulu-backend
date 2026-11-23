import { Inject, Injectable } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { DB_POOL } from './db.tokens';

/** Supabase'teki üç istek rolü (AGENTS.md → K5). */
export const DB_ROLES = ['anon', 'authenticated', 'service_role'] as const;
export type DbRole = (typeof DB_ROLES)[number];

/**
 * Yalnızca auth modülünün geçtiği dar rol (0005_auth_service_role.sql):
 * auth.users / sessions / refresh_tokens. Hiçbir token bu role çözülmez.
 */
export const AUTH_SERVICE_ROLE = 'auth_service';
export type ContextRole = DbRole | typeof AUTH_SERVICE_ROLE;

/** `request.jwt.claims`'e yazılan JWT yükü (Supabase'in claim adlarıyla). */
export type JwtClaims = Record<string, unknown> & {
  role?: string;
  sub?: string;
};

export interface DbRequestContext {
  role: ContextRole;
  /** Verilmezse `{ role }`; PostgREST'in tokensız istekte yazdığıyla aynı. */
  claims?: JwtClaims;
  /** Milisaniye; verilmezse rolün varsayılanı (`STATEMENT_TIMEOUT_MS`). */
  statementTimeoutMs?: number;
}

/**
 * Rol başına sorgu süresi sınırı. Supabase'in varsayılanları: anon 3 sn,
 * authenticated 8 sn (yönetim uygulamasının AGENTS.md'si bu 8 sn'ye
 * dayanıyor: "Supabase cancels an authenticated query after 8 s").
 * service_role sunucunun kendi işleri (toplu aktarım, cron benzeri işler).
 */
export const STATEMENT_TIMEOUT_MS: Record<ContextRole, number> = {
  anon: 3_000,
  authenticated: 8_000,
  service_role: 60_000,
  auth_service: 5_000,
};

/**
 * Repository'lerin veritabanına tek kapısı.
 *
 * Her çağrı havuzdan bir bağlantı alır ve tek transaction açar:
 *
 *   begin;
 *   set local role <anon|authenticated|service_role>;
 *   select set_config('request.jwt.claims', '<json>', true),
 *          set_config('request.jwt.claim.sub', '<sub>', true),   -- eski biçim
 *          set_config('request.jwt.claim.role', '<rol>', true),  -- eski biçim
 *          set_config('statement_timeout', '<ms>', true);
 *   <iş>
 *   commit;   -- iş hata verirse rollback
 *
 * Böylece RLS, `auth.uid()` ve GRANT'ler Supabase'teki gibi çalışır.
 * Ayarların hepsi `local`: transaction bitince bağlantı havuza temiz döner;
 * bir sonraki istek önceki kullanıcının kimliğini ya da rolünü göremez.
 * Havuzun kendi kullanıcısı `api_authenticator`'dır (noinherit): rol
 * geçişi olmadan hiçbir tabloya erişemez.
 */
@Injectable()
export class DbContextService {
  constructor(@Inject(DB_POOL) private readonly pool: Pool) {}

  /** Sağlık kontrolü için: veritabanı sorguya cevap veriyor mu. */
  async ping(): Promise<void> {
    await this.pool.query('select 1');
  }

  async run<T>(
    context: DbRequestContext,
    work: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    // Rol SQL'e metin olarak girer (`set role` parametre almaz); yalnızca
    // bilinen üç addan biri olabilir.
    if (
      !(DB_ROLES as readonly string[]).includes(context.role) &&
      context.role !== AUTH_SERVICE_ROLE
    ) {
      throw new Error(`Bilinmeyen veritabanı rolü: ${String(context.role)}`);
    }
    const claims: JwtClaims = context.claims ?? { role: context.role };
    const timeout =
      context.statementTimeoutMs ?? STATEMENT_TIMEOUT_MS[context.role];

    const client = await this.pool.connect();
    let broken = false;
    try {
      await client.query('begin');
      try {
        await client.query(`set local role ${context.role}`);
        await client.query(
          `select set_config('request.jwt.claims', $1, true),
                  set_config('request.jwt.claim.sub', $2, true),
                  set_config('request.jwt.claim.role', $3, true),
                  set_config('statement_timeout', $4, true)`,
          [
            JSON.stringify(claims),
            typeof claims.sub === 'string' ? claims.sub : '',
            context.role,
            String(Math.max(0, Math.trunc(timeout))),
          ],
        );
        const result = await work(client);
        await client.query('commit');
        return result;
      } catch (error) {
        try {
          await client.query('rollback');
        } catch {
          // Bağlantı kopmuşsa rollback da başarısız olur; bağlantı havuza
          // geri verilmez, atılır.
          broken = true;
        }
        throw error;
      }
    } finally {
      client.release(broken);
    }
  }

  /**
   * Açık bir `run` transaction'ının içinde rolü değiştirir (`set local role`).
   * Yalnızca bir işin parçaları farklı rollerle ama **tek transaction'da**
   * yapılmak zorundaysa (ör. update-parent: çağıranın rolüyle profil, sonra
   * service_role ile hesap, sonra auth_service ile davet token'ı — biri
   * düşerse hepsi geri alınır). Claims değişmez.
   */
  async switchRole(client: PoolClient, role: ContextRole): Promise<void> {
    if (
      !(DB_ROLES as readonly string[]).includes(role) &&
      role !== AUTH_SERVICE_ROLE
    ) {
      throw new Error(`Bilinmeyen veritabanı rolü: ${String(role)}`);
    }
    await client.query(`set local role ${role}`);
  }

  /** Oturumsuz ya da sunucunun kendi işi. */
  withRole<T>(
    role: DbRole,
    work: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    return this.run({ role }, work);
  }

  /** Auth modülünün kendi işleri (giriş, oturum, refresh token). */
  asAuthService<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    return this.run({ role: AUTH_SERVICE_ROLE }, work);
  }

  /** Oturum açmış kullanıcı: `authenticated` + token'ın claim'leri. */
  withUser<T>(
    claims: JwtClaims,
    work: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    return this.run({ role: 'authenticated', claims }, work);
  }
}
