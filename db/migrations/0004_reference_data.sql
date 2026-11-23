-- migrate:up
-- =============================================================================
-- 0004 — Başvuru verisi: roller, rol yetki matrisi, asgari sürümler (canlıdan)
-- =============================================================================
-- Şema dump'ı veri taşımaz; ama bu iki tablo kişisel veri değil, ürünün
-- kendisi: get_user_role(), has_permission(), staff_management_error() …
-- hepsi bunları okur. Boş bir veritabanı bunlarsız çalışmaz.
-- Kaynak: canlı public.roles (8 satır) ve public.role_permissions (38 satır),
-- 2026-11-23; yönetim AGENTS.md → "Roles" / "Permissions" tablosuyla aynı.
-- Rol 1 (manager) 20261011'de kaldırıldı, bu yüzden yok.
--
-- app_min_versions (zorunlu güncelleme kapısı, S02; 20261027): 8 satır,
-- canlıdaki değerler (hepsi min_build = 0). Geçişte bu değerler yeni
-- backend için ayrıca düşünülür (S17).
--
-- S12 (veri taşıma) bu üç tabloyu KOPYALAMAZ (ya da `on conflict do
-- nothing`); burada zaten var.
-- =============================================================================

insert into public.roles (id, name) overriding system value values
  (2, 'branch_manager'),
  (3, 'branch_manager_assistant'),
  (4, 'coach'),
  (5, 'accountant'),
  (6, 'dietician'),
  (7, 'doctor'),
  (8, 'parent'),
  (9, 'general_manager')
on conflict (id) do nothing;

-- Canlıdaki sıra değeri (last_value = 9).
select setval('public.roles_id_seq', 9);

insert into public.role_permissions (role_id, permission, is_optional) values
  (2, 'attendance.take', false),
  (2, 'communication.announce', false),
  (2, 'communication.message', false),
  (2, 'communication.view', false),
  (2, 'finance.manage', false),
  (2, 'finance.view', false),
  (2, 'registration.manage', false),
  (2, 'registration.view', false),
  (2, 'reports.view', false),
  (2, 'users.manage', false),
  (3, 'attendance.take', false),
  (3, 'communication.announce', false),
  (3, 'communication.message', false),
  (3, 'communication.view', false),
  (3, 'finance.manage', true),
  (3, 'finance.view', true),
  (3, 'registration.manage', false),
  (3, 'registration.view', false),
  (3, 'reports.view', true),
  (4, 'attendance.take', false),
  (4, 'communication.announce', true),
  (4, 'communication.message', true),
  (4, 'communication.view', false),
  (4, 'registration.view', false),
  (5, 'finance.manage', false),
  (5, 'finance.view', false),
  (5, 'reports.view', false),
  (9, 'attendance.take', false),
  (9, 'communication.announce', false),
  (9, 'communication.message', false),
  (9, 'communication.view', false),
  (9, 'finance.manage', true),
  (9, 'finance.view', true),
  (9, 'registration.manage', false),
  (9, 'registration.view', false),
  (9, 'reports.view', false),
  (9, 'school.manage', false),
  (9, 'users.manage', false)
on conflict do nothing;

insert into public.app_min_versions (app, brand, platform, min_build, store_url) values
  ('management', 'dev_adim', 'android', 0, null),
  ('management', 'dev_adim', 'ios',     0, null),
  ('management', 'public',   'android', 0, null),
  ('management', 'public',   'ios',     0, null),
  ('parent',     'dev_adim', 'android', 0, null),
  ('parent',     'dev_adim', 'ios',     0, null),
  ('parent',     'public',   'android', 0, null),
  ('parent',     'public',   'ios',     0, null)
on conflict (app, brand, platform) do nothing;

-- migrate:down
delete from public.app_min_versions;
delete from public.role_permissions;
delete from public.roles where id between 2 and 9;
