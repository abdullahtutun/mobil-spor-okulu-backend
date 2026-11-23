-- migrate:up
-- =============================================================================
-- 0007 — Tablo okumaları SQL fonksiyonu olarak (S07, PLAN K7)
-- =============================================================================
-- Uygulamalar bugün PostgREST'e `.from(tablo).select(...)` ile okuyor. Yeni
-- backend'de PostgREST yok; her okumanın karşılığı burada, aynı JSON'u dönen
-- bir fonksiyon ve `POST /rpc/<ad>` ile çağrılıyor. Eşleme tablosu:
-- docs/migration/read-mapping.md.
--
-- Kurallar (bozulursa test/read-functions.e2e-spec.ts düşer — o test aynı
-- veritabanına bağlı gerçek bir PostgREST'e uygulamanın sorgusunu, bize de
-- fonksiyonu sorar ve iki JSON'u karşılaştırır):
--
--   * SECURITY INVOKER. Fonksiyon çağıranın rolüyle (authenticated) ve
--     `request.jwt.claims`'iyle çalışır: üst tablonun da gömülü tabloların da
--     RLS politikaları (okul, şube kapsamı, `is_deleted`, velinin
--     `parent_no_direct_access`'i, pasif/silinmiş hesap) PostgREST'teki gibi
--     uygulanır. Burada yeni bir yetki kuralı YOK; süzgeç yalnızca
--     uygulamanın kendi gönderdiği filtrelerdir.
--   * `*` = `to_jsonb(satır)` (bütün sütunlar), seçilen sütunlar aynı
--     anahtar adlarıyla. Gömülü kaynak PostgREST'teki adıyla: çoka-bir →
--     nesne ya da (satır yoksa / RLS gizliyorsa) null; bire-çok → dizi,
--     boşsa []. `!inner` → eşleşmeyen bağ satırı diziden düşer.
--   * Sıralama uygulamanın `order`'ı; NULL'lar Postgres'in varsayılanı
--     (asc → sonda, desc → başta), PostgREST de böyle. Sırasız okumalar
--     `created_at, id` (ya da anahtar) ile sıralanır: PostgREST'te sıra
--     tanımsızdı, burada deterministik. Gömülü dizilerin sırası PostgREST'te
--     de tanımsız; burada bağ satırının `id`'si.
--   * Sayfalama `p_offset` / `p_limit` (PostgREST'in `offset` / `limit`'i;
--     `range(from, to)` → `p_offset = from`, `p_limit = to - from + 1`).
--     Yanıt düz dizi: `paged_query.dart` toplam sayı kullanmıyor, kısa
--     sayfada duruyor. `p_limit` null → hepsi.
--   * `search_path = public, extensions`: Supabase PostgREST'inin istek
--     ortamı (politikaların çağırdığı yardımcılar orada çalışıyordu).
--   * Yalnızca authenticated (ve sunucu içi service_role) çağırır; anon'a
--     kapalı (uygulamalar bu okumaları oturumla yapıyor). PostgREST anon'a
--     boş liste dönerdi; bizde 401 — kimse oturumsuz istemiyor.
--
-- Canlıya karşılığı YOK: yalnızca yeni backend'de lazım, yönetim reposuna
-- eklenmez. Her fonksiyonun yorumu `backend:` ile başlar;
-- scripts/schema-fingerprint.sql bunları canlı karşılaştırmasından çıkarır.
-- =============================================================================

-- ---------------------------------------------------------------- sporcular

-- Y athletes_data_source.dart fetchAthletes — sporcu listesi (sayfalı).
create function public.list_athletes(
  p_offset integer default 0,
  p_limit integer default null
) returns jsonb
language sql stable security invoker
set search_path = public, extensions
as $$
  select coalesce(jsonb_agg(r.j order by r.created_at, r.id), '[]'::jsonb)
    from (
      select a.created_at, a.id,
             to_jsonb(a) || jsonb_build_object(
               'classes', (
                 select jsonb_build_object(
                          'id', c.id, 'name', c.name,
                          'sports', (select jsonb_build_object('name', s.name)
                                       from public.sports s where s.id = c.sport_id))
                   from public.classes c where c.id = a.class_id),
               'branches', (
                 select jsonb_build_object('id', b.id, 'name', b.name)
                   from public.branches b where b.id = a.branch_id),
               'parent_athlete_links', coalesce((
                 select jsonb_agg(jsonb_build_object(
                          'profile_id', l.profile_id,
                          'profiles', jsonb_build_object(
                            'full_name', p.full_name,
                            'phone_number', p.phone_number))
                          order by l.id)
                   from public.parent_athlete_links l
                   join public.profiles p on p.id = l.profile_id   -- profiles!inner
                  where l.athlete_id = a.id), '[]'::jsonb)
             ) as j
        from public.athletes a
       order by a.created_at, a.id
      offset p_offset limit p_limit
    ) r
$$;

-- Y attendances_data_source.dart fetchRosterAthletes — çevrimdışı yoklama
-- şablonu (RosterAthleteDto.columns).
create function public.list_roster_athletes(
  p_offset integer default 0,
  p_limit integer default null
) returns jsonb
language sql stable security invoker
set search_path = public, extensions
as $$
  select coalesce(jsonb_agg(r.j order by r.created_at, r.id), '[]'::jsonb)
    from (
      select a.created_at, a.id,
             jsonb_build_object(
               'id', a.id, 'full_name', a.full_name, 'class_id', a.class_id,
               'photo_path', a.photo_path, 'approval_status', a.approval_status) as j
        from public.athletes a
       order by a.created_at, a.id
      offset p_offset limit p_limit
    ) r
$$;

-- Y reminders_data_source.dart _fetchBirthdayCandidates — aktif, doğum
-- tarihi olan sporcular (sayfalı).
create function public.list_birthday_candidates(
  p_offset integer default 0,
  p_limit integer default null
) returns jsonb
language sql stable security invoker
set search_path = public, extensions
as $$
  select coalesce(jsonb_agg(r.j order by r.id), '[]'::jsonb)
    from (
      select a.id,
             jsonb_build_object(
               'id', a.id, 'full_name', a.full_name,
               'date_of_birth', a.date_of_birth, 'photo_path', a.photo_path) as j
        from public.athletes a
       where a.approval_status = 'active'
         and a.date_of_birth is not null
       order by a.id
      offset p_offset limit p_limit
    ) r
$$;

-- Y reminders_data_source.dart _fetchExpiringRegistrations — sözleşmesi
-- [p_from, p_to] arasında biten aktif sporcular.
create function public.list_expiring_registrations(
  p_from date,
  p_to date
) returns jsonb
language sql stable security invoker
set search_path = public, extensions
as $$
  select coalesce(jsonb_agg(
           jsonb_build_object(
             'id', a.id, 'full_name', a.full_name,
             'contract_end_date', a.contract_end_date, 'photo_path', a.photo_path,
             'classes', (
               select jsonb_build_object(
                        'name', c.name,
                        'sports', (select jsonb_build_object('name', s.name)
                                     from public.sports s where s.id = c.sport_id))
                 from public.classes c where c.id = a.class_id),
             'branches', (
               select jsonb_build_object('name', b.name)
                 from public.branches b where b.id = a.branch_id))
           order by a.contract_end_date, a.id), '[]'::jsonb)
    from public.athletes a
   where a.approval_status = 'active'
     and a.contract_end_date >= p_from
     and a.contract_end_date <= p_to
$$;

-- ------------------------------------------------------------------ yoklama

-- Y attendances_data_source.dart fetchAttendances (geçmiş, sayfalı) ve
-- fetchClassAttendance (p_start_date = p_end_date = gün, p_class_id). Boş
-- (null) filtre uygulanmaz — uygulama da boş filtreyi eklemiyor.
create function public.list_attendances(
  p_start_date date,
  p_end_date date,
  p_branch_id uuid default null,
  p_class_id uuid default null,
  p_coach_id uuid default null,
  p_offset integer default 0,
  p_limit integer default null
) returns jsonb
language sql stable security invoker
set search_path = public, extensions
as $$
  select coalesce(jsonb_agg(r.j order by r.attendance_date desc, r.id), '[]'::jsonb)
    from (
      select t.attendance_date, t.id,
             to_jsonb(t) || jsonb_build_object(
               'athletes', (
                 select jsonb_build_object('id', a.id, 'full_name', a.full_name)
                   from public.athletes a where a.id = t.athlete_id),
               'classes', (
                 select jsonb_build_object('id', c.id, 'name', c.name)
                   from public.classes c where c.id = t.class_id),
               'branches', (
                 select jsonb_build_object('id', b.id, 'name', b.name)
                   from public.branches b where b.id = t.branch_id),
               -- coach:profiles!attendances_coach_id_fkey
               'coach', (
                 select jsonb_build_object('id', p.id, 'full_name', p.full_name)
                   from public.profiles p where p.id = t.coach_id)
             ) as j
        from public.attendances t
       where t.attendance_date >= p_start_date
         and t.attendance_date <= p_end_date
         and (p_branch_id is null or t.branch_id = p_branch_id)
         and (p_class_id is null or t.class_id = p_class_id)
         and (p_coach_id is null or t.coach_id = p_coach_id)
       order by t.attendance_date desc, t.id
      offset p_offset limit p_limit
    ) r
$$;

-- ------------------------------------------------------------------ ön kayıt

-- Y pre_registration_data_source.dart fetchPreRegistrations (sayfalı).
create function public.list_pre_registrations(
  p_offset integer default 0,
  p_limit integer default null
) returns jsonb
language sql stable security invoker
set search_path = public, extensions
as $$
  select coalesce(jsonb_agg(r.j order by r.created_at, r.id), '[]'::jsonb)
    from (
      select t.created_at, t.id,
             to_jsonb(t) || jsonb_build_object(
               'branches', (
                 select jsonb_build_object('id', b.id, 'name', b.name)
                   from public.branches b where b.id = t.branch_id),
               'classes', (
                 select jsonb_build_object(
                          'id', c.id, 'name', c.name,
                          'sports', (select jsonb_build_object('id', s.id, 'name', s.name)
                                       from public.sports s where s.id = c.sport_id))
                   from public.classes c where c.id = t.class_id)
             ) as j
        from public.pre_registrations t
       order by t.created_at, t.id
      offset p_offset limit p_limit
    ) r
$$;

-- ---------------------------------------------------------------- profiller

-- Y parents_data_source.dart fetchParents — veliler (role_id = 8, sayfalı).
create function public.list_parents(
  p_offset integer default 0,
  p_limit integer default null
) returns jsonb
language sql stable security invoker
set search_path = public, extensions
as $$
  select coalesce(jsonb_agg(r.j order by r.created_at, r.id), '[]'::jsonb)
    from (
      select p.created_at, p.id,
             to_jsonb(p) || jsonb_build_object(
               'parent_athlete_links', coalesce((
                 select jsonb_agg(jsonb_build_object(
                          'athletes', (select jsonb_build_object('id', a.id, 'full_name', a.full_name)
                                         from public.athletes a where a.id = l.athlete_id))
                          order by l.id)
                   from public.parent_athlete_links l
                  where l.profile_id = p.id), '[]'::jsonb),
               'profile_branch_links', coalesce((
                 select jsonb_agg(jsonb_build_object('branch_id', l.branch_id) order by l.id)
                   from public.profile_branch_links l
                  where l.profile_id = p.id), '[]'::jsonb)
             ) as j
        from public.profiles p
       where p.role_id = 8
       order by p.created_at, p.id
      offset p_offset limit p_limit
    ) r
$$;

-- Y coaches_data_source.dart fetchCoaches — antrenörler (role_id = 4).
create function public.list_coaches()
returns jsonb
language sql stable security invoker
set search_path = public, extensions
as $$
  select coalesce(jsonb_agg(
           to_jsonb(p) || jsonb_build_object(
             'coach_class_links', coalesce((
               select jsonb_agg(jsonb_build_object(
                        'class_id', l.class_id,
                        'classes', (select jsonb_build_object('id', c.id, 'name', c.name)
                                      from public.classes c where c.id = l.class_id))
                        order by l.id)
                 from public.coach_class_links l
                where l.profile_id = p.id), '[]'::jsonb),
             'profile_branch_links', coalesce((
               select jsonb_agg(jsonb_build_object(
                        'branch_id', l.branch_id,
                        'branches', (select jsonb_build_object('id', b.id, 'name', b.name)
                                       from public.branches b where b.id = l.branch_id))
                        order by l.id)
                 from public.profile_branch_links l
                where l.profile_id = p.id), '[]'::jsonb),
             -- profile_permissions!profile_permissions_profile_id_fkey
             'profile_permissions', coalesce((
               select jsonb_agg(jsonb_build_object('permission', pp.permission) order by pp.id)
                 from public.profile_permissions pp
                where pp.profile_id = p.id), '[]'::jsonb))
           order by p.created_at, p.id), '[]'::jsonb)
    from public.profiles p
   where p.role_id = 4
$$;

-- Y users_data_source.dart fetchUsers — personel (antrenör ve veli hariç:
-- `role_id not in (4, 8)`; role_id'si null olan da düşer, PostgREST gibi).
create function public.list_users()
returns jsonb
language sql stable security invoker
set search_path = public, extensions
as $$
  select coalesce(jsonb_agg(
           to_jsonb(p) || jsonb_build_object(
             'roles', (select jsonb_build_object('name', ro.name)
                         from public.roles ro where ro.id = p.role_id),
             'profile_branch_links', coalesce((
               select jsonb_agg(jsonb_build_object('branch_id', l.branch_id) order by l.id)
                 from public.profile_branch_links l
                where l.profile_id = p.id), '[]'::jsonb),
             'profile_permissions', coalesce((
               select jsonb_agg(jsonb_build_object('permission', pp.permission) order by pp.id)
                 from public.profile_permissions pp
                where pp.profile_id = p.id), '[]'::jsonb))
           order by p.created_at, p.id), '[]'::jsonb)
    from public.profiles p
   where not (p.role_id in (4, 8))
$$;

-- Y users_data_source.dart fetchRoles — kullanıcı formunun rol listesi;
-- düşülecek id'leri uygulama gönderir (`id not in (...)`). Boş/null → hepsi.
create function public.list_roles(
  p_exclude_ids bigint[] default null
) returns jsonb
language sql stable security invoker
set search_path = public, extensions
as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', ro.id, 'name', ro.name)
           order by ro.id), '[]'::jsonb)
    from public.roles ro
   where not (ro.id = any (coalesce(p_exclude_ids, '{}')))
$$;

-- Y permissions_data_source.dart fetchRolePermissions — yetki matrisi.
create function public.list_role_permissions()
returns jsonb
language sql stable security invoker
set search_path = public, extensions
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'role_id', rp.role_id, 'permission', rp.permission,
           'is_optional', rp.is_optional)
           order by rp.role_id, rp.permission), '[]'::jsonb)
    from public.role_permissions rp
$$;

-- ------------------------------------------------- şube, sınıf, branş, okul

-- Y branch_data_source.dart fetchBranches — şubeler ve yöneticileri:
-- `profile_branch_links(profiles!inner(*, roles(name)))` +
-- `profile_branch_links.profiles.role_id in (1,2,3,9)`. Bağ satırı, profili
-- görünmüyorsa ya da rolü yönetici değilse diziden düşer; şube düşmez.
create function public.list_branches()
returns jsonb
language sql stable security invoker
set search_path = public, extensions
as $$
  select coalesce(jsonb_agg(
           to_jsonb(b) || jsonb_build_object(
             'profile_branch_links', coalesce((
               select jsonb_agg(jsonb_build_object(
                        'profiles', to_jsonb(p) || jsonb_build_object(
                          'roles', (select jsonb_build_object('name', ro.name)
                                      from public.roles ro where ro.id = p.role_id)))
                        order by l.id)
                 from public.profile_branch_links l
                 join public.profiles p
                   on p.id = l.profile_id and p.role_id in (1, 2, 3, 9)
                where l.branch_id = b.id), '[]'::jsonb))
           order by b.created_at, b.id), '[]'::jsonb)
    from public.branches b
$$;

-- Y classes_data_source.dart fetchClasses — sınıflar, sporcuları, programı
-- ve eğitmenleri.
create function public.list_classes()
returns jsonb
language sql stable security invoker
set search_path = public, extensions
as $$
  select coalesce(jsonb_agg(
           to_jsonb(c) || jsonb_build_object(
             'branches', (select jsonb_build_object('id', b.id, 'name', b.name)
                            from public.branches b where b.id = c.branch_id),
             'sports', (select jsonb_build_object('id', s.id, 'name', s.name)
                          from public.sports s where s.id = c.sport_id),
             'athletes', coalesce((
               select jsonb_agg(jsonb_build_object('id', a.id, 'full_name', a.full_name)
                        order by a.created_at, a.id)
                 from public.athletes a where a.class_id = c.id), '[]'::jsonb),
             'class_schedule_slots', coalesce((
               select jsonb_agg(jsonb_build_object(
                        'weekday', sl.weekday, 'start_time', sl.start_time)
                        order by sl.weekday, sl.id)
                 from public.class_schedule_slots sl where sl.class_id = c.id), '[]'::jsonb),
             'coach_class_links', coalesce((
               select jsonb_agg(jsonb_build_object(
                        'profile_id', l.profile_id,
                        'profiles', (select jsonb_build_object(
                                              'id', p.id, 'full_name', p.full_name,
                                              'status', p.status, 'role_id', p.role_id,
                                              'is_deleted', p.is_deleted)
                                       from public.profiles p where p.id = l.profile_id))
                        order by l.id)
                 from public.coach_class_links l where l.class_id = c.id), '[]'::jsonb))
           order by c.created_at, c.id), '[]'::jsonb)
    from public.classes c
$$;

-- Y sports_data_source.dart fetchSports — branşlar ve şubeleri.
create function public.list_sports()
returns jsonb
language sql stable security invoker
set search_path = public, extensions
as $$
  select coalesce(jsonb_agg(
           to_jsonb(s) || jsonb_build_object(
             'branch_sport_links', coalesce((
               select jsonb_agg(jsonb_build_object(
                        'branches', (select jsonb_build_object('id', b.id, 'name', b.name)
                                       from public.branches b where b.id = l.branch_id))
                        order by l.id)
                 from public.branch_sport_links l where l.sport_id = s.id), '[]'::jsonb))
           order by s.created_at, s.id), '[]'::jsonb)
    from public.sports s
$$;

-- Y school_data_source.dart fetchSchool — `.eq('id', …).maybeSingle()`:
-- satır nesnesi ya da (yok / görünmüyor) null.
create function public.get_school(
  p_school_id uuid
) returns jsonb
language sql stable security invoker
set search_path = public, extensions
as $$
  select to_jsonb(s) from public.schools s where s.id = p_school_id
$$;

-- -------------------------------------------------------------------- finans

-- Y customers_data_source.dart fetchCustomers — cari rehberi; `p_types`
-- CustomerScope'un `queryValue`'ları (`type in (...)`), null/boş → hepsi.
create function public.list_customers(
  p_types public.customer_type[] default null,
  p_offset integer default 0,
  p_limit integer default null
) returns jsonb
language sql stable security invoker
set search_path = public, extensions
as $$
  select coalesce(jsonb_agg(r.j order by r.display_name, r.id), '[]'::jsonb)
    from (
      select cu.display_name, cu.id,
             to_jsonb(cu) || jsonb_build_object(
               'athletes', (
                 select jsonb_build_object(
                          'id', a.id, 'full_name', a.full_name,
                          'class_id', a.class_id, 'branch_id', a.branch_id,
                          'classes', (select jsonb_build_object('id', c.id, 'name', c.name)
                                        from public.classes c where c.id = a.class_id))
                   from public.athletes a where a.id = cu.athlete_id)
             ) as j
        from public.customers cu
       where (coalesce(cardinality(p_types), 0) = 0 or cu.type = any (p_types))
       order by cu.display_name, cu.id
      offset p_offset limit p_limit
    ) r
$$;

-- Y financial_records_data_source.dart fetchRecords — bir türün kayıtları,
-- muhatap/sınıf/branş, kalem, şube ve tahsilatlar (silinmişler dahil — kalan
-- borç istemcide hesaplanır) ile (sayfalı).
create function public.list_financial_records(
  p_type public.accounting_type,
  p_offset integer default 0,
  p_limit integer default null
) returns jsonb
language sql stable security invoker
set search_path = public, extensions
as $$
  select coalesce(jsonb_agg(r.j order by r.expected_date desc, r.id), '[]'::jsonb)
    from (
      select f.expected_date, f.id,
             to_jsonb(f) || jsonb_build_object(
               'customers', (
                 select jsonb_build_object(
                          'id', cu.id, 'display_name', cu.display_name, 'type', cu.type,
                          'phone', cu.phone, 'email', cu.email, 'athlete_id', cu.athlete_id,
                          'athletes', (
                            select jsonb_build_object(
                                     'id', a.id, 'full_name', a.full_name, 'class_id', a.class_id,
                                     'classes', (
                                       select jsonb_build_object(
                                                'id', c.id, 'name', c.name, 'sport_id', c.sport_id,
                                                'sports', (select jsonb_build_object('id', s.id, 'name', s.name)
                                                             from public.sports s where s.id = c.sport_id))
                                         from public.classes c where c.id = a.class_id))
                              from public.athletes a where a.id = cu.athlete_id))
                   from public.customers cu where cu.id = f.customer_id),
               'income_expense_items', (
                 select jsonb_build_object('id', i.id, 'name', i.name)
                   from public.income_expense_items i where i.id = f.income_expense_item_id),
               'branches', (
                 select jsonb_build_object('id', b.id, 'name', b.name)
                   from public.branches b where b.id = f.branch_id),
               'transactions', coalesce((
                 select jsonb_agg(jsonb_build_object(
                          'id', t.id, 'record_id', t.record_id, 'amount', t.amount,
                          'method', t.method, 'transaction_date', t.transaction_date,
                          'created_at', t.created_at, 'is_deleted', t.is_deleted,
                          'processed_by', t.processed_by,
                          'profiles', (select jsonb_build_object('id', p.id, 'full_name', p.full_name)
                                         from public.profiles p where p.id = t.processed_by))
                          order by t.created_at, t.id)
                   from public.transactions t where t.record_id = f.id), '[]'::jsonb)
             ) as j
        from public.financial_records f
       where f.type = p_type
       order by f.expected_date desc, f.id
      offset p_offset limit p_limit
    ) r
$$;

-- Y income_expense_items_data_source.dart fetchIncomeExpenseItems.
create function public.list_income_expense_items()
returns jsonb
language sql stable security invoker
set search_path = public, extensions
as $$
  select coalesce(jsonb_agg(
           to_jsonb(i) || jsonb_build_object(
             'branch_income_expense_item_links', coalesce((
               select jsonb_agg(jsonb_build_object(
                        'branches', (select jsonb_build_object('id', b.id, 'name', b.name)
                                       from public.branches b where b.id = l.branch_id))
                        order by l.id)
                 from public.branch_income_expense_item_links l
                where l.income_expense_item_id = i.id), '[]'::jsonb))
           order by i.created_at, i.id), '[]'::jsonb)
    from public.income_expense_items i
$$;

-- Y discounts_data_source.dart fetchDiscounts — `order created_at desc`.
create function public.list_discounts()
returns jsonb
language sql stable security invoker
set search_path = public, extensions
as $$
  select coalesce(jsonb_agg(
           to_jsonb(d) || jsonb_build_object(
             'branch_discount_links', coalesce((
               select jsonb_agg(jsonb_build_object(
                        'branches', (select jsonb_build_object('id', b.id, 'name', b.name)
                                       from public.branches b where b.id = l.branch_id))
                        order by l.id)
                 from public.branch_discount_links l
                where l.discount_id = d.id), '[]'::jsonb))
           order by d.created_at desc, d.id), '[]'::jsonb)
    from public.discounts d
$$;

-- --------------------------------------------------------------- bildirimler

-- Y announcements_data_source.dart fetchAnnouncements (AnnouncementDto.columns).
create function public.list_announcements(
  p_limit integer default 50
) returns jsonb
language sql stable security invoker
set search_path = public, extensions
as $$
  select coalesce(jsonb_agg(r.j order by r.created_at desc, r.id), '[]'::jsonb)
    from (
      select n.created_at, n.id,
             jsonb_build_object(
               'id', n.id, 'title', n.title, 'body', n.body,
               'role_ids', n.role_ids, 'branch_ids', n.branch_ids,
               'recipient_count', n.recipient_count, 'created_at', n.created_at,
               'profiles', (select jsonb_build_object('full_name', p.full_name)
                              from public.profiles p where p.id = n.sender_id)) as j
        from public.notification_announcements n
       order by n.created_at desc, n.id
       limit p_limit
    ) r
$$;

-- Y + V notifications_data_source.dart fetchInbox — gelen kutusu
-- (NotificationDto.columns). Satırları `notifications_select_own` süzer.
create function public.list_notifications(
  p_limit integer default 50
) returns jsonb
language sql stable security invoker
set search_path = public, extensions
as $$
  select coalesce(jsonb_agg(r.j order by r.created_at desc, r.id), '[]'::jsonb)
    from (
      select n.created_at, n.id,
             jsonb_build_object(
               'id', n.id, 'type', n.type, 'params', n.params,
               'created_at', n.created_at, 'read_at', n.read_at) as j
        from public.notifications n
       order by n.created_at desc, n.id
       limit p_limit
    ) r
$$;

-- Y + V notifications_data_source.dart fetchUnreadCount —
-- `select('id').isFilter('read_at', null).count(exact)`'in sayısı.
create function public.count_unread_notifications()
returns integer
language sql stable security invoker
set search_path = public, extensions
as $$
  select count(*)::integer from public.notifications n where n.read_at is null
$$;

-- Realtime (S11) için: bir bildirim satırının tamamı, Supabase Realtime'ın
-- `record`'u gibi (bütün sütunlar), çağıranın RLS'iyle — alıcı değilse null.
-- Uygulamalar doğrudan çağırmaz; S11'in gateway'i alıcı adına
-- (`DbContextService.withUser`) sorar. Allow-list'te değil.
create function public.get_notification(
  p_id uuid
) returns jsonb
language sql stable security invoker
set search_path = public, extensions
as $$
  select to_jsonb(n) from public.notifications n where n.id = p_id
$$;

-- Y notifications_data_source.dart fetchPreferences — `type, push_enabled`.
create function public.list_notification_preferences()
returns jsonb
language sql stable security invoker
set search_path = public, extensions
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'type', np.type, 'push_enabled', np.push_enabled)
           order by np.type), '[]'::jsonb)
    from public.notification_preferences np
$$;

-- --------------------------------------------------------- yetki ve yorumlar
-- Varsayılan yetkiler (pg_default_acl) anon'a da EXECUTE veriyor; bu
-- okumalar yalnızca oturumla.
do $$
declare
  f regprocedure;
begin
  foreach f in array array[
    'public.list_athletes(integer, integer)',
    'public.list_roster_athletes(integer, integer)',
    'public.list_birthday_candidates(integer, integer)',
    'public.list_expiring_registrations(date, date)',
    'public.list_attendances(date, date, uuid, uuid, uuid, integer, integer)',
    'public.list_pre_registrations(integer, integer)',
    'public.list_parents(integer, integer)',
    'public.list_coaches()',
    'public.list_users()',
    'public.list_roles(bigint[])',
    'public.list_role_permissions()',
    'public.list_branches()',
    'public.list_classes()',
    'public.list_sports()',
    'public.get_school(uuid)',
    'public.list_customers(public.customer_type[], integer, integer)',
    'public.list_financial_records(public.accounting_type, integer, integer)',
    'public.list_income_expense_items()',
    'public.list_discounts()',
    'public.list_announcements(integer)',
    'public.list_notifications(integer)',
    'public.count_unread_notifications()',
    'public.get_notification(uuid)',
    'public.list_notification_preferences()'
  ]::regprocedure[]
  loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated, service_role', f);
    execute format(
      'comment on function %s is %L', f,
      'backend: S07 okuma fonksiyonu (PostgREST .from() karşılığı); canlıda yok. docs/migration/read-mapping.md');
  end loop;
end
$$;

-- migrate:down
drop function if exists public.list_athletes(integer, integer);
drop function if exists public.list_roster_athletes(integer, integer);
drop function if exists public.list_birthday_candidates(integer, integer);
drop function if exists public.list_expiring_registrations(date, date);
drop function if exists public.list_attendances(date, date, uuid, uuid, uuid, integer, integer);
drop function if exists public.list_pre_registrations(integer, integer);
drop function if exists public.list_parents(integer, integer);
drop function if exists public.list_coaches();
drop function if exists public.list_users();
drop function if exists public.list_roles(bigint[]);
drop function if exists public.list_role_permissions();
drop function if exists public.list_branches();
drop function if exists public.list_classes();
drop function if exists public.list_sports();
drop function if exists public.get_school(uuid);
drop function if exists public.list_customers(public.customer_type[], integer, integer);
drop function if exists public.list_financial_records(public.accounting_type, integer, integer);
drop function if exists public.list_income_expense_items();
drop function if exists public.list_discounts();
drop function if exists public.list_announcements(integer);
drop function if exists public.list_notifications(integer);
drop function if exists public.count_unread_notifications();
drop function if exists public.get_notification(uuid);
drop function if exists public.list_notification_preferences();
