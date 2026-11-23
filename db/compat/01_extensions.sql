-- =============================================================================
-- Uyumluluk katmanı 01 — eklentiler (PLAN.md K4, K10)
-- =============================================================================
-- Canlıda kurulu eklentiler (2026-11-23) ve buradaki karşılıkları:
--
--   pg_cron             kurulur (pg_catalog'a, Supabase'teki gibi). İşler
--                       0003_cron_jobs.sql'de. İmaj shared_preload'da yükler.
--   pgcrypto, uuid-ossp kurulur, `extensions` şemasına (Supabase'teki yer):
--                       seed ve veri betikleri `extensions.crypt(...)` yazar.
--                       Şemadaki fonksiyonlar bunları kullanmıyor
--                       (gen_random_uuid() çekirdekte).
--   pg_net              KURULMAZ (K10). Tek kullanımı request_push_dispatch;
--                       yerine pg_notify (04_supabase_removed.sql).
--   supabase_vault      KURULMAZ (K10). Aynı fonksiyonun sırları; sır
--                       veritabanında değil, API'nin .env'inde.
--   pg_stat_statements  KURULMAZ: şema kullanmıyor, shared_preload ister.
--                       İzleme gerekirse S16 ekler.
-- =============================================================================

create extension if not exists pg_cron with schema pg_catalog;

create schema if not exists extensions;
grant usage on schema extensions to anon, authenticated, service_role;

create extension if not exists pgcrypto with schema extensions;
create extension if not exists "uuid-ossp" with schema extensions;
