import type { AppConfig } from '../../config/env.schema';
import {
  hashInviteToken,
  newInviteToken,
  newOtpCode,
  OTP_CODE_PATTERN,
  OtpHasher,
} from './otp-codes';

const hasher = (secret = 'x'.repeat(32)) =>
  new OtpHasher({ JWT_SECRET: secret } as AppConfig);

describe('otp-codes', () => {
  it('kod 6 hane (önde sıfır korunur), dağılım rastgele', () => {
    const codes = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const c = newOtpCode();
      expect(c).toMatch(OTP_CODE_PATTERN);
      codes.add(c);
    }
    expect(codes.size).toBeGreaterThan(190);
  });

  it('HMAC: kullanıcıya, türe ve anahtara bağlı; sabit süreli eşleşme', () => {
    const h = hasher();
    const u1 = '00000000-0000-4000-8000-000000000001';
    const u2 = '00000000-0000-4000-8000-000000000002';
    const stored = h.hash('recovery_token', u1, '123456');
    expect(stored).toMatch(/^[0-9a-f]{64}$/);
    expect(h.matches('recovery_token', u1, '123456', stored)).toBe(true);
    expect(h.matches('recovery_token', u1, '123457', stored)).toBe(false);
    expect(h.matches('recovery_token', u2, '123456', stored)).toBe(false);
    expect(h.matches('confirmation_token', u1, '123456', stored)).toBe(false);
    expect(
      hasher('y'.repeat(32)).matches('recovery_token', u1, '123456', stored),
    ).toBe(false);
    expect(h.matches('recovery_token', u1, '123456', '')).toBe(false);
  });

  it('davet token’ı 256 bit; saklanan SHA-256’sı', () => {
    const { token, hash } = newInviteToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(hash).toBe(hashInviteToken(token));
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(newInviteToken().token).not.toBe(token);
  });
});
