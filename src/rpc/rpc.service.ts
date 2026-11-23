import { HttpStatus, Injectable } from '@nestjs/common';
import type { RequestAuth } from '../auth/request/jwt-verifier.service';
import { ApiException } from '../common/errors/api-error';
import {
  isPgError,
  pgErrorToApiException,
} from '../common/errors/pg-error.mapper';
import { DbContextService } from '../db/db-context.service';
import { allowEntry } from './rpc-allowlist';
import { buildCallSql, matchSignature } from './rpc-call';
import { RpcCatalog } from './rpc-catalog.service';

/**
 * `POST /rpc/:name`'in işi: allow-list → imza → isteğin rolüyle tek
 * transaction'da çağrı → PostgREST'in döndürdüğü JSON.
 */
@Injectable()
export class RpcService {
  constructor(
    private readonly catalog: RpcCatalog,
    private readonly db: DbContextService,
  ) {}

  async call(name: string, body: unknown, auth: RequestAuth): Promise<unknown> {
    const args = argsOf(body);
    const keys = Object.keys(args);

    // Allow-list'te olmayan fonksiyon, veritabanında olsa da "yok"tur.
    const entry = allowEntry(name);
    if (!entry) throw notFound(name, keys);

    // Rol kapısı: veritabanının EXECUTE yetkisiyle aynı cevabı verir
    // (oturumsuz 401, oturumlu 403 — PostgREST'in 42501 eşlemesi).
    if (!entry.callers.includes(auth.role)) {
      throw ApiException.of(
        auth.role === 'anon' ? HttpStatus.UNAUTHORIZED : HttpStatus.FORBIDDEN,
        '42501',
        `permission denied for function ${name}`,
        { details: null, hint: null },
      );
    }

    const { match, ambiguous } = matchSignature(this.catalog.find(name), keys);
    if (ambiguous) {
      throw ApiException.of(
        HttpStatus.AMBIGUOUS,
        'PGRST203',
        `Could not choose the best candidate function between overloads of public.${name}`,
        { details: null, hint: null },
      );
    }
    if (!match) throw notFound(name, keys);

    const sql = buildCallSql(match, keys);
    const values = keys.length > 0 ? [JSON.stringify(args)] : [];
    try {
      return await this.db.run(
        { role: auth.role, claims: auth.claims },
        async (client) => {
          const { rows } = await client.query<{ result: unknown }>(sql, values);
          return rows[0]?.result ?? null;
        },
      );
    } catch (error) {
      if (isPgError(error)) {
        throw pgErrorToApiException(error, auth.role === 'authenticated');
      }
      throw error;
    }
  }
}

/**
 * Gövde: parametre adları → değerler. Boş gövde parametresiz çağrıdır.
 * Nesne olmayan gövde (dizi, metin) PostgREST'te de 400'dür.
 */
function argsOf(body: unknown): Record<string, unknown> {
  if (body === undefined || body === null) return {};
  if (typeof body !== 'object' || Array.isArray(body)) {
    throw ApiException.of(
      HttpStatus.BAD_REQUEST,
      'PGRST102',
      'RPC gövdesi parametre adlarından oluşan bir JSON nesnesi olmalı.',
      { details: null, hint: null },
    );
  }
  return body as Record<string, unknown>;
}

/** PostgREST'in "fonksiyon şema önbelleğinde yok" cevabı (404 PGRST202). */
function notFound(name: string, keys: readonly string[]): ApiException {
  const params = [...keys].sort().join(', ');
  return ApiException.of(
    HttpStatus.NOT_FOUND,
    'PGRST202',
    `Could not find the function public.${name}(${params}) in the schema cache`,
    {
      details: `Searched for the function public.${name} with parameters ${params || '(none)'}, but no matches were found in the schema cache.`,
      hint: null,
    },
  );
}
