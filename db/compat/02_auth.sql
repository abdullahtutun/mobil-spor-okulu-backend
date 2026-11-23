-- =============================================================================
-- Uyumluluk katmanı 02 — `auth` şeması (PLAN.md K5, K8)
-- =============================================================================
-- Supabase'te bu şema GoTrue'nundur. Bizde auth modülü (S05) aynı tabloları
-- kullanır; böylece:
--   * kullanıcılar aynı id ve aynı bcrypt `encrypted_password` ile taşınır
--     (S12), kimse şifre sıfırlamaz;
--   * şemadaki SQL (profiles_id_fkey, handle_new_user, delete_own_account,
--     sync_*_brand, save_staff_profile) değişmeden çalışır.
--
-- Sütunlar canlıdaki `auth.*` tablolarının sütunlarıyla bire bir aynı
-- (information_schema, 2026-11-23): veri taşıma tablo tablo kopyalar.
-- Yalnızca GoTrue'nun bizde karşılığı olmayan tabloları (saml, sso, flow_state,
-- oauth_*, audit_log_entries, schema_migrations …) yok. audit_log_entries
-- S12'de yasal saklama (5651) için ayrıca ele alınır.
--
-- delete_own_account() identities, refresh_tokens, sessions, mfa_factors ve
-- one_time_tokens'tan siler; bu yüzden beşi de şimdiden var. Sütunların
-- son hâli S05'te kesinleşir (yeni sütun eklenebilir, var olan silinmez).
--
-- auth.uid() / jwt() / role() / email(): Supabase'in tanımlarıyla harfi
-- harfine aynı (canlıdan pg_get_functiondef). API her istekte
-- `set_config('request.jwt.claims', '<json>', true)` yapar; eski
-- `request.jwt.claim.<ad>` biçimi de okunur, Supabase'teki gibi.
-- =============================================================================

create schema if not exists auth;
grant usage on schema auth to anon, authenticated, service_role;

-- ── İstek bağlamı fonksiyonları ──────────────────────────────────────────────

create or replace function auth.uid()
 returns uuid
 language sql
 stable
as $function$
  select 
  coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
$function$;

create or replace function auth.role()
 returns text
 language sql
 stable
as $function$
  select 
  coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role')
  )::text
$function$;

create or replace function auth.email()
 returns text
 language sql
 stable
as $function$
  select 
  coalesce(
    nullif(current_setting('request.jwt.claim.email', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'email')
  )::text
$function$;

create or replace function auth.jwt()
 returns jsonb
 language sql
 stable
as $function$
  select 
    coalesce(
        nullif(current_setting('request.jwt.claim', true), ''),
        nullif(current_setting('request.jwt.claims', true), '')
    )::jsonb
$function$;

grant execute on function auth.uid(), auth.role(), auth.email(), auth.jwt()
  to anon, authenticated, service_role;

-- ── Türler (GoTrue'daki adlar) ───────────────────────────────────────────────

create type auth.aal_level as enum ('aal1', 'aal2', 'aal3');
create type auth.factor_type as enum ('totp', 'webauthn', 'phone');
create type auth.factor_status as enum ('unverified', 'verified');
create type auth.one_time_token_type as enum (
  'confirmation_token',
  'reauthentication_token',
  'recovery_token',
  'email_change_token_new',
  'email_change_token_current',
  'phone_change_token'
);

-- ── Tablolar ─────────────────────────────────────────────────────────────────

create table auth.users (
  instance_id                 uuid,
  id                          uuid not null primary key,
  aud                         varchar(255),
  role                        varchar(255),
  email                       varchar(255),
  encrypted_password          varchar(255),
  email_confirmed_at          timestamptz,
  invited_at                  timestamptz,
  confirmation_token          varchar(255),
  confirmation_sent_at        timestamptz,
  recovery_token              varchar(255),
  recovery_sent_at            timestamptz,
  email_change_token_new      varchar(255),
  email_change                varchar(255),
  email_change_sent_at        timestamptz,
  last_sign_in_at             timestamptz,
  raw_app_meta_data           jsonb,
  raw_user_meta_data          jsonb,
  is_super_admin              boolean,
  created_at                  timestamptz,
  updated_at                  timestamptz,
  phone                       text default null::character varying,
  phone_confirmed_at          timestamptz,
  phone_change                text default ''::character varying,
  phone_change_token          varchar(255) default ''::character varying,
  phone_change_sent_at        timestamptz,
  -- GoTrue'da da üretilen sütun.
  confirmed_at                timestamptz
                              generated always as (least(email_confirmed_at, phone_confirmed_at)) stored,
  email_change_token_current  varchar(255) default ''::character varying,
  email_change_confirm_status smallint default 0
                              check (email_change_confirm_status >= 0 and email_change_confirm_status <= 2),
  banned_until                timestamptz,
  reauthentication_token      varchar(255) default ''::character varying,
  reauthentication_sent_at    timestamptz,
  is_sso_user                 boolean not null default false,
  deleted_at                  timestamptz,
  is_anonymous                boolean not null default false,
  constraint users_phone_key unique (phone)
);

comment on table auth.users is
  'Supabase auth.users ile aynı sütunlar (S03). Yazan: auth modülü (S05) ve şemadaki SECURITY DEFINER fonksiyonlar.';

-- GoTrue'nun e-posta tekilliği: SSO dışı hesaplarda tek e-posta.
create unique index users_email_partial_key on auth.users (email) where (is_sso_user = false);
create index users_instance_id_email_idx on auth.users (instance_id, lower((email)::text));
create unique index confirmation_token_idx on auth.users (confirmation_token)
  where ((confirmation_token)::text !~ '^[0-9 ]*$');
create unique index recovery_token_idx on auth.users (recovery_token)
  where ((recovery_token)::text !~ '^[0-9 ]*$');

create table auth.identities (
  provider_id     text not null,
  user_id         uuid not null references auth.users (id) on delete cascade,
  identity_data   jsonb not null,
  provider        text not null,
  last_sign_in_at timestamptz,
  created_at      timestamptz,
  updated_at      timestamptz,
  email           text generated always as (lower((identity_data ->> 'email'::text))) stored,
  id              uuid not null default gen_random_uuid() primary key,
  constraint identities_provider_id_provider_unique unique (provider_id, provider)
);
create index identities_user_id_idx on auth.identities (user_id);

create table auth.sessions (
  id                     uuid not null primary key,
  user_id                uuid not null references auth.users (id) on delete cascade,
  created_at             timestamptz,
  updated_at             timestamptz,
  factor_id              uuid,
  aal                    auth.aal_level,
  not_after              timestamptz,
  refreshed_at           timestamp,
  user_agent             text,
  ip                     inet,
  tag                    text,
  oauth_client_id        uuid,
  refresh_token_hmac_key text,
  refresh_token_counter  bigint,
  scopes                 text
);
create index sessions_user_id_idx on auth.sessions (user_id);
create index sessions_not_after_idx on auth.sessions (not_after desc);

create table auth.refresh_tokens (
  instance_id uuid,
  id          bigserial primary key,
  token       varchar(255),
  -- GoTrue'da metin; delete_own_account `user_id = p_user_id::text` yazar.
  user_id     varchar(255),
  revoked     boolean,
  created_at  timestamptz,
  updated_at  timestamptz,
  parent      varchar(255),
  session_id  uuid references auth.sessions (id) on delete cascade,
  constraint refresh_tokens_token_unique unique (token)
);
create index refresh_tokens_parent_idx on auth.refresh_tokens (parent);
create index refresh_tokens_session_id_revoked_idx on auth.refresh_tokens (session_id, revoked);

create table auth.mfa_factors (
  id                           uuid not null primary key,
  user_id                      uuid not null references auth.users (id) on delete cascade,
  friendly_name                text,
  factor_type                  auth.factor_type not null,
  status                       auth.factor_status not null,
  created_at                   timestamptz not null,
  updated_at                   timestamptz not null,
  secret                       text,
  phone                        text,
  last_challenged_at           timestamptz,
  web_authn_credential         jsonb,
  web_authn_aaguid             uuid,
  last_webauthn_challenge_data jsonb
);
create index mfa_factors_user_id_idx on auth.mfa_factors (user_id);

create table auth.one_time_tokens (
  id              uuid not null primary key,
  user_id         uuid not null references auth.users (id) on delete cascade,
  token_type      auth.one_time_token_type not null,
  token_hash      text not null check (char_length(token_hash) > 0),
  relates_to      text not null,
  created_at      timestamp not null default now(),
  updated_at      timestamp not null default now(),
  expires_at      timestamptz,
  link_token_hash text
);
create unique index one_time_tokens_user_id_token_type_key on auth.one_time_tokens (user_id, token_type);
create index one_time_tokens_token_hash_hash_idx on auth.one_time_tokens using hash (token_hash);

-- İstemci rolleri auth tablolarına dokunamaz (Supabase'te de öyle). Şemadaki
-- SECURITY DEFINER fonksiyonlar postgres olarak çalışır; auth modülü
-- tablolara kendi bağlamıyla erişir (S05 karar verir).
revoke all on all tables in schema auth from public, anon, authenticated;
