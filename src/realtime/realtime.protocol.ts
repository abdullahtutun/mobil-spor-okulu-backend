/**
 * `GET /realtime` WebSocket protokolü (S11; sözleşme `docs/api/realtime.md`).
 * Supabase Realtime'ın bizdeki tek kullanımı gelen kutusu olduğu için
 * Phoenix protokolü taklit edilmedi; küçük bir JSON protokolü.
 */

export const REALTIME_PATH = '/realtime';

/** Gelen kutusu kanalı: `notifications:<kullanıcı kimliği>` (Supabase'teki adla aynı). */
export const NOTIFICATIONS_CHANNEL_PREFIX = 'notifications:';

export const MAX_MESSAGE_BYTES = 16 * 1024;

/** Kapanış kodları (4000–4999 uygulamaya ayrılmış aralık). */
export const CLOSE = {
  /** Sunucu kapanıyor (standart "going away"). */
  goingAway: 1001,
  /** Bozuk ya da bilinmeyen mesaj. */
  badMessage: 4000,
  /** Kimlik yok, geçersiz, süresi doldu ya da oturum kapandı. Yeni token'la yeniden bağlanın. */
  unauthorized: 4001,
  /** Başka kullanıcının kanalı ya da token'ın kullanıcısı değişti. */
  forbidden: 4003,
  /** Aynı kullanıcının çok fazla açık bağlantısı: en eskisi kapandı. */
  tooManyConnections: 4029,
} as const;

export type ClientMessage =
  | { type: 'auth'; token: string }
  | { type: 'subscribe'; channel: string }
  | { type: 'unsubscribe'; channel: string }
  | { type: 'ping' };

export type ServerMessage =
  | { type: 'ready'; user_id: string; expires_at: number }
  | { type: 'subscribed'; channel: string }
  | { type: 'unsubscribed'; channel: string }
  | {
      type: 'event';
      channel: string;
      event: 'INSERT' | 'UPDATE';
      record: Record<string, unknown>;
    }
  /** Sunucu olay kaçırmış olabilir (LISTEN bağlantısı koptu): listeyi yeniden okuyun. */
  | { type: 'resync'; channel: string }
  | { type: 'pong' };

/** Ham metni istemci mesajına çevirir; uymazsa `null`. */
export function parseClientMessage(raw: string): ClientMessage | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  const m = value as Record<string, unknown>;
  switch (m.type) {
    case 'auth':
      return typeof m.token === 'string' && m.token.length > 0
        ? { type: 'auth', token: m.token }
        : null;
    case 'subscribe':
    case 'unsubscribe':
      return typeof m.channel === 'string'
        ? { type: m.type, channel: m.channel }
        : null;
    case 'ping':
      return { type: 'ping' };
    default:
      return null;
  }
}

/** NOTIFY yükü: `{op, id, recipient_id}` (0009_realtime_notify.sql). */
export interface NotificationChange {
  op: 'INSERT' | 'UPDATE';
  id: string;
  recipientId: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

export function parseNotificationChange(
  payload: string,
): NotificationChange | null {
  let value: unknown;
  try {
    value = JSON.parse(payload);
  } catch {
    return null;
  }
  const m = value as Record<string, unknown> | null;
  if (!m || (m.op !== 'INSERT' && m.op !== 'UPDATE')) return null;
  if (!isUuid(m.id) || !isUuid(m.recipient_id)) return null;
  return {
    op: m.op,
    id: m.id.toLowerCase(),
    recipientId: m.recipient_id.toLowerCase(),
  };
}
