-- migrate:up
-- =============================================================================
-- 0005 — `auth_service` rolü: auth modülünün (S05) auth tablolarına kapısı
-- =============================================================================
-- Supabase'te auth şemasının sahibi GoTrue'nun rolü (supabase_auth_admin);
-- istek rolleri (anon, authenticated, service_role) auth tablolarına
-- dokunamaz. Bizde GoTrue'nun yerini NestJS'in auth modülü alıyor. Onun da
-- bir istek rolü değil, kendi dar rolü var:
--
--   * api_authenticator bu role yalnızca `set local role auth_service` ile
--     geçer (DbContextService.asAuthService); dışarıdan gelen hiçbir token bu
--     role çözülmez (RequestAuth yalnızca anon | authenticated olabilir).
--   * Yalnızca auth modülünün kullandığı tablo ve sütunlar; public şemasında
--     hiçbir yetkisi yok, bypassrls değil.
--   * S06 (kayıt, davet, şifre sıfırlama) ve S09 (hesap işlemleri) ihtiyaç
--     duydukları yetkileri kendi migration'larında ekler.
--
-- Canlıya karşılığı yok (Supabase'te bu rol yok); şema parmak izleri
-- yalnızca public ve storage'ı kapsadığı için etkilenmez.
-- =============================================================================

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'auth_service') then
    create role auth_service nologin noinherit;
  end if;
end;
$$;

grant auth_service to api_authenticator;
grant usage on schema auth to auth_service;

-- Kullanıcı: giriş için okunur; güncellenen yalnızca bu sütunlar.
grant select on auth.users to auth_service;
grant update (last_sign_in_at, updated_at, encrypted_password, raw_user_meta_data)
  on auth.users to auth_service;
grant select on auth.identities to auth_service;

-- Oturumlar ve refresh token'lar: tamamen auth modülünün.
grant select, insert, update, delete on auth.sessions to auth_service;
grant select, insert, update, delete on auth.refresh_tokens to auth_service;
grant usage on sequence auth.refresh_tokens_id_seq to auth_service;

-- migrate:down
revoke all on auth.refresh_tokens, auth.sessions, auth.identities, auth.users from auth_service;
revoke usage on sequence auth.refresh_tokens_id_seq from auth_service;
revoke usage on schema auth from auth_service;
revoke auth_service from api_authenticator;
drop role if exists auth_service;
