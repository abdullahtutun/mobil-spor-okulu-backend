import jwt from 'jsonwebtoken';
import { TEST_JWT_SECRET } from './app';

/**
 * Test için token. Token üretimi S05'te; buradaki yük Supabase GoTrue'nun
 * access token'ıyla aynı alanları taşır (gerçek bir Supabase token'ından
 * alınan claim adları), böylece "Supabase'in ürettiği token da kabul
 * edilir" sınanır.
 */
export function supabaseUserToken(
  sub: string,
  options: {
    secret?: string;
    expiresInSec?: number;
    overrides?: Record<string, unknown>;
  } = {},
): string {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: 'https://gcmeltwnryjscinptecb.supabase.co/auth/v1',
    sub,
    aud: 'authenticated',
    exp: now + (options.expiresInSec ?? 3600),
    iat: now,
    email: 'kullanici@a.test',
    phone: '',
    app_metadata: { provider: 'email', providers: ['email'] },
    user_metadata: { brand: 'dev_adim', email_verified: true },
    role: 'authenticated',
    aal: 'aal1',
    amr: [{ method: 'password', timestamp: now }],
    session_id: '00000000-0000-4000-8000-00000000abcd',
    is_anonymous: false,
    ...options.overrides,
  };
  return jwt.sign(payload, options.secret ?? TEST_JWT_SECRET, {
    algorithm: 'HS256',
    header: { alg: 'HS256', typ: 'JWT', kid: 'test' },
  });
}

/** Supabase'in proje anon anahtarının biçimi. */
export function supabaseAnonKey(secret = TEST_JWT_SECRET): string {
  const now = Math.floor(Date.now() / 1000);
  return jwt.sign(
    {
      iss: 'supabase',
      ref: 'gcmeltwnryjscinptecb',
      role: 'anon',
      iat: now,
      exp: now + 10 * 365 * 24 * 3600,
    },
    secret,
    { algorithm: 'HS256' },
  );
}

/** Supabase'in service_role anahtarının biçimi — dışarıdan kabul edilmemeli. */
export function supabaseServiceRoleKey(secret = TEST_JWT_SECRET): string {
  const now = Math.floor(Date.now() / 1000);
  return jwt.sign(
    {
      iss: 'supabase',
      ref: 'gcmeltwnryjscinptecb',
      role: 'service_role',
      iat: now,
      exp: now + 3600,
    },
    secret,
    { algorithm: 'HS256' },
  );
}
