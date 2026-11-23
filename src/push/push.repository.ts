import { Injectable } from '@nestjs/common';
import { DbContextService } from '../db/db-context.service';
import type { QueuedNotification } from './push-content';

interface Envelope<T> {
  success: boolean;
  code: string;
  message: string | null;
  data: T;
}

/**
 * Push kuyruğu. İki RPC de yalnızca `service_role`'e açık (istemci kuyruğu
 * talep edebilseydi herkesin token'larını görürdü); burada sunucunun kendi
 * işi olarak çağrılır. Gateway allow-list'inde değiller.
 */
@Injectable()
export class PushRepository {
  constructor(private readonly db: DbContextService) {}

  /** `for update skip locked`: iki süreç aynı satırı talep edemez. */
  async claim(limit: number): Promise<QueuedNotification[]> {
    const envelope = await this.db.withRole('service_role', async (c) => {
      const { rows } = await c.query<{ r: Envelope<QueuedNotification[]> }>(
        'select public.claim_push_batch($1) as r',
        [limit],
      );
      return rows[0].r;
    });
    if (!envelope?.success) {
      throw new Error(`Kuyruk okunamadı: ${envelope?.message ?? 'yanıt yok'}`);
    }
    return envelope.data ?? [];
  }

  async complete(
    sent: string[],
    failed: string[],
    invalidTokens: string[],
  ): Promise<void> {
    const envelope = await this.db.withRole('service_role', async (c) => {
      const { rows } = await c.query<{ r: Envelope<null> }>(
        'select public.complete_push_batch($1::uuid[], $2::uuid[], $3::text[]) as r',
        [sent, failed, invalidTokens],
      );
      return rows[0].r;
    });
    if (!envelope?.success) {
      throw new Error(`Sonuç yazılamadı: ${envelope?.message ?? 'yanıt yok'}`);
    }
  }
}
