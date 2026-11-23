import type { AppConfig } from '../../config/env.schema';
import { LoginRateLimiter } from './login-rate-limiter';

function limiter(limits: Partial<AppConfig> = {}) {
  const l = new LoginRateLimiter({
    AUTH_LOGIN_IP_LIMIT: 30,
    AUTH_LOGIN_FAILURE_LIMIT: 3,
    AUTH_LOGIN_EMAIL_FAILURE_LIMIT: 5,
    ...limits,
  } as AppConfig);
  let now = 1_000_000;
  l.clock = () => now;
  return { l, advance: (ms: number) => (now += ms) };
}

describe('LoginRateLimiter', () => {
  it('IP + e-posta: sınır kadar yanlış şifreden sonra kilit, 15 dk sonra açılır', () => {
    const { l, advance } = limiter();
    for (let i = 0; i < 3; i++) {
      expect(l.tryAttempt('1.1.1.1', 'a@x.test')).toBe(0);
      l.recordFailure('1.1.1.1', 'a@x.test');
    }
    const wait = l.tryAttempt('1.1.1.1', 'a@x.test');
    expect(wait).toBeGreaterThan(0);
    expect(wait).toBeLessThanOrEqual(15 * 60);
    // Aynı IP'den başka hesap, başka IP'den aynı hesap etkilenmez.
    expect(l.tryAttempt('1.1.1.1', 'b@x.test')).toBe(0);
    expect(l.tryAttempt('2.2.2.2', 'a@x.test')).toBe(0);
    advance(15 * 60_000);
    expect(l.tryAttempt('1.1.1.1', 'a@x.test')).toBe(0);
  });

  it('doğru şifre IP + e-posta sayacını sıfırlar', () => {
    const { l } = limiter();
    l.recordFailure('1.1.1.1', 'a@x.test');
    l.recordFailure('1.1.1.1', 'a@x.test');
    l.recordSuccess('1.1.1.1', 'a@x.test');
    l.recordFailure('1.1.1.1', 'a@x.test');
    l.recordFailure('1.1.1.1', 'a@x.test');
    expect(l.tryAttempt('1.1.1.1', 'a@x.test')).toBe(0);
  });

  it('e-posta başına, IP’lerden bağımsız: dağıtık tahmin', () => {
    const { l, advance } = limiter();
    for (let i = 0; i < 5; i++) l.recordFailure(`10.0.0.${i}`, 'a@x.test');
    expect(l.tryAttempt('10.0.0.99', 'a@x.test')).toBeGreaterThan(0);
    advance(60 * 60_000);
    expect(l.tryAttempt('10.0.0.99', 'a@x.test')).toBe(0);
  });

  it('IP başına deneme: doğru şifreler de sayılır, 5 dk', () => {
    const { l, advance } = limiter({ AUTH_LOGIN_IP_LIMIT: 2 });
    expect(l.tryAttempt('1.1.1.1', 'a@x.test')).toBe(0);
    expect(l.tryAttempt('1.1.1.1', 'b@x.test')).toBe(0);
    expect(l.tryAttempt('1.1.1.1', 'c@x.test')).toBeGreaterThan(0);
    expect(l.tryAttempt('2.2.2.2', 'c@x.test')).toBe(0);
    advance(5 * 60_000);
    expect(l.tryAttempt('1.1.1.1', 'c@x.test')).toBe(0);
  });
});
