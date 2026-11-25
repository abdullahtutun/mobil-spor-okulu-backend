-- migrate:up
-- =============================================================================
-- 0010 — Erişim kaydı (5651): giriş, token yenileme, başarısız giriş
-- =============================================================================
-- Supabase'te bu iş GoTrue'nun `auth.audit_log_entries`'indeydi; yeni
-- backend o tabloyu kurmuyor (db/compat/02_auth.sql) ve S05'ten beri hiçbir
-- giriş olayını yazmıyordu. Gizlilik politikası (§9) erişim kayıtlarını
-- 5651 sayılı Kanun gereği 1 yıl saklıyor; bu tablo o kayıttır.
--
-- Ne yazılır (auth modülü, AuthService / SessionOpener):
--   password        parolayla giriş (oturum açıldı)
--   otp             e-posta koduyla doğrulama oturum açtı (kayıt, sıfırlama)
--   invite          davet bağlantısıyla oturum açıldı
--   refresh         refresh token döndü (oturum sürüyor)
--   password_failed yanlış parola / bilinmeyen e-posta / kilitli hesap
-- Her satırda zaman (UTC), kullanıcı kimliği (bilinmeyen e-postada null),
-- oturum kimliği, istemci IP'si (TRUST_PROXY'ye göre gerçek IP) ve
-- user agent. E-posta, parola, token YAZILMAZ: kimlik user_id'den bulunur,
-- bilinmeyen bir e-postayı saklamak kimin denendiğini kaydetmek olurdu.
--
-- Kim okur: hiçbir istek rolü. RLS açık; tek politika auth_service'in
-- INSERT'i (bypassrls değil, politika olmadan yazamazdı). anon,
-- authenticated, service_role'ün hiçbir yetkisi yok (site_leads gibi).
-- Okuma yalnızca veritabanı sahibiyle (psql / yedekten), adli talep olunca.
--
-- auth şemasında: public/storage parmak izleri (test/schema.e2e-spec.ts)
-- etkilenmez; cron işi `backend_` önekiyle parmak izinin dışında.
-- user_id'de FK yok: hesap silinse de (ya da mezar taşına dönse de) kayıt
-- saklama süresi boyunca kalmalı.
-- =============================================================================

create table auth.access_log (
  id          uuid primary key default gen_random_uuid(),
  created_at  timestamptz not null default now(),
  event       text not null
              check (event in ('password', 'otp', 'invite', 'refresh', 'password_failed')),
  user_id     uuid,
  session_id  uuid,
  ip          inet,
  user_agent  text check (char_length(user_agent) <= 512)
);

create index access_log_created_at_idx on auth.access_log (created_at);
create index access_log_user_id_idx on auth.access_log (user_id, created_at);

comment on table auth.access_log is
  '5651 erişim kaydı: giriş, token yenileme, başarısız giriş. 1 yıl saklanır (backend_access_log_purge). İstek rollerine kapalı.';

alter table auth.access_log enable row level security;
revoke all on auth.access_log from public, anon, authenticated, service_role;

grant insert on auth.access_log to auth_service;
create policy access_log_insert on auth.access_log
  for insert to auth_service with check (true);

-- Saklama: 1 yıldan eski satırlar kalıcı silinir. Yalnızca pg_cron çağırır.
create function auth.purge_expired_access_log() returns integer
language plpgsql
set search_path = auth
as $function$
declare
  v_count integer;
begin
  delete from auth.access_log where created_at < now() - interval '1 year';
  get diagnostics v_count = row_count;
  return v_count;
end;
$function$;

revoke all on function auth.purge_expired_access_log() from public, anon, authenticated, service_role, auth_service;

select cron.schedule('backend_access_log_purge', '15 1 * * *',
  $$select auth.purge_expired_access_log()$$);

-- migrate:down
select cron.unschedule('backend_access_log_purge');
drop function if exists auth.purge_expired_access_log();
drop table if exists auth.access_log;
