# S11 — Bildirimler: realtime, push ve cron

**Repo:** backend (Y ve V okunur) · **Bağımlı:** S05 (S07'nin gelen kutusu fonksiyonu varsa onu kullanır)

## Amaç
Gelen kutusunun canlı güncellenmesi (Supabase Realtime yerine) ve push
kuyruğunun FCM'e boşaltılması (`send-push` yerine), veritabanından dışa
HTTP çağrısı olmadan (K10, K11).

## Okunacaklar
- **S03'ten:** `public.request_push_dispatch()` artık `pg_notify('push_dispatch', '')`
  (boş yük; `db/compat/04_supabase_removed.sql`). `supabase_realtime` yayını
  yok; gelen kutusu için notifications trigger'ı + pg_notify burada yazılır.
  pg_cron işleri (9 tane, `expire_trials_job` dahil) `0003_cron_jobs.sql`'de
  zaten kurulu, UTC.
- Y `supabase/migrations/20260927_notifications.sql` (kuyruk, dispatch,
  `claim_push_batch`/`complete_push_batch`), `20261005_parent_attendance_payment_notifications.sql`
- Y `supabase/functions/send-push/index.ts` (tamamı)
- Y ve V `features/notifications/data/source/notifications_data_source.dart`
  (kanal adı, dinlenen olaylar, `isRevived`, yeniden bağlanınca yeniden okuma)
- `db/compat/04_supabase_removed.sql`

## Yapılacaklar
- [x] Migration: `notifications` üzerinde AFTER INSERT/UPDATE trigger'ı →
      `pg_notify('notifications_changed', {op, id, <alıcı sütunu>})`
      (yük 8000 bayttan küçük kalsın; satırın kendisi gönderilmez).
- [x] `src/realtime/`: `ws` tabanlı gateway, `GET /realtime` (WebSocket).
      Kimlik: bağlanırken access token; süresi dolmadan istemci yeni token
      gönderir, dolarsa sunucu kapatır. Kullanıcı yalnızca kendi kanalına
      abone olur. Mesaj: `{ event: 'INSERT' | 'UPDATE', record }`; `record`
      = `get_notification(p_id)` (S07, 0007: satırın bütün sütunları,
      alıcının RLS'iyle, `withUser`; alıcı değilse null → gönderme). Veli
      uygulamasının `isRevived`'ı `read_at`/`push_status` okur. Heartbeat.
- [x] Ayrı (havuz dışı) bir bağlantıyla `LISTEN`; kopunca yeniden bağlan ve
      bağlı istemcilere "yeniden oku" sinyali gönder (kaçan olaylar
      yeniden oynatılmaz — uygulamalar zaten yeniden okuyor).
- [x] `src/push/`: `send-push`'un portu — `LISTEN push_dispatch` + periyodik
      süpürme, `claim_push_batch` / `complete_push_batch` (`service_role`),
      `firebase-admin` (`FCM_SERVICE_ACCOUNT`), geçersiz token temizliği,
      dil ve metin kuralları aynen.
- [x] Cron: 8 işin hepsinin kurulu olduğunu ve fonksiyonlarının hatasız
      çalıştığını test et (iş fonksiyonlarını doğrudan çağırarak).
- [x] Tek API süreci varsayımı ya da birden fazla süreçte tekrar gönderimi
      önleyen yöntem `AGENTS.md`'ye.
- [x] Testler: insert → bağlı velinin soketine olay; başka kullanıcıya
      gitmez; UPDATE ile tekrar okunmamış hâle gelen satır olayı; sahte FCM
      ile push kuyruğunun boşalması.

## Kapsam dışı
Dart realtime istemcisi (S13, S15).

## Kabul kriterleri
- Push metinleri ve davranışı `send-push` ile aynı (port farkları gerekçeli).
- lint/test/test:e2e geçiyor.

## Teslim notu
**Durum: tamam (2026-11-23).**

Yapılanlar:
- `db/migrations/0009_realtime_notify.sql`: `notifications_realtime_notify()`
  (`backend:` yorumlu, EXECUTE kimseye yok) + iki satır trigger'ı
  (`backend_notifications_realtime_insert`, `…_update`). Yük
  `{op, id, recipient_id}` → `notifications_changed`. UPDATE yalnızca
  `read_at is null and push_status = 'pending'` ve satır değiştiyse
  (`WHEN`): veli `isRevived`'ının aradığı olay; push worker'ın kendi
  yazımları olay üretmez. `scripts/schema-fingerprint.sql` `backend_*`
  trigger'larını dışarıda bırakır; `BACKEND_ONLY` = 25 fonksiyon, 2 trigger.
- `src/db/pg-listener.service.ts` (`PgListener`): havuz dışı tek LISTEN
  bağlantısı, 30 sn `select 1` yoklaması, üstel bekleyişle yeniden bağlanma,
  `onConnected({reconnected})`.
- `src/realtime/`: `GET /realtime` (ws 8.22, `noServer`, Nest HTTP
  sunucusunun `upgrade`'i). Protokol ve kapanış kodları
  `docs/api/realtime.md`. Her olay abone adına `get_notification` (RLS).
- `src/push/`: `PushWorker` (send-push portu: 200'lük talep, ≤5 tur, 10'luk
  havuz, bir cihaza ulaştıysa sent, ölü token silme), `push-content.ts`
  (`render` bire bir, `dataParams` izin listesi), `fcm-error.ts` (kopya),
  `fcm.transport.ts` (`HttpFcmTransport`: RS256 JWT → OAuth → HTTP v1;
  `FCM_TRANSPORT` jetonu), `push.repository.ts` (service_role ile
  `claim_push_batch` / `complete_push_batch`).
- Config: `FCM_SERVICE_ACCOUNT`, `PUSH_SWEEP_INTERVAL_MS`,
  `REALTIME_AUTH_TIMEOUT_MS`, `REALTIME_HEARTBEAT_MS`,
  `REALTIME_SESSION_CHECK_MS`, `REALTIME_MAX_SOCKETS_PER_USER`.

Port farkları (gerekçeleri kodda ve PROGRESS günlüğünde):
- `data.params` tür başına izin listesi: send-push `birthdays_*`'ta sporcu
  adlarını (`names`), `pre_registration_received`'da çocuğun adını
  (`athlete_name`) FCM `data`'sına koyuyordu.
- firebase-admin yok: ham HTTP v1 (ölü token kararı ham gövdeye bakıyor).
- Ağ hatası o token için yeniden deneme (send-push çağrıyı düşürüp satırları
  10 dk `sending`'de bırakıyordu); 5 tur dolarsa hemen yeni boşaltma.
- HTTP ucu ve `PUSH_DISPATCH_SECRET` yok: dürtme NOTIFY ile.

Testler: birim `src/push/*.spec.ts` (render ve isDeadToken kardeş repodaki
kaynakla karşılaştırılıyor; kişisel veri; transport imza/önbellek),
`src/realtime/realtime.protocol.spec.ts`; e2e `test/notifications.e2e-spec.ts`
(59): kendi olayı, başkasınınki gitmez, kanal sahteciliği 4003, kimliksiz /
anon / service_role / bozuk / süresi geçmiş / çıkış yapılmış token 4001,
bağlantı açıkken pasif ve silinmiş hesap, token bitişi ve yenileme, oturum
kapanınca 4001, bağlantı sınırı, heartbeat, yanlış yol / Origin, LISTEN
kopunca resync; push: sent + metin + kişisel verisiz, dil, statement
dürtmesi, FCM yokken dokunmama, token alınamazsa talep yok, 5 deneme →
failed, ağ hatası, UNREGISTERED / bozuk token silme → skipped, 24 saat,
tercih, pasif alıcı, LISTEN dönüşünde boşaltma; kuyruk fonksiyonları
`/rpc`'de 404 ve anon/authenticated EXECUTE yok; eşzamanlı iki talep ayrık;
9 cron işinin kurulumu ve her komutun hatasız çalışması, süpürmenin
dürtmesi. Kural bozularak doğrulandı: RLS'li okuma service_role'e
çevrilince 3 test, kanal sahiplik denetimi kaldırılınca kanal testleri
düştü.

Bilinen eksikler / sonrakiler:
- Dart istemcisi S13/S15 (`docs/api/realtime.md`).
- S16: vekilde WebSocket (`/realtime`, Upgrade başlıkları, boşta kalma
  süresi > 30 sn heartbeat), `FCM_SERVICE_ACCOUNT` (Supabase secrets'taki
  değer, kullanıcıdan).
- S17: Supabase'teki send-push ve Vault sırları geçişte kapanır; geçiş
  anında kuyrukta kalan satırlar 24 saat kuralıyla zaten düşer.
