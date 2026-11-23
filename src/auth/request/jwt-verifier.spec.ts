import jwt from 'jsonwebtoken';
import { ApiException } from '../../common/errors/api-error';
import type { AppConfig } from '../../config/env.schema';
import { JwtVerifier } from './jwt-verifier.service';

const SECRET = 'birim-test-icin-en-az-otuz-iki-karakterlik';
const USER = 'a0000000-0000-4000-8000-0000000000a8';
const verifier = new JwtVerifier({ JWT_SECRET: SECRET } as AppConfig);

const sign = (payload: object, secret = SECRET) =>
  jwt.sign(payload, secret, { algorithm: 'HS256' });

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    if (e instanceof ApiException) {
      expect(e.getStatus()).toBe(401);
      return (e.getResponse() as { code: string }).code;
    }
    throw e;
  }
  return undefined;
}

describe('JwtVerifier', () => {
  it('başlık yoksa anon', () => {
    expect(verifier.fromAuthorizationHeader(undefined)).toEqual({
      role: 'anon',
      claims: { role: 'anon' },
    });
  });

  it('geçerli kullanıcı token’ı authenticated; claims olduğu gibi', () => {
    const token = sign({
      sub: USER,
      role: 'authenticated',
      aud: 'authenticated',
      email: 'veli@a.test',
    });
    const auth = verifier.fromAuthorizationHeader(`Bearer ${token}`);
    expect(auth.role).toBe('authenticated');
    expect(auth.claims).toMatchObject({ sub: USER, email: 'veli@a.test' });
  });

  it('anon anahtarı anon', () => {
    expect(verifier.verify(sign({ role: 'anon', iss: 'supabase' })).role).toBe(
      'anon',
    );
  });

  it.each([
    ['service_role', { role: 'service_role' }, 'PGRST303'],
    ['rolsüz', { sub: USER }, 'PGRST303'],
    [
      'postgres',
      { role: 'postgres', sub: USER, aud: 'authenticated' },
      'PGRST303',
    ],
    ['aud yanlış', { role: 'authenticated', sub: USER, aud: 'x' }, 'PGRST303'],
    [
      'sub uuid değil',
      { role: 'authenticated', sub: 'x', aud: 'authenticated' },
      'PGRST303',
    ],
  ])('%s reddedilir', (_, payload, code) => {
    expect(codeOf(() => verifier.verify(sign(payload)))).toBe(code);
  });

  it('süresi geçmiş: PGRST303 JWT expired', () => {
    const token = sign({
      role: 'authenticated',
      sub: USER,
      aud: 'authenticated',
      exp: Math.floor(Date.now() / 1000) - 10,
    });
    expect(codeOf(() => verifier.verify(token))).toBe('PGRST303');
  });

  it('başka anahtar, bozuk token, HS512, Bearer olmayan başlık: PGRST301', () => {
    const payload = { role: 'authenticated', sub: USER, aud: 'authenticated' };
    expect(codeOf(() => verifier.verify(sign(payload, 'x'.repeat(40))))).toBe(
      'PGRST301',
    );
    expect(codeOf(() => verifier.verify('a.b.c'))).toBe('PGRST301');
    const hs512 = jwt.sign(payload, SECRET, { algorithm: 'HS512' });
    expect(codeOf(() => verifier.verify(hs512))).toBe('PGRST301');
    expect(codeOf(() => verifier.fromAuthorizationHeader('Basic abc'))).toBe(
      'PGRST301',
    );
  });
});
