-- migrate:up
-- =============================================================================
-- 0009 — Gelen kutusunun canlı akışı: notifications → pg_notify (S11, K10/K11)
-- =============================================================================
-- Supabase'te gelen kutusu `supabase_realtime` yayınından besleniyordu
-- (uygulamalar `notifications:<userId>` kanalında recipient_id filtresiyle
-- INSERT, veli uygulaması ayrıca UPDATE dinliyordu). Burada yayın yok
-- (db/compat/04); her değişen satır için `notifications_changed` kanalına
-- küçük bir yük gider ve API'nin realtime gateway'i (src/realtime/) LISTEN
-- eder:
--
--   {"op": "INSERT" | "UPDATE", "id": "<uuid>", "recipient_id": "<uuid>"}
--
-- Satırın kendisi gönderilmez (8000 bayt sınırı; kişisel veri kanala
-- girmez). Gateway satırı, abonenin kendi kimliğiyle ve RLS'iyle
-- `get_notification(id)` ile okur; `recipient_id` yalnızca yönlendirme
-- içindir, yetki kararı değildir (uydurma bir yük yalnızca RLS'in
-- gösterdiğini getirir).
--
-- UPDATE olayları yalnızca satır "yeniden canlanınca" gider: okunmamış
-- (`read_at is null`) ve push'u kuyrukta (`push_status = 'pending'`) — veli
-- uygulamasının `NotificationsDataSource.isRevived`'ı tam olarak buna
-- bakıyor, yönetim uygulaması UPDATE dinlemiyor. Supabase her UPDATE'i
-- gönderiyordu ve istemci geri kalanını atıyordu; push worker her gönderimde
-- `push_status`'u iki kez yazdığı için o olaylar burada hiç üretilmez.
-- İstemcinin gördüğü sonuç aynı.
--
-- Bildirim commit'te gider (rollback olan transaction'ınki hiç gitmez).
-- Hata yutulur: gelen kutusu olayı gitmedi diye bildirim (ve onu yazan
-- yoklama/duyuru) geri alınmamalı — request_push_dispatch ile aynı kural.
--
-- Yalnızca yeni backend'de var: fonksiyonun yorumu `backend:` ile, trigger
-- adları `backend_` ile başlar; canlı şema parmak izi ikisini de dışarıda
-- bırakır (scripts/schema-fingerprint.sql).
-- =============================================================================

create function public.notifications_realtime_notify()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $$
begin
  perform pg_notify(
    'notifications_changed',
    json_build_object('op', tg_op, 'id', new.id,
                      'recipient_id', new.recipient_id)::text);
  return null;
exception
  when others then
    raise warning 'Gelen kutusu olayı gönderilemedi (%): %', sqlstate, sqlerrm;
    return null;
end;
$$;

-- Trigger ateşlenirken EXECUTE denetlenmez (yalnızca oluştururken);
-- /rpc'den çağrılabilir bir uç olarak açık kalmasın.
revoke all on function public.notifications_realtime_notify() from public, anon, authenticated, service_role;

comment on function public.notifications_realtime_notify() is
  'backend: S11 gelen kutusu canlı akışı — pg_notify(''notifications_changed'', {op,id,recipient_id}); canlıda yok (Supabase Realtime yayınının yerine).';

create trigger backend_notifications_realtime_insert
  after insert on public.notifications
  for each row
  execute function public.notifications_realtime_notify();

create trigger backend_notifications_realtime_update
  after update on public.notifications
  for each row
  when (new.read_at is null
        and new.push_status = 'pending'
        and old.* is distinct from new.*)
  execute function public.notifications_realtime_notify();

-- migrate:down
drop trigger if exists backend_notifications_realtime_update on public.notifications;
drop trigger if exists backend_notifications_realtime_insert on public.notifications;
drop function if exists public.notifications_realtime_notify();
