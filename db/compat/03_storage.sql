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
