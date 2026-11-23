import { Inject, Injectable } from '@nestjs/common';
import type { Pool } from 'pg';
import { DB_POOL } from './db.tokens';

/** Supabase'teki üç istek rolü (AGENTS.md → K5). */
export type DbRole = 'anon' | 'authenticated' | 'service_role';

/**
 * Repository'lerin veritabanına tek kapısı.
 *
 * İSKELET — S04 doldurur. Plan: her çağrı tek transaction açar, önce
 * `set local role <rol>` ve
 * `select set_config('request.jwt.claims', <claims>, true)` çalıştırır,
 * sonra verilen işi aynı bağlantıda yürütür. Böylece RLS ve `auth.uid()`
 * Supabase'teki gibi çalışır.
 *
 *   withRole(role, work)          anon / service_role istekleri
 *   withUser(claims, work)        oturum açmış kullanıcı (authenticated)
 */
@Injectable()
export class DbContextService {
  constructor(@Inject(DB_POOL) private readonly pool: Pool) {}

  /** Sağlık kontrolü için: veritabanı sorguya cevap veriyor mu. */
  async ping(): Promise<void> {
    await this.pool.query('select 1');
  }
}
