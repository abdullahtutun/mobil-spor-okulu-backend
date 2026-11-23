-- Şemanın parmak izi: aynı sorgu canlı Supabase'te ve bizim veritabanımızda
-- aynı md5'leri vermeli. test/schema.e2e-spec.ts bunu çalıştırır ve sonucu
-- canlıdan alınmış sabitlerle karşılaştırır.
--
-- Canlıda (salt okunur):
--   supabase db query --linked -f scripts/schema-fingerprint.sql   ya da
--   Supabase MCP execute_sql / SQL editörü
--
-- Kapsam dışı (burada var, canlıda yok ya da bilerek farklı):
--   schema_migrations        dbmate'in tablosu
--   request_push_dispatch    db/compat/04: pg_net + Vault yerine pg_notify
--
-- Henüz canlıya uygulanmamış bir migration taşındıysa (AGENTS.md → "Schema
-- sync") onun nesneleri geçici olarak aşağıdaki `not in (...)` listelerine
-- eklenir; canlıya uygulanınca çıkarılır ve sabitler yeniden alınır.
--
-- Sıralama metni karşılaştırdığı için veritabanının collation'ı canlıdakiyle
-- aynı olmalı (ICU en-US; docker/postgres/Dockerfile).
select 'fn' as k, md5(string_agg(
         p.proname || ':' || md5(pg_get_functiondef(p.oid)) || ':' || coalesce(array_to_string(p.proacl, ','), ''),
         '|' order by p.proname, pg_get_function_identity_arguments(p.oid))) as md5
  from pg_proc p
 where p.pronamespace = 'public'::regnamespace
   and p.proname not in ('request_push_dispatch')
union all
select 'pol', md5(string_agg(
         tablename || policyname || cmd || array_to_string(roles, ',') || coalesce(qual, '') || coalesce(with_check, ''),
         '|' order by tablename, policyname))
  from pg_policies
 where schemaname = 'public' and tablename not in ('schema_migrations')
union all
select 'trg', md5(string_agg(pg_get_triggerdef(t.oid), '|' order by c.relname, t.tgname))
  from pg_trigger t
  join pg_class c on c.oid = t.tgrelid
 where c.relnamespace = 'public'::regnamespace and not t.tgisinternal
   and c.relname not in ('schema_migrations')
union all
select 'tblacl', md5(string_agg(
         c.relname || coalesce(array_to_string(c.relacl, ','), '') || c.relrowsecurity::text || c.relforcerowsecurity::text,
         '|' order by c.relname))
  from pg_class c
 where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'S')
   and c.relname not in ('schema_migrations')
union all
select 'cols', md5(string_agg(
         table_name || column_name || data_type || coalesce(column_default, '') || is_nullable,
         '|' order by table_name, ordinal_position))
  from information_schema.columns
 where table_schema = 'public' and table_name not in ('schema_migrations')
union all
select 'idx', md5(string_agg(indexdef, '|' order by indexname))
  from pg_indexes
 where schemaname = 'public' and tablename not in ('schema_migrations')
union all
select 'con', md5(string_agg(
         conrelid::regclass::text || conname || pg_get_constraintdef(oid),
         '|' order by conrelid::regclass::text, conname))
  from pg_constraint
 where connamespace = 'public'::regnamespace
   and conrelid::regclass::text not in ('schema_migrations')
union all
select 'spol', md5(string_agg(
         policyname || cmd || array_to_string(roles, ',') || coalesce(qual, '') || coalesce(with_check, ''),
         '|' order by policyname))
  from pg_policies
 where schemaname = 'storage'
union all
select 'cron', md5(string_agg(jobname || schedule || command, '|' order by jobname))
  from cron.job
order by 1;
