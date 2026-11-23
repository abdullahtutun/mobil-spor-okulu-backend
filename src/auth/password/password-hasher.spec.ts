import bcrypt from 'bcryptjs';
import { isBcryptHash, PasswordHasher } from './password-hasher';
import { passwordPolicyError } from './password-policy';

const hasher = new PasswordHasher();

describe('PasswordHasher', () => {
  // golang.org/x/crypto/bcrypt'in test vektörü: GoTrue'nun (Supabase Auth)
  // ürettiği biçimin aynısı ($2a$, maliyet 10).
  const GO_HASH =
    '$2a$10$XajjQvNhvvRt5GSeFk1xFeyqRrsxkhBkUiQeg0dt.wU1qD4aFDcga';

  it('GoTrue (Go bcrypt) hash’ini doğrular', async () => {
    expect(await hasher.verify('allmine', GO_HASH)).toBe(true);
    expect(await hasher.verify('allmine2', GO_HASH)).toBe(false);
    expect(await hasher.verify('Allmine', GO_HASH)).toBe(false);
  });

  it('pgcrypto biçimini (maliyet 6, canlıdaki demo hesapları) ve $2b$/$2y$ doğrular', async () => {
    const h6 = bcrypt.hashSync('Test1234!', 6).replace(/^\$2b\$/, '$2a$');
    expect(await hasher.verify('Test1234!', h6)).toBe(true);
    for (const prefix of ['$2b$', '$2y$']) {
      expect(await hasher.verify('Test1234!', h6.replace('$2a$', prefix))).toBe(
        true,
      );
    }
  });

  it('hash yoksa ya da bozuksa false', async () => {
    expect(await hasher.verify('x', null)).toBe(false);
    expect(await hasher.verify('', '')).toBe(false);
    expect(await hasher.verify('x', 'plain')).toBe(false);
  });

  it('yeni hash $2a$, maliyet 10, doğrulanır', async () => {
    const hash = await hasher.hash('yeni-sifre1');
    expect(hash).toMatch(/^\$2a\$10\$/);
    expect(isBcryptHash(hash)).toBe(true);
    expect(await hasher.verify('yeni-sifre1', hash)).toBe(true);
  });
});

describe('passwordPolicyError', () => {
  it('en az 6 karakter; 123456 kabul (Supabase / yönetim PasswordPolicy)', () => {
    expect(passwordPolicyError('12345')).not.toBeNull();
    expect(passwordPolicyError('123456')).toBeNull();
    expect(passwordPolicyError('şğüöçı')).toBeNull();
  });

  it('72 bayttan uzun reddedilir', () => {
    expect(passwordPolicyError('a'.repeat(72))).toBeNull();
    expect(passwordPolicyError('a'.repeat(73))).not.toBeNull();
    expect(passwordPolicyError('ş'.repeat(37))).not.toBeNull(); // 74 bayt
  });
});
