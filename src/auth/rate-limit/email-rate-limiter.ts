import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG } from '../../config/config.module';
import type { AppConfig } from '../../config/env.schema';
import {
  FIVE_MINUTES,
  FixedWindowCounter,
  ONE_HOUR,
} from './fixed-window-counter';

/**
 * E-posta gönderen (recover, signup, resend) ve kod doğrulayan (verify)
 * uçların sınırları. Hepsi **hesap var mı bakılmadan** sayılır: bilinmeyen
 * bir adres de aynı sınıra takılır, böylece 429 yanıtı hesabın varlığını
 * söylemez (Supabase bilinen adreste "60 sn" der, bilinmeyende demez).
 *
 * - adres başına en sık `AUTH_EMAIL_SEND_INTERVAL_SEC`'de bir (Supabase: 60);
 * - adres başına saatte `AUTH_EMAIL_HOURLY_LIMIT` (birinin bir kutuyu kod
 *   e-postasına boğmasını keser);
 * - IP başına saatte `AUTH_EMAIL_IP_HOURLY_LIMIT` (adres tarayan tek kaynak);
 * - doğrulama: IP başına 5 dakikada `AUTH_VERIFY_IP_LIMIT` (Supabase'in
 *   "token verifications" sınırı). Kod başına yanlış deneme ayrıca
 *   veritabanında sayılır (auth.otp_attempts).
 *
 * Bellekte, tek süreç (LoginRateLimiter ile aynı varsayım, S16).
 */
@Injectable()
export class EmailRateLimiter {
  private readonly perEmailInterval: FixedWindowCounter | null;
  private readonly perEmailHour: FixedWindowCounter;
  private readonly perIpHour: FixedWindowCounter;
  private readonly verifyPerIp: FixedWindowCounter;

  /** Testler zamanı ilerletebilsin diye değiştirilebilir. */
  clock: () => number = Date.now;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.perEmailInterval =
      config.AUTH_EMAIL_SEND_INTERVAL_SEC > 0
        ? new FixedWindowCounter(1, config.AUTH_EMAIL_SEND_INTERVAL_SEC * 1000)
        : null;
    this.perEmailHour = new FixedWindowCounter(
      config.AUTH_EMAIL_HOURLY_LIMIT,
      ONE_HOUR,
    );
    this.perIpHour = new FixedWindowCounter(
      config.AUTH_EMAIL_IP_HOURLY_LIMIT,
      ONE_HOUR,
    );
    this.verifyPerIp = new FixedWindowCounter(
      config.AUTH_VERIFY_IP_LIMIT,
      FIVE_MINUTES,
    );
  }

  /** Gönderime izin varsa 0 (ve sayar); yoksa Retry-After saniyesi. */
  trySend(ip: string, email: string): number {
    const now = this.clock();
    const blocked = Math.max(
      this.perEmailInterval?.blockedFor(email, now) ?? 0,
      this.perEmailHour.blockedFor(email, now),
      this.perIpHour.blockedFor(ip, now),
    );
    if (blocked > 0) return Math.ceil(blocked / 1000);
    this.perEmailInterval?.hit(email, now);
    this.perEmailHour.hit(email, now);
    this.perIpHour.hit(ip, now);
    return 0;
  }

  /** Doğrulama denemesine izin varsa 0 (ve sayar); yoksa Retry-After. */
  tryVerify(ip: string): number {
    const now = this.clock();
    const blocked = this.verifyPerIp.blockedFor(ip, now);
    if (blocked > 0) return Math.ceil(blocked / 1000);
    this.verifyPerIp.hit(ip, now);
    return 0;
  }
}
