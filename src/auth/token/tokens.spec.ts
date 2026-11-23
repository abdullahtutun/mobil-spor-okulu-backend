import type { AppConfig } from '../../config/env.schema';
import { JwtVerifier } from '../request/jwt-verifier.service';
import { AccessTokenIssuer, hashRefreshToken, newRefreshToken } from './tokens';

const config = {
  JWT_SECRET: 'birim-test-icin-en-az-otuz-iki-karakterlik',
  JWT_EXPIRY_SEC: 3600,
  JWT_ISSUER: 'test-iss',
} as AppConfig;
const USER = 'a0000000-0000-4000-8000-0000000000a8';
const SESSION = '00000000-0000-4000-8000-00000000abcd';

describe('AccessTokenIssuer', () => {
  it('Supabase claim adlarıyla HS256 token; JwtVerifier authenticated sayar', () => {
    const issued = new AccessTokenIssuer(config).issue(
      {
        id: USER,
        email: 'veli@a.test',
        phone: null,
        app_metadata: { provider: 'email', providers: ['email'] },
        user_metadata: { brand: 'dev_adim' },
        is_anonymous: false,
      },
      SESSION,
      1_700_000_000,
    );
    expect(issued.expiresIn).toBe(3600);
    const auth = new JwtVerifier(config).verify(issued.token);
    expect(auth.role).toBe('authenticated');
    expect(auth.claims).toMatchObject({
      iss: 'test-iss',
      sub: USER,
      aud: 'authenticated',
      role: 'authenticated',
      email: 'veli@a.test',
      phone: '',
      session_id: SESSION,
      aal: 'aal1',
      amr: [{ method: 'password', timestamp: 1_700_000_000 }],
      user_metadata: { brand: 'dev_adim' },
      app_metadata: { provider: 'email', providers: ['email'] },
      is_anonymous: false,
      exp: issued.expiresAt,
    });
    expect((auth.claims.exp as number) - (auth.claims.iat as number)).toBe(
      3600,
    );
  });
});

describe('refresh token', () => {
  it('43 karakter base64url, her seferinde farklı; hash sha256 hex', () => {
    const a = newRefreshToken();
    const b = newRefreshToken();
    expect(a.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a.token).not.toBe(b.token);
    expect(a.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hashRefreshToken(a.token)).toBe(a.hash);
    expect(a.hash).not.toContain(a.token);
  });
});
