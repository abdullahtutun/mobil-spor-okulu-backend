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
- [ ] Migration: `notifications` üzerinde AFTER INSERT/UPDATE trigger'ı →
      `pg_notify('notifications_changed', {op, id, <alıcı sütunu>})`
      (yük 8000 bayttan küçük kalsın; satırın kendisi gönderilmez).
- [ ] `src/realtime/`: `ws` tabanlı gateway, `GET /realtime` (WebSocket).
      Kimlik: bağlanırken access token; süresi dolmadan istemci yeni token
      gönderir, dolarsa sunucu kapatır. Kullanıcı yalnızca kendi kanalına
      abone olur. Mesaj: `{ event: 'INSERT' | 'UPDATE', record }`; `record`
      = `get_notification(p_id)` (S07, 0007: satırın bütün sütunları,
      alıcının RLS'iyle, `withUser`; alıcı değilse null → gönderme). Veli
      uygulamasının `isRevived`'ı `read_at`/`push_status` okur. Heartbeat.
- [ ] Ayrı (havuz dışı) bir bağlantıyla `LISTEN`; kopunca yeniden bağlan ve
      bağlı istemcilere "yeniden oku" sinyali gönder (kaçan olaylar
      yeniden oynatılmaz — uygulamalar zaten yeniden okuyor).
- [ ] `src/push/`: `send-push`'un portu — `LISTEN push_dispatch` + periyodik
      süpürme, `claim_push_batch` / `complete_push_batch` (`service_role`),
      `firebase-admin` (`FCM_SERVICE_ACCOUNT`), geçersiz token temizliği,
      dil ve metin kuralları aynen.
- [ ] Cron: 8 işin hepsinin kurulu olduğunu ve fonksiyonlarının hatasız
      çalıştığını test et (iş fonksiyonlarını doğrudan çağırarak).
- [ ] Tek API süreci varsayımı ya da birden fazla süreçte tekrar gönderimi
      önleyen yöntem `AGENTS.md`'ye.
- [ ] Testler: insert → bağlı velinin soketine olay; başka kullanıcıya
      gitmez; UPDATE ile tekrar okunmamış hâle gelen satır olayı; sahte FCM
      ile push kuyruğunun boşalması.

## Kapsam dışı
Dart realtime istemcisi (S13, S15).

## Kabul kriterleri
- Push metinleri ve davranışı `send-push` ile aynı (port farkları gerekçeli).
- lint/test/test:e2e geçiyor.

## Teslim notu
_(oturum sonunda doldurulur)_
