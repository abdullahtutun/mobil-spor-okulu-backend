# Realtime — `GET /realtime` (WebSocket)

S11. Supabase Realtime'ın bizdeki tek kullanımı gelen kutusuydu
(`notifications:<userId>` kanalı, `postgres_changes`, `recipient_id`
filtresi; yönetim INSERT, veli INSERT + UPDATE dinliyordu). Bunun yerine
küçük bir JSON protokolü; Phoenix protokolü taklit edilmedi. İstemci S13
(veli) ve S15 (yönetim) yazılır.

Adres: `wss://<API>/realtime` (yerelde `ws://127.0.0.1:3000/realtime`).
Metin çerçeveleri, her biri tek bir JSON nesnesi, en çok 16 KB. İkili çerçeve
ve sıkıştırma yok.

## Akış

```
istemci                               sunucu
  ── bağlan ─────────────────────────►
  ── {"type":"auth","token":"<access token>"} ──►     (≤ 5 sn içinde)
  ◄── {"type":"ready","user_id":"<uuid>","expires_at":<unix sn>}
  ── {"type":"subscribe","channel":"notifications:<uuid>"} ──►
  ◄── {"type":"subscribed","channel":"notifications:<uuid>"}
  ◄── {"type":"event","channel":"…","event":"INSERT","record":{…}}
  ◄── {"type":"event","channel":"…","event":"UPDATE","record":{…}}
  ◄── {"type":"resync","channel":"…"}                 (olay kaçmış olabilir)
  ── {"type":"auth","token":"<yenilenmiş token>"} ──► (süre dolmadan)
  ◄── {"type":"ready",…}
  ── {"type":"ping"} ──►  ◄── {"type":"pong"}
  ── {"type":"unsubscribe","channel":"…"} ──►  ◄── {"type":"unsubscribed",…}
```

- **auth**: bağlandıktan sonraki ilk mesaj; access token (`/auth/token`'ın
  verdiği, `Authorization: Bearer` ile aynı). Token başlıkta ya da adreste
  değil mesajda: tarayıcıda WebSocket'e başlık konamaz, adres de vekil
  loglarına düşer. Oturumu `/auth/user` kuralıyla denetlenir (çıkış
  yapılmış, silinmiş, yasaklı hesap reddedilir) ve bağlantı süresince
  dakikada bir yeniden denetlenir. Token yenilenince (`SessionRetryClient`,
  `onAuthStateChange`) aynı mesaj yeni token'la tekrar gönderilir; aynı
  kullanıcı olmalı. Yeni `ready` yeni `expires_at`'i söyler. Yenilenmeyen
  bağlantı token bittiğinde 4001 ile kapanır.
- **subscribe**: yalnızca kendi kanalı, `notifications:<token.sub>`
  (Supabase'teki kanal adı). Filtre yok; sunucu kendisi uygular.
- **event**: `record` satırın bütün sütunları (`get_notification(id)`,
  `to_jsonb` — PostgREST'in `select *`'ı ile aynı biçim, zaman damgaları
  `2026-11-23T10:00:00.123456+00:00`). Satır abonenin kimliğiyle ve RLS'iyle
  okunur: abonenin göremediği satır (başkasının, silinmiş, hesap pasif)
  hiç gönderilmez.
  - `INSERT`: her yeni satır.
  - `UPDATE`: **yalnızca satır yeniden canlanınca** — `read_at` null ve
    `push_status = 'pending'` (yoklama düzeltmesi, push yeniden denemesi).
    Veli uygulamasının `isRevived` filtresi bunu zaten arıyordu; okundu
    işareti ve push durumu yazımları olay üretmez. İstemci filtresi
    kalabilir, zararsız.
- **resync**: sunucu olay kaçırmış olabilir (veritabanı LISTEN bağlantısı
  koptu ve döndü, ya da bir satır okunamadı). Gelen kutusunu yeniden okuyun
  — Supabase'te yeniden abonelikten sonraki okumanın karşılığı.
- **Kopma**: istemci üstel bekleyişle yeniden bağlanır, auth + subscribe
  yapar ve gelen kutusunu yeniden okur (kaçan olaylar yeniden oynatılmaz;
  uygulamalar bugün de böyle yapıyor). Uygulama öne gelince de okunur.
- **Heartbeat**: sunucu 30 sn'de bir WebSocket ping'i yollar; pong
  gelmeyen bağlantı düşürülür (Dart `WebSocket`'i ve tarayıcı pong'u
  kendisi verir). `{"type":"ping"}` isteğe bağlı uygulama düzeyi yoklama.

## Kapanış kodları

| Kod | `reason` | Ne zaman | İstemci |
|---|---|---|---|
| 1001 | `server_shutdown` | API kapanıyor | yeniden bağlan |
| 4000 | `bad_message` | JSON değil, bilinmeyen tür, ikili çerçeve | hata (istemci hatası) |
| 4001 | `auth_timeout`, `auth_required`, `invalid_token`, `token_expired`, `session_ended` | kimlik yok/geçersiz/süresi doldu/oturum kapandı | token'ı yenile, yeniden bağlan; yenileme reddedilirse çıkış |
| 4003 | `channel_forbidden`, `user_changed` | başkasının kanalı, başka kullanıcının token'ı | hata (yeniden deneme yok) |
| 4029 | `too_many_connections` | aynı kullanıcının 10'dan fazla bağlantısı; en eskisi kapanır | yeniden bağlanma (eski soket) |
| 1009 | — | 16 KB'tan büyük mesaj | hata |

El sıkışmada: yol `/realtime` değilse 404; tarayıcıdan gelen `Origin`
`CORS_ORIGINS`'te değilse 403 (mobil istemci `Origin` göndermez).

## Sunucu tarafı

```
notifications INSERT/UPDATE ─► trigger backend_notifications_realtime_* (0009)
   └─► pg_notify('notifications_changed', {op, id, recipient_id})
          └─► PgListener (havuz dışı tek bağlantı, LISTEN)
                 └─► RealtimeServer: recipient_id'nin soketleri ─► get_notification(id) abone adına ─► event
```

- NOTIFY yükü satır taşımaz (8000 bayt sınırı; kişisel veri kanala girmez);
  `recipient_id` yalnızca yönlendirme, yetki değil.
- Birden fazla API süreci: her biri kendi LISTEN'ı ve soketleriyle;
  ortak durum gerekmez.
- Ayarlar: `REALTIME_AUTH_TIMEOUT_MS`, `REALTIME_HEARTBEAT_MS`,
  `REALTIME_SESSION_CHECK_MS`, `REALTIME_MAX_SOCKETS_PER_USER`.
- Testler: `test/notifications.e2e-spec.ts` (istemci `test/support/ws-client.ts`).
