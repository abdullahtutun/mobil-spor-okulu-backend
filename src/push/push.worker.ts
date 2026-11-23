import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { APP_CONFIG } from '../config/config.module';
import type { AppConfig } from '../config/env.schema';
import { PgListener } from '../db/pg-listener.service';
import { isDeadToken } from './fcm-error';
import { FCM_TRANSPORT, type FcmTransport } from './fcm.transport';
import { buildMessage, type QueuedNotification } from './push-content';
import { PushRepository } from './push.repository';

/** send-push'taki sabitler. */
export const BATCH_SIZE = 200;
export const MAX_BATCHES = 5;
const POOL_SIZE = 10;

type SendOutcome = 'sent' | 'retry' | 'invalid_token';

export interface DrainTotals {
  sent: number;
  failed: number;
  invalidTokens: number;
}

/**
 * Bildirim kuyruğunu FCM'e boşaltır — ex `send-push` Edge Function'ı (S11).
 *
 * KİM DÜRTER: veritabanı. `notifications`'a satır yazılınca statement
 * trigger'ı `request_push_dispatch()` → `pg_notify('push_dispatch', '')`;
 * 5 dakikada bir `sweep_push_queue` cron'u. Yük boş: "kuyruğa bak". Ayrıca
 * LISTEN bağlantısı her açıldığında (ilk açılış ve kopmanın dönüşü) ve
 * `PUSH_SWEEP_INTERVAL_MS`'de bir. Üst üste gelen dürtmeler tek boşaltmada
 * birleşir: çalışırken gelen dürtme bir sonraki turu ister.
 *
 * Kurallar send-push'unkiyle aynı: `claim_push_batch(200)`, en çok 5 tur;
 * bir bildirim bir cihaza ulaştıysa `sent` (diğer cihazlara yeniden denemek
 * ulaşana ikinci push olurdu), hiçbirine ulaşmadıysa `failed` (SQL beşinci
 * denemede `failed`, öncesinde `pending` yapar); ölü token'lar
 * (`isDeadToken`) `complete_push_batch` ile silinir. 24 saatten eski,
 * silinmiş, token'sız, pasif alıcılı ve tercihi kapalı satırlar
 * `claim_push_batch`'in kendisinde `skipped` olur.
 *
 * Port farkları (gerekçeli):
 * - Bir FCM isteğinin ağ hatası/zaman aşımı o token için "yeniden dene"dir;
 *   send-push'ta bütün çağrıyı düşürüp satırları 10 dakika `sending`'de
 *   bırakıyordu.
 * - Beş tur dolduğunda son tur tam doluysa hemen yeni bir boşaltma başlar
 *   (Edge Function'ın süre sınırı yok; bir sonraki dürtmeyi beklemek
 *   gerekmez).
 *
 * Birden fazla API süreci: güvenli. Talep `for update skip locked`; iki
 * süreç aynı satırı alamaz (e2e'de eşzamanlı talep testi).
 */
@Injectable()
export class PushWorker
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(PushWorker.name);
  private running: Promise<void> | null = null;
  private rerun = false;
  private stopped = false;
  private sweepTimer: NodeJS.Timeout | null = null;
  private warnedDisabled = false;
  private readonly unsubscribe: (() => void)[] = [];

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(FCM_TRANSPORT) private readonly transport: FcmTransport,
    private readonly repo: PushRepository,
    private readonly listener: PgListener,
  ) {}

  onApplicationBootstrap(): void {
    this.unsubscribe.push(
      this.listener.on('push_dispatch', () => this.kick()),
      // Bağlantı yokken gelen dürtmeler kayboldu: her açılışta kuyruğa bak.
      this.listener.onConnected(() => this.kick()),
    );
    if (this.config.PUSH_SWEEP_INTERVAL_MS > 0) {
      this.sweepTimer = setInterval(
        () => this.kick(),
        this.config.PUSH_SWEEP_INTERVAL_MS,
      );
      this.sweepTimer.unref();
    }
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopped = true;
    this.unsubscribe.forEach((u) => u());
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    await this.idle();
  }

  /** Kuyruğa bakılmasını ister; çalışan boşaltma varsa bir tur daha. */
  kick(): void {
    if (this.stopped) return;
    if (this.running) {
      this.rerun = true;
      return;
    }
    this.running = this.loop().finally(() => {
      this.running = null;
    });
  }

  /** Çalışan boşaltma (ve istenen ek turlar) bitince çözülür. */
  async idle(): Promise<void> {
    while (this.running) await this.running;
  }

  private async loop(): Promise<void> {
    do {
      this.rerun = false;
      try {
        const { full } = await this.drain();
        if (full) this.rerun = true;
      } catch (err) {
        this.logger.error({ err }, 'Push gönderimi başarısız');
      }
    } while (this.rerun && !this.stopped);
  }

  /** Bir boşaltma (en çok MAX_BATCHES tur). Testler doğrudan çağırabilir. */
  async drain(): Promise<DrainTotals & { full: boolean }> {
    const totals = { sent: 0, failed: 0, invalidTokens: 0, full: false };
    if (!this.transport.configured) {
      if (!this.warnedDisabled) {
        this.logger.warn(
          'FCM_SERVICE_ACCOUNT tanımlı değil — kuyruk bekletiliyor.',
        );
        this.warnedDisabled = true;
      }
      return totals;
    }
    // Erişim token'ı alınamazsa kuyruğa dokunulmaz (send-push gibi).
    await this.transport.prepare();

    for (let batch = 0; batch < MAX_BATCHES; batch++) {
      const queued = await this.repo.claim(BATCH_SIZE);
      if (queued.length === 0) return totals;

      const sent: string[] = [];
      const failed: string[] = [];
      const invalidTokens: string[] = [];

      await runPool(queued, POOL_SIZE, async (notification) => {
        const outcomes = await Promise.all(
          notification.tokens.map(async (token) => {
            const outcome = await this.sendOne(notification, token);
            if (outcome === 'invalid_token') invalidTokens.push(token.token);
            return outcome;
          }),
        );
        if (outcomes.includes('sent')) sent.push(notification.id);
        // Hepsi ölü token'sa da buraya düşer: token'lar silinince sonraki
        // talep satırı "token yok" diye `skipped`'e çeker.
        else failed.push(notification.id);
      });

      // Yazılamazsa satırlar `sending`'de kalır; 10 dakika sonra kuyruğa döner.
      await this.repo.complete(sent, failed, invalidTokens);
      totals.sent += sent.length;
      totals.failed += failed.length;
      totals.invalidTokens += invalidTokens.length;

      if (queued.length < BATCH_SIZE) return totals;
    }
    totals.full = true;
    return totals;
  }

  private async sendOne(
    notification: QueuedNotification,
    token: QueuedNotification['tokens'][number],
  ): Promise<SendOutcome> {
    try {
      const result = await this.transport.send(
        buildMessage(notification, token),
      );
      if (result.ok) return 'sent';
      // Karar dar tutuluyor — gerekçesi fcm-error.ts'te.
      if (isDeadToken(result.body)) return 'invalid_token';
      // Token ve gövde loglanmaz; durum ve FCM hata kodu yeter.
      this.logger.warn(
        { status: result.status, errorCode: fcmErrorCode(result.body) },
        'FCM gönderimi reddetti; yeniden denenecek',
      );
      return 'retry';
    } catch (err) {
      this.logger.warn({ err }, 'FCM isteği başarısız; yeniden denenecek');
      return 'retry';
    }
  }
}

function fcmErrorCode(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as {
      error?: { status?: unknown; details?: { errorCode?: unknown }[] };
    };
    const code = parsed.error?.details?.find(
      (d) => typeof d?.errorCode === 'string',
    )?.errorCode;
    if (typeof code === 'string') return code;
    return typeof parsed.error?.status === 'string'
      ? parsed.error.status
      : null;
  } catch {
    return null;
  }
}

/** Küçük eşzamanlılık havuzu (send-push'taki `runPool`). */
async function runPool<T>(
  items: T[],
  size: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let index = 0;
  const runners = Array.from(
    { length: Math.min(size, items.length) },
    async () => {
      while (index < items.length) {
        const current = items[index++];
        await worker(current);
      }
    },
  );
  await Promise.all(runners);
}
