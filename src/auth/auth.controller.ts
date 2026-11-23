import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
  Put,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { ApiException } from '../common/errors/api-error';
import { authError } from './auth.errors';
import type { ClientInfo } from './auth.repository';
import {
  AuthService,
  type LogoutScope,
  type SessionResponse,
  type TokenIdentity,
} from './auth.service';
import { JwtVerifier } from './request/jwt-verifier.service';
import type { UserJson } from './user.mapper';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const passwordGrant = z.object({
  email: z.string().trim().min(1).max(255),
  password: z.string().min(1).max(1024),
});
const refreshGrant = z.object({
  refresh_token: z.string().min(1).max(255),
});
const logoutScope = z.enum(['global', 'local', 'others']);
const updateUserBody = z
  .object({
    password: z.string().max(1024).optional(),
    data: z.record(z.string(), z.unknown()).optional(),
  })
  // E-posta / telefon değişikliği yok: hiçbir uygulama kullanmıyor ve
  // yönetim uygulamasının send-email kancası email_change'i bilerek
  // reddediyor (AGENTS.md → "Brands").
  .strict();

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw authError(
      HttpStatus.BAD_REQUEST,
      'validation_failed',
      result.error.issues
        .map((i) => `${i.path.join('.') || '(gövde)'}: ${i.message}`)
        .join('; '),
    );
  }
  return result.data;
}

/**
 * GoTrue'nun `/auth/v1/*` uçlarının karşılığı (S05; sözleşme
 * `docs/api/auth.md`). `RequestAuthGuard` kullanılmaz: token uçlarında
 * token yok, logout süresi geçmiş token'ı da kabul eder, `/user` anon'u
 * `no_authorization` ile reddeder (guard anon'u geçirirdi).
 */
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly verifier: JwtVerifier,
  ) {}

  @Post('token')
  @HttpCode(200)
  async token(
    @Query('grant_type') grantType: string | undefined,
    @Body() body: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SessionResponse> {
    const client = clientInfo(req);
    try {
      if (grantType === 'password') {
        const { email, password } = parse(passwordGrant, body ?? {});
        return await this.auth.signInWithPassword(email, password, client);
      }
      if (grantType === 'refresh_token') {
        const { refresh_token } = parse(refreshGrant, body ?? {});
        return await this.auth.refresh(refresh_token, client);
      }
    } catch (error) {
      const retryAfter = (error as { retryAfterSec?: number }).retryAfterSec;
      if (error instanceof ApiException && retryAfter !== undefined) {
        res.setHeader('Retry-After', String(retryAfter));
      }
      throw error;
    }
    throw authError(
      HttpStatus.BAD_REQUEST,
      'unsupported_grant_type',
      'grant_type password ya da refresh_token olmalı.',
    );
  }

  /** Kapsam sorguda (`?scope=`, supabase-dart böyle gönderir) ya da gövdede. */
  @Post('logout')
  @HttpCode(204)
  async logout(
    @Headers('authorization') authorization: string | undefined,
    @Query('scope') queryScope: string | undefined,
    @Body() body: unknown,
  ): Promise<void> {
    const identity = this.identity(authorization, { ignoreExpiration: true });
    const bodyScope = (body as { scope?: unknown } | undefined)?.scope;
    const scope: LogoutScope = parse(
      logoutScope.default('global'),
      queryScope ?? bodyScope,
    );
    await this.auth.logout(identity, scope);
  }

  @Get('user')
  getUser(
    @Headers('authorization') authorization: string | undefined,
  ): Promise<UserJson> {
    return this.auth.getUser(this.identity(authorization));
  }

  @Put('user')
  updateUser(
    @Headers('authorization') authorization: string | undefined,
    @Body() body: unknown,
  ): Promise<UserJson> {
    const identity = this.identity(authorization);
    return this.auth.updateUser(identity, parse(updateUserBody, body ?? {}));
  }

  private identity(
    authorization: string | undefined,
    options: { ignoreExpiration?: boolean } = {},
  ): TokenIdentity {
    const auth = this.verifier.fromAuthorizationHeader(authorization, options);
    if (auth.role !== 'authenticated') {
      throw authError(
        HttpStatus.UNAUTHORIZED,
        'no_authorization',
        'This endpoint requires a valid Bearer token',
      );
    }
    const sessionId = auth.claims.session_id;
    return {
      userId: auth.claims.sub as string,
      sessionId:
        typeof sessionId === 'string' && UUID.test(sessionId)
          ? sessionId
          : null,
    };
  }
}

/** Oturum satırına yazılan istemci bilgisi (IP `trust proxy`'ye göre). */
function clientInfo(req: Request): ClientInfo {
  const ua = req.headers['user-agent'];
  return {
    ip: normalizeIp(req.ip),
    userAgent: typeof ua === 'string' && ua !== '' ? ua.slice(0, 512) : null,
  };
}

function normalizeIp(ip: string | undefined): string | null {
  if (!ip) return null;
  // IPv4'ün IPv6 gösterimi (::ffff:1.2.3.4) düz IPv4'e: aynı istemci tek anahtar.
  const v4 = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  return v4 ? v4[1] : ip;
}
