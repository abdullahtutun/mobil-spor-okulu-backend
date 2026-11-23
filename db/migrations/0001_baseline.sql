-- migrate:up
-- =============================================================================
-- 0001 — Taban şema: Supabase şema dump'ı + uyumluluk katmanı
-- =============================================================================
-- ÜRETİLMİŞ DOSYA, elle düzenlemeyin. Kaynaklar:
--   db/compat/*.sql            uyumluluk katmanı (okunur, yorumlu)
--   dumps/schema.sql           `supabase db dump` (yalnızca şema, repoda yok)
--   scripts/build-baseline.mjs bu dosyayı üretir
--
-- Yeniden üretmek (canlı şema değiştiyse; S03 → AGENTS.md "Schema sync"):
--   supabase db dump --project-ref <ref> -f dumps/schema.sql
--   node scripts/build-baseline.mjs
--
-- Dump: canlı Supabase projesinin public şeması, Postgres 17.6, 2026-11-23.
-- Dump'a girmeyen ve ayrıca eklenenler: auth şeması (02), storage şeması +
-- bucket satırları (03), auth.users trigger'ı (05), storage.objects
-- politikaları (0002), pg_cron işleri (0003).
--
-- Dump'tan ayıklananlar (8 satır):
--   CREATE EXTENSION IF NOT EXISTS "pg_cron" WITH SCHEMA "pg_catalog";   -- eklenti db/compat/01_extensions.sql kurar
--   CREATE EXTENSION IF NOT EXISTS "pg_net" WITH SCHEMA "extensions";   -- K10: pg_net ve Vault yok (db/compat/04_supabase_removed.sql)
--   CREATE EXTENSION IF NOT EXISTS "pg_stat_statements" WITH SCHEMA "extensions";   -- şema kullanmıyor; shared_preload ister
--   CREATE EXTENSION IF NOT EXISTS "pgcrypto" WITH SCHEMA "extensions";   -- eklenti db/compat/01_extensions.sql kurar
--   CREATE EXTENSION IF NOT EXISTS "supabase_vault" WITH SCHEMA "vault";   -- K10: pg_net ve Vault yok (db/compat/04_supabase_removed.sql)
--   CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA "extensions";   -- eklenti db/compat/01_extensions.sql kurar
--   ALTER PUBLICATION "supabase_realtime" OWNER TO "postgres";   -- K11: Realtime yayını yok
--   ALTER PUBLICATION "supabase_realtime" ADD TABLE ONLY "public"."notifications";   -- K11: Realtime yayını yok
--
-- Dump'ta bırakılıp sonradan üzerine yazılan:
--   public.request_push_dispatch()  Vault + pg_net → pg_notify (04)
--
-- Sahiplik ve yetkiler dump'taki gibi: her nesne "postgres"in, GRANT'ler
-- anon / authenticated / service_role / postgres'e (supabase_admin vb.
-- Supabase iç rollerine giden yetki dump'ta yok).
-- =============================================================================

-- ▼▼▼ db/compat/00_roles.sql ▼▼▼
-- =============================================================================
-- Uyumluluk katmanı 00 — roller (PLAN.md K5, AGENTS.md karar 2)
-- =============================================================================
-- Supabase'teki üç istek rolü aynı adlarla. Şemadaki 200'ü aşkın GRANT ve
-- 72 politika bu adlara yazılı; adlar değişirse hiçbiri çalışmaz.
--
--   anon           oturumsuz istek. RLS uygulanır.
--   authenticated  giriş yapmış kullanıcı. RLS uygulanır, auth.uid() dolu.
--   service_role   sunucunun kendi işleri (eski Edge Function'lar). RLS'i
--                  aşar (bypassrls) — Supabase'teki gibi.
--
-- Üçü de giriş yapamaz (nologin). API `api_authenticator` olarak bağlanır
-- ve her istekte `set local role <rol>` ile bunlardan birine geçer
-- (PostgREST'in `authenticator` modeli). `noinherit`: bağlantı kendi başına
-- hiçbir rolün yetkisini taşımaz, yalnızca geçiş yapabilir.
--
-- Parola burada verilmez (sır repoya girmez). Ortam kurulurken:
--   alter role api_authenticator password '<.env içindeki parola>';
-- (S04 yerel/test için, S16 üretim için.)
--
-- Roller küme genelidir; aynı sunucuda ikinci bir veritabanı kurulursa
-- zaten vardır, bu yüzden "yoksa oluştur".
-- =============================================================================

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
  if not exists (select 1 from pg_roles where rolname = 'api_authenticator') then
    create role api_authenticator login noinherit;
  end if;
end;
$$;

grant anon, authenticated, service_role to api_authenticator;
-- ▲▲▲ db/compat/00_roles.sql ▲▲▲

-- ▼▼▼ db/compat/01_extensions.sql ▼▼▼
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
-- ▲▲▲ db/compat/01_extensions.sql ▲▲▲

-- ▼▼▼ db/compat/02_auth.sql ▼▼▼
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
-- ▲▲▲ db/compat/02_auth.sql ▲▲▲

-- ▼▼▼ db/compat/03_storage.sql ▼▼▼
-- =============================================================================
-- Uyumluluk katmanı 03 — `storage` şeması (PLAN.md K9)
-- =============================================================================
-- Dosyaların baytları diskte (S08: STORAGE_ROOT/<bucket>/<yol>); kim neyi
-- okur/yazar/siler kararını Supabase'teki gibi `storage.objects` üzerindeki
-- politikalar verir (0002_storage_policies.sql, canlıdan bire bir). API her
-- dosya işleminde metadata satırını isteğin rolüyle okur/yazar.
--
-- Yalnızca bizim kullandığımız sütunlar: Supabase'in sürümleme, yaşam
-- döngüsü, çok parçalı yükleme ve "prefixes" tabloları burada yok. Var
-- olanların adı ve türü canlıdakiyle aynı (S12 satırları kopyalar).
--
-- storage.foldername / filename / extension: canlıdaki tanımlarla aynı
-- (pg_get_functiondef). Politikalar `storage.foldername(name)[1]` ile okul
-- klasörünü okur; şemadaki can_*_athlete_photo fonksiyonları da kullanır.
--
-- Bucket'lar canlıdan (storage.buckets, 2026-11-23):
--   athlete-photos  private, 1 MB, image/jpeg   (çocuk fotoğrafları)
--   school-logos    public,  2 MB, image/png
-- =============================================================================

create schema if not exists storage;
grant usage on schema storage to anon, authenticated, service_role;

create table storage.buckets (
  id                 text not null primary key,
  name               text not null,
  owner              uuid,
  owner_id           text,
  created_at         timestamptz default now(),
  updated_at         timestamptz default now(),
  public             boolean default false,
  avif_autodetection boolean default false,
  file_size_limit    bigint,
  allowed_mime_types text[]
);
create unique index bname on storage.buckets (name);

create table storage.objects (
  id               uuid not null default gen_random_uuid() primary key,
  bucket_id        text references storage.buckets (id),
  name             text,
  owner            uuid,
  owner_id         text,
  created_at       timestamptz default now(),
  updated_at       timestamptz default now(),
  last_accessed_at timestamptz default now(),
  metadata         jsonb,
  path_tokens      text[] generated always as (string_to_array(name, '/')) stored,
  version          text,
  user_metadata    jsonb
);
create unique index bucketid_objname on storage.objects (bucket_id, name);
create index name_prefix_search on storage.objects (name text_pattern_ops);

alter table storage.buckets enable row level security;
alter table storage.objects enable row level security;

-- Canlıdaki yetkiler: üç rol de tablolara yazabilir; sınırı politikalar
-- çizer (buckets'ta hiç politika yok → istemci bucket göremez/değiştiremez).
grant select, insert, update, delete on storage.buckets, storage.objects to anon, authenticated;
grant all on storage.buckets, storage.objects to service_role;

create or replace function storage.update_updated_at_column()
 returns trigger
 language plpgsql
as $function$
begin
    new.updated_at = now();
    return new;
end;
$function$;

create trigger update_objects_updated_at
  before update on storage.objects
  for each row execute function storage.update_updated_at_column();

create or replace function storage.foldername(name text)
 returns text[]
 language plpgsql
 immutable
as $function$
DECLARE
    _parts text[];
BEGIN
    -- Split on "/" to get path segments
    SELECT string_to_array(name, '/') INTO _parts;
    -- Return everything except the last segment
    RETURN _parts[1 : array_length(_parts,1) - 1];
END
$function$;

create or replace function storage.filename(name text)
 returns text
 language plpgsql
 immutable
as $function$
DECLARE
    _parts text[];
BEGIN
    SELECT string_to_array(name, '/') INTO _parts;
    RETURN _parts[array_length(_parts, 1)];
END
$function$;

create or replace function storage.extension(name text)
 returns text
 language plpgsql
 immutable
as $function$
DECLARE
    _parts text[];
    _filename text;
BEGIN
    -- Split on "/" to get path segments
    SELECT string_to_array(name, '/') INTO _parts;
    -- Get the last path segment (the actual filename)
    SELECT _parts[array_length(_parts, 1)] INTO _filename;
    -- Extract extension: reverse, split on '.', then reverse again
    RETURN reverse(split_part(reverse(_filename), '.', 1));
END
$function$;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types) values
  ('athlete-photos', 'athlete-photos', false, 1048576, array['image/jpeg']),
  ('school-logos',   'school-logos',   true,  2097152, array['image/png'])
on conflict (id) do nothing;
-- ▲▲▲ db/compat/03_storage.sql ▲▲▲

-- ▼▼▼ Supabase şema dump'ı (temizlenmiş) ▼▼▼
SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;


COMMENT ON SCHEMA "public" IS 'standard public schema';


CREATE TYPE "public"."accounting_type" AS ENUM (
    'income',
    'expense',
    'due'
);


ALTER TYPE "public"."accounting_type" OWNER TO "postgres";


CREATE TYPE "public"."approval_status" AS ENUM (
    'active',
    'passive'
);


ALTER TYPE "public"."approval_status" OWNER TO "postgres";


CREATE TYPE "public"."attendance_status" AS ENUM (
    'present',
    'absent',
    'excused'
);


ALTER TYPE "public"."attendance_status" OWNER TO "postgres";


CREATE TYPE "public"."blood_type" AS ENUM (
    'A+',
    'A-',
    'B+',
    'B-',
    'AB+',
    'AB-',
    '0+',
    '0-'
);


ALTER TYPE "public"."blood_type" OWNER TO "postgres";


CREATE TYPE "public"."contract_possibility" AS ENUM (
    'low',
    'moderate',
    'high'
);


ALTER TYPE "public"."contract_possibility" OWNER TO "postgres";


CREATE TYPE "public"."customer_type" AS ENUM (
    'athlete',
    'user',
    'external'
);


ALTER TYPE "public"."customer_type" OWNER TO "postgres";


CREATE TYPE "public"."discount_type" AS ENUM (
    'percentage',
    'fixed_amount'
);


ALTER TYPE "public"."discount_type" OWNER TO "postgres";


CREATE TYPE "public"."expense_status" AS ENUM (
    'pending',
    'partially_paid',
    'paid'
);


ALTER TYPE "public"."expense_status" OWNER TO "postgres";


CREATE TYPE "public"."gender_type" AS ENUM (
    'male',
    'female'
);


ALTER TYPE "public"."gender_type" OWNER TO "postgres";


CREATE TYPE "public"."income_type" AS ENUM (
    'due',
    'sale',
    'service',
    'other'
);


ALTER TYPE "public"."income_type" OWNER TO "postgres";


CREATE TYPE "public"."interview_type" AS ENUM (
    'face_to_face',
    'phone',
    'online'
);


ALTER TYPE "public"."interview_type" OWNER TO "postgres";


CREATE TYPE "public"."payment_method" AS ENUM (
    'cash',
    'credit_card',
    'transfer'
);


ALTER TYPE "public"."payment_method" OWNER TO "postgres";


CREATE TYPE "public"."payment_status" AS ENUM (
    'unpaid',
    'partial',
    'paid',
    'cancelled'
);


ALTER TYPE "public"."payment_status" OWNER TO "postgres";


CREATE TYPE "public"."product_category_type" AS ENUM (
    'equipment',
    'uniform',
    'others'
);


ALTER TYPE "public"."product_category_type" OWNER TO "postgres";


CREATE TYPE "public"."referral_source" AS ENUM (
    'social_media',
    'search_engine',
    'recommendation',
    'advertisement',
    'passing_by',
    'other'
);


ALTER TYPE "public"."referral_source" OWNER TO "postgres";


CREATE TYPE "public"."registration_status" AS ENUM (
    'converted',
    'not_converted'
);


ALTER TYPE "public"."registration_status" OWNER TO "postgres";


CREATE TYPE "public"."subscription_status_type" AS ENUM (
    'pending_verification',
    'trial',
    'active',
    'past_due',
    'canceled',
    'expired'
);


ALTER TYPE "public"."subscription_status_type" OWNER TO "postgres";


CREATE TYPE "public"."transaction_type" AS ENUM (
    'income',
    'expense'
);


ALTER TYPE "public"."transaction_type" OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."acknowledge_privacy_notice"("p_version" "text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_user_id uuid := auth.uid();
  v_version text := nullif(btrim(p_version), '');
  v_updated integer;
begin
  if v_user_id is null then
    return public.app_err('Kullanıcı girişi yapılmamış.', 'forbidden');
  end if;

  if v_version is null or length(v_version) > 32 then
    return public.app_err('Geçersiz metin sürümü.', 'validation');
  end if;

  perform set_config('app.privacy_notice_ack', 'on', true);

  update public.profiles
     set privacy_notice_version = v_version,
         privacy_notice_ack_at  = now()
   where id = v_user_id
     and is_deleted is not true;
  get diagnostics v_updated = row_count;

  perform set_config('app.privacy_notice_ack', 'off', true);

  if v_updated = 0 then
    return public.app_err('Kullanıcı profili bulunamadı.', 'not_found');
  end if;

  return public.app_ok(null, jsonb_build_object('version', v_version));
exception when others then
  return public.app_err(sqlerrm, public.app_sqlstate_code(sqlstate));
end;
$$;


ALTER FUNCTION "public"."acknowledge_privacy_notice"("p_version" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."app_err"("p_message" "text", "p_code" "text" DEFAULT 'internal'::"text") RETURNS "jsonb"
    LANGUAGE "sql" IMMUTABLE
    SET "search_path" TO 'public'
    AS $$
  select jsonb_build_object('success', false, 'code', coalesce(p_code, 'internal'),
                            'message', p_message, 'data', null, 'error', p_message);
$$;


ALTER FUNCTION "public"."app_err"("p_message" "text", "p_code" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."app_local_date"() RETURNS "date"
    LANGUAGE "sql" STABLE
    SET "search_path" TO 'public'
    AS $$
  select (now() at time zone 'Europe/Istanbul')::date;
$$;


ALTER FUNCTION "public"."app_local_date"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."app_local_now"() RETURNS timestamp without time zone
    LANGUAGE "sql" STABLE
    SET "search_path" TO 'public'
    AS $$
  select (now() at time zone 'Europe/Istanbul');
$$;


ALTER FUNCTION "public"."app_local_now"() OWNER TO "postgres";


COMMENT ON FUNCTION "public"."app_local_now"() IS 'Türkiye yerel saati (timestamp without time zone). app_local_date() ile aynı saat dilimini kullanır; biri değişirse diğeri de değişmeli.';


CREATE OR REPLACE FUNCTION "public"."app_ok"("p_message" "text" DEFAULT NULL::"text", "p_data" "jsonb" DEFAULT NULL::"jsonb") RETURNS "jsonb"
    LANGUAGE "sql" IMMUTABLE
    SET "search_path" TO 'public'
    AS $$
  select jsonb_build_object('success', true, 'code', 'ok', 'message', p_message, 'data', p_data);
$$;


ALTER FUNCTION "public"."app_ok"("p_message" "text", "p_data" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."app_sqlstate_code"("p_sqlstate" "text") RETURNS "text"
    LANGUAGE "sql" IMMUTABLE
    SET "search_path" TO 'public'
    AS $$
  select case
    when p_sqlstate in ('23505') then 'conflict'
    when p_sqlstate in ('23503') then 'conflict'
    when p_sqlstate in ('23502', '23514', '23P01') then 'validation'
    when p_sqlstate like '22%' then 'validation'
    when p_sqlstate = 'P0001' then 'validation'
    when p_sqlstate = '42501' then 'forbidden'
    else 'internal'
  end;
$$;


ALTER FUNCTION "public"."app_sqlstate_code"("p_sqlstate" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."attendances_after_insert_notify"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
  -- Bildirim yazılamadı diye yoklama kaybolmamalı.
  begin
    perform public.queue_attendance_results(
      array(select id from inserted_rows where is_deleted is not true));
  exception
    when others then
      raise warning 'Yoklama bildirimi yazılamadı (%): %', sqlstate, sqlerrm;
  end;
  return null;
end;
$$;


ALTER FUNCTION "public"."attendances_after_insert_notify"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."attendances_after_update_notify"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_changed integer;
begin
  begin
    update public.notifications n
       set is_deleted = true
      from old_rows o
      join new_rows w on w.id = o.id
     where w.is_deleted is true
       and o.is_deleted is not true
       and n.type = 'attendance_result'
       and n.dedupe_key = 'attendance_result:' || w.athlete_id || ':'
                          || w.class_id || ':' || w.attendance_date
       and n.is_deleted is not true;

    v_changed := public.queue_attendance_results(array(
      select w.id
        from new_rows w
        join old_rows o on o.id = w.id
       where w.is_deleted is not true
         and (o.status is distinct from w.status or o.is_deleted is true)));

    -- Güncellenen satırlar `notifications`'ın INSERT tetikleyicisini
    -- uyandırmaz; düzeltmenin push'u 5 dakikalık süpürmeyi beklemesin.
    if v_changed > 0 then
      perform public.request_push_dispatch();
    end if;
  exception
    when others then
      raise warning 'Yoklama bildirimi güncellenemedi (%): %', sqlstate, sqlerrm;
  end;
  return null;
end;
$$;


ALTER FUNCTION "public"."attendances_after_update_notify"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."birthday_falls_on"("p_date_of_birth" "date", "p_day" "date") RETURNS boolean
    LANGUAGE "sql" STABLE
    SET "search_path" TO 'public'
    AS $$
  select p_date_of_birth is not null
     and (
          to_char(p_date_of_birth, 'MM-DD') = to_char(p_day, 'MM-DD')
       or (to_char(p_date_of_birth, 'MM-DD') = '02-29'
           and to_char(p_day, 'MM-DD') = '02-28'
           and to_char(p_day + 1, 'MM-DD') = '03-01')
     );
$$;


ALTER FUNCTION "public"."birthday_falls_on"("p_date_of_birth" "date", "p_day" "date") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."bulk_delete_athletes"("p_athlete_ids" "uuid"[]) RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_requested int;
  v_deleted   int;
  v_school_id uuid := public.get_user_school_id();
begin
  if not public.has_permission('registration.manage') then
    return public.app_err('Bu işlemi gerçekleştirmek için yetkiniz yok.', 'forbidden');
  end if;

  if p_athlete_ids is null or array_length(p_athlete_ids, 1) is null then
    return public.app_err('Silinecek kayıt seçilmedi.', 'validation');
  end if;

  select count(distinct id) into v_requested
    from unnest(p_athlete_ids) as id;

  if exists (
    select 1
      from unnest(p_athlete_ids) as t(id)
      left join public.athletes a
             on a.id = t.id
            and a.school_id = v_school_id
            and a.is_deleted is not true
     where a.id is null
        or not public.has_branch_access(a.branch_id)
  ) then
    return public.app_err(
      'Seçilen kayıtların bir kısmı bulunamadı veya bu kayıtlar üzerinde işlem yetkiniz yok.',
      'forbidden'
    );
  end if;

  update public.athletes
     set is_deleted = true
   where id = any (p_athlete_ids)
     and school_id = v_school_id
     and is_deleted is not true;

  get diagnostics v_deleted = row_count;

  if v_deleted <> v_requested then
    raise exception 'Kayıtlar silinirken bir hata oluştu, lütfen listeyi yenileyip tekrar deneyin.';
  end if;

  return public.app_ok(
    v_deleted || ' sporcu başarıyla silindi.',
    jsonb_build_object('deleted_count', v_deleted)
  );

exception
  when others then
    return public.app_err(sqlerrm, public.app_sqlstate_code(sqlstate));
end;
$$;


ALTER FUNCTION "public"."bulk_delete_athletes"("p_athlete_ids" "uuid"[]) OWNER TO "postgres";


COMMENT ON FUNCTION "public"."bulk_delete_athletes"("p_athlete_ids" "uuid"[]) IS 'Seçili sporcuları toplu olarak soft-delete eder. Rol 1/2/3 ve yalnızca kullanıcının bağlı olduğu şubeler. Kısmi başarı yoktur; bağlı kayıtlara dokunulmaz (tekli delete_athlete ile aynı davranış).';


CREATE OR REPLACE FUNCTION "public"."bulk_delete_pre_registrations"("p_pre_registration_ids" "uuid"[]) RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_requested   int;
  v_deleted     int;
  v_school_id   uuid := public.get_user_school_id();
begin
  if not public.has_permission('registration.manage') then
    return public.app_err('Bu işlemi gerçekleştirmek için yetkiniz yok.', 'forbidden');
  end if;

  if p_pre_registration_ids is null or array_length(p_pre_registration_ids, 1) is null then
    return public.app_err('Silinecek kayıt seçilmedi.', 'validation');
  end if;

  select count(distinct id) into v_requested
    from unnest(p_pre_registration_ids) as id;

  if exists (
    select 1
      from unnest(p_pre_registration_ids) as t(id)
      left join public.pre_registrations pr
             on pr.id = t.id
            and pr.school_id = v_school_id
            and pr.is_deleted is not true
     where pr.id is null
        or not public.has_branch_access(pr.branch_id)
  ) then
    return public.app_err(
      'Seçilen kayıtların bir kısmı bulunamadı veya bu kayıtlar üzerinde işlem yetkiniz yok.',
      'forbidden'
    );
  end if;

  update public.pre_registrations
     set is_deleted = true
   where id = any (p_pre_registration_ids)
     and school_id = v_school_id
     and is_deleted is not true;

  get diagnostics v_deleted = row_count;

  if v_deleted <> v_requested then
    raise exception 'Kayıtlar silinirken bir hata oluştu, lütfen listeyi yenileyip tekrar deneyin.';
  end if;

  return public.app_ok(
    v_deleted || ' ön kayıt başarıyla silindi.',
    jsonb_build_object('deleted_count', v_deleted)
  );

exception
  when others then
    return public.app_err(sqlerrm, public.app_sqlstate_code(sqlstate));
end;
$$;


ALTER FUNCTION "public"."bulk_delete_pre_registrations"("p_pre_registration_ids" "uuid"[]) OWNER TO "postgres";


COMMENT ON FUNCTION "public"."bulk_delete_pre_registrations"("p_pre_registration_ids" "uuid"[]) IS 'Seçili ön kayıtları toplu olarak soft-delete eder. Rol 1/2/3 ve yalnızca kullanıcının bağlı olduğu şubeler. Kısmi başarı yoktur.';


CREATE OR REPLACE FUNCTION "public"."can_manage_accounting"() RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select public.has_permission('finance.manage');
$$;


ALTER FUNCTION "public"."can_manage_accounting"() OWNER TO "postgres";


COMMENT ON FUNCTION "public"."can_manage_accounting"() IS 'Muhasebe yazma RPC''lerinin ortak yetki kontrolü: manager, branch_manager, branch_manager_assistant, coach ve accountant.';


CREATE OR REPLACE FUNCTION "public"."can_manage_parent"("p_parent_id" "uuid") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select public.has_permission('registration.manage')
     and exists (
       select 1 from public.profiles p
        where p.id = p_parent_id
          and p.school_id = public.get_user_school_id()
          and p.role_id = 8
          and p.is_deleted is not true)
     and (
          public.current_user_is_school_wide()
       or not exists (
            select 1 from unnest(public.profile_branch_ids(p_parent_id)) as c(branch_id)
             where not public.has_branch_access(c.branch_id))
     );
$$;


ALTER FUNCTION "public"."can_manage_parent"("p_parent_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."can_message_athlete"("p_athlete_id" "uuid") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select public.has_permission('communication.message')
     and exists (
    select 1
      from public.athletes a
     where a.id = p_athlete_id
       and a.is_deleted is not true
       and a.school_id = public.get_user_school_id()
       and (
            (public.get_user_role() in (2, 3, 9)
             and public.has_branch_access(a.branch_id))
         or (public.get_user_role() = 4
             and exists (select 1
                           from public.coach_class_links l
                          where l.profile_id = auth.uid()
                            and l.class_id   = a.class_id
                            and l.is_deleted is not true))
       )
  );
$$;


ALTER FUNCTION "public"."can_message_athlete"("p_athlete_id" "uuid") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."can_message_athlete"("p_athlete_id" "uuid") IS 'Çağıranın sporcunun velisine özel mesaj yazıp yazamayacağı: 1 okulun tamamı, 2-3 erişebildiği şubeler, 4 kendi sınıfları. İstemcide UserRole.canSendDirectMessages aynı rol kümesini taşır.';


CREATE OR REPLACE FUNCTION "public"."can_parent_delete_athlete_photo"("p_object_name" "text") RETURNS boolean
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_parts     text[] := storage.foldername(p_object_name);
  v_school_id uuid   := public.get_user_school_id();
begin
  if public.get_user_role() is distinct from 8
     or v_school_id is null
     or coalesce(array_length(v_parts, 1), 0) <> 2
     or v_parts[1] <> v_school_id::text then
    return false;
  end if;

  return exists (
    select 1
      from public.parent_athlete_links l
      join public.athletes a on a.id = l.athlete_id
     where a.id::text = v_parts[2]
       and l.profile_id = auth.uid()
       and l.is_deleted is not true
       and a.school_id = v_school_id
       and a.is_deleted is not true
       and a.photo_consent_at is null
       and a.photo_path is null
  );
end;
$$;


ALTER FUNCTION "public"."can_parent_delete_athlete_photo"("p_object_name" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."can_read_athlete_photo"("p_object_name" "text") RETURNS boolean
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_parts      text[] := storage.foldername(p_object_name);
  v_school_id  uuid   := public.get_user_school_id();
  v_role       bigint := public.get_user_role();
begin
  if v_school_id is null or v_role is null
     or coalesce(array_length(v_parts, 1), 0) <> 2
     or v_parts[1] <> v_school_id::text then
    return false;
  end if;

  if v_role = 8 then
    return exists (
      select 1
        from public.parent_athlete_links l
        join public.athletes a on a.id = l.athlete_id
       where a.id::text = v_parts[2]
         and l.profile_id = auth.uid()
         and l.is_deleted is not true
         and a.school_id = v_school_id
         and a.is_deleted is not true
    );
  end if;

  return exists (
    select 1 from public.athletes a
     where a.id::text = v_parts[2]
       and a.school_id = v_school_id
       and a.is_deleted is not true
       and a.branch_id in (select public.current_user_branch_ids())
  );
end;
$$;


ALTER FUNCTION "public"."can_read_athlete_photo"("p_object_name" "text") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."can_read_athlete_photo"("p_object_name" "text") IS 'athlete-photos okuma kuralı: sporcuyu görebilen fotoğrafı görür. Veli yalnızca bağlı çocuğunu.';


CREATE OR REPLACE FUNCTION "public"."can_write_athlete_photo"("p_object_name" "text") RETURNS boolean
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_parts     text[] := storage.foldername(p_object_name);
  v_school_id uuid   := public.get_user_school_id();
begin
  if not public.has_permission('registration.manage') then
    return false;
  end if;

  if v_school_id is null
     or coalesce(array_length(v_parts, 1), 0) <> 2
     or v_parts[1] <> v_school_id::text then
    return false;
  end if;

  return exists (
    select 1 from public.athletes a
     where a.id::text = v_parts[2]
       and a.school_id = v_school_id
       and a.is_deleted is not true
       and a.branch_id in (select public.current_user_branch_ids())
  );
end;
$$;


ALTER FUNCTION "public"."can_write_athlete_photo"("p_object_name" "text") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."can_write_athlete_photo"("p_object_name" "text") IS 'athlete-photos yazma kuralı: update_athlete ile aynı roller (1-4), okul kapsamında, silinmemiş sporcu.';


CREATE OR REPLACE FUNCTION "public"."claim_push_batch"("p_limit" integer DEFAULT 200) RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_result jsonb;
begin
  update public.notifications
     set push_status = 'pending'
   where push_status = 'sending'
     and push_claimed_at < now() - interval '10 minutes';

  update public.notifications n
     set push_status = 'skipped'
   where n.push_status = 'pending'
     and (
          n.created_at < now() - interval '24 hours'
       or n.is_deleted is true
       or not exists (select 1 from public.push_tokens t
                       where t.profile_id = n.recipient_id)
       or not exists (select 1 from public.profiles p
                       where p.id = n.recipient_id
                         and p.is_deleted is not true
                         and p.status = 'active')
       or (n.type <> 'announcement' and exists (
             select 1 from public.notification_preferences np
              where np.profile_id = n.recipient_id
                and np.type = n.type
                and np.push_enabled = false))
     );

  with claimed as (
    select id
      from public.notifications
     where push_status = 'pending'
       and (push_claimed_at is null or push_claimed_at < now() - interval '2 minutes')
     order by created_at
     limit greatest(1, least(coalesce(p_limit, 200), 500))
       for update skip locked
  ), updated as (
    update public.notifications n
       set push_status     = 'sending',
           push_attempts   = n.push_attempts + 1,
           push_claimed_at = now()
      from claimed c
     where n.id = c.id
    returning n.id, n.recipient_id, n.type, n.params
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'id',     u.id,
           'type',   u.type,
           'params', u.params,
           'tokens', (select coalesce(jsonb_agg(jsonb_build_object(
                                'token', t.token, 'locale', t.locale,
                                'platform', t.platform, 'app', t.app)), '[]'::jsonb)
                        from public.push_tokens t
                       where t.profile_id = u.recipient_id)
         )), '[]'::jsonb)
    into v_result
    from updated u;

  return public.app_ok(null, v_result);
exception
  when others then
    return public.app_err(sqlerrm, public.app_sqlstate_code(sqlstate));
end;
$$;


ALTER FUNCTION "public"."claim_push_batch"("p_limit" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."class_coaches_error"("p_coach_ids" "uuid"[], "p_branch_id" "uuid") RETURNS "text"
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_coach_id  uuid;
  v_school_id uuid := public.get_user_school_id();
begin
  if p_coach_ids is null or cardinality(p_coach_ids) = 0 then
    return 'Sınıfın en az bir eğitmeni olmalı.';
  end if;

  foreach v_coach_id in array p_coach_ids loop
    if not exists (
      select 1 from public.profiles
       where id = v_coach_id
         and school_id = v_school_id
         and role_id = 4
         and status = 'active'
         and is_deleted is not true
    ) then
      return 'Geçersiz, pasif ya da yetkiniz olmayan bir eğitmen seçildi.';
    end if;

    if not public.profile_has_branch_access(v_coach_id, p_branch_id) then
      return 'Seçilen eğitmenlerden biri bu şubede görevli değil.';
    end if;
  end loop;

  return null;
end;
$$;


ALTER FUNCTION "public"."class_coaches_error"("p_coach_ids" "uuid"[], "p_branch_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."class_has_active_coach"("p_class_id" "uuid") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select exists (
    select 1
      from public.coach_class_links l
      join public.profiles p on p.id = l.profile_id
     where l.class_id = p_class_id
       and l.is_deleted is not true
       and p.is_deleted is not true
       and p.role_id = 4
       and p.status = 'active'
  );
$$;


ALTER FUNCTION "public"."class_has_active_coach"("p_class_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."class_meets_on"("p_class_id" "uuid", "p_day" "date") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select exists (
    select 1 from public.class_schedule_slots s
     where s.class_id = p_class_id
       and s.is_deleted is not true
       and s.weekday = extract(isodow from p_day)
  );
$$;


ALTER FUNCTION "public"."class_meets_on"("p_class_id" "uuid", "p_day" "date") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."class_meets_on"("p_class_id" "uuid", "p_day" "date") IS 'Sınıf o gün ders yapıyor mu: programında o hafta günü var mı. Bildirimler ve get_daily_attendance aynı cevabı okur. Bkz. 20261003_class_schedule_drop_inference.sql.';


CREATE OR REPLACE FUNCTION "public"."class_schedule_error"("p_schedule" "jsonb") RETURNS "text"
    LANGUAGE "plpgsql" IMMUTABLE
    SET "search_path" TO 'public'
    AS $$
declare
  v_item    jsonb;
  v_weekday integer;
  v_time    time;
  v_seen    integer[] := '{}';
begin
  if p_schedule is null
     or jsonb_typeof(p_schedule) <> 'array'
     or jsonb_array_length(p_schedule) = 0 then
    return 'Sınıfın en az bir antrenman günü ve saati olmalı.';
  end if;

  for v_item in select value from jsonb_array_elements(p_schedule) loop
    begin
      v_weekday := (v_item ->> 'weekday')::integer;
      v_time    := (v_item ->> 'start_time')::time;
    exception when others then
      return 'Antrenman programında geçersiz bir gün veya saat var.';
    end;

    if v_weekday is null or v_weekday not between 1 and 7
       or v_time is null
       or extract(second from v_time) <> 0
       or v_time >= time '24:00' then
      return 'Antrenman programında geçersiz bir gün veya saat var.';
    end if;

    if v_weekday = any (v_seen) then
      return 'Aynı güne birden fazla antrenman saati girilemez.';
    end if;
    v_seen := v_seen || v_weekday;
  end loop;

  return null;
end;
$$;


ALTER FUNCTION "public"."class_schedule_error"("p_schedule" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."class_start_time_on"("p_class_id" "uuid", "p_day" "date") RETURNS time without time zone
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select s.start_time
    from public.class_schedule_slots s
   where s.class_id = p_class_id
     and s.is_deleted is not true
     and s.weekday = extract(isodow from p_day);
$$;


ALTER FUNCTION "public"."class_start_time_on"("p_class_id" "uuid", "p_day" "date") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."coach_classes_error"("p_coach_id" "uuid", "p_role_id" bigint, "p_status" "public"."approval_status", "p_branch_ids" "uuid"[], "p_class_ids" "uuid"[]) RETURNS "text"
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_school_id uuid   := public.get_user_school_id();
  v_requested uuid[];
  v_current   uuid[] := '{}'::uuid[];
  v_sole      text;
begin
  select coalesce(array_agg(distinct c), '{}'::uuid[]) into v_requested
    from unnest(coalesce(p_class_ids, '{}'::uuid[])) as t(c)
   where c is not null;

  if p_coach_id is not null then
    select coalesce(array_agg(l.class_id), '{}'::uuid[]) into v_current
      from public.coach_class_links l
      join public.classes c on c.id = l.class_id and c.is_deleted is not true
     where l.profile_id = p_coach_id
       and l.school_id = v_school_id
       and l.is_deleted is not true;
  end if;

  -- Değişiklik yoksa söylenecek bir şey yok (yetki de sorulmaz: sınıfa
  -- dokunmayan bir profil düzenlemesi kayıt yetkisi istemez).
  if v_requested @> v_current and v_current @> v_requested then
    return null;
  end if;

  if not public.has_permission('registration.manage') then
    return 'Sınıf atamak için kayıt yönetimi yetkiniz yok.';
  end if;

  if cardinality(v_requested) > 0 and p_role_id is distinct from 4 then
    return 'Yalnızca eğitmenler sınıfa atanabilir.';
  end if;

  if p_status is distinct from 'active'::public.approval_status and exists (
    select 1 from unnest(v_requested) as r(class_id)
     where not (r.class_id = any (v_current))
  ) then
    return 'Pasif eğitmene sınıf atanamaz.';
  end if;

  -- Eğitmen şubesinde görevli olmadığı sınıfı RLS yüzünden göremez ama
  -- hatırlatmasını alırdı (bkz. `class_coaches_error`).
  if exists (
    select 1 from unnest(v_requested) as r(class_id)
     where not exists (
       select 1 from public.classes c
        where c.id = r.class_id
          and c.school_id = v_school_id
          and c.is_deleted is not true
          and c.branch_id = any (coalesce(p_branch_ids, '{}'::uuid[])))
  ) then
    return 'Seçilen sınıflardan biri eğitmenin şubelerinde değil.';
  end if;

  -- Çıkarılan sınıflardan, bu eğitmen dışında aktif eğitmeni kalmayanlar.
  -- "Aktif eğitmen" tanımı `class_has_active_coach` ile aynı. Eğitmen zaten
  -- pasifse sınıfın aktif eğitmeni o değildir; çıkarmak durumu değiştirmez.
  select string_agg(c.name, ', ' order by c.name) into v_sole
    from public.classes c
   where c.id = any (v_current)
     and not (c.id = any (v_requested))
     and exists (
       select 1 from public.profiles me
        where me.id = p_coach_id
          and me.is_deleted is not true
          and me.role_id = 4
          and me.status = 'active'
     )
     and not exists (
       select 1
         from public.coach_class_links o
         join public.profiles p on p.id = o.profile_id
        where o.class_id = c.id
          and o.profile_id <> p_coach_id
          and o.is_deleted is not true
          and p.is_deleted is not true
          and p.role_id = 4
          and p.status = 'active'
     );

  if v_sole is not null then
    return format(
      'Eğitmen şu sınıfların tek aktif eğitmeni, çıkarılamaz: %s. '
      'Önce sınıf formundan bu sınıflara başka bir eğitmen atayın.',
      v_sole);
  end if;

  return null;
end;
$$;


ALTER FUNCTION "public"."coach_classes_error"("p_coach_id" "uuid", "p_role_id" bigint, "p_status" "public"."approval_status", "p_branch_ids" "uuid"[], "p_class_ids" "uuid"[]) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."complete_push_batch"("p_sent" "uuid"[] DEFAULT '{}'::"uuid"[], "p_failed" "uuid"[] DEFAULT '{}'::"uuid"[], "p_invalid_tokens" "text"[] DEFAULT '{}'::"text"[]) RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
  update public.notifications
     set push_status = 'sent', pushed_at = now()
   where id = any (coalesce(p_sent, '{}'))
     and push_status = 'sending';

  update public.notifications
     set push_status = case when push_attempts >= 5 then 'failed' else 'pending' end
   where id = any (coalesce(p_failed, '{}'))
     and push_status = 'sending';

  delete from public.push_tokens
   where token = any (coalesce(p_invalid_tokens, '{}'));

  return public.app_ok(null, null);
exception
  when others then
    return public.app_err(sqlerrm, public.app_sqlstate_code(sqlstate));
end;
$$;


ALTER FUNCTION "public"."complete_push_batch"("p_sent" "uuid"[], "p_failed" "uuid"[], "p_invalid_tokens" "text"[]) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."convert_pre_registration"("p_pre_registration_id" "uuid", "p_parent_ids" "uuid"[] DEFAULT NULL::"uuid"[]) RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_school_id   uuid := public.get_user_school_id();
  v_pre         public.pre_registrations%rowtype;
  v_parent_ids  uuid[];
  v_athlete_id  uuid;
  v_national_id text;
  v_has_consent boolean;
begin
  if not public.has_permission('registration.manage') then
    return public.app_err('Bu işlemi gerçekleştirmek için yetkiniz yok.', 'forbidden');
  end if;

  if v_school_id is null or p_pre_registration_id is null then
    return public.app_err('Ön kayıt bulunamadı.', 'not_found');
  end if;

  select * into v_pre
    from public.pre_registrations
   where id = p_pre_registration_id
     and school_id = v_school_id
     and is_deleted is not true
   for update;

  if not found or not public.has_branch_access(v_pre.branch_id) then
    return public.app_err(
      'Ön kayıt bulunamadı veya bu kayıt üzerinde işlem yetkiniz yok.',
      'not_found'
    );
  end if;

  if v_pre.status = 'converted' then
    return public.app_err('Bu ön kayıt zaten kesin kayda aktarılmış.', 'conflict');
  end if;

  if v_pre.class_id is null or not exists (
    select 1 from public.classes c
     where c.id = v_pre.class_id
       and c.branch_id = v_pre.branch_id
       and c.school_id = v_school_id
       and c.is_deleted is not true
  ) then
    return public.app_err(
      'Ön kaydın sınıfı artık geçerli değil. Kaydı açıp bir sınıf seçtikten sonra aktarın.',
      'validation'
    );
  end if;

  v_national_id := public.normalize_national_id(v_pre.national_id);
  if v_national_id = 'invalid' then
    return public.app_err(
      'Ön kaydın T.C. Kimlik numarası 11 haneli değil. Kaydı açıp düzelttikten sonra aktarın.',
      'validation'
    );
  end if;

  v_has_consent := v_pre.health_consent_at is not null;

  select coalesce(array_agg(distinct pid), '{}')
    into v_parent_ids
    from unnest(coalesce(p_parent_ids, '{}')) as t(pid)
   where pid is not null;

  if exists (
    select 1 from unnest(v_parent_ids) as t(pid)
     where not exists (
       select 1 from public.profiles pr
        where pr.id = t.pid
          and pr.school_id = v_school_id
          and pr.role_id = 8
          and pr.is_deleted is not true
     )
  ) then
    return public.app_err('Geçersiz veya yetkiniz olmayan bir veli seçildi.', 'validation');
  end if;

  if v_pre.kvkk_approved_at is not null then
    perform set_config('app.consent_channel', 'online_form', true);
  end if;

  insert into public.athletes (
    school_id, branch_id, class_id, full_name, gender, date_of_birth,
    phone_number, address, height, weight,
    registration_date, approval_status,
    national_id, health_problems, has_health_report, health_consent_at,
    photo_consent_at, promo_photo_consent_at
  ) values (
    v_school_id, v_pre.branch_id, v_pre.class_id, v_pre.full_name,
    v_pre.gender, v_pre.date_of_birth,
    v_pre.phone, v_pre.address,
    public.pre_registration_measure(v_pre.height),
    public.pre_registration_measure(v_pre.weight),
    current_date, 'active',
    v_national_id,
    case when v_has_consent then v_pre.health_problems end,
    case when v_has_consent then v_pre.has_health_report end,
    v_pre.health_consent_at,
    v_pre.photo_consent_at,
    v_pre.promo_photo_consent_at
  ) returning id into v_athlete_id;

  perform set_config('app.consent_channel', '', true);

  if array_length(v_parent_ids, 1) > 0 then
    insert into public.parent_athlete_links (profile_id, athlete_id, school_id)
    select pid, v_athlete_id, v_school_id
      from unnest(v_parent_ids) as t(pid)
    on conflict (profile_id, athlete_id) do update set is_deleted = false;

    insert into public.profile_branch_links (profile_id, branch_id, school_id)
    select pid, v_pre.branch_id, v_school_id
      from unnest(v_parent_ids) as t(pid)
    on conflict (profile_id, branch_id) do update set is_deleted = false;
  end if;

  update public.pre_registrations
     set status = 'converted'
   where id = v_pre.id;

  return public.app_ok(
    'Ön kayıt kesin kayda aktarıldı.',
    jsonb_build_object('id', v_athlete_id)
  );

exception
  when unique_violation then
    return public.app_err(
      'Bu T.C. Kimlik numarasıyla kayıtlı bir sporcu zaten var; ön kayıt aynı çocuk için açılmış olabilir.',
      'conflict'
    );
  when others then
    return public.app_err(sqlerrm, public.app_sqlstate_code(sqlstate));
end;
$$;


ALTER FUNCTION "public"."convert_pre_registration"("p_pre_registration_id" "uuid", "p_parent_ids" "uuid"[]) OWNER TO "postgres";


COMMENT ON FUNCTION "public"."convert_pre_registration"("p_pre_registration_id" "uuid", "p_parent_ids" "uuid"[]) IS 'Tek ön kaydı kesin kayda aktarır: sporcu kartı, veli-sporcu ve veli-şube bağları ve durum tek transaction''da yazılır. Veli profilleri önceden açılmış olmalıdır (bulk-convert-pre-registrations Edge Function''ı). Rol 1/2/3, okul ve şube kapsamı.';


CREATE OR REPLACE FUNCTION "public"."create_athlete"("p_branch_id" "uuid", "p_gender" "public"."gender_type", "p_date_of_birth" "date", "p_approval_status" "public"."approval_status", "p_school_id" "uuid", "p_class_id" "uuid", "p_full_name" "text", "p_parent_ids" "uuid"[], "p_blood_type" "public"."blood_type" DEFAULT NULL::"public"."blood_type", "p_license_number" "text" DEFAULT NULL::"text", "p_height" numeric DEFAULT NULL::numeric, "p_weight" numeric DEFAULT NULL::numeric, "p_photo_url" "text" DEFAULT NULL::"text", "p_address" "text" DEFAULT NULL::"text", "p_registration_date" "date" DEFAULT NULL::"date", "p_contract_end_date" "date" DEFAULT NULL::"date", "p_phone_number" "text" DEFAULT NULL::"text", "p_national_id" "text" DEFAULT NULL::"text", "p_health_problems" "text" DEFAULT NULL::"text", "p_has_health_report" boolean DEFAULT NULL::boolean, "p_health_consent" boolean DEFAULT NULL::boolean) RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_school_id   uuid;
  v_athlete_id  uuid;
  v_national_id text := public.normalize_national_id(p_national_id);
  v_consent_at  timestamp with time zone :=
    public.resolve_health_consent(p_health_consent, null);
begin
  if not public.has_permission('registration.manage') then
    return public.app_err('Bu işlemi gerçekleştirmek için yetkiniz yok.', 'forbidden');
  end if;

  v_school_id := get_user_school_id();
  if v_school_id is null
     or (p_school_id is not null and p_school_id <> v_school_id) then
    return public.app_err('Bu işlemi gerçekleştirmek için yetkiniz yok.', 'forbidden');
  end if;

  if v_national_id = 'invalid' then
    return public.app_err('T.C. Kimlik numarası 11 haneli olmalıdır.', 'validation');
  end if;

  if not public.has_branch_access(p_branch_id) then
    return public.app_err('Geçersiz veya yetkiniz olmayan bir şube seçildi.', 'validation');
  end if;

  if p_class_id is not null and not exists (
    select 1 from public.classes
     where id = p_class_id and branch_id = p_branch_id
       and school_id = v_school_id and is_deleted is not true
  ) then
    return public.app_err('Seçilen sınıf bu şubeye ait değil.', 'validation');
  end if;

  if exists (
    select 1 from unnest(coalesce(p_parent_ids, '{}')) as t(pid)
     where not exists (
       select 1 from public.profiles pr
        where pr.id = t.pid and pr.school_id = v_school_id
          and pr.role_id = 8 and pr.is_deleted is not true
     )
  ) then
    return public.app_err('Geçersiz veya yetkiniz olmayan bir veli seçildi.', 'validation');
  end if;

  insert into public.athletes (
    branch_id, gender, blood_type, license_number, height, weight,
    address, date_of_birth, registration_date,
    contract_end_date, approval_status, school_id, class_id,
    full_name, phone_number,
    national_id, health_problems, has_health_report, health_consent_at
  ) values (
    p_branch_id, p_gender, p_blood_type, p_license_number, p_height, p_weight,
    p_address, p_date_of_birth, coalesce(p_registration_date, current_date),
    p_contract_end_date, p_approval_status, v_school_id, p_class_id,
    p_full_name, p_phone_number,
    v_national_id,
    case when v_consent_at is not null then nullif(btrim(p_health_problems), '') end,
    case when v_consent_at is not null then p_has_health_report end,
    v_consent_at
  ) returning id into v_athlete_id;

  if p_parent_ids is not null and array_length(p_parent_ids, 1) > 0 then
    insert into public.parent_athlete_links (profile_id, athlete_id, school_id)
    select distinct pid, v_athlete_id, v_school_id
      from unnest(p_parent_ids) as t(pid)
    on conflict (profile_id, athlete_id) do update set is_deleted = false;
  end if;

  return public.app_ok(
    'Sporcu kartı oluşturuldu ve veli bağlantıları başarıyla tanımlandı.',
    jsonb_build_object('id', v_athlete_id)
  );
exception
  when unique_violation then
    return public.app_err('Bu T.C. Kimlik numarasıyla kayıtlı bir sporcu zaten var.', 'conflict');
  when others then
    return public.app_err(sqlerrm, public.app_sqlstate_code(sqlstate));
end;
$$;


ALTER FUNCTION "public"."create_athlete"("p_branch_id" "uuid", "p_gender" "public"."gender_type", "p_date_of_birth" "date", "p_approval_status" "public"."approval_status", "p_school_id" "uuid", "p_class_id" "uuid", "p_full_name" "text", "p_parent_ids" "uuid"[], "p_blood_type" "public"."blood_type", "p_license_number" "text", "p_height" numeric, "p_weight" numeric, "p_photo_url" "text", "p_address" "text", "p_registration_date" "date", "p_contract_end_date" "date", "p_phone_number" "text", "p_national_id" "text", "p_health_problems" "text", "p_has_health_report" boolean, "p_health_consent" boolean) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."create_branch"("p_school_id" "uuid", "p_name" "text", "p_address" "text", "p_email" "text", "p_phone_number" "text", "p_phone_number_2" "text", "p_company_title" "text", "p_billing_address" "text", "p_tax_address" "text", "p_tax_number" "text", "p_trade_registry_number" "text", "p_mersis_number" "text", "p_tax_office_province_code" "text", "p_iban" "text", "p_status" "public"."approval_status") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_school_id uuid;
  v_branch_id uuid;
begin
  if not public.has_permission('school.manage') then
    return public.app_err('Bu işlemi gerçekleştirmek için yetkiniz yok.', 'forbidden');
  end if;

  v_school_id := get_user_school_id();
  if v_school_id is null
     or (p_school_id is not null and p_school_id <> v_school_id) then
    return public.app_err('Bu işlemi gerçekleştirmek için yetkiniz yok.', 'forbidden');
  end if;

  if nullif(btrim(p_phone_number), '') is null then
    return public.app_err('Şube telefon numarası zorunludur.', 'validation');
  end if;

  insert into public.branches (
    school_id, name, address, email, phone_number, phone_number_2,
    company_title, billing_address, tax_address, tax_number,
    trade_registry_number, mersis_number, tax_office_province_code, iban,
    status
  ) values (
    v_school_id, p_name, p_address, nullif(btrim(p_email), ''),
    btrim(p_phone_number), p_phone_number_2,
    p_company_title, p_billing_address, p_tax_address, p_tax_number,
    p_trade_registry_number, p_mersis_number, p_tax_office_province_code, p_iban,
    p_status
  ) returning id into v_branch_id;

  -- Şubeyi açan yönetici, şube listesindeki "Sorumlular" sütununda görünsün.
  -- Erişim için gerekli değil (yönetici okul genelidir); yalnızca gösterim.
  insert into public.profile_branch_links (school_id, profile_id, branch_id)
  values (v_school_id, auth.uid(), v_branch_id)
  on conflict do nothing;

  return public.app_ok('Şube bilgileri başarıyla oluşturuldu.', jsonb_build_object('id', v_branch_id));

exception when others then
  return public.app_err(sqlerrm, public.app_sqlstate_code(sqlstate));
end;
$$;


ALTER FUNCTION "public"."create_branch"("p_school_id" "uuid", "p_name" "text", "p_address" "text", "p_email" "text", "p_phone_number" "text", "p_phone_number_2" "text", "p_company_title" "text", "p_billing_address" "text", "p_tax_address" "text", "p_tax_number" "text", "p_trade_registry_number" "text", "p_mersis_number" "text", "p_tax_office_province_code" "text", "p_iban" "text", "p_status" "public"."approval_status") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."create_class"("p_name" "text", "p_branch_id" "uuid", "p_sport_id" "uuid", "p_school_id" "uuid", "p_quota" smallint, "p_athlete_ids" "uuid"[], "p_schedule" "jsonb" DEFAULT NULL::"jsonb", "p_coach_ids" "uuid"[] DEFAULT NULL::"uuid"[]) RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_school_id    uuid;
  v_new_class_id uuid;
  v_error        text;
  v_sync         jsonb;
begin
  if not public.has_permission('registration.manage') then
    return public.app_err('Bu işlemi gerçekleştirmek için yetkiniz yok.', 'forbidden');
  end if;

  v_school_id := get_user_school_id();
  if v_school_id is null
     or (p_school_id is not null and p_school_id <> v_school_id) then
    return public.app_err('Bu işlemi gerçekleştirmek için yetkiniz yok.', 'forbidden');
  end if;

  if not public.has_branch_access(p_branch_id) then
    return public.app_err('Geçersiz veya yetkiniz olmayan bir şube seçildi.', 'validation');
  end if;

  if not exists (
    select 1 from public.sports
     where id = p_sport_id and school_id = v_school_id and is_deleted is not true
  ) then
    return public.app_err('Geçersiz veya yetkiniz olmayan bir branş seçildi.', 'validation');
  end if;

  -- Sınıfa alınan sporcu bu sınıfın şubesine taşınır: bugün çağıranın
  -- şubelerinden birinde olmalı.
  if exists (
    select 1 from unnest(coalesce(p_athlete_ids, '{}')) as t(aid)
     where not exists (
       select 1 from public.athletes a
        where a.id = t.aid and a.school_id = v_school_id and a.is_deleted is not true
          and public.has_branch_access(a.branch_id)
     )
  ) then
    return public.app_err('Geçersiz veya yetkiniz olmayan bir sporcu seçildi.', 'validation');
  end if;

  -- Yazmadan önce: aşağıdaki insert'ler başladıktan sonra dönen bir
  -- `app_err` onları geri almaz.
  v_error := coalesce(
    public.class_schedule_error(p_schedule),
    public.class_coaches_error(p_coach_ids, p_branch_id)
  );
  if v_error is not null then
    return public.app_err(v_error, 'validation');
  end if;

  insert into public.classes (name, branch_id, sport_id, school_id, quota)
  values (p_name, p_branch_id, p_sport_id, v_school_id, p_quota)
  returning id into v_new_class_id;

  insert into public.branch_class_links (class_id, branch_id, school_id)
  values (v_new_class_id, p_branch_id, v_school_id);

  update public.athletes
     set class_id = v_new_class_id,
         branch_id = p_branch_id
   where id = any(p_athlete_ids)
     and school_id = v_school_id;

  -- Program ve eğitmenler sınıfla aynı işlemde yazılır: biri başarısızsa
  -- `raise` bütün bloğu geri alır.
  v_sync := public.sync_class_schedule(v_new_class_id, p_schedule);
  if (v_sync ->> 'success')::boolean is not true then
    raise exception '%', v_sync ->> 'message';
  end if;

  v_sync := public.sync_class_coaches(v_new_class_id, p_coach_ids);
  if (v_sync ->> 'success')::boolean is not true then
    raise exception '%', v_sync ->> 'message';
  end if;

  return public.app_ok('Sınıf başarıyla oluşturuldu ve sporcular atandı.', jsonb_build_object('id', v_new_class_id));
exception when others then
  return public.app_err(sqlerrm, public.app_sqlstate_code(sqlstate));
end;
$$;


ALTER FUNCTION "public"."create_class"("p_name" "text", "p_branch_id" "uuid", "p_sport_id" "uuid", "p_school_id" "uuid", "p_quota" smallint, "p_athlete_ids" "uuid"[], "p_schedule" "jsonb", "p_coach_ids" "uuid"[]) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."create_customer"("p_display_name" "text", "p_type" "public"."customer_type", "p_phone" "text" DEFAULT ''::"text", "p_athlete_id" "uuid" DEFAULT NULL::"uuid", "p_profile_id" "uuid" DEFAULT NULL::"uuid", "p_email" "text" DEFAULT NULL::"text", "p_national_id" "text" DEFAULT NULL::"text", "p_address" "text" DEFAULT NULL::"text", "p_school_id" "uuid" DEFAULT NULL::"uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_customer_id uuid;
  v_school_id   uuid;
begin
  if not public.can_manage_accounting() then
    return public.app_err('Bu işlemi gerçekleştirmek için yetkiniz yok.', 'forbidden');
  end if;

  v_school_id := public.get_user_school_id();

  if v_school_id is null then
    return public.app_err('Kullanıcının bağlı olduğu okul bulunamadı.', 'forbidden');
  end if;

  if p_school_id is not null and p_school_id <> v_school_id then
    return public.app_err('Başka bir okul adına müşteri oluşturulamaz.', 'forbidden');
  end if;

  if p_athlete_id is not null and not exists (
    select 1 from public.athletes a
     where a.id = p_athlete_id and a.school_id = v_school_id
       and a.is_deleted is not true and public.has_branch_access(a.branch_id)
  ) then
    return public.app_err('Geçersiz veya yetkiniz olmayan bir sporcu seçildi.', 'validation');
  end if;

  if p_profile_id is not null and not exists (
    select 1 from public.profiles pr
     where pr.id = p_profile_id and pr.school_id = v_school_id and pr.is_deleted is not true
  ) then
    return public.app_err('Geçersiz bir kullanıcı seçildi.', 'validation');
  end if;

  insert into public.customers (
    display_name, type, athlete_id, profile_id, phone, email,
    national_id, address, school_id, is_deleted
  ) values (
    p_display_name, coalesce(p_type, 'external'::customer_type),
    p_athlete_id, p_profile_id, coalesce(p_phone, ''), p_email,
    nullif(p_national_id, ''), p_address, v_school_id, false
  ) returning id into v_customer_id;

  return public.app_ok('Müşteri başarıyla oluşturuldu.',
                       jsonb_build_object('id', v_customer_id));
exception when others then
  return public.app_err(sqlerrm, public.app_sqlstate_code(sqlstate));
end;
$$;


ALTER FUNCTION "public"."create_customer"("p_display_name" "text", "p_type" "public"."customer_type", "p_phone" "text", "p_athlete_id" "uuid", "p_profile_id" "uuid", "p_email" "text", "p_national_id" "text", "p_address" "text", "p_school_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."create_discount"("p_name" "text", "p_type" "public"."discount_type", "p_value" numeric, "p_branch_ids" "uuid"[]) RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_school_id uuid := public.get_user_school_id();
  v_id        uuid;
begin
  if not public.has_permission('finance.manage') then
    return public.app_err('Bu işlemi gerçekleştirmek için yetkiniz yok.', 'forbidden');
  end if;
  if v_school_id is null then
    return public.app_err('Kullanıcının bağlı olduğu okul bulunamadı.', 'forbidden');
  end if;
  if p_branch_ids is null or cardinality(p_branch_ids) = 0 then
    return public.app_err('En az bir şube seçilmelidir.', 'validation');
  end if;
  if exists (select 1 from unnest(p_branch_ids) as b(branch_id)
              where b.branch_id is null or not public.has_branch_access(b.branch_id)) then
    return public.app_err('Geçersiz veya yetkiniz olmayan bir şube seçildi.', 'validation');
  end if;
  if p_value < 0 then
    return public.app_err('İndirim değeri negatif olamaz.', 'validation');
  end if;
  if p_type = 'percentage' and p_value > 100 then
    return public.app_err('Yüzdelik indirim 100''den büyük olamaz.', 'validation');
  end if;

  insert into public.discounts (name, school_id, type, value)
  values (p_name, v_school_id, p_type, p_value)
  returning id into v_id;

  insert into public.branch_discount_links (discount_id, branch_id, school_id)
  select v_id, b, v_school_id from (select distinct unnest(p_branch_ids) as b) s;

  return public.app_ok('İndirim başarıyla oluşturuldu.', jsonb_build_object('id', v_id));
exception when others then
  return public.app_err(sqlerrm, public.app_sqlstate_code(sqlstate));
end;
$$;


ALTER FUNCTION "public"."create_discount"("p_name" "text", "p_type" "public"."discount_type", "p_value" numeric, "p_branch_ids" "uuid"[]) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."create_financial_record"("p_customer_id" "uuid", "p_type" "public"."accounting_type", "p_name" "text", "p_expected_date" "date", "p_net_amount" numeric, "p_income_expense_item_id" "uuid" DEFAULT NULL::"uuid", "p_discount_id" "uuid" DEFAULT NULL::"uuid", "p_branch_id" "uuid" DEFAULT NULL::"uuid", "p_school_id" "uuid" DEFAULT NULL::"uuid", "p_description" "text" DEFAULT NULL::"text", "p_invoice_no" "text" DEFAULT NULL::"text", "p_reminder_date" "date" DEFAULT NULL::"date", "p_base_amount" numeric DEFAULT 0, "p_discount_amount" numeric DEFAULT 0, "p_tax_rate" integer DEFAULT 0, "p_tax_included" boolean DEFAULT true, "p_created_by" "uuid" DEFAULT NULL::"uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_record_id uuid;
  v_school_id uuid;
begin
  if not public.can_manage_accounting() then
    return public.app_err('Bu işlemi gerçekleştirmek için yetkiniz yok.', 'forbidden');
  end if;

  v_school_id := public.get_user_school_id();

  if v_school_id is null then
    return public.app_err('Kullanıcının bağlı olduğu okul bulunamadı.', 'forbidden');
  end if;

  if p_school_id is not null and p_school_id <> v_school_id then
    return public.app_err('Başka bir okul adına kayıt oluşturulamaz.', 'forbidden');
  end if;

  if not exists (
    select 1 from public.customers
     where id = p_customer_id and school_id = v_school_id
       and (is_deleted is false or is_deleted is null)
  ) then
    return public.app_err('Geçersiz veya yetkiniz olmayan bir müşteri seçildi.', 'validation');
  end if;

  if not public.finance_branch_ok(p_branch_id) then
    return public.app_err('Geçersiz veya yetkiniz olmayan bir şube seçildi.', 'validation');
  end if;

  if not public.customer_in_scope(p_customer_id) then
    return public.app_err('Geçersiz veya yetkiniz olmayan bir müşteri seçildi.', 'validation');
  end if;

  if (p_income_expense_item_id is not null and not public.income_expense_item_visible(p_income_expense_item_id))
     or (p_discount_id is not null and not public.discount_visible(p_discount_id)) then
    return public.app_err('Geçersiz veya yetkiniz olmayan bir gelir/gider kalemi ya da indirim seçildi.', 'validation');
  end if;

  insert into public.financial_records (
    customer_id, income_expense_item_id, discount_id, branch_id, school_id,
    type, name, description, invoice_no, expected_date, reminder_date,
    base_amount, discount_amount, tax_rate, tax_included, net_amount,
    status, created_by, is_deleted
  ) values (
    p_customer_id, p_income_expense_item_id, p_discount_id, p_branch_id, v_school_id,
    p_type, p_name, p_description, p_invoice_no, p_expected_date, p_reminder_date,
    p_base_amount, p_discount_amount, p_tax_rate, p_tax_included, p_net_amount,
    'unpaid', p_created_by, false
  ) returning id into v_record_id;

  return public.app_ok('Finansal kayıt başarıyla oluşturuldu.',
                       jsonb_build_object('id', v_record_id));
exception when others then
  return public.app_err(sqlerrm, public.app_sqlstate_code(sqlstate));
end;
$$;


ALTER FUNCTION "public"."create_financial_record"("p_customer_id" "uuid", "p_type" "public"."accounting_type", "p_name" "text", "p_expected_date" "date", "p_net_amount" numeric, "p_income_expense_item_id" "uuid", "p_discount_id" "uuid", "p_branch_id" "uuid", "p_school_id" "uuid", "p_description" "text", "p_invoice_no" "text", "p_reminder_date" "date", "p_base_amount" numeric, "p_discount_amount" numeric, "p_tax_rate" integer, "p_tax_included" boolean, "p_created_by" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."create_income_expense_item"("p_name" "text", "p_type" "public"."transaction_type", "p_value" numeric, "p_branch_ids" "uuid"[]) RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_school_id uuid := public.get_user_school_id();
  v_id        uuid;
begin
  if not public.has_permission('finance.manage') then
    return public.app_err('Bu işlemi gerçekleştirmek için yetkiniz yok.', 'forbidden');
  end if;
  if v_school_id is null then
    return public.app_err('Kullanıcının bağlı olduğu okul bulunamadı.', 'forbidden');
  end if;
  if coalesce(cardinality(p_branch_ids), 0) = 0 and not public.current_user_is_school_wide() then
    return public.app_err('En az bir şube seçilmelidir.', 'validation');
  end if;
  if exists (select 1 from unnest(coalesce(p_branch_ids, '{}'::uuid[])) as b(branch_id)
              where b.branch_id is null or not public.has_branch_access(b.branch_id)) then
    return public.app_err('Geçersiz veya yetkiniz olmayan bir şube seçildi.', 'validation');
  end if;
  if p_value < 0 then
    return public.app_err('Tutar negatif olamaz.', 'validation');
  end if;

  insert into public.income_expense_items (name, school_id, type, value)
  values (p_name, v_school_id, p_type, p_value)
  returning id into v_id;

  insert into public.branch_income_expense_item_links (school_id, income_expense_item_id, branch_id)
  select v_school_id, v_id, b
    from (select distinct unnest(coalesce(p_branch_ids, '{}'::uuid[])) as b) s;

  return public.app_ok('Gelir/Gider kalemi başarıyla oluşturuldu.', jsonb_build_object('id', v_id));
exception when others then
  return public.app_err(sqlerrm, public.app_sqlstate_code(sqlstate));
end;
$$;


ALTER FUNCTION "public"."create_income_expense_item"("p_name" "text", "p_type" "public"."transaction_type", "p_value" numeric, "p_branch_ids" "uuid"[]) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."create_pre_registration"("p_full_name" "text", "p_gender" "text", "p_date_of_birth" "date", "p_branch_id" "uuid", "p_class_id" "uuid", "p_interviewer_name" "text", "p_interview_type" "text", "p_interview_date" "date", "p_parent_full_name" "text", "p_parent_phone" "text", "p_parent_email" "text", "p_national_id" "text" DEFAULT NULL::"text", "p_phone" "text" DEFAULT NULL::"text", "p_address" "text" DEFAULT NULL::"text", "p_height" "text" DEFAULT NULL::"text", "p_weight" "text" DEFAULT NULL::"text", "p_health_problems" "text" DEFAULT NULL::"text", "p_has_health_report" boolean DEFAULT NULL::boolean, "p_has_sports_history" boolean DEFAULT NULL::boolean, "p_parent2_full_name" "text" DEFAULT NULL::"text", "p_parent2_phone" "text" DEFAULT NULL::"text", "p_parent2_email" "text" DEFAULT NULL::"text", "p_contract_possibility" "text" DEFAULT NULL::"text", "p_referral_source" "text" DEFAULT NULL::"text", "p_status" "text" DEFAULT 'not_converted'::"text", "p_health_consent" boolean DEFAULT NULL::boolean) RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_id          uuid;
  v_school_id   uuid := public.get_user_school_id();
  v_national_id text := public.normalize_national_id(p_national_id);
  v_consent_at  timestamp with time zone :=
    public.resolve_health_consent(p_health_consent, null);
begin
  if not public.has_permission('registration.manage') then
    return public.app_err('Bu işlemi gerçekleştirmek için yetkiniz yok.', 'forbidden');
  end if;

  if v_school_id is null then
    return public.app_err('Okul bilgisi bulunamadı, lütfen tekrar giriş yapın.', 'validation');
  end if;

  if v_national_id = 'invalid' then
    return public.app_err('T.C. Kimlik numarası 11 haneli olmalıdır.', 'validation');
  end if;

  if not public.has_branch_access(p_branch_id) then
    return public.app_err('Bu şubede işlem yapma yetkiniz yok.', 'forbidden');
  end if;

  if not exists (
    select 1 from public.classes
     where id = p_class_id and branch_id = p_branch_id
       and school_id = v_school_id and is_deleted is not true
  ) then
    return public.app_err('Seçilen şube/sınıf bu okula ait değil.', 'validation');
  end if;

  insert into public.pre_registrations (
    school_id, full_name, gender, date_of_birth, branch_id, class_id,
    interviewer_name, interview_type, interview_date, national_id, phone,
    address, height, weight, health_problems, has_health_report,
    has_sports_history, parent_full_name, parent_phone, parent_email,
    parent2_full_name, parent2_phone, parent2_email, contract_possibility,
    referral_source, status, health_consent_at
  ) values (
    v_school_id, p_full_name, p_gender::gender_type, p_date_of_birth,
    p_branch_id, p_class_id, p_interviewer_name,
    p_interview_type::interview_type, p_interview_date,
    v_national_id, nullif(p_phone, ''), nullif(p_address, ''),
    nullif(p_height, ''), nullif(p_weight, ''),
    case when v_consent_at is not null then nullif(p_health_problems, '') end,
    case when v_consent_at is not null then p_has_health_report end,
    p_has_sports_history,
    p_parent_full_name, p_parent_phone, p_parent_email,
    nullif(p_parent2_full_name, ''), nullif(p_parent2_phone, ''),
    nullif(p_parent2_email, ''),
    nullif(p_contract_possibility, '')::contract_possibility,
    nullif(p_referral_source, '')::referral_source,
    'not_converted', v_consent_at
  ) returning id into v_id;

  return public.app_ok('Ön kayıt başarıyla oluşturuldu.', jsonb_build_object('id', v_id));
exception when others then
  return public.app_err(sqlerrm, public.app_sqlstate_code(sqlstate));
end;
$$;


ALTER FUNCTION "public"."create_pre_registration"("p_full_name" "text", "p_gender" "text", "p_date_of_birth" "date", "p_branch_id" "uuid", "p_class_id" "uuid", "p_interviewer_name" "text", "p_interview_type" "text", "p_interview_date" "date", "p_parent_full_name" "text", "p_parent_phone" "text", "p_parent_email" "text", "p_national_id" "text", "p_phone" "text", "p_address" "text", "p_height" "text", "p_weight" "text", "p_health_problems" "text", "p_has_health_report" boolean, "p_has_sports_history" boolean, "p_parent2_full_name" "text", "p_parent2_phone" "text", "p_parent2_email" "text", "p_contract_possibility" "text", "p_referral_source" "text", "p_status" "text", "p_health_consent" boolean) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."create_public_pre_registration"("p_school_id" "uuid", "p_full_name" "text", "p_gender" "text", "p_date_of_birth" "date", "p_branch_id" "uuid", "p_class_id" "uuid", "p_national_id" "text", "p_phone" "text", "p_height" "text", "p_weight" "text", "p_health_problems" "text", "p_has_health_report" boolean, "p_has_sports_history" boolean, "p_address" "text", "p_parent_full_name" "text", "p_parent_phone" "text", "p_parent_email" "text", "p_parent2_full_name" "text", "p_parent2_phone" "text", "p_parent2_email" "text", "p_interview_date" "date", "p_referral_source" "text", "p_kvkk_approved" boolean) RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_id uuid;
  c_rate_window  constant interval := interval '1 hour';
  c_rate_limit   constant integer  := 5;
  c_dup_window   constant interval := interval '24 hours';
  v_recent_count integer;
begin
  if p_kvkk_approved is not true then
    return public.app_err('KVKK onayı olmadan kayıt oluşturulamaz.', 'validation');
  end if;

  if not exists (select 1 from public.schools where id = p_school_id) then
    return public.app_err('Okul bulunamadı.', 'not_found');
  end if;

  if not exists (
    select 1 from public.classes
     where id = p_class_id and branch_id = p_branch_id
       and school_id = p_school_id and is_deleted = false
  ) then
    return public.app_err('Seçilen şube/sınıf bu okula ait değil.', 'validation');
  end if;

  if exists (
    select 1
      from public.pre_registrations
     where school_id   = p_school_id
       and parent_phone = p_parent_phone
       and lower(btrim(full_name)) = lower(btrim(p_full_name))
       and created_at > now() - c_dup_window
  ) then
    return public.app_err(
      'Bu sporcu için son 24 saat içinde zaten bir ön kayıt aldık. Ekibimiz en kısa sürede sizinle iletişime geçecek.',
      'conflict'
    );
  end if;

  select count(*) into v_recent_count
    from public.pre_registrations
   where school_id    = p_school_id
     and parent_phone = p_parent_phone
     and created_at   > now() - c_rate_window;

  if v_recent_count >= c_rate_limit then
    return public.app_err(
      'Kısa sürede çok fazla ön kayıt gönderildi. Lütfen bir süre sonra tekrar deneyin.',
      'conflict'
    );
  end if;

  insert into public.pre_registrations (
    school_id, full_name, gender, date_of_birth, branch_id, class_id,
    national_id, phone, height, weight, health_problems, has_health_report,
    has_sports_history, address, parent_full_name, parent_phone, parent_email,
    parent2_full_name, parent2_phone, parent2_email, interviewer_name,
    interview_date, interview_type, referral_source, status, kvkk_approved_at
  ) values (
    p_school_id, p_full_name, p_gender::gender_type, p_date_of_birth,
    p_branch_id, p_class_id, nullif(p_national_id, ''), nullif(p_phone, ''),
    nullif(p_height, ''), nullif(p_weight, ''), nullif(p_health_problems, ''),
    p_has_health_report, p_has_sports_history, nullif(p_address, ''),
    p_parent_full_name, p_parent_phone, p_parent_email,
    nullif(p_parent2_full_name, ''), nullif(p_parent2_phone, ''),
    nullif(p_parent2_email, ''), 'Online Ön Kayıt (QR)', p_interview_date,
    'online', nullif(p_referral_source, '')::referral_source,
    'not_converted', now()
  ) returning id into v_id;

  return public.app_ok('Ön kayıt başarıyla alındı.', jsonb_build_object('id', v_id));
exception when others then
  return public.app_err(sqlerrm, public.app_sqlstate_code(sqlstate));
end;
$$;


ALTER FUNCTION "public"."create_public_pre_registration"("p_school_id" "uuid", "p_full_name" "text", "p_gender" "text", "p_date_of_birth" "date", "p_branch_id" "uuid", "p_class_id" "uuid", "p_national_id" "text", "p_phone" "text", "p_height" "text", "p_weight" "text", "p_health_problems" "text", "p_has_health_report" boolean, "p_has_sports_history" boolean, "p_address" "text", "p_parent_full_name" "text", "p_parent_phone" "text", "p_parent_email" "text", "p_parent2_full_name" "text", "p_parent2_phone" "text", "p_parent2_email" "text", "p_interview_date" "date", "p_referral_source" "text", "p_kvkk_approved" boolean) OWNER TO "postgres";


COMMENT ON FUNCTION "public"."create_public_pre_registration"("p_school_id" "uuid", "p_full_name" "text", "p_gender" "text", "p_date_of_birth" "date", "p_branch_id" "uuid", "p_class_id" "uuid", "p_national_id" "text", "p_phone" "text", "p_height" "text", "p_weight" "text", "p_health_problems" "text", "p_has_health_report" boolean, "p_has_sports_history" boolean, "p_address" "text", "p_parent_full_name" "text", "p_parent_phone" "text", "p_parent_email" "text", "p_parent2_full_name" "text", "p_parent2_phone" "text", "p_parent2_email" "text", "p_interview_date" "date", "p_referral_source" "text", "p_kvkk_approved" boolean) IS 'ESKİ imza (p_school_id ile). anon''a KAPALI: IP hız sınırı ve Turnstile yalnızca submit-pre-registration Edge Function''ında uygulanıyor ve bu imza onu atlıyordu. Yeni yol: create_public_pre_registration_by_token. Basılı QR''lar tükendiğinde bu fonksiyon tamamen kaldırılabilir.';


CREATE OR REPLACE FUNCTION "public"."create_public_pre_registration_by_token"("p_token" "text", "p_full_name" "text", "p_gender" "text", "p_date_of_birth" "date", "p_branch_id" "uuid", "p_class_id" "uuid", "p_national_id" "text", "p_phone" "text", "p_height" "text", "p_weight" "text", "p_health_problems" "text", "p_has_health_report" boolean, "p_has_sports_history" boolean, "p_address" "text", "p_parent_full_name" "text", "p_parent_phone" "text", "p_parent_email" "text", "p_parent2_full_name" "text", "p_parent2_phone" "text", "p_parent2_email" "text", "p_interview_date" "date", "p_referral_source" "text", "p_kvkk_approved" boolean, "p_health_consent" boolean DEFAULT NULL::boolean, "p_photo_consent" boolean DEFAULT NULL::boolean, "p_promo_photo_consent" boolean DEFAULT NULL::boolean) RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_school_id      uuid;
  v_id             uuid;
  c_rate_window    constant interval := interval '1 hour';
  c_rate_limit     constant integer  := 5;
  c_dup_window     constant interval := interval '24 hours';
  v_recent_count   integer;
  v_health_consent boolean := p_health_consent is true;
begin
  if p_kvkk_approved is not true then
    return public.app_err('KVKK onayı olmadan kayıt oluşturulamaz.', 'validation');
  end if;

  v_school_id := public.resolve_pre_registration_token(p_token);

  if v_school_id is null then
    return public.app_err('Bağlantı geçersiz ya da süresi dolmuş. Lütfen kurumla iletişime geçin.', 'not_found');
  end if;

  if not exists (
    select 1 from public.classes
     where id = p_class_id and branch_id = p_branch_id
       and school_id = v_school_id and is_deleted = false
  ) then
    return public.app_err('Seçilen şube/sınıf bu okula ait değil.', 'validation');
  end if;

  if exists (
    select 1 from public.pre_registrations
     where school_id = v_school_id
       and parent_phone = p_parent_phone
       and lower(btrim(full_name)) = lower(btrim(p_full_name))
       and created_at > now() - c_dup_window
  ) then
    return public.app_err('Bu sporcu için son 24 saat içinde zaten bir ön kayıt aldık. Ekibimiz en kısa sürede sizinle iletişime geçecek.', 'conflict');
  end if;

  select count(*) into v_recent_count
    from public.pre_registrations
   where school_id = v_school_id
     and parent_phone = p_parent_phone
     and created_at > now() - c_rate_window;

  if v_recent_count >= c_rate_limit then
    return public.app_err('Kısa sürede çok fazla ön kayıt gönderildi. Lütfen bir süre sonra tekrar deneyin.', 'conflict');
  end if;

  -- Rıza yoksa sağlık alanları istemciden ne gelirse gelsin yazılmaz.
  insert into public.pre_registrations (
    school_id, full_name, gender, date_of_birth, branch_id, class_id,
    national_id, phone, height, weight, health_problems, has_health_report,
    has_sports_history, address, parent_full_name, parent_phone, parent_email,
    parent2_full_name, parent2_phone, parent2_email, interviewer_name,
    interview_date, interview_type, referral_source, status, kvkk_approved_at,
    health_consent_at, photo_consent_at, promo_photo_consent_at
  ) values (
    v_school_id, p_full_name, p_gender::gender_type, p_date_of_birth,
    p_branch_id, p_class_id, nullif(p_national_id, ''), nullif(p_phone, ''),
    nullif(p_height, ''), nullif(p_weight, ''),
    case when v_health_consent then nullif(p_health_problems, '') end,
    case when v_health_consent then p_has_health_report end,
    p_has_sports_history, nullif(p_address, ''),
    p_parent_full_name, p_parent_phone, p_parent_email,
    nullif(p_parent2_full_name, ''), nullif(p_parent2_phone, ''),
    nullif(p_parent2_email, ''), 'Online Ön Kayıt (QR)', p_interview_date,
    'online', nullif(p_referral_source, '')::referral_source,
    'not_converted', now(),
    case when v_health_consent then now() end,
    case when p_photo_consent is true then now() end,
    case when p_promo_photo_consent is true then now() end
  ) returning id into v_id;

  return public.app_ok('Ön kayıt başarıyla alındı.', jsonb_build_object('id', v_id));
exception when others then
  return public.app_err(sqlerrm, public.app_sqlstate_code(sqlstate));
end;
$$;


ALTER FUNCTION "public"."create_public_pre_registration_by_token"("p_token" "text", "p_full_name" "text", "p_gender" "text", "p_date_of_birth" "date", "p_branch_id" "uuid", "p_class_id" "uuid", "p_national_id" "text", "p_phone" "text", "p_height" "text", "p_weight" "text", "p_health_problems" "text", "p_has_health_report" boolean, "p_has_sports_history" boolean, "p_address" "text", "p_parent_full_name" "text", "p_parent_phone" "text", "p_parent_email" "text", "p_parent2_full_name" "text", "p_parent2_phone" "text", "p_parent2_email" "text", "p_interview_date" "date", "p_referral_source" "text", "p_kvkk_approved" boolean, "p_health_consent" boolean, "p_photo_consent" boolean, "p_promo_photo_consent" boolean) OWNER TO "postgres";


COMMENT ON FUNCTION "public"."create_public_pre_registration_by_token"("p_token" "text", "p_full_name" "text", "p_gender" "text", "p_date_of_birth" "date", "p_branch_id" "uuid", "p_class_id" "uuid", "p_national_id" "text", "p_phone" "text", "p_height" "text", "p_weight" "text", "p_health_problems" "text", "p_has_health_report" boolean, "p_has_sports_history" boolean, "p_address" "text", "p_parent_full_name" "text", "p_parent_phone" "text", "p_parent_email" "text", "p_parent2_full_name" "text", "p_parent2_phone" "text", "p_parent2_email" "text", "p_interview_date" "date", "p_referral_source" "text", "p_kvkk_approved" boolean, "p_health_consent" boolean, "p_photo_consent" boolean, "p_promo_photo_consent" boolean) IS 'Online ön kayıt yazma yolu. anon''a KAPALI: yalnızca submit-pre-registration Edge Function''ı service_role ile çağırır. Üç rıza (sağlık, fotoğraf, tanıtım fotoğrafı) ayrı ayrı; sağlık rızası yoksa sağlık alanları yazılmaz.';


CREATE OR REPLACE FUNCTION "public"."create_school"("p_name" "text", "p_city" "text", "p_district" "text", "p_address" "text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_user_id                 uuid;
  v_profile_id              uuid;
  v_current_school_id       uuid;
  v_new_school_id           uuid;
  v_general_manager_role_id integer;
begin
  v_user_id := auth.uid();

  if v_user_id is null then
    return public.app_err('Kullanıcı girişi yapılmamış.', 'forbidden');
  end if;

  select id, school_id into v_profile_id, v_current_school_id
    from public.profiles where id = v_user_id;

  if v_profile_id is null then
    return public.app_err('Profil bulunamadı. Lütfen önce profil oluşturun.', 'not_found');
  end if;

  if v_current_school_id is not null and exists (
    select 1 from public.schools
     where id = v_current_school_id and is_deleted is not true
  ) then
    return public.app_err('Hesabınız zaten bir okula bağlı.', 'conflict');
  end if;

  select id into v_general_manager_role_id
    from public.roles where name = 'general_manager';

  if v_general_manager_role_id is null then
    return public.app_err(
      'Sistemde "general_manager" rolü bulunamadı. Lütfen yetkilendirme ayarlarını kontrol edin.',
      'internal');
  end if;

  insert into public.schools (
    name, city, district, address, owner_id,
    subscription_status, trial_starts_at, trial_ends_at
  ) values (
    p_name, p_city, p_district, p_address, v_profile_id,
    'trial', now(), now() + interval '14 days'
  ) returning id into v_new_school_id;

  update public.profiles
     set school_id = v_new_school_id,
         role_id   = v_general_manager_role_id
   where id = v_profile_id;

  return public.app_ok('Okul başarıyla oluşturuldu.',
                       jsonb_build_object('id', v_new_school_id));
exception when others then
  return public.app_err(sqlerrm, public.app_sqlstate_code(sqlstate));
end;
$$;


ALTER FUNCTION "public"."create_school"("p_name" "text", "p_city" "text", "p_district" "text", "p_address" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."create_sport"("p_name" "text", "p_school_id" "uuid", "p_branch_ids" "uuid"[]) RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_school_id    uuid;
  v_name         text;
  v_branch_id    uuid;
  v_new_sport_id uuid;
begin
  if not public.has_permission('registration.manage') then
    return public.app_err('Bu işlemi gerçekleştirmek için yetkiniz yok.', 'forbidden');
  end if;

  v_school_id := public.get_user_school_id();

  if v_school_id is null then
    return public.app_err('Kullanıcının bağlı olduğu okul bulunamadı.', 'forbidden');
  end if;

  if p_school_id is not null and p_school_id <> v_school_id then
    return public.app_err('Bu okula spor branşı ekleme yetkiniz yok.', 'forbidden');
  end if;

  v_name := btrim(coalesce(p_name, ''));

  if v_name = '' then
    return public.app_err('Branş adı boş olamaz.', 'validation');
  end if;

  if p_branch_ids is null or array_length(p_branch_ids, 1) is null then
    return public.app_err('En az bir şube seçilmelidir.', 'validation');
  end if;

  if exists (
    select 1
      from public.sports
     where school_id = v_school_id
       and lower(name) = lower(v_name)
       and is_deleted is not true
  ) then
    return public.app_err('Bu isimde bir branş zaten tanımlı.', 'conflict');
  end if;

  -- Şubeler önce baştan sona doğrulanır, sonra yazılır. has_branch_access
  -- okulu ve silinmişliği de sorar.
  foreach v_branch_id in array p_branch_ids
  loop
    if not public.has_branch_access(v_branch_id) then
      return public.app_err('Geçersiz veya yetkiniz olmayan bir şube seçildi.', 'validation');
    end if;
  end loop;

  insert into public.sports (name, school_id)
  values (v_name, v_school_id)
  returning id into v_new_sport_id;

  foreach v_branch_id in array p_branch_ids
  loop
    insert into public.branch_sport_links (branch_id, sport_id, school_id)
    values (v_branch_id, v_new_sport_id, v_school_id)
    on conflict (branch_id, sport_id) do update
      set is_deleted = false;
  end loop;

  return public.app_ok(
    'Branş bilgisi başarıyla oluşturuldu.',
    jsonb_build_object('id', v_new_sport_id)
  );
exception when others then
  return public.app_err(sqlerrm, public.app_sqlstate_code(sqlstate));
end;
$$;


ALTER FUNCTION "public"."create_sport"("p_name" "text", "p_school_id" "uuid", "p_branch_ids" "uuid"[]) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."create_transaction"("p_record_id" "uuid", "p_amount" numeric, "p_method" "public"."payment_method", "p_transaction_date" timestamp with time zone DEFAULT "now"(), "p_processed_by" "uuid" DEFAULT NULL::"uuid", "p_school_id" "uuid" DEFAULT NULL::"uuid", "p_branch_id" "uuid" DEFAULT NULL::"uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_school_id      uuid;
  v_branch_id      uuid;
  v_transaction_id uuid;
begin
  if not public.can_manage_accounting() then
    return public.app_err('Bu işlemi gerçekleştirmek için yetkiniz yok.', 'forbidden');
  end if;

  v_school_id := public.get_user_school_id();
  if v_school_id is null
     or (p_school_id is not null and p_school_id <> v_school_id) then
    return public.app_err('Bu işlemi gerçekleştirmek için yetkiniz yok.', 'forbidden');
  end if;

  -- Tahsilatın şubesi tahakkukun şubesidir; istemcinin p_branch_id'si
  -- uyumluluk için imzada kalır ama okunmaz.
  select fr.branch_id into v_branch_id
    from public.financial_records fr
   where fr.id = p_record_id
     and fr.school_id = v_school_id
     and fr.is_deleted is not true
     and public.finance_branch_ok(fr.branch_id);

  if not found then
    return public.app_err('Tahsilat yapılacak finansal kayıt bulunamadı.', 'not_found');
  end if;

  insert into public.transactions (
    record_id, amount, method, transaction_date, processed_by,
    school_id, branch_id, is_deleted
  ) values (
    p_record_id, p_amount, p_method, coalesce(p_transaction_date, now()), auth.uid(),
    v_school_id, v_branch_id, false
  ) returning id into v_transaction_id;

  perform public.recalculate_financial_record_status(p_record_id);

  return public.app_ok('Tahsilat başarıyla işlendi.', jsonb_build_object('id', v_transaction_id));
exception when others then
  return public.app_err(sqlerrm, public.app_sqlstate_code(sqlstate));
end;
$$;


ALTER FUNCTION "public"."create_transaction"("p_record_id" "uuid", "p_amount" numeric, "p_method" "public"."payment_method", "p_transaction_date" timestamp with time zone, "p_processed_by" "uuid", "p_school_id" "uuid", "p_branch_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."current_user_branch_ids"() RETURNS SETOF "uuid"
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select b.id
    from public.branches b
   where b.school_id = public.get_user_school_id()
     and b.is_deleted is not true
     and (
          public.current_user_is_school_wide()
       or exists (
            select 1
              from public.profile_branch_links pbl
             where pbl.profile_id = auth.uid()
               and pbl.branch_id  = b.id
               and pbl.is_deleted is not true
          )
     );
$$;


ALTER FUNCTION "public"."current_user_branch_ids"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."current_user_is_school_wide"() RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select public.is_school_wide_role(public.get_user_role());
$$;


ALTER FUNCTION "public"."current_user_is_school_wide"() OWNER TO "postgres";


COMMENT ON FUNCTION "public"."current_user_is_school_wide"() IS 'Oturumdaki kullanıcının rolü okul geneli mi. Şube erişimi okuyan politikalar ve RPC''ler bunu sorar.';


CREATE OR REPLACE FUNCTION "public"."customer_in_scope"("p_customer_id" "uuid") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select exists (
    select 1
      from public.customers c
     where c.id = p_customer_id
       and c.school_id = public.get_user_school_id()
       and c.is_deleted is not true
       and (
            c.athlete_id is null
         or public.current_user_is_school_wide()
         or exists (select 1 from public.athletes a
                     where a.id = c.athlete_id
                       and public.has_branch_access(a.branch_id))
       )
  );
$$;


ALTER FUNCTION "public"."customer_in_scope"("p_customer_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."delete_athlete"("p_athlete_id" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_school_id uuid;
  v_branch_id uuid;
begin
  if not public.has_permission('registration.manage') then
    return public.app_err('Bu işlemi gerçekleştirmek için yetkiniz yok.', 'forbidden');
  end if;

  v_school_id := get_user_school_id();

  select branch_id into v_branch_id
    from public.athletes
   where id = p_athlete_id and school_id = v_school_id and is_deleted is not true;

  if not found or not public.has_branch_access(v_branch_id) then
    return public.app_err('Sporcu bulunamadı veya bu kayıt üzerinde işlem yetkiniz yok.', 'not_found');
  end if;

  update public.athletes set is_deleted = true
   where id = p_athlete_id and school_id = v_school_id and is_deleted is not true;

  update public.parent_athlete_links set is_deleted = true
   where athlete_id = p_athlete_id and school_id = v_school_id and is_deleted is not true;

  return public.app_ok('Sporcu başarıyla silindi.');
exception when others then
  return public.app_err(sqlerrm, public.app_sqlstate_code(sqlstate));
end;
$$;


ALTER FUNCTION "public"."delete_athlete"("p_athlete_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."delete_branch"("p_branch_id" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_school_id uuid;
begin
  if not public.has_permission('school.manage') then
    return public.app_err('Bu işlemi gerçekleştirmek için yetkiniz yok.', 'forbidden');
  end if;

  v_school_id := get_user_school_id();

  update public.branches
     set is_deleted = true
   where id = p_branch_id
     and school_id = v_school_id
     and is_deleted is not true;

  if not found then
    return public.app_err('Şube bulunamadı veya bu kayıt üzerinde işlem yetkiniz yok.', 'not_found');
  end if;

  -- Subeye bagli tum link kayitlari.
  update public.branch_sport_links set is_deleted = true
   where branch_id = p_branch_id and school_id = v_school_id and is_deleted is not true;

  update public.branch_class_links set is_deleted = true
   where branch_id = p_branch_id and school_id = v_school_id and is_deleted is not true;

  update public.profile_branch_links set is_deleted = true
   where branch_id = p_branch_id and school_id = v_school_id and is_deleted is not true;

  update public.branch_discount_links set is_deleted = true
   where branch_id = p_branch_id and school_id = v_school_id and is_deleted is not true;

  update public.branch_income_expense_item_links set is_deleted = true
   where branch_id = p_branch_id and school_id = v_school_id and is_deleted is not true;

  return public.app_ok('Şube başarıyla silindi.');
exception when others then
  return public.app_err(sqlerrm, public.app_sqlstate_code(sqlstate));
end;$$;


ALTER FUNCTION "public"."delete_branch"("p_branch_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."delete_class"("p_class_id" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_school_id uuid;
  v_branch_id uuid;
begin
  if not public.has_permission('registration.manage') then
    return public.app_err('Bu işlemi gerçekleştirmek için yetkiniz yok.', 'forbidden');
  end if;

  v_school_id := get_user_school_id();

  select branch_id into v_branch_id
    from public.classes
   where id = p_class_id and school_id = v_school_id and is_deleted is not true;

  if not found or not public.has_branch_access(v_branch_id) then
    return public.app_err('Sınıf bulunamadı veya bu kayıt üzerinde işlem yetkiniz yok.', 'not_found');
  end if;

  update public.classes set is_deleted = true
   where id = p_class_id and school_id = v_school_id and is_deleted is not true;

  if not found then
    return public.app_err('Sınıf silinirken bir hata oluştu.', 'internal');
  end if;

  update public.branch_class_links set is_deleted = true
   where class_id = p_class_id and school_id = v_school_id and is_deleted is not true;

  update public.coach_class_links set is_deleted = true
   where class_id = p_class_id and school_id = v_school_id and is_deleted is not true;

  update public.class_schedule_slots set is_deleted = true
   where class_id = p_class_id and school_id = v_school_id and is_deleted is not true;

  return public.app_ok('Sınıf başarıyla silindi.');
exception when others then
  return public.app_err(sqlerrm, public.app_sqlstate_code(sqlstate));
end;
$$;


ALTER FUNCTION "public"."delete_class"("p_class_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."delete_class_attendance"("p_class_id" "uuid", "p_attendance_date" "date") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_count int;
begin
  if not public.has_permission('attendance.take') then
    return public.app_err('Yoklama silmek için yetkiniz yok.', 'forbidden');
  end if;

  if not exists (
    select 1 from public.classes c
     where c.id = p_class_id
       and c.school_id = public.get_user_school_id()
       and public.has_branch_access(c.branch_id)
  ) then
    return public.app_err('Silinecek yoklama kaydı bulunamadı.', 'not_found');
  end if;

  update public.attendances
     set is_deleted = true
   where class_id = p_class_id
     and attendance_date = p_attendance_date
     and school_id = public.get_user_school_id()
     and (is_deleted is false or is_deleted is null);

  get diagnostics v_count = row_count;

  if v_count = 0 then
    return public.app_err('Silinecek yoklama kaydı bulunamadı.', 'not_found');
  end if;

  return public.app_ok(null, jsonb_build_object('deleted_count', v_count));
exception
  when others then
    return public.app_err(sqlerrm, public.app_sqlstate_code(sqlstate));
end;
$$;


ALTER FUNCTION "public"."delete_class_attendance"("p_class_id" "uuid", "p_attendance_date" "date") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."delete_coach"("p_coach_id" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_school_id uuid := public.get_user_school_id();
  v_error     text;
begin
  if not exists (
    select 1 from public.profiles
     where id = p_coach_id and school_id = v_school_id
       and role_id = 4 and is_deleted is not true
  ) then
    return public.app_err('Eğitmen bulunamadı veya bu kayıt üzerinde işlem yetkiniz yok.', 'not_found');
  end if;

  v_error := public.staff_management_error(p_coach_id, null, null);
  if v_error is not null or p_coach_id = auth.uid() then
    return public.app_err(coalesce(v_error, 'Bu işlemi gerçekleştirmek için yetkiniz yok.'), 'forbidden');
  end if;

  update public.profiles set is_deleted = true
   where id = p_coach_id and school_id = v_school_id and is_deleted is not true;

  update public.coach_class_links set is_deleted = true
   where profile_id = p_coach_id and school_id = v_school_id and is_deleted is not true;

  update public.profile_branch_links set is_deleted = true
   where profile_id = p_coach_id and school_id = v_school_id and is_deleted is not true;

  update public.profile_permissions set is_deleted = true
   where profile_id = p_coach_id and is_deleted is not true;

  return public.app_ok('Eğitmen başarıyla silindi.');
exception when others then
  return public.app_err(sqlerrm, public.app_sqlstate_code(sqlstate));
end;
$$;


ALTER FUNCTION "public"."delete_coach"("p_coach_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."delete_customer"("p_id" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$begin
  IF not public.can_manage_accounting() THEN
    RETURN public.app_err('Bu işlemi gerçekleştirmek için yetkiniz yok.', 'forbidden');
 END IF;

  update public.customers
     set is_deleted = true
   where id = p_id
     and school_id = public.get_user_school_id()
     and public.customer_in_scope(id);

  if not found then
    return public.app_err('Silinecek müşteri bulunamadı.', 'not_found');
  end if;

  return public.app_ok('Müşteri başarıyla silindi.');
exception when others then
  return public.app_err(sqlerrm, public.app_sqlstate_code(sqlstate));
end;$$;


ALTER FUNCTION "public"."delete_customer"("p_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."delete_discount"("p_discount_id" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_school_id uuid := public.get_user_school_id();
begin
  if not public.has_permission('finance.manage') then
    return public.app_err('Bu işlemi gerçekleştirmek için yetkiniz yok.', 'forbidden');
  end if;
  if not exists (select 1 from public.discounts
                  where id = p_discount_id and school_id = v_school_id and is_deleted is not true) then
    return public.app_err('Silinecek indirim bulunamadı veya zaten silinmiş.', 'not_found');
  end if;
  if not public.discount_writable(p_discount_id) then
    return public.app_err('Bu indirim yetkiniz olmayan bir şubede de kullanılıyor; silemezsiniz.', 'forbidden');
  end if;

  update public.discounts set is_deleted = true where id = p_discount_id;

  return public.app_ok('İndirim başarıyla silindi.');
exception when others then
  return public.app_err(sqlerrm, public.app_sqlstate_code(sqlstate));
end;
$$;


ALTER FUNCTION "public"."delete_discount"("p_discount_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."delete_financial_record"("p_id" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$begin
  IF not public.can_manage_accounting() THEN
    RETURN public.app_err('Bu işlemi gerçekleştirmek için yetkiniz yok.', 'forbidden');
  END IF;

  update public.financial_records
     set is_deleted = true
   where id = p_id
     and school_id = public.get_user_school_id()
     and public.finance_branch_ok(branch_id);

  if not found then
    return public.app_err('Silinecek finansal kayıt bulunamadı.', 'not_found');
  end if;

  update public.transactions
     set is_deleted = true
   where record_id = p_id;

  return public.app_ok('Finansal kayıt ve bağlı tahsilatları silindi.');
exception when others then
  return public.app_err(sqlerrm, public.app_sqlstate_code(sqlstate));
end;$$;


ALTER FUNCTION "public"."delete_financial_record"("p_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."delete_income_expense_item"("p_item_id" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_school_id uuid := public.get_user_school_id();
begin
  if not public.has_permission('finance.manage') then
    return public.app_err('Bu işlemi gerçekleştirmek için yetkiniz yok.', 'forbidden');
  end if;
  if not exists (select 1 from public.income_expense_items
                  where id = p_item_id and school_id = v_school_id and is_deleted is not true) then
    return public.app_err('Silinecek kalem bulunamadı veya yetkiniz yok.', 'not_found');
  end if;
  if not public.income_expense_item_writable(p_item_id) then
    return public.app_err('Bu kalem yetkiniz olmayan bir şubede de kullanılıyor; silemezsiniz.', 'forbidden');
  end if;

  update public.income_expense_items set is_deleted = true where id = p_item_id;

  return public.app_ok('Gelir/Gider kalemi başarıyla silindi.');
exception when others then
  return public.app_err(sqlerrm, public.app_sqlstate_code(sqlstate));
end;
$$;


ALTER FUNCTION "public"."delete_income_expense_item"("p_item_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."delete_own_account"("p_user_id" "uuid", "p_validate_only" boolean DEFAULT false) RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_profile     public.profiles%rowtype;
  v_has_profile boolean;
  v_school      public.schools%rowtype;
begin
  if p_user_id is null
     or not exists (select 1 from auth.users where id = p_user_id) then
    return public.app_err('Kullanıcı bulunamadı.', 'not_found');
  end if;

  select * into v_profile
    from public.profiles
   where id = p_user_id
     for update;
  v_has_profile := found;

  if v_has_profile
     and v_profile.account_deleted_at is null
     and v_profile.role_id = 9
     and v_profile.school_id is not null then
    select * into v_school from public.schools where id = v_profile.school_id;

    if found and v_school.is_deleted is not true and not exists (
      select 1 from public.profiles p
       where p.school_id = v_profile.school_id
         and p.role_id = 9
         and p.id <> p_user_id
         and p.is_deleted is not true
         and p.status = 'active'
    ) then
      return public.app_err(
        case when v_school.is_self_service
          then 'Okulun tek genel müdürü sizsiniz. Hesabınızı silmeden önce '
               'başka bir kullanıcıyı genel müdür yapın ya da Okul Bilgileri '
               'ekranından okulu silin.'
          else 'Okulun tek genel müdürü sizsiniz. Hesabınızı silmeden önce '
               'başka bir kullanıcıyı genel müdür yapın.'
        end,
        'conflict');
    end if;
  end if;

  if p_validate_only then
    return public.app_ok(null);
  end if;

  if v_has_profile then
    delete from public.push_tokens              where profile_id   = p_user_id;
    delete from public.notification_preferences where profile_id   = p_user_id;
    delete from public.notifications            where recipient_id = p_user_id;

    update public.parent_athlete_links set is_deleted = true
     where profile_id = p_user_id and is_deleted is not true;
    update public.profile_branch_links set is_deleted = true
     where profile_id = p_user_id and is_deleted is not true;
    update public.coach_class_links set is_deleted = true
     where profile_id = p_user_id and is_deleted is not true;
    update public.profile_permissions set is_deleted = true
     where profile_id = p_user_id and is_deleted is not true;

    update public.notifications n
       set params = jsonb_set(n.params, '{sender_name}', to_jsonb(s.name))
      from public.schools s
     where s.id = n.school_id
       and n.params ? 'sender_name'
       and (n.announcement_id in (
              select a.id from public.notification_announcements a
               where a.sender_id = p_user_id)
         or n.direct_message_id in (
              select m.id from public.direct_messages m
               where m.sender_id = p_user_id));

    update public.profiles
       set full_name          = 'Silinmiş kullanıcı',
           email              = 'silinmis-' || p_user_id || '@silinmis.invalid',
           phone_number       = null,
           birth_of_date      = null,
           status             = 'passive',
           is_deleted         = true,
           account_deleted_at = coalesce(account_deleted_at, now())
     where id = p_user_id;
  end if;

  delete from auth.identities      where user_id = p_user_id;
  delete from auth.refresh_tokens  where user_id = p_user_id::text;
  delete from auth.sessions        where user_id = p_user_id;
  delete from auth.mfa_factors     where user_id = p_user_id;
  delete from auth.one_time_tokens where user_id = p_user_id;

  update auth.users
     set email                      = null,
         phone                      = null,
         encrypted_password         = null,
         email_change               = '',
         phone_change               = '',
         confirmation_token         = '',
         recovery_token             = '',
         email_change_token_new     = '',
         email_change_token_current = '',
         phone_change_token         = '',
         reauthentication_token     = '',
         raw_user_meta_data         = '{}'::jsonb,
         raw_app_meta_data          = '{}'::jsonb,
         banned_until               = '2999-12-31 00:00:00+00',
         deleted_at                 = coalesce(deleted_at, now()),
         updated_at                 = now()
   where id = p_user_id;

  return public.app_ok('Hesabınız silindi.');
exception when others then
  return public.app_err(sqlerrm, public.app_sqlstate_code(sqlstate));
end;
$$;


ALTER FUNCTION "public"."delete_own_account"("p_user_id" "uuid", "p_validate_only" boolean) OWNER TO "postgres";


COMMENT ON FUNCTION "public"."delete_own_account"("p_user_id" "uuid", "p_validate_only" boolean) IS 'Kullanıcının kendi hesabını siler: profili anonimleştirir, auth kaydını boşaltır. Yalnızca delete-account Edge Function''ı (service_role) çağırır.';


CREATE OR REPLACE FUNCTION "public"."delete_parent"("p_parent_id" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_school_id uuid := public.get_user_school_id();
begin
  if not public.has_permission('registration.manage') then
    return public.app_err('Bu işlemi gerçekleştirmek için yetkiniz yok.', 'forbidden');
  end if;

  if not exists (
    select 1 from public.profiles
     where id = p_parent_id and school_id = v_school_id
       and role_id = 8 and is_deleted is not true
  ) then
    return public.app_err('Veli bulunamadı veya bu kayıt üzerinde işlem yetkiniz yok.', 'not_found');
  end if;

  if not public.can_manage_parent(p_parent_id) then
    return public.app_err('Bu veli yetkiniz olmayan bir şubede.', 'forbidden');
  end if;

  update public.profiles set is_deleted = true
   where id = p_parent_id and school_id = v_school_id and is_deleted is not true;

  update public.parent_athlete_links set is_deleted = true
   where profile_id = p_parent_id and school_id = v_school_id and is_deleted is not true;

  update public.profile_branch_links set is_deleted = true
   where profile_id = p_parent_id and school_id = v_school_id and is_deleted is not true;

  return public.app_ok('Veli başarıyla silindi.');
exception when others then
  return public.app_err(sqlerrm, public.app_sqlstate_code(sqlstate));
end;
$$;


ALTER FUNCTION "public"."delete_parent"("p_parent_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."delete_pre_registration"("p_pre_registration_id" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_branch_id uuid;
begin
  if not public.has_permission('registration.manage') then
    return public.app_err('Bu işlemi gerçekleştirmek için yetkiniz yok.', 'forbidden');
  end if;

  select branch_id into v_branch_id
    from public.pre_registrations
   where id = p_pre_registration_id
     and school_id = public.get_user_school_id()
     and is_deleted is not true;

  if not found or not public.has_branch_access(v_branch_id) then
    return public.app_err(
      'Ön kayıt bulunamadı veya bu kayıt üzerinde işlem yetkiniz yok.', 'not_found');
  end if;

  update public.pre_registrations
     set is_deleted = true
   where id = p_pre_registration_id
     and is_deleted is not true;

  return public.app_ok('Ön kayıt başarıyla silindi.');
exception when others then
  return public.app_err(sqlerrm, public.app_sqlstate_code(sqlstate));
end;
$$;


ALTER FUNCTION "public"."delete_pre_registration"("p_pre_registration_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."delete_school"("p_school_id" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
  -- Yalnızca genel müdür (9) ve müdür (1) okulu silebilir.
  if not public.has_permission('school.manage') then
    return public.app_err('Okulu yalnızca yönetici silebilir.', 'forbidden');
  end if;

  -- Yönetici yalnızca kendi okulunu silebilir.
  if not exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.school_id = p_school_id
  ) then
    return public.app_err('Bu okulu silme yetkiniz yok.', 'forbidden');
  end if;

  -- Okul kendi kaydını kapatabiliyor mu? Bu kontrol istemcinin hangi sürüm
  -- olduğundan bağımsızdır: public uygulamadan giren Dev Adım yöneticisi de
  -- buraya düşer.
  if not exists (
    select 1 from public.schools s
    where s.id = p_school_id and s.is_self_service
  ) then
    return public.app_err(
      'Bu okulun kaydı uygulama üzerinden kapatılamaz.', 'forbidden');
  end if;

  update public.schools
  set is_deleted = true
  where id = p_school_id;

  if not found then
    return public.app_err('Okul bulunamadı.', 'not_found');
  end if;

  return public.app_ok('Okul başarıyla silindi.');
end;
$$;


ALTER FUNCTION "public"."delete_school"("p_school_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."delete_sport"("p_sport_id" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_school_id uuid;
  v_classes     text;
begin
  if not public.has_permission('registration.manage') then
    return public.app_err('Bu işlemi gerçekleştirmek için yetkiniz yok.', 'forbidden');
  end if;

  v_school_id := public.get_user_school_id();

  if not exists (
    select 1
      from public.sports
     where id = p_sport_id
       and school_id = v_school_id
       and is_deleted is not true
  ) then
    return public.app_err('Silinecek branş bulunamadı veya yetkiniz yok.', 'not_found');
  end if;

  if not public.sport_writable(p_sport_id) then
    return public.app_err(
      'Bu branş yetkiniz olmayan bir şubede de kullanılıyor; silemezsiniz.', 'forbidden');
  end if;

  select string_agg(t.name, ', ' order by t.name)
    into v_classes
    from public.classes t
   where t.sport_id = p_sport_id
     and t.school_id = v_school_id
     and t.is_deleted is not true;

  if v_classes is not null then
    return public.app_err(
      'Bu branş şu sınıflarda kullanıldığı için silinemez: ' || v_classes ||
      '. Önce ilgili sınıfları silin.',
      'conflict'
    );
  end if;

  update public.branch_sport_links
     set is_deleted = true
   where sport_id = p_sport_id
     and school_id = v_school_id
     and is_deleted is not true;

  update public.sports
     set is_deleted = true
   where id = p_sport_id
     and school_id = v_school_id;

  return public.app_ok('Branş başarıyla silindi.');
exception when others then
  return public.app_err(sqlerrm, public.app_sqlstate_code(sqlstate));
end;
$$;


ALTER FUNCTION "public"."delete_sport"("p_sport_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."delete_transaction"("p_id" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_record_id uuid;
begin
  if not public.can_manage_accounting() then
    return public.app_err('Bu işlemi gerçekleştirmek için yetkiniz yok.', 'forbidden');
  end if;

  update public.transactions
     set is_deleted = true
   where id = p_id
     and school_id = public.get_user_school_id()
     and is_deleted is not true
     and public.finance_branch_ok(branch_id)
  returning record_id into v_record_id;

  if not found then
    return public.app_err('Silinecek tahsilat kaydı bulunamadı.', 'not_found');
  end if;

  perform public.recalculate_financial_record_status(v_record_id);

  return public.app_ok('Tahsilat kaydı silindi.');
exception when others then
  return public.app_err(sqlerrm, public.app_sqlstate_code(sqlstate));
end;
$$;


ALTER FUNCTION "public"."delete_transaction"("p_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."delete_user"("p_user_id" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_school_id uuid := public.get_user_school_id();
  v_role_id   bigint;
  v_error     text;
begin
  if p_user_id = auth.uid() then
    return public.app_err('Kendi hesabınızı silemezsiniz.', 'forbidden');
  end if;

  v_error := public.staff_management_error(p_user_id, null, null);
  if v_error is not null then
    return public.app_err(v_error, 'forbidden');
  end if;

  select role_id into v_role_id from public.profiles where id = p_user_id;

  if v_role_id = 9 and not exists (
    select 1 from public.profiles
     where school_id = v_school_id and role_id = 9
       and is_deleted is not true and id <> p_user_id
  ) then
    return public.app_err('Okulda en az bir aktif genel müdür bulunmalıdır. Son genel müdür silinemez.', 'conflict');
  end if;

  update public.profiles set is_deleted = true
   where id = p_user_id and school_id = v_school_id and is_deleted is not true;

  if not found then
    return public.app_err('Kullanıcı silinirken bir hata oluştu.', 'internal');
  end if;

  update public.profile_branch_links set is_deleted = true
   where profile_id = p_user_id and school_id = v_school_id and is_deleted is not true;

  update public.coach_class_links set is_deleted = true
   where profile_id = p_user_id and school_id = v_school_id and is_deleted is not true;

  update public.profile_permissions set is_deleted = true
   where profile_id = p_user_id and is_deleted is not true;

  return public.app_ok('Kullanıcı başarıyla silindi.');
exception when others then
  return public.app_err(sqlerrm, public.app_sqlstate_code(sqlstate));
end;
$$;


ALTER FUNCTION "public"."delete_user"("p_user_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."direct_message_recipients"("p_athlete_id" "uuid") RETURNS TABLE("profile_id" "uuid")
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select p.id
    from public.parent_athlete_links pal
    join public.athletes a on a.id = pal.athlete_id
    join public.profiles p on p.id = pal.profile_id
   where pal.athlete_id = p_athlete_id
     and pal.is_deleted is not true
     and a.is_deleted is not true
     and p.is_deleted is not true
     and p.status = 'active'
     and p.role_id = 8
     and p.school_id = a.school_id;
$$;


ALTER FUNCTION "public"."direct_message_recipients"("p_athlete_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."discount_visible"("p_discount_id" "uuid") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select exists (
    select 1
      from public.discounts d
     where d.id = p_discount_id
       and d.school_id = public.get_user_school_id()
       and d.is_deleted is not true
       and (
            public.current_user_is_school_wide()
         or not exists (
              select 1 from public.branch_discount_links l
                join public.branches b on b.id = l.branch_id and b.is_deleted is not true
               where l.discount_id = d.id and l.is_deleted is not true)
         or exists (
              select 1 from public.branch_discount_links l
               where l.discount_id = d.id and l.is_deleted is not true
                 and public.has_branch_access(l.branch_id))
       )
  );
$$;


ALTER FUNCTION "public"."discount_visible"("p_discount_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."discount_writable"("p_discount_id" "uuid") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select public.current_user_is_school_wide()
      or (
           exists (
             select 1 from public.branch_discount_links l
               join public.branches b on b.id = l.branch_id and b.is_deleted is not true
              where l.discount_id = p_discount_id and l.is_deleted is not true)
       and not exists (
             select 1 from public.branch_discount_links l
               join public.branches b on b.id = l.branch_id and b.is_deleted is not true
              where l.discount_id = p_discount_id and l.is_deleted is not true
                and not public.has_branch_access(l.branch_id))
      );
$$;


ALTER FUNCTION "public"."discount_writable"("p_discount_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."enforce_athlete_health_consent"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$
begin
  if new.health_consent_at is not null then
    return new;
  end if;

  if tg_op = 'INSERT' then
    new.blood_type        := null;
    new.health_problems   := null;
    new.has_health_report := null;
    return new;
  end if;

  if new.blood_type is distinct from old.blood_type then
    new.blood_type := null;
  end if;
  if new.health_problems is distinct from old.health_problems then
    new.health_problems := null;
  end if;
  if new.has_health_report is distinct from old.has_health_report then
    new.has_health_report := null;
  end if;
  return new;
end;
$$;


ALTER FUNCTION "public"."enforce_athlete_health_consent"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."enforce_pre_registration_health_consent"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$
begin
  if new.health_consent_at is not null then
    return new;
  end if;

  if tg_op = 'INSERT' then
    new.health_problems   := null;
    new.has_health_report := null;
    return new;
  end if;

  if new.health_problems is distinct from old.health_problems then
    new.health_problems := null;
  end if;
  if new.has_health_report is distinct from old.has_health_report then
    new.has_health_report := null;
  end if;
  return new;
end;
$$;


ALTER FUNCTION "public"."enforce_pre_registration_health_consent"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."enqueue_attendance_reminders"() RETURNS integer
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_grace    constant interval := interval '30 minutes';
  v_last_run constant time     := time '23:45';
  v_now      timestamp := public.app_local_now();
  v_today    date      := v_now::date;
  v_count    integer;
begin
  insert into public.notifications (school_id, recipient_id, type, params, dedupe_key)
  select c.school_id, l.profile_id, 'attendance_reminder',
         jsonb_build_object('class_id', c.id, 'class_name', c.name,
                            'date', v_today),
         'attendance_reminder:' || c.id || ':' || v_today
    from public.classes c
    join public.class_schedule_slots slot
      on slot.class_id = c.id
     and slot.is_deleted is not true
     and slot.weekday = extract(isodow from v_today)
    join public.schools s
      on s.id = c.school_id and s.is_deleted is not true
    join public.coach_class_links l
      on l.class_id = c.id and l.is_deleted is not true
    join public.profiles p
      on p.id = l.profile_id and p.is_deleted is not true and p.status = 'active'
   where public.is_class_visible(c.id)
     and exists (select 1 from public.athletes a
                  where a.class_id = c.id
                    and a.is_deleted is not true
                    and a.approval_status = 'active')
     and least(v_today + slot.start_time + v_grace,
               v_today + v_last_run) <= v_now
     and not exists (select 1 from public.attendances x
                      where x.class_id = c.id
                        and x.attendance_date = v_today
                        and x.is_deleted is not true)
  on conflict (recipient_id, dedupe_key) where dedupe_key is not null do nothing;

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;


ALTER FUNCTION "public"."enqueue_attendance_reminders"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."enqueue_birthday_upcoming_notifications"() RETURNS integer
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  -- Kaç gün önceden haber verilir. İstemcide
  -- `ReminderWindow.birthdayNoticeDays`; test ikisinin eşitliğini denetler.
  v_days   constant integer := 7;
  v_target date := public.app_local_date() + 7;
  v_total  integer := 0;
  v_count  integer;
begin
  with upcoming as (
    select a.id, a.school_id, a.branch_id, a.class_id, a.full_name
      from public.athletes a
      join public.schools s on s.id = a.school_id and s.is_deleted is not true
     where a.is_deleted is not true
       and a.approval_status = 'active'
       and public.birthday_falls_on(a.date_of_birth, v_target)
  ), recipients as (
    select u.id as athlete_id, u.school_id, u.full_name, p.id as recipient_id
      from upcoming u
      join public.profiles p on p.school_id = u.school_id
     where p.is_deleted is not true and p.status = 'active'
       and p.role_id in (1, 2, 3, 9)
       and public.profile_has_branch_access(p.id, u.branch_id)
    union
    select u.id, u.school_id, u.full_name, l.profile_id
      from upcoming u
      join public.coach_class_links l
        on l.class_id = u.class_id and l.is_deleted is not true
      join public.profiles p
        on p.id = l.profile_id and p.is_deleted is not true and p.status = 'active'
  ), per_recipient as (
    select school_id, recipient_id,
           count(*) as cnt,
           (array_agg(full_name order by full_name))[1:5] as names
      from recipients
     group by school_id, recipient_id
  )
  insert into public.notifications (school_id, recipient_id, type, params, dedupe_key)
  select school_id, recipient_id, 'birthdays_upcoming',
         jsonb_build_object('count', cnt, 'names', to_jsonb(names),
                            'days', v_days, 'date', v_target),
         'birthdays_upcoming:' || v_target
    from per_recipient
  on conflict (recipient_id, dedupe_key) where dedupe_key is not null do nothing;
  get diagnostics v_count = row_count;
  v_total := v_total + v_count;

  insert into public.notifications (school_id, recipient_id, type, params, dedupe_key)
  select a.school_id, r.profile_id, 'child_birthday_upcoming',
         jsonb_build_object(
           'athlete_id',   a.id,
           'athlete_name', a.full_name,
           'date',         v_target,
           'days',         v_days,
           'age',          extract(year from v_target)::int
                             - extract(year from a.date_of_birth)::int,
           'sender_name',  s.name),
         'child_birthday_upcoming:' || a.id || ':' || v_target
    from public.athletes a
    join public.schools s on s.id = a.school_id and s.is_deleted is not true
    cross join lateral public.direct_message_recipients(a.id) r
   where a.is_deleted is not true
     and a.approval_status = 'active'
     and public.birthday_falls_on(a.date_of_birth, v_target)
  on conflict (recipient_id, dedupe_key) where dedupe_key is not null do nothing;
  get diagnostics v_count = row_count;
  v_total := v_total + v_count;

  return v_total;
end;
$$;


ALTER FUNCTION "public"."enqueue_birthday_upcoming_notifications"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."enqueue_morning_notifications"() RETURNS integer
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_today     date := public.app_local_date();
  v_yesterday date := public.app_local_date() - 1;
  v_total     integer := 0;
  v_count     integer;
begin
  with missing as (
    select c.id, c.school_id, c.branch_id
      from public.classes c
      join public.schools s on s.id = c.school_id and s.is_deleted is not true
     where public.is_class_visible(c.id)
       and exists (select 1 from public.athletes a
                    where a.class_id = c.id and a.is_deleted is not true
                      and a.approval_status = 'active')
       and public.class_meets_on(c.id, v_yesterday)
       and not exists (select 1 from public.attendances x
                        where x.class_id = c.id
                          and x.attendance_date = v_yesterday
                          and x.is_deleted is not true)
  ), per_recipient as (
    select p.school_id, p.id as recipient_id, count(*) as cnt
      from public.profiles p
      join missing m on m.school_id = p.school_id
     where p.is_deleted is not true and p.status = 'active'
       and p.role_id in (1, 2, 3, 9)
       and public.profile_has_branch_access(p.id, m.branch_id)
     group by p.school_id, p.id
  )
  insert into public.notifications (school_id, recipient_id, type, params, dedupe_key)
  select school_id, recipient_id, 'attendance_missing_summary',
         jsonb_build_object('count', cnt, 'date', v_yesterday),
         'attendance_missing_summary:' || v_yesterday
    from per_recipient
  on conflict (recipient_id, dedupe_key) where dedupe_key is not null do nothing;
  get diagnostics v_count = row_count;
  v_total := v_total + v_count;

  with expiring as (
    select a.school_id, a.branch_id
      from public.athletes a
      join public.schools s on s.id = a.school_id and s.is_deleted is not true
     where a.is_deleted is not true
       and a.approval_status = 'active'
       and a.contract_end_date = v_today + 7
  ), per_recipient as (
    select p.school_id, p.id as recipient_id, count(*) as cnt
      from public.profiles p
      join expiring e on e.school_id = p.school_id
     where p.is_deleted is not true and p.status = 'active'
       and p.role_id in (1, 2, 3, 9)
       and public.profile_has_branch_access(p.id, e.branch_id)
     group by p.school_id, p.id
  )
  insert into public.notifications (school_id, recipient_id, type, params, dedupe_key)
  select school_id, recipient_id, 'registrations_expiring',
         jsonb_build_object('count', cnt, 'days', 7, 'date', v_today),
         'registrations_expiring:' || v_today
    from per_recipient
  on conflict (recipient_id, dedupe_key) where dedupe_key is not null do nothing;
  get diagnostics v_count = row_count;
  v_total := v_total + v_count;

  with due as (
    select f.school_id, f.branch_id
      from public.financial_records f
      join public.schools s on s.id = f.school_id and s.is_deleted is not true
     where f.is_deleted is not true
       and f.status in ('unpaid', 'partial')
       and coalesce(f.reminder_date, f.expected_date) = v_today
  ), per_recipient as (
    select p.school_id, p.id as recipient_id, count(*) as cnt
      from public.profiles p
      join due d on d.school_id = p.school_id
     where p.is_deleted is not true and p.status = 'active'
       and public.profile_has_permission(p.id, 'finance.view')
       and (
            (d.branch_id is null and (public.is_school_wide_role(p.role_id) or p.role_id = 5))
         or (d.branch_id is not null and public.profile_has_branch_access(p.id, d.branch_id))
       )
     group by p.school_id, p.id
  )
  insert into public.notifications (school_id, recipient_id, type, params, dedupe_key)
  select school_id, recipient_id, 'payments_due',
         jsonb_build_object('count', cnt, 'date', v_today),
         'payments_due:' || v_today
    from per_recipient
  on conflict (recipient_id, dedupe_key) where dedupe_key is not null do nothing;
  get diagnostics v_count = row_count;
  v_total := v_total + v_count;

  with birthdays as (
    select a.school_id, a.class_id, a.full_name
      from public.athletes a
      join public.schools s on s.id = a.school_id and s.is_deleted is not true
     where a.is_deleted is not true
       and a.approval_status = 'active'
       and (
            to_char(a.date_of_birth, 'MM-DD') = to_char(v_today, 'MM-DD')
         or (to_char(a.date_of_birth, 'MM-DD') = '02-29'
             and to_char(v_today, 'MM-DD') = '02-28'
             and to_char(v_today + 1, 'MM-DD') = '03-01')
       )
  ), per_recipient as (
    select b.school_id, l.profile_id as recipient_id,
           count(*) as cnt,
           (array_agg(b.full_name order by b.full_name))[1:5] as names
      from birthdays b
      join public.coach_class_links l
        on l.class_id = b.class_id and l.is_deleted is not true
      join public.profiles p
        on p.id = l.profile_id and p.is_deleted is not true and p.status = 'active'
     group by b.school_id, l.profile_id
  )
  insert into public.notifications (school_id, recipient_id, type, params, dedupe_key)
  select school_id, recipient_id, 'birthdays_today',
         jsonb_build_object('count', cnt, 'names', to_jsonb(names), 'date', v_today),
         'birthdays_today:' || v_today
    from per_recipient
  on conflict (recipient_id, dedupe_key) where dedupe_key is not null do nothing;
  get diagnostics v_count = row_count;
  v_total := v_total + v_count;

  return v_total;
end;
$$;


ALTER FUNCTION "public"."enqueue_morning_notifications"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."enqueue_parent_payment_notifications"() RETURNS integer
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  -- Vadeden kaç gün önce haber verilir. Metinler bu sayıyı `params.days`'ten
  -- okur; istemcide ayrı bir kopyası yok.
  v_days  constant integer := 3;
  v_today date := public.app_local_date();
  v_count integer;
begin
  with open_records as (
    select fr.id, fr.school_id, fr.name, fr.expected_date, cu.athlete_id,
           s.name as school_name,
           fr.net_amount - coalesce((
             select sum(t.amount) from public.transactions t
              where t.record_id = fr.id and t.is_deleted is not true), 0)
             as remaining
      from public.financial_records fr
      join public.customers cu
        on cu.id = fr.customer_id and cu.is_deleted is not true
       and cu.athlete_id is not null
      join public.schools s on s.id = fr.school_id and s.is_deleted is not true
     where fr.is_deleted is not true
       and fr.type in ('due', 'income')
       and fr.status in ('unpaid', 'partial')
       and fr.expected_date in (v_today + v_days, v_today - 1)
  ), typed as (
    select o.*,
           case when o.expected_date > v_today
                then 'payment_upcoming' else 'payment_overdue' end as type
      from open_records o
     where o.remaining > 0
  )
  insert into public.notifications (school_id, recipient_id, type, params, dedupe_key)
  select t.school_id, r.profile_id, t.type,
         jsonb_build_object(
           'record_id',     t.id,
           'record_name',   t.name,
           'athlete_id',    a.id,
           'athlete_name',  a.full_name,
           'amount',        t.remaining,
           'expected_date', t.expected_date,
           'days',          v_days,
           'sender_name',   t.school_name),
         t.type || ':' || t.id || ':' || t.expected_date
    from typed t
    join public.athletes a
      on a.id = t.athlete_id and a.is_deleted is not true
     and a.approval_status = 'active'
    cross join lateral public.direct_message_recipients(a.id) r
  on conflict (recipient_id, dedupe_key) where dedupe_key is not null do nothing;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;


ALTER FUNCTION "public"."enqueue_parent_payment_notifications"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."finance_branch_ok"("p_branch_id" "uuid") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select p_branch_id is not null and public.has_branch_access(p_branch_id);
$$;


ALTER FUNCTION "public"."finance_branch_ok"("p_branch_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."generate_pre_registration_token"() RETURNS "text"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$
declare
  c_alphabet constant text := 'abcdefghjkmnpqrstuvwxyz23456789';
  c_length   constant integer := 10;
  v_token    text;
  v_attempt  integer := 0;
begin
  loop
    v_token := '';
    for i in 1..c_length loop
      v_token := v_token || substr(c_alphabet, 1 + floor(random() * length(c_alphabet))::integer, 1);
    end loop;
    exit when not exists (select 1 from public.pre_registration_links where token = v_token);
    v_attempt := v_attempt + 1;
    if v_attempt >= 10 then
      raise exception 'Benzersiz bağlantı kodu üretilemedi.';
    end if;
  end loop;
  return v_token;
end;
$$;


ALTER FUNCTION "public"."generate_pre_registration_token"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_athlete_profile_summary"("p_athlete_id" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_school_id uuid := public.get_user_school_id();
  v_attendance jsonb;
  v_balance    jsonb;
begin
  -- Profil kayıt ekranında açılır (`registration.view`); rol listesi
  -- muhasebeciyi de içeriyordu.
  if not public.has_permission('registration.view') then
    return public.app_err('Bu bilgilere erişim yetkiniz yok.', 'forbidden');
  end if;

  if v_school_id is null or not exists (
    select 1 from public.athletes a
     where a.id = p_athlete_id
       and a.school_id = v_school_id
       and a.is_deleted is not true
       and public.has_branch_access(a.branch_id)
  ) then
    -- Başka okulun ya da şubenin sporcusu da "bulunamadı" — kimliğin varlığı
    -- doğrulanmaz.
    return public.app_err('Sporcu bulunamadı.', 'not_found');
  end if;

  select jsonb_build_object(
           'present',   count(*) filter (where att.status = 'present'),
           'absent',    count(*) filter (where att.status = 'absent'),
           'excused',   count(*) filter (where att.status = 'excused'),
           'last_date', max(att.attendance_date))
    into v_attendance
    from public.attendances att
   where att.athlete_id = p_athlete_id
     and att.is_deleted is not true
     and att.attendance_date >= current_date - 30;

  if public.has_permission('finance.view') then
    select jsonb_build_object(
             'outstanding',   coalesce(sum(open.remaining), 0),
             'open_count',    count(*),
             'overdue_count', count(*) filter (where open.expected_date < current_date),
             'next_due_date', min(open.expected_date) filter (where open.expected_date >= current_date))
      into v_balance
      from (
        select fr.expected_date,
               fr.net_amount - coalesce((
                 select sum(t.amount) from public.transactions t
                  where t.record_id = fr.id and t.is_deleted is not true
               ), 0) as remaining
          from public.financial_records fr
          join public.customers cu on cu.id = fr.customer_id
         where cu.athlete_id = p_athlete_id
           and cu.is_deleted is not true
           and fr.is_deleted is not true
           and fr.type in ('due', 'income')
           and fr.status in ('unpaid', 'partial')
      ) open;
  end if;

  return public.app_ok(null, jsonb_build_object(
    'attendance', v_attendance,
    'balance',    v_balance
  ));
exception when others then
  return public.app_err(sqlerrm, public.app_sqlstate_code(sqlstate));
end;
$$;


ALTER FUNCTION "public"."get_athlete_profile_summary"("p_athlete_id" "uuid") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."get_athlete_profile_summary"("p_athlete_id" "uuid") IS 'Profil paneli: son 30 gün devam + açık bakiye. Hesap parent_get_athletes ile aynı; birlikte değiştirin.';


CREATE OR REPLACE FUNCTION "public"."get_attendance_analytics"("p_school_id" "uuid", "p_start_date" "date", "p_end_date" "date", "p_branch_id" "uuid" DEFAULT NULL::"uuid", "p_class_id" "uuid" DEFAULT NULL::"uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  -- null → okulun tamamı (okul geneli hesap, şube seçmedi)
  v_school_id uuid;
  v_branches  uuid[];
  v_result    jsonb;
begin
  v_school_id := public.get_user_school_id();

  if v_school_id is null then
    return public.app_err('Kullanıcının bağlı olduğu okul bulunamadı.', 'not_found');
  end if;

  if p_school_id is not null and p_school_id <> v_school_id then
    return public.app_err('Başka bir okulun yoklama analizi görüntülenemez.', 'forbidden');
  end if;

  if not public.has_permission('attendance.take') then
    return public.app_err('Yoklama analizini görüntüleme yetkiniz yok.', 'forbidden');
  end if;

  if p_start_date is null or p_end_date is null or p_end_date < p_start_date then
    return public.app_err('Geçerli bir tarih aralığı seçin.', 'validation');
  end if;

  if p_branch_id is not null then
    if not public.has_branch_access(p_branch_id) then
      return public.app_err('Geçersiz veya yetkiniz olmayan bir şube seçildi.', 'forbidden');
    end if;
    v_branches := array[p_branch_id];
  elsif not public.current_user_is_school_wide() then
    select coalesce(array_agg(b.id), '{}'::uuid[]) into v_branches
      from public.branches b
     where b.school_id = v_school_id
       and b.is_deleted is not true
       and public.has_branch_access(b.id);
  end if;

  if p_class_id is not null and not exists (
    select 1
      from public.classes c
     where c.id = p_class_id
       and c.school_id = v_school_id
       and public.is_class_visible(c.id)
       and (v_branches is null or c.branch_id = any (v_branches))
  ) then
    return public.app_err('Sınıf bulunamadı.', 'not_found');
  end if;

  with scoped as (
    select a.athlete_id,
           a.status,
           a.attendance_date
      from public.attendances a
     where a.school_id = v_school_id
       and a.attendance_date between p_start_date and p_end_date
       and a.is_deleted is not true
       and (v_branches is null or a.branch_id = any (v_branches))
       and (p_class_id is null or a.class_id = p_class_id)
  ),
  per_athlete as (
    select s.athlete_id,
           count(*)                                     as total_sessions,
           count(*) filter (where s.status = 'present') as present_count,
           count(*) filter (where s.status = 'absent')  as absent_count,
           count(*) filter (where s.status = 'excused') as excused_count
      from scoped s
     group by s.athlete_id
  ),
  per_day as (
    select s.attendance_date,
           count(*)                                     as total_count,
           count(*) filter (where s.status = 'present') as present_count
      from scoped s
     group by s.attendance_date
  )
  select jsonb_build_object(
    'athletes', coalesce((
      select jsonb_agg(
               jsonb_build_object(
                 'athlete_id',     pa.athlete_id,
                 'athlete_name',   ath.full_name,
                 'class_id',       ath.class_id,
                 'class_name',     t.name,
                 'branch_name',    b.name,
                 'total_sessions', pa.total_sessions,
                 'present_count',  pa.present_count,
                 'absent_count',   pa.absent_count,
                 'excused_count',  pa.excused_count
               )
               order by (pa.present_count::numeric / nullif(pa.total_sessions, 0)) asc
             )
        from per_athlete pa
        join public.athletes ath on ath.id = pa.athlete_id
                                and ath.school_id = v_school_id
        left join public.classes  t on t.id = ath.class_id
        left join public.branches b on b.id = ath.branch_id
       where ath.is_deleted is not true
    ), '[]'::jsonb),
    'trend', coalesce((
      select jsonb_agg(
               jsonb_build_object(
                 'date',          pd.attendance_date,
                 'total_count',   pd.total_count,
                 'present_count', pd.present_count
               )
               order by pd.attendance_date
             )
        from per_day pd
    ), '[]'::jsonb)
  ) into v_result;

  return public.app_ok(null, v_result);
exception
  when others then
    return public.app_err(sqlerrm, public.app_sqlstate_code(sqlstate));
end;
$$;


ALTER FUNCTION "public"."get_attendance_analytics"("p_school_id" "uuid", "p_start_date" "date", "p_end_date" "date", "p_branch_id" "uuid", "p_class_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_coach_sole_classes"("p_coach_id" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_school_id uuid;
  v_result    jsonb;
begin
  if not public.has_permission('users.manage') then
    return public.app_err('Bu işlemi gerçekleştirmek için yetkiniz yok.', 'forbidden');
  end if;

  v_school_id := public.get_user_school_id();

  if not exists (
    select 1 from public.profiles
     where id = p_coach_id and school_id = v_school_id and is_deleted is not true
  ) then
    return public.app_err('Eğitmen bulunamadı veya bu kayıt üzerinde işlem yetkiniz yok.', 'not_found');
  end if;

  select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name) order by c.name), '[]'::jsonb)
    into v_result
    from public.classes c
    join public.coach_class_links l
      on l.class_id = c.id and l.profile_id = p_coach_id and l.is_deleted is not true
   where c.school_id = v_school_id
     and public.is_class_visible(c.id)
     and not exists (
       select 1
         from public.coach_class_links o
         join public.profiles p on p.id = o.profile_id
        where o.class_id = c.id
          and o.profile_id <> p_coach_id
          and o.is_deleted is not true
          and p.is_deleted is not true
          and p.role_id = 4
          and p.status = 'active'
     );

  return public.app_ok(null, v_result);
exception when others then
  return public.app_err(sqlerrm, public.app_sqlstate_code(sqlstate));
end;
$$;


ALTER FUNCTION "public"."get_coach_sole_classes"("p_coach_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_daily_attendance"("p_school_id" "uuid", "p_attendance_date" "date", "p_branch_id" "uuid" DEFAULT NULL::"uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_result    jsonb;
  v_school_id uuid;
begin
  if not public.has_permission('attendance.take') then
    return public.app_err('Yoklama görüntülemek için yetkiniz yok.', 'forbidden');
  end if;

  v_school_id := public.get_user_school_id();

  if v_school_id is null then
    return public.app_err('Kullanıcının bağlı olduğu okul bulunamadı.', 'not_found');
  end if;

  if p_school_id is not null and p_school_id <> v_school_id then
    return public.app_err('Başka bir okulun ders programı görüntülenemez.', 'forbidden');
  end if;

  if p_branch_id is not null and not public.has_branch_access(p_branch_id) then
    return public.app_err('Bu şubeye erişiminiz yok.', 'forbidden');
  end if;

  with day_rows as (
    -- Sınıf başına tek satır. Yoklamayı alan, en son yazan kişidir: kısmi
    -- (çakışmalı) bir kayıtta satırlar iki kişiye ait olabilir.
    select a.class_id,
           (array_agg(a.coach_id order by a.updated_at desc))[1] as coach_id,
           count(*)                                      as total_count,
           count(*) filter (where a.status = 'present')  as present_count,
           count(*) filter (where a.status = 'absent')   as absent_count,
           count(*) filter (where a.status = 'excused')  as excused_count
      from public.attendances a
     where a.school_id = v_school_id
       and a.attendance_date = p_attendance_date
       and (a.is_deleted is false or a.is_deleted is null)
     group by a.class_id
  ), day_classes as (
    select t.*,
           public.class_start_time_on(t.id, p_attendance_date) as start_time,
           public.class_meets_on(t.id, p_attendance_date)      as is_scheduled
      from public.classes t
     where t.school_id = v_school_id
       and public.is_class_visible(t.id)
       and t.branch_id in (select public.current_user_branch_ids())
       and (p_branch_id is null or t.branch_id = p_branch_id)
  )
  select coalesce(jsonb_agg(
           jsonb_build_object(
             'class_id',      t.id,
             'class_name',    t.name,
             'branch_id',     t.branch_id,
             'branch_name',   b.name,
             'sport_name',    sp.name,
             'quota',         t.quota,
             'athlete_count', (
               select count(*) from public.athletes ath
                where ath.class_id = t.id
                  and coalesce(ath.approval_status, 'active') <> 'passive'
                  and (ath.is_deleted is false or ath.is_deleted is null)
             ),
             'start_time',    to_char(t.start_time, 'HH24:MI'),
             'is_scheduled',  t.is_scheduled,
             'coach_id',      d.coach_id,
             'coach_name',    p.full_name,
             'is_taken',      d.class_id is not null,
             'total_count',   coalesce(d.total_count, 0),
             'present_count', coalesce(d.present_count, 0),
             'absent_count',  coalesce(d.absent_count, 0),
             'excused_count', coalesce(d.excused_count, 0)
           )
           order by t.start_time nulls last, t.name, b.name, sp.name
         ), '[]'::jsonb)
    into v_result
    from day_classes t
    left join public.branches b  on b.id  = t.branch_id
    left join public.sports   sp on sp.id = t.sport_id
    left join day_rows        d  on d.class_id = t.id
    left join public.profiles p  on p.id = d.coach_id;

  return public.app_ok(null, v_result);
exception
  when others then
    return public.app_err(sqlerrm, public.app_sqlstate_code(sqlstate));
end;
$$;


ALTER FUNCTION "public"."get_daily_attendance"("p_school_id" "uuid", "p_attendance_date" "date", "p_branch_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_dashboard_overview"("p_branch_id" "uuid" DEFAULT NULL::"uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_school_id  uuid;
  v_today      date := current_date;
  v_month_start date;
  v_month_end   date;

  v_can_registration boolean := public.has_permission('registration.view');
  v_can_attendance   boolean := public.has_permission('attendance.take');
  v_can_finance      boolean := public.has_permission('finance.view');

  -- null → okulun tamamı (okul geneli kullanıcı, şube seçmedi)
  v_branches         uuid[];

  v_active_athletes  int  := 0;
  v_collected        numeric := 0;
  v_target           numeric := 0;
  v_present_today    int  := 0;
  v_expected_today   int  := 0;
  v_pending_prereg   int  := 0;
  v_overdue_dues     int  := 0;
  v_without_coach    int  := 0;
  v_distribution     jsonb := '[]'::jsonb;
begin
  v_school_id := public.get_user_school_id();

  if v_school_id is null then
    return public.app_err('Kullanıcının bağlı olduğu okul bulunamadı.', 'not_found');
  end if;

  if p_branch_id is not null then
    if not public.has_branch_access(p_branch_id) then
      return public.app_err('Geçersiz veya yetkiniz olmayan bir şube seçildi.', 'forbidden');
    end if;
    v_branches := array[p_branch_id];
  elsif not public.current_user_is_school_wide() then
    select coalesce(array_agg(b.id), '{}'::uuid[]) into v_branches
      from public.branches b
     where b.school_id = v_school_id
       and b.is_deleted is not true
       and public.has_branch_access(b.id);
  end if;

  v_month_start := date_trunc('month', v_today)::date;
  v_month_end   := (date_trunc('month', v_today) + interval '1 month - 1 day')::date;

  if v_can_registration then
    select count(*)
      into v_active_athletes
      from public.athletes a
      join public.branches br on br.id = a.branch_id
     where a.school_id = v_school_id
       and a.approval_status = 'active'
       and (a.is_deleted is false or a.is_deleted is null)
       and (br.is_deleted is false or br.is_deleted is null)
       and (v_branches is null or a.branch_id = any (v_branches));

    select count(*)
      into v_pending_prereg
      from public.pre_registrations pr
     where pr.school_id = v_school_id
       and pr.status = 'not_converted'
       and (pr.is_deleted is false or pr.is_deleted is null)
       and (v_branches is null or pr.branch_id = any (v_branches));

    select count(*)
      into v_without_coach
      from public.classes c
     where c.school_id = v_school_id
       and public.is_class_visible(c.id)
       and (v_branches is null or c.branch_id = any (v_branches))
       and not public.class_has_active_coach(c.id);

    select coalesce(
             jsonb_agg(
               jsonb_build_object(
                 'branch_id',     b.id,
                 'branch_name',   b.name,
                 'athlete_count', b.athlete_count
               )
               order by b.athlete_count desc, b.name
             ),
             '[]'::jsonb
           )
      into v_distribution
      from (
        select br.id,
               br.name,
               count(a.id) as athlete_count
          from public.branches br
          left join public.athletes a
                 on a.branch_id = br.id
                and a.approval_status = 'active'
                and (a.is_deleted is false or a.is_deleted is null)
         where br.school_id = v_school_id
           and (br.is_deleted is false or br.is_deleted is null)
           and (v_branches is null or br.id = any (v_branches))
         group by br.id, br.name
      ) b;
  end if;

  if v_can_finance then
    with target_records as (
      select fr.id, fr.net_amount
        from public.financial_records fr
       where fr.school_id = v_school_id
         and (fr.is_deleted is false or fr.is_deleted is null)
         and fr.type = 'due'
         and fr.status <> 'cancelled'
         and fr.expected_date between v_month_start and v_month_end
         and (v_branches is null or fr.branch_id = any (v_branches))
    )
    select
      coalesce((select sum(tr.net_amount) from target_records tr), 0),
      coalesce((
        select sum(t.amount)
          from public.transactions t
          join target_records tr on tr.id = t.record_id
         where (t.is_deleted is false or t.is_deleted is null)
      ), 0)
      into v_target, v_collected;

    select count(*)
      into v_overdue_dues
      from public.financial_records fr
     where fr.school_id = v_school_id
       and (fr.is_deleted is false or fr.is_deleted is null)
       and fr.type = 'due'
       and fr.status in ('unpaid', 'partial')
       and fr.expected_date < v_today
       and (v_branches is null or fr.branch_id = any (v_branches));
  end if;

  if v_can_attendance then
    select count(*),
           count(*) filter (where at.status = 'present')
      into v_expected_today, v_present_today
      from public.attendances at
     where at.school_id = v_school_id
       and at.attendance_date = v_today
       and (at.is_deleted is false or at.is_deleted is null)
       and (v_branches is null or at.branch_id = any (v_branches));
  end if;

  return public.app_ok(null, jsonb_build_object(
      'metrics', jsonb_build_object(
        'active_athletes',           v_active_athletes,
        'collected_amount',          v_collected,
        'target_amount',             v_target,
        'present_today',             v_present_today,
        'expected_today',            v_expected_today,
        'pending_pre_registrations', v_pending_prereg
      ),
      'alerts', jsonb_build_array(
        jsonb_build_object('type', 'pending_pre_registration', 'count', v_pending_prereg),
        jsonb_build_object('type', 'overdue_dues',             'count', v_overdue_dues),
        jsonb_build_object('type', 'classes_without_coach',    'count', v_without_coach)
      ),
      'branch_distribution', v_distribution
    )
  );
exception
  when others then
    return public.app_err(sqlerrm, public.app_sqlstate_code(sqlstate));
end;
$$;


ALTER FUNCTION "public"."get_dashboard_overview"("p_branch_id" "uuid") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."get_dashboard_overview"("p_branch_id" "uuid") IS 'Dashboard KPI''ları. collected_amount ve target_amount aynı kayıt kümesinden (expected_date bu ay olan, iptal edilmemiş aidatlar) beslenir; böylece tahsilat oranı %100''ü aşamaz. Peşin ödenen bir aidat, vadesinin ait olduğu ayın tahsilatında sayılır (bkz. 20260916_dashboard_collection_rate.sql).';


CREATE OR REPLACE FUNCTION "public"."get_direct_message_targets"() RETURNS "jsonb"
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_role      bigint := public.get_user_role();
  v_school_id uuid   := public.get_user_school_id();
  v_payload   jsonb;
begin
  if not public.has_permission('communication.message') then
    return public.app_err('Veliye mesaj göndermek için yetkiniz yok.', 'forbidden');
  end if;
  if v_school_id is null then
    return public.app_err('Kullanıcının bağlı olduğu okul bulunamadı.', 'forbidden');
  end if;
  select coalesce(jsonb_agg(row_data order by row_data->>'full_name'), '[]'::jsonb)
    into v_payload
    from (
      select jsonb_build_object(
               'id',          a.id,
               'full_name',   a.full_name,
               'class_name',  c.name,
               'branch_name', b.name,
               'parent_count',
                 (select count(*) from public.direct_message_recipients(a.id))
             ) as row_data
        from public.athletes a
        left join public.classes  c on c.id = a.class_id  and c.is_deleted is not true
        left join public.branches b on b.id = a.branch_id and b.is_deleted is not true
       where a.school_id = v_school_id
         and a.is_deleted is not true
         and public.can_message_athlete(a.id)
    ) target_rows;
  return public.app_ok(null, v_payload);
exception when others then
  return public.app_err(sqlerrm, public.app_sqlstate_code(sqlstate));
end;
$$;


ALTER FUNCTION "public"."get_direct_message_targets"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_min_app_version"("p_app" "text", "p_platform" "text", "p_brand" "text") RETURNS "jsonb"
    LANGUAGE "plpgsql" STABLE
    SET "search_path" TO 'public'
    AS $$
declare
  v_row public.app_min_versions%rowtype;
begin
  select * into v_row
    from public.app_min_versions
   where app = p_app
     and brand = p_brand
     and platform = p_platform;

  if not found then
    return public.app_ok(null, null);
  end if;

  return public.app_ok(
    null,
    jsonb_build_object(
      'min_build', v_row.min_build,
      'store_url', v_row.store_url
    )
  );
end;
$$;


ALTER FUNCTION "public"."get_min_app_version"("p_app" "text", "p_platform" "text", "p_brand" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_pre_registration_link"() RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_school_id uuid;
  v_row       jsonb;
  v_token     text;
begin
  if not public.has_permission('registration.manage') then
    return public.app_err('Bu işlemi gerçekleştirmek için yetkiniz yok.', 'forbidden');
  end if;

  v_school_id := public.get_user_school_id();
  if v_school_id is null then
    return public.app_err('Okul bilgisi çözülemedi.', 'forbidden');
  end if;

  select jsonb_build_object(
           'id', l.id, 'token', l.token,
           'is_active', l.is_active, 'created_at', l.created_at)
    into v_row
    from public.pre_registration_links l
   where l.school_id = v_school_id and l.is_deleted is not true;

  if v_row is not null then
    return public.app_ok(null, v_row);
  end if;

  v_token := public.generate_pre_registration_token();

  insert into public.pre_registration_links (token, school_id, created_by)
  values (v_token, v_school_id, auth.uid())
  returning jsonb_build_object(
    'id', id, 'token', token, 'is_active', is_active, 'created_at', created_at)
  into v_row;

  return public.app_ok(null, v_row);
exception when others then
  return public.app_err(sqlerrm, public.app_sqlstate_code(sqlstate));
end;
$$;


ALTER FUNCTION "public"."get_pre_registration_link"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_sent_direct_messages"("p_limit" integer DEFAULT 50, "p_before" timestamp with time zone DEFAULT NULL::timestamp with time zone) RETURNS "jsonb"
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_uid       uuid   := auth.uid();
  v_role      bigint := public.get_user_role();
  v_school_id uuid   := public.get_user_school_id();
  v_payload   jsonb;
begin
  if not public.has_permission('communication.view') then
    return public.app_err('Mesaj geçmişini görmek için yetkiniz yok.', 'forbidden');
  end if;
  if v_school_id is null then
    return public.app_err('Kullanıcının bağlı olduğu okul bulunamadı.', 'forbidden');
  end if;
  select coalesce(jsonb_agg(row_data order by (row_data->>'created_at')::timestamptz desc),
                  '[]'::jsonb)
    into v_payload
    from (
      select jsonb_build_object(
               'id',              m.id,
               'athlete_id',      m.athlete_id,
               'athlete_name',    a.full_name,
               'sender_name',     s.full_name,
               'body',            m.body,
               'recipient_count', m.recipient_count,
               'read_count',
                 (select count(*) from public.notifications n
                   where n.direct_message_id = m.id
                     and n.read_at is not null),
               'created_at',      m.created_at
             ) as row_data
        from public.direct_messages m
        join public.athletes a on a.id = m.athlete_id
        left join public.profiles s on s.id = m.sender_id
       where m.school_id = v_school_id
         and m.is_deleted is not true
         and (p_before is null or m.created_at < p_before)
         and (
              public.is_school_wide_role(v_role)
           or (v_role in (2, 3) and public.has_branch_access(m.branch_id))
           or (v_role = 4 and m.sender_id = v_uid)
         )
       order by m.created_at desc
       limit greatest(1, least(coalesce(p_limit, 50), 200))
    ) message_rows;
  return public.app_ok(null, v_payload);
exception when others then
  return public.app_err(sqlerrm, public.app_sqlstate_code(sqlstate));
end;
$$;


ALTER FUNCTION "public"."get_sent_direct_messages"("p_limit" integer, "p_before" timestamp with time zone) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_session_data"() RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_user_id uuid;
  v_payload json;
begin
  v_user_id := auth.uid();

  if v_user_id is null then
    return public.app_err('Kullanıcı girişi yapılmamış.', 'forbidden');
  end if;

  select json_build_object(
    'full_name', p.full_name,
    'role', r.name,
    'status', p.status,
    'privacy_notice_version', coalesce(p.privacy_notice_version, ''),
    'permissions', case when p.status = 'active'
                        then public.profile_permission_list(p.id)
                        else '{}'::text[] end,
    'school',
    case
      when s.id is null then null
      else json_build_object(
        'id', s.id,
        'name', s.name,
        'subscription_status', s.subscription_status,
        'is_self_service', s.is_self_service,
        'brand', s.brand,
        'branches',
        coalesce(
          (
            -- Okul geneli rol (genel müdür): okulun tüm şubeleri, link
            -- aranmaz. Diğer roller: yalnızca bağlı oldukları şubeler.
            select json_agg(json_build_object('id', b.id, 'name', b.name)
                            order by b.name)
              from public.branches b
             where b.school_id = s.id
               and b.is_deleted is not true
               and (
                    public.is_school_wide_role(p.role_id)
                 or exists (
                      select 1
                        from public.profile_branch_links pbl
                       where pbl.branch_id  = b.id
                         and pbl.profile_id = p.id
                         and pbl.is_deleted is not true
                    )
               )
          ),
          '[]'::json
        )
      )
    end
  )
  into v_payload
  from public.profiles p
  left join public.roles   r on p.role_id   = r.id
  left join public.schools s on p.school_id = s.id
  where p.id = v_user_id
    and p.is_deleted is not true;

  if v_payload is null then
    return public.app_err('Kullanıcı profili bulunamadı.', 'not_found');
  end if;

  return public.app_ok(null, v_payload::jsonb);
exception when others then
  return public.app_err(sqlerrm, public.app_sqlstate_code(sqlstate));
end;
$$;


ALTER FUNCTION "public"."get_session_data"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_setup_progress"() RETURNS "jsonb"
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_school_id uuid;
begin
  -- Rehberi yalnızca okulu kuran yönetici görür (SetupGuideCard).
  if not public.has_permission('school.manage') then
    return public.app_err('Bu bilgiye erişim yetkiniz yok.', 'forbidden');
  end if;

  v_school_id := public.get_user_school_id();

  if v_school_id is null then
    return public.app_err('Kullanıcının bağlı olduğu okul bulunamadı.', 'not_found');
  end if;

  return public.app_ok(null, jsonb_build_object(
    'branches', (
      select count(*) from public.branches
       where school_id = v_school_id and is_deleted is not true),
    'sports', (
      select count(*) from public.sports
       where school_id = v_school_id and is_deleted is not true),
    'coaches', (
      select count(*) from public.profiles
       where school_id = v_school_id and role_id = 4 and is_deleted is not true),
    'classes', (
      select count(*) from public.classes
       where school_id = v_school_id and is_deleted is not true),
    'athletes', (
      select count(*) from public.athletes
       where school_id = v_school_id and is_deleted is not true)
  ));
exception when others then
  return public.app_err(sqlerrm, public.app_sqlstate_code(sqlstate));
end;
$$;


ALTER FUNCTION "public"."get_setup_progress"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_user_role"() RETURNS bigint
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select role_id
    from public.profiles
   where id = auth.uid()
     and is_deleted is not true
     and status = 'active';
$$;


ALTER FUNCTION "public"."get_user_role"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_user_school_id"() RETURNS "uuid"
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  -- Silinmiş ya da pasif profilin okulu yoktur: hesap auth tarafında yaşasa da
  -- hiçbir okul satırına politikadan erişemez.
  select school_id
    from public.profiles
   where id = auth.uid()
     and is_deleted is not true
     and status = 'active'
   limit 1;
$$;


ALTER FUNCTION "public"."get_user_school_id"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."grant_founder_permissions"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
  if new.owner_id is null then
    return new;
  end if;

  insert into public.profile_permissions (profile_id, school_id, permission, granted_by)
  select new.owner_id, new.id, rp.permission, new.owner_id
    from public.role_permissions rp
   where rp.role_id = 9
     and rp.is_optional
  on conflict (profile_id, permission) do update
    set is_deleted = false,
        school_id  = excluded.school_id;

  return new;
end;
$$;


ALTER FUNCTION "public"."grant_founder_permissions"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."guard_general_manager_profile"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$
begin
  if current_user not in ('authenticated', 'anon') then
    return new;
  end if;

  if (new.role_id = 9 or (tg_op = 'UPDATE' and old.role_id = 9))
     and public.get_user_role() is distinct from 9 then
    raise exception using
      errcode = '42501',
      message = 'Genel müdür hesabını yalnızca genel müdür atayabilir veya düzenleyebilir.';
  end if;

  return new;
end;
$$;


ALTER FUNCTION "public"."guard_general_manager_profile"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."guard_privacy_notice_columns"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$
begin
  if coalesce(auth.role(), '') in ('authenticated', 'anon')
     and coalesce(current_setting('app.privacy_notice_ack', true), '') <> 'on'
     and (
          (tg_op = 'INSERT'
             and (new.privacy_notice_version is not null
                  or new.privacy_notice_ack_at is not null))
       or (tg_op = 'UPDATE'
             and (new.privacy_notice_version is distinct from old.privacy_notice_version
                  or new.privacy_notice_ack_at is distinct from old.privacy_notice_ack_at))
     ) then
    raise exception 'Bu alan uygulamadan değiştirilemez.'
      using errcode = '42501';
  end if;
  return new;
end;
$$;


ALTER FUNCTION "public"."guard_privacy_notice_columns"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."guard_school_contract_columns"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$
begin
  if coalesce(auth.role(), '') in ('authenticated', 'anon')
     and (new.brand is distinct from old.brand
          or new.is_self_service is distinct from old.is_self_service) then
    raise exception 'Bu alan uygulamadan değiştirilemez.'
      using errcode = '42501';
  end if;
  return new;
end;
$$;


ALTER FUNCTION "public"."guard_school_contract_columns"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."handle_new_user"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_privacy_version text :=
    nullif(left(btrim(new.raw_user_meta_data->>'privacy_notice_version'), 32), '');
begin
  -- Yalnızca kendi kaydını açan kurucu hesap; yönetimin açtığı kullanıcılar
  -- ve veliler profillerini Edge Function'dan alır.
  if coalesce(new.raw_user_meta_data->>'is_creator', 'false') != 'true' then
    return new;
  end if;

  insert into public.profiles (
    id,
    email,
    full_name,
    phone_number,
    status,
    role_id,
    privacy_notice_version,
    privacy_notice_ack_at
  )
  values (
    new.id,
    new.email,
    new.raw_user_meta_data->>'full_name',
    new.raw_user_meta_data->>'phone_number',
    'active'::public.approval_status,
    9, -- genel müdür
    v_privacy_version,
    case when v_privacy_version is not null then now() end
  );

  return new;
end;
$$;


ALTER FUNCTION "public"."handle_new_user"() OWNER TO "postgres";


COMMENT ON FUNCTION "public"."handle_new_user"() IS 'on_auth_user_created trigger fonksiyonu. İstemciye kapalı: trigger''lar tablo sahibinin yetkisiyle çalışır, EXECUTE grant''ına ihtiyaç duymaz.';


CREATE OR REPLACE FUNCTION "public"."has_branch_access"("p_branch_id" "uuid") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select exists (
    select 1
      from public.branches b
     where b.id        = p_branch_id
       and b.is_deleted is not true
       and b.school_id  = public.get_user_school_id()
       and (
            public.current_user_is_school_wide()
         or exists (
              select 1
                from public.profile_branch_links pbl
               where pbl.profile_id = auth.uid()
                 and pbl.branch_id  = b.id
                 and pbl.is_deleted is not true
            )
       )
  );
$$;


ALTER FUNCTION "public"."has_branch_access"("p_branch_id" "uuid") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."has_branch_access"("p_branch_id" "uuid") IS 'Çağıran kullanıcının verilen şubeye bağlı olup olmadığı. SECURITY DEFINER RPC''lerde RLS devre dışı kaldığı için şube kapsamı bu yardımcıyla açıkça uygulanır.';


CREATE OR REPLACE FUNCTION "public"."has_permission"("p_permission" "text") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select public.profile_has_permission(auth.uid(), p_permission);
$$;


ALTER FUNCTION "public"."has_permission"("p_permission" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."income_expense_item_visible"("p_item_id" "uuid") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select exists (
    select 1
      from public.income_expense_items i
     where i.id = p_item_id
       and i.school_id = public.get_user_school_id()
       and i.is_deleted is not true
       and (
            public.current_user_is_school_wide()
         or not exists (
              select 1 from public.branch_income_expense_item_links l
                join public.branches b on b.id = l.branch_id and b.is_deleted is not true
               where l.income_expense_item_id = i.id and l.is_deleted is not true)
         or exists (
              select 1 from public.branch_income_expense_item_links l
               where l.income_expense_item_id = i.id and l.is_deleted is not true
                 and public.has_branch_access(l.branch_id))
       )
  );
$$;


ALTER FUNCTION "public"."income_expense_item_visible"("p_item_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."income_expense_item_writable"("p_item_id" "uuid") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select public.current_user_is_school_wide()
      or (
           exists (
             select 1 from public.branch_income_expense_item_links l
               join public.branches b on b.id = l.branch_id and b.is_deleted is not true
              where l.income_expense_item_id = p_item_id and l.is_deleted is not true)
       and not exists (
             select 1 from public.branch_income_expense_item_links l
               join public.branches b on b.id = l.branch_id and b.is_deleted is not true
              where l.income_expense_item_id = p_item_id and l.is_deleted is not true
                and not public.has_branch_access(l.branch_id))
      );
$$;


ALTER FUNCTION "public"."income_expense_item_writable"("p_item_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."is_class_visible"("p_class_id" "uuid") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select exists (
    select 1
      from public.classes t
      join public.branches b on b.id = t.branch_id
      join public.sports   s on s.id = t.sport_id
     where t.id = p_class_id
       and (t.is_deleted is false or t.is_deleted is null)
       and (b.is_deleted is false or b.is_deleted is null)
       and (s.is_deleted is false or s.is_deleted is null)
  );
$$;


ALTER FUNCTION "public"."is_class_visible"("p_class_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."is_school_manager"("_school_id" "uuid") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select exists (
    select 1
      from public.profiles p
     where p.id        = auth.uid()
       and p.school_id = _school_id
       and p.role_id   = 9
       and p.is_deleted is not true
  );
$$;


ALTER FUNCTION "public"."is_school_manager"("_school_id" "uuid") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."is_school_manager"("_school_id" "uuid") IS 'Çağıran, verilen okulun yöneticisi (role_id = 1) mi? schools tablosunun UPDATE/DELETE politikaları bunu kullanır. Önceki sürümü profiles.user_id ve profiles.role kolonlarına bakıyordu; ikisi de yok, dolayısıyla her çağrıda 42703 veriyordu.';


CREATE OR REPLACE FUNCTION "public"."is_school_wide_role"("p_role_id" bigint) RETURNS boolean
    LANGUAGE "sql" IMMUTABLE
    SET "search_path" TO 'public'
    AS $$
  select p_role_id = 9;
$$;


ALTER FUNCTION "public"."is_school_wide_role"("p_role_id" bigint) OWNER TO "postgres";


COMMENT ON FUNCTION "public"."is_school_wide_role"("p_role_id" bigint) IS 'Rolün okul genelinde yetkili olup olmadığı. Okul geneli roller şube bağıyla sınırlanmaz; şubeleri profile_branch_links''ten değil, okulun şube listesinden gelir. Dart tarafındaki UserRole.isSchoolWide ile eşleşir.';


CREATE OR REPLACE FUNCTION "public"."log_athlete_consents"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_actor   uuid := auth.uid();
  v_role    bigint;
  v_channel text := nullif(current_setting('app.consent_channel', true), '');
  v_source  text;
begin
  if v_actor is not null then
    select role_id into v_role from public.profiles where id = v_actor;
  end if;

  v_source := coalesce(
    v_channel,
    case when v_actor is null then 'system'
         when v_role = 8      then 'parent'
         else 'staff' end
  );

  insert into public.athlete_consent_events (
    school_id, athlete_id, kind, granted, consent_at,
    actor_id, actor_role, source
  )
  select new.school_id, new.id, c.kind, c.new_at is not null, c.new_at,
         v_actor, v_role, v_source
    from (values
      ('health',
       case when tg_op = 'UPDATE' then old.health_consent_at end,
       new.health_consent_at),
      ('photo',
       case when tg_op = 'UPDATE' then old.photo_consent_at end,
       new.photo_consent_at),
      ('promo_photo',
       case when tg_op = 'UPDATE' then old.promo_photo_consent_at end,
       new.promo_photo_consent_at)
    ) as c(kind, old_at, new_at)
   where (c.old_at is not null) <> (c.new_at is not null);

  return null;
end;
$$;


ALTER FUNCTION "public"."log_athlete_consents"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."mark_notifications_read"("p_ids" "uuid"[] DEFAULT NULL::"uuid"[]) RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_count integer;
begin
  if auth.uid() is null then
    return public.app_err('Oturum bulunamadı.', 'forbidden');
  end if;

  update public.notifications
     set read_at = now()
   where recipient_id = auth.uid()
     and read_at is null
     and is_deleted is not true
     and (p_ids is null or id = any (p_ids));

  get diagnostics v_count = row_count;
  return public.app_ok(null, jsonb_build_object('updated_count', v_count));
exception
  when others then
    return public.app_err(sqlerrm, public.app_sqlstate_code(sqlstate));
end;
$$;


ALTER FUNCTION "public"."mark_notifications_read"("p_ids" "uuid"[]) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."normalize_national_id"("p_value" "text") RETURNS "text"
    LANGUAGE "sql" IMMUTABLE
    SET "search_path" TO 'public'
    AS $_$
  select case
    when nullif(btrim(p_value), '') is null then null
    when btrim(p_value) ~ '^[1-9][0-9]{10}$' then btrim(p_value)
    else 'invalid'
  end;
$_$;


ALTER FUNCTION "public"."normalize_national_id"("p_value" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."notifications_after_insert"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
  if exists (select 1 from inserted_rows) then
    perform public.request_push_dispatch();
  end if;
  return null;
end;
$$;


ALTER FUNCTION "public"."notifications_after_insert"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."notify_pre_registration_received"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
  if auth.uid() is not null then
    return new;
  end if;

  begin
    insert into public.notifications (school_id, recipient_id, type, params, dedupe_key)
    select new.school_id, p.id, 'pre_registration_received',
           jsonb_build_object(
             'pre_registration_id', new.id,
             'athlete_name',        new.full_name,
             'branch_id',           new.branch_id,
             'branch_name',         b.name),
           'pre_registration_received:' || new.id
      from public.profiles p
      left join public.branches b on b.id = new.branch_id
     where p.school_id = new.school_id
       and p.is_deleted is not true
       and p.status = 'active'
       and p.role_id in (1, 2, 3, 9)
       and public.profile_has_branch_access(p.id, new.branch_id)
    on conflict (recipient_id, dedupe_key) where dedupe_key is not null do nothing;
  exception
    when others then
      raise warning 'Ön kayıt bildirimi yazılamadı (%): %', sqlstate, sqlerrm;
  end;

  return new;
end;
$$;


ALTER FUNCTION "public"."notify_pre_registration_received"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."parent_get_athletes"() RETURNS "jsonb"
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_uid       uuid := auth.uid();
  v_school_id uuid := public.get_user_school_id();
  v_payload   jsonb;
begin
  if v_uid is null or public.get_user_role() is distinct from 8 then
    return public.app_err('Bu bilgilere yalnızca veli hesabıyla erişilebilir.', 'forbidden');
  end if;
  select coalesce(jsonb_agg(row_data order by row_data->>'full_name'), '[]'::jsonb)
    into v_payload
    from (
      select jsonb_build_object(
        'id', a.id, 'full_name', a.full_name, 'photo_path', a.photo_path,
        'date_of_birth', a.date_of_birth, 'gender', a.gender, 'blood_type', a.blood_type,
        'health_problems', a.health_problems, 'has_health_report', a.has_health_report,
        'health_consent_at', a.health_consent_at,
        'photo_consent_at', a.photo_consent_at,
        'promo_photo_consent_at', a.promo_photo_consent_at,
        'license_number', a.license_number, 'height', a.height, 'weight', a.weight,
        'registration_date', a.registration_date, 'contract_end_date', a.contract_end_date,
        'approval_status', a.approval_status, 'branch_name', b.name, 'branch_phone', b.phone_number,
        'branch_address', b.address, 'class_name', c.name, 'sport_name', s.name,
        'coach_names',
          coalesce((
            select jsonb_agg(cp.full_name order by cp.full_name)
              from public.coach_class_links ccl
              join public.profiles cp on cp.id = ccl.profile_id
             where ccl.class_id = c.id and ccl.is_deleted is not true and cp.is_deleted is not true
          ), '[]'::jsonb),
        'attendance',
          (select jsonb_build_object(
                    'present', count(*) filter (where att.status = 'present'),
                    'absent',  count(*) filter (where att.status = 'absent'),
                    'excused', count(*) filter (where att.status = 'excused'),
                    'last_date', max(att.attendance_date))
             from public.attendances att
            where att.athlete_id = a.id and att.is_deleted is not true
              and att.attendance_date >= current_date - 30),
        'balance',
          (select jsonb_build_object(
                    'outstanding', coalesce(sum(open.remaining), 0),
                    'open_count',  count(*),
                    'overdue_count', count(*) filter (where open.expected_date < current_date),
                    'next_due_date', min(open.expected_date) filter (where open.expected_date >= current_date))
             from (
               select fr.expected_date,
                      fr.net_amount - coalesce((
                        select sum(t.amount) from public.transactions t
                         where t.record_id = fr.id and t.is_deleted is not true
                      ), 0) as remaining
                 from public.financial_records fr
                 join public.customers cu on cu.id = fr.customer_id
                where cu.athlete_id = a.id and cu.is_deleted is not true
                  and fr.is_deleted is not true and fr.type in ('due', 'income')
                  and fr.status in ('unpaid', 'partial')
             ) open)
      ) as row_data
        from public.parent_athlete_links pal
        join public.athletes a on a.id = pal.athlete_id
        left join public.branches b on b.id = a.branch_id and b.is_deleted is not true
        left join public.classes  c on c.id = a.class_id  and c.is_deleted is not true
        left join public.sports   s on s.id = c.sport_id  and s.is_deleted is not true
       where pal.profile_id = v_uid and pal.is_deleted is not true
         and a.is_deleted is not true and a.school_id = v_school_id
    ) athlete_rows;
  return public.app_ok(null, v_payload);
exception when others then
  return public.app_err(sqlerrm, public.app_sqlstate_code(sqlstate));
end;
$$;


ALTER FUNCTION "public"."parent_get_athletes"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."parent_get_attendance"("p_athlete_id" "uuid", "p_from" "date", "p_to" "date") RETURNS "jsonb"
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare v_payload jsonb;
begin
  if auth.uid() is null or public.get_user_role() is distinct from 8 then
    return public.app_err('Bu bilgilere yalnızca veli hesabıyla erişilebilir.', 'forbidden');
  end if;
  if not public.parent_owns_athlete(p_athlete_id) then
    return public.app_err('Sporcu bulunamadı.', 'not_found');
  end if;
  if p_from is null or p_to is null or p_from > p_to or p_to - p_from > 366 then
    return public.app_err('Geçersiz tarih aralığı.', 'validation');
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
           'date', att.attendance_date, 'status', att.status, 'class_name', c.name
         ) order by att.attendance_date desc), '[]'::jsonb)
    into v_payload
    from public.attendances att
    left join public.classes c on c.id = att.class_id
   where att.athlete_id = p_athlete_id and att.is_deleted is not true
     and att.attendance_date between p_from and p_to;
  return public.app_ok(null, v_payload);
exception when others then
  return public.app_err(sqlerrm, public.app_sqlstate_code(sqlstate));
end;
$$;


ALTER FUNCTION "public"."parent_get_attendance"("p_athlete_id" "uuid", "p_from" "date", "p_to" "date") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."parent_get_payments"("p_athlete_id" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare v_payload jsonb;
begin
  if auth.uid() is null or public.get_user_role() is distinct from 8 then
    return public.app_err('Bu bilgilere yalnızca veli hesabıyla erişilebilir.', 'forbidden');
  end if;
  if not public.parent_owns_athlete(p_athlete_id) then
    return public.app_err('Sporcu bulunamadı.', 'not_found');
  end if;
  select coalesce(jsonb_agg(rec order by rec->>'expected_date' desc nulls last), '[]'::jsonb)
    into v_payload
    from (
      select jsonb_build_object(
        'id', fr.id, 'name', fr.name, 'type', fr.type, 'expected_date', fr.expected_date,
        'net_amount', fr.net_amount, 'status', fr.status,
        'paid_amount', coalesce(sum(t.amount), 0),
        'payments',
          coalesce(jsonb_agg(jsonb_build_object(
                     'amount', t.amount, 'date', t.transaction_date, 'method', t.method
                   ) order by t.transaction_date desc)
                   filter (where t.id is not null), '[]'::jsonb)
      ) as rec
        from public.financial_records fr
        join public.customers cu on cu.id = fr.customer_id
        left join public.transactions t on t.record_id = fr.id and t.is_deleted is not true
       where cu.athlete_id = p_athlete_id and cu.is_deleted is not true
         and fr.is_deleted is not true and fr.type in ('due', 'income')
         and fr.status <> 'cancelled'
       group by fr.id
    ) records;
  return public.app_ok(null, v_payload);
exception when others then
  return public.app_err(sqlerrm, public.app_sqlstate_code(sqlstate));
end;
$$;


ALTER FUNCTION "public"."parent_get_payments"("p_athlete_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."parent_owns_athlete"("p_athlete_id" "uuid") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select exists (
    select 1 from public.parent_athlete_links pal
      join public.athletes a on a.id = pal.athlete_id
     where pal.profile_id = auth.uid() and pal.athlete_id = p_athlete_id
       and pal.is_deleted is not true and a.is_deleted is not true
       and a.school_id = public.get_user_school_id()
  );
$$;


ALTER FUNCTION "public"."parent_owns_athlete"("p_athlete_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."parent_set_consents"("p_athlete_id" "uuid", "p_health" boolean DEFAULT NULL::boolean, "p_photo" boolean DEFAULT NULL::boolean, "p_promo_photo" boolean DEFAULT NULL::boolean) RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_uid       uuid := auth.uid();
  v_school_id uuid := public.get_user_school_id();
  v_photo     text;
  v_health_at timestamp with time zone;
  v_photo_at  timestamp with time zone;
  v_promo_at  timestamp with time zone;
begin
  if v_uid is null or public.get_user_role() is distinct from 8 then
    return public.app_err('Bu işlem yalnızca veli hesabıyla yapılabilir.', 'forbidden');
  end if;

  if not exists (
    select 1
      from public.parent_athlete_links pal
      join public.athletes a on a.id = pal.athlete_id
     where pal.profile_id = v_uid
       and pal.athlete_id = p_athlete_id
       and pal.is_deleted is not true
       and a.is_deleted is not true
       and a.school_id = v_school_id
  ) then
    return public.app_err('Sporcu bulunamadı.', 'not_found');
  end if;

  select photo_path into v_photo
    from public.athletes where id = p_athlete_id for update;

  update public.athletes set
    health_consent_at = case
      when p_health is true  then coalesce(health_consent_at, now())
      when p_health is false then null
      else health_consent_at end,
    blood_type        = case when p_health is false then null else blood_type end,
    health_problems   = case when p_health is false then null else health_problems end,
    has_health_report = case when p_health is false then null else has_health_report end,
    photo_consent_at = case
      when p_photo is true  then coalesce(photo_consent_at, now())
      when p_photo is false then null
      else photo_consent_at end,
    photo_path        = case when p_photo is false then null else photo_path end,
    promo_photo_consent_at = case
      when p_promo_photo is true  then coalesce(promo_photo_consent_at, now())
      when p_promo_photo is false then null
      else promo_photo_consent_at end
   where id = p_athlete_id
  returning health_consent_at, photo_consent_at, promo_photo_consent_at
       into v_health_at, v_photo_at, v_promo_at;

  return public.app_ok(null, jsonb_build_object(
    'health_consent_at',      v_health_at,
    'photo_consent_at',       v_photo_at,
    'promo_photo_consent_at', v_promo_at,
    'removed_photo_path',     case when p_photo is false then v_photo end
  ));
exception when others then
  return public.app_err(sqlerrm, public.app_sqlstate_code(sqlstate));
end;
$$;


ALTER FUNCTION "public"."parent_set_consents"("p_athlete_id" "uuid", "p_health" boolean, "p_photo" boolean, "p_promo_photo" boolean) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."pre_registration_measure"("p_value" "text") RETURNS numeric
    LANGUAGE "sql" IMMUTABLE
    SET "search_path" TO 'public'
    AS $_$
  select case
           when v ~ '^[0-9]+(\.[0-9]+)?$' and v::numeric > 0 then v::numeric
           else null
         end
    from (select replace(trim(coalesce(p_value, '')), ',', '.') as v) s;
$_$;


ALTER FUNCTION "public"."pre_registration_measure"("p_value" "text") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."pre_registration_measure"("p_value" "text") IS 'Ön kaydın serbest metin boy/kilo değerini sporcu kartının numeric alanına çevirir; okunamayan ya da sıfır/negatif değer null olur.';


CREATE OR REPLACE FUNCTION "public"."prevent_last_manager_removal"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_leaves boolean;
begin
  if old.school_id is null or old.role_id not in (1, 9) then
    return new;
  end if;

  if exists (select 1 from public.schools
              where id = old.school_id and is_deleted is true) then
    return new;
  end if;

  v_leaves := (new.is_deleted is true and old.is_deleted is not true)
           or new.school_id is distinct from old.school_id;

  if old.role_id = 9 and (v_leaves or new.role_id is distinct from 9) then
    if not exists (
      select 1 from public.profiles
       where school_id = old.school_id and role_id = 9
         and is_deleted is not true and id <> old.id
    ) then
      raise exception using
        errcode = 'P0001',
        message = 'İşlem reddedildi: okulda en az bir genel müdür bulunmak zorundadır.';
    end if;
  end if;

  if old.role_id = 1 and (v_leaves or new.role_id not in (1, 9)) then
    if not exists (
      select 1 from public.profiles
       where school_id = old.school_id and role_id in (1, 9)
         and is_deleted is not true and id <> old.id
    ) then
      raise exception using
        errcode = 'P0001',
        message = 'İşlem reddedildi: okulda en az bir yönetici bulunmak zorundadır.';
    end if;
  end if;

  return new;
end;
$$;


ALTER FUNCTION "public"."prevent_last_manager_removal"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."process_bulk_dues"("p_customer_id" "uuid", "p_dues_list" "jsonb", "p_branch_id" "uuid" DEFAULT NULL::"uuid", "p_school_id" "uuid" DEFAULT NULL::"uuid", "p_created_by" "uuid" DEFAULT NULL::"uuid", "p_income_expense_item_id" "uuid" DEFAULT NULL::"uuid", "p_discount_id" "uuid" DEFAULT NULL::"uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_school_id uuid;
  due_item    jsonb;
  v_record_id uuid;
  v_is_paid   boolean;
  v_amount    numeric;
  v_method    payment_method;
  v_count     int := 0;
begin
  if not public.can_manage_accounting() then
    return public.app_err('Bu işlemi gerçekleştirmek için yetkiniz yok.', 'forbidden');
  end if;

  v_school_id := public.get_user_school_id();
  if v_school_id is null
     or (p_school_id is not null and p_school_id <> v_school_id) then
    return public.app_err('Bu işlemi gerçekleştirmek için yetkiniz yok.', 'forbidden');
  end if;

  if p_dues_list is null or jsonb_array_length(p_dues_list) = 0 then
    return public.app_err('Eklenecek taksit listesi boş olamaz.', 'validation');
  end if;

  if not exists (
    select 1 from public.customers
     where id = p_customer_id and school_id = v_school_id and is_deleted is not true
       and public.customer_in_scope(id)
  ) then
    return public.app_err('Seçilen cari bulunamadı.', 'not_found');
  end if;

  if (select type from public.customers where id = p_customer_id) <> 'athlete' then
    raise exception 'Aidat kaydı sadece sporculara tanımlanabilir.';
  end if;

  if not public.finance_branch_ok(p_branch_id) then
    return public.app_err('Geçersiz veya yetkiniz olmayan bir şube seçildi.', 'validation');
  end if;

  -- Taksit başına kalem/indirim, genel değeri ezebilir. Liste döngüden ÖNCE
  -- bütünüyle doğrulanır: app_err dönmek önceki insert'leri geri almaz.
  if exists (
    select 1
      from jsonb_array_elements(p_dues_list) e
     cross join lateral (
       select coalesce((e->>'income_expense_item_id')::uuid, p_income_expense_item_id) as item_id,
              coalesce((e->>'discount_id')::uuid, p_discount_id)                       as discount_id
     ) x
     where (x.item_id is not null and not exists (
              select 1 from public.income_expense_items
               where id = x.item_id and school_id = v_school_id and is_deleted is not true
                 and public.income_expense_item_visible(id)))
        or (x.discount_id is not null and not exists (
              select 1 from public.discounts
               where id = x.discount_id and school_id = v_school_id and is_deleted is not true
                 and public.discount_visible(id)))
  ) then
    return public.app_err('Geçersiz veya yetkiniz olmayan bir gelir/gider kalemi ya da indirim seçildi.', 'validation');
  end if;

  for due_item in select * from jsonb_array_elements(p_dues_list)
  loop
    v_amount  := (due_item->>'net_amount')::numeric;
    v_is_paid := coalesce((due_item->>'is_paid')::boolean, false);

    insert into public.financial_records (
      customer_id, branch_id, school_id, type,
      income_expense_item_id, discount_id,
      name, invoice_no, expected_date, reminder_date,
      base_amount, discount_amount, net_amount,
      status, created_by, is_deleted
    ) values (
      p_customer_id, p_branch_id, v_school_id, 'due',
      coalesce((due_item->>'income_expense_item_id')::uuid, p_income_expense_item_id),
      coalesce((due_item->>'discount_id')::uuid, p_discount_id),
      (due_item->>'name')::text,
      nullif(trim(due_item->>'invoice_no'), ''),
      (due_item->>'expected_date')::date,
      (due_item->>'reminder_date')::date,
      coalesce((due_item->>'base_amount')::numeric, v_amount),
      coalesce((due_item->>'discount_amount')::numeric, 0),
      v_amount,
      case when v_is_paid then 'paid'::payment_status else 'unpaid'::payment_status end,
      auth.uid(),
      false
    ) returning id into v_record_id;

    if v_is_paid then
      v_method := coalesce((due_item->>'payment_method')::payment_method, 'cash');

      insert into public.transactions (
        record_id, amount, method, transaction_date, processed_by,
        school_id, branch_id, is_deleted
      ) values (
        v_record_id, v_amount, v_method, now(), auth.uid(),
        v_school_id, p_branch_id, false
      );
    end if;

    v_count := v_count + 1;
  end loop;

  return public.app_ok(format('%s adet aidat taksiti başarıyla oluşturuldu.', v_count));
exception when others then
  return public.app_err(sqlerrm, public.app_sqlstate_code(sqlstate));
end;
$$;


ALTER FUNCTION "public"."process_bulk_dues"("p_customer_id" "uuid", "p_dues_list" "jsonb", "p_branch_id" "uuid", "p_school_id" "uuid", "p_created_by" "uuid", "p_income_expense_item_id" "uuid", "p_discount_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."process_financial_operation"("p_type" "public"."accounting_type", "p_name" "text", "p_expected_date" "date", "p_net_amount" numeric, "p_customer_id" "uuid" DEFAULT NULL::"uuid", "p_new_customer_name" "text" DEFAULT NULL::"text", "p_new_customer_phone" "text" DEFAULT ''::"text", "p_branch_id" "uuid" DEFAULT NULL::"uuid", "p_school_id" "uuid" DEFAULT NULL::"uuid", "p_created_by" "uuid" DEFAULT NULL::"uuid", "p_income_expense_item_id" "uuid" DEFAULT NULL::"uuid", "p_discount_id" "uuid" DEFAULT NULL::"uuid", "p_description" "text" DEFAULT NULL::"text", "p_invoice_no" "text" DEFAULT NULL::"text", "p_reminder_date" "date" DEFAULT NULL::"date", "p_base_amount" numeric DEFAULT 0, "p_discount_amount" numeric DEFAULT 0, "p_tax_rate" integer DEFAULT 0, "p_tax_included" boolean DEFAULT true, "p_paid_amount" numeric DEFAULT 0, "p_payment_method" "public"."payment_method" DEFAULT NULL::"public"."payment_method") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_school_id         uuid;
  v_final_customer_id uuid;
  v_record_id         uuid;
  v_customer_type     customer_type;
begin
  if not public.can_manage_accounting() then
    return public.app_err('Bu işlemi gerçekleştirmek için yetkiniz yok.', 'forbidden');
  end if;

  v_school_id := public.get_user_school_id();
  if v_school_id is null
     or (p_school_id is not null and p_school_id <> v_school_id) then
    return public.app_err('Bu işlemi gerçekleştirmek için yetkiniz yok.', 'forbidden');
  end if;

  -- Referanslar yazmadan önce doğrulanır.
  if not public.finance_branch_ok(p_branch_id) then
    return public.app_err('Geçersiz veya yetkiniz olmayan bir şube seçildi.', 'validation');
  end if;

  if p_income_expense_item_id is not null and not exists (
    select 1 from public.income_expense_items
     where id = p_income_expense_item_id and school_id = v_school_id and is_deleted is not true
       and public.income_expense_item_visible(id)
  ) then
    return public.app_err('Geçersiz veya yetkiniz olmayan bir gelir/gider kalemi seçildi.', 'validation');
  end if;

  if p_discount_id is not null and not exists (
    select 1 from public.discounts
     where id = p_discount_id and school_id = v_school_id and is_deleted is not true
       and public.discount_visible(id)
  ) then
    return public.app_err('Geçersiz veya yetkiniz olmayan bir indirim seçildi.', 'validation');
  end if;

  -- 1. Cari çözümleme
  if p_customer_id is not null then
    select type into v_customer_type
      from public.customers
     where id = p_customer_id and school_id = v_school_id and is_deleted is not true
       and public.customer_in_scope(id);

    if not found then
      return public.app_err('Seçilen cari bulunamadı.', 'not_found');
    end if;

    v_final_customer_id := p_customer_id;
  elsif p_new_customer_name is not null and btrim(p_new_customer_name) <> '' then
    insert into public.customers (display_name, type, phone, school_id, is_deleted)
    values (btrim(p_new_customer_name), 'external', coalesce(p_new_customer_phone, ''), v_school_id, false)
    returning id, type into v_final_customer_id, v_customer_type;
  else
    return public.app_err('Geçerli bir müşteri seçilmeli veya yeni müşteri adı girilmelidir.', 'validation');
  end if;

  -- 2. Cari tipi geçerlilik kontrolü
  if p_type = 'due' and v_customer_type <> 'athlete' then
    raise exception 'Aidat kaydı sadece sporculara tanımlanabilir.';
  elsif p_type = 'income' and v_customer_type not in ('athlete', 'external') then
    raise exception 'Gelir kaydı yalnızca sporcular veya harici müşteriler için oluşturulabilir.';
  elsif p_type = 'expense' and v_customer_type not in ('external') then
    raise exception 'Gider kaydı yalnızca harici cariler için oluşturulabilir.';
  end if;

  -- 3. Tahakkuk
  insert into public.financial_records (
    customer_id, income_expense_item_id, discount_id, branch_id, school_id, type,
    name, description, invoice_no, expected_date, reminder_date,
    base_amount, discount_amount, tax_rate, tax_included, net_amount,
    status, created_by, is_deleted
  ) values (
    v_final_customer_id, p_income_expense_item_id, p_discount_id, p_branch_id, v_school_id, p_type,
    p_name, p_description, p_invoice_no, p_expected_date, p_reminder_date,
    p_base_amount, p_discount_amount, p_tax_rate, p_tax_included, p_net_amount,
    'unpaid', auth.uid(), false
  ) returning id into v_record_id;

  -- 4. Tahsilat
  if p_paid_amount is not null and p_paid_amount > 0 then
    if p_payment_method is null then
      raise exception 'Ödeme tutarı girildiyse ödeme yöntemi (payment_method) zorunludur.';
    end if;

    insert into public.transactions (
      record_id, amount, method, transaction_date, processed_by,
      school_id, branch_id, is_deleted
    ) values (
      v_record_id, p_paid_amount, p_payment_method, now(), auth.uid(),
      v_school_id, p_branch_id, false
    );

    perform public.recalculate_financial_record_status(v_record_id);
  end if;

  return public.app_ok('İşlem başarıyla kaydedildi.', jsonb_build_object('id', v_record_id));
exception when others then
  return public.app_err(sqlerrm, public.app_sqlstate_code(sqlstate));
end;
$$;


ALTER FUNCTION "public"."process_financial_operation"("p_type" "public"."accounting_type", "p_name" "text", "p_expected_date" "date", "p_net_amount" numeric, "p_customer_id" "uuid", "p_new_customer_name" "text", "p_new_customer_phone" "text", "p_branch_id" "uuid", "p_school_id" "uuid", "p_created_by" "uuid", "p_income_expense_item_id" "uuid", "p_discount_id" "uuid", "p_description" "text", "p_invoice_no" "text", "p_reminder_date" "date", "p_base_amount" numeric, "p_discount_amount" numeric, "p_tax_rate" integer, "p_tax_included" boolean, "p_paid_amount" numeric, "p_payment_method" "public"."payment_method") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."profile_branch_ids"("p_profile_id" "uuid") RETURNS "uuid"[]
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select coalesce(array_agg(l.branch_id order by l.branch_id), '{}'::uuid[])
    from public.profile_branch_links l
    join public.branches b on b.id = l.branch_id and b.is_deleted is not true
   where l.profile_id = p_profile_id
     and l.is_deleted is not true;
$$;


ALTER FUNCTION "public"."profile_branch_ids"("p_profile_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."profile_has_branch_access"("p_profile_id" "uuid", "p_branch_id" "uuid") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select exists (
    select 1
      from public.profiles p
      join public.branches b
        on b.id = p_branch_id
       and b.school_id = p.school_id
       and b.is_deleted is not true
     where p.id = p_profile_id
       and p.is_deleted is not true
       and (
            public.is_school_wide_role(p.role_id)
         or exists (
              select 1
                from public.profile_branch_links l
               where l.profile_id = p.id
                 and l.branch_id  = b.id
                 and l.is_deleted is not true
            )
       )
  );
$$;


ALTER FUNCTION "public"."profile_has_branch_access"("p_profile_id" "uuid", "p_branch_id" "uuid") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."profile_has_branch_access"("p_profile_id" "uuid", "p_branch_id" "uuid") IS 'has_branch_access()''in verilen profil için olanı. Bildirim alıcılarını çözen cron işleri kullanır; orada auth.uid() yok. İki fonksiyon aynı kuralı taşır — biri değişirse diğeri de değişmeli.';


CREATE OR REPLACE FUNCTION "public"."profile_has_permission"("p_profile_id" "uuid", "p_permission" "text") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select exists (
    select 1
      from public.profiles p
      join public.role_permissions rp
        on rp.role_id = p.role_id
       and rp.permission = p_permission
     where p.id = p_profile_id
       and p.is_deleted is not true
       and p.status = 'active'
       and (
            not rp.is_optional
         or exists (
              select 1
                from public.profile_permissions pp
               where pp.profile_id = p.id
                 and pp.permission = rp.permission
                 and pp.is_deleted is not true
            )
       )
  );
$$;


ALTER FUNCTION "public"."profile_has_permission"("p_profile_id" "uuid", "p_permission" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."profile_permission_list"("p_profile_id" "uuid") RETURNS "text"[]
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select coalesce(array_agg(rp.permission order by rp.permission), '{}'::text[])
    from public.profiles p
    join public.role_permissions rp on rp.role_id = p.role_id
   where p.id = p_profile_id
     and p.is_deleted is not true
     and (
          not rp.is_optional
       or exists (
            select 1
              from public.profile_permissions pp
             where pp.profile_id = p.id
               and pp.permission = rp.permission
               and pp.is_deleted is not true
          )
     );
$$;


ALTER FUNCTION "public"."profile_permission_list"("p_profile_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."profile_permissions_error"("p_target_id" "uuid", "p_role_id" bigint, "p_permissions" "text"[]) RETURNS "text"
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_requested text[];
  v_current   text[] := '{}'::text[];
  v_changed   text[];
begin
  select coalesce(array_agg(distinct x), '{}'::text[]) into v_requested
    from unnest(coalesce(p_permissions, '{}'::text[])) as t(x)
   where x is not null;

  if exists (
    select 1 from unnest(v_requested) as r(permission)
     where not exists (
       select 1 from public.role_permissions rp
        where rp.role_id = p_role_id
          and rp.permission = r.permission
          and rp.is_optional)
  ) then
    return 'Seçilen yetkilerden biri bu role verilemez.';
  end if;

  if 'finance.manage' = any (v_requested) and not ('finance.view' = any (v_requested)) then
    return 'Muhasebe düzenleme yetkisi, görüntüleme yetkisi olmadan verilemez.';
  end if;

  if p_target_id is not null then
    select coalesce(array_agg(pp.permission), '{}'::text[]) into v_current
      from public.profile_permissions pp
      join public.role_permissions rp
        on rp.role_id = p_role_id
       and rp.permission = pp.permission
       and rp.is_optional
     where pp.profile_id = p_target_id
       and pp.is_deleted is not true;
  end if;

  select coalesce(array_agg(x), '{}'::text[]) into v_changed
    from (
      (select unnest(v_requested) except select unnest(v_current))
      union
      (select unnest(v_current) except select unnest(v_requested))
    ) as d(x);

  if cardinality(v_changed) > 0 then
    if p_target_id = auth.uid() then
      return 'Kendi yetkilerinizi değiştiremezsiniz.';
    end if;
    if exists (select 1 from unnest(v_changed) as c(permission)
                where not public.has_permission(c.permission)) then
      return 'Sahip olmadığınız bir yetkiyi veremez ya da geri alamazsınız.';
    end if;
  end if;

  return null;
end;
$$;


ALTER FUNCTION "public"."profile_permissions_error"("p_target_id" "uuid", "p_role_id" bigint, "p_permissions" "text"[]) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."prune_profile_permissions_on_role_change"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
  update public.profile_permissions pp
     set is_deleted = true
   where pp.profile_id = new.id
     and pp.is_deleted is not true
     and not exists (
       select 1
         from public.role_permissions rp
        where rp.role_id = new.role_id
          and rp.permission = pp.permission
          and rp.is_optional
     );
  return new;
end;
$$;


ALTER FUNCTION "public"."prune_profile_permissions_on_role_change"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."public_get_branches"("p_school_id" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
  return public.app_ok(null, coalesce(
    (select jsonb_agg(jsonb_build_object('id', b.id, 'name', b.name) order by b.name)
       from public.branches b
      where b.school_id = p_school_id
        and (b.is_deleted is false or b.is_deleted is null)),
    '[]'::jsonb));
exception when others then
  return public.app_err(sqlerrm, public.app_sqlstate_code(sqlstate));
end;
$$;


ALTER FUNCTION "public"."public_get_branches"("p_school_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."public_get_branches_by_token"("p_token" "text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_school_id uuid;
begin
  v_school_id := public.resolve_pre_registration_token(p_token);

  if v_school_id is null then
    return public.app_err('Bağlantı geçersiz ya da süresi dolmuş. Lütfen kurumla iletişime geçin.', 'not_found');
  end if;

  return public.app_ok(null, coalesce(
    (select jsonb_agg(jsonb_build_object('id', b.id, 'name', b.name) order by b.name)
       from public.branches b
      where b.school_id = v_school_id
        and (b.is_deleted is false or b.is_deleted is null)),
    '[]'::jsonb));
exception when others then
  return public.app_err(sqlerrm, public.app_sqlstate_code(sqlstate));
end;
$$;


ALTER FUNCTION "public"."public_get_branches_by_token"("p_token" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."public_get_classes"("p_school_id" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
  return public.app_ok(null, coalesce(
    (select jsonb_agg(
              jsonb_build_object('id', t.id, 'branch_id', t.branch_id, 'name', t.name)
              order by t.name)
       from public.classes t
      where t.school_id = p_school_id
        and public.is_class_visible(t.id)),
    '[]'::jsonb));
exception when others then
  return public.app_err(sqlerrm, public.app_sqlstate_code(sqlstate));
end;
$$;


ALTER FUNCTION "public"."public_get_classes"("p_school_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."public_get_classes_by_token"("p_token" "text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_school_id uuid;
begin
  v_school_id := public.resolve_pre_registration_token(p_token);

  if v_school_id is null then
    return public.app_err('Bağlantı geçersiz ya da süresi dolmuş. Lütfen kurumla iletişime geçin.', 'not_found');
  end if;

  return public.app_ok(null, coalesce(
    (select jsonb_agg(jsonb_build_object('id', c.id, 'branch_id', c.branch_id, 'name', c.name) order by c.name)
       from public.classes c
      where c.school_id = v_school_id
        and public.is_class_visible(c.id)),
    '[]'::jsonb));
exception when others then
  return public.app_err(sqlerrm, public.app_sqlstate_code(sqlstate));
end;
$$;


ALTER FUNCTION "public"."public_get_classes_by_token"("p_token" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."public_get_school_branding"("p_school_id" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_row jsonb;
begin
  select jsonb_build_object('id', s.id, 'name', s.name, 'logo_url', s.logo_url)
    into v_row
    from public.schools s
   where s.id = p_school_id;

  if v_row is null then
    return public.app_err('Okul bulunamadı.', 'not_found');
  end if;

  return public.app_ok(null, v_row);
exception when others then
  return public.app_err(sqlerrm, public.app_sqlstate_code(sqlstate));
end;
$$;


ALTER FUNCTION "public"."public_get_school_branding"("p_school_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."public_get_school_branding_by_token"("p_token" "text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_school_id uuid;
  v_row       jsonb;
begin
  v_school_id := public.resolve_pre_registration_token(p_token);

  if v_school_id is null then
    return public.app_err('Bağlantı geçersiz ya da süresi dolmuş. Lütfen kurumla iletişime geçin.', 'not_found');
  end if;

  select jsonb_build_object('id', s.id, 'name', s.name, 'logo_url', s.logo_url)
    into v_row from public.schools s where s.id = v_school_id;

  if v_row is null then
    return public.app_err('Okul bulunamadı.', 'not_found');
  end if;

  return public.app_ok(null, v_row);
exception when others then
  return public.app_err(sqlerrm, public.app_sqlstate_code(sqlstate));
end;
$$;


ALTER FUNCTION "public"."public_get_school_branding_by_token"("p_token" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."purge_deleted_athlete_sensitive_data"() RETURNS integer
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_count integer;
begin
  update public.athletes
     set national_id       = null,
         blood_type        = null,
         health_problems   = null,
         has_health_report = null,
         health_consent_at = null
   where is_deleted is true
     and (national_id is not null
          or blood_type is not null
          or health_problems is not null
          or has_health_report is not null
          or health_consent_at is not null);
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;


ALTER FUNCTION "public"."purge_deleted_athlete_sensitive_data"() OWNER TO "postgres";


COMMENT ON FUNCTION "public"."purge_deleted_athlete_sensitive_data"() IS 'Silinen sporcuların TC kimlik numarası ve sağlık bilgisini temizler. Yalnızca pg_cron çağırır.';


CREATE OR REPLACE FUNCTION "public"."purge_expired_pre_registrations"() RETURNS integer
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  c_retention constant integer := 14; -- gün; gizlilik politikasıyla aynı
  v_today     date := (now() at time zone 'Europe/Istanbul')::date;
  v_ids       uuid[];
begin
  select coalesce(array_agg(id), '{}')
    into v_ids
    from public.pre_registrations
   where is_deleted is true
      or greatest(
           (created_at at time zone 'Europe/Istanbul')::date,
           interview_date,
           (updated_at at time zone 'Europe/Istanbul')::date
         ) + c_retention < v_today;

  if array_length(v_ids, 1) is null then
    return 0;
  end if;

  delete from public.notifications
   where type = 'pre_registration_received'
     and params->>'pre_registration_id' = any (v_ids::text[]);

  delete from public.pre_registrations
   where id = any (v_ids);

  return array_length(v_ids, 1);
end;
$$;


ALTER FUNCTION "public"."purge_expired_pre_registrations"() OWNER TO "postgres";


COMMENT ON FUNCTION "public"."purge_expired_pre_registrations"() IS 'KVKK saklama süresi: son işlem veya görüşme tarihinden (geç olanı) 14 gün sonra ön kaydı ve bildirimlerini kalıcı siler; personelin sildiği kayıtları beklemeden siler. Yalnızca pg_cron çağırır.';


CREATE OR REPLACE FUNCTION "public"."purge_expired_site_leads"() RETURNS integer
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_deleted integer;
begin
  delete from public.site_leads where created_at < now() - interval '12 months';
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;


ALTER FUNCTION "public"."purge_expired_site_leads"() OWNER TO "postgres";


COMMENT ON FUNCTION "public"."purge_expired_site_leads"() IS 'KVKK saklama süresi: 12 aydan eski site taleplerini kalıcı siler. Yalnızca pg_cron çağırır.';


CREATE OR REPLACE FUNCTION "public"."queue_attendance_results"("p_attendance_ids" "uuid"[]) RETURNS integer
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_today date := public.app_local_date();
  v_count integer;
begin
  insert into public.notifications (school_id, recipient_id, type, params, dedupe_key)
  select x.school_id, r.profile_id, 'attendance_result',
         jsonb_build_object(
           'athlete_id',   a.id,
           'athlete_name', a.full_name,
           'class_id',     x.class_id,
           'class_name',   c.name,
           'date',         x.attendance_date,
           'status',       x.status,
           'sender_name',  s.name),
         'attendance_result:' || x.athlete_id || ':' || x.class_id
           || ':' || x.attendance_date
    from public.attendances x
    join public.athletes a on a.id = x.athlete_id
                          and a.school_id = x.school_id
                          and a.is_deleted is not true
    join public.schools  s on s.id = x.school_id  and s.is_deleted is not true
    left join public.classes c on c.id = x.class_id
    cross join lateral public.direct_message_recipients(a.id) r
   where x.id = any(p_attendance_ids)
     and x.is_deleted is not true
     and x.attendance_date between v_today - 1 and v_today
  on conflict (recipient_id, dedupe_key) where dedupe_key is not null do update
    set params          = excluded.params,
        is_deleted      = false,
        read_at         = null,
        created_at      = now(),
        push_status     = 'pending',
        push_attempts   = 0,
        push_claimed_at = null,
        pushed_at       = null
    -- Aynı durumla yeniden kaydetmek bir şey değiştirmez; yalnızca gerçek
    -- düzeltme ya da geri getirilen yoklama veliye yeniden ulaşır.
    where notifications.params->>'status' is distinct from excluded.params->>'status'
       or notifications.is_deleted is true;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;


ALTER FUNCTION "public"."queue_attendance_results"("p_attendance_ids" "uuid"[]) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."recalculate_financial_record_status"("p_record_id" "uuid") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$DECLARE
    v_net_amount NUMERIC;
    v_paid_amount NUMERIC;
    v_new_status payment_status;
BEGIN
    SELECT net_amount INTO v_net_amount 
    FROM financial_records 
    WHERE id = p_record_id AND (is_deleted = false OR is_deleted IS NULL);

    SELECT COALESCE(SUM(amount), 0) INTO v_paid_amount 
    FROM transactions 
    WHERE record_id = p_record_id AND (is_deleted = false OR is_deleted IS NULL);

    IF v_paid_amount >= v_net_amount THEN
        v_new_status := 'paid';
    ELSIF v_paid_amount > 0 THEN
        v_new_status := 'partial';
    ELSE
        v_new_status := 'unpaid';
    END IF;

    UPDATE financial_records 
    SET status = v_new_status 
    WHERE id = p_record_id;
END;$$;


ALTER FUNCTION "public"."recalculate_financial_record_status"("p_record_id" "uuid") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."recalculate_financial_record_status"("p_record_id" "uuid") IS 'Bir finansal kaydın ödeme statüsünü tahsilatlarından yeniden hesaplar. DAHİLİ: yalnızca muhasebe RPC''lerinin içinden çağrılır, istemciye kapalı. Kendi içinde yetki denetimi YOK — çağıranların can_manage_accounting() kapısı geçerlidir, o yüzden doğrudan erişime açılmamalı.';


CREATE OR REPLACE FUNCTION "public"."record_pre_registration_attempt"("p_ip_hash" "text", "p_school_id" "uuid" DEFAULT NULL::"uuid", "p_limit" integer DEFAULT 15, "p_window" interval DEFAULT '01:00:00'::interval) RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_recent integer;
begin
  if p_ip_hash is null or btrim(p_ip_hash) = '' then
    -- IP çözülemediyse sınır uygulanamaz; isteği reddetmiyoruz, çünkü bazı
    -- vekil sunucu düzenlerinde başlık hiç gelmiyor ve gerçek velileri
    -- kesmek istemiyoruz. Telefon bazlı sınır yine devrede.
    return public.app_ok(null, jsonb_build_object('allowed', true, 'recent', 0));
  end if;

  delete from public.pre_registration_attempts
   where created_at < now() - interval '24 hours';

  select count(*) into v_recent
    from public.pre_registration_attempts
   where ip_hash = p_ip_hash
     and created_at > now() - p_window;

  insert into public.pre_registration_attempts (ip_hash, school_id)
  values (p_ip_hash, p_school_id);

  return public.app_ok(null, jsonb_build_object(
    'allowed', v_recent < p_limit,
    'recent', v_recent
  ));
exception when others then
  return public.app_err(sqlerrm, public.app_sqlstate_code(sqlstate));
end;
$$;


ALTER FUNCTION "public"."record_pre_registration_attempt"("p_ip_hash" "text", "p_school_id" "uuid", "p_limit" integer, "p_window" interval) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."register_push_token"("p_token" "text", "p_app" "text", "p_platform" "text", "p_locale" "text" DEFAULT 'tr'::"text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_uid  uuid   := auth.uid();
  v_role bigint := public.get_user_role();
begin
  if v_uid is null or v_role is null then
    return public.app_err('Oturum bulunamadı.', 'forbidden');
  end if;

  if p_token is null or length(p_token) not between 20 and 4096 then
    return public.app_err('Cihaz anahtarı geçersiz.', 'validation');
  end if;

  if p_app not in ('dev_adim', 'public', 'parent') then
    return public.app_err('Uygulama tanınmıyor.', 'validation');
  end if;

  if p_platform not in ('android', 'ios', 'web', 'macos') then
    return public.app_err('Platform tanınmıyor.', 'validation');
  end if;

  if (p_app = 'parent' and v_role <> 8)
     or (p_app <> 'parent' and v_role not in (1, 2, 3, 4, 5, 9)) then
    return public.app_err('Bu uygulama için bildirim kaydı yapılamaz.', 'forbidden');
  end if;

  insert into public.push_tokens (token, profile_id, app, platform, locale)
  values (
    p_token, v_uid, p_app, p_platform,
    case when p_locale in ('tr', 'en') then p_locale else 'tr' end
  )
  on conflict (token) do update
    set profile_id   = excluded.profile_id,
        app          = excluded.app,
        platform     = excluded.platform,
        locale       = excluded.locale,
        last_seen_at = now();

  return public.app_ok(null, null);
exception
  when others then
    return public.app_err(sqlerrm, public.app_sqlstate_code(sqlstate));
end;
$$;


ALTER FUNCTION "public"."register_push_token"("p_token" "text", "p_app" "text", "p_platform" "text", "p_locale" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."request_push_dispatch"() RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_url    text;
  v_secret text;
begin
  select decrypted_secret into v_url
    from vault.decrypted_secrets where name = 'push_dispatch_url';
  select decrypted_secret into v_secret
    from vault.decrypted_secrets where name = 'push_dispatch_secret';

  if v_url is null or v_secret is null then
    return;
  end if;

  perform net.http_post(
    url     := v_url,
    headers := jsonb_build_object(
                 'Content-Type', 'application/json',
                 'x-dispatch-secret', v_secret),
    body    := '{}'::jsonb,
    timeout_milliseconds := 10000
  );
exception
  when others then
    raise warning 'Push dürtmesi gönderilemedi (%): %', sqlstate, sqlerrm;
end;
$$;


ALTER FUNCTION "public"."request_push_dispatch"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."resolve_health_consent"("p_consent" boolean, "p_existing" timestamp with time zone) RETURNS timestamp with time zone
    LANGUAGE "sql" STABLE
    SET "search_path" TO 'public'
    AS $$
  select case
    when p_consent is false then null
    else p_existing
  end;
$$;


ALTER FUNCTION "public"."resolve_health_consent"("p_consent" boolean, "p_existing" timestamp with time zone) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."resolve_pre_registration_token"("p_token" "text") RETURNS "uuid"
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_token     text := btrim(p_token);
  v_school_id uuid;
  v_legacy_id uuid;
begin
  if v_token is null or v_token = '' then
    return null;
  end if;

  select l.school_id into v_school_id
    from public.pre_registration_links l
   where l.token = v_token
     and l.is_active
     and l.is_deleted is not true;

  if v_school_id is not null then
    return v_school_id;
  end if;

  begin
    v_legacy_id := v_token::uuid;
  exception when others then
    return null;
  end;

  select s.id into v_school_id from public.schools s where s.id = v_legacy_id;
  return v_school_id;
end;
$$;


ALTER FUNCTION "public"."resolve_pre_registration_token"("p_token" "text") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."resolve_pre_registration_token"("p_token" "text") IS 'Genel ön kayıt bağlantısını okula çözer. Token ya da (geçiş desteği) eski school_id biçimini kabul eder; geçersizse null döner.';


CREATE OR REPLACE FUNCTION "public"."role_rank"("p_role_id" bigint) RETURNS integer
    LANGUAGE "sql" IMMUTABLE
    SET "search_path" TO 'public'
    AS $$
  select case p_role_id
           when 9 then 4
           when 2 then 3
           when 3 then 2
           when 4 then 1
           when 5 then 1
           when 6 then 1
           when 7 then 1
           else 0
         end;
$$;


ALTER FUNCTION "public"."role_rank"("p_role_id" bigint) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."rotate_pre_registration_link"() RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
  -- Bağlantı sabittir (20261018). Eski uygulama sürümleri "Bağlantıyı
  -- yenile" düğmesini hâlâ gösteriyor; okunur bir ret alsınlar.
  return public.app_err(
    'Ön kayıt bağlantısı sabittir ve yenilenemez.', 'forbidden');
end;
$$;


ALTER FUNCTION "public"."rotate_pre_registration_link"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."save_attendances"("p_school_id" "uuid", "p_branch_id" "uuid", "p_class_id" "uuid", "p_attendance_date" "date", "p_items" "jsonb", "p_coach_id" "uuid" DEFAULT NULL::"uuid", "p_created_by" "uuid" DEFAULT NULL::"uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_count     int;
  v_school_id uuid;
  v_branch_id uuid;
  v_actor_id  uuid := auth.uid();
begin
  if not public.has_permission('attendance.take') then
    return public.app_err('Yoklama almak için yetkiniz yok.', 'forbidden');
  end if;

  v_school_id := public.get_user_school_id();

  if v_school_id is null then
    return public.app_err('Kullanıcının bağlı olduğu okul bulunamadı.', 'forbidden');
  end if;

  if p_school_id is not null and p_school_id <> v_school_id then
    return public.app_err('Başka bir okul adına yoklama alınamaz.', 'forbidden');
  end if;

  select t.branch_id into v_branch_id
    from public.classes t
   where t.id = p_class_id
     and t.school_id = v_school_id
     and (t.is_deleted is false or t.is_deleted is null)
     and public.has_branch_access(t.branch_id);

  if not found then
    return public.app_err(
      'Sınıf bulunamadı veya bu sınıf üzerinde işlem yetkiniz yok.', 'not_found');
  end if;

  if p_items is null or jsonb_typeof(p_items) <> 'array' then
    return public.app_err('Yoklama listesi geçersiz.', 'validation');
  end if;

  if jsonb_array_length(p_items) = 0 then
    return public.app_err('Kaydedilecek sporcu bulunamadı.', 'not_found');
  end if;

  insert into public.attendances (
    school_id, branch_id, class_id, athlete_id,
    attendance_date, status, note, coach_id, created_by, is_deleted
  )
  select
    v_school_id, v_branch_id, p_class_id,
    a.id,
    p_attendance_date,
    coalesce((item->>'status')::public.attendance_status, 'present'),
    nullif(item->>'note', ''),
    v_actor_id, v_actor_id, false
  from jsonb_array_elements(p_items) as item
  join public.athletes a
    on a.id = (item->>'athlete_id')::uuid
   and a.school_id = v_school_id
   and a.is_deleted is not true
   and public.has_branch_access(a.branch_id)
  on conflict (class_id, athlete_id, attendance_date) do update
    set status     = excluded.status,
        note       = excluded.note,
        coach_id   = excluded.coach_id,
        created_by = excluded.created_by,
        is_deleted = false;

  get diagnostics v_count = row_count;

  return public.app_ok(null, jsonb_build_object('saved_count', v_count));
exception
  when others then
    return public.app_err(sqlerrm, public.app_sqlstate_code(sqlstate));
end;
$$;


ALTER FUNCTION "public"."save_attendances"("p_school_id" "uuid", "p_branch_id" "uuid", "p_class_id" "uuid", "p_attendance_date" "date", "p_items" "jsonb", "p_coach_id" "uuid", "p_created_by" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."save_staff_profile"("p_profile_id" "uuid", "p_full_name" "text", "p_email" "text", "p_phone_number" "text", "p_birth_of_date" "date", "p_status" "text", "p_role_id" bigint, "p_branch_ids" "uuid"[], "p_permissions" "text"[], "p_validate_only" boolean DEFAULT false, "p_class_ids" "uuid"[] DEFAULT NULL::"uuid"[]) RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_uid       uuid := auth.uid();
  v_school_id uuid := public.get_user_school_id();
  v_existing  public.profiles%rowtype;
  v_is_new    boolean;
  v_status    public.approval_status;
  v_wide      boolean := public.is_school_wide_role(p_role_id);
  v_branches  uuid[];
  v_error     text;
begin
  if p_profile_id is not null then
    select * into v_existing from public.profiles where id = p_profile_id;
  end if;
  v_is_new := v_existing.id is null;

  if btrim(coalesce(p_full_name, '')) = '' then
    return public.app_err('Ad soyad zorunludur.', 'validation');
  end if;
  if btrim(coalesce(p_email, '')) = '' then
    return public.app_err('E-posta zorunludur.', 'validation');
  end if;
  if p_role_id is null then
    return public.app_err('Rol seçilmelidir.', 'validation');
  end if;

  begin
    v_status := coalesce(nullif(p_status, ''), 'active')::public.approval_status;
  exception when others then
    return public.app_err('Geçersiz durum.', 'validation');
  end;

  if p_branch_ids is not null or v_is_new then
    select coalesce(array_agg(distinct b), '{}'::uuid[]) into v_branches
      from unnest(coalesce(p_branch_ids, '{}'::uuid[])) as t(b)
     where b is not null;
  end if;

  v_error := public.staff_management_error(
    case when v_is_new then null else p_profile_id end,
    p_role_id,
    case when v_wide then null else v_branches end
  );
  if v_error is not null then
    return public.app_err(v_error, 'forbidden');
  end if;

  if not v_is_new and p_profile_id = v_uid
     and v_status is distinct from v_existing.status then
    return public.app_err('Kendi hesabınızın durumunu değiştiremezsiniz.', 'forbidden');
  end if;

  if not v_wide and v_branches is not null and exists (
    select 1 from unnest(v_branches) as b(branch_id)
     where not exists (
       select 1 from public.branches br
        where br.id = b.branch_id and br.school_id = v_school_id and br.is_deleted is not true)
  ) then
    return public.app_err('Geçersiz veya yetkiniz olmayan bir şube seçildi.', 'validation');
  end if;

  if p_permissions is not null or v_is_new then
    v_error := public.profile_permissions_error(
      case when v_is_new then null else p_profile_id end,
      p_role_id,
      coalesce(p_permissions, '{}'::text[])
    );
    if v_error is not null then
      return public.app_err(v_error, 'forbidden');
    end if;
  end if;

  -- Sınıflar eğitmenin kayıttan SONRAKİ şubelerine göre doğrulanır.
  if p_class_ids is not null then
    v_error := public.coach_classes_error(
      case when v_is_new then null else p_profile_id end,
      p_role_id,
      v_status,
      coalesce(v_branches, public.profile_branch_ids(p_profile_id)),
      p_class_ids
    );
    if v_error is not null then
      return public.app_err(v_error, 'validation');
    end if;
  end if;

  if p_validate_only then
    return public.app_ok(null, jsonb_build_object('is_new', v_is_new));
  end if;

  -- ── Yazma: buradan sonra hata, exception ile bütünüyle geri alınır. ──
  if v_is_new then
    if p_profile_id is null or not exists (
      select 1 from auth.users u
       where u.id = p_profile_id
         and u.raw_user_meta_data->>'created_by' = v_uid::text
         and u.created_at > now() - interval '15 minutes'
    ) then
      return public.app_err('Hesap doğrulanamadı.', 'forbidden');
    end if;

    insert into public.profiles (
      id, full_name, email, phone_number, birth_of_date, school_id, status, role_id
    ) values (
      p_profile_id, btrim(p_full_name), btrim(p_email), p_phone_number,
      p_birth_of_date, v_school_id, v_status, p_role_id
    );
  else
    update public.profiles
       set full_name     = btrim(p_full_name),
           email         = btrim(p_email),
           phone_number  = p_phone_number,
           birth_of_date = p_birth_of_date,
           status        = v_status,
           role_id       = p_role_id
     where id = p_profile_id;
  end if;

  if not v_wide and v_branches is not null then
    perform public.write_profile_branch_links(p_profile_id, v_school_id, v_branches);
  end if;

  if p_permissions is not null or v_is_new then
    perform public.write_profile_permissions(
      p_profile_id, v_school_id, coalesce(p_permissions, '{}'::text[]));
  end if;

  -- Şube bağlarından sonra: şubeden çıkan sınıfları orası zaten kapatır,
  -- doğrulama da onları listede bırakmaya izin vermez.
  if p_class_ids is not null then
    perform public.write_coach_class_links(p_profile_id, v_school_id, p_class_ids);
  end if;

  return public.app_ok(
    case when v_is_new then 'Kullanıcı oluşturuldu.' else 'Kullanıcı güncellendi.' end,
    jsonb_build_object('id', p_profile_id));
exception when others then
  return public.app_err(sqlerrm, public.app_sqlstate_code(sqlstate));
end;
$$;


ALTER FUNCTION "public"."save_staff_profile"("p_profile_id" "uuid", "p_full_name" "text", "p_email" "text", "p_phone_number" "text", "p_birth_of_date" "date", "p_status" "text", "p_role_id" bigint, "p_branch_ids" "uuid"[], "p_permissions" "text"[], "p_validate_only" boolean, "p_class_ids" "uuid"[]) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."send_announcement"("p_title" "text", "p_body" "text", "p_role_ids" bigint[] DEFAULT NULL::bigint[], "p_branch_ids" "uuid"[] DEFAULT NULL::"uuid"[]) RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_uid uuid := auth.uid(); v_role bigint := public.get_user_role(); v_school_id uuid := public.get_user_school_id();
  v_title text := btrim(coalesce(p_title, '')); v_body text := btrim(coalesce(p_body, ''));
  v_roles bigint[]; v_branches uuid[]; v_id uuid; v_count integer; v_sender text;
begin
  if not public.has_permission('communication.announce') then
    return public.app_err('Duyuru göndermek için yetkiniz yok.', 'forbidden');
  end if;
  if v_school_id is null then
    return public.app_err('Kullanıcının bağlı olduğu okul bulunamadı.', 'forbidden');
  end if;
  if length(v_title) = 0 or length(v_title) > 100 then
    return public.app_err('Başlık 1-100 karakter olmalı.', 'validation');
  end if;
  if length(v_body) = 0 or length(v_body) > 1000 then
    return public.app_err('Mesaj 1-1000 karakter olmalı.', 'validation');
  end if;
  if (select count(*) from public.notification_announcements a
       where a.sender_id = v_uid and a.created_at > now() - interval '24 hours') >= 30 then
    return public.app_err('Son 24 saatte çok fazla duyuru gönderildi. Lütfen daha sonra tekrar deneyin.', 'conflict');
  end if;
  v_roles := coalesce(nullif(p_role_ids, '{}'), array[2, 3, 4, 5, 9]::bigint[]);
  if not (v_roles <@ array[2, 3, 4, 5, 8, 9]::bigint[]) then
    return public.app_err('Seçilen rollerden biri duyuru alamaz.', 'validation');
  end if;
  v_branches := nullif(p_branch_ids, '{}');
  if v_branches is not null then
    if exists (select 1 from unnest(v_branches) b where not public.has_branch_access(b)) then
      return public.app_err('Seçilen şubelerden birine erişiminiz yok.', 'forbidden');
    end if;
  elsif not public.is_school_wide_role(v_role) then
    select coalesce(array_agg(b.id), '{}') into v_branches from public.branches b
     where b.school_id = v_school_id and b.is_deleted is not true and public.has_branch_access(b.id);
  end if;
  select full_name into v_sender from public.profiles where id = v_uid;
  insert into public.notification_announcements (school_id, sender_id, title, body, role_ids, branch_ids)
  values (v_school_id, v_uid, v_title, v_body, coalesce(nullif(p_role_ids, '{}'), '{}'), coalesce(nullif(p_branch_ids, '{}'), '{}'))
  returning id into v_id;
  insert into public.notifications (school_id, recipient_id, type, params, announcement_id, dedupe_key)
  select v_school_id, p.id, 'announcement',
         jsonb_build_object('title', v_title, 'body', v_body, 'sender_name', v_sender, 'announcement_id', v_id),
         v_id, 'announcement:' || v_id
    from public.profiles p
   where p.school_id = v_school_id and p.id <> v_uid and p.is_deleted is not true
     and p.status = 'active' and p.role_id = any (v_roles)
     and (
          (p.role_id <> 8 and (v_branches is null
            or exists (select 1 from unnest(v_branches) b where public.profile_has_branch_access(p.id, b))))
       or (p.role_id = 8 and exists (
               select 1 from public.parent_athlete_links pal
                 join public.athletes a on a.id = pal.athlete_id
                where pal.profile_id = p.id and pal.is_deleted is not true and a.is_deleted is not true
                  and a.school_id = v_school_id and (v_branches is null or a.branch_id = any (v_branches))))
     );
  get diagnostics v_count = row_count;
  if v_count = 0 then
    raise exception using errcode = 'P0001', message = 'Seçilen kitlede bildirim gönderilecek kimse yok.';
  end if;
  update public.notification_announcements set recipient_count = v_count where id = v_id;
  return public.app_ok('Duyuru gönderildi.', jsonb_build_object('id', v_id, 'recipient_count', v_count));
exception
  when sqlstate 'P0001' then return public.app_err(sqlerrm, 'validation');
  when others then return public.app_err(sqlerrm, public.app_sqlstate_code(sqlstate));
end;
$$;


ALTER FUNCTION "public"."send_announcement"("p_title" "text", "p_body" "text", "p_role_ids" bigint[], "p_branch_ids" "uuid"[]) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."send_direct_message"("p_athlete_id" "uuid", "p_body" "text", "p_id" "uuid" DEFAULT NULL::"uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_uid        uuid   := auth.uid();
  v_role       bigint := public.get_user_role();
  v_school_id  uuid   := public.get_user_school_id();
  v_body       text   := btrim(coalesce(p_body, ''));
  v_id         uuid   := coalesce(p_id, gen_random_uuid());
  v_existing   public.direct_messages%rowtype;
  v_athlete    public.athletes%rowtype;
  v_recipients integer;
  v_count      integer;
  v_sender     text;
begin
  if not public.has_permission('communication.message') then
    return public.app_err('Veliye mesaj göndermek için yetkiniz yok.', 'forbidden');
  end if;
  if v_school_id is null then
    return public.app_err('Kullanıcının bağlı olduğu okul bulunamadı.', 'forbidden');
  end if;
  select * into v_existing from public.direct_messages where id = v_id;
  if found then
    if v_existing.sender_id = v_uid then
      return public.app_ok('Mesaj gönderildi.',
        jsonb_build_object('id', v_existing.id,
                           'recipient_count', v_existing.recipient_count));
    end if;
    return public.app_err('Mesaj kimliği kullanılamaz.', 'conflict');
  end if;
  if length(v_body) = 0 or length(v_body) > 1000 then
    return public.app_err('Mesaj 1-1000 karakter olmalı.', 'validation');
  end if;
  if p_athlete_id is null or not public.can_message_athlete(p_athlete_id) then
    return public.app_err('Sporcu bulunamadı.', 'not_found');
  end if;
  select * into v_athlete from public.athletes where id = p_athlete_id;
  select count(*) into v_recipients
    from public.direct_message_recipients(p_athlete_id);
  if v_recipients = 0 then
    return public.app_err(
      'Bu sporcunun veli uygulamasına kayıtlı velisi yok.', 'validation');
  end if;
  if (select count(*) from public.direct_messages m
       where m.sender_id = v_uid
         and m.created_at > now() - interval '24 hours') >= 100 then
    return public.app_err(
      'Son 24 saatte çok fazla mesaj gönderildi. Lütfen daha sonra tekrar deneyin.',
      'conflict');
  end if;
  if (select count(*) from public.direct_messages m
       where m.athlete_id = p_athlete_id
         and m.created_at > now() - interval '24 hours') >= 5 then
    return public.app_err(
      'Bu sporcunun velisine bugün yeterince mesaj gönderildi. Lütfen yarın tekrar deneyin.',
      'conflict');
  end if;
  select full_name into v_sender from public.profiles where id = v_uid;
  insert into public.direct_messages (
    id, school_id, branch_id, athlete_id, sender_id, body, recipient_count
  )
  values (
    v_id, v_school_id, v_athlete.branch_id, v_athlete.id, v_uid, v_body, v_recipients
  );
  insert into public.notifications (
    school_id, recipient_id, type, params, direct_message_id, dedupe_key
  )
  select v_school_id, r.profile_id, 'direct_message',
         jsonb_build_object(
           'direct_message_id', v_id,
           'athlete_id',        v_athlete.id,
           'athlete_name',      v_athlete.full_name,
           'sender_name',       v_sender,
           'body',              v_body),
         v_id,
         'direct_message:' || v_id
    from public.direct_message_recipients(p_athlete_id) r
  on conflict (recipient_id, dedupe_key) where dedupe_key is not null do nothing;
  get diagnostics v_count = row_count;
  if v_count <> v_recipients then
    update public.direct_messages set recipient_count = v_count where id = v_id;
  end if;
  return public.app_ok('Mesaj gönderildi.',
    jsonb_build_object('id', v_id, 'recipient_count', v_count));
exception
  when unique_violation then
    return public.app_err('Mesaj zaten gönderildi.', 'conflict');
  when others then
    return public.app_err(sqlerrm, public.app_sqlstate_code(sqlstate));
end;
$$;


ALTER FUNCTION "public"."send_direct_message"("p_athlete_id" "uuid", "p_body" "text", "p_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."set_athlete_photo"("p_athlete_id" "uuid", "p_photo_path" "text" DEFAULT NULL::"text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $_$
declare
  v_school_id  uuid;
  v_branch_id  uuid;
  v_previous   text;
  v_prefix     text;
  v_consent_at timestamp with time zone;
begin
  if not public.has_permission('registration.manage') then
    return public.app_err('Bu işlemi gerçekleştirmek için yetkiniz yok.', 'forbidden');
  end if;

  v_school_id := public.get_user_school_id();
  if v_school_id is null then
    return public.app_err('Kullanıcının bağlı olduğu okul bulunamadı.', 'forbidden');
  end if;

  -- Satırı kilitle: iki kişi aynı anda fotoğraf değiştirirse "önceki" yol
  -- ikisinde de aynı çıkmasın; biri ötekinin yüklediği dosyayı silmesin.
  select photo_path, branch_id, photo_consent_at
    into v_previous, v_branch_id, v_consent_at
    from public.athletes
   where id = p_athlete_id
     and school_id = v_school_id
     and is_deleted is not true
   for update;

  if not found or not public.has_branch_access(v_branch_id) then
    return public.app_err('Sporcu bulunamadı.', 'not_found');
  end if;

  if p_photo_path is not null then
    if v_consent_at is null then
      return public.app_err(
        'Velinin fotoğraf için açık rızası yok. Veli rızayı veli uygulamasından ya da online ön kayıt formundan verir.',
        'validation'
      );
    end if;

    v_prefix := v_school_id::text || '/' || p_athlete_id::text || '/';

    -- Yol bu okulun bu sporcusuna ait olmalı; başka bir sporcunun (veya
    -- okulun) dosyasına işaret eden bir yol yazılamaz.
    if left(p_photo_path, length(v_prefix)) <> v_prefix
       or substr(p_photo_path, length(v_prefix) + 1) !~ '^[A-Za-z0-9-]+\.jpg$' then
      return public.app_err('Geçersiz fotoğraf yolu.', 'validation');
    end if;

    -- Var olmayan bir dosyaya işaret eden kayıt kırık bir resim demektir.
    if not exists (
      select 1 from storage.objects
       where bucket_id = 'athlete-photos' and name = p_photo_path
    ) or not exists (
      select 1 from storage.objects
       where bucket_id = 'athlete-photos'
         and name = regexp_replace(p_photo_path, '\.jpg$', '_thumb.jpg')
    ) then
      return public.app_err('Fotoğraf dosyası bulunamadı. Lütfen tekrar yükleyin.', 'validation');
    end if;
  end if;

  update public.athletes
     set photo_path = p_photo_path
   where id = p_athlete_id;

  return public.app_ok(
    case when p_photo_path is null then 'Fotoğraf kaldırıldı.' else 'Fotoğraf kaydedildi.' end,
    jsonb_build_object(
      'photo_path',          p_photo_path,
      'previous_photo_path', case when v_previous is distinct from p_photo_path then v_previous end
    )
  );
exception when others then
  return public.app_err(sqlerrm, public.app_sqlstate_code(sqlstate));
end;
$_$;


ALTER FUNCTION "public"."set_athlete_photo"("p_athlete_id" "uuid", "p_photo_path" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."set_notification_preference"("p_type" "text", "p_push_enabled" boolean) RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
  if auth.uid() is null then
    return public.app_err('Oturum bulunamadı.', 'forbidden');
  end if;

  if p_type = 'announcement' then
    return public.app_err('Duyuru bildirimleri kapatılamaz.', 'validation');
  end if;

  if p_type not in (
    'attendance_reminder', 'attendance_missing_summary',
    'pre_registration_received', 'registrations_expiring',
    'payments_due', 'birthdays_today', 'birthdays_upcoming'
  ) then
    return public.app_err('Bildirim türü tanınmıyor.', 'validation');
  end if;

  if p_push_enabled is null then
    return public.app_err('Tercih boş olamaz.', 'validation');
  end if;

  insert into public.notification_preferences (profile_id, type, push_enabled)
  values (auth.uid(), p_type, p_push_enabled)
  on conflict (profile_id, type) do update
    set push_enabled = excluded.push_enabled;

  return public.app_ok(null, null);
exception
  when others then
    return public.app_err(sqlerrm, public.app_sqlstate_code(sqlstate));
end;
$$;


ALTER FUNCTION "public"."set_notification_preference"("p_type" "text", "p_push_enabled" boolean) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."set_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$
begin
  new.updated_at := now();
  return new;
end;
$$;


ALTER FUNCTION "public"."set_updated_at"() OWNER TO "postgres";


COMMENT ON FUNCTION "public"."set_updated_at"() IS 'updated_at''in tek yazarı. <tablo>_set_updated_at trigger''ları çağırır; RPC''ler alanı yazmaz. Bkz. 20260930_updated_at_automation.sql.';


CREATE OR REPLACE FUNCTION "public"."sport_writable"("p_sport_id" "uuid") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select public.current_user_is_school_wide()
      or (
           exists (
             select 1 from public.branch_sport_links l
               join public.branches b on b.id = l.branch_id and b.is_deleted is not true
              where l.sport_id = p_sport_id and l.is_deleted is not true)
       and not exists (
             select 1 from public.branch_sport_links l
               join public.branches b on b.id = l.branch_id and b.is_deleted is not true
              where l.sport_id = p_sport_id and l.is_deleted is not true
                and not public.has_branch_access(l.branch_id))
      );
$$;


ALTER FUNCTION "public"."sport_writable"("p_sport_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."staff_management_error"("p_target_id" "uuid", "p_new_role_id" bigint, "p_new_branch_ids" "uuid"[]) RETURNS "text"
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_uid         uuid    := auth.uid();
  v_school_id   uuid    := public.get_user_school_id();
  v_caller_role bigint  := public.get_user_role();
  v_caller_wide boolean := public.current_user_is_school_wide();
  v_target_role bigint;
  v_role        bigint;
  v_current     uuid[]  := '{}'::uuid[];
begin
  if v_uid is null or v_school_id is null or not public.has_permission('users.manage') then
    return 'Bu işlemi gerçekleştirmek için yetkiniz yok.';
  end if;

  if p_target_id is not null then
    select role_id into v_target_role
      from public.profiles
     where id = p_target_id
       and school_id = v_school_id
       and is_deleted is not true;

    -- Veliler kendi akışlarından yönetilir; başka okulun hesabı "yok"tur.
    if v_target_role is null or v_target_role = 8 then
      return 'Kullanıcı bulunamadı veya yetkiniz yok.';
    end if;

    v_current := public.profile_branch_ids(p_target_id);
  end if;

  v_role := coalesce(p_new_role_id, v_target_role);

  -- Atanabilir rol: matriste satırı olan personel rolü.
  if v_role is distinct from v_target_role
     and (v_role is null or not exists (
       select 1 from public.role_permissions rp where rp.role_id = v_role)) then
    return 'Seçilen rol atanamaz.';
  end if;

  -- Kendi hesabı: yalnızca kişisel bilgiler.
  if p_target_id = v_uid then
    if v_role is distinct from v_target_role then
      return 'Kendi rolünüzü değiştiremezsiniz.';
    end if;
    if p_new_branch_ids is not null
       and not public.is_school_wide_role(v_role)
       and not (p_new_branch_ids @> v_current and v_current @> p_new_branch_ids) then
      return 'Kendi şubelerinizi değiştiremezsiniz.';
    end if;
    return null;
  end if;

  -- Hiyerarşi: genel müdür dışındakiler yalnızca kendinden aşağıdakini
  -- yönetir ve atar.
  if v_caller_role is distinct from 9 then
    if p_target_id is not null
       and public.role_rank(v_target_role) >= public.role_rank(v_caller_role) then
      return 'Bu kullanıcıyı yönetme yetkiniz yok.';
    end if;
    if public.role_rank(v_role) >= public.role_rank(v_caller_role) then
      return 'Bu rolü atama yetkiniz yok.';
    end if;
  end if;

  -- Sahip olmadığın yetkiye sahip hesabı yönetemez, öyle bir rol atayamazsın.
  if p_target_id is not null and exists (
    select 1
      from unnest(public.profile_permission_list(p_target_id)) as t(permission)
     where not public.has_permission(t.permission)
  ) then
    return 'Sizde olmayan bir yetkiye sahip kullanıcıyı yönetemezsiniz.';
  end if;

  if exists (
    select 1
      from public.role_permissions rp
     where rp.role_id = v_role
       and not rp.is_optional
       and not public.has_permission(rp.permission)
  ) then
    return 'Sizde olmayan yetkileri içeren bir rol atanamaz.';
  end if;

  -- Şube kapsamı.
  if not v_caller_wide then
    if exists (select 1 from unnest(v_current) as c(branch_id)
                where not public.has_branch_access(c.branch_id)) then
      return 'Bu kullanıcı yetkiniz olmayan bir şubede çalışıyor.';
    end if;

    if p_new_branch_ids is not null and exists (
      select 1 from unnest(p_new_branch_ids) as b(branch_id)
       where b.branch_id is null or not public.has_branch_access(b.branch_id)
    ) then
      return 'Seçilen şubelerden birine erişiminiz yok.';
    end if;

    if not public.is_school_wide_role(v_role)
       and (p_target_id is null or p_new_branch_ids is not null)
       and coalesce(cardinality(p_new_branch_ids), 0) = 0 then
      return 'En az bir şube seçilmelidir.';
    end if;
  end if;

  return null;
end;
$$;


ALTER FUNCTION "public"."staff_management_error"("p_target_id" "uuid", "p_new_role_id" bigint, "p_new_branch_ids" "uuid"[]) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."submit_attendances"("p_class_id" "uuid", "p_attendance_date" "date", "p_items" "jsonb") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_school_id uuid;
  v_branch_id uuid;
  v_actor_id  uuid := auth.uid();
  v_data      jsonb;
begin
  if public.get_user_role() is null
     or not public.has_permission('attendance.take') then
    return public.app_err('Yoklama almak için yetkiniz yok.', 'forbidden');
  end if;

  v_school_id := public.get_user_school_id();
  if v_school_id is null then
    return public.app_err('Kullanıcının bağlı olduğu okul bulunamadı.', 'forbidden');
  end if;

  -- `is_class_visible` çağırandan bağımsızdır (sınıf, şubesi ve branşı canlı
  -- mı); çağıranın kapsamı `has_branch_access`.
  select t.branch_id into v_branch_id
    from public.classes t
   where t.id = p_class_id
     and t.school_id = v_school_id
     and t.is_deleted is not true
     and public.is_class_visible(t.id)
     and public.has_branch_access(t.branch_id);

  if not found then
    return public.app_err(
      'Sınıf bulunamadı veya bu sınıf üzerinde işlem yetkiniz yok.', 'not_found');
  end if;

  if p_attendance_date is null then
    return public.app_err('Yoklama tarihi geçersiz.', 'validation');
  end if;

  if p_items is null or jsonb_typeof(p_items) <> 'array' then
    return public.app_err('Yoklama listesi geçersiz.', 'validation');
  end if;

  if jsonb_array_length(p_items) = 0 then
    return public.app_err('Kaydedilecek sporcu bulunamadı.', 'not_found');
  end if;

  if jsonb_array_length(p_items) > 500 then
    return public.app_err('Bir yoklamada en fazla 500 sporcu olabilir.', 'validation');
  end if;

  -- Aynı sınıf + gün için karar ve yazma tek seferde yapılsın.
  perform pg_advisory_xact_lock(
    hashtextextended('attendance:' || p_class_id || ':' || p_attendance_date, 0));

  -- Tek deyim: bütün CTE'ler yazmadan önceki anlık görüntüyü görür, yani
  -- çakışma kararı ile dönen "sunucudaki değer" aynı satırdan okunur.
  with input as (
    -- Aynı sporcu iki kez gelirse sonuncusu geçerlidir; `on conflict do
    -- update` aynı satıra bir deyimde iki kez dokunamaz.
    select distinct on (athlete_id) athlete_id, status, note, base
      from (
        select (i.item->>'athlete_id')::uuid as athlete_id,
               coalesce(nullif(i.item->>'status', '')::public.attendance_status,
                        'present') as status,
               nullif(btrim(i.item->>'note'), '') as note,
               nullif(i.item->>'base_updated_at', '')::timestamptz as base,
               i.ord
          from jsonb_array_elements(p_items) with ordinality as i(item, ord)
      ) s
     order by athlete_id, ord desc
  ), current_rows as (
    select i.*,
           -- Sporcu çağıranın şubelerinden birinde olmalı: yoklama satırı
           -- velisine bildirim olarak gider.
           exists (
             select 1 from public.athletes a
              where a.id = i.athlete_id
                and a.school_id = v_school_id
                and a.is_deleted is not true
                and public.has_branch_access(a.branch_id)) as is_valid,
           x.id is not null               as row_exists,
           x.status                       as cur_status,
           x.note                         as cur_note,
           x.updated_at                   as cur_updated,
           coalesce(x.is_deleted, false)  as cur_deleted
      from input i
      left join public.attendances x
        on x.class_id = p_class_id
       and x.athlete_id = i.athlete_id
       and x.attendance_date = p_attendance_date
  ), compared as (
    select c.*,
           -- Aynı değer zaten yazılı: yeniden deneme ya da aynı karar.
           -- Satır yeniden yazılmaz; "yoklamayı alan" ve updated_at korunur.
           coalesce(c.row_exists
                    and not c.cur_deleted
                    and c.cur_status = c.status
                    and c.cur_note is not distinct from c.note, false) as is_same
      from current_rows c
  ), decided as (
    select c.*,
           case
             when not c.row_exists or c.is_same then false
             when c.base is null then not c.cur_deleted
             else c.cur_updated > c.base
           end as is_conflict
      from compared c
  ), written as (
    insert into public.attendances (
      school_id, branch_id, class_id, athlete_id,
      attendance_date, status, note, coach_id, created_by, is_deleted
    )
    select v_school_id, v_branch_id, p_class_id, d.athlete_id,
           p_attendance_date, d.status, d.note,
           v_actor_id, v_actor_id, false
      from decided d
     where d.is_valid and not d.is_conflict and not d.is_same
    on conflict (class_id, athlete_id, attendance_date) do update
      set status     = excluded.status,
          note       = excluded.note,
          coach_id   = excluded.coach_id,
          created_by = excluded.created_by,
          is_deleted = false
    -- updated_at'i attendances_set_updated_at trigger'ı yazar.
    returning athlete_id, updated_at
  )
  select jsonb_build_object(
           -- Değişmeyen satırlar da "kaydedildi" sayılır, mevcut sürümüyle.
           'saved', coalesce((
             select jsonb_agg(jsonb_build_object(
                      'athlete_id', x.athlete_id, 'updated_at', x.updated_at))
               from (
                 select w.athlete_id, w.updated_at from written w
                 union all
                 select d.athlete_id, d.cur_updated from decided d
                  where d.is_valid and d.is_same
               ) x), '[]'::jsonb),
           'conflicts', coalesce((
             select jsonb_agg(jsonb_build_object(
                      'athlete_id', d.athlete_id,
                      'status',     d.cur_status,
                      'note',       d.cur_note,
                      'updated_at', d.cur_updated,
                      'is_deleted', d.cur_deleted))
               from decided d
              where d.is_valid and d.is_conflict), '[]'::jsonb),
           'rejected', coalesce((
             select jsonb_agg(d.athlete_id)
               from decided d
              where not d.is_valid), '[]'::jsonb))
    into v_data;

  return public.app_ok(null, v_data);
exception
  when others then
    return public.app_err(sqlerrm, public.app_sqlstate_code(sqlstate));
end;
$$;


ALTER FUNCTION "public"."submit_attendances"("p_class_id" "uuid", "p_attendance_date" "date", "p_items" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."submit_site_lead"("p_kind" "text", "p_full_name" "text", "p_phone" "text", "p_email" "text", "p_school_name" "text", "p_city" "text", "p_athlete_count" "text", "p_message" "text", "p_source_page" "text", "p_utm_source" "text", "p_utm_medium" "text", "p_utm_campaign" "text", "p_ip_hash" "text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_recent integer;
  v_id     uuid;
begin
  -- Aynı IP'den ya da aynı telefondan eşzamanlı istekler sayımın arasından
  -- geçmesin: anahtar başına sıraya girer, işlem bitince kilit kalkar.
  perform pg_advisory_xact_lock(hashtext('site_lead:' || p_phone));
  if p_ip_hash is not null then
    perform pg_advisory_xact_lock(hashtext('site_lead_ip:' || p_ip_hash));
  end if;

  -- Çift gönderim: aynı kişi aynı formu iki kez gönderdi. Hata değil.
  select id into v_id
    from public.site_leads
   where phone = p_phone
     and kind = p_kind
     and created_at > now() - interval '10 minutes'
   order by created_at desc
   limit 1;
  if v_id is not null then
    return public.app_ok(null, jsonb_build_object('id', v_id, 'duplicate', true));
  end if;

  if p_ip_hash is not null then
    select count(*) into v_recent
      from public.site_leads
     where ip_hash = p_ip_hash
       and created_at > now() - interval '1 hour';
    if v_recent >= 5 then
      return public.app_err('Kısa sürede çok fazla talep gönderildi. Lütfen daha sonra tekrar deneyin.', 'conflict');
    end if;
  end if;

  select count(*) into v_recent
    from public.site_leads
   where phone = p_phone
     and created_at > now() - interval '24 hours';
  if v_recent >= 3 then
    return public.app_err('Bu numaradan bugün yeterince talep aldık; size en kısa sürede dönüş yapacağız.', 'conflict');
  end if;

  insert into public.site_leads (
    kind, full_name, phone, email, school_name, city, athlete_count, message,
    source_page, utm_source, utm_medium, utm_campaign, ip_hash
  ) values (
    p_kind, p_full_name, p_phone, p_email, p_school_name, p_city, p_athlete_count, p_message,
    p_source_page, p_utm_source, p_utm_medium, p_utm_campaign, p_ip_hash
  )
  returning id into v_id;

  return public.app_ok(null, jsonb_build_object('id', v_id, 'duplicate', false));
exception
  -- CHECK kısıtına takılan değer: Edge Function doğrulamasının kaçırdığı bir
  -- şey. İstemciye ayrıntı değil, düzeltebileceği bir cümle.
  when check_violation then
    return public.app_err('Form bilgileri geçersiz. Lütfen alanları kontrol edin.', 'validation');
  when others then
    return public.app_err(sqlerrm, public.app_sqlstate_code(sqlstate));
end;
$$;


ALTER FUNCTION "public"."submit_site_lead"("p_kind" "text", "p_full_name" "text", "p_phone" "text", "p_email" "text", "p_school_name" "text", "p_city" "text", "p_athlete_count" "text", "p_message" "text", "p_source_page" "text", "p_utm_source" "text", "p_utm_medium" "text", "p_utm_campaign" "text", "p_ip_hash" "text") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."submit_site_lead"("p_kind" "text", "p_full_name" "text", "p_phone" "text", "p_email" "text", "p_school_name" "text", "p_city" "text", "p_athlete_count" "text", "p_message" "text", "p_source_page" "text", "p_utm_source" "text", "p_utm_medium" "text", "p_utm_campaign" "text", "p_ip_hash" "text") IS 'Tanıtım sitesi talebi. anon''a KAPALI: yalnızca site-lead Edge Function''ı service_role ile çağırır. IP (1 saatte 5) ve telefon (24 saatte 3) sınırı, 10 dakikalık çift gönderim koruması bu gövdededir.';


CREATE OR REPLACE FUNCTION "public"."sweep_push_queue"() RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
  if exists (select 1 from public.notifications
              where push_status in ('pending', 'sending')) then
    perform public.request_push_dispatch();
  end if;
end;
$$;


ALTER FUNCTION "public"."sweep_push_queue"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."sync_athlete_to_customer"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        INSERT INTO customers (
            display_name,
            type,
            athlete_id,
            phone,
            address,
            school_id,
            is_deleted
        ) VALUES (
            NEW.full_name,
            'athlete',
            NEW.id,
            COALESCE(NEW.phone_number, ''),
            NEW.address,
            NEW.school_id,
            COALESCE(NEW.is_deleted, false)
        );

    ELSIF TG_OP = 'UPDATE' THEN
        UPDATE customers 
        SET display_name = NEW.full_name,
            phone = COALESCE(NEW.phone_number, phone),
            address = NEW.address,
            school_id = NEW.school_id,
            is_deleted = COALESCE(NEW.is_deleted, false)
        WHERE athlete_id = NEW.id;
    END IF;

    RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."sync_athlete_to_customer"() OWNER TO "postgres";


COMMENT ON FUNCTION "public"."sync_athlete_to_customer"() IS 'trg_sync_athlete_to_customer trigger fonksiyonu. İstemciye kapalı: trigger''lar tablo sahibinin yetkisiyle çalışır, EXECUTE grant''ına ihtiyaç duymaz.';


CREATE OR REPLACE FUNCTION "public"."sync_class_coaches"("p_class_id" "uuid", "p_coach_ids" "uuid"[]) RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_school_id uuid;
  v_branch_id uuid;
  v_error     text;
begin
  if not public.has_permission('registration.manage') then
    return public.app_err('Bu işlemi gerçekleştirmek için yetkiniz yok.', 'forbidden');
  end if;

  v_school_id := public.get_user_school_id();

  select branch_id into v_branch_id
    from public.classes
   where id = p_class_id and school_id = v_school_id and is_deleted is not true;

  if v_branch_id is null or not public.has_branch_access(v_branch_id) then
    return public.app_err('Sınıf bulunamadı.', 'not_found');
  end if;

  v_error := public.class_coaches_error(p_coach_ids, v_branch_id);
  if v_error is not null then
    return public.app_err(v_error, 'validation');
  end if;

  -- İstenmeyen eğitmenler: kapat.
  update public.coach_class_links
     set is_deleted = true
   where class_id = p_class_id
     and school_id = v_school_id
     and is_deleted is not true
     and not (profile_id = any(p_coach_ids));

  -- İstenenler: ekle ya da canlandır.
  insert into public.coach_class_links (profile_id, class_id, school_id)
  select distinct c, p_class_id, v_school_id
    from unnest(p_coach_ids) as c
  on conflict (profile_id, class_id) do update
     set is_deleted = false
   where coach_class_links.is_deleted is true;

  return public.app_ok(null, null);
exception when others then
  return public.app_err(sqlerrm, public.app_sqlstate_code(sqlstate));
end;
$$;


ALTER FUNCTION "public"."sync_class_coaches"("p_class_id" "uuid", "p_coach_ids" "uuid"[]) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."sync_class_schedule"("p_class_id" "uuid", "p_schedule" "jsonb") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_school_id uuid;
  v_branch_id uuid;
  v_error     text;
begin
  if not public.has_permission('registration.manage') then
    return public.app_err('Bu işlemi gerçekleştirmek için yetkiniz yok.', 'forbidden');
  end if;

  v_school_id := public.get_user_school_id();

  select branch_id into v_branch_id
    from public.classes
   where id = p_class_id and school_id = v_school_id and is_deleted is not true;

  if v_school_id is null or v_branch_id is null
     or not public.has_branch_access(v_branch_id) then
    return public.app_err('Sınıf bulunamadı.', 'not_found');
  end if;

  v_error := public.class_schedule_error(p_schedule);
  if v_error is not null then
    return public.app_err(v_error, 'validation');
  end if;

  -- İstenmeyen günler: kapat.
  update public.class_schedule_slots s
     set is_deleted = true
   where s.class_id = p_class_id
     and s.is_deleted is not true
     and not exists (
       select 1 from jsonb_array_elements(p_schedule) e
        where (e ->> 'weekday')::smallint = s.weekday
     );

  -- İstenen günler: ekle ya da canlandır. Değişmeyen satıra dokunulmaz,
  -- `updated_at` boşuna ilerlemesin.
  insert into public.class_schedule_slots (class_id, school_id, weekday, start_time)
  select p_class_id, v_school_id,
         (e ->> 'weekday')::smallint,
         (e ->> 'start_time')::time
    from jsonb_array_elements(p_schedule) e
  on conflict (class_id, weekday) do update
     set start_time = excluded.start_time,
         is_deleted = false
   where class_schedule_slots.is_deleted is true
      or class_schedule_slots.start_time is distinct from excluded.start_time;

  return public.app_ok(null, null);
exception when others then
  return public.app_err(sqlerrm, public.app_sqlstate_code(sqlstate));
end;
$$;


ALTER FUNCTION "public"."sync_class_schedule"("p_class_id" "uuid", "p_schedule" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."sync_parent_athlete_links"("p_profile_id" "uuid", "p_athlete_ids" "uuid"[]) RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_school_id  uuid := public.get_user_school_id();
  v_athlete_id uuid;
  v_keep       uuid[];
begin
  if not public.has_permission('registration.manage') then
    return public.app_err('Bu işlemi gerçekleştirmek için yetkiniz yok.', 'forbidden');
  end if;

  if v_school_id is null then
    return public.app_err('Kullanıcının bağlı olduğu okul bulunamadı.', 'forbidden');
  end if;

  if not exists (
    select 1 from public.profiles
     where id = p_profile_id and school_id = v_school_id
       and role_id = 8 and is_deleted is not true
  ) then
    return public.app_err('Veli bulunamadı veya yetkiniz yok.', 'not_found');
  end if;

  -- Başka şubenin velisinin çocuk bağları kapatılamaz.
  if not public.can_manage_parent(p_profile_id) then
    return public.app_err('Bu veli yetkiniz olmayan bir şubede.', 'forbidden');
  end if;

  select coalesce(array_agg(distinct a), '{}'::uuid[]) into v_keep
    from unnest(coalesce(p_athlete_ids, '{}'::uuid[])) as t(a)
   where a is not null;

  if exists (
    select 1 from unnest(v_keep) as k(athlete_id)
     where not exists (
       select 1 from public.athletes a
        where a.id = k.athlete_id and a.school_id = v_school_id
          and a.is_deleted is not true and public.has_branch_access(a.branch_id))
  ) then
    return public.app_err('Geçersiz veya yetkiniz olmayan bir sporcu seçildi.', 'validation');
  end if;

  update public.parent_athlete_links
     set is_deleted = true
   where profile_id = p_profile_id
     and school_id = v_school_id
     and is_deleted is not true
     and not (athlete_id = any (v_keep));

  foreach v_athlete_id in array v_keep loop
    insert into public.parent_athlete_links (profile_id, athlete_id, school_id)
    values (p_profile_id, v_athlete_id, v_school_id)
    on conflict (profile_id, athlete_id) do update set is_deleted = false;
  end loop;

  return public.app_ok('Sporcu eşleştirmeleri güncellendi.');
exception when others then
  return public.app_err(sqlerrm, public.app_sqlstate_code(sqlstate));
end;
$$;


ALTER FUNCTION "public"."sync_parent_athlete_links"("p_profile_id" "uuid", "p_athlete_ids" "uuid"[]) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."sync_profile_branch_links"("p_profile_id" "uuid", "p_branch_ids" "uuid"[]) RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_school_id   uuid := public.get_user_school_id();
  v_target_role bigint;
  v_keep        uuid[];
  v_error       text;
begin
  if v_school_id is null then
    return public.app_err('Kullanıcının bağlı olduğu okul bulunamadı.', 'forbidden');
  end if;

  select role_id into v_target_role
    from public.profiles
   where id = p_profile_id
     and school_id = v_school_id
     and is_deleted is not true;

  if v_target_role is null then
    return public.app_err('Kullanıcı bulunamadı veya yetkiniz yok.', 'not_found');
  end if;

  select coalesce(array_agg(distinct b), '{}'::uuid[]) into v_keep
    from unnest(coalesce(p_branch_ids, '{}'::uuid[])) as t(b)
   where b is not null;

  if exists (
    select 1 from unnest(v_keep) as b(branch_id)
     where not exists (
       select 1 from public.branches br
        where br.id = b.branch_id and br.school_id = v_school_id and br.is_deleted is not true)
  ) then
    return public.app_err('Geçersiz veya yetkiniz olmayan bir şube seçildi.', 'validation');
  end if;

  if v_target_role = 8 then
    if not public.has_permission('registration.manage') then
      return public.app_err('Bu işlemi gerçekleştirmek için yetkiniz yok.', 'forbidden');
    end if;
    if not public.can_manage_parent(p_profile_id)
       or (not public.current_user_is_school_wide()
           and exists (select 1 from unnest(v_keep) as b(branch_id)
                        where not public.has_branch_access(b.branch_id))) then
      return public.app_err('Seçilen şubelerden birine erişiminiz yok.', 'forbidden');
    end if;
    -- Şubesiz veli herkesin kapsamına düşer; okul geneli olmayan hesap
    -- veliyi şubesiz bırakamaz (personel kuralıyla aynı).
    if not public.current_user_is_school_wide() and cardinality(v_keep) = 0 then
      return public.app_err('En az bir şube seçilmelidir.', 'validation');
    end if;
  else
    if public.is_school_wide_role(v_target_role) then
      return public.app_err(
        'Genel müdür tüm şubeleri yönetir; şube yetkileri düzenlenemez.', 'forbidden');
    end if;
    v_error := public.staff_management_error(p_profile_id, null, v_keep);
    if v_error is not null then
      return public.app_err(v_error, 'forbidden');
    end if;
  end if;

  perform public.write_profile_branch_links(p_profile_id, v_school_id, v_keep);

  return public.app_ok('Şube yetkileri güncellendi.');
exception when others then
  return public.app_err(sqlerrm, public.app_sqlstate_code(sqlstate));
end;
$$;


ALTER FUNCTION "public"."sync_profile_branch_links"("p_profile_id" "uuid", "p_branch_ids" "uuid"[]) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."sync_profile_permissions"("p_profile_id" "uuid", "p_permissions" "text"[]) RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_error text;
  v_role  bigint;
begin
  v_error := public.staff_management_error(p_profile_id, null, null);
  if v_error is not null then
    return public.app_err(v_error, 'forbidden');
  end if;

  select role_id into v_role from public.profiles where id = p_profile_id;

  v_error := public.profile_permissions_error(p_profile_id, v_role, p_permissions);
  if v_error is not null then
    return public.app_err(v_error, 'forbidden');
  end if;

  perform public.write_profile_permissions(
    p_profile_id, public.get_user_school_id(), p_permissions);

  return public.app_ok('Yetkiler güncellendi.');
exception when others then
  return public.app_err(sqlerrm, public.app_sqlstate_code(sqlstate));
end;
$$;


ALTER FUNCTION "public"."sync_profile_permissions"("p_profile_id" "uuid", "p_permissions" "text"[]) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."sync_school_users_brand"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
  update auth.users u
     set raw_user_meta_data =
           coalesce(u.raw_user_meta_data, '{}'::jsonb)
           || jsonb_build_object('brand', new.brand)
    from public.profiles p
   where p.school_id = new.id
     and u.id = p.id
     and u.raw_user_meta_data->>'brand' is distinct from new.brand;

  return new;
end;
$$;


ALTER FUNCTION "public"."sync_school_users_brand"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."sync_user_brand_from_profile"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_brand text;
begin
  if new.school_id is null then
    return new;
  end if;

  select s.brand into v_brand from public.schools s where s.id = new.school_id;
  if v_brand is null then
    return new;
  end if;

  update auth.users u
     set raw_user_meta_data =
           coalesce(u.raw_user_meta_data, '{}'::jsonb)
           || jsonb_build_object('brand', v_brand)
   where u.id = new.id
     and u.raw_user_meta_data->>'brand' is distinct from v_brand;

  return new;
end;
$$;


ALTER FUNCTION "public"."sync_user_brand_from_profile"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."unregister_push_token"("p_token" "text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
  if auth.uid() is null then
    return public.app_err('Oturum bulunamadı.', 'forbidden');
  end if;

  delete from public.push_tokens
   where token = p_token
     and profile_id = auth.uid();

  return public.app_ok(null, null);
exception
  when others then
    return public.app_err(sqlerrm, public.app_sqlstate_code(sqlstate));
end;
$$;


ALTER FUNCTION "public"."unregister_push_token"("p_token" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."update_athlete"("p_athlete_id" "uuid", "p_branch_id" "uuid", "p_gender" "public"."gender_type", "p_date_of_birth" "date", "p_approval_status" "public"."approval_status", "p_school_id" "uuid", "p_class_id" "uuid", "p_full_name" "text", "p_parent_ids" "uuid"[], "p_blood_type" "public"."blood_type" DEFAULT NULL::"public"."blood_type", "p_license_number" "text" DEFAULT NULL::"text", "p_height" numeric DEFAULT NULL::numeric, "p_weight" numeric DEFAULT NULL::numeric, "p_photo_url" "text" DEFAULT NULL::"text", "p_address" "text" DEFAULT NULL::"text", "p_registration_date" "date" DEFAULT NULL::"date", "p_contract_end_date" "date" DEFAULT NULL::"date", "p_phone_number" "text" DEFAULT NULL::"text", "p_national_id" "text" DEFAULT NULL::"text", "p_health_problems" "text" DEFAULT NULL::"text", "p_has_health_report" boolean DEFAULT NULL::boolean, "p_health_consent" boolean DEFAULT NULL::boolean) RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_school_id   uuid;
  v_old_branch  uuid;
  v_old_consent timestamp with time zone;
  v_consent_at  timestamp with time zone;
  v_national_id text := public.normalize_national_id(p_national_id);
begin
  if not public.has_permission('registration.manage') then
    return public.app_err('Bu işlemi gerçekleştirmek için yetkiniz yok.', 'forbidden');
  end if;

  v_school_id := get_user_school_id();
  if v_school_id is null then
    return public.app_err('Kullanıcının bağlı olduğu okul bulunamadı.', 'forbidden');
  end if;

  if p_school_id is not null and p_school_id <> v_school_id then
    return public.app_err('Başka bir okulun sporcusu güncellenemez.', 'forbidden');
  end if;

  if v_national_id = 'invalid' then
    return public.app_err('T.C. Kimlik numarası 11 haneli olmalıdır.', 'validation');
  end if;

  select branch_id, health_consent_at into v_old_branch, v_old_consent
    from public.athletes
   where id = p_athlete_id
     and school_id = v_school_id
     and is_deleted is not true;

  if not found or not public.has_branch_access(v_old_branch) then
    return public.app_err('Güncellenecek sporcu bulunamadı veya yetkiniz yok.', 'not_found');
  end if;

  if not public.has_branch_access(p_branch_id) then
    return public.app_err('Geçersiz veya yetkiniz olmayan bir şube seçildi.', 'validation');
  end if;

  if p_class_id is not null and not exists (
    select 1 from public.classes
     where id = p_class_id and branch_id = p_branch_id
       and school_id = v_school_id and is_deleted is not true
  ) then
    return public.app_err('Seçilen sınıf bu şubeye ait değil.', 'validation');
  end if;

  if exists (
    select 1 from unnest(coalesce(p_parent_ids, '{}')) as t(pid)
     where not exists (
       select 1 from public.profiles pr
        where pr.id = t.pid and pr.school_id = v_school_id
          and pr.role_id = 8 and pr.is_deleted is not true
     )
  ) then
    return public.app_err('Geçersiz veya yetkiniz olmayan bir veli seçildi.', 'validation');
  end if;

  v_consent_at := public.resolve_health_consent(p_health_consent, v_old_consent);

  update public.athletes
     set branch_id = p_branch_id,
         gender = p_gender,
         blood_type = p_blood_type,
         license_number = p_license_number,
         height = p_height,
         weight = p_weight,
         address = p_address,
         date_of_birth = p_date_of_birth,
         registration_date = coalesce(p_registration_date, registration_date),
         contract_end_date = p_contract_end_date,
         approval_status = p_approval_status,
         class_id = p_class_id,
         full_name = p_full_name,
         phone_number = p_phone_number,
         national_id = v_national_id,
         health_problems = case when v_consent_at is not null
                                then nullif(btrim(p_health_problems), '') end,
         has_health_report = case when v_consent_at is not null
                                  then p_has_health_report end,
         health_consent_at = v_consent_at
   where id = p_athlete_id
     and school_id = v_school_id
     and is_deleted is not true;

  if not found then
    return public.app_err('Güncellenecek sporcu bulunamadı veya yetkiniz yok.', 'not_found');
  end if;

  update public.parent_athlete_links
     set is_deleted = true
   where athlete_id = p_athlete_id
     and school_id = v_school_id
     and is_deleted is not true
     and (p_parent_ids is null or not (profile_id = any(p_parent_ids)));

  if p_parent_ids is not null and array_length(p_parent_ids, 1) > 0 then
    insert into public.parent_athlete_links (profile_id, athlete_id, school_id)
    select distinct pid, p_athlete_id, v_school_id from unnest(p_parent_ids) as t(pid)
    on conflict (profile_id, athlete_id) do update set is_deleted = false;
  end if;

  return public.app_ok('Sporcu bilgileri ve veli bağlantıları başarıyla güncellendi.');
exception
  when unique_violation then
    return public.app_err('Bu T.C. Kimlik numarasıyla kayıtlı bir sporcu zaten var.', 'conflict');
  when others then
    return public.app_err(sqlerrm, public.app_sqlstate_code(sqlstate));
end;
$$;


ALTER FUNCTION "public"."update_athlete"("p_athlete_id" "uuid", "p_branch_id" "uuid", "p_gender" "public"."gender_type", "p_date_of_birth" "date", "p_approval_status" "public"."approval_status", "p_school_id" "uuid", "p_class_id" "uuid", "p_full_name" "text", "p_parent_ids" "uuid"[], "p_blood_type" "public"."blood_type", "p_license_number" "text", "p_height" numeric, "p_weight" numeric, "p_photo_url" "text", "p_address" "text", "p_registration_date" "date", "p_contract_end_date" "date", "p_phone_number" "text", "p_national_id" "text", "p_health_problems" "text", "p_has_health_report" boolean, "p_health_consent" boolean) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."update_branch"("p_branch_id" "uuid", "p_name" "text", "p_address" "text", "p_email" "text", "p_phone_number" "text", "p_phone_number_2" "text", "p_company_title" "text", "p_billing_address" "text", "p_tax_address" "text", "p_tax_number" "text", "p_trade_registry_number" "text", "p_mersis_number" "text", "p_tax_office_province_code" "text", "p_iban" "text", "p_status" "public"."approval_status") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
  if not public.has_permission('registration.manage') then
    return public.app_err('Bu işlemi gerçekleştirmek için yetkiniz yok.', 'forbidden');
  end if;

  if not public.has_branch_access(p_branch_id) then
    return public.app_err('Şube bulunamadı veya bu kayıt üzerinde işlem yetkiniz yok.', 'not_found');
  end if;

  if nullif(btrim(p_phone_number), '') is null then
    return public.app_err('Şube telefon numarası zorunludur.', 'validation');
  end if;

  -- has_branch_access zaten okul ve silinmişliği denetledi; koşulların
  -- burada tekrarı, iki satır arasında durumu değişen bir şubeye karşı.
  update public.branches
     set name                     = p_name,
         address                  = p_address,
         email                    = nullif(btrim(p_email), ''),
         phone_number             = btrim(p_phone_number),
         phone_number_2           = p_phone_number_2,
         company_title            = p_company_title,
         billing_address          = p_billing_address,
         tax_address              = p_tax_address,
         tax_number               = p_tax_number,
         trade_registry_number    = p_trade_registry_number,
         mersis_number            = p_mersis_number,
         tax_office_province_code = p_tax_office_province_code,
         iban                     = p_iban,
         status                   = p_status
   where id = p_branch_id
     and school_id = get_user_school_id()
     and is_deleted is not true;

  if not found then
    return public.app_err('Şube bulunamadı veya bu kayıt üzerinde işlem yetkiniz yok.', 'not_found');
  end if;

  return public.app_ok('Şube bilgileri başarıyla güncellendi.');

exception when others then
  return public.app_err(sqlerrm, public.app_sqlstate_code(sqlstate));
end;
$$;


ALTER FUNCTION "public"."update_branch"("p_branch_id" "uuid", "p_name" "text", "p_address" "text", "p_email" "text", "p_phone_number" "text", "p_phone_number_2" "text", "p_company_title" "text", "p_billing_address" "text", "p_tax_address" "text", "p_tax_number" "text", "p_trade_registry_number" "text", "p_mersis_number" "text", "p_tax_office_province_code" "text", "p_iban" "text", "p_status" "public"."approval_status") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."update_class"("p_class_id" "uuid", "p_name" "text", "p_branch_id" "uuid", "p_sport_id" "uuid", "p_quota" integer, "p_athlete_ids" "uuid"[], "p_schedule" "jsonb" DEFAULT NULL::"jsonb", "p_coach_ids" "uuid"[] DEFAULT NULL::"uuid"[]) RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_school_id  uuid;
  v_old_branch uuid;
  v_error      text;
  v_removed    text;
  v_sync       jsonb;
begin
  if not public.has_permission('registration.manage') then
    return public.app_err('Bu işlemi gerçekleştirmek için yetkiniz yok.', 'forbidden');
  end if;

  v_school_id := get_user_school_id();
  if v_school_id is null then
    return public.app_err('Bu işlemi gerçekleştirmek için yetkiniz yok.', 'forbidden');
  end if;

  -- Sınıf bugün çağıranın şubesinde olmalı; başka şubeye taşınıyorsa o şube
  -- de çağıranın.
  select branch_id into v_old_branch
    from public.classes
   where id = p_class_id
     and school_id = v_school_id
     and is_deleted is not true;

  if not found or not public.has_branch_access(v_old_branch) then
    return public.app_err('Güncellenecek sınıf bulunamadı veya yetkiniz yok.', 'not_found');
  end if;

  if not public.has_branch_access(p_branch_id) then
    return public.app_err('Geçersiz veya yetkiniz olmayan bir şube seçildi.', 'validation');
  end if;

  if not exists (
    select 1 from public.sports
     where id = p_sport_id and school_id = v_school_id and is_deleted is not true
  ) then
    return public.app_err('Geçersiz veya yetkiniz olmayan bir branş seçildi.', 'validation');
  end if;

  if exists (
    select 1 from unnest(coalesce(p_athlete_ids, '{}')) as t(aid)
     where not exists (
       select 1 from public.athletes a
        where a.id = t.aid and a.school_id = v_school_id and a.is_deleted is not true
          and public.has_branch_access(a.branch_id)
     )
  ) then
    return public.app_err('Geçersiz veya yetkiniz olmayan bir sporcu seçildi.', 'validation');
  end if;

  -- Her sporcunun bir sınıfı vardır (`athletes.class_id` NOT NULL). Listeden
  -- çıkarılan aktif sporcu sınıfsız kalırdı: reddedilir. Pasif sporcular
  -- formda listelenmez, bu yüzden listede olmamaları "çıkar" demek değildir.
  select string_agg(a.full_name, ', ' order by a.full_name)
    into v_removed
    from public.athletes a
   where a.class_id = p_class_id
     and a.school_id = v_school_id
     and a.is_deleted is not true
     and coalesce(a.approval_status, 'active') <> 'passive'
     and not (a.id = any (coalesce(p_athlete_ids, '{}')));

  if v_removed is not null then
    return public.app_err(
      'Sporcu sınıfsız kalamaz: ' || v_removed ||
      '. Sporcuyu çıkarmak için kaydından başka bir sınıf seçin.',
      'validation');
  end if;

  -- Eğitmenler YENİ şubeye göre doğrulanır: sınıf başka şubeye taşınırken
  -- o şubede görevli olmayan eğitmeni götüremez.
  v_error := coalesce(
    public.class_schedule_error(p_schedule),
    public.class_coaches_error(p_coach_ids, p_branch_id)
  );
  if v_error is not null then
    return public.app_err(v_error, 'validation');
  end if;

  update public.classes
     set name      = p_name,
         branch_id = p_branch_id,
         sport_id  = p_sport_id,
         quota     = p_quota
   where id = p_class_id
     and school_id = v_school_id
     and is_deleted is not true;

  if not found then
    return public.app_err('Güncellenecek sınıf bulunamadı veya yetkiniz yok.', 'not_found');
  end if;

  update public.branch_class_links
     set branch_id = p_branch_id
   where class_id = p_class_id
     and school_id = v_school_id;

  -- Listedekiler bu sınıfa (ve şubesine) gelir.
  update public.athletes
     set class_id = p_class_id,
         branch_id = p_branch_id
   where id = any(p_athlete_ids)
     and school_id = v_school_id;

  -- Sınıfta kalan pasif sporcular da sınıfla birlikte taşınır: sporcunun
  -- şubesi sınıfının şubesidir.
  update public.athletes
     set branch_id = p_branch_id
   where class_id = p_class_id
     and school_id = v_school_id
     and branch_id is distinct from p_branch_id;

  v_sync := public.sync_class_schedule(p_class_id, p_schedule);
  if (v_sync ->> 'success')::boolean is not true then
    raise exception '%', v_sync ->> 'message';
  end if;

  v_sync := public.sync_class_coaches(p_class_id, p_coach_ids);
  if (v_sync ->> 'success')::boolean is not true then
    raise exception '%', v_sync ->> 'message';
  end if;

  return public.app_ok('Sınıf bilgileri ve sporcu listesi başarıyla güncellendi.');
exception when others then
  return public.app_err(sqlerrm, public.app_sqlstate_code(sqlstate));
end;
$$;


ALTER FUNCTION "public"."update_class"("p_class_id" "uuid", "p_name" "text", "p_branch_id" "uuid", "p_sport_id" "uuid", "p_quota" integer, "p_athlete_ids" "uuid"[], "p_schedule" "jsonb", "p_coach_ids" "uuid"[]) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."update_customer"("p_id" "uuid", "p_display_name" "text", "p_phone" "text" DEFAULT ''::"text", "p_email" "text" DEFAULT NULL::"text", "p_national_id" "text" DEFAULT NULL::"text", "p_address" "text" DEFAULT NULL::"text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
  if not public.can_manage_accounting() then
    return public.app_err('Bu işlem için yetkiniz yok.', 'forbidden');
  end if;

  update public.customers
     set display_name = p_display_name,
         phone        = coalesce(p_phone, phone),
         email        = p_email,
         national_id  = nullif(p_national_id, ''),
         address      = p_address
   where id = p_id
     and (is_deleted = false or is_deleted is null)
     and school_id = public.get_user_school_id()
     and public.customer_in_scope(id);

  if not found then
    return public.app_err('Güncellenecek müşteri bulunamadı.', 'not_found');
  end if;

  return public.app_ok('Müşteri bilgileri güncellendi.');
exception when others then
  return public.app_err(sqlerrm, public.app_sqlstate_code(sqlstate));
end;
$$;


ALTER FUNCTION "public"."update_customer"("p_id" "uuid", "p_display_name" "text", "p_phone" "text", "p_email" "text", "p_national_id" "text", "p_address" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."update_discount"("p_discount_id" "uuid", "p_name" "text", "p_type" "public"."discount_type", "p_value" numeric, "p_branch_ids" "uuid"[]) RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_school_id uuid := public.get_user_school_id();
  v_branch_id uuid;
begin
  if not public.has_permission('finance.manage') then
    return public.app_err('Bu işlemi gerçekleştirmek için yetkiniz yok.', 'forbidden');
  end if;
  if v_school_id is null then
    return public.app_err('Kullanıcının bağlı olduğu okul bulunamadı.', 'forbidden');
  end if;
  if p_branch_ids is null or cardinality(p_branch_ids) = 0 then
    return public.app_err('En az bir şube seçilmelidir.', 'validation');
  end if;
  if p_value < 0 then
    return public.app_err('İndirim değeri negatif olamaz.', 'validation');
  end if;
  if p_type = 'percentage' and p_value > 100 then
    return public.app_err('Yüzdelik indirim 100''den büyük olamaz.', 'validation');
  end if;
  if not exists (select 1 from public.discounts
                  where id = p_discount_id and school_id = v_school_id and is_deleted is not true) then
    return public.app_err('Güncellenecek indirim bulunamadı veya yetkiniz yok.', 'not_found');
  end if;
  if not public.discount_writable(p_discount_id) then
    return public.app_err('Bu indirim yetkiniz olmayan bir şubede de kullanılıyor; düzenleyemezsiniz.', 'forbidden');
  end if;
  if exists (select 1 from unnest(p_branch_ids) as b(branch_id)
              where b.branch_id is null or not public.has_branch_access(b.branch_id)) then
    return public.app_err('Geçersiz veya yetkiniz olmayan bir şube seçildi.', 'validation');
  end if;

  update public.discounts
     set name = p_name, type = p_type, value = p_value
   where id = p_discount_id;

  update public.branch_discount_links
     set is_deleted = true
   where discount_id = p_discount_id
     and school_id = v_school_id
     and is_deleted is not true
     and not (branch_id = any (p_branch_ids));

  foreach v_branch_id in array p_branch_ids loop
    insert into public.branch_discount_links (discount_id, branch_id, school_id)
    values (p_discount_id, v_branch_id, v_school_id)
    on conflict (branch_id, discount_id) do update set is_deleted = false;
  end loop;

  return public.app_ok('İndirim başarıyla güncellendi.');
exception when others then
  return public.app_err(sqlerrm, public.app_sqlstate_code(sqlstate));
end;
$$;


ALTER FUNCTION "public"."update_discount"("p_discount_id" "uuid", "p_name" "text", "p_type" "public"."discount_type", "p_value" numeric, "p_branch_ids" "uuid"[]) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."update_financial_record"("p_id" "uuid", "p_name" "text", "p_expected_date" "date", "p_net_amount" numeric, "p_income_expense_item_id" "uuid" DEFAULT NULL::"uuid", "p_discount_id" "uuid" DEFAULT NULL::"uuid", "p_description" "text" DEFAULT NULL::"text", "p_reminder_date" "date" DEFAULT NULL::"date", "p_base_amount" numeric DEFAULT 0, "p_discount_amount" numeric DEFAULT 0, "p_tax_rate" integer DEFAULT 0, "p_tax_included" boolean DEFAULT true) RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$begin
  IF not public.can_manage_accounting() THEN
    RETURN public.app_err('Bu işlemi gerçekleştirmek için yetkiniz yok.', 'forbidden');
  END IF;

  if (p_income_expense_item_id is not null and not public.income_expense_item_visible(p_income_expense_item_id))
     or (p_discount_id is not null and not public.discount_visible(p_discount_id)) then
    return public.app_err('Geçersiz veya yetkiniz olmayan bir gelir/gider kalemi ya da indirim seçildi.', 'validation');
  end if;

  update public.financial_records
     set name                   = p_name,
         expected_date          = p_expected_date,
         net_amount             = p_net_amount,
         income_expense_item_id = p_income_expense_item_id,
         discount_id            = p_discount_id,
         description            = p_description,
         reminder_date          = p_reminder_date,
         base_amount            = p_base_amount,
         discount_amount        = p_discount_amount,
         tax_rate               = p_tax_rate,
         tax_included           = p_tax_included
   where id = p_id
     and (is_deleted = false or is_deleted is null)
     and school_id = public.get_user_school_id()
     and public.finance_branch_ok(branch_id);

  if not found then
    return public.app_err('Güncellenecek finansal kayıt bulunamadı.', 'not_found');
  end if;

  perform public.recalculate_financial_record_status(p_id);

  return public.app_ok('Finansal kayıt güncellendi.');
exception when others then
  return public.app_err(sqlerrm, public.app_sqlstate_code(sqlstate));
end;$$;


ALTER FUNCTION "public"."update_financial_record"("p_id" "uuid", "p_name" "text", "p_expected_date" "date", "p_net_amount" numeric, "p_income_expense_item_id" "uuid", "p_discount_id" "uuid", "p_description" "text", "p_reminder_date" "date", "p_base_amount" numeric, "p_discount_amount" numeric, "p_tax_rate" integer, "p_tax_included" boolean) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."update_income_expense_item"("p_item_id" "uuid", "p_name" "text", "p_type" "public"."transaction_type", "p_value" numeric, "p_branch_ids" "uuid"[]) RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_school_id uuid := public.get_user_school_id();
  v_branch_id uuid;
begin
  if not public.has_permission('finance.manage') then
    return public.app_err('Bu işlemi gerçekleştirmek için yetkiniz yok.', 'forbidden');
  end if;
  if v_school_id is null then
    return public.app_err('Kullanıcının bağlı olduğu okul bulunamadı.', 'forbidden');
  end if;
  if p_branch_ids is null or cardinality(p_branch_ids) = 0 then
    return public.app_err('En az bir şube seçilmelidir.', 'validation');
  end if;
  if p_value < 0 then
    return public.app_err('Tutar negatif olamaz.', 'validation');
  end if;
  if not exists (select 1 from public.income_expense_items
                  where id = p_item_id and school_id = v_school_id and is_deleted is not true) then
    return public.app_err('Güncellenecek kalem bulunamadı veya yetkiniz yok.', 'not_found');
  end if;
  if not public.income_expense_item_writable(p_item_id) then
    return public.app_err('Bu kalem yetkiniz olmayan bir şubede de kullanılıyor; düzenleyemezsiniz.', 'forbidden');
  end if;
  if exists (select 1 from unnest(p_branch_ids) as b(branch_id)
              where b.branch_id is null or not public.has_branch_access(b.branch_id)) then
    return public.app_err('Geçersiz veya yetkiniz olmayan bir şube seçildi.', 'validation');
  end if;

  update public.income_expense_items
     set name = p_name, type = p_type, value = p_value
   where id = p_item_id;

  update public.branch_income_expense_item_links
     set is_deleted = true
   where income_expense_item_id = p_item_id
     and school_id = v_school_id
     and is_deleted is not true
     and not (branch_id = any (p_branch_ids));

  foreach v_branch_id in array p_branch_ids loop
    insert into public.branch_income_expense_item_links (school_id, income_expense_item_id, branch_id)
    values (v_school_id, p_item_id, v_branch_id)
    on conflict (branch_id, income_expense_item_id) do update set is_deleted = false;
  end loop;

  return public.app_ok('Gelir/Gider kalemi başarıyla güncellendi.');
exception when others then
  return public.app_err(sqlerrm, public.app_sqlstate_code(sqlstate));
end;
$$;


ALTER FUNCTION "public"."update_income_expense_item"("p_item_id" "uuid", "p_name" "text", "p_type" "public"."transaction_type", "p_value" numeric, "p_branch_ids" "uuid"[]) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."update_pre_registration"("p_id" "uuid", "p_full_name" "text", "p_gender" "text", "p_date_of_birth" "date", "p_branch_id" "uuid", "p_class_id" "uuid", "p_interviewer_name" "text", "p_interview_type" "text", "p_interview_date" "date", "p_parent_full_name" "text", "p_parent_phone" "text", "p_parent_email" "text", "p_national_id" "text" DEFAULT NULL::"text", "p_phone" "text" DEFAULT NULL::"text", "p_address" "text" DEFAULT NULL::"text", "p_height" "text" DEFAULT NULL::"text", "p_weight" "text" DEFAULT NULL::"text", "p_health_problems" "text" DEFAULT NULL::"text", "p_has_health_report" boolean DEFAULT NULL::boolean, "p_has_sports_history" boolean DEFAULT NULL::boolean, "p_parent2_full_name" "text" DEFAULT NULL::"text", "p_parent2_phone" "text" DEFAULT NULL::"text", "p_parent2_email" "text" DEFAULT NULL::"text", "p_contract_possibility" "text" DEFAULT NULL::"text", "p_referral_source" "text" DEFAULT NULL::"text", "p_status" "text" DEFAULT 'not_converted'::"text", "p_health_consent" boolean DEFAULT NULL::boolean) RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_school_id   uuid := public.get_user_school_id();
  v_old_branch  uuid;
  v_status      public.registration_status;
  v_old_consent timestamp with time zone;
  v_consent_at  timestamp with time zone;
  v_national_id text := public.normalize_national_id(p_national_id);
begin
  if not public.has_permission('registration.manage') then
    return public.app_err('Bu işlemi gerçekleştirmek için yetkiniz yok.', 'forbidden');
  end if;

  if v_national_id = 'invalid' then
    return public.app_err('T.C. Kimlik numarası 11 haneli olmalıdır.', 'validation');
  end if;

  select branch_id, status, health_consent_at
    into v_old_branch, v_status, v_old_consent
    from public.pre_registrations
   where id = p_id and school_id = v_school_id and is_deleted is not true
   for update;

  if v_old_branch is null then
    return public.app_err('Ön kayıt bulunamadı.', 'not_found');
  end if;

  if not public.has_branch_access(v_old_branch)
     or not public.has_branch_access(p_branch_id) then
    return public.app_err('Bu şubede işlem yapma yetkiniz yok.', 'forbidden');
  end if;

  if v_status = 'converted' then
    return public.app_err('Bu ön kayıt aktarıldığı için düzenlenemez.', 'conflict');
  end if;

  if not exists (
    select 1 from public.classes
     where id = p_class_id and branch_id = p_branch_id
       and school_id = v_school_id and is_deleted is not true
  ) then
    return public.app_err('Seçilen şube/sınıf bu okula ait değil.', 'validation');
  end if;

  v_consent_at := public.resolve_health_consent(p_health_consent, v_old_consent);

  update public.pre_registrations set
    full_name            = p_full_name,
    gender               = p_gender::gender_type,
    date_of_birth        = p_date_of_birth,
    branch_id            = p_branch_id,
    class_id             = p_class_id,
    interviewer_name     = p_interviewer_name,
    interview_type       = p_interview_type::interview_type,
    interview_date       = p_interview_date,
    national_id          = v_national_id,
    phone                = nullif(p_phone, ''),
    address              = nullif(p_address, ''),
    height               = nullif(p_height, ''),
    weight               = nullif(p_weight, ''),
    health_problems      = case when v_consent_at is not null
                                then nullif(p_health_problems, '') end,
    has_health_report    = case when v_consent_at is not null
                                then p_has_health_report end,
    health_consent_at    = v_consent_at,
    has_sports_history   = p_has_sports_history,
    parent_full_name     = p_parent_full_name,
    parent_phone         = p_parent_phone,
    parent_email         = p_parent_email,
    parent2_full_name    = nullif(p_parent2_full_name, ''),
    parent2_phone        = nullif(p_parent2_phone, ''),
    parent2_email        = nullif(p_parent2_email, ''),
    contract_possibility = nullif(p_contract_possibility, '')::contract_possibility,
    referral_source      = nullif(p_referral_source, '')::referral_source
  where id = p_id and school_id = v_school_id and is_deleted is not true;

  return public.app_ok('Ön kayıt başarıyla güncellendi.');
exception when others then
  return public.app_err(sqlerrm, public.app_sqlstate_code(sqlstate));
end;
$$;


ALTER FUNCTION "public"."update_pre_registration"("p_id" "uuid", "p_full_name" "text", "p_gender" "text", "p_date_of_birth" "date", "p_branch_id" "uuid", "p_class_id" "uuid", "p_interviewer_name" "text", "p_interview_type" "text", "p_interview_date" "date", "p_parent_full_name" "text", "p_parent_phone" "text", "p_parent_email" "text", "p_national_id" "text", "p_phone" "text", "p_address" "text", "p_height" "text", "p_weight" "text", "p_health_problems" "text", "p_has_health_report" boolean, "p_has_sports_history" boolean, "p_parent2_full_name" "text", "p_parent2_phone" "text", "p_parent2_email" "text", "p_contract_possibility" "text", "p_referral_source" "text", "p_status" "text", "p_health_consent" boolean) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."update_school"("p_school_id" "uuid", "p_name" "text", "p_city" "text", "p_district" "text", "p_address" "text", "p_logo_url" "text" DEFAULT NULL::"text", "p_clear_logo" boolean DEFAULT false) RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$begin
  IF not public.has_permission('school.manage') THEN
        RETURN public.app_err('Bu işlemi gerçekleştirmek için yetkiniz yok.', 'forbidden');
    END IF;

  -- Yönetici yalnızca kendi okulunu güncelleyebilir.
  if not exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.school_id = p_school_id
  ) then
    return public.app_err('Bu okulu düzenleme yetkiniz yok.', 'forbidden');
  end if;

  if p_name is null or length(trim(p_name)) = 0 then
    return public.app_err('Okul adı boş olamaz.', 'validation');
  end if;

  update public.schools
  set
    name       = trim(p_name),
    city       = trim(p_city),
    district   = trim(p_district),
    address    = trim(p_address),
    logo_url   = case
                   when p_clear_logo then null
                   when p_logo_url is not null then p_logo_url
                   else logo_url
                 end
  where id = p_school_id
    and coalesce(is_deleted, false) = false;

  if not found then
    return public.app_err('Okul bulunamadı.', 'not_found');
  end if;

  return public.app_ok('Okul başarıyla güncellendi.');
end;$$;


ALTER FUNCTION "public"."update_school"("p_school_id" "uuid", "p_name" "text", "p_city" "text", "p_district" "text", "p_address" "text", "p_logo_url" "text", "p_clear_logo" boolean) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."update_sport"("p_sport_id" "uuid", "p_name" "text", "p_branch_ids" "uuid"[]) RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_school_id uuid;
  v_name      text;
  v_old_name  text;
  v_branch_id uuid;
  v_wide      boolean := public.current_user_is_school_wide();
  v_blocked   text;
begin
  if not public.has_permission('registration.manage') then
    return public.app_err('Bu işlemi gerçekleştirmek için yetkiniz yok.', 'forbidden');
  end if;

  v_school_id := public.get_user_school_id();

  if v_school_id is null then
    return public.app_err('Kullanıcının bağlı olduğu okul bulunamadı.', 'forbidden');
  end if;

  v_name := btrim(coalesce(p_name, ''));

  if v_name = '' then
    return public.app_err('Branş adı boş olamaz.', 'validation');
  end if;

  if p_branch_ids is null or array_length(p_branch_ids, 1) is null then
    return public.app_err('En az bir şube seçilmelidir.', 'validation');
  end if;

  select name into v_old_name
    from public.sports
   where id = p_sport_id
     and school_id = v_school_id
     and is_deleted is not true;

  if not found then
    return public.app_err('Güncellenecek branş bulunamadı veya yetkiniz yok.', 'not_found');
  end if;

  -- Ad bütün şubelerde görünür: yalnızca branşın bütün şubeleri çağıranınsa.
  if v_name is distinct from v_old_name and not public.sport_writable(p_sport_id) then
    return public.app_err(
      'Bu branş yetkiniz olmayan bir şubede de kullanılıyor; adını değiştiremezsiniz.',
      'forbidden');
  end if;

  if exists (
    select 1
      from public.sports
     where school_id = v_school_id
       and lower(name) = lower(v_name)
       and id <> p_sport_id
       and is_deleted is not true
  ) then
    return public.app_err('Bu isimde başka bir branş zaten tanımlı.', 'conflict');
  end if;

  foreach v_branch_id in array p_branch_ids
  loop
    if not public.has_branch_access(v_branch_id) then
      return public.app_err('Geçersiz veya yetkiniz olmayan bir şube seçildi.', 'validation');
    end if;
  end loop;

  -- Kaldırılmak istenen şubelerde bu branşa ait aktif sınıf var mı? Çağıran
  -- yalnızca kendi şubelerinin bağlarını kaldırır: form yalnızca onları
  -- gösterir, diğer şubelerin bağı listede olmadığı için silinmemeli.
  select string_agg(distinct b.name || ' (' || t.name || ')', ', ' order by b.name || ' (' || t.name || ')')
    into v_blocked
    from public.branch_sport_links bsl
    join public.branches b on b.id = bsl.branch_id
    join public.classes    t on t.branch_id = bsl.branch_id
                          and t.sport_id  = bsl.sport_id
                          and t.is_deleted is not true
   where bsl.sport_id = p_sport_id
     and bsl.school_id = v_school_id
     and bsl.is_deleted is not true
     and not (bsl.branch_id = any(p_branch_ids))
     and (v_wide or public.has_branch_access(bsl.branch_id));

  if v_blocked is not null then
    return public.app_err(
      'Bu branş şu şubelerde sınıflarda kullanıldığı için kaldırılamaz: ' || v_blocked ||
      '. Önce ilgili sınıfları silin veya başka bir branşa taşıyın.',
      'conflict'
    );
  end if;

  update public.sports
     set name = v_name
   where id = p_sport_id
     and school_id = v_school_id;

  update public.branch_sport_links
     set is_deleted = true
   where sport_id = p_sport_id
     and school_id = v_school_id
     and is_deleted is not true
     and not (branch_id = any(p_branch_ids))
     and (v_wide or public.has_branch_access(branch_id));

  foreach v_branch_id in array p_branch_ids
  loop
    insert into public.branch_sport_links (branch_id, sport_id, school_id)
    values (v_branch_id, p_sport_id, v_school_id)
    on conflict (branch_id, sport_id) do update
      set is_deleted = false;
  end loop;

  return public.app_ok('Branş bilgileri başarıyla güncellendi.');
exception when others then
  return public.app_err(sqlerrm, public.app_sqlstate_code(sqlstate));
end;
$$;


ALTER FUNCTION "public"."update_sport"("p_sport_id" "uuid", "p_name" "text", "p_branch_ids" "uuid"[]) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."update_transaction"("p_id" "uuid", "p_amount" numeric, "p_method" "public"."payment_method", "p_transaction_date" timestamp with time zone) RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_record_id uuid;
begin
  if not public.can_manage_accounting() then
    return public.app_err('Bu işlemi gerçekleştirmek için yetkiniz yok.', 'forbidden');
  end if;

  update public.transactions
     set amount           = p_amount,
         method           = p_method,
         transaction_date = p_transaction_date
   where id = p_id
     and school_id = public.get_user_school_id()
     and is_deleted is not true
     and public.finance_branch_ok(branch_id)
  returning record_id into v_record_id;

  if not found then
    return public.app_err('Güncellenecek tahsilat kaydı bulunamadı.', 'not_found');
  end if;

  perform public.recalculate_financial_record_status(v_record_id);

  return public.app_ok('Tahsilat güncellendi.');
exception when others then
  return public.app_err(sqlerrm, public.app_sqlstate_code(sqlstate));
end;
$$;


ALTER FUNCTION "public"."update_transaction"("p_id" "uuid", "p_amount" numeric, "p_method" "public"."payment_method", "p_transaction_date" timestamp with time zone) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."write_coach_class_links"("p_coach_id" "uuid", "p_school_id" "uuid", "p_class_ids" "uuid"[]) RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_keep uuid[] := coalesce(p_class_ids, '{}'::uuid[]);
begin
  update public.coach_class_links
     set is_deleted = true
   where profile_id = p_coach_id
     and school_id = p_school_id
     and is_deleted is not true
     and not (class_id = any (v_keep));

  insert into public.coach_class_links (profile_id, class_id, school_id)
  select distinct p_coach_id, c, p_school_id
    from unnest(v_keep) as t(c)
   where c is not null
  on conflict (profile_id, class_id) do update
     set is_deleted = false
   where coach_class_links.is_deleted is true;
end;
$$;


ALTER FUNCTION "public"."write_coach_class_links"("p_coach_id" "uuid", "p_school_id" "uuid", "p_class_ids" "uuid"[]) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."write_profile_branch_links"("p_profile_id" "uuid", "p_school_id" "uuid", "p_branch_ids" "uuid"[]) RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_keep      uuid[] := coalesce(p_branch_ids, '{}'::uuid[]);
  v_branch_id uuid;
begin
  update public.profile_branch_links
     set is_deleted = true
   where profile_id = p_profile_id
     and school_id = p_school_id
     and is_deleted is not true
     and not (branch_id = any (v_keep));

  foreach v_branch_id in array v_keep loop
    insert into public.profile_branch_links (profile_id, branch_id, school_id)
    values (p_profile_id, v_branch_id, p_school_id)
    on conflict (profile_id, branch_id) do update set is_deleted = false;
  end loop;

  update public.coach_class_links l
     set is_deleted = true
    from public.classes c
   where c.id = l.class_id
     and l.profile_id = p_profile_id
     and l.school_id = p_school_id
     and l.is_deleted is not true
     and not (c.branch_id = any (v_keep));
end;
$$;


ALTER FUNCTION "public"."write_profile_branch_links"("p_profile_id" "uuid", "p_school_id" "uuid", "p_branch_ids" "uuid"[]) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."write_profile_permissions"("p_profile_id" "uuid", "p_school_id" "uuid", "p_permissions" "text"[]) RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_requested  text[];
  v_permission text;
begin
  select coalesce(array_agg(distinct x), '{}'::text[]) into v_requested
    from unnest(coalesce(p_permissions, '{}'::text[])) as t(x)
   where x is not null;

  update public.profile_permissions
     set is_deleted = true
   where profile_id = p_profile_id
     and is_deleted is not true
     and not (permission = any (v_requested));

  foreach v_permission in array v_requested loop
    insert into public.profile_permissions as pp (profile_id, school_id, permission, granted_by)
    values (p_profile_id, p_school_id, v_permission, auth.uid())
    on conflict (profile_id, permission) do update
      set is_deleted = false,
          school_id  = excluded.school_id,
          granted_by = case when pp.is_deleted
                            then excluded.granted_by
                            else pp.granted_by end;
  end loop;
end;
$$;


ALTER FUNCTION "public"."write_profile_permissions"("p_profile_id" "uuid", "p_school_id" "uuid", "p_permissions" "text"[]) OWNER TO "postgres";

SET default_tablespace = '';

SET default_table_access_method = "heap";


CREATE TABLE IF NOT EXISTS "public"."app_min_versions" (
    "app" "text" NOT NULL,
    "brand" "text" NOT NULL,
    "platform" "text" NOT NULL,
    "min_build" integer DEFAULT 0 NOT NULL,
    "store_url" "text",
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "app_min_versions_app_check" CHECK (("app" = ANY (ARRAY['management'::"text", 'parent'::"text"]))),
    CONSTRAINT "app_min_versions_brand_check" CHECK (("brand" = ANY (ARRAY['dev_adim'::"text", 'public'::"text"]))),
    CONSTRAINT "app_min_versions_min_build_check" CHECK (("min_build" >= 0)),
    CONSTRAINT "app_min_versions_platform_check" CHECK (("platform" = ANY (ARRAY['android'::"text", 'ios'::"text"]))),
    CONSTRAINT "app_min_versions_store_url_check" CHECK ((("store_url" IS NULL) OR ("store_url" ~ '^(https|itms-apps|market)://'::"text")))
);


ALTER TABLE "public"."app_min_versions" OWNER TO "postgres";


COMMENT ON TABLE "public"."app_min_versions" IS 'Zorunlu güncelleme kapısı: uygulama/marka/platform başına asgari build numarası. Bkz. 20261027_app_min_versions.sql.';


CREATE TABLE IF NOT EXISTS "public"."athlete_consent_events" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "school_id" "uuid" NOT NULL,
    "athlete_id" "uuid" NOT NULL,
    "granted" boolean NOT NULL,
    "consent_at" timestamp with time zone,
    "actor_id" "uuid",
    "actor_role" bigint,
    "source" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "kind" "text" NOT NULL,
    CONSTRAINT "athlete_consent_events_kind_check" CHECK (("kind" = ANY (ARRAY['health'::"text", 'photo'::"text", 'promo_photo'::"text"]))),
    CONSTRAINT "athlete_consent_events_source_check" CHECK (("source" = ANY (ARRAY['parent'::"text", 'online_form'::"text", 'staff'::"text", 'system'::"text"])))
);


ALTER TABLE "public"."athlete_consent_events" OWNER TO "postgres";


COMMENT ON TABLE "public"."athlete_consent_events" IS 'Sporcu rızalarının (sağlık, fotoğraf, tanıtım fotoğrafı) verilme ve kaldırılma geçmişi — KVKK ispatı. Yalnızca athletes_log_consents tetikleyicisi yazar; istemci okuyamaz, yazamaz.';


CREATE TABLE IF NOT EXISTS "public"."athletes" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "branch_id" "uuid" NOT NULL,
    "gender" "public"."gender_type" NOT NULL,
    "blood_type" "public"."blood_type",
    "license_number" "text",
    "height" numeric,
    "weight" numeric,
    "photo_path" "text",
    "address" "text",
    "date_of_birth" "date" NOT NULL,
    "registration_date" "date" DEFAULT CURRENT_DATE,
    "contract_end_date" "date",
    "approval_status" "public"."approval_status" DEFAULT 'passive'::"public"."approval_status" NOT NULL,
    "created_at" timestamp with time zone DEFAULT ("now"() AT TIME ZONE 'utc'::"text"),
    "school_id" "uuid" NOT NULL,
    "class_id" "uuid" NOT NULL,
    "full_name" "text" NOT NULL,
    "phone_number" "text",
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "is_deleted" boolean DEFAULT false,
    "national_id" "text",
    "health_problems" "text",
    "has_health_report" boolean,
    "health_consent_at" timestamp with time zone,
    "photo_consent_at" timestamp with time zone,
    "promo_photo_consent_at" timestamp with time zone,
    CONSTRAINT "athlete_details_height_check" CHECK (("height" > (0)::numeric)),
    CONSTRAINT "athlete_details_weight_check" CHECK (("weight" > (0)::numeric))
);


ALTER TABLE "public"."athletes" OWNER TO "postgres";


COMMENT ON COLUMN "public"."athletes"."photo_path" IS 'athlete-photos bucket''ındaki profil fotoğrafının yolu (<school>/<athlete>/<sürüm>.jpg). Yalnızca set_athlete_photo yazar. Küçük resim aynı adın _thumb ekli hâlidir.';


COMMENT ON COLUMN "public"."athletes"."national_id" IS 'TC kimlik numarası (11 hane). Okul içinde silinmemiş sporcular arasında tekil. Sporcu silinince gece temizlenir.';


COMMENT ON COLUMN "public"."athletes"."health_problems" IS 'Sağlık sorunları (KVKK m.6). Yalnızca health_consent_at doluysa yazılır.';


COMMENT ON COLUMN "public"."athletes"."has_health_report" IS 'Sağlık raporu var mı (KVKK m.6). Yalnızca health_consent_at doluysa yazılır.';


COMMENT ON COLUMN "public"."athletes"."health_consent_at" IS 'Velinin sağlık verisi için açık rızasının anı (KVKK m.6). Yalnızca veli verir: online ön kayıttan taşınır ya da veli uygulamasından yazılır.';


COMMENT ON COLUMN "public"."athletes"."photo_consent_at" IS 'Velinin sporcu fotoğrafının uygulama içinde (yoklama, profil) kullanılmasına açık rızasının anı. Yoksa yeni fotoğraf yüklenemez; geri alınınca fotoğraf kaldırılır.';


COMMENT ON COLUMN "public"."athletes"."promo_photo_consent_at" IS 'Velinin çocuğunun fotoğrafının tanıtımda (sosyal medya, web, broşür) kullanılmasına açık rızasının anı. Personele bilgi olarak gösterilir.';


CREATE TABLE IF NOT EXISTS "public"."attendances" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "school_id" "uuid" NOT NULL,
    "branch_id" "uuid" NOT NULL,
    "class_id" "uuid" NOT NULL,
    "athlete_id" "uuid" NOT NULL,
    "attendance_date" "date" NOT NULL,
    "status" "public"."attendance_status" DEFAULT 'present'::"public"."attendance_status" NOT NULL,
    "note" "text",
    "coach_id" "uuid",
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "is_deleted" boolean DEFAULT false
);


ALTER TABLE "public"."attendances" OWNER TO "postgres";


COMMENT ON TABLE "public"."attendances" IS 'Tarih + takım bazlı sporcu yoklama kayıtları. Ayrı bir seans tablosu yoktur: bir gün/takım için satır varsa yoklama alınmış demektir.';


COMMENT ON COLUMN "public"."attendances"."coach_id" IS 'Yoklamayı alan (son kaydeden) kişi; save_attendances bunu auth.uid()''den yazar.';


COMMENT ON COLUMN "public"."attendances"."is_deleted" IS 'Soft delete bayrağı. Bir günün yoklaması geri alındığında satırlar silinmez, bu alan true yapılır; aynı gün tekrar yoklama alınırsa save_attendances mevcut satırı diriltir.';


CREATE TABLE IF NOT EXISTS "public"."branch_class_links" (
    "id" bigint NOT NULL,
    "branch_id" "uuid" NOT NULL,
    "class_id" "uuid" NOT NULL,
    "school_id" "uuid" NOT NULL,
    "is_deleted" boolean DEFAULT false
);


ALTER TABLE "public"."branch_class_links" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."branch_discount_links" (
    "branch_id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "discount_id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "school_id" "uuid",
    "is_deleted" boolean DEFAULT false
);


ALTER TABLE "public"."branch_discount_links" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."branch_income_expense_item_links" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "branch_id" "uuid" NOT NULL,
    "income_expense_item_id" "uuid",
    "school_id" "uuid",
    "is_deleted" boolean DEFAULT false
);


ALTER TABLE "public"."branch_income_expense_item_links" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."branch_sport_links" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "branch_id" "uuid" NOT NULL,
    "sport_id" "uuid" NOT NULL,
    "school_id" "uuid" NOT NULL,
    "is_deleted" boolean DEFAULT false
);


ALTER TABLE "public"."branch_sport_links" OWNER TO "postgres";


ALTER TABLE "public"."branch_class_links" ALTER COLUMN "id" ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME "public"."branch_team_links_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


CREATE TABLE IF NOT EXISTS "public"."branches" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "school_id" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "address" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "email" "text",
    "phone_number" "text" NOT NULL,
    "phone_number_2" "text",
    "company_title" "text",
    "billing_address" "text",
    "tax_address" "text",
    "tax_number" "text",
    "trade_registry_number" "text",
    "mersis_number" "text",
    "tax_office_province_code" "text",
    "iban" "text",
    "status" "public"."approval_status" NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "is_deleted" boolean DEFAULT false,
    CONSTRAINT "branches_phone_number_not_blank" CHECK (("btrim"("phone_number") <> ''::"text"))
);


ALTER TABLE "public"."branches" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."class_schedule_slots" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "class_id" "uuid" NOT NULL,
    "school_id" "uuid" NOT NULL,
    "weekday" smallint NOT NULL,
    "start_time" time without time zone NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "is_deleted" boolean DEFAULT false,
    CONSTRAINT "class_schedule_slots_start_time_check" CHECK (((EXTRACT(second FROM "start_time") = (0)::numeric) AND ("start_time" < '24:00:00'::time without time zone))),
    CONSTRAINT "class_schedule_slots_weekday_check" CHECK ((("weekday" >= 1) AND ("weekday" <= 7)))
);


ALTER TABLE "public"."class_schedule_slots" OWNER TO "postgres";


COMMENT ON TABLE "public"."class_schedule_slots" IS 'Sınıfın haftalık antrenman programı: gün başına bir başlangıç saati. weekday ISO (1 = Pazartesi). Yazma yalnızca sync_class_schedule üzerinden. Bkz. 20261002_class_training_schedule.sql.';


CREATE TABLE IF NOT EXISTS "public"."classes" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "branch_id" "uuid" NOT NULL,
    "sport_id" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "school_id" "uuid" NOT NULL,
    "quota" smallint,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "is_deleted" boolean DEFAULT false
);


ALTER TABLE "public"."classes" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."coach_class_links" (
    "school_id" "uuid" NOT NULL,
    "profile_id" "uuid" NOT NULL,
    "class_id" "uuid" NOT NULL,
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "is_deleted" boolean DEFAULT false
);


ALTER TABLE "public"."coach_class_links" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."customers" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "display_name" "text" NOT NULL,
    "type" "public"."customer_type" NOT NULL,
    "athlete_id" "uuid",
    "profile_id" "uuid",
    "phone" "text" NOT NULL,
    "email" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "school_id" "uuid",
    "is_deleted" boolean DEFAULT false,
    "national_id" "text",
    "address" "text"
);


ALTER TABLE "public"."customers" OWNER TO "postgres";


COMMENT ON COLUMN "public"."customers"."national_id" IS 'TC kimlik numarası. 11 haneli olduğu için text tutulur; pre_registrations.national_id ile aynı tiptedir.';


CREATE TABLE IF NOT EXISTS "public"."direct_messages" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "school_id" "uuid" NOT NULL,
    "branch_id" "uuid" NOT NULL,
    "athlete_id" "uuid" NOT NULL,
    "sender_id" "uuid" NOT NULL,
    "body" "text" NOT NULL,
    "recipient_count" integer DEFAULT 0 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "is_deleted" boolean DEFAULT false,
    CONSTRAINT "direct_messages_body_length" CHECK ((("length"("btrim"("body")) >= 1) AND ("length"("btrim"("body")) <= 1000)))
);


ALTER TABLE "public"."direct_messages" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."discounts" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "school_id" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "type" "public"."discount_type" NOT NULL,
    "value" numeric NOT NULL,
    "created_at" timestamp with time zone DEFAULT ("now"() AT TIME ZONE 'utc'::"text"),
    "is_deleted" boolean DEFAULT false,
    CONSTRAINT "discounts_value_check" CHECK (("value" > (0)::numeric))
);


ALTER TABLE "public"."discounts" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."financial_records" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "customer_id" "uuid" NOT NULL,
    "income_expense_item_id" "uuid",
    "branch_id" "uuid",
    "type" "public"."accounting_type" NOT NULL,
    "name" "text" NOT NULL,
    "description" "text",
    "invoice_no" "text",
    "expected_date" "date" NOT NULL,
    "reminder_date" "date",
    "base_amount" numeric(10,2) DEFAULT 0.00,
    "discount_amount" numeric(10,2) DEFAULT 0.00,
    "tax_rate" integer DEFAULT 0,
    "tax_included" boolean DEFAULT true,
    "net_amount" numeric(10,2) NOT NULL,
    "status" "public"."payment_status" DEFAULT 'unpaid'::"public"."payment_status",
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "school_id" "uuid",
    "is_deleted" boolean DEFAULT false,
    "discount_id" "uuid"
);


ALTER TABLE "public"."financial_records" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."income_expense_items" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "school_id" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "value" numeric NOT NULL,
    "type" "public"."transaction_type" NOT NULL,
    "is_deleted" boolean DEFAULT false,
    "created_at" timestamp with time zone DEFAULT ("now"() AT TIME ZONE 'utc'::"text"),
    CONSTRAINT "products_value_check" CHECK (("value" >= (0)::numeric))
);


ALTER TABLE "public"."income_expense_items" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."notification_announcements" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "school_id" "uuid" NOT NULL,
    "sender_id" "uuid" NOT NULL,
    "title" "text" NOT NULL,
    "body" "text" NOT NULL,
    "role_ids" bigint[] DEFAULT '{}'::bigint[] NOT NULL,
    "branch_ids" "uuid"[] DEFAULT '{}'::"uuid"[] NOT NULL,
    "recipient_count" integer DEFAULT 0 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "is_deleted" boolean DEFAULT false
);


ALTER TABLE "public"."notification_announcements" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."notification_preferences" (
    "profile_id" "uuid" NOT NULL,
    "type" "text" NOT NULL,
    "push_enabled" boolean NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."notification_preferences" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."notifications" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "school_id" "uuid" NOT NULL,
    "recipient_id" "uuid" NOT NULL,
    "type" "text" NOT NULL,
    "params" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "announcement_id" "uuid",
    "dedupe_key" "text",
    "read_at" timestamp with time zone,
    "push_status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "push_attempts" smallint DEFAULT 0 NOT NULL,
    "push_claimed_at" timestamp with time zone,
    "pushed_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "is_deleted" boolean DEFAULT false,
    "direct_message_id" "uuid",
    CONSTRAINT "notifications_push_status_check" CHECK (("push_status" = ANY (ARRAY['pending'::"text", 'sending'::"text", 'sent'::"text", 'skipped'::"text", 'failed'::"text"]))),
    CONSTRAINT "notifications_type_check" CHECK (("type" = ANY (ARRAY['attendance_reminder'::"text", 'attendance_missing_summary'::"text", 'pre_registration_received'::"text", 'registrations_expiring'::"text", 'payments_due'::"text", 'birthdays_today'::"text", 'birthdays_upcoming'::"text", 'child_birthday_upcoming'::"text", 'announcement'::"text", 'direct_message'::"text", 'attendance_result'::"text", 'payment_upcoming'::"text", 'payment_overdue'::"text"])))
);


ALTER TABLE "public"."notifications" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."parent_athlete_links" (
    "profile_id" "uuid" NOT NULL,
    "athlete_id" "uuid" NOT NULL,
    "school_id" "uuid" NOT NULL,
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "is_deleted" boolean DEFAULT false
);


ALTER TABLE "public"."parent_athlete_links" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."pre_registration_attempts" (
    "id" bigint NOT NULL,
    "ip_hash" "text" NOT NULL,
    "school_id" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."pre_registration_attempts" OWNER TO "postgres";


COMMENT ON TABLE "public"."pre_registration_attempts" IS 'Online ön kayıt denemelerinin IP bazlı sayımı. ip_hash ham IP değil, tuzlanmış SHA-256 özetidir; kayıtlar 24 saat sonra silinir. RLS açık ve POLİTİKA YOK — kasıtlı: hiçbir istemci erişmemeli, yalnızca submit-pre-registration Edge Function''ı service_role ile yazar.';


CREATE SEQUENCE IF NOT EXISTS "public"."pre_registration_attempts_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."pre_registration_attempts_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."pre_registration_attempts_id_seq" OWNED BY "public"."pre_registration_attempts"."id";


CREATE TABLE IF NOT EXISTS "public"."pre_registration_links" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "token" "text" NOT NULL,
    "school_id" "uuid" NOT NULL,
    "is_active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_by" "uuid",
    "is_deleted" boolean DEFAULT false NOT NULL
);


ALTER TABLE "public"."pre_registration_links" OWNER TO "postgres";


COMMENT ON TABLE "public"."pre_registration_links" IS 'Online ön kayıt formunun iptal edilebilir genel bağlantıları. Token bir yetki taşımaz, yalnızca okulu (ve varsa şubeyi) çözer.';


CREATE TABLE IF NOT EXISTS "public"."pre_registrations" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "school_id" "uuid" NOT NULL,
    "full_name" "text" NOT NULL,
    "gender" "public"."gender_type" NOT NULL,
    "date_of_birth" "date" NOT NULL,
    "phone" "text",
    "class_id" "uuid" NOT NULL,
    "address" "text",
    "health_problems" "text",
    "has_health_report" boolean DEFAULT false,
    "has_sports_history" boolean DEFAULT false,
    "interviewer_name" "text" NOT NULL,
    "interview_type" "public"."interview_type" DEFAULT 'face_to_face'::"public"."interview_type" NOT NULL,
    "referral_source" "public"."referral_source",
    "created_at" timestamp with time zone DEFAULT ("now"() AT TIME ZONE 'utc'::"text"),
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "branch_id" "uuid" NOT NULL,
    "interview_date" "date" NOT NULL,
    "national_id" "text",
    "contract_possibility" "public"."contract_possibility",
    "parent_full_name" "text" NOT NULL,
    "parent_phone" "text" NOT NULL,
    "parent_email" "text" NOT NULL,
    "parent2_full_name" "text",
    "parent2_phone" "text",
    "parent2_email" "text",
    "height" "text",
    "weight" "text",
    "is_deleted" boolean DEFAULT false,
    "status" "public"."registration_status" DEFAULT 'not_converted'::"public"."registration_status" NOT NULL,
    "kvkk_approved_at" timestamp with time zone,
    "health_consent_at" timestamp with time zone,
    "photo_consent_at" timestamp with time zone,
    "promo_photo_consent_at" timestamp with time zone
);


ALTER TABLE "public"."pre_registrations" OWNER TO "postgres";


COMMENT ON COLUMN "public"."pre_registrations"."kvkk_approved_at" IS 'Velinin KVKK aydınlatma metnini okuduğunu onayladığı an (online form). Açık rıza DEĞİLDİR.';


COMMENT ON COLUMN "public"."pre_registrations"."health_consent_at" IS 'Velinin online formda sağlık verisinin işlenmesine açık rıza verdiği an (KVKK m.6). Online formdan gelen kayıtta NULL ise sağlık alanları da NULL''dır. Personelin elle açtığı kayıtlarda rızayı okul ayrıca alır.';


COMMENT ON COLUMN "public"."pre_registrations"."photo_consent_at" IS 'Velinin online formda fotoğraf (uygulama içi) rızası. Aktarımda sporcu kartına taşınır, ön kayıtla birlikte silinir.';


COMMENT ON COLUMN "public"."pre_registrations"."promo_photo_consent_at" IS 'Velinin online formda tanıtım fotoğrafı rızası. Aktarımda sporcu kartına taşınır, ön kayıtla birlikte silinir.';


CREATE TABLE IF NOT EXISTS "public"."profile_branch_links" (
    "branch_id" "uuid" DEFAULT "gen_random_uuid"(),
    "profile_id" "uuid" DEFAULT "gen_random_uuid"(),
    "school_id" "uuid" NOT NULL,
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "is_deleted" boolean DEFAULT false
);


ALTER TABLE "public"."profile_branch_links" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."profile_permissions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "profile_id" "uuid" NOT NULL,
    "school_id" "uuid" NOT NULL,
    "permission" "text" NOT NULL,
    "is_deleted" boolean DEFAULT false NOT NULL,
    "granted_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."profile_permissions" OWNER TO "postgres";


COMMENT ON TABLE "public"."profile_permissions" IS 'Hesaba verilmiş opsiyonel yetkiler. Yalnızca sync_profile_permissions yazar; satır silinmez, is_deleted ile kapatılır.';


CREATE TABLE IF NOT EXISTS "public"."profiles" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "school_id" "uuid",
    "full_name" "text" NOT NULL,
    "email" "text" NOT NULL,
    "phone_number" "text",
    "created_at" timestamp with time zone DEFAULT ("now"() AT TIME ZONE 'utc'::"text"),
    "status" "public"."approval_status" DEFAULT 'active'::"public"."approval_status" NOT NULL,
    "role_id" bigint NOT NULL,
    "birth_of_date" "date",
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "is_deleted" boolean DEFAULT false,
    "privacy_notice_version" "text",
    "privacy_notice_ack_at" timestamp with time zone,
    "account_deleted_at" timestamp with time zone
);


ALTER TABLE "public"."profiles" OWNER TO "postgres";


COMMENT ON COLUMN "public"."profiles"."privacy_notice_version" IS 'Kullanıcının okuduğunu onayladığı gizlilik politikası / aydınlatma metni sürümü. Açık rıza DEĞİLDİR. Yalnızca acknowledge_privacy_notice ve handle_new_user yazar.';


COMMENT ON COLUMN "public"."profiles"."privacy_notice_ack_at" IS 'privacy_notice_version onayının sunucu saatine göre anı.';


COMMENT ON COLUMN "public"."profiles"."account_deleted_at" IS 'Kullanıcının hesabını kendisinin sildiği an (delete_own_account). Dolu ise profil anonimleştirilmiştir; KVKK başvurusunun yerine getirildiğinin kaydı.';


CREATE TABLE IF NOT EXISTS "public"."push_tokens" (
    "token" "text" NOT NULL,
    "profile_id" "uuid" NOT NULL,
    "app" "text" NOT NULL,
    "platform" "text" NOT NULL,
    "locale" "text" DEFAULT 'tr'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "last_seen_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "push_tokens_app_check" CHECK (("app" = ANY (ARRAY['dev_adim'::"text", 'public'::"text", 'parent'::"text"]))),
    CONSTRAINT "push_tokens_locale_check" CHECK (("locale" = ANY (ARRAY['tr'::"text", 'en'::"text"]))),
    CONSTRAINT "push_tokens_platform_check" CHECK (("platform" = ANY (ARRAY['android'::"text", 'ios'::"text", 'web'::"text", 'macos'::"text"])))
);


ALTER TABLE "public"."push_tokens" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."role_permissions" (
    "role_id" bigint NOT NULL,
    "permission" "text" NOT NULL,
    "is_optional" boolean DEFAULT false NOT NULL,
    CONSTRAINT "role_permissions_permission_format" CHECK (("permission" ~ '^[a-z]+\.[a-z]+$'::"text"))
);


ALTER TABLE "public"."role_permissions" OWNER TO "postgres";


COMMENT ON TABLE "public"."role_permissions" IS 'Rolün yetkileri: sabit (rolün her hesabında) ya da opsiyonel (hesabı açan kişi verir, profile_permissions). Bkz. 20261011_role_permissions.sql.';


CREATE TABLE IF NOT EXISTS "public"."roles" (
    "id" bigint NOT NULL,
    "name" "text"
);


ALTER TABLE "public"."roles" OWNER TO "postgres";


ALTER TABLE "public"."roles" ALTER COLUMN "id" ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME "public"."roles_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


CREATE TABLE IF NOT EXISTS "public"."schools" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "subscription_status" "public"."subscription_status_type" DEFAULT 'trial'::"public"."subscription_status_type" NOT NULL,
    "owner_id" "uuid",
    "trial_starts_at" timestamp with time zone NOT NULL,
    "trial_ends_at" timestamp with time zone NOT NULL,
    "subscription_ends_at" timestamp with time zone,
    "city" "text" NOT NULL,
    "district" "text" NOT NULL,
    "address" "text" NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "is_deleted" boolean DEFAULT false,
    "logo_url" "text",
    "is_self_service" boolean DEFAULT true NOT NULL,
    "brand" "text" DEFAULT 'public'::"text" NOT NULL,
    CONSTRAINT "schools_brand_check" CHECK (("brand" = ANY (ARRAY['dev_adim'::"text", 'public'::"text"])))
);


ALTER TABLE "public"."schools" OWNER TO "postgres";


COMMENT ON COLUMN "public"."schools"."is_self_service" IS 'Okul kendi kaydını kapatabilir ve abonelik bilgisini görür. Sözleşmesi uygulama dışında yürüyen kurulumlarda (Dev Adım) false. delete_school bunu kontrol eder; arayüzdeki gizleme yalnızca bunun yansımasıdır.';


COMMENT ON COLUMN "public"."schools"."brand" IS 'Okulun hizmet aldığı marka: dev_adim (Dev Adım) ya da public (Mobil Spor Okulu). Davet ve ön kayıt bağlantılarının alan adını ve auth e-postalarının markasını belirler. Yalnızca service_role / SQL editörü değiştirebilir.';


CREATE TABLE IF NOT EXISTS "public"."site_leads" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "kind" "text" NOT NULL,
    "full_name" "text" NOT NULL,
    "phone" "text" NOT NULL,
    "email" "text",
    "school_name" "text",
    "city" "text",
    "athlete_count" "text",
    "message" "text",
    "source_page" "text",
    "utm_source" "text",
    "utm_medium" "text",
    "utm_campaign" "text",
    "ip_hash" "text",
    "status" "text" DEFAULT 'new'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "site_leads_athlete_count_check" CHECK ((("athlete_count" IS NULL) OR ("athlete_count" = ANY (ARRAY['1-50'::"text", '51-150'::"text", '151-300'::"text", '300+'::"text"])))),
    CONSTRAINT "site_leads_city_check" CHECK ((("city" IS NULL) OR (("char_length"("city") >= 1) AND ("char_length"("city") <= 60)))),
    CONSTRAINT "site_leads_contact_fields" CHECK ((("kind" <> 'contact'::"text") OR ("message" IS NOT NULL))),
    CONSTRAINT "site_leads_demo_fields" CHECK ((("kind" <> 'demo'::"text") OR (("school_name" IS NOT NULL) AND ("athlete_count" IS NOT NULL)))),
    CONSTRAINT "site_leads_email_check" CHECK ((("email" IS NULL) OR (("char_length"("email") <= 254) AND ("email" ~~ '%_@_%._%'::"text")))),
    CONSTRAINT "site_leads_full_name_check" CHECK ((("char_length"("full_name") >= 2) AND ("char_length"("full_name") <= 100))),
    CONSTRAINT "site_leads_kind_check" CHECK (("kind" = ANY (ARRAY['demo'::"text", 'contact'::"text"]))),
    CONSTRAINT "site_leads_message_check" CHECK ((("message" IS NULL) OR (("char_length"("message") >= 10) AND ("char_length"("message") <= 2000)))),
    CONSTRAINT "site_leads_phone_check" CHECK (("phone" ~ '^5[0-9]{9}$'::"text")),
    CONSTRAINT "site_leads_school_name_check" CHECK ((("school_name" IS NULL) OR (("char_length"("school_name") >= 1) AND ("char_length"("school_name") <= 120)))),
    CONSTRAINT "site_leads_source_page_check" CHECK ((("source_page" IS NULL) OR ("char_length"("source_page") <= 200))),
    CONSTRAINT "site_leads_status_check" CHECK (("status" = ANY (ARRAY['new'::"text", 'contacted'::"text", 'converted'::"text", 'closed'::"text"]))),
    CONSTRAINT "site_leads_utm_campaign_check" CHECK ((("utm_campaign" IS NULL) OR ("char_length"("utm_campaign") <= 100))),
    CONSTRAINT "site_leads_utm_medium_check" CHECK ((("utm_medium" IS NULL) OR ("char_length"("utm_medium") <= 100))),
    CONSTRAINT "site_leads_utm_source_check" CHECK ((("utm_source" IS NULL) OR ("char_length"("utm_source") <= 100)))
);


ALTER TABLE "public"."site_leads" OWNER TO "postgres";


COMMENT ON TABLE "public"."site_leads" IS 'mobilsporokulu.com demo/iletişim formu talepleri. Yalnızca site-lead Edge Function''ı submit_site_lead() ile yazar; RLS açık, politika yok. 12 ay sonra silinir.';


CREATE TABLE IF NOT EXISTS "public"."sports" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "school_id" "uuid" NOT NULL,
    "is_deleted" boolean DEFAULT false
);


ALTER TABLE "public"."sports" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."transactions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "record_id" "uuid" NOT NULL,
    "amount" numeric(10,2) NOT NULL,
    "method" "public"."payment_method" NOT NULL,
    "transaction_date" timestamp with time zone DEFAULT "now"(),
    "processed_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "school_id" "uuid",
    "branch_id" "uuid",
    "is_deleted" boolean DEFAULT false
);


ALTER TABLE "public"."transactions" OWNER TO "postgres";


ALTER TABLE ONLY "public"."pre_registration_attempts" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."pre_registration_attempts_id_seq"'::"regclass");


ALTER TABLE ONLY "public"."app_min_versions"
    ADD CONSTRAINT "app_min_versions_pkey" PRIMARY KEY ("app", "brand", "platform");


ALTER TABLE ONLY "public"."athletes"
    ADD CONSTRAINT "athletes_pkey" PRIMARY KEY ("id");


ALTER TABLE ONLY "public"."attendances"
    ADD CONSTRAINT "attendances_class_athlete_date_unique" UNIQUE ("class_id", "athlete_id", "attendance_date");


ALTER TABLE ONLY "public"."attendances"
    ADD CONSTRAINT "attendances_pkey" PRIMARY KEY ("id");


ALTER TABLE ONLY "public"."branch_class_links"
    ADD CONSTRAINT "branch_class_links_pkey" PRIMARY KEY ("id");


ALTER TABLE ONLY "public"."branch_discount_links"
    ADD CONSTRAINT "branch_discount_links_pkey" PRIMARY KEY ("id");


ALTER TABLE ONLY "public"."branch_income_expense_item_links"
    ADD CONSTRAINT "branch_income_expense_item_links_pkey" PRIMARY KEY ("id");


ALTER TABLE ONLY "public"."branch_sport_links"
    ADD CONSTRAINT "branch_sport_links_pkey" PRIMARY KEY ("id");


ALTER TABLE ONLY "public"."branches"
    ADD CONSTRAINT "branches_pkey" PRIMARY KEY ("id");


ALTER TABLE ONLY "public"."class_schedule_slots"
    ADD CONSTRAINT "class_schedule_slots_pkey" PRIMARY KEY ("id");


ALTER TABLE ONLY "public"."classes"
    ADD CONSTRAINT "classes_pkey" PRIMARY KEY ("id");


ALTER TABLE ONLY "public"."coach_class_links"
    ADD CONSTRAINT "coach_class_links_pkey" PRIMARY KEY ("id");


ALTER TABLE ONLY "public"."customers"
    ADD CONSTRAINT "customers_pkey" PRIMARY KEY ("id");


ALTER TABLE ONLY "public"."direct_messages"
    ADD CONSTRAINT "direct_messages_pkey" PRIMARY KEY ("id");


ALTER TABLE ONLY "public"."discounts"
    ADD CONSTRAINT "discounts_pkey" PRIMARY KEY ("id");


ALTER TABLE ONLY "public"."financial_records"
    ADD CONSTRAINT "financial_records_pkey" PRIMARY KEY ("id");


ALTER TABLE ONLY "public"."athlete_consent_events"
    ADD CONSTRAINT "health_consent_events_pkey" PRIMARY KEY ("id");


ALTER TABLE ONLY "public"."income_expense_items"
    ADD CONSTRAINT "income_expense_items_pkey" PRIMARY KEY ("id");


ALTER TABLE ONLY "public"."notification_announcements"
    ADD CONSTRAINT "notification_announcements_pkey" PRIMARY KEY ("id");


ALTER TABLE ONLY "public"."notification_preferences"
    ADD CONSTRAINT "notification_preferences_pkey" PRIMARY KEY ("profile_id", "type");


ALTER TABLE ONLY "public"."notifications"
    ADD CONSTRAINT "notifications_pkey" PRIMARY KEY ("id");


ALTER TABLE ONLY "public"."parent_athlete_links"
    ADD CONSTRAINT "parent_athlete_links_pkey" PRIMARY KEY ("id");


ALTER TABLE ONLY "public"."pre_registration_attempts"
    ADD CONSTRAINT "pre_registration_attempts_pkey" PRIMARY KEY ("id");


ALTER TABLE ONLY "public"."pre_registration_links"
    ADD CONSTRAINT "pre_registration_links_pkey" PRIMARY KEY ("id");


ALTER TABLE ONLY "public"."pre_registration_links"
    ADD CONSTRAINT "pre_registration_links_token_key" UNIQUE ("token");


ALTER TABLE ONLY "public"."pre_registrations"
    ADD CONSTRAINT "pre_registrations_pkey" PRIMARY KEY ("id");


ALTER TABLE ONLY "public"."profile_branch_links"
    ADD CONSTRAINT "profile_branch_links_pkey" PRIMARY KEY ("id");


ALTER TABLE ONLY "public"."profile_permissions"
    ADD CONSTRAINT "profile_permissions_pkey" PRIMARY KEY ("id");


ALTER TABLE ONLY "public"."profile_permissions"
    ADD CONSTRAINT "profile_permissions_profile_permission_key" UNIQUE ("profile_id", "permission");


ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_pkey" PRIMARY KEY ("id");


ALTER TABLE ONLY "public"."push_tokens"
    ADD CONSTRAINT "push_tokens_pkey" PRIMARY KEY ("token");


ALTER TABLE ONLY "public"."role_permissions"
    ADD CONSTRAINT "role_permissions_pkey" PRIMARY KEY ("role_id", "permission");


ALTER TABLE ONLY "public"."roles"
    ADD CONSTRAINT "roles_pkey" PRIMARY KEY ("id");


ALTER TABLE ONLY "public"."schools"
    ADD CONSTRAINT "schools_pkey" PRIMARY KEY ("id");


ALTER TABLE ONLY "public"."site_leads"
    ADD CONSTRAINT "site_leads_pkey" PRIMARY KEY ("id");


ALTER TABLE ONLY "public"."sports"
    ADD CONSTRAINT "sports_pkey" PRIMARY KEY ("id");


ALTER TABLE ONLY "public"."transactions"
    ADD CONSTRAINT "transactions_pkey" PRIMARY KEY ("id");


CREATE INDEX "athlete_consent_events_athlete_idx" ON "public"."athlete_consent_events" USING "btree" ("athlete_id", "created_at" DESC);


CREATE UNIQUE INDEX "athletes_school_national_id_key" ON "public"."athletes" USING "btree" ("school_id", "national_id") WHERE (("national_id" IS NOT NULL) AND ("is_deleted" IS NOT TRUE));


CREATE UNIQUE INDEX "branch_class_links_pair_unique" ON "public"."branch_class_links" USING "btree" ("branch_id", "class_id");


CREATE UNIQUE INDEX "branch_discount_links_pair_unique" ON "public"."branch_discount_links" USING "btree" ("branch_id", "discount_id");


CREATE UNIQUE INDEX "branch_income_expense_item_links_pair_unique" ON "public"."branch_income_expense_item_links" USING "btree" ("branch_id", "income_expense_item_id");


CREATE UNIQUE INDEX "branch_sport_links_pair_unique" ON "public"."branch_sport_links" USING "btree" ("branch_id", "sport_id");


CREATE UNIQUE INDEX "class_schedule_slots_pair_unique" ON "public"."class_schedule_slots" USING "btree" ("class_id", "weekday");


CREATE UNIQUE INDEX "coach_class_links_pair_unique" ON "public"."coach_class_links" USING "btree" ("profile_id", "class_id");


CREATE INDEX "direct_messages_athlete_idx" ON "public"."direct_messages" USING "btree" ("athlete_id", "created_at" DESC);


CREATE INDEX "direct_messages_school_idx" ON "public"."direct_messages" USING "btree" ("school_id", "created_at" DESC) WHERE ("is_deleted" IS NOT TRUE);


CREATE INDEX "direct_messages_sender_idx" ON "public"."direct_messages" USING "btree" ("sender_id", "created_at" DESC);


CREATE INDEX "idx_athletes_branch_id" ON "public"."athletes" USING "btree" ("branch_id");


CREATE INDEX "idx_athletes_class_id" ON "public"."athletes" USING "btree" ("class_id");


CREATE INDEX "idx_athletes_school_id" ON "public"."athletes" USING "btree" ("school_id");


CREATE INDEX "idx_attendances_athlete" ON "public"."attendances" USING "btree" ("athlete_id");


CREATE INDEX "idx_attendances_branch" ON "public"."attendances" USING "btree" ("branch_id");


CREATE INDEX "idx_attendances_class_date" ON "public"."attendances" USING "btree" ("class_id", "attendance_date");


CREATE INDEX "idx_attendances_coach" ON "public"."attendances" USING "btree" ("coach_id");


CREATE INDEX "idx_attendances_school_date" ON "public"."attendances" USING "btree" ("school_id", "attendance_date");


CREATE INDEX "idx_branches_school_id" ON "public"."branches" USING "btree" ("school_id");


CREATE INDEX "idx_classes_branch_id" ON "public"."classes" USING "btree" ("branch_id");


CREATE INDEX "idx_classes_school_id" ON "public"."classes" USING "btree" ("school_id");


CREATE INDEX "idx_coach_class_links_class_id" ON "public"."coach_class_links" USING "btree" ("class_id");


CREATE INDEX "idx_customers_school_id" ON "public"."customers" USING "btree" ("school_id");


CREATE INDEX "idx_discounts_school_id" ON "public"."discounts" USING "btree" ("school_id");


CREATE INDEX "idx_financial_records_branch_id" ON "public"."financial_records" USING "btree" ("branch_id");


CREATE INDEX "idx_financial_records_customer_id" ON "public"."financial_records" USING "btree" ("customer_id");


CREATE INDEX "idx_financial_records_school_id" ON "public"."financial_records" USING "btree" ("school_id");


CREATE INDEX "idx_financial_records_status_date" ON "public"."financial_records" USING "btree" ("status", "expected_date");


CREATE INDEX "idx_income_expense_items_school_id" ON "public"."income_expense_items" USING "btree" ("school_id");


CREATE INDEX "idx_parent_athlete_links_athlete" ON "public"."parent_athlete_links" USING "btree" ("athlete_id");


CREATE INDEX "idx_pre_registrations_school_id" ON "public"."pre_registrations" USING "btree" ("school_id");


CREATE INDEX "idx_profile_branch_links_branch" ON "public"."profile_branch_links" USING "btree" ("branch_id");


CREATE INDEX "idx_profile_permissions_school_id" ON "public"."profile_permissions" USING "btree" ("school_id");


CREATE INDEX "idx_profiles_school_id" ON "public"."profiles" USING "btree" ("school_id");


CREATE INDEX "idx_sports_school_id" ON "public"."sports" USING "btree" ("school_id");


CREATE INDEX "idx_transactions_branch_id" ON "public"."transactions" USING "btree" ("branch_id");


CREATE INDEX "idx_transactions_record_id" ON "public"."transactions" USING "btree" ("record_id");


CREATE INDEX "idx_transactions_school_id" ON "public"."transactions" USING "btree" ("school_id");


CREATE INDEX "notification_announcements_school_idx" ON "public"."notification_announcements" USING "btree" ("school_id", "created_at" DESC) WHERE ("is_deleted" IS NOT TRUE);


CREATE UNIQUE INDEX "notifications_dedupe_unique" ON "public"."notifications" USING "btree" ("recipient_id", "dedupe_key") WHERE ("dedupe_key" IS NOT NULL);


CREATE INDEX "notifications_direct_message_idx" ON "public"."notifications" USING "btree" ("direct_message_id") WHERE ("direct_message_id" IS NOT NULL);


CREATE INDEX "notifications_inbox_idx" ON "public"."notifications" USING "btree" ("recipient_id", "created_at" DESC) WHERE ("is_deleted" IS NOT TRUE);


CREATE INDEX "notifications_push_queue_idx" ON "public"."notifications" USING "btree" ("created_at") WHERE ("push_status" = ANY (ARRAY['pending'::"text", 'sending'::"text"]));


CREATE UNIQUE INDEX "parent_athlete_links_pair_unique" ON "public"."parent_athlete_links" USING "btree" ("profile_id", "athlete_id");


CREATE INDEX "pre_registration_attempts_ip_idx" ON "public"."pre_registration_attempts" USING "btree" ("ip_hash", "created_at" DESC);


CREATE UNIQUE INDEX "pre_registration_links_one_per_school" ON "public"."pre_registration_links" USING "btree" ("school_id") WHERE ("is_deleted" IS NOT TRUE);


CREATE INDEX "pre_registration_links_school_idx" ON "public"."pre_registration_links" USING "btree" ("school_id", "created_at" DESC) WHERE ("is_deleted" IS NOT TRUE);


CREATE INDEX "pre_registration_links_token_idx" ON "public"."pre_registration_links" USING "btree" ("token") WHERE ("is_deleted" IS NOT TRUE);


CREATE INDEX "pre_registrations_abuse_guard_idx" ON "public"."pre_registrations" USING "btree" ("school_id", "parent_phone", "created_at" DESC);


CREATE UNIQUE INDEX "profile_branch_links_pair_unique" ON "public"."profile_branch_links" USING "btree" ("profile_id", "branch_id");


CREATE INDEX "push_tokens_profile_idx" ON "public"."push_tokens" USING "btree" ("profile_id");


CREATE INDEX "site_leads_created_at_idx" ON "public"."site_leads" USING "btree" ("created_at" DESC);


CREATE INDEX "site_leads_ip_hash_idx" ON "public"."site_leads" USING "btree" ("ip_hash", "created_at");


CREATE INDEX "site_leads_phone_idx" ON "public"."site_leads" USING "btree" ("phone", "created_at");


CREATE UNIQUE INDEX "sports_school_name_unique" ON "public"."sports" USING "btree" ("school_id", "lower"("name")) WHERE ("is_deleted" IS NOT TRUE);


CREATE OR REPLACE TRIGGER "app_min_versions_set_updated_at" BEFORE INSERT OR UPDATE ON "public"."app_min_versions" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();


CREATE OR REPLACE TRIGGER "athletes_enforce_health_consent" BEFORE INSERT OR UPDATE ON "public"."athletes" FOR EACH ROW EXECUTE FUNCTION "public"."enforce_athlete_health_consent"();


CREATE OR REPLACE TRIGGER "athletes_log_consents" AFTER INSERT OR UPDATE OF "health_consent_at", "photo_consent_at", "promo_photo_consent_at" ON "public"."athletes" FOR EACH ROW EXECUTE FUNCTION "public"."log_athlete_consents"();


CREATE OR REPLACE TRIGGER "athletes_set_updated_at" BEFORE INSERT OR UPDATE ON "public"."athletes" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();


CREATE OR REPLACE TRIGGER "attendances_notify_insert" AFTER INSERT ON "public"."attendances" REFERENCING NEW TABLE AS "inserted_rows" FOR EACH STATEMENT EXECUTE FUNCTION "public"."attendances_after_insert_notify"();


CREATE OR REPLACE TRIGGER "attendances_notify_update" AFTER UPDATE ON "public"."attendances" REFERENCING OLD TABLE AS "old_rows" NEW TABLE AS "new_rows" FOR EACH STATEMENT EXECUTE FUNCTION "public"."attendances_after_update_notify"();


CREATE OR REPLACE TRIGGER "attendances_set_updated_at" BEFORE INSERT OR UPDATE ON "public"."attendances" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();


CREATE OR REPLACE TRIGGER "branches_set_updated_at" BEFORE INSERT OR UPDATE ON "public"."branches" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();


CREATE OR REPLACE TRIGGER "class_schedule_slots_set_updated_at" BEFORE INSERT OR UPDATE ON "public"."class_schedule_slots" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();


CREATE OR REPLACE TRIGGER "classes_set_updated_at" BEFORE INSERT OR UPDATE ON "public"."classes" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();


CREATE OR REPLACE TRIGGER "ensure_last_manager" BEFORE UPDATE ON "public"."profiles" FOR EACH ROW EXECUTE FUNCTION "public"."prevent_last_manager_removal"();


CREATE OR REPLACE TRIGGER "financial_records_set_updated_at" BEFORE INSERT OR UPDATE ON "public"."financial_records" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();


CREATE OR REPLACE TRIGGER "guard_general_manager_profile" BEFORE INSERT OR UPDATE ON "public"."profiles" FOR EACH ROW EXECUTE FUNCTION "public"."guard_general_manager_profile"();


CREATE OR REPLACE TRIGGER "guard_school_contract_columns" BEFORE UPDATE ON "public"."schools" FOR EACH ROW EXECUTE FUNCTION "public"."guard_school_contract_columns"();


CREATE OR REPLACE TRIGGER "notification_preferences_set_updated_at" BEFORE INSERT OR UPDATE ON "public"."notification_preferences" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();


CREATE OR REPLACE TRIGGER "notifications_dispatch_push" AFTER INSERT ON "public"."notifications" REFERENCING NEW TABLE AS "inserted_rows" FOR EACH STATEMENT EXECUTE FUNCTION "public"."notifications_after_insert"();


CREATE OR REPLACE TRIGGER "pre_registrations_enforce_health_consent" BEFORE INSERT OR UPDATE ON "public"."pre_registrations" FOR EACH ROW EXECUTE FUNCTION "public"."enforce_pre_registration_health_consent"();


CREATE OR REPLACE TRIGGER "pre_registrations_notify" AFTER INSERT ON "public"."pre_registrations" FOR EACH ROW EXECUTE FUNCTION "public"."notify_pre_registration_received"();


CREATE OR REPLACE TRIGGER "pre_registrations_set_updated_at" BEFORE INSERT OR UPDATE ON "public"."pre_registrations" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();


CREATE OR REPLACE TRIGGER "profile_permissions_set_updated_at" BEFORE INSERT OR UPDATE ON "public"."profile_permissions" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();


CREATE OR REPLACE TRIGGER "profiles_guard_privacy_notice" BEFORE INSERT OR UPDATE ON "public"."profiles" FOR EACH ROW EXECUTE FUNCTION "public"."guard_privacy_notice_columns"();


CREATE OR REPLACE TRIGGER "profiles_prune_permissions" AFTER UPDATE OF "role_id" ON "public"."profiles" FOR EACH ROW WHEN (("old"."role_id" IS DISTINCT FROM "new"."role_id")) EXECUTE FUNCTION "public"."prune_profile_permissions_on_role_change"();


CREATE OR REPLACE TRIGGER "profiles_set_updated_at" BEFORE INSERT OR UPDATE ON "public"."profiles" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();


CREATE OR REPLACE TRIGGER "schools_grant_founder_permissions" AFTER INSERT ON "public"."schools" FOR EACH ROW EXECUTE FUNCTION "public"."grant_founder_permissions"();


CREATE OR REPLACE TRIGGER "schools_set_updated_at" BEFORE INSERT OR UPDATE ON "public"."schools" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();


CREATE OR REPLACE TRIGGER "sync_school_users_brand" AFTER UPDATE OF "brand" ON "public"."schools" FOR EACH ROW WHEN (("new"."brand" IS DISTINCT FROM "old"."brand")) EXECUTE FUNCTION "public"."sync_school_users_brand"();


CREATE OR REPLACE TRIGGER "sync_user_brand" AFTER INSERT OR UPDATE OF "school_id" ON "public"."profiles" FOR EACH ROW EXECUTE FUNCTION "public"."sync_user_brand_from_profile"();


CREATE OR REPLACE TRIGGER "trg_sync_athlete_to_customer" AFTER INSERT OR UPDATE ON "public"."athletes" FOR EACH ROW EXECUTE FUNCTION "public"."sync_athlete_to_customer"();


ALTER TABLE ONLY "public"."athletes"
    ADD CONSTRAINT "athlete_details_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE CASCADE;


ALTER TABLE ONLY "public"."athletes"
    ADD CONSTRAINT "athletes_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id");


ALTER TABLE ONLY "public"."athletes"
    ADD CONSTRAINT "athletes_class_id_fkey" FOREIGN KEY ("class_id") REFERENCES "public"."classes"("id");


ALTER TABLE ONLY "public"."attendances"
    ADD CONSTRAINT "attendances_athlete_id_fkey" FOREIGN KEY ("athlete_id") REFERENCES "public"."athletes"("id") ON DELETE CASCADE;


ALTER TABLE ONLY "public"."attendances"
    ADD CONSTRAINT "attendances_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE CASCADE;


ALTER TABLE ONLY "public"."attendances"
    ADD CONSTRAINT "attendances_class_id_fkey" FOREIGN KEY ("class_id") REFERENCES "public"."classes"("id") ON DELETE CASCADE;


ALTER TABLE ONLY "public"."attendances"
    ADD CONSTRAINT "attendances_coach_id_fkey" FOREIGN KEY ("coach_id") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;


ALTER TABLE ONLY "public"."attendances"
    ADD CONSTRAINT "attendances_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;


ALTER TABLE ONLY "public"."attendances"
    ADD CONSTRAINT "attendances_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE CASCADE;


ALTER TABLE ONLY "public"."branch_class_links"
    ADD CONSTRAINT "branch_class_links_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE CASCADE;


ALTER TABLE ONLY "public"."branch_class_links"
    ADD CONSTRAINT "branch_class_links_class_id_fkey" FOREIGN KEY ("class_id") REFERENCES "public"."classes"("id") ON DELETE CASCADE;


ALTER TABLE ONLY "public"."branch_class_links"
    ADD CONSTRAINT "branch_class_links_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE CASCADE;


ALTER TABLE ONLY "public"."branch_discount_links"
    ADD CONSTRAINT "branch_discount_links_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id");


ALTER TABLE ONLY "public"."branch_discount_links"
    ADD CONSTRAINT "branch_discount_links_discount_id_fkey" FOREIGN KEY ("discount_id") REFERENCES "public"."discounts"("id");


ALTER TABLE ONLY "public"."branch_discount_links"
    ADD CONSTRAINT "branch_discount_links_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id");


ALTER TABLE ONLY "public"."branch_income_expense_item_links"
    ADD CONSTRAINT "branch_income_expense_item_links_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id");


ALTER TABLE ONLY "public"."branch_income_expense_item_links"
    ADD CONSTRAINT "branch_income_expense_item_links_income_expense_item_id_fkey" FOREIGN KEY ("income_expense_item_id") REFERENCES "public"."income_expense_items"("id");


ALTER TABLE ONLY "public"."branch_income_expense_item_links"
    ADD CONSTRAINT "branch_income_expense_item_links_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id");


ALTER TABLE ONLY "public"."branch_sport_links"
    ADD CONSTRAINT "branch_sport_links_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE CASCADE;


ALTER TABLE ONLY "public"."branch_sport_links"
    ADD CONSTRAINT "branch_sport_links_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE CASCADE;


ALTER TABLE ONLY "public"."branch_sport_links"
    ADD CONSTRAINT "branch_sport_links_sport_id_fkey" FOREIGN KEY ("sport_id") REFERENCES "public"."sports"("id") ON DELETE CASCADE;


ALTER TABLE ONLY "public"."branches"
    ADD CONSTRAINT "branches_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE CASCADE;


ALTER TABLE ONLY "public"."class_schedule_slots"
    ADD CONSTRAINT "class_schedule_slots_class_id_fkey" FOREIGN KEY ("class_id") REFERENCES "public"."classes"("id");


ALTER TABLE ONLY "public"."class_schedule_slots"
    ADD CONSTRAINT "class_schedule_slots_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id");


ALTER TABLE ONLY "public"."classes"
    ADD CONSTRAINT "classes_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE CASCADE;


ALTER TABLE ONLY "public"."classes"
    ADD CONSTRAINT "classes_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE CASCADE;


ALTER TABLE ONLY "public"."classes"
    ADD CONSTRAINT "classes_sport_id_fkey" FOREIGN KEY ("sport_id") REFERENCES "public"."sports"("id") ON DELETE RESTRICT;


ALTER TABLE ONLY "public"."coach_class_links"
    ADD CONSTRAINT "coach_class_links_class_id_fkey" FOREIGN KEY ("class_id") REFERENCES "public"."classes"("id") ON DELETE CASCADE;


ALTER TABLE ONLY "public"."coach_class_links"
    ADD CONSTRAINT "coach_class_links_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id");


ALTER TABLE ONLY "public"."coach_class_links"
    ADD CONSTRAINT "coach_class_links_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE CASCADE;


ALTER TABLE ONLY "public"."customers"
    ADD CONSTRAINT "customers_athlete_id_fkey" FOREIGN KEY ("athlete_id") REFERENCES "public"."athletes"("id");


ALTER TABLE ONLY "public"."customers"
    ADD CONSTRAINT "customers_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id");


ALTER TABLE ONLY "public"."customers"
    ADD CONSTRAINT "customers_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id");


ALTER TABLE ONLY "public"."direct_messages"
    ADD CONSTRAINT "direct_messages_athlete_id_fkey" FOREIGN KEY ("athlete_id") REFERENCES "public"."athletes"("id");


ALTER TABLE ONLY "public"."direct_messages"
    ADD CONSTRAINT "direct_messages_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id");


ALTER TABLE ONLY "public"."direct_messages"
    ADD CONSTRAINT "direct_messages_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id");


ALTER TABLE ONLY "public"."direct_messages"
    ADD CONSTRAINT "direct_messages_sender_id_fkey" FOREIGN KEY ("sender_id") REFERENCES "public"."profiles"("id");


ALTER TABLE ONLY "public"."discounts"
    ADD CONSTRAINT "discounts_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE CASCADE;


ALTER TABLE ONLY "public"."financial_records"
    ADD CONSTRAINT "financial_records_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id");


ALTER TABLE ONLY "public"."financial_records"
    ADD CONSTRAINT "financial_records_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE RESTRICT;


ALTER TABLE ONLY "public"."financial_records"
    ADD CONSTRAINT "financial_records_discount_id_fkey" FOREIGN KEY ("discount_id") REFERENCES "public"."discounts"("id");


ALTER TABLE ONLY "public"."financial_records"
    ADD CONSTRAINT "financial_records_income_expense_item_id_fkey" FOREIGN KEY ("income_expense_item_id") REFERENCES "public"."income_expense_items"("id") ON DELETE SET NULL;


ALTER TABLE ONLY "public"."financial_records"
    ADD CONSTRAINT "financial_records_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id");


ALTER TABLE ONLY "public"."athlete_consent_events"
    ADD CONSTRAINT "health_consent_events_athlete_id_fkey" FOREIGN KEY ("athlete_id") REFERENCES "public"."athletes"("id") ON DELETE CASCADE;


ALTER TABLE ONLY "public"."athlete_consent_events"
    ADD CONSTRAINT "health_consent_events_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE CASCADE;


ALTER TABLE ONLY "public"."income_expense_items"
    ADD CONSTRAINT "income_expense_items_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE CASCADE;


ALTER TABLE ONLY "public"."notification_announcements"
    ADD CONSTRAINT "notification_announcements_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id");


ALTER TABLE ONLY "public"."notification_announcements"
    ADD CONSTRAINT "notification_announcements_sender_id_fkey" FOREIGN KEY ("sender_id") REFERENCES "public"."profiles"("id");


ALTER TABLE ONLY "public"."notification_preferences"
    ADD CONSTRAINT "notification_preferences_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id");


ALTER TABLE ONLY "public"."notifications"
    ADD CONSTRAINT "notifications_announcement_id_fkey" FOREIGN KEY ("announcement_id") REFERENCES "public"."notification_announcements"("id");


ALTER TABLE ONLY "public"."notifications"
    ADD CONSTRAINT "notifications_direct_message_id_fkey" FOREIGN KEY ("direct_message_id") REFERENCES "public"."direct_messages"("id");


ALTER TABLE ONLY "public"."notifications"
    ADD CONSTRAINT "notifications_recipient_id_fkey" FOREIGN KEY ("recipient_id") REFERENCES "public"."profiles"("id");


ALTER TABLE ONLY "public"."notifications"
    ADD CONSTRAINT "notifications_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id");


ALTER TABLE ONLY "public"."parent_athlete_links"
    ADD CONSTRAINT "parent_athlete_links_athlete_id_fkey" FOREIGN KEY ("athlete_id") REFERENCES "public"."athletes"("id");


ALTER TABLE ONLY "public"."parent_athlete_links"
    ADD CONSTRAINT "parent_athlete_links_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id");


ALTER TABLE ONLY "public"."parent_athlete_links"
    ADD CONSTRAINT "parent_athlete_links_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE CASCADE;


ALTER TABLE ONLY "public"."pre_registration_links"
    ADD CONSTRAINT "pre_registration_links_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."profiles"("id");


ALTER TABLE ONLY "public"."pre_registration_links"
    ADD CONSTRAINT "pre_registration_links_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE CASCADE;


ALTER TABLE ONLY "public"."pre_registrations"
    ADD CONSTRAINT "pre_registrations_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE CASCADE;


ALTER TABLE ONLY "public"."pre_registrations"
    ADD CONSTRAINT "pre_registrations_class_id_fkey" FOREIGN KEY ("class_id") REFERENCES "public"."classes"("id") ON DELETE SET NULL;


ALTER TABLE ONLY "public"."pre_registrations"
    ADD CONSTRAINT "pre_registrations_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE CASCADE;


ALTER TABLE ONLY "public"."profile_branch_links"
    ADD CONSTRAINT "profile_branch_links_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE CASCADE;


ALTER TABLE ONLY "public"."profile_branch_links"
    ADD CONSTRAINT "profile_branch_links_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id");


ALTER TABLE ONLY "public"."profile_branch_links"
    ADD CONSTRAINT "profile_branch_links_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE CASCADE;


ALTER TABLE ONLY "public"."profile_permissions"
    ADD CONSTRAINT "profile_permissions_granted_by_fkey" FOREIGN KEY ("granted_by") REFERENCES "public"."profiles"("id");


ALTER TABLE ONLY "public"."profile_permissions"
    ADD CONSTRAINT "profile_permissions_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id");


ALTER TABLE ONLY "public"."profile_permissions"
    ADD CONSTRAINT "profile_permissions_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE CASCADE;


ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_id_fkey" FOREIGN KEY ("id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;


ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id");


ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE CASCADE;


ALTER TABLE ONLY "public"."push_tokens"
    ADD CONSTRAINT "push_tokens_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id");


ALTER TABLE ONLY "public"."role_permissions"
    ADD CONSTRAINT "role_permissions_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE CASCADE;


ALTER TABLE ONLY "public"."schools"
    ADD CONSTRAINT "schools_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;


ALTER TABLE ONLY "public"."sports"
    ADD CONSTRAINT "sports_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id");


ALTER TABLE ONLY "public"."transactions"
    ADD CONSTRAINT "transactions_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id");


ALTER TABLE ONLY "public"."transactions"
    ADD CONSTRAINT "transactions_processed_by_fkey" FOREIGN KEY ("processed_by") REFERENCES "public"."profiles"("id");


ALTER TABLE ONLY "public"."transactions"
    ADD CONSTRAINT "transactions_record_id_fkey" FOREIGN KEY ("record_id") REFERENCES "public"."financial_records"("id") ON DELETE CASCADE;


ALTER TABLE ONLY "public"."transactions"
    ADD CONSTRAINT "transactions_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id");


ALTER TABLE "public"."app_min_versions" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "app_min_versions_select" ON "public"."app_min_versions" FOR SELECT TO "anon", "authenticated" USING (true);


ALTER TABLE "public"."athlete_consent_events" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."athletes" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "athletes_select_policy" ON "public"."athletes" FOR SELECT TO "authenticated" USING ((("school_id" = "public"."get_user_school_id"()) AND ("is_deleted" IS NOT TRUE) AND (EXISTS ( SELECT 1
   FROM "public"."branches" "b"
  WHERE (("b"."id" = "athletes"."branch_id") AND ("b"."is_deleted" IS NOT TRUE))))));


ALTER TABLE "public"."attendances" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "attendances_select_policy" ON "public"."attendances" FOR SELECT TO "authenticated" USING ((("school_id" = "public"."get_user_school_id"()) AND ("is_deleted" IS NOT TRUE) AND (EXISTS ( SELECT 1
   FROM "public"."branches" "b"
  WHERE (("b"."id" = "attendances"."branch_id") AND ("b"."is_deleted" IS NOT TRUE))))));


CREATE POLICY "bcl_select_policy" ON "public"."branch_class_links" FOR SELECT TO "authenticated" USING ((("school_id" = "public"."get_user_school_id"()) AND ("is_deleted" IS NOT TRUE)));


ALTER TABLE "public"."branch_class_links" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."branch_discount_links" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."branch_income_expense_item_links" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."branch_sport_links" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."branches" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "branches_select_policy" ON "public"."branches" FOR SELECT TO "authenticated" USING ((("school_id" = "public"."get_user_school_id"()) AND ("is_deleted" IS NOT TRUE) AND ("public"."current_user_is_school_wide"() OR (EXISTS ( SELECT 1
   FROM "public"."profile_branch_links" "pbl"
  WHERE (("pbl"."profile_id" = "auth"."uid"()) AND ("pbl"."branch_id" = "branches"."id") AND ("pbl"."is_deleted" IS NOT TRUE)))))));


CREATE POLICY "bsl_select_policy" ON "public"."branch_sport_links" FOR SELECT TO "authenticated" USING ((("school_id" = "public"."get_user_school_id"()) AND ("is_deleted" IS NOT TRUE)));


CREATE POLICY "ccl_select_policy" ON "public"."coach_class_links" FOR SELECT TO "authenticated" USING ((("school_id" = "public"."get_user_school_id"()) AND ("is_deleted" IS NOT TRUE)));


ALTER TABLE "public"."class_schedule_slots" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "class_schedule_slots_select_policy" ON "public"."class_schedule_slots" FOR SELECT TO "authenticated" USING ((("school_id" = "public"."get_user_school_id"()) AND ("is_deleted" IS NOT TRUE) AND (EXISTS ( SELECT 1
   FROM "public"."classes" "c"
  WHERE ("c"."id" = "class_schedule_slots"."class_id")))));


ALTER TABLE "public"."classes" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "classes_select_policy" ON "public"."classes" FOR SELECT TO "authenticated" USING ((("school_id" = "public"."get_user_school_id"()) AND (("is_deleted" IS FALSE) OR ("is_deleted" IS NULL)) AND (EXISTS ( SELECT 1
   FROM "public"."branches" "b"
  WHERE (("b"."id" = "classes"."branch_id") AND (("b"."is_deleted" IS FALSE) OR ("b"."is_deleted" IS NULL))))) AND (EXISTS ( SELECT 1
   FROM "public"."sports" "s"
  WHERE (("s"."id" = "classes"."sport_id") AND (("s"."is_deleted" IS FALSE) OR ("s"."is_deleted" IS NULL)))))));


COMMENT ON POLICY "classes_select_policy" ON "public"."classes" IS 'Görünürlük kuralı is_class_visible() ile aynıdır ama satırın kendi kolonları üzerinden yazılır. Fonksiyon STABLE olduğu için kendi komutunun eklediği satırı göremez; politikada çağrılınca RETURNING''li her INSERT "new row violates row-level security policy" ile reddediliyordu. Kuralı değiştirirken is_class_visible() ile birlikte güncelle.';


ALTER TABLE "public"."coach_class_links" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."customers" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."direct_messages" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."discounts" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "finance_branch_scope" ON "public"."branch_discount_links" AS RESTRICTIVE FOR SELECT TO "authenticated" USING ((( SELECT "public"."current_user_is_school_wide"() AS "current_user_is_school_wide") OR "public"."has_branch_access"("branch_id")));


CREATE POLICY "finance_branch_scope" ON "public"."branch_income_expense_item_links" AS RESTRICTIVE FOR SELECT TO "authenticated" USING ((( SELECT "public"."current_user_is_school_wide"() AS "current_user_is_school_wide") OR "public"."has_branch_access"("branch_id")));


CREATE POLICY "finance_branch_scope" ON "public"."customers" AS RESTRICTIVE FOR SELECT TO "authenticated" USING ("public"."customer_in_scope"("id"));


CREATE POLICY "finance_branch_scope" ON "public"."discounts" AS RESTRICTIVE FOR SELECT TO "authenticated" USING ("public"."discount_visible"("id"));


CREATE POLICY "finance_branch_scope" ON "public"."financial_records" AS RESTRICTIVE FOR SELECT TO "authenticated" USING ("public"."finance_branch_ok"("branch_id"));


CREATE POLICY "finance_branch_scope" ON "public"."income_expense_items" AS RESTRICTIVE FOR SELECT TO "authenticated" USING ("public"."income_expense_item_visible"("id"));


CREATE POLICY "finance_branch_scope" ON "public"."transactions" AS RESTRICTIVE FOR SELECT TO "authenticated" USING ("public"."finance_branch_ok"("branch_id"));


CREATE POLICY "finance_view_required" ON "public"."branch_discount_links" AS RESTRICTIVE FOR SELECT TO "authenticated" USING (( SELECT "public"."has_permission"('finance.view'::"text") AS "has_permission"));


CREATE POLICY "finance_view_required" ON "public"."branch_income_expense_item_links" AS RESTRICTIVE FOR SELECT TO "authenticated" USING (( SELECT "public"."has_permission"('finance.view'::"text") AS "has_permission"));


CREATE POLICY "finance_view_required" ON "public"."customers" AS RESTRICTIVE FOR SELECT TO "authenticated" USING (( SELECT "public"."has_permission"('finance.view'::"text") AS "has_permission"));


CREATE POLICY "finance_view_required" ON "public"."discounts" AS RESTRICTIVE FOR SELECT TO "authenticated" USING (( SELECT "public"."has_permission"('finance.view'::"text") AS "has_permission"));


CREATE POLICY "finance_view_required" ON "public"."financial_records" AS RESTRICTIVE FOR SELECT TO "authenticated" USING (( SELECT "public"."has_permission"('finance.view'::"text") AS "has_permission"));


CREATE POLICY "finance_view_required" ON "public"."income_expense_items" AS RESTRICTIVE FOR SELECT TO "authenticated" USING (( SELECT "public"."has_permission"('finance.view'::"text") AS "has_permission"));


CREATE POLICY "finance_view_required" ON "public"."transactions" AS RESTRICTIVE FOR SELECT TO "authenticated" USING (( SELECT "public"."has_permission"('finance.view'::"text") AS "has_permission"));


ALTER TABLE "public"."financial_records" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."income_expense_items" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."notification_announcements" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "notification_announcements_select" ON "public"."notification_announcements" FOR SELECT TO "authenticated" USING ((("is_deleted" IS NOT TRUE) AND ("school_id" = "public"."get_user_school_id"()) AND ("public"."current_user_is_school_wide"() OR ("sender_id" = "auth"."uid"()))));


ALTER TABLE "public"."notification_preferences" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "notification_preferences_select_own" ON "public"."notification_preferences" FOR SELECT TO "authenticated" USING (("profile_id" = "auth"."uid"()));


ALTER TABLE "public"."notifications" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "notifications_select_own" ON "public"."notifications" FOR SELECT TO "authenticated" USING ((("recipient_id" = "auth"."uid"()) AND ("is_deleted" IS NOT TRUE) AND (( SELECT "public"."get_user_role"() AS "get_user_role") IS NOT NULL)));


ALTER TABLE "public"."parent_athlete_links" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "parent_no_direct_access" ON "public"."athletes" AS RESTRICTIVE TO "authenticated" USING (("public"."get_user_role"() IS DISTINCT FROM 8)) WITH CHECK (("public"."get_user_role"() IS DISTINCT FROM 8));


COMMENT ON POLICY "parent_no_direct_access" ON "public"."athletes" IS 'Veli (rol 8) bu tabloyu doğrudan okuyamaz/yazamaz; görmesi gerekenler parent_* RPC''lerinden gelir. Restrictive: personelin erişimini değiştirmez. Bkz. 20260928_parent_app.sql.';


CREATE POLICY "parent_no_direct_access" ON "public"."attendances" AS RESTRICTIVE TO "authenticated" USING (("public"."get_user_role"() IS DISTINCT FROM 8)) WITH CHECK (("public"."get_user_role"() IS DISTINCT FROM 8));


COMMENT ON POLICY "parent_no_direct_access" ON "public"."attendances" IS 'Veli (rol 8) bu tabloyu doğrudan okuyamaz/yazamaz; görmesi gerekenler parent_* RPC''lerinden gelir. Restrictive: personelin erişimini değiştirmez. Bkz. 20260928_parent_app.sql.';


CREATE POLICY "parent_no_direct_access" ON "public"."branch_class_links" AS RESTRICTIVE TO "authenticated" USING (("public"."get_user_role"() IS DISTINCT FROM 8)) WITH CHECK (("public"."get_user_role"() IS DISTINCT FROM 8));


COMMENT ON POLICY "parent_no_direct_access" ON "public"."branch_class_links" IS 'Veli (rol 8) bu tabloyu doğrudan okuyamaz/yazamaz; görmesi gerekenler parent_* RPC''lerinden gelir. Restrictive: personelin erişimini değiştirmez. Bkz. 20260928_parent_app.sql.';


CREATE POLICY "parent_no_direct_access" ON "public"."branch_discount_links" AS RESTRICTIVE TO "authenticated" USING (("public"."get_user_role"() IS DISTINCT FROM 8)) WITH CHECK (("public"."get_user_role"() IS DISTINCT FROM 8));


COMMENT ON POLICY "parent_no_direct_access" ON "public"."branch_discount_links" IS 'Veli (rol 8) bu tabloyu doğrudan okuyamaz/yazamaz; görmesi gerekenler parent_* RPC''lerinden gelir. Restrictive: personelin erişimini değiştirmez. Bkz. 20260928_parent_app.sql.';


CREATE POLICY "parent_no_direct_access" ON "public"."branch_income_expense_item_links" AS RESTRICTIVE TO "authenticated" USING (("public"."get_user_role"() IS DISTINCT FROM 8)) WITH CHECK (("public"."get_user_role"() IS DISTINCT FROM 8));


COMMENT ON POLICY "parent_no_direct_access" ON "public"."branch_income_expense_item_links" IS 'Veli (rol 8) bu tabloyu doğrudan okuyamaz/yazamaz; görmesi gerekenler parent_* RPC''lerinden gelir. Restrictive: personelin erişimini değiştirmez. Bkz. 20260928_parent_app.sql.';


CREATE POLICY "parent_no_direct_access" ON "public"."branch_sport_links" AS RESTRICTIVE TO "authenticated" USING (("public"."get_user_role"() IS DISTINCT FROM 8)) WITH CHECK (("public"."get_user_role"() IS DISTINCT FROM 8));


COMMENT ON POLICY "parent_no_direct_access" ON "public"."branch_sport_links" IS 'Veli (rol 8) bu tabloyu doğrudan okuyamaz/yazamaz; görmesi gerekenler parent_* RPC''lerinden gelir. Restrictive: personelin erişimini değiştirmez. Bkz. 20260928_parent_app.sql.';


CREATE POLICY "parent_no_direct_access" ON "public"."branches" AS RESTRICTIVE TO "authenticated" USING (("public"."get_user_role"() IS DISTINCT FROM 8)) WITH CHECK (("public"."get_user_role"() IS DISTINCT FROM 8));


COMMENT ON POLICY "parent_no_direct_access" ON "public"."branches" IS 'Veli (rol 8) bu tabloyu doğrudan okuyamaz/yazamaz; görmesi gerekenler parent_* RPC''lerinden gelir. Restrictive: personelin erişimini değiştirmez. Bkz. 20260928_parent_app.sql.';


CREATE POLICY "parent_no_direct_access" ON "public"."class_schedule_slots" AS RESTRICTIVE TO "authenticated" USING (("public"."get_user_role"() IS DISTINCT FROM 8)) WITH CHECK (("public"."get_user_role"() IS DISTINCT FROM 8));


COMMENT ON POLICY "parent_no_direct_access" ON "public"."class_schedule_slots" IS 'Veli (rol 8) bu tabloyu doğrudan okuyamaz/yazamaz; görmesi gerekenler parent_* RPC''lerinden gelir. Restrictive: personelin erişimini değiştirmez. Bkz. 20260928_parent_app.sql.';


CREATE POLICY "parent_no_direct_access" ON "public"."classes" AS RESTRICTIVE TO "authenticated" USING (("public"."get_user_role"() IS DISTINCT FROM 8)) WITH CHECK (("public"."get_user_role"() IS DISTINCT FROM 8));


COMMENT ON POLICY "parent_no_direct_access" ON "public"."classes" IS 'Veli (rol 8) bu tabloyu doğrudan okuyamaz/yazamaz; görmesi gerekenler parent_* RPC''lerinden gelir. Restrictive: personelin erişimini değiştirmez. Bkz. 20260928_parent_app.sql.';


CREATE POLICY "parent_no_direct_access" ON "public"."coach_class_links" AS RESTRICTIVE TO "authenticated" USING (("public"."get_user_role"() IS DISTINCT FROM 8)) WITH CHECK (("public"."get_user_role"() IS DISTINCT FROM 8));


COMMENT ON POLICY "parent_no_direct_access" ON "public"."coach_class_links" IS 'Veli (rol 8) bu tabloyu doğrudan okuyamaz/yazamaz; görmesi gerekenler parent_* RPC''lerinden gelir. Restrictive: personelin erişimini değiştirmez. Bkz. 20260928_parent_app.sql.';


CREATE POLICY "parent_no_direct_access" ON "public"."customers" AS RESTRICTIVE TO "authenticated" USING (("public"."get_user_role"() IS DISTINCT FROM 8)) WITH CHECK (("public"."get_user_role"() IS DISTINCT FROM 8));


COMMENT ON POLICY "parent_no_direct_access" ON "public"."customers" IS 'Veli (rol 8) bu tabloyu doğrudan okuyamaz/yazamaz; görmesi gerekenler parent_* RPC''lerinden gelir. Restrictive: personelin erişimini değiştirmez. Bkz. 20260928_parent_app.sql.';


CREATE POLICY "parent_no_direct_access" ON "public"."direct_messages" AS RESTRICTIVE TO "authenticated" USING (("public"."get_user_role"() IS DISTINCT FROM 8)) WITH CHECK (("public"."get_user_role"() IS DISTINCT FROM 8));


COMMENT ON POLICY "parent_no_direct_access" ON "public"."direct_messages" IS 'Veli (rol 8) bu tabloyu doğrudan okuyamaz/yazamaz; mesajı kendi notifications satırından okur. Bkz. 20260930_direct_messages.sql.';


CREATE POLICY "parent_no_direct_access" ON "public"."discounts" AS RESTRICTIVE TO "authenticated" USING (("public"."get_user_role"() IS DISTINCT FROM 8)) WITH CHECK (("public"."get_user_role"() IS DISTINCT FROM 8));


COMMENT ON POLICY "parent_no_direct_access" ON "public"."discounts" IS 'Veli (rol 8) bu tabloyu doğrudan okuyamaz/yazamaz; görmesi gerekenler parent_* RPC''lerinden gelir. Restrictive: personelin erişimini değiştirmez. Bkz. 20260928_parent_app.sql.';


CREATE POLICY "parent_no_direct_access" ON "public"."financial_records" AS RESTRICTIVE TO "authenticated" USING (("public"."get_user_role"() IS DISTINCT FROM 8)) WITH CHECK (("public"."get_user_role"() IS DISTINCT FROM 8));


COMMENT ON POLICY "parent_no_direct_access" ON "public"."financial_records" IS 'Veli (rol 8) bu tabloyu doğrudan okuyamaz/yazamaz; görmesi gerekenler parent_* RPC''lerinden gelir. Restrictive: personelin erişimini değiştirmez. Bkz. 20260928_parent_app.sql.';


CREATE POLICY "parent_no_direct_access" ON "public"."income_expense_items" AS RESTRICTIVE TO "authenticated" USING (("public"."get_user_role"() IS DISTINCT FROM 8)) WITH CHECK (("public"."get_user_role"() IS DISTINCT FROM 8));


COMMENT ON POLICY "parent_no_direct_access" ON "public"."income_expense_items" IS 'Veli (rol 8) bu tabloyu doğrudan okuyamaz/yazamaz; görmesi gerekenler parent_* RPC''lerinden gelir. Restrictive: personelin erişimini değiştirmez. Bkz. 20260928_parent_app.sql.';


CREATE POLICY "parent_no_direct_access" ON "public"."notification_announcements" AS RESTRICTIVE TO "authenticated" USING (("public"."get_user_role"() IS DISTINCT FROM 8)) WITH CHECK (("public"."get_user_role"() IS DISTINCT FROM 8));


COMMENT ON POLICY "parent_no_direct_access" ON "public"."notification_announcements" IS 'Veli (rol 8) bu tabloyu doğrudan okuyamaz/yazamaz; görmesi gerekenler parent_* RPC''lerinden gelir. Restrictive: personelin erişimini değiştirmez. Bkz. 20260928_parent_app.sql.';


CREATE POLICY "parent_no_direct_access" ON "public"."parent_athlete_links" AS RESTRICTIVE TO "authenticated" USING (("public"."get_user_role"() IS DISTINCT FROM 8)) WITH CHECK (("public"."get_user_role"() IS DISTINCT FROM 8));


COMMENT ON POLICY "parent_no_direct_access" ON "public"."parent_athlete_links" IS 'Veli (rol 8) bu tabloyu doğrudan okuyamaz/yazamaz; görmesi gerekenler parent_* RPC''lerinden gelir. Restrictive: personelin erişimini değiştirmez. Bkz. 20260928_parent_app.sql.';


CREATE POLICY "parent_no_direct_access" ON "public"."pre_registration_links" AS RESTRICTIVE TO "authenticated" USING (("public"."get_user_role"() IS DISTINCT FROM 8)) WITH CHECK (("public"."get_user_role"() IS DISTINCT FROM 8));


COMMENT ON POLICY "parent_no_direct_access" ON "public"."pre_registration_links" IS 'Veli (rol 8) bu tabloyu doğrudan okuyamaz/yazamaz; görmesi gerekenler parent_* RPC''lerinden gelir. Restrictive: personelin erişimini değiştirmez. Bkz. 20260928_parent_app.sql.';


CREATE POLICY "parent_no_direct_access" ON "public"."pre_registrations" AS RESTRICTIVE TO "authenticated" USING (("public"."get_user_role"() IS DISTINCT FROM 8)) WITH CHECK (("public"."get_user_role"() IS DISTINCT FROM 8));


COMMENT ON POLICY "parent_no_direct_access" ON "public"."pre_registrations" IS 'Veli (rol 8) bu tabloyu doğrudan okuyamaz/yazamaz; görmesi gerekenler parent_* RPC''lerinden gelir. Restrictive: personelin erişimini değiştirmez. Bkz. 20260928_parent_app.sql.';


CREATE POLICY "parent_no_direct_access" ON "public"."profile_branch_links" AS RESTRICTIVE TO "authenticated" USING (("public"."get_user_role"() IS DISTINCT FROM 8)) WITH CHECK (("public"."get_user_role"() IS DISTINCT FROM 8));


COMMENT ON POLICY "parent_no_direct_access" ON "public"."profile_branch_links" IS 'Veli (rol 8) bu tabloyu doğrudan okuyamaz/yazamaz; görmesi gerekenler parent_* RPC''lerinden gelir. Restrictive: personelin erişimini değiştirmez. Bkz. 20260928_parent_app.sql.';


CREATE POLICY "parent_no_direct_access" ON "public"."profile_permissions" AS RESTRICTIVE TO "authenticated" USING (("public"."get_user_role"() IS DISTINCT FROM 8)) WITH CHECK (("public"."get_user_role"() IS DISTINCT FROM 8));


CREATE POLICY "parent_no_direct_access" ON "public"."profiles" AS RESTRICTIVE TO "authenticated" USING (("public"."get_user_role"() IS DISTINCT FROM 8)) WITH CHECK (("public"."get_user_role"() IS DISTINCT FROM 8));


COMMENT ON POLICY "parent_no_direct_access" ON "public"."profiles" IS 'Veli (rol 8) bu tabloyu doğrudan okuyamaz/yazamaz; görmesi gerekenler parent_* RPC''lerinden gelir. Restrictive: personelin erişimini değiştirmez. Bkz. 20260928_parent_app.sql.';


CREATE POLICY "parent_no_direct_access" ON "public"."sports" AS RESTRICTIVE TO "authenticated" USING (("public"."get_user_role"() IS DISTINCT FROM 8)) WITH CHECK (("public"."get_user_role"() IS DISTINCT FROM 8));


COMMENT ON POLICY "parent_no_direct_access" ON "public"."sports" IS 'Veli (rol 8) bu tabloyu doğrudan okuyamaz/yazamaz; görmesi gerekenler parent_* RPC''lerinden gelir. Restrictive: personelin erişimini değiştirmez. Bkz. 20260928_parent_app.sql.';


CREATE POLICY "parent_no_direct_access" ON "public"."transactions" AS RESTRICTIVE TO "authenticated" USING (("public"."get_user_role"() IS DISTINCT FROM 8)) WITH CHECK (("public"."get_user_role"() IS DISTINCT FROM 8));


COMMENT ON POLICY "parent_no_direct_access" ON "public"."transactions" IS 'Veli (rol 8) bu tabloyu doğrudan okuyamaz/yazamaz; görmesi gerekenler parent_* RPC''lerinden gelir. Restrictive: personelin erişimini değiştirmez. Bkz. 20260928_parent_app.sql.';


CREATE POLICY "pbl_select_policy" ON "public"."profile_branch_links" FOR SELECT TO "authenticated" USING ((("school_id" = "public"."get_user_school_id"()) AND ("is_deleted" IS NOT TRUE)));


ALTER TABLE "public"."pre_registration_attempts" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."pre_registration_links" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "pre_registration_links_select" ON "public"."pre_registration_links" FOR SELECT TO "authenticated" USING ((("school_id" = "public"."get_user_school_id"()) AND ("is_deleted" IS NOT TRUE) AND ( SELECT "public"."has_permission"('registration.manage'::"text") AS "has_permission")));


ALTER TABLE "public"."pre_registrations" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "pre_registrations_select" ON "public"."pre_registrations" FOR SELECT TO "authenticated" USING ((("school_id" = "public"."get_user_school_id"()) AND ("is_deleted" IS NOT TRUE) AND (EXISTS ( SELECT 1
   FROM "public"."branches" "b"
  WHERE (("b"."id" = "pre_registrations"."branch_id") AND ("b"."is_deleted" IS NOT TRUE))))));


ALTER TABLE "public"."profile_branch_links" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."profile_permissions" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "profile_permissions_select" ON "public"."profile_permissions" FOR SELECT TO "authenticated" USING ((("school_id" = "public"."get_user_school_id"()) AND ("is_deleted" IS NOT TRUE) AND (( SELECT "public"."has_permission"('users.manage'::"text") AS "has_permission") OR ("profile_id" = "auth"."uid"()))));


CREATE POLICY "profile_select_policy" ON "public"."profiles" FOR SELECT TO "authenticated" USING ((("school_id" = "public"."get_user_school_id"()) AND ("is_deleted" IS NOT TRUE) AND (("role_id" <> 8) OR (NOT (EXISTS ( SELECT 1
   FROM "public"."parent_athlete_links" "pal"
  WHERE (("pal"."profile_id" = "profiles"."id") AND ("pal"."is_deleted" IS NOT TRUE))))) OR (EXISTS ( SELECT 1
   FROM ("public"."parent_athlete_links" "pal"
     JOIN "public"."athletes" "a" ON (("a"."id" = "pal"."athlete_id")))
  WHERE (("pal"."profile_id" = "profiles"."id") AND ("pal"."is_deleted" IS NOT TRUE) AND ("a"."is_deleted" IS NOT TRUE)))))));


ALTER TABLE "public"."profiles" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "profiles_insert_policy" ON "public"."profiles" FOR INSERT TO "authenticated" WITH CHECK ((("role_id" = 8) AND ("school_id" = "public"."get_user_school_id"()) AND ( SELECT "public"."has_permission"('registration.manage'::"text") AS "has_permission")));


CREATE POLICY "profiles_update_policy" ON "public"."profiles" FOR UPDATE TO "authenticated" USING ((("role_id" = 8) AND ("school_id" = "public"."get_user_school_id"()) AND ( SELECT "public"."has_permission"('registration.manage'::"text") AS "has_permission") AND (( SELECT "public"."current_user_is_school_wide"() AS "current_user_is_school_wide") OR (NOT (EXISTS ( SELECT 1
   FROM "public"."profile_branch_links" "pbl"
  WHERE (("pbl"."profile_id" = "profiles"."id") AND ("pbl"."is_deleted" IS NOT TRUE) AND (NOT ("pbl"."branch_id" IN ( SELECT "public"."current_user_branch_ids"() AS "current_user_branch_ids")))))))))) WITH CHECK ((("role_id" = 8) AND ("school_id" = "public"."get_user_school_id"()) AND ( SELECT "public"."has_permission"('registration.manage'::"text") AS "has_permission") AND (( SELECT "public"."current_user_is_school_wide"() AS "current_user_is_school_wide") OR (NOT (EXISTS ( SELECT 1
   FROM "public"."profile_branch_links" "pbl"
  WHERE (("pbl"."profile_id" = "profiles"."id") AND ("pbl"."is_deleted" IS NOT TRUE) AND (NOT ("pbl"."branch_id" IN ( SELECT "public"."current_user_branch_ids"() AS "current_user_branch_ids"))))))))));


COMMENT ON POLICY "profiles_update_policy" ON "public"."profiles" IS 'Veli satırı (20261017): registration.manage ve velinin bütün şubeleri çağıranın kapsamında. can_manage_parent ile aynı kural; birlikte değiştirin.';


ALTER TABLE "public"."push_tokens" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "registration_branch_scope" ON "public"."athletes" AS RESTRICTIVE FOR SELECT TO "authenticated" USING (("branch_id" IN ( SELECT "public"."current_user_branch_ids"() AS "current_user_branch_ids")));


COMMENT ON POLICY "registration_branch_scope" ON "public"."athletes" IS 'Şube kapsamı (20261016): okul geneli olmayan rol yalnızca kendi şubelerinin satırlarını okur.';


CREATE POLICY "registration_branch_scope" ON "public"."attendances" AS RESTRICTIVE FOR SELECT TO "authenticated" USING (("branch_id" IN ( SELECT "public"."current_user_branch_ids"() AS "current_user_branch_ids")));


COMMENT ON POLICY "registration_branch_scope" ON "public"."attendances" IS 'Şube kapsamı (20261016): okul geneli olmayan rol yalnızca kendi şubelerinin satırlarını okur.';


CREATE POLICY "registration_branch_scope" ON "public"."classes" AS RESTRICTIVE FOR SELECT TO "authenticated" USING (("branch_id" IN ( SELECT "public"."current_user_branch_ids"() AS "current_user_branch_ids")));


COMMENT ON POLICY "registration_branch_scope" ON "public"."classes" IS 'Şube kapsamı (20261016): okul geneli olmayan rol yalnızca kendi şubelerinin satırlarını okur.';


CREATE POLICY "registration_branch_scope" ON "public"."pre_registrations" AS RESTRICTIVE FOR SELECT TO "authenticated" USING (("branch_id" IN ( SELECT "public"."current_user_branch_ids"() AS "current_user_branch_ids")));


COMMENT ON POLICY "registration_branch_scope" ON "public"."pre_registrations" IS 'Şube kapsamı (20261016): okul geneli olmayan rol yalnızca kendi şubelerinin satırlarını okur.';


ALTER TABLE "public"."role_permissions" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "role_permissions_select" ON "public"."role_permissions" FOR SELECT TO "authenticated" USING (true);


ALTER TABLE "public"."roles" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "roles_select_policy" ON "public"."roles" FOR SELECT TO "authenticated" USING (true);


ALTER TABLE "public"."schools" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "schools_select_own" ON "public"."schools" FOR SELECT TO "authenticated" USING (((("id" IN ( SELECT "p"."school_id"
   FROM "public"."profiles" "p"
  WHERE ("p"."id" = "auth"."uid"()))) OR ("owner_id" = "auth"."uid"())) AND ("is_deleted" IS NOT TRUE)));


COMMENT ON POLICY "schools_select_own" ON "public"."schools" IS 'Kullanıcı yalnızca kendi okulunu (veya sahibi olduğu okulu) görür. Tabloda İKİNCİ bir select politikası olmamalı: politikalar OR''lanır, kapsamsız bir politika bunun korumasını tümden boşa çıkarır — "Public read access" tam olarak bunu yapıyordu.';


CREATE POLICY "select for all" ON "public"."income_expense_items" FOR SELECT TO "authenticated" USING ((("school_id" = "public"."get_user_school_id"()) AND ("is_deleted" IS NOT TRUE)));


CREATE POLICY "select for all" ON "public"."parent_athlete_links" FOR SELECT TO "authenticated" USING ((("school_id" = "public"."get_user_school_id"()) AND ("is_deleted" IS NOT TRUE)));


CREATE POLICY "select_policy" ON "public"."branch_discount_links" FOR SELECT TO "authenticated" USING ((("school_id" = "public"."get_user_school_id"()) AND ("is_deleted" IS NOT TRUE) AND (EXISTS ( SELECT 1
   FROM "public"."branches" "b"
  WHERE (("b"."id" = "branch_discount_links"."branch_id") AND ("b"."is_deleted" IS NOT TRUE))))));


CREATE POLICY "select_policy" ON "public"."branch_income_expense_item_links" FOR SELECT TO "authenticated" USING ((("school_id" = "public"."get_user_school_id"()) AND ("is_deleted" IS NOT TRUE) AND (EXISTS ( SELECT 1
   FROM "public"."branches" "b"
  WHERE (("b"."id" = "branch_income_expense_item_links"."branch_id") AND ("b"."is_deleted" IS NOT TRUE))))));


CREATE POLICY "select_policy" ON "public"."customers" FOR SELECT TO "authenticated" USING ((("school_id" = "public"."get_user_school_id"()) AND ("is_deleted" IS NOT TRUE)));


CREATE POLICY "select_policy" ON "public"."discounts" FOR SELECT TO "authenticated" USING ((("school_id" = "public"."get_user_school_id"()) AND ("is_deleted" IS NOT TRUE)));


CREATE POLICY "select_policy" ON "public"."financial_records" FOR SELECT TO "authenticated" USING ((("school_id" = "public"."get_user_school_id"()) AND ("is_deleted" IS NOT TRUE) AND (EXISTS ( SELECT 1
   FROM "public"."branches" "b"
  WHERE (("b"."id" = "financial_records"."branch_id") AND ("b"."is_deleted" IS NOT TRUE))))));


CREATE POLICY "select_policy" ON "public"."transactions" FOR SELECT TO "authenticated" USING ((("school_id" = "public"."get_user_school_id"()) AND ("is_deleted" IS NOT TRUE) AND (EXISTS ( SELECT 1
   FROM "public"."branches" "b"
  WHERE (("b"."id" = "transactions"."branch_id") AND ("b"."is_deleted" IS NOT TRUE))))));


ALTER TABLE "public"."site_leads" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."sports" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "sports_select_policy" ON "public"."sports" FOR SELECT TO "authenticated" USING ((("school_id" = "public"."get_user_school_id"()) AND ("is_deleted" IS NOT TRUE) AND (EXISTS ( SELECT 1
   FROM ("public"."branch_sport_links" "bsl"
     JOIN "public"."branches" "b" ON (("b"."id" = "bsl"."branch_id")))
  WHERE (("bsl"."sport_id" = "sports"."id") AND ("bsl"."is_deleted" IS NOT TRUE) AND ("b"."is_deleted" IS NOT TRUE))))));


ALTER TABLE "public"."transactions" ENABLE ROW LEVEL SECURITY;


GRANT USAGE ON SCHEMA "public" TO "postgres";
GRANT USAGE ON SCHEMA "public" TO "anon";
GRANT USAGE ON SCHEMA "public" TO "authenticated";
GRANT USAGE ON SCHEMA "public" TO "service_role";


REVOKE ALL ON FUNCTION "public"."acknowledge_privacy_notice"("p_version" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."acknowledge_privacy_notice"("p_version" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."acknowledge_privacy_notice"("p_version" "text") TO "service_role";


GRANT ALL ON FUNCTION "public"."app_err"("p_message" "text", "p_code" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."app_err"("p_message" "text", "p_code" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."app_err"("p_message" "text", "p_code" "text") TO "service_role";


GRANT ALL ON FUNCTION "public"."app_local_date"() TO "anon";
GRANT ALL ON FUNCTION "public"."app_local_date"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."app_local_date"() TO "service_role";


REVOKE ALL ON FUNCTION "public"."app_local_now"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."app_local_now"() TO "service_role";


GRANT ALL ON FUNCTION "public"."app_ok"("p_message" "text", "p_data" "jsonb") TO "anon";
GRANT ALL ON FUNCTION "public"."app_ok"("p_message" "text", "p_data" "jsonb") TO "authenticated";
GRANT ALL ON FUNCTION "public"."app_ok"("p_message" "text", "p_data" "jsonb") TO "service_role";


GRANT ALL ON FUNCTION "public"."app_sqlstate_code"("p_sqlstate" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."app_sqlstate_code"("p_sqlstate" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."app_sqlstate_code"("p_sqlstate" "text") TO "service_role";


REVOKE ALL ON FUNCTION "public"."attendances_after_insert_notify"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."attendances_after_insert_notify"() TO "service_role";


REVOKE ALL ON FUNCTION "public"."attendances_after_update_notify"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."attendances_after_update_notify"() TO "service_role";


REVOKE ALL ON FUNCTION "public"."birthday_falls_on"("p_date_of_birth" "date", "p_day" "date") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."birthday_falls_on"("p_date_of_birth" "date", "p_day" "date") TO "service_role";


REVOKE ALL ON FUNCTION "public"."bulk_delete_athletes"("p_athlete_ids" "uuid"[]) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."bulk_delete_athletes"("p_athlete_ids" "uuid"[]) TO "authenticated";
GRANT ALL ON FUNCTION "public"."bulk_delete_athletes"("p_athlete_ids" "uuid"[]) TO "service_role";


REVOKE ALL ON FUNCTION "public"."bulk_delete_pre_registrations"("p_pre_registration_ids" "uuid"[]) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."bulk_delete_pre_registrations"("p_pre_registration_ids" "uuid"[]) TO "authenticated";
GRANT ALL ON FUNCTION "public"."bulk_delete_pre_registrations"("p_pre_registration_ids" "uuid"[]) TO "service_role";


REVOKE ALL ON FUNCTION "public"."can_manage_accounting"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."can_manage_accounting"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."can_manage_accounting"() TO "service_role";


REVOKE ALL ON FUNCTION "public"."can_manage_parent"("p_parent_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."can_manage_parent"("p_parent_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."can_manage_parent"("p_parent_id" "uuid") TO "service_role";


REVOKE ALL ON FUNCTION "public"."can_message_athlete"("p_athlete_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."can_message_athlete"("p_athlete_id" "uuid") TO "service_role";


REVOKE ALL ON FUNCTION "public"."can_parent_delete_athlete_photo"("p_object_name" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."can_parent_delete_athlete_photo"("p_object_name" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."can_parent_delete_athlete_photo"("p_object_name" "text") TO "service_role";


REVOKE ALL ON FUNCTION "public"."can_read_athlete_photo"("p_object_name" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."can_read_athlete_photo"("p_object_name" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."can_read_athlete_photo"("p_object_name" "text") TO "service_role";


REVOKE ALL ON FUNCTION "public"."can_write_athlete_photo"("p_object_name" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."can_write_athlete_photo"("p_object_name" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."can_write_athlete_photo"("p_object_name" "text") TO "service_role";


REVOKE ALL ON FUNCTION "public"."claim_push_batch"("p_limit" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."claim_push_batch"("p_limit" integer) TO "service_role";


REVOKE ALL ON FUNCTION "public"."class_coaches_error"("p_coach_ids" "uuid"[], "p_branch_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."class_coaches_error"("p_coach_ids" "uuid"[], "p_branch_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."class_coaches_error"("p_coach_ids" "uuid"[], "p_branch_id" "uuid") TO "service_role";


REVOKE ALL ON FUNCTION "public"."class_has_active_coach"("p_class_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."class_has_active_coach"("p_class_id" "uuid") TO "service_role";


REVOKE ALL ON FUNCTION "public"."class_meets_on"("p_class_id" "uuid", "p_day" "date") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."class_meets_on"("p_class_id" "uuid", "p_day" "date") TO "service_role";


REVOKE ALL ON FUNCTION "public"."class_schedule_error"("p_schedule" "jsonb") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."class_schedule_error"("p_schedule" "jsonb") TO "authenticated";
GRANT ALL ON FUNCTION "public"."class_schedule_error"("p_schedule" "jsonb") TO "service_role";


REVOKE ALL ON FUNCTION "public"."class_start_time_on"("p_class_id" "uuid", "p_day" "date") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."class_start_time_on"("p_class_id" "uuid", "p_day" "date") TO "service_role";


REVOKE ALL ON FUNCTION "public"."coach_classes_error"("p_coach_id" "uuid", "p_role_id" bigint, "p_status" "public"."approval_status", "p_branch_ids" "uuid"[], "p_class_ids" "uuid"[]) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."coach_classes_error"("p_coach_id" "uuid", "p_role_id" bigint, "p_status" "public"."approval_status", "p_branch_ids" "uuid"[], "p_class_ids" "uuid"[]) TO "service_role";


REVOKE ALL ON FUNCTION "public"."complete_push_batch"("p_sent" "uuid"[], "p_failed" "uuid"[], "p_invalid_tokens" "text"[]) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."complete_push_batch"("p_sent" "uuid"[], "p_failed" "uuid"[], "p_invalid_tokens" "text"[]) TO "service_role";


REVOKE ALL ON FUNCTION "public"."convert_pre_registration"("p_pre_registration_id" "uuid", "p_parent_ids" "uuid"[]) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."convert_pre_registration"("p_pre_registration_id" "uuid", "p_parent_ids" "uuid"[]) TO "authenticated";
GRANT ALL ON FUNCTION "public"."convert_pre_registration"("p_pre_registration_id" "uuid", "p_parent_ids" "uuid"[]) TO "service_role";


REVOKE ALL ON FUNCTION "public"."create_athlete"("p_branch_id" "uuid", "p_gender" "public"."gender_type", "p_date_of_birth" "date", "p_approval_status" "public"."approval_status", "p_school_id" "uuid", "p_class_id" "uuid", "p_full_name" "text", "p_parent_ids" "uuid"[], "p_blood_type" "public"."blood_type", "p_license_number" "text", "p_height" numeric, "p_weight" numeric, "p_photo_url" "text", "p_address" "text", "p_registration_date" "date", "p_contract_end_date" "date", "p_phone_number" "text", "p_national_id" "text", "p_health_problems" "text", "p_has_health_report" boolean, "p_health_consent" boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."create_athlete"("p_branch_id" "uuid", "p_gender" "public"."gender_type", "p_date_of_birth" "date", "p_approval_status" "public"."approval_status", "p_school_id" "uuid", "p_class_id" "uuid", "p_full_name" "text", "p_parent_ids" "uuid"[], "p_blood_type" "public"."blood_type", "p_license_number" "text", "p_height" numeric, "p_weight" numeric, "p_photo_url" "text", "p_address" "text", "p_registration_date" "date", "p_contract_end_date" "date", "p_phone_number" "text", "p_national_id" "text", "p_health_problems" "text", "p_has_health_report" boolean, "p_health_consent" boolean) TO "authenticated";
GRANT ALL ON FUNCTION "public"."create_athlete"("p_branch_id" "uuid", "p_gender" "public"."gender_type", "p_date_of_birth" "date", "p_approval_status" "public"."approval_status", "p_school_id" "uuid", "p_class_id" "uuid", "p_full_name" "text", "p_parent_ids" "uuid"[], "p_blood_type" "public"."blood_type", "p_license_number" "text", "p_height" numeric, "p_weight" numeric, "p_photo_url" "text", "p_address" "text", "p_registration_date" "date", "p_contract_end_date" "date", "p_phone_number" "text", "p_national_id" "text", "p_health_problems" "text", "p_has_health_report" boolean, "p_health_consent" boolean) TO "service_role";


REVOKE ALL ON FUNCTION "public"."create_branch"("p_school_id" "uuid", "p_name" "text", "p_address" "text", "p_email" "text", "p_phone_number" "text", "p_phone_number_2" "text", "p_company_title" "text", "p_billing_address" "text", "p_tax_address" "text", "p_tax_number" "text", "p_trade_registry_number" "text", "p_mersis_number" "text", "p_tax_office_province_code" "text", "p_iban" "text", "p_status" "public"."approval_status") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."create_branch"("p_school_id" "uuid", "p_name" "text", "p_address" "text", "p_email" "text", "p_phone_number" "text", "p_phone_number_2" "text", "p_company_title" "text", "p_billing_address" "text", "p_tax_address" "text", "p_tax_number" "text", "p_trade_registry_number" "text", "p_mersis_number" "text", "p_tax_office_province_code" "text", "p_iban" "text", "p_status" "public"."approval_status") TO "authenticated";
GRANT ALL ON FUNCTION "public"."create_branch"("p_school_id" "uuid", "p_name" "text", "p_address" "text", "p_email" "text", "p_phone_number" "text", "p_phone_number_2" "text", "p_company_title" "text", "p_billing_address" "text", "p_tax_address" "text", "p_tax_number" "text", "p_trade_registry_number" "text", "p_mersis_number" "text", "p_tax_office_province_code" "text", "p_iban" "text", "p_status" "public"."approval_status") TO "service_role";


REVOKE ALL ON FUNCTION "public"."create_class"("p_name" "text", "p_branch_id" "uuid", "p_sport_id" "uuid", "p_school_id" "uuid", "p_quota" smallint, "p_athlete_ids" "uuid"[], "p_schedule" "jsonb", "p_coach_ids" "uuid"[]) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."create_class"("p_name" "text", "p_branch_id" "uuid", "p_sport_id" "uuid", "p_school_id" "uuid", "p_quota" smallint, "p_athlete_ids" "uuid"[], "p_schedule" "jsonb", "p_coach_ids" "uuid"[]) TO "authenticated";
GRANT ALL ON FUNCTION "public"."create_class"("p_name" "text", "p_branch_id" "uuid", "p_sport_id" "uuid", "p_school_id" "uuid", "p_quota" smallint, "p_athlete_ids" "uuid"[], "p_schedule" "jsonb", "p_coach_ids" "uuid"[]) TO "service_role";


REVOKE ALL ON FUNCTION "public"."create_customer"("p_display_name" "text", "p_type" "public"."customer_type", "p_phone" "text", "p_athlete_id" "uuid", "p_profile_id" "uuid", "p_email" "text", "p_national_id" "text", "p_address" "text", "p_school_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."create_customer"("p_display_name" "text", "p_type" "public"."customer_type", "p_phone" "text", "p_athlete_id" "uuid", "p_profile_id" "uuid", "p_email" "text", "p_national_id" "text", "p_address" "text", "p_school_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."create_customer"("p_display_name" "text", "p_type" "public"."customer_type", "p_phone" "text", "p_athlete_id" "uuid", "p_profile_id" "uuid", "p_email" "text", "p_national_id" "text", "p_address" "text", "p_school_id" "uuid") TO "service_role";


REVOKE ALL ON FUNCTION "public"."create_discount"("p_name" "text", "p_type" "public"."discount_type", "p_value" numeric, "p_branch_ids" "uuid"[]) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."create_discount"("p_name" "text", "p_type" "public"."discount_type", "p_value" numeric, "p_branch_ids" "uuid"[]) TO "authenticated";
GRANT ALL ON FUNCTION "public"."create_discount"("p_name" "text", "p_type" "public"."discount_type", "p_value" numeric, "p_branch_ids" "uuid"[]) TO "service_role";


REVOKE ALL ON FUNCTION "public"."create_financial_record"("p_customer_id" "uuid", "p_type" "public"."accounting_type", "p_name" "text", "p_expected_date" "date", "p_net_amount" numeric, "p_income_expense_item_id" "uuid", "p_discount_id" "uuid", "p_branch_id" "uuid", "p_school_id" "uuid", "p_description" "text", "p_invoice_no" "text", "p_reminder_date" "date", "p_base_amount" numeric, "p_discount_amount" numeric, "p_tax_rate" integer, "p_tax_included" boolean, "p_created_by" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."create_financial_record"("p_customer_id" "uuid", "p_type" "public"."accounting_type", "p_name" "text", "p_expected_date" "date", "p_net_amount" numeric, "p_income_expense_item_id" "uuid", "p_discount_id" "uuid", "p_branch_id" "uuid", "p_school_id" "uuid", "p_description" "text", "p_invoice_no" "text", "p_reminder_date" "date", "p_base_amount" numeric, "p_discount_amount" numeric, "p_tax_rate" integer, "p_tax_included" boolean, "p_created_by" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."create_financial_record"("p_customer_id" "uuid", "p_type" "public"."accounting_type", "p_name" "text", "p_expected_date" "date", "p_net_amount" numeric, "p_income_expense_item_id" "uuid", "p_discount_id" "uuid", "p_branch_id" "uuid", "p_school_id" "uuid", "p_description" "text", "p_invoice_no" "text", "p_reminder_date" "date", "p_base_amount" numeric, "p_discount_amount" numeric, "p_tax_rate" integer, "p_tax_included" boolean, "p_created_by" "uuid") TO "service_role";


REVOKE ALL ON FUNCTION "public"."create_income_expense_item"("p_name" "text", "p_type" "public"."transaction_type", "p_value" numeric, "p_branch_ids" "uuid"[]) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."create_income_expense_item"("p_name" "text", "p_type" "public"."transaction_type", "p_value" numeric, "p_branch_ids" "uuid"[]) TO "authenticated";
GRANT ALL ON FUNCTION "public"."create_income_expense_item"("p_name" "text", "p_type" "public"."transaction_type", "p_value" numeric, "p_branch_ids" "uuid"[]) TO "service_role";


REVOKE ALL ON FUNCTION "public"."create_pre_registration"("p_full_name" "text", "p_gender" "text", "p_date_of_birth" "date", "p_branch_id" "uuid", "p_class_id" "uuid", "p_interviewer_name" "text", "p_interview_type" "text", "p_interview_date" "date", "p_parent_full_name" "text", "p_parent_phone" "text", "p_parent_email" "text", "p_national_id" "text", "p_phone" "text", "p_address" "text", "p_height" "text", "p_weight" "text", "p_health_problems" "text", "p_has_health_report" boolean, "p_has_sports_history" boolean, "p_parent2_full_name" "text", "p_parent2_phone" "text", "p_parent2_email" "text", "p_contract_possibility" "text", "p_referral_source" "text", "p_status" "text", "p_health_consent" boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."create_pre_registration"("p_full_name" "text", "p_gender" "text", "p_date_of_birth" "date", "p_branch_id" "uuid", "p_class_id" "uuid", "p_interviewer_name" "text", "p_interview_type" "text", "p_interview_date" "date", "p_parent_full_name" "text", "p_parent_phone" "text", "p_parent_email" "text", "p_national_id" "text", "p_phone" "text", "p_address" "text", "p_height" "text", "p_weight" "text", "p_health_problems" "text", "p_has_health_report" boolean, "p_has_sports_history" boolean, "p_parent2_full_name" "text", "p_parent2_phone" "text", "p_parent2_email" "text", "p_contract_possibility" "text", "p_referral_source" "text", "p_status" "text", "p_health_consent" boolean) TO "authenticated";
GRANT ALL ON FUNCTION "public"."create_pre_registration"("p_full_name" "text", "p_gender" "text", "p_date_of_birth" "date", "p_branch_id" "uuid", "p_class_id" "uuid", "p_interviewer_name" "text", "p_interview_type" "text", "p_interview_date" "date", "p_parent_full_name" "text", "p_parent_phone" "text", "p_parent_email" "text", "p_national_id" "text", "p_phone" "text", "p_address" "text", "p_height" "text", "p_weight" "text", "p_health_problems" "text", "p_has_health_report" boolean, "p_has_sports_history" boolean, "p_parent2_full_name" "text", "p_parent2_phone" "text", "p_parent2_email" "text", "p_contract_possibility" "text", "p_referral_source" "text", "p_status" "text", "p_health_consent" boolean) TO "service_role";


REVOKE ALL ON FUNCTION "public"."create_public_pre_registration"("p_school_id" "uuid", "p_full_name" "text", "p_gender" "text", "p_date_of_birth" "date", "p_branch_id" "uuid", "p_class_id" "uuid", "p_national_id" "text", "p_phone" "text", "p_height" "text", "p_weight" "text", "p_health_problems" "text", "p_has_health_report" boolean, "p_has_sports_history" boolean, "p_address" "text", "p_parent_full_name" "text", "p_parent_phone" "text", "p_parent_email" "text", "p_parent2_full_name" "text", "p_parent2_phone" "text", "p_parent2_email" "text", "p_interview_date" "date", "p_referral_source" "text", "p_kvkk_approved" boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."create_public_pre_registration"("p_school_id" "uuid", "p_full_name" "text", "p_gender" "text", "p_date_of_birth" "date", "p_branch_id" "uuid", "p_class_id" "uuid", "p_national_id" "text", "p_phone" "text", "p_height" "text", "p_weight" "text", "p_health_problems" "text", "p_has_health_report" boolean, "p_has_sports_history" boolean, "p_address" "text", "p_parent_full_name" "text", "p_parent_phone" "text", "p_parent_email" "text", "p_parent2_full_name" "text", "p_parent2_phone" "text", "p_parent2_email" "text", "p_interview_date" "date", "p_referral_source" "text", "p_kvkk_approved" boolean) TO "service_role";


REVOKE ALL ON FUNCTION "public"."create_public_pre_registration_by_token"("p_token" "text", "p_full_name" "text", "p_gender" "text", "p_date_of_birth" "date", "p_branch_id" "uuid", "p_class_id" "uuid", "p_national_id" "text", "p_phone" "text", "p_height" "text", "p_weight" "text", "p_health_problems" "text", "p_has_health_report" boolean, "p_has_sports_history" boolean, "p_address" "text", "p_parent_full_name" "text", "p_parent_phone" "text", "p_parent_email" "text", "p_parent2_full_name" "text", "p_parent2_phone" "text", "p_parent2_email" "text", "p_interview_date" "date", "p_referral_source" "text", "p_kvkk_approved" boolean, "p_health_consent" boolean, "p_photo_consent" boolean, "p_promo_photo_consent" boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."create_public_pre_registration_by_token"("p_token" "text", "p_full_name" "text", "p_gender" "text", "p_date_of_birth" "date", "p_branch_id" "uuid", "p_class_id" "uuid", "p_national_id" "text", "p_phone" "text", "p_height" "text", "p_weight" "text", "p_health_problems" "text", "p_has_health_report" boolean, "p_has_sports_history" boolean, "p_address" "text", "p_parent_full_name" "text", "p_parent_phone" "text", "p_parent_email" "text", "p_parent2_full_name" "text", "p_parent2_phone" "text", "p_parent2_email" "text", "p_interview_date" "date", "p_referral_source" "text", "p_kvkk_approved" boolean, "p_health_consent" boolean, "p_photo_consent" boolean, "p_promo_photo_consent" boolean) TO "service_role";


REVOKE ALL ON FUNCTION "public"."create_school"("p_name" "text", "p_city" "text", "p_district" "text", "p_address" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."create_school"("p_name" "text", "p_city" "text", "p_district" "text", "p_address" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."create_school"("p_name" "text", "p_city" "text", "p_district" "text", "p_address" "text") TO "service_role";


REVOKE ALL ON FUNCTION "public"."create_sport"("p_name" "text", "p_school_id" "uuid", "p_branch_ids" "uuid"[]) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."create_sport"("p_name" "text", "p_school_id" "uuid", "p_branch_ids" "uuid"[]) TO "authenticated";
GRANT ALL ON FUNCTION "public"."create_sport"("p_name" "text", "p_school_id" "uuid", "p_branch_ids" "uuid"[]) TO "service_role";


REVOKE ALL ON FUNCTION "public"."create_transaction"("p_record_id" "uuid", "p_amount" numeric, "p_method" "public"."payment_method", "p_transaction_date" timestamp with time zone, "p_processed_by" "uuid", "p_school_id" "uuid", "p_branch_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."create_transaction"("p_record_id" "uuid", "p_amount" numeric, "p_method" "public"."payment_method", "p_transaction_date" timestamp with time zone, "p_processed_by" "uuid", "p_school_id" "uuid", "p_branch_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."create_transaction"("p_record_id" "uuid", "p_amount" numeric, "p_method" "public"."payment_method", "p_transaction_date" timestamp with time zone, "p_processed_by" "uuid", "p_school_id" "uuid", "p_branch_id" "uuid") TO "service_role";


REVOKE ALL ON FUNCTION "public"."current_user_branch_ids"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."current_user_branch_ids"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."current_user_branch_ids"() TO "service_role";


REVOKE ALL ON FUNCTION "public"."current_user_is_school_wide"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."current_user_is_school_wide"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."current_user_is_school_wide"() TO "service_role";


REVOKE ALL ON FUNCTION "public"."customer_in_scope"("p_customer_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."customer_in_scope"("p_customer_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."customer_in_scope"("p_customer_id" "uuid") TO "service_role";


REVOKE ALL ON FUNCTION "public"."delete_athlete"("p_athlete_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."delete_athlete"("p_athlete_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."delete_athlete"("p_athlete_id" "uuid") TO "service_role";


REVOKE ALL ON FUNCTION "public"."delete_branch"("p_branch_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."delete_branch"("p_branch_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."delete_branch"("p_branch_id" "uuid") TO "service_role";


REVOKE ALL ON FUNCTION "public"."delete_class"("p_class_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."delete_class"("p_class_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."delete_class"("p_class_id" "uuid") TO "service_role";


REVOKE ALL ON FUNCTION "public"."delete_class_attendance"("p_class_id" "uuid", "p_attendance_date" "date") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."delete_class_attendance"("p_class_id" "uuid", "p_attendance_date" "date") TO "authenticated";
GRANT ALL ON FUNCTION "public"."delete_class_attendance"("p_class_id" "uuid", "p_attendance_date" "date") TO "service_role";


REVOKE ALL ON FUNCTION "public"."delete_coach"("p_coach_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."delete_coach"("p_coach_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."delete_coach"("p_coach_id" "uuid") TO "service_role";


REVOKE ALL ON FUNCTION "public"."delete_customer"("p_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."delete_customer"("p_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."delete_customer"("p_id" "uuid") TO "service_role";


REVOKE ALL ON FUNCTION "public"."delete_discount"("p_discount_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."delete_discount"("p_discount_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."delete_discount"("p_discount_id" "uuid") TO "service_role";


REVOKE ALL ON FUNCTION "public"."delete_financial_record"("p_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."delete_financial_record"("p_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."delete_financial_record"("p_id" "uuid") TO "service_role";


REVOKE ALL ON FUNCTION "public"."delete_income_expense_item"("p_item_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."delete_income_expense_item"("p_item_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."delete_income_expense_item"("p_item_id" "uuid") TO "service_role";


REVOKE ALL ON FUNCTION "public"."delete_own_account"("p_user_id" "uuid", "p_validate_only" boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."delete_own_account"("p_user_id" "uuid", "p_validate_only" boolean) TO "service_role";


REVOKE ALL ON FUNCTION "public"."delete_parent"("p_parent_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."delete_parent"("p_parent_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."delete_parent"("p_parent_id" "uuid") TO "service_role";


REVOKE ALL ON FUNCTION "public"."delete_pre_registration"("p_pre_registration_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."delete_pre_registration"("p_pre_registration_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."delete_pre_registration"("p_pre_registration_id" "uuid") TO "service_role";


REVOKE ALL ON FUNCTION "public"."delete_school"("p_school_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."delete_school"("p_school_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."delete_school"("p_school_id" "uuid") TO "service_role";


REVOKE ALL ON FUNCTION "public"."delete_sport"("p_sport_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."delete_sport"("p_sport_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."delete_sport"("p_sport_id" "uuid") TO "service_role";


REVOKE ALL ON FUNCTION "public"."delete_transaction"("p_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."delete_transaction"("p_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."delete_transaction"("p_id" "uuid") TO "service_role";


REVOKE ALL ON FUNCTION "public"."delete_user"("p_user_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."delete_user"("p_user_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."delete_user"("p_user_id" "uuid") TO "service_role";


REVOKE ALL ON FUNCTION "public"."direct_message_recipients"("p_athlete_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."direct_message_recipients"("p_athlete_id" "uuid") TO "service_role";


REVOKE ALL ON FUNCTION "public"."discount_visible"("p_discount_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."discount_visible"("p_discount_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."discount_visible"("p_discount_id" "uuid") TO "service_role";


REVOKE ALL ON FUNCTION "public"."discount_writable"("p_discount_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."discount_writable"("p_discount_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."discount_writable"("p_discount_id" "uuid") TO "service_role";


GRANT ALL ON FUNCTION "public"."enforce_athlete_health_consent"() TO "anon";
GRANT ALL ON FUNCTION "public"."enforce_athlete_health_consent"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."enforce_athlete_health_consent"() TO "service_role";


GRANT ALL ON FUNCTION "public"."enforce_pre_registration_health_consent"() TO "anon";
GRANT ALL ON FUNCTION "public"."enforce_pre_registration_health_consent"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."enforce_pre_registration_health_consent"() TO "service_role";


REVOKE ALL ON FUNCTION "public"."enqueue_attendance_reminders"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."enqueue_attendance_reminders"() TO "service_role";


REVOKE ALL ON FUNCTION "public"."enqueue_birthday_upcoming_notifications"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."enqueue_birthday_upcoming_notifications"() TO "service_role";


REVOKE ALL ON FUNCTION "public"."enqueue_morning_notifications"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."enqueue_morning_notifications"() TO "service_role";


REVOKE ALL ON FUNCTION "public"."enqueue_parent_payment_notifications"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."enqueue_parent_payment_notifications"() TO "service_role";


REVOKE ALL ON FUNCTION "public"."finance_branch_ok"("p_branch_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."finance_branch_ok"("p_branch_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."finance_branch_ok"("p_branch_id" "uuid") TO "service_role";


REVOKE ALL ON FUNCTION "public"."generate_pre_registration_token"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."generate_pre_registration_token"() TO "service_role";


REVOKE ALL ON FUNCTION "public"."get_athlete_profile_summary"("p_athlete_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."get_athlete_profile_summary"("p_athlete_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_athlete_profile_summary"("p_athlete_id" "uuid") TO "service_role";


REVOKE ALL ON FUNCTION "public"."get_attendance_analytics"("p_school_id" "uuid", "p_start_date" "date", "p_end_date" "date", "p_branch_id" "uuid", "p_class_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."get_attendance_analytics"("p_school_id" "uuid", "p_start_date" "date", "p_end_date" "date", "p_branch_id" "uuid", "p_class_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_attendance_analytics"("p_school_id" "uuid", "p_start_date" "date", "p_end_date" "date", "p_branch_id" "uuid", "p_class_id" "uuid") TO "service_role";


REVOKE ALL ON FUNCTION "public"."get_coach_sole_classes"("p_coach_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."get_coach_sole_classes"("p_coach_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_coach_sole_classes"("p_coach_id" "uuid") TO "service_role";


REVOKE ALL ON FUNCTION "public"."get_daily_attendance"("p_school_id" "uuid", "p_attendance_date" "date", "p_branch_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."get_daily_attendance"("p_school_id" "uuid", "p_attendance_date" "date", "p_branch_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_daily_attendance"("p_school_id" "uuid", "p_attendance_date" "date", "p_branch_id" "uuid") TO "service_role";


REVOKE ALL ON FUNCTION "public"."get_dashboard_overview"("p_branch_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."get_dashboard_overview"("p_branch_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_dashboard_overview"("p_branch_id" "uuid") TO "service_role";


REVOKE ALL ON FUNCTION "public"."get_direct_message_targets"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."get_direct_message_targets"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_direct_message_targets"() TO "service_role";


REVOKE ALL ON FUNCTION "public"."get_min_app_version"("p_app" "text", "p_platform" "text", "p_brand" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."get_min_app_version"("p_app" "text", "p_platform" "text", "p_brand" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."get_min_app_version"("p_app" "text", "p_platform" "text", "p_brand" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_min_app_version"("p_app" "text", "p_platform" "text", "p_brand" "text") TO "service_role";


REVOKE ALL ON FUNCTION "public"."get_pre_registration_link"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."get_pre_registration_link"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_pre_registration_link"() TO "service_role";


REVOKE ALL ON FUNCTION "public"."get_sent_direct_messages"("p_limit" integer, "p_before" timestamp with time zone) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."get_sent_direct_messages"("p_limit" integer, "p_before" timestamp with time zone) TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_sent_direct_messages"("p_limit" integer, "p_before" timestamp with time zone) TO "service_role";


REVOKE ALL ON FUNCTION "public"."get_session_data"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."get_session_data"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_session_data"() TO "service_role";


REVOKE ALL ON FUNCTION "public"."get_setup_progress"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."get_setup_progress"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_setup_progress"() TO "service_role";


REVOKE ALL ON FUNCTION "public"."get_user_role"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."get_user_role"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_user_role"() TO "service_role";


REVOKE ALL ON FUNCTION "public"."get_user_school_id"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."get_user_school_id"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_user_school_id"() TO "service_role";


REVOKE ALL ON FUNCTION "public"."grant_founder_permissions"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."grant_founder_permissions"() TO "service_role";


REVOKE ALL ON FUNCTION "public"."guard_general_manager_profile"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."guard_general_manager_profile"() TO "service_role";


GRANT ALL ON FUNCTION "public"."guard_privacy_notice_columns"() TO "anon";
GRANT ALL ON FUNCTION "public"."guard_privacy_notice_columns"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."guard_privacy_notice_columns"() TO "service_role";


REVOKE ALL ON FUNCTION "public"."guard_school_contract_columns"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."guard_school_contract_columns"() TO "service_role";


REVOKE ALL ON FUNCTION "public"."handle_new_user"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."handle_new_user"() TO "service_role";


REVOKE ALL ON FUNCTION "public"."has_branch_access"("p_branch_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."has_branch_access"("p_branch_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."has_branch_access"("p_branch_id" "uuid") TO "service_role";


REVOKE ALL ON FUNCTION "public"."has_permission"("p_permission" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."has_permission"("p_permission" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."has_permission"("p_permission" "text") TO "service_role";


REVOKE ALL ON FUNCTION "public"."income_expense_item_visible"("p_item_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."income_expense_item_visible"("p_item_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."income_expense_item_visible"("p_item_id" "uuid") TO "service_role";


REVOKE ALL ON FUNCTION "public"."income_expense_item_writable"("p_item_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."income_expense_item_writable"("p_item_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."income_expense_item_writable"("p_item_id" "uuid") TO "service_role";


REVOKE ALL ON FUNCTION "public"."is_class_visible"("p_class_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."is_class_visible"("p_class_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."is_class_visible"("p_class_id" "uuid") TO "service_role";


REVOKE ALL ON FUNCTION "public"."is_school_manager"("_school_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."is_school_manager"("_school_id" "uuid") TO "service_role";


GRANT ALL ON FUNCTION "public"."is_school_wide_role"("p_role_id" bigint) TO "anon";
GRANT ALL ON FUNCTION "public"."is_school_wide_role"("p_role_id" bigint) TO "authenticated";
GRANT ALL ON FUNCTION "public"."is_school_wide_role"("p_role_id" bigint) TO "service_role";


REVOKE ALL ON FUNCTION "public"."log_athlete_consents"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."log_athlete_consents"() TO "service_role";


REVOKE ALL ON FUNCTION "public"."mark_notifications_read"("p_ids" "uuid"[]) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."mark_notifications_read"("p_ids" "uuid"[]) TO "authenticated";
GRANT ALL ON FUNCTION "public"."mark_notifications_read"("p_ids" "uuid"[]) TO "service_role";


REVOKE ALL ON FUNCTION "public"."normalize_national_id"("p_value" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."normalize_national_id"("p_value" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."normalize_national_id"("p_value" "text") TO "service_role";


REVOKE ALL ON FUNCTION "public"."notifications_after_insert"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."notifications_after_insert"() TO "service_role";


REVOKE ALL ON FUNCTION "public"."notify_pre_registration_received"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."notify_pre_registration_received"() TO "service_role";


REVOKE ALL ON FUNCTION "public"."parent_get_athletes"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."parent_get_athletes"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."parent_get_athletes"() TO "service_role";


REVOKE ALL ON FUNCTION "public"."parent_get_attendance"("p_athlete_id" "uuid", "p_from" "date", "p_to" "date") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."parent_get_attendance"("p_athlete_id" "uuid", "p_from" "date", "p_to" "date") TO "authenticated";
GRANT ALL ON FUNCTION "public"."parent_get_attendance"("p_athlete_id" "uuid", "p_from" "date", "p_to" "date") TO "service_role";


REVOKE ALL ON FUNCTION "public"."parent_get_payments"("p_athlete_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."parent_get_payments"("p_athlete_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."parent_get_payments"("p_athlete_id" "uuid") TO "service_role";


REVOKE ALL ON FUNCTION "public"."parent_owns_athlete"("p_athlete_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."parent_owns_athlete"("p_athlete_id" "uuid") TO "service_role";


REVOKE ALL ON FUNCTION "public"."parent_set_consents"("p_athlete_id" "uuid", "p_health" boolean, "p_photo" boolean, "p_promo_photo" boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."parent_set_consents"("p_athlete_id" "uuid", "p_health" boolean, "p_photo" boolean, "p_promo_photo" boolean) TO "authenticated";
GRANT ALL ON FUNCTION "public"."parent_set_consents"("p_athlete_id" "uuid", "p_health" boolean, "p_photo" boolean, "p_promo_photo" boolean) TO "service_role";


REVOKE ALL ON FUNCTION "public"."pre_registration_measure"("p_value" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."pre_registration_measure"("p_value" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."pre_registration_measure"("p_value" "text") TO "service_role";


REVOKE ALL ON FUNCTION "public"."prevent_last_manager_removal"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."prevent_last_manager_removal"() TO "service_role";


REVOKE ALL ON FUNCTION "public"."process_bulk_dues"("p_customer_id" "uuid", "p_dues_list" "jsonb", "p_branch_id" "uuid", "p_school_id" "uuid", "p_created_by" "uuid", "p_income_expense_item_id" "uuid", "p_discount_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."process_bulk_dues"("p_customer_id" "uuid", "p_dues_list" "jsonb", "p_branch_id" "uuid", "p_school_id" "uuid", "p_created_by" "uuid", "p_income_expense_item_id" "uuid", "p_discount_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."process_bulk_dues"("p_customer_id" "uuid", "p_dues_list" "jsonb", "p_branch_id" "uuid", "p_school_id" "uuid", "p_created_by" "uuid", "p_income_expense_item_id" "uuid", "p_discount_id" "uuid") TO "service_role";


REVOKE ALL ON FUNCTION "public"."process_financial_operation"("p_type" "public"."accounting_type", "p_name" "text", "p_expected_date" "date", "p_net_amount" numeric, "p_customer_id" "uuid", "p_new_customer_name" "text", "p_new_customer_phone" "text", "p_branch_id" "uuid", "p_school_id" "uuid", "p_created_by" "uuid", "p_income_expense_item_id" "uuid", "p_discount_id" "uuid", "p_description" "text", "p_invoice_no" "text", "p_reminder_date" "date", "p_base_amount" numeric, "p_discount_amount" numeric, "p_tax_rate" integer, "p_tax_included" boolean, "p_paid_amount" numeric, "p_payment_method" "public"."payment_method") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."process_financial_operation"("p_type" "public"."accounting_type", "p_name" "text", "p_expected_date" "date", "p_net_amount" numeric, "p_customer_id" "uuid", "p_new_customer_name" "text", "p_new_customer_phone" "text", "p_branch_id" "uuid", "p_school_id" "uuid", "p_created_by" "uuid", "p_income_expense_item_id" "uuid", "p_discount_id" "uuid", "p_description" "text", "p_invoice_no" "text", "p_reminder_date" "date", "p_base_amount" numeric, "p_discount_amount" numeric, "p_tax_rate" integer, "p_tax_included" boolean, "p_paid_amount" numeric, "p_payment_method" "public"."payment_method") TO "authenticated";
GRANT ALL ON FUNCTION "public"."process_financial_operation"("p_type" "public"."accounting_type", "p_name" "text", "p_expected_date" "date", "p_net_amount" numeric, "p_customer_id" "uuid", "p_new_customer_name" "text", "p_new_customer_phone" "text", "p_branch_id" "uuid", "p_school_id" "uuid", "p_created_by" "uuid", "p_income_expense_item_id" "uuid", "p_discount_id" "uuid", "p_description" "text", "p_invoice_no" "text", "p_reminder_date" "date", "p_base_amount" numeric, "p_discount_amount" numeric, "p_tax_rate" integer, "p_tax_included" boolean, "p_paid_amount" numeric, "p_payment_method" "public"."payment_method") TO "service_role";


REVOKE ALL ON FUNCTION "public"."profile_branch_ids"("p_profile_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."profile_branch_ids"("p_profile_id" "uuid") TO "service_role";


REVOKE ALL ON FUNCTION "public"."profile_has_branch_access"("p_profile_id" "uuid", "p_branch_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."profile_has_branch_access"("p_profile_id" "uuid", "p_branch_id" "uuid") TO "service_role";


REVOKE ALL ON FUNCTION "public"."profile_has_permission"("p_profile_id" "uuid", "p_permission" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."profile_has_permission"("p_profile_id" "uuid", "p_permission" "text") TO "service_role";


REVOKE ALL ON FUNCTION "public"."profile_permission_list"("p_profile_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."profile_permission_list"("p_profile_id" "uuid") TO "service_role";


REVOKE ALL ON FUNCTION "public"."profile_permissions_error"("p_target_id" "uuid", "p_role_id" bigint, "p_permissions" "text"[]) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."profile_permissions_error"("p_target_id" "uuid", "p_role_id" bigint, "p_permissions" "text"[]) TO "service_role";


REVOKE ALL ON FUNCTION "public"."prune_profile_permissions_on_role_change"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."prune_profile_permissions_on_role_change"() TO "service_role";


REVOKE ALL ON FUNCTION "public"."public_get_branches"("p_school_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."public_get_branches"("p_school_id" "uuid") TO "service_role";


REVOKE ALL ON FUNCTION "public"."public_get_branches_by_token"("p_token" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."public_get_branches_by_token"("p_token" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."public_get_branches_by_token"("p_token" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."public_get_branches_by_token"("p_token" "text") TO "service_role";


REVOKE ALL ON FUNCTION "public"."public_get_classes"("p_school_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."public_get_classes"("p_school_id" "uuid") TO "service_role";


REVOKE ALL ON FUNCTION "public"."public_get_classes_by_token"("p_token" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."public_get_classes_by_token"("p_token" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."public_get_classes_by_token"("p_token" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."public_get_classes_by_token"("p_token" "text") TO "service_role";


REVOKE ALL ON FUNCTION "public"."public_get_school_branding"("p_school_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."public_get_school_branding"("p_school_id" "uuid") TO "service_role";


REVOKE ALL ON FUNCTION "public"."public_get_school_branding_by_token"("p_token" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."public_get_school_branding_by_token"("p_token" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."public_get_school_branding_by_token"("p_token" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."public_get_school_branding_by_token"("p_token" "text") TO "service_role";


REVOKE ALL ON FUNCTION "public"."purge_deleted_athlete_sensitive_data"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."purge_deleted_athlete_sensitive_data"() TO "service_role";


REVOKE ALL ON FUNCTION "public"."purge_expired_pre_registrations"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."purge_expired_pre_registrations"() TO "service_role";


REVOKE ALL ON FUNCTION "public"."purge_expired_site_leads"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."purge_expired_site_leads"() TO "service_role";


REVOKE ALL ON FUNCTION "public"."queue_attendance_results"("p_attendance_ids" "uuid"[]) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."queue_attendance_results"("p_attendance_ids" "uuid"[]) TO "service_role";


REVOKE ALL ON FUNCTION "public"."recalculate_financial_record_status"("p_record_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."recalculate_financial_record_status"("p_record_id" "uuid") TO "service_role";


REVOKE ALL ON FUNCTION "public"."record_pre_registration_attempt"("p_ip_hash" "text", "p_school_id" "uuid", "p_limit" integer, "p_window" interval) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."record_pre_registration_attempt"("p_ip_hash" "text", "p_school_id" "uuid", "p_limit" integer, "p_window" interval) TO "service_role";


REVOKE ALL ON FUNCTION "public"."register_push_token"("p_token" "text", "p_app" "text", "p_platform" "text", "p_locale" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."register_push_token"("p_token" "text", "p_app" "text", "p_platform" "text", "p_locale" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."register_push_token"("p_token" "text", "p_app" "text", "p_platform" "text", "p_locale" "text") TO "service_role";


REVOKE ALL ON FUNCTION "public"."request_push_dispatch"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."request_push_dispatch"() TO "service_role";


REVOKE ALL ON FUNCTION "public"."resolve_health_consent"("p_consent" boolean, "p_existing" timestamp with time zone) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."resolve_health_consent"("p_consent" boolean, "p_existing" timestamp with time zone) TO "authenticated";
GRANT ALL ON FUNCTION "public"."resolve_health_consent"("p_consent" boolean, "p_existing" timestamp with time zone) TO "service_role";


REVOKE ALL ON FUNCTION "public"."resolve_pre_registration_token"("p_token" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."resolve_pre_registration_token"("p_token" "text") TO "service_role";


REVOKE ALL ON FUNCTION "public"."role_rank"("p_role_id" bigint) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."role_rank"("p_role_id" bigint) TO "service_role";


REVOKE ALL ON FUNCTION "public"."rotate_pre_registration_link"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."rotate_pre_registration_link"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."rotate_pre_registration_link"() TO "service_role";


REVOKE ALL ON FUNCTION "public"."save_attendances"("p_school_id" "uuid", "p_branch_id" "uuid", "p_class_id" "uuid", "p_attendance_date" "date", "p_items" "jsonb", "p_coach_id" "uuid", "p_created_by" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."save_attendances"("p_school_id" "uuid", "p_branch_id" "uuid", "p_class_id" "uuid", "p_attendance_date" "date", "p_items" "jsonb", "p_coach_id" "uuid", "p_created_by" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."save_attendances"("p_school_id" "uuid", "p_branch_id" "uuid", "p_class_id" "uuid", "p_attendance_date" "date", "p_items" "jsonb", "p_coach_id" "uuid", "p_created_by" "uuid") TO "service_role";


REVOKE ALL ON FUNCTION "public"."save_staff_profile"("p_profile_id" "uuid", "p_full_name" "text", "p_email" "text", "p_phone_number" "text", "p_birth_of_date" "date", "p_status" "text", "p_role_id" bigint, "p_branch_ids" "uuid"[], "p_permissions" "text"[], "p_validate_only" boolean, "p_class_ids" "uuid"[]) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."save_staff_profile"("p_profile_id" "uuid", "p_full_name" "text", "p_email" "text", "p_phone_number" "text", "p_birth_of_date" "date", "p_status" "text", "p_role_id" bigint, "p_branch_ids" "uuid"[], "p_permissions" "text"[], "p_validate_only" boolean, "p_class_ids" "uuid"[]) TO "authenticated";
GRANT ALL ON FUNCTION "public"."save_staff_profile"("p_profile_id" "uuid", "p_full_name" "text", "p_email" "text", "p_phone_number" "text", "p_birth_of_date" "date", "p_status" "text", "p_role_id" bigint, "p_branch_ids" "uuid"[], "p_permissions" "text"[], "p_validate_only" boolean, "p_class_ids" "uuid"[]) TO "service_role";


REVOKE ALL ON FUNCTION "public"."send_announcement"("p_title" "text", "p_body" "text", "p_role_ids" bigint[], "p_branch_ids" "uuid"[]) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."send_announcement"("p_title" "text", "p_body" "text", "p_role_ids" bigint[], "p_branch_ids" "uuid"[]) TO "authenticated";
GRANT ALL ON FUNCTION "public"."send_announcement"("p_title" "text", "p_body" "text", "p_role_ids" bigint[], "p_branch_ids" "uuid"[]) TO "service_role";


REVOKE ALL ON FUNCTION "public"."send_direct_message"("p_athlete_id" "uuid", "p_body" "text", "p_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."send_direct_message"("p_athlete_id" "uuid", "p_body" "text", "p_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."send_direct_message"("p_athlete_id" "uuid", "p_body" "text", "p_id" "uuid") TO "service_role";


REVOKE ALL ON FUNCTION "public"."set_athlete_photo"("p_athlete_id" "uuid", "p_photo_path" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."set_athlete_photo"("p_athlete_id" "uuid", "p_photo_path" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."set_athlete_photo"("p_athlete_id" "uuid", "p_photo_path" "text") TO "service_role";


REVOKE ALL ON FUNCTION "public"."set_notification_preference"("p_type" "text", "p_push_enabled" boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."set_notification_preference"("p_type" "text", "p_push_enabled" boolean) TO "authenticated";
GRANT ALL ON FUNCTION "public"."set_notification_preference"("p_type" "text", "p_push_enabled" boolean) TO "service_role";


REVOKE ALL ON FUNCTION "public"."set_updated_at"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."set_updated_at"() TO "service_role";


REVOKE ALL ON FUNCTION "public"."sport_writable"("p_sport_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."sport_writable"("p_sport_id" "uuid") TO "service_role";


REVOKE ALL ON FUNCTION "public"."staff_management_error"("p_target_id" "uuid", "p_new_role_id" bigint, "p_new_branch_ids" "uuid"[]) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."staff_management_error"("p_target_id" "uuid", "p_new_role_id" bigint, "p_new_branch_ids" "uuid"[]) TO "service_role";


REVOKE ALL ON FUNCTION "public"."submit_attendances"("p_class_id" "uuid", "p_attendance_date" "date", "p_items" "jsonb") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."submit_attendances"("p_class_id" "uuid", "p_attendance_date" "date", "p_items" "jsonb") TO "authenticated";
GRANT ALL ON FUNCTION "public"."submit_attendances"("p_class_id" "uuid", "p_attendance_date" "date", "p_items" "jsonb") TO "service_role";


REVOKE ALL ON FUNCTION "public"."submit_site_lead"("p_kind" "text", "p_full_name" "text", "p_phone" "text", "p_email" "text", "p_school_name" "text", "p_city" "text", "p_athlete_count" "text", "p_message" "text", "p_source_page" "text", "p_utm_source" "text", "p_utm_medium" "text", "p_utm_campaign" "text", "p_ip_hash" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."submit_site_lead"("p_kind" "text", "p_full_name" "text", "p_phone" "text", "p_email" "text", "p_school_name" "text", "p_city" "text", "p_athlete_count" "text", "p_message" "text", "p_source_page" "text", "p_utm_source" "text", "p_utm_medium" "text", "p_utm_campaign" "text", "p_ip_hash" "text") TO "service_role";


REVOKE ALL ON FUNCTION "public"."sweep_push_queue"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."sweep_push_queue"() TO "service_role";


REVOKE ALL ON FUNCTION "public"."sync_athlete_to_customer"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."sync_athlete_to_customer"() TO "service_role";


REVOKE ALL ON FUNCTION "public"."sync_class_coaches"("p_class_id" "uuid", "p_coach_ids" "uuid"[]) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."sync_class_coaches"("p_class_id" "uuid", "p_coach_ids" "uuid"[]) TO "authenticated";
GRANT ALL ON FUNCTION "public"."sync_class_coaches"("p_class_id" "uuid", "p_coach_ids" "uuid"[]) TO "service_role";


REVOKE ALL ON FUNCTION "public"."sync_class_schedule"("p_class_id" "uuid", "p_schedule" "jsonb") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."sync_class_schedule"("p_class_id" "uuid", "p_schedule" "jsonb") TO "authenticated";
GRANT ALL ON FUNCTION "public"."sync_class_schedule"("p_class_id" "uuid", "p_schedule" "jsonb") TO "service_role";


REVOKE ALL ON FUNCTION "public"."sync_parent_athlete_links"("p_profile_id" "uuid", "p_athlete_ids" "uuid"[]) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."sync_parent_athlete_links"("p_profile_id" "uuid", "p_athlete_ids" "uuid"[]) TO "authenticated";
GRANT ALL ON FUNCTION "public"."sync_parent_athlete_links"("p_profile_id" "uuid", "p_athlete_ids" "uuid"[]) TO "service_role";


REVOKE ALL ON FUNCTION "public"."sync_profile_branch_links"("p_profile_id" "uuid", "p_branch_ids" "uuid"[]) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."sync_profile_branch_links"("p_profile_id" "uuid", "p_branch_ids" "uuid"[]) TO "authenticated";
GRANT ALL ON FUNCTION "public"."sync_profile_branch_links"("p_profile_id" "uuid", "p_branch_ids" "uuid"[]) TO "service_role";


REVOKE ALL ON FUNCTION "public"."sync_profile_permissions"("p_profile_id" "uuid", "p_permissions" "text"[]) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."sync_profile_permissions"("p_profile_id" "uuid", "p_permissions" "text"[]) TO "authenticated";
GRANT ALL ON FUNCTION "public"."sync_profile_permissions"("p_profile_id" "uuid", "p_permissions" "text"[]) TO "service_role";


REVOKE ALL ON FUNCTION "public"."sync_school_users_brand"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."sync_school_users_brand"() TO "service_role";


REVOKE ALL ON FUNCTION "public"."sync_user_brand_from_profile"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."sync_user_brand_from_profile"() TO "service_role";


REVOKE ALL ON FUNCTION "public"."unregister_push_token"("p_token" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."unregister_push_token"("p_token" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."unregister_push_token"("p_token" "text") TO "service_role";


REVOKE ALL ON FUNCTION "public"."update_athlete"("p_athlete_id" "uuid", "p_branch_id" "uuid", "p_gender" "public"."gender_type", "p_date_of_birth" "date", "p_approval_status" "public"."approval_status", "p_school_id" "uuid", "p_class_id" "uuid", "p_full_name" "text", "p_parent_ids" "uuid"[], "p_blood_type" "public"."blood_type", "p_license_number" "text", "p_height" numeric, "p_weight" numeric, "p_photo_url" "text", "p_address" "text", "p_registration_date" "date", "p_contract_end_date" "date", "p_phone_number" "text", "p_national_id" "text", "p_health_problems" "text", "p_has_health_report" boolean, "p_health_consent" boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."update_athlete"("p_athlete_id" "uuid", "p_branch_id" "uuid", "p_gender" "public"."gender_type", "p_date_of_birth" "date", "p_approval_status" "public"."approval_status", "p_school_id" "uuid", "p_class_id" "uuid", "p_full_name" "text", "p_parent_ids" "uuid"[], "p_blood_type" "public"."blood_type", "p_license_number" "text", "p_height" numeric, "p_weight" numeric, "p_photo_url" "text", "p_address" "text", "p_registration_date" "date", "p_contract_end_date" "date", "p_phone_number" "text", "p_national_id" "text", "p_health_problems" "text", "p_has_health_report" boolean, "p_health_consent" boolean) TO "authenticated";
GRANT ALL ON FUNCTION "public"."update_athlete"("p_athlete_id" "uuid", "p_branch_id" "uuid", "p_gender" "public"."gender_type", "p_date_of_birth" "date", "p_approval_status" "public"."approval_status", "p_school_id" "uuid", "p_class_id" "uuid", "p_full_name" "text", "p_parent_ids" "uuid"[], "p_blood_type" "public"."blood_type", "p_license_number" "text", "p_height" numeric, "p_weight" numeric, "p_photo_url" "text", "p_address" "text", "p_registration_date" "date", "p_contract_end_date" "date", "p_phone_number" "text", "p_national_id" "text", "p_health_problems" "text", "p_has_health_report" boolean, "p_health_consent" boolean) TO "service_role";


REVOKE ALL ON FUNCTION "public"."update_branch"("p_branch_id" "uuid", "p_name" "text", "p_address" "text", "p_email" "text", "p_phone_number" "text", "p_phone_number_2" "text", "p_company_title" "text", "p_billing_address" "text", "p_tax_address" "text", "p_tax_number" "text", "p_trade_registry_number" "text", "p_mersis_number" "text", "p_tax_office_province_code" "text", "p_iban" "text", "p_status" "public"."approval_status") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."update_branch"("p_branch_id" "uuid", "p_name" "text", "p_address" "text", "p_email" "text", "p_phone_number" "text", "p_phone_number_2" "text", "p_company_title" "text", "p_billing_address" "text", "p_tax_address" "text", "p_tax_number" "text", "p_trade_registry_number" "text", "p_mersis_number" "text", "p_tax_office_province_code" "text", "p_iban" "text", "p_status" "public"."approval_status") TO "authenticated";
GRANT ALL ON FUNCTION "public"."update_branch"("p_branch_id" "uuid", "p_name" "text", "p_address" "text", "p_email" "text", "p_phone_number" "text", "p_phone_number_2" "text", "p_company_title" "text", "p_billing_address" "text", "p_tax_address" "text", "p_tax_number" "text", "p_trade_registry_number" "text", "p_mersis_number" "text", "p_tax_office_province_code" "text", "p_iban" "text", "p_status" "public"."approval_status") TO "service_role";


REVOKE ALL ON FUNCTION "public"."update_class"("p_class_id" "uuid", "p_name" "text", "p_branch_id" "uuid", "p_sport_id" "uuid", "p_quota" integer, "p_athlete_ids" "uuid"[], "p_schedule" "jsonb", "p_coach_ids" "uuid"[]) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."update_class"("p_class_id" "uuid", "p_name" "text", "p_branch_id" "uuid", "p_sport_id" "uuid", "p_quota" integer, "p_athlete_ids" "uuid"[], "p_schedule" "jsonb", "p_coach_ids" "uuid"[]) TO "authenticated";
GRANT ALL ON FUNCTION "public"."update_class"("p_class_id" "uuid", "p_name" "text", "p_branch_id" "uuid", "p_sport_id" "uuid", "p_quota" integer, "p_athlete_ids" "uuid"[], "p_schedule" "jsonb", "p_coach_ids" "uuid"[]) TO "service_role";


REVOKE ALL ON FUNCTION "public"."update_customer"("p_id" "uuid", "p_display_name" "text", "p_phone" "text", "p_email" "text", "p_national_id" "text", "p_address" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."update_customer"("p_id" "uuid", "p_display_name" "text", "p_phone" "text", "p_email" "text", "p_national_id" "text", "p_address" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."update_customer"("p_id" "uuid", "p_display_name" "text", "p_phone" "text", "p_email" "text", "p_national_id" "text", "p_address" "text") TO "service_role";


REVOKE ALL ON FUNCTION "public"."update_discount"("p_discount_id" "uuid", "p_name" "text", "p_type" "public"."discount_type", "p_value" numeric, "p_branch_ids" "uuid"[]) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."update_discount"("p_discount_id" "uuid", "p_name" "text", "p_type" "public"."discount_type", "p_value" numeric, "p_branch_ids" "uuid"[]) TO "authenticated";
GRANT ALL ON FUNCTION "public"."update_discount"("p_discount_id" "uuid", "p_name" "text", "p_type" "public"."discount_type", "p_value" numeric, "p_branch_ids" "uuid"[]) TO "service_role";


REVOKE ALL ON FUNCTION "public"."update_financial_record"("p_id" "uuid", "p_name" "text", "p_expected_date" "date", "p_net_amount" numeric, "p_income_expense_item_id" "uuid", "p_discount_id" "uuid", "p_description" "text", "p_reminder_date" "date", "p_base_amount" numeric, "p_discount_amount" numeric, "p_tax_rate" integer, "p_tax_included" boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."update_financial_record"("p_id" "uuid", "p_name" "text", "p_expected_date" "date", "p_net_amount" numeric, "p_income_expense_item_id" "uuid", "p_discount_id" "uuid", "p_description" "text", "p_reminder_date" "date", "p_base_amount" numeric, "p_discount_amount" numeric, "p_tax_rate" integer, "p_tax_included" boolean) TO "authenticated";
GRANT ALL ON FUNCTION "public"."update_financial_record"("p_id" "uuid", "p_name" "text", "p_expected_date" "date", "p_net_amount" numeric, "p_income_expense_item_id" "uuid", "p_discount_id" "uuid", "p_description" "text", "p_reminder_date" "date", "p_base_amount" numeric, "p_discount_amount" numeric, "p_tax_rate" integer, "p_tax_included" boolean) TO "service_role";


REVOKE ALL ON FUNCTION "public"."update_income_expense_item"("p_item_id" "uuid", "p_name" "text", "p_type" "public"."transaction_type", "p_value" numeric, "p_branch_ids" "uuid"[]) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."update_income_expense_item"("p_item_id" "uuid", "p_name" "text", "p_type" "public"."transaction_type", "p_value" numeric, "p_branch_ids" "uuid"[]) TO "authenticated";
GRANT ALL ON FUNCTION "public"."update_income_expense_item"("p_item_id" "uuid", "p_name" "text", "p_type" "public"."transaction_type", "p_value" numeric, "p_branch_ids" "uuid"[]) TO "service_role";


REVOKE ALL ON FUNCTION "public"."update_pre_registration"("p_id" "uuid", "p_full_name" "text", "p_gender" "text", "p_date_of_birth" "date", "p_branch_id" "uuid", "p_class_id" "uuid", "p_interviewer_name" "text", "p_interview_type" "text", "p_interview_date" "date", "p_parent_full_name" "text", "p_parent_phone" "text", "p_parent_email" "text", "p_national_id" "text", "p_phone" "text", "p_address" "text", "p_height" "text", "p_weight" "text", "p_health_problems" "text", "p_has_health_report" boolean, "p_has_sports_history" boolean, "p_parent2_full_name" "text", "p_parent2_phone" "text", "p_parent2_email" "text", "p_contract_possibility" "text", "p_referral_source" "text", "p_status" "text", "p_health_consent" boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."update_pre_registration"("p_id" "uuid", "p_full_name" "text", "p_gender" "text", "p_date_of_birth" "date", "p_branch_id" "uuid", "p_class_id" "uuid", "p_interviewer_name" "text", "p_interview_type" "text", "p_interview_date" "date", "p_parent_full_name" "text", "p_parent_phone" "text", "p_parent_email" "text", "p_national_id" "text", "p_phone" "text", "p_address" "text", "p_height" "text", "p_weight" "text", "p_health_problems" "text", "p_has_health_report" boolean, "p_has_sports_history" boolean, "p_parent2_full_name" "text", "p_parent2_phone" "text", "p_parent2_email" "text", "p_contract_possibility" "text", "p_referral_source" "text", "p_status" "text", "p_health_consent" boolean) TO "authenticated";
GRANT ALL ON FUNCTION "public"."update_pre_registration"("p_id" "uuid", "p_full_name" "text", "p_gender" "text", "p_date_of_birth" "date", "p_branch_id" "uuid", "p_class_id" "uuid", "p_interviewer_name" "text", "p_interview_type" "text", "p_interview_date" "date", "p_parent_full_name" "text", "p_parent_phone" "text", "p_parent_email" "text", "p_national_id" "text", "p_phone" "text", "p_address" "text", "p_height" "text", "p_weight" "text", "p_health_problems" "text", "p_has_health_report" boolean, "p_has_sports_history" boolean, "p_parent2_full_name" "text", "p_parent2_phone" "text", "p_parent2_email" "text", "p_contract_possibility" "text", "p_referral_source" "text", "p_status" "text", "p_health_consent" boolean) TO "service_role";


REVOKE ALL ON FUNCTION "public"."update_school"("p_school_id" "uuid", "p_name" "text", "p_city" "text", "p_district" "text", "p_address" "text", "p_logo_url" "text", "p_clear_logo" boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."update_school"("p_school_id" "uuid", "p_name" "text", "p_city" "text", "p_district" "text", "p_address" "text", "p_logo_url" "text", "p_clear_logo" boolean) TO "authenticated";
GRANT ALL ON FUNCTION "public"."update_school"("p_school_id" "uuid", "p_name" "text", "p_city" "text", "p_district" "text", "p_address" "text", "p_logo_url" "text", "p_clear_logo" boolean) TO "service_role";


REVOKE ALL ON FUNCTION "public"."update_sport"("p_sport_id" "uuid", "p_name" "text", "p_branch_ids" "uuid"[]) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."update_sport"("p_sport_id" "uuid", "p_name" "text", "p_branch_ids" "uuid"[]) TO "authenticated";
GRANT ALL ON FUNCTION "public"."update_sport"("p_sport_id" "uuid", "p_name" "text", "p_branch_ids" "uuid"[]) TO "service_role";


REVOKE ALL ON FUNCTION "public"."update_transaction"("p_id" "uuid", "p_amount" numeric, "p_method" "public"."payment_method", "p_transaction_date" timestamp with time zone) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."update_transaction"("p_id" "uuid", "p_amount" numeric, "p_method" "public"."payment_method", "p_transaction_date" timestamp with time zone) TO "authenticated";
GRANT ALL ON FUNCTION "public"."update_transaction"("p_id" "uuid", "p_amount" numeric, "p_method" "public"."payment_method", "p_transaction_date" timestamp with time zone) TO "service_role";


REVOKE ALL ON FUNCTION "public"."write_coach_class_links"("p_coach_id" "uuid", "p_school_id" "uuid", "p_class_ids" "uuid"[]) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."write_coach_class_links"("p_coach_id" "uuid", "p_school_id" "uuid", "p_class_ids" "uuid"[]) TO "service_role";


REVOKE ALL ON FUNCTION "public"."write_profile_branch_links"("p_profile_id" "uuid", "p_school_id" "uuid", "p_branch_ids" "uuid"[]) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."write_profile_branch_links"("p_profile_id" "uuid", "p_school_id" "uuid", "p_branch_ids" "uuid"[]) TO "service_role";


REVOKE ALL ON FUNCTION "public"."write_profile_permissions"("p_profile_id" "uuid", "p_school_id" "uuid", "p_permissions" "text"[]) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."write_profile_permissions"("p_profile_id" "uuid", "p_school_id" "uuid", "p_permissions" "text"[]) TO "service_role";


GRANT ALL ON TABLE "public"."app_min_versions" TO "service_role";
GRANT SELECT ON TABLE "public"."app_min_versions" TO "anon";
GRANT SELECT ON TABLE "public"."app_min_versions" TO "authenticated";


GRANT ALL ON TABLE "public"."athlete_consent_events" TO "service_role";


GRANT SELECT,REFERENCES,TRIGGER,MAINTAIN ON TABLE "public"."athletes" TO "anon";
GRANT SELECT,REFERENCES,TRIGGER,MAINTAIN ON TABLE "public"."athletes" TO "authenticated";
GRANT ALL ON TABLE "public"."athletes" TO "service_role";


GRANT SELECT,REFERENCES,TRIGGER,MAINTAIN ON TABLE "public"."attendances" TO "anon";
GRANT SELECT,REFERENCES,TRIGGER,MAINTAIN ON TABLE "public"."attendances" TO "authenticated";
GRANT ALL ON TABLE "public"."attendances" TO "service_role";


GRANT SELECT,REFERENCES,TRIGGER,MAINTAIN ON TABLE "public"."branch_class_links" TO "anon";
GRANT SELECT,REFERENCES,TRIGGER,MAINTAIN ON TABLE "public"."branch_class_links" TO "authenticated";
GRANT ALL ON TABLE "public"."branch_class_links" TO "service_role";


GRANT SELECT,REFERENCES,TRIGGER,MAINTAIN ON TABLE "public"."branch_discount_links" TO "anon";
GRANT SELECT,REFERENCES,TRIGGER,MAINTAIN ON TABLE "public"."branch_discount_links" TO "authenticated";
GRANT ALL ON TABLE "public"."branch_discount_links" TO "service_role";


GRANT SELECT,REFERENCES,TRIGGER,MAINTAIN ON TABLE "public"."branch_income_expense_item_links" TO "anon";
GRANT SELECT,REFERENCES,TRIGGER,MAINTAIN ON TABLE "public"."branch_income_expense_item_links" TO "authenticated";
GRANT ALL ON TABLE "public"."branch_income_expense_item_links" TO "service_role";


GRANT SELECT,REFERENCES,TRIGGER,MAINTAIN ON TABLE "public"."branch_sport_links" TO "anon";
GRANT SELECT,REFERENCES,TRIGGER,MAINTAIN ON TABLE "public"."branch_sport_links" TO "authenticated";
GRANT ALL ON TABLE "public"."branch_sport_links" TO "service_role";


GRANT ALL ON SEQUENCE "public"."branch_team_links_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."branch_team_links_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."branch_team_links_id_seq" TO "service_role";


GRANT SELECT,REFERENCES,TRIGGER,MAINTAIN ON TABLE "public"."branches" TO "anon";
GRANT SELECT,REFERENCES,TRIGGER,MAINTAIN ON TABLE "public"."branches" TO "authenticated";
GRANT ALL ON TABLE "public"."branches" TO "service_role";


GRANT SELECT,REFERENCES,TRIGGER,MAINTAIN ON TABLE "public"."class_schedule_slots" TO "authenticated";
GRANT ALL ON TABLE "public"."class_schedule_slots" TO "service_role";


GRANT SELECT,REFERENCES,TRIGGER,MAINTAIN ON TABLE "public"."classes" TO "anon";
GRANT SELECT,REFERENCES,TRIGGER,MAINTAIN ON TABLE "public"."classes" TO "authenticated";
GRANT ALL ON TABLE "public"."classes" TO "service_role";


GRANT SELECT,REFERENCES,TRIGGER,MAINTAIN ON TABLE "public"."coach_class_links" TO "anon";
GRANT SELECT,REFERENCES,TRIGGER,MAINTAIN ON TABLE "public"."coach_class_links" TO "authenticated";
GRANT ALL ON TABLE "public"."coach_class_links" TO "service_role";


GRANT SELECT,REFERENCES,TRIGGER,MAINTAIN ON TABLE "public"."customers" TO "anon";
GRANT SELECT,REFERENCES,TRIGGER,MAINTAIN ON TABLE "public"."customers" TO "authenticated";
GRANT ALL ON TABLE "public"."customers" TO "service_role";


GRANT ALL ON TABLE "public"."direct_messages" TO "service_role";


GRANT SELECT,REFERENCES,TRIGGER,MAINTAIN ON TABLE "public"."discounts" TO "anon";
GRANT SELECT,REFERENCES,TRIGGER,MAINTAIN ON TABLE "public"."discounts" TO "authenticated";
GRANT ALL ON TABLE "public"."discounts" TO "service_role";


GRANT SELECT,REFERENCES,TRIGGER,MAINTAIN ON TABLE "public"."financial_records" TO "anon";
GRANT SELECT,REFERENCES,TRIGGER,MAINTAIN ON TABLE "public"."financial_records" TO "authenticated";
GRANT ALL ON TABLE "public"."financial_records" TO "service_role";


GRANT SELECT,REFERENCES,TRIGGER,MAINTAIN ON TABLE "public"."income_expense_items" TO "anon";
GRANT SELECT,REFERENCES,TRIGGER,MAINTAIN ON TABLE "public"."income_expense_items" TO "authenticated";
GRANT ALL ON TABLE "public"."income_expense_items" TO "service_role";


GRANT SELECT,REFERENCES,TRIGGER,MAINTAIN ON TABLE "public"."notification_announcements" TO "authenticated";
GRANT ALL ON TABLE "public"."notification_announcements" TO "service_role";


GRANT SELECT,REFERENCES,TRIGGER,MAINTAIN ON TABLE "public"."notification_preferences" TO "authenticated";
GRANT ALL ON TABLE "public"."notification_preferences" TO "service_role";


GRANT SELECT,REFERENCES,TRIGGER,MAINTAIN ON TABLE "public"."notifications" TO "authenticated";
GRANT ALL ON TABLE "public"."notifications" TO "service_role";


GRANT SELECT,REFERENCES,TRIGGER,MAINTAIN ON TABLE "public"."parent_athlete_links" TO "anon";
GRANT SELECT,REFERENCES,TRIGGER,MAINTAIN ON TABLE "public"."parent_athlete_links" TO "authenticated";
GRANT ALL ON TABLE "public"."parent_athlete_links" TO "service_role";


GRANT SELECT,REFERENCES,TRIGGER,MAINTAIN ON TABLE "public"."pre_registration_attempts" TO "anon";
GRANT SELECT,REFERENCES,TRIGGER,MAINTAIN ON TABLE "public"."pre_registration_attempts" TO "authenticated";
GRANT ALL ON TABLE "public"."pre_registration_attempts" TO "service_role";


GRANT ALL ON SEQUENCE "public"."pre_registration_attempts_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."pre_registration_attempts_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."pre_registration_attempts_id_seq" TO "service_role";


GRANT SELECT,REFERENCES,TRIGGER,MAINTAIN ON TABLE "public"."pre_registration_links" TO "anon";
GRANT SELECT,REFERENCES,TRIGGER,MAINTAIN ON TABLE "public"."pre_registration_links" TO "authenticated";
GRANT ALL ON TABLE "public"."pre_registration_links" TO "service_role";


GRANT SELECT,REFERENCES,TRIGGER,MAINTAIN ON TABLE "public"."pre_registrations" TO "anon";
GRANT SELECT,REFERENCES,TRIGGER,MAINTAIN ON TABLE "public"."pre_registrations" TO "authenticated";
GRANT ALL ON TABLE "public"."pre_registrations" TO "service_role";


GRANT SELECT,REFERENCES,TRIGGER,MAINTAIN ON TABLE "public"."profile_branch_links" TO "anon";
GRANT SELECT,REFERENCES,TRIGGER,MAINTAIN ON TABLE "public"."profile_branch_links" TO "authenticated";
GRANT ALL ON TABLE "public"."profile_branch_links" TO "service_role";


GRANT ALL ON TABLE "public"."profile_permissions" TO "service_role";
GRANT SELECT ON TABLE "public"."profile_permissions" TO "authenticated";


GRANT SELECT,REFERENCES,TRIGGER,MAINTAIN ON TABLE "public"."profiles" TO "anon";
GRANT SELECT,INSERT,REFERENCES,TRIGGER,MAINTAIN,UPDATE ON TABLE "public"."profiles" TO "authenticated";
GRANT ALL ON TABLE "public"."profiles" TO "service_role";


GRANT ALL ON TABLE "public"."push_tokens" TO "service_role";


GRANT ALL ON TABLE "public"."role_permissions" TO "service_role";
GRANT SELECT ON TABLE "public"."role_permissions" TO "authenticated";


GRANT SELECT,REFERENCES,TRIGGER,MAINTAIN ON TABLE "public"."roles" TO "anon";
GRANT SELECT,REFERENCES,TRIGGER,MAINTAIN ON TABLE "public"."roles" TO "authenticated";
GRANT ALL ON TABLE "public"."roles" TO "service_role";


GRANT ALL ON SEQUENCE "public"."roles_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."roles_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."roles_id_seq" TO "service_role";


GRANT SELECT,REFERENCES,TRIGGER,MAINTAIN ON TABLE "public"."schools" TO "anon";
GRANT SELECT,REFERENCES,TRIGGER,MAINTAIN ON TABLE "public"."schools" TO "authenticated";
GRANT ALL ON TABLE "public"."schools" TO "service_role";


GRANT ALL ON TABLE "public"."site_leads" TO "service_role";


GRANT SELECT,REFERENCES,TRIGGER,MAINTAIN ON TABLE "public"."sports" TO "anon";
GRANT SELECT,REFERENCES,TRIGGER,MAINTAIN ON TABLE "public"."sports" TO "authenticated";
GRANT ALL ON TABLE "public"."sports" TO "service_role";


GRANT SELECT,REFERENCES,TRIGGER,MAINTAIN ON TABLE "public"."transactions" TO "anon";
GRANT SELECT,REFERENCES,TRIGGER,MAINTAIN ON TABLE "public"."transactions" TO "authenticated";
GRANT ALL ON TABLE "public"."transactions" TO "service_role";


ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "service_role";


ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "service_role";


ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "service_role";
-- ▲▲▲ Supabase şema dump'ı ▲▲▲

-- Dump oturum ayarlarını değiştirir (search_path = '', row_security = off,
-- check_function_bodies = off). Sonraki dosyalar ve migration'lar normal
-- ayarlarla çalışsın.
RESET ALL;

-- ▼▼▼ db/compat/04_supabase_removed.sql ▼▼▼
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
-- ▲▲▲ db/compat/04_supabase_removed.sql ▲▲▲

-- ▼▼▼ db/compat/05_auth_triggers.sql ▼▼▼
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
-- ▲▲▲ db/compat/05_auth_triggers.sql ▲▲▲

-- migrate:down
-- Taban geri alınmaz: boş veritabanından yeniden kurun
-- (docker compose down -v && docker compose up -d db && npm run db:migrate).
do $$ begin raise exception '0001_baseline geri alınamaz'; end $$;
