-- =============================================================================
-- Uyumluluk katmanı 04 — Supabase'e özgü parçaların yerine (PLAN.md K10, K11)
-- =============================================================================
-- Dump'tan SONRA çalışır: dump'taki tanımın üzerine yazar.
--
-- 1. request_push_dispatch(): Supabase'te Vault'tan URL + sır okuyup
--    pg_net ile send-push Edge Function'ını dürtüyordu. Burada yalnızca
--    `pg_notify('push_dispatch', '')`; push worker'ı (S11) API'de LISTEN eder
--    ve kuyruğu claim_push_batch ile boşaltır. Sözleşme aynı: gövde boş, bir
--    dürtme = "kuyruğa bak". Bildirim transaction commit edilince gider
--    (pg_net de commit'ten sonra gönderiyordu). Hata yutulur: bildirim
--    yazılamadı diye yoklama/duyuru geri alınmamalı (eski davranış).
--    Çağıranlar değişmedi: notifications üzerindeki statement trigger'ı ve
--    5 dakikalık sweep_push_queue cron işi.
--
-- 2. `supabase_realtime` yayını: yok. Dump'taki
--    `ALTER PUBLICATION supabase_realtime ...` satırları baseline
--    üretilirken ayıklanır (scripts/build-baseline.mjs). Gelen kutusunun
--    canlı akışı S11'de notifications trigger'ı + pg_notify ile gelir.
-- =============================================================================

create or replace function public.request_push_dispatch()
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $$
begin
  perform pg_notify('push_dispatch', '');
exception
  when others then
    raise warning 'Push dürtmesi gönderilemedi (%): %', sqlstate, sqlerrm;
end;
$$;

comment on function public.request_push_dispatch() is
  'Push kuyruğunu dürter: pg_notify(''push_dispatch''). API''deki push worker LISTEN eder (S11). Supabase''teki pg_net + Vault sürümünün yerine (db/compat/04_supabase_removed.sql).';
