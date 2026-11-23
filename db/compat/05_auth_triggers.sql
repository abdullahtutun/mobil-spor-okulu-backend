-- =============================================================================
-- Uyumluluk katmanı 05 — `auth.users` üzerindeki trigger (canlıdan)
-- =============================================================================
-- Dump yalnızca public şemasını alır; auth.users üzerindeki trigger
-- dump'a girmez. Canlıda tek bir tane var (pg_trigger, 2026-11-23):
--   on_auth_user_created  AFTER INSERT  → public.handle_new_user()
-- Kendi kendine kayıtta (sign up) profil satırını açar. Fonksiyon dump'tan
-- geldiği için dump'tan sonra çalışır.
-- =============================================================================

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
