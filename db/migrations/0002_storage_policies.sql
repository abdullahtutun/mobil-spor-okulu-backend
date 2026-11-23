-- migrate:up
-- =============================================================================
-- 0002 — storage.objects politikaları (canlıdan, bire bir)
-- =============================================================================
-- Şema dump'ı yalnızca public şemasını alır; storage.objects üzerindeki
-- politikalar dump'a girmez. Bunlar canlıdaki pg_policies'ten
-- (schemaname = 'storage', 2026-11-23) aynen alındı: 8 politika, hepsi
-- permissive. Kaynak migration'lar: 20261001_athlete_photos.sql,
-- 20261025_athlete_consents.sql (veli silmesi), 20261017_write_access_hardening.sql
-- (logo politikaları school.manage sorar).
--
-- Kararı veren fonksiyonlar (can_read/can_write/can_parent_delete_athlete_photo,
-- has_permission, get_user_school_id) public şemada, dump'tan gelir.
-- school-logos'ta UPDATE politikası var ama with check yok — canlıda da öyle.
-- =============================================================================

create policy athlete_photos_select on storage.objects
  for select to authenticated
  using (bucket_id = 'athlete-photos'::text and public.can_read_athlete_photo(name));

create policy athlete_photos_insert on storage.objects
  for insert to authenticated
  with check (bucket_id = 'athlete-photos'::text and public.can_write_athlete_photo(name));

create policy athlete_photos_delete on storage.objects
  for delete to authenticated
  using (bucket_id = 'athlete-photos'::text and public.can_write_athlete_photo(name));

create policy athlete_photos_parent_delete on storage.objects
  for delete to authenticated
  using (bucket_id = 'athlete-photos'::text and public.can_parent_delete_athlete_photo(name));

create policy school_logos_public_read on storage.objects
  for select to public
  using (bucket_id = 'school-logos'::text);

create policy school_logos_admin_insert on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'school-logos'::text
    and (select public.has_permission('school.manage'::text))
    and (storage.foldername(name))[1] = ((select public.get_user_school_id()))::text
  );

create policy school_logos_admin_update on storage.objects
  for update to authenticated
  using (
    bucket_id = 'school-logos'::text
    and (select public.has_permission('school.manage'::text))
    and (storage.foldername(name))[1] = ((select public.get_user_school_id()))::text
  );

create policy school_logos_admin_delete on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'school-logos'::text
    and (select public.has_permission('school.manage'::text))
    and (storage.foldername(name))[1] = ((select public.get_user_school_id()))::text
  );

-- migrate:down
drop policy if exists athlete_photos_select on storage.objects;
drop policy if exists athlete_photos_insert on storage.objects;
drop policy if exists athlete_photos_delete on storage.objects;
drop policy if exists athlete_photos_parent_delete on storage.objects;
drop policy if exists school_logos_public_read on storage.objects;
drop policy if exists school_logos_admin_insert on storage.objects;
drop policy if exists school_logos_admin_update on storage.objects;
drop policy if exists school_logos_admin_delete on storage.objects;
