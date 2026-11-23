import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import {
  AuthRepository,
  type ClientInfo,
  type SessionRow,
  type UserRow,
} from '../auth.repository';
import { AccessTokenIssuer, newRefreshToken } from '../token/tokens';
import { toTokenSubject, toUserJson, type UserJson } from '../user.mapper';

/** `POST /auth/token` ve `POST /auth/verify` yanıtı — GoTrue'nun `AccessTokenResponse`'u. */
export interface SessionResponse {
  access_token: string;
  token_type: 'bearer';
  expires_in: number;
  expires_at: number;
  refresh_token: string;
  user: UserJson;
}

/**
 * Oturum açan her akışın ortak sonu (S05'te `signInWithPassword`'un içindeydi;
 * S06'nın verify uçları da kullanır): `last_sign_in_at`, yeni `auth.sessions`
 * satırı, ilk refresh token, access token ve yanıt. Çağıranın
 * transaction'ında (`asAuthService`) çalışır.
 */
@Injectable()
export class SessionOpener {
  constructor(
    private readonly repo: AuthRepository,
    private readonly tokens: AccessTokenIssuer,
  ) {}

  async open(
    c: PoolClient,
    user: UserRow,
    client: ClientInfo,
  ): Promise<SessionResponse> {
    const lastSignIn = await this.repo.touchLastSignIn(c, user.id);
    const session = await this.repo.createSession(c, user.id, client);
    const refresh = newRefreshToken();
    await this.repo.insertRefreshToken(c, {
      hash: refresh.hash,
      userId: user.id,
      sessionId: session.id,
      parent: null,
    });
    const fresh = { ...user, last_sign_in_at: lastSignIn };
    return this.respond(c, fresh, session, refresh.token);
  }

  async respond(
    c: PoolClient,
    user: UserRow,
    session: SessionRow,
    refreshToken: string,
  ): Promise<SessionResponse> {
    const access = this.tokens.issue(
      toTokenSubject(user),
      session.id,
      Math.floor(session.created_at.getTime() / 1000),
    );
    return {
      access_token: access.token,
      token_type: 'bearer',
      expires_in: access.expiresIn,
      expires_at: access.expiresAt,
      refresh_token: refreshToken,
      user: toUserJson(user, await this.repo.identitiesOf(c, user.id)),
    };
  }
}
