import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG } from '../../config/config.module';
import type { AppConfig } from '../../config/env.schema';

/** Sabit pencereli bir sayaç. */
interface Bucket {
  count: number;
  resetAt: number;
}

const FIVE_MINUTES = 5 * 60_000;
const FIFTEEN_MINUTES = 15 * 60_000;
const ONE_HOUR = 60 * 60_000;

/** Bellek sınırı: bu kadar anahtardan sonra süresi geçmişler süpürülür. */
const SWEEP_THRESHOLD = 10_000;

class FixedWindowCounter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  /** Sınır doluysa kaç ms sonra açılacağı, değilse 0. */
  blockedFor(key: string, now: number): number {
    const bucket = this.buckets.get(key);
    if (!bucket || bucket.resetAt <= now) return 0;
    return bucket.count >= this.limit ? bucket.resetAt - now : 0;
  }

  hit(key: string, now: number): void {
    const bucket = this.buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      if (this.buckets.size >= SWEEP_THRESHOLD) this.sweep(now);
      this.buckets.set(key, { count: 1, resetAt: now + this.windowMs });
    } else {
      bucket.count += 1;
    }
  }

  reset(key: string): void {
    this.buckets.delete(key);
  }

  private sweep(now: number): void {
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt <= now) this.buckets.delete(key);
    }
  }
}

/**
 * Şifreyle girişin kaba kuvvet koruması. Üç sayaç:
 *
 * - **IP başına deneme** (5 dk, varsayılan 30): Supabase'in "sign-in per IP"
 *   sınırının karşılığı. Doğru şifre de sayılır; tek IP'den hesap taraması
 *   yavaşlasın.
 * - **IP + e-posta başına yanlış şifre** (15 dk, varsayılan 10): bir
 *   hesaba tek kaynaktan tahmin. Doğru şifre bu sayacı sıfırlar.
 * - **E-posta başına yanlış şifre, tüm IP'ler** (1 saat, varsayılan 20):
 *   dağıtık tahmin (her denemede başka IP). Bedeli: biri bilerek 20 yanlış
 *   şifre denerse hesap sahibi bir saate kadar giremez — kabul edildi,
 *   saldırganın ancak saatte 20 tahmini kalır.
 *
 * Sınır, hesap var mı yok mu bakılmadan ve bcrypt'ten **önce** uygulanır;
 * bilinmeyen e-postanın yanlış denemesi de sayılır. Böylece sınır yanıtı
 * hesabın varlığını söylemez.
 *
 * Bellekte (tek API süreci; S04'ün hız sınırıyla aynı varsayım, S16).
 * Süreç yeniden başlarsa sayaçlar sıfırlanır.
 */
@Injectable()
export class LoginRateLimiter {
  private readonly attemptsPerIp: FixedWindowCounter;
  private readonly failuresPerIpEmail: FixedWindowCounter;
  private readonly failuresPerEmail: FixedWindowCounter;

  /** Testler zamanı ilerletebilsin diye değiştirilebilir. */
  clock: () => number = Date.now;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.attemptsPerIp = new FixedWindowCounter(
      config.AUTH_LOGIN_IP_LIMIT,
      FIVE_MINUTES,
    );
    this.failuresPerIpEmail = new FixedWindowCounter(
      config.AUTH_LOGIN_FAILURE_LIMIT,
      FIFTEEN_MINUTES,
    );
    this.failuresPerEmail = new FixedWindowCounter(
      config.AUTH_LOGIN_EMAIL_FAILURE_LIMIT,
      ONE_HOUR,
    );
  }

  /**
   * Denemeye izin varsa 0 döner ve IP denemesini sayar; yoksa kaç saniye
   * sonra tekrar denenebileceği (Retry-After).
   */
  tryAttempt(ip: string, email: string): number {
    const now = this.clock();
    const blocked = Math.max(
      this.attemptsPerIp.blockedFor(ip, now),
      this.failuresPerIpEmail.blockedFor(pair(ip, email), now),
      this.failuresPerEmail.blockedFor(email, now),
    );
    if (blocked > 0) return Math.ceil(blocked / 1000);
    this.attemptsPerIp.hit(ip, now);
    return 0;
  }

  recordFailure(ip: string, email: string): void {
    const now = this.clock();
    this.failuresPerIpEmail.hit(pair(ip, email), now);
    this.failuresPerEmail.hit(email, now);
  }

  recordSuccess(ip: string, email: string): void {
    this.failuresPerIpEmail.reset(pair(ip, email));
  }
}

function pair(ip: string, email: string): string {
  return `${ip}\u0000${email}`;
}
