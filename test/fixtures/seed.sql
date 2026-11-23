-- =============================================================================
-- Test verisi — UYDURMA, kişisel veri değil
-- =============================================================================
-- Integration testleri `npm run db:migrate`'ten sonra bunu yükler
-- (test/support/database.ts → seed()). Gerçek okullardan, adlardan, telefon
-- ve e-postalardan hiçbiri burada yok; e-postalar `.test` alan adında
-- (RFC 2606, hiçbir zaman teslim edilmez).
--
-- Hesapların hepsinin şifresi: Test1234!
--
-- Okul A — "Deneme Spor Kulübü", brand = dev_adim, is_self_service = false
--   şubeler: A1 (Merkez), A2 (Sahil)
--   a9  genel.mudur@a.test      genel müdür (9)      okul geneli
--   a2  sube.muduru@a.test      şube müdürü (2)      A1
--   a3  mudur.yardimcisi@a.test şube müdür yrd. (3)  A1
--   a4  antrenor@a.test         antrenör (4)         A1, sınıf "U10 Futbol"
--   a5  muhasebe@a.test         muhasebeci (5)       A1, A2
--   a6  diyetisyen@a.test       diyetisyen (6)       uygulamaya giremez
--   a8  veli@a.test             veli (8), aktif      çocuğu: Deniz (A1)
--   b8  pasif.veli@a.test       veli (8), PASİF      çocuğu: Ege (A1)
--   antrenör2: a7 antrenor2@a.test (4) A2, sınıf "U12 Basketbol"
--   sporcular: Deniz, Ege (U10 Futbol, A1), Ada (U12 Basketbol, A2, velisiz)
--
-- Okul B — "Örnek Spor Akademisi", brand = public, is_self_service = true
--   c9  genel.mudur@b.test      genel müdür (9)
--   c4  antrenor@b.test         antrenör (4)
--   c8  veli@b.test             veli (8)             çocuğu: Mina
--
-- Yoklama ve ödemeler Eylül 2026'da: yoklama trigger'ı yalnızca bugün ve
-- dün için veliye bildirim yazar, bu tarihler bildirim üretmez.
-- Kimlikler sabit; testler bunlara göre yazılır (test/fixtures/seed-ids.ts).
-- =============================================================================

begin;

create temp table seed_users (id uuid, email text, name text, role_id bigint, phone text, school uuid, status public.approval_status) on commit drop;
insert into seed_users values
  ('a0000000-0000-4000-8000-0000000000a9', 'genel.mudur@a.test',      'Selin Deneme',   9, '5550000009', 'a0000000-0000-4000-8000-000000000001', 'active'),
  ('a0000000-0000-4000-8000-0000000000a2', 'sube.muduru@a.test',      'Kemal Deneme',   2, '5550000002', 'a0000000-0000-4000-8000-000000000001', 'active'),
  ('a0000000-0000-4000-8000-0000000000a3', 'mudur.yardimcisi@a.test', 'Nur Deneme',     3, '5550000003', 'a0000000-0000-4000-8000-000000000001', 'active'),
  ('a0000000-0000-4000-8000-0000000000a4', 'antrenor@a.test',         'Okan Deneme',    4, '5550000004', 'a0000000-0000-4000-8000-000000000001', 'active'),
  ('a0000000-0000-4000-8000-0000000000a7', 'antrenor2@a.test',        'Pelin Deneme',   4, '5550000007', 'a0000000-0000-4000-8000-000000000001', 'active'),
  ('a0000000-0000-4000-8000-0000000000a5', 'muhasebe@a.test',         'Tarık Deneme',   5, '5550000005', 'a0000000-0000-4000-8000-000000000001', 'active'),
  ('a0000000-0000-4000-8000-0000000000a6', 'diyetisyen@a.test',       'Gül Deneme',     6, '5550000006', 'a0000000-0000-4000-8000-000000000001', 'active'),
  ('a0000000-0000-4000-8000-0000000000a8', 'veli@a.test',             'Aylin Deneme',   8, '5550000008', 'a0000000-0000-4000-8000-000000000001', 'active'),
  ('a0000000-0000-4000-8000-0000000000b8', 'pasif.veli@a.test',       'Murat Deneme',   8, '5550000018', 'a0000000-0000-4000-8000-000000000001', 'passive'),
  ('b0000000-0000-4000-8000-0000000000c9', 'genel.mudur@b.test',      'Derya Örnek',    9, '5550000109', 'b0000000-0000-4000-8000-000000000001', 'active'),
  ('b0000000-0000-4000-8000-0000000000c4', 'antrenor@b.test',         'Serkan Örnek',   4, '5550000104', 'b0000000-0000-4000-8000-000000000001', 'active'),
  ('b0000000-0000-4000-8000-0000000000c8', 'veli@b.test',             'İpek Örnek',     8, '5550000108', 'b0000000-0000-4000-8000-000000000001', 'active');

-- ------------------------------------------------------------- auth hesapları
-- Supabase'in e-posta hesabı biçimi (GoTrue'nun yazdığı alanlar).
insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, recovery_token, email_change_token_new, email_change,
  email_change_token_current, phone_change, phone_change_token,
  reauthentication_token, is_sso_user, is_anonymous
)
select '00000000-0000-0000-0000-000000000000', u.id, 'authenticated', 'authenticated',
       u.email, extensions.crypt('Test1234!', extensions.gen_salt('bf')), now(),
       '{"provider":"email","providers":["email"]}'::jsonb,
       jsonb_build_object('name', u.name, 'email_verified', true),
       now(), now(), '', '', '', '', '', '', '', '', false, false
  from seed_users u;

insert into auth.identities (user_id, provider_id, identity_data, provider, created_at, updated_at)
select u.id, u.id::text,
       jsonb_build_object('sub', u.id::text, 'email', u.email,
                          'email_verified', true, 'phone_verified', false),
       'email', now(), now()
  from seed_users u;

-- ------------------------------------------------------------------- okullar
-- Kurucu önce okulsuz: schools.owner_id profile bağlı; kurucu yetkilerini
-- okulun insert trigger'ı verir.
insert into public.profiles (id, school_id, full_name, email, phone_number, status, role_id)
select id, null, name, email, phone, status, role_id from seed_users where role_id = 9;

insert into public.schools (
  id, name, subscription_status, owner_id, trial_starts_at, trial_ends_at,
  city, district, address, is_self_service, brand
) values
  ('a0000000-0000-4000-8000-000000000001', 'Deneme Spor Kulübü', 'active',
   'a0000000-0000-4000-8000-0000000000a9', now(), now(),
   'İzmir', 'Karşıyaka', 'Deneme Mah. 1. Sok. No: 1', false, 'dev_adim'),
  ('b0000000-0000-4000-8000-000000000001', 'Örnek Spor Akademisi', 'trial',
   'b0000000-0000-4000-8000-0000000000c9', now(), now() + interval '14 days',
   'Ankara', 'Çankaya', 'Örnek Cad. No: 2', true, 'public');

update public.profiles p set school_id = u.school
  from seed_users u where p.id = u.id and u.role_id = 9;

insert into public.profiles (id, school_id, full_name, email, phone_number, status, role_id)
select id, school, name, email, phone, status, role_id from seed_users where role_id <> 9;

-- ------------------------------------------------- şube, branş, sınıf, program
insert into public.branches (id, school_id, name, address, phone_number, status) values
  ('a0000000-0000-4000-8000-0000000000b1', 'a0000000-0000-4000-8000-000000000001', 'Merkez', 'Deneme Mah. 1', '2320000001', 'active'),
  ('a0000000-0000-4000-8000-0000000000b2', 'a0000000-0000-4000-8000-000000000001', 'Sahil',  'Deneme Mah. 2', '2320000002', 'active'),
  ('b0000000-0000-4000-8000-0000000000b1', 'b0000000-0000-4000-8000-000000000001', 'Çankaya', 'Örnek Cad. 2', '3120000001', 'active');

insert into public.sports (id, school_id, name) values
  ('a0000000-0000-4000-8000-0000000000c1', 'a0000000-0000-4000-8000-000000000001', 'Futbol'),
  ('a0000000-0000-4000-8000-0000000000c2', 'a0000000-0000-4000-8000-000000000001', 'Basketbol'),
  ('b0000000-0000-4000-8000-0000000000c1', 'b0000000-0000-4000-8000-000000000001', 'Yüzme');

insert into public.branch_sport_links (branch_id, sport_id, school_id) values
  ('a0000000-0000-4000-8000-0000000000b1', 'a0000000-0000-4000-8000-0000000000c1', 'a0000000-0000-4000-8000-000000000001'),
  ('a0000000-0000-4000-8000-0000000000b2', 'a0000000-0000-4000-8000-0000000000c2', 'a0000000-0000-4000-8000-000000000001'),
  ('b0000000-0000-4000-8000-0000000000b1', 'b0000000-0000-4000-8000-0000000000c1', 'b0000000-0000-4000-8000-000000000001');

create temp table seed_classes (id uuid, school uuid, branch uuid, sport uuid, name text, coach uuid, weekday smallint) on commit drop;
insert into seed_classes values
  ('a0000000-0000-4000-8000-0000000000d1', 'a0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-0000000000b1', 'a0000000-0000-4000-8000-0000000000c1', 'U10 Futbol',    'a0000000-0000-4000-8000-0000000000a4', 1),
  ('a0000000-0000-4000-8000-0000000000d2', 'a0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-0000000000b2', 'a0000000-0000-4000-8000-0000000000c2', 'U12 Basketbol', 'a0000000-0000-4000-8000-0000000000a7', 3),
  ('b0000000-0000-4000-8000-0000000000d1', 'b0000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-0000000000b1', 'b0000000-0000-4000-8000-0000000000c1', 'Minikler Yüzme', 'b0000000-0000-4000-8000-0000000000c4', 6);

insert into public.classes (id, branch_id, sport_id, name, school_id, quota)
select id, branch, sport, name, school, 16 from seed_classes;

insert into public.branch_class_links (branch_id, class_id, school_id)
select branch, id, school from seed_classes;

insert into public.class_schedule_slots (class_id, school_id, weekday, start_time)
select id, school, weekday, time '17:00' from seed_classes;

insert into public.coach_class_links (school_id, profile_id, class_id)
select school, coach, id from seed_classes;

insert into public.profile_branch_links (profile_id, branch_id, school_id)
select p, b, s
  from (values
    ('a0000000-0000-4000-8000-0000000000a2'::uuid, 'a0000000-0000-4000-8000-0000000000b1'::uuid, 'a0000000-0000-4000-8000-000000000001'::uuid),
    ('a0000000-0000-4000-8000-0000000000a3', 'a0000000-0000-4000-8000-0000000000b1', 'a0000000-0000-4000-8000-000000000001'),
    ('a0000000-0000-4000-8000-0000000000a4', 'a0000000-0000-4000-8000-0000000000b1', 'a0000000-0000-4000-8000-000000000001'),
    ('a0000000-0000-4000-8000-0000000000a7', 'a0000000-0000-4000-8000-0000000000b2', 'a0000000-0000-4000-8000-000000000001'),
    ('a0000000-0000-4000-8000-0000000000a5', 'a0000000-0000-4000-8000-0000000000b1', 'a0000000-0000-4000-8000-000000000001'),
    ('a0000000-0000-4000-8000-0000000000a5', 'a0000000-0000-4000-8000-0000000000b2', 'a0000000-0000-4000-8000-000000000001'),
    ('a0000000-0000-4000-8000-0000000000a6', 'a0000000-0000-4000-8000-0000000000b1', 'a0000000-0000-4000-8000-000000000001'),
    ('a0000000-0000-4000-8000-0000000000a8', 'a0000000-0000-4000-8000-0000000000b1', 'a0000000-0000-4000-8000-000000000001'),
    ('a0000000-0000-4000-8000-0000000000b8', 'a0000000-0000-4000-8000-0000000000b1', 'a0000000-0000-4000-8000-000000000001'),
    ('b0000000-0000-4000-8000-0000000000c4', 'b0000000-0000-4000-8000-0000000000b1', 'b0000000-0000-4000-8000-000000000001'),
    ('b0000000-0000-4000-8000-0000000000c8', 'b0000000-0000-4000-8000-0000000000b1', 'b0000000-0000-4000-8000-000000000001')
  ) x(p, b, s);

-- ---------------------------------------------------------------- sporcular
-- Müşteri (cari) kaydını trg_sync_athlete_to_customer açar.
insert into public.athletes (
  id, branch_id, gender, date_of_birth, registration_date, contract_end_date,
  approval_status, school_id, class_id, full_name, is_deleted
) values
  ('a0000000-0000-4000-8000-000000000101', 'a0000000-0000-4000-8000-0000000000b1', 'male',   '2016-04-10', '2026-09-01', '2027-06-30', 'active', 'a0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-0000000000d1', 'Deniz Deneme', false),
  ('a0000000-0000-4000-8000-000000000102', 'a0000000-0000-4000-8000-0000000000b1', 'male',   '2016-08-22', '2026-09-01', '2027-06-30', 'active', 'a0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-0000000000d1', 'Ege Deneme',   false),
  ('a0000000-0000-4000-8000-000000000103', 'a0000000-0000-4000-8000-0000000000b2', 'female', '2014-02-03', '2026-09-01', '2027-06-30', 'active', 'a0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-0000000000d2', 'Ada Deneme',   false),
  ('b0000000-0000-4000-8000-000000000201', 'b0000000-0000-4000-8000-0000000000b1', 'female', '2018-11-30', '2026-09-01', '2027-06-30', 'active', 'b0000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-0000000000d1', 'Mina Örnek',   false);

insert into public.parent_athlete_links (profile_id, athlete_id, school_id) values
  ('a0000000-0000-4000-8000-0000000000a8', 'a0000000-0000-4000-8000-000000000101', 'a0000000-0000-4000-8000-000000000001'),
  ('a0000000-0000-4000-8000-0000000000b8', 'a0000000-0000-4000-8000-000000000102', 'a0000000-0000-4000-8000-000000000001'),
  ('b0000000-0000-4000-8000-0000000000c8', 'b0000000-0000-4000-8000-000000000201', 'b0000000-0000-4000-8000-000000000001');

-- ------------------------------------------------------------------- yoklama
-- Her sınıfın Eylül 2026'daki iki antrenmanı.
insert into public.attendances (
  school_id, branch_id, class_id, athlete_id, attendance_date, status, coach_id, created_by
)
select a.school_id, a.branch_id, a.class_id, a.id, d,
       (case when a.id = 'a0000000-0000-4000-8000-000000000102' and d = date '2026-09-14'
             then 'absent' else 'present' end)::public.attendance_status,
       c.coach, c.coach
  from public.athletes a
  join seed_classes c on c.id = a.class_id
 cross join (values (date '2026-09-07'), (date '2026-09-14')) x(d);

-- -------------------------------------------------------------------- finans
insert into public.income_expense_items (id, school_id, name, value, type) values
  ('a0000000-0000-4000-8000-0000000000e1', 'a0000000-0000-4000-8000-000000000001', 'Aylık Aidat', 1500, 'income'),
  ('b0000000-0000-4000-8000-0000000000e1', 'b0000000-0000-4000-8000-000000000001', 'Aylık Aidat', 2000, 'income');

-- Her sporcuya Eylül aidatı; Deniz ve Mina ödedi, Ege ödemedi, Ada yarısını.
insert into public.financial_records (
  id, customer_id, income_expense_item_id, branch_id, type, name,
  expected_date, base_amount, discount_amount, net_amount, status,
  created_by, school_id, is_deleted
)
select ('f' || substr(a.id::text, 2))::uuid, cu.id, i.id, a.branch_id, 'due', 'Eylül 2026 Aidatı',
       date '2026-09-10', i.value, 0, i.value,
       (case a.id
          when 'a0000000-0000-4000-8000-000000000102' then 'unpaid'
          when 'a0000000-0000-4000-8000-000000000103' then 'partial'
          else 'paid' end)::public.payment_status,
       s.owner_id, a.school_id, false
  from public.athletes a
  join public.customers cu on cu.athlete_id = a.id
  join public.income_expense_items i on i.school_id = a.school_id
  join public.schools s on s.id = a.school_id;

insert into public.transactions (record_id, amount, method, transaction_date, processed_by, school_id, branch_id, is_deleted)
select r.id,
       case r.status when 'partial' then r.net_amount / 2 else r.net_amount end,
       'cash', timestamptz '2026-09-09 15:00+03', r.created_by, r.school_id, r.branch_id, false
  from public.financial_records r
 where r.status in ('paid', 'partial');

commit;
