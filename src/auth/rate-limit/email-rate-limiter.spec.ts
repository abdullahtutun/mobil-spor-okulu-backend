import type { AppConfig } from '../../config/env.schema';
import { EmailRateLimiter } from './email-rate-limiter';

function limiter(limits: Partial<AppConfig> = {}) {
  const l = new EmailRateLimiter({
    AUTH_EMAIL_SEND_INTERVAL_SEC: 60,
    AUTH_EMAIL_HOURLY_LIMIT: 3,
    AUTH_EMAIL_IP_HOURLY_LIMIT: 5,
    AUTH_VERIFY_IP_LIMIT: 2,
    ...limits,
  } as AppConfig);
  let now = 1_000_000;
  l.clock = () => now;
  return { l, advance: (ms: number) => (now += ms) };
}

describe('EmailRateLimiter', () => {
  it('aynı adrese 60 sn’de bir; saatte en çok 3', () => {
    const { l, advance } = limiter();
    expect(l.trySend('1.1.1.1', 'a@x.test')).toBe(0);
    const wait = l.trySend('1.1.1.1', 'a@x.test');
    expect(wait).toBeGreaterThan(0);
    expect(wait).toBeLessThanOrEqual(60);
    advance(60_000);
    expect(l.trySend('2.2.2.2', 'a@x.test')).toBe(0);
    advance(60_000);
    expect(l.trySend('3.3.3.3', 'a@x.test')).toBe(0);
    advance(60_000);
    expect(l.trySend('4.4.4.4', 'a@x.test')).toBeGreaterThan(60);
    advance(60 * 60_000);
    expect(l.trySend('4.4.4.4', 'a@x.test')).toBe(0);
  });

  it('IP başına saatlik sınır (farklı adreslerle)', () => {
    const { l } = limiter();
    for (let i = 0; i < 5; i++)
      expect(l.trySend('9.9.9.9', `u${i}@x.test`)).toBe(0);
    expect(l.trySend('9.9.9.9', 'u9@x.test')).toBeGreaterThan(0);
    expect(l.trySend('8.8.8.8', 'u9@x.test')).toBe(0);
  });

  it('reddedilen istek sayılmaz; doğrulama IP sınırı ayrı', () => {
    const { l } = limiter();
    expect(l.trySend('1.1.1.1', 'a@x.test')).toBe(0);
    for (let i = 0; i < 10; i++) l.trySend('1.1.1.1', 'a@x.test');
    expect(l.trySend('1.1.1.1', 'b@x.test')).toBe(0);
    expect(l.tryVerify('1.1.1.1')).toBe(0);
    expect(l.tryVerify('1.1.1.1')).toBe(0);
    expect(l.tryVerify('1.1.1.1')).toBeGreaterThan(0);
  });

  it('aralık 0 ise yalnızca saatlik sınır', () => {
    const { l } = limiter({ AUTH_EMAIL_SEND_INTERVAL_SEC: 0 });
    expect(l.trySend('1.1.1.1', 'a@x.test')).toBe(0);
    expect(l.trySend('1.1.1.1', 'a@x.test')).toBe(0);
  });
});
