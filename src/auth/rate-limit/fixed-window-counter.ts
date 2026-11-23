// Bellekte sabit pencereli sayaçlar (tek API süreci; S16 çok süreçte
// paylaşılmadığını biliyor). Giriş (S05) ve e-posta/kod (S06) sınırları kullanır.

/** Sabit pencereli bir sayaç. */
interface Bucket {
  count: number;
  resetAt: number;
}

export const FIVE_MINUTES = 5 * 60_000;
export const FIFTEEN_MINUTES = 15 * 60_000;
export const ONE_HOUR = 60 * 60_000;

/** Bellek sınırı: bu kadar anahtardan sonra süresi geçmişler süpürülür. */
const SWEEP_THRESHOLD = 10_000;

export class FixedWindowCounter {
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
