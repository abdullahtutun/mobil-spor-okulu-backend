import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import jwt from 'jsonwebtoken';
import { ApiException } from '../../common/errors/api-error';
import { APP_CONFIG } from '../../config/config.module';
import type { AppConfig } from '../../config/env.schema';
import type { JwtClaims } from '../../db/db-context.service';

/** Bir isteğin veritabanında kim olarak çalışacağı. */
export interface RequestAuth {
  /** Dışarıdan yalnızca bu ikisi gelebilir; service_role yalnızca sunucu içi. */
  role: 'anon' | 'authenticated';
  claims: JwtClaims;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `Authorization: Bearer <jwt>` başlığını isteğin rolüne çevirir.
 *
 * - Başlık yok → `anon`, claims `{ role: 'anon' }` (PostgREST'in tokensız
 *   isteği).
 * - HS256 + `JWT_SECRET` ile imzalı, süresi geçmemiş token:
 *   - `role = authenticated` → `aud` `authenticated` içermeli, `sub` bir
 *     UUID olmalı → `authenticated`; claims token'ın yükü olduğu gibi
 *     (`auth.jwt()` Supabase'teki gibi tam yükü görür).
 *   - `role = anon` → `anon` (Supabase'in anon anahtarı böyle bir token;
 *     supabase-dart oturum yokken onu gönderir).
 *   - başka her rol (özellikle `service_role`) → 401. Supabase'te
 *     service_role anahtarı RLS'i aşar; bizde o rol yalnızca sunucunun kendi
 *     servislerinde (`DbContextService.withRole('service_role', …)`) vardır,
 *     dışarıdan gelen bir token onu açamaz.
 *
 * Hata gövdeleri PostgREST'inkiyle aynı kodlarla: imza/biçim `PGRST301`,
 * süre ve claim doğrulaması `PGRST303`. Uygulamaların `SessionRetryClient`'ı
 * 401 + bu kodları "token reddedildi, yenile ve tekrar dene" diye okur.
 */
@Injectable()
export class JwtVerifier {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  fromAuthorizationHeader(header: string | undefined): RequestAuth {
    if (header === undefined || header.trim() === '') {
      return { role: 'anon', claims: { role: 'anon' } };
    }
    const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
    if (!match) {
      throw invalid(
        'PGRST301',
        'Authorization başlığı "Bearer <token>" olmalı.',
      );
    }
    return this.verify(match[1]);
  }

  verify(token: string): RequestAuth {
    let payload: string | jwt.JwtPayload;
    try {
      payload = jwt.verify(token, this.config.JWT_SECRET, {
        // Algoritma sabit: `none` ya da RS/HS karışıklığı kabul edilmez.
        algorithms: ['HS256'],
      });
    } catch (error) {
      if (error instanceof jwt.TokenExpiredError) {
        throw invalid('PGRST303', 'JWT expired');
      }
      throw invalid('PGRST301', 'JWT doğrulanamadı.');
    }
    if (typeof payload !== 'object' || payload === null) {
      throw invalid('PGRST301', 'JWT yükü bir nesne değil.');
    }

    const claims = payload as JwtClaims;
    if (claims.role === 'anon') return { role: 'anon', claims };

    if (claims.role !== 'authenticated') {
      throw invalid('PGRST303', 'JWT rolü kabul edilmiyor.');
    }
    const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!audiences.includes('authenticated')) {
      throw invalid('PGRST303', 'JWT aud authenticated değil.');
    }
    if (typeof claims.sub !== 'string' || !UUID.test(claims.sub)) {
      throw invalid('PGRST303', 'JWT sub geçerli bir kullanıcı kimliği değil.');
    }
    return { role: 'authenticated', claims };
  }
}

function invalid(code: 'PGRST301' | 'PGRST303', message: string): ApiException {
  return ApiException.of(HttpStatus.UNAUTHORIZED, code, message, {
    details: null,
    hint: null,
  });
}
