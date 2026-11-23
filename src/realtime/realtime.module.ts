import { Module } from '@nestjs/common';
import { RealtimeRepository } from './realtime.repository';
import { RealtimeServer } from './realtime.server';

/**
 * S11: `GET /realtime` (WebSocket) — gelen kutusunun canlı akışı, Supabase
 * Realtime'ın yerine (K11). Olaylar `notifications_changed` NOTIFY'ından
 * (0009). Sözleşme `docs/api/realtime.md`.
 */
@Module({
  providers: [RealtimeRepository, RealtimeServer],
  exports: [RealtimeServer],
})
export class RealtimeModule {}
