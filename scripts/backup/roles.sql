-- Geri yüklemeden önce (restore-db.sh) oluşturulan küme rolleri.
-- Roller küme genelidir, pg_dump'ta yoktur; dump'taki GRANT'lar bunları
-- arar. Kaynakları: db/compat/00_roles.sql (0001) ve 0005_auth_service_role.
-- Yeni bir migration rol eklerse buraya da eklenir —
-- test/backup-restore.e2e-spec.ts eksik rolde geri yüklemeyi düşürür.
-- Parola yok: API açılışta api_authenticator'ınkini yazar.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin noinherit bypassrls;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'auth_service') then
    create role auth_service nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'api_authenticator') then
    create role api_authenticator login noinherit;
  end if;
end;
$$;

grant anon, authenticated, service_role, auth_service to api_authenticator;
