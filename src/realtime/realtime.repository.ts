import { Injectable } from '@nestjs/common';
import { DbContextService, type JwtClaims } from '../db/db-context.service';

@Injectable()
export class RealtimeRepository {
  constructor(private readonly db: DbContextService) {}

  /**
   * Bildirim satırı, abonenin kendi token'ıyla ve RLS'iyle
   * (`notifications_select_own`: alıcı kendisi, silinmemiş, hesabı aktif).
   * Göremiyorsa `null` — olay o istemciye gitmez. Yetki kararının tek yeri
   * burası; NOTIFY yükündeki `recipient_id`'ye güvenilmez.
   */
  async getNotification(
    claims: JwtClaims,
    id: string,
  ): Promise<Record<string, unknown> | null> {
    return this.db.withUser(claims, async (c) => {
      const { rows } = await c.query<{ r: Record<string, unknown> | null }>(
        'select public.get_notification($1::uuid) as r',
        [id],
      );
      return rows[0]?.r ?? null;
    });
  }
}
