# Tablo okumaları → okuma fonksiyonları (S07, K7)

Uygulamaların PostgREST'e yaptığı her `.from(tablo).select(...)` okumasının
yeni backend'deki karşılığı. Fonksiyonlar `db/migrations/0007_read_functions.sql`'de;
hepsi `SECURITY INVOKER`, `stable`, `jsonb` (biri `integer`) döner, yalnızca
`authenticated` çağırır ve `POST /rpc/<ad>` ile (allow-list:
`src/rpc/rpc-allowlist.ts` → `READS`) açılır. S13 (veli) ve S15 (yönetim)
Dart tarafında `.from(...)...` zincirini `.rpc(<ad>, params: {...})`'ye
çevirir; **DTO'lar değişmez**, çünkü yanıt PostgREST'inkiyle aynı JSON'dur.

Satır numaraları 2026-11-23'teki `main` (Y `f28053c`, V aynı gün).

## Ortak sözleşme

| Konu | PostgREST'te | Fonksiyonda |
|---|---|---|
| Yetki | Tablo ve gömülü tabloların RLS'i, çağıranın rolüyle | Aynı: SECURITY INVOKER, aynı `request.jwt.claims`. Yeni kural yok |
| `*` | Bütün sütunlar | `to_jsonb(satır)` — aynı anahtarlar ve değer biçimleri |
| Çoka-bir gömme (`classes(id, name)`) | Nesne; satır yok ya da RLS gizliyorsa `null` | Aynı (alt sorgu) |
| Bire-çok gömme (`coach_class_links(...)`) | Dizi, boşsa `[]`; RLS'in gizlediği satırlar yok | Aynı; dizi sırası PostgREST'te tanımsız, burada bağ satırının `id`'si |
| `!inner` | Eşleşmeyen bağ satırı diziden düşer | İç `join` |
| Sıralama | `order=a.desc,id.asc`; NULL'lar Postgres'in varsayılanı | Aynı `order by`. Sırasız okumalar `created_at, id` (ya da anahtar) ile — PostgREST'te tanımsızdı |
| Sayfalama | `range(from, to)` → `offset` / `limit` | `p_offset` / `p_limit` (null → hepsi); yanıt **düz dizi** |
| Tek satır (`maybeSingle`) | Nesne ya da `null` | Nesne ya da `null` |
| Sayı (`count(exact)`) | `Content-Range` başlığı | Fonksiyonun dönüşü (tam sayı) |
| Oturumsuz | anon: RLS'e göre boş liste | 401 `42501` (anon'a EXECUTE yok; uygulamalar bu okumaları oturumla yapar) |
| Yanlış tip (`p_type: 'x'`) | 400 `22P02` | 400 `22P02` |

**Sayfalama şekli.** Oturum dosyası örnek olarak `{items, total}` diyordu;
`paged_query.dart` toplam sayı kullanmıyor (kısa sayfada durur), bu yüzden
yanıt PostgREST'teki gibi düz dizi kaldı. Dart'ta `PagedQuery.fetchAll`
aynen kalır, yalnızca sayfa kapanışı değişir:

```dart
PagedQuery.fetchAll((from, to) async => List<Map<String, dynamic>>.from(
  await client.rpc(listAthletesRpc,
      params: {'p_offset': from, 'p_limit': to - from + 1}) as List));
```

Sayfa boyutu 1000 kalabilir (yeni backend'de satır sınırı yok, ama tek yanıt
8 sn'lik `statement_timeout`'a sığmalı).

## Çağrı noktaları

Y = `../mobil_spor_okulu/lib/features/`, V = `../mobil_spor_okulu_veli/lib/features/`.

| # | Dart dosyası:satır | Tablo | select (embed'ler) | Filtre | Sıra | Sayfa | Fonksiyon (parametreler) |
|---|---|---|---|---|---|---|---|
| 1 | Y `registration/data/source/athletes/athletes_data_source.dart:29` fetchAthletes | athletes | `*, classes(id, name, sports(name)), branches(id, name), parent_athlete_links(profile_id, profiles!inner(full_name, phone_number))` | — | created_at, id | ✓ | `list_athletes(p_offset, p_limit)` |
| 2 | Y `attendance/data/source/attendances/attendances_data_source.dart:114` fetchRosterAthletes | athletes | `id, full_name, class_id, photo_path, approval_status` (RosterAthleteDto.columns) | — | created_at, id | ✓ | `list_roster_athletes(p_offset, p_limit)` |
| 3 | Y `notifications/data/source/reminders_data_source.dart:39` _fetchBirthdayCandidates | athletes | `id, full_name, date_of_birth, photo_path` | approval_status = active, date_of_birth not null | id | ✓ | `list_birthday_candidates(p_offset, p_limit)` |
| 4 | Y `notifications/data/source/reminders_data_source.dart:57` _fetchExpiringRegistrations | athletes | `id, full_name, contract_end_date, photo_path, classes(name, sports(name)), branches(name)` | approval_status = active, contract_end_date ∈ [from, to] | contract_end_date (+ id) | — | `list_expiring_registrations(p_from, p_to)` |
| 5 | Y `attendance/data/source/attendances/attendances_data_source.dart:61` fetchAttendances | attendances | `*, athletes(id, full_name), classes(id, name), branches(id, name), coach:profiles!attendances_coach_id_fkey(id, full_name)` | attendance_date ∈ [start, end]; branch_id, class_id, coach_id (verilirse) | attendance_date desc, id | ✓ | `list_attendances(p_start_date, p_end_date, p_branch_id?, p_class_id?, p_coach_id?, p_offset, p_limit)` |
| 6 | Y `attendance/data/source/attendances/attendances_data_source.dart:100` fetchClassAttendance | attendances | (5 ile aynı) | class_id = X, attendance_date = gün | — | — | `list_attendances(p_start_date: gün, p_end_date: gün, p_class_id: X)` |
| 7 | Y `registration/data/source/pre_registration/pre_registration_data_source.dart:30` fetchPreRegistrations | pre_registrations | `*, branches(id, name), classes(id, name, sports(id, name))` | — | created_at, id | ✓ | `list_pre_registrations(p_offset, p_limit)` |
| 8 | Y `registration/data/source/parents/parents_data_source.dart:27` fetchParents | profiles | `*, parent_athlete_links(athletes(id, full_name)), profile_branch_links(branch_id)` | role_id = 8 | created_at, id | ✓ | `list_parents(p_offset, p_limit)` |
| 9 | Y `registration/data/source/coaches/coaches_data_source.dart:24` fetchCoaches | profiles | `*, coach_class_links(class_id, classes(id, name)), profile_branch_links(branch_id, branches(id, name)), profile_permissions!profile_permissions_profile_id_fkey(permission)` | role_id = 4 | — | — | `list_coaches()` |
| 10 | Y `registration/data/source/users/users_data_source.dart:27` fetchUsers | profiles | `*, roles(name), profile_branch_links(branch_id), profile_permissions!profile_permissions_profile_id_fkey(permission)` | role_id not in (4, 8) | — | — | `list_users()` |
| 11 | Y `registration/data/source/users/users_data_source.dart:61` fetchRoles | roles | `id, name` | id not in (uygulamanın listesi) | — | — | `list_roles(p_exclude_ids bigint[])` |
| 12 | Y `registration/data/source/permissions/permissions_data_source.dart:20` fetchRolePermissions | role_permissions | `role_id, permission, is_optional` | — | — | — | `list_role_permissions()` |
| 13 | Y `registration/data/source/branches/branch_data_source.dart:24` fetchBranches | branches | `*, profile_branch_links(profiles!inner(*, roles(name)))` | `profile_branch_links.profiles.role_id in (1, 2, 3, 9)` (gömülü süzgeç: şube düşmez, bağ düşer) | — | — | `list_branches()` |
| 14 | Y `registration/data/source/classes/classes_data_source.dart:24` fetchClasses | classes | `*, branches(id, name), sports(id, name), athletes(id, full_name), class_schedule_slots(weekday, start_time), coach_class_links(profile_id, profiles(id, full_name, status, role_id, is_deleted))` | — | — | — | `list_classes()` |
| 15 | Y `registration/data/source/sports/sports_data_source.dart:26` fetchSports | sports | `*, branch_sport_links!left(branches!left(id, name))` | — | — | — | `list_sports()` |
| 16 | Y `school/data/source/school_data_source.dart:26` fetchSchool | schools | `*` | id = X, `maybeSingle` | — | — | `get_school(p_school_id)` → nesne / null |
| 17 | Y `financial_ledger/data/source/customers/customers_data_source.dart:37` fetchCustomers | customers | `*, athletes!left(id, full_name, class_id, branch_id, classes!left(id, name))` | type in (CustomerScope `queryValue`'ları; boş liste → süzgeç yok) | display_name, id | ✓ | `list_customers(p_types customer_type[]?, p_offset, p_limit)` |
| 18 | Y `financial_ledger/data/source/financial_records/financial_records_data_source.dart:64` fetchRecords | financial_records | `*, customers!left(id, display_name, type, phone, email, athlete_id, athletes!left(id, full_name, class_id, classes!left(id, name, sport_id, sports!left(id, name)))), income_expense_items!left(id, name), branches!left(id, name), transactions!left(id, record_id, amount, method, transaction_date, created_at, is_deleted, processed_by, profiles!left(id, full_name))` | type = X | expected_date desc, id | ✓ | `list_financial_records(p_type accounting_type, p_offset, p_limit)` |
| 19 | Y `financial_ledger/data/source/income_expense_items/income_expense_items_data_source.dart:26` fetchIncomeExpenseItems | income_expense_items | `*, branch_income_expense_item_links!left(branches!left(id, name))` | — | — | — | `list_income_expense_items()` |
| 20 | Y `financial_ledger/data/source/discounts/discounts_data_source.dart:25` fetchDiscounts | discounts | `*, branch_discount_links!left(branches!left(id, name))` | — | created_at desc (+ id) | — | `list_discounts()` |
| 21 | Y `notifications/data/source/announcements_data_source.dart:24` fetchAnnouncements | notification_announcements | `id, title, body, role_ids, branch_ids, recipient_count, created_at, profiles(full_name)` (AnnouncementDto.columns) | — | created_at desc (+ id) | limit | `list_announcements(p_limit = 50)` |
| 22 | Y `notifications/data/source/notifications_data_source.dart:25` fetchInbox | notifications | `id, type, params, created_at, read_at` (NotificationDto.columns) | — | created_at desc (+ id) | limit | `list_notifications(p_limit = 50)` |
| 23 | Y `notifications/data/source/notifications_data_source.dart:38` fetchUnreadCount | notifications | `id`, `count(exact)` | read_at is null | — | — | `count_unread_notifications()` → tam sayı |
| 24 | Y `notifications/data/source/notifications_data_source.dart:58` fetchPreferences | notification_preferences | `type, push_enabled` | — | — | — | `list_notification_preferences()` |
| 25 | V `notifications/data/source/notifications_data_source.dart:26` fetchInbox | notifications | (22 ile aynı) | — | created_at desc (+ id) | limit | `list_notifications(p_limit = 50)` |
| 26 | V `notifications/data/source/notifications_data_source.dart:39` fetchUnreadCount | notifications | (23 ile aynı) | read_at is null | — | — | `count_unread_notifications()` |

"(+ id)": uygulamanın sırası eşit değerlerde tanımsızdı; fonksiyon `id` ile
bağı koparır (daha sıkı, aynı sözleşme).

## Uygulamanın çağırmadığı

| Fonksiyon | Kim | Ne için |
|---|---|---|
| `get_notification(p_id)` | S11'in Realtime gateway'i, alıcı adına (`DbContextService.withUser`) | Supabase Realtime'ın `record`'u gibi satırın bütün sütunları (`push_status`, `read_at` … — veli uygulamasının `isRevived`'ı bunları okuyor). Alıcı değilse `null`. Allow-list'te değil |

## Nasıl doğrulandı

`test/read-functions.e2e-spec.ts`: aynı veritabanına bağlı gerçek bir
PostgREST (`postgrest/postgrest:v12.2.12`, Supabase'teki ayarlarla:
authenticator rolü, `anon`, ek arama yolu `public, extensions`) kurulur. Her
satır için uygulamanın sorgusu (supabase-dart'ın ürettiği adres) PostgREST'e,
fonksiyon bizim `/rpc`'ye sorulur; iki JSON on kullanıcı için (A genel müdür,
şube müdürü, müdür yardımcısı, antrenör, muhasebeci, veli, pasif veli,
silinmiş hesap; B genel müdür, B veli) eşit olmalı. Sayfalı olanlar ayrıca
2'lik sayfalarla (`PagedQuery`'nin yaptığı) karşılaştırılır. Seed'e ek olarak
silinmiş sporcu, silinmiş bağ, okul geneli/şubeli indirim, harici cari,
silinmiş tahsilat, ön kayıtlar, duyuru, bildirimler ve tercihler eklenir.

DTO'nun okuduğu anahtarlar ayrıca sınanmadı: yanıt PostgREST'inkiyle aynı
JSON olduğundan bugün çalışan `fromJson` aynısını okur.

Kuralı bilerek bozma denemesi (2026-11-23, elle): `list_athletes` SECURITY
DEFINER yapılınca 16 test düştü (her kullanıcıda eşitlik, açık kapsam
beklentileri, katalog); `list_branches`'ta `!inner` (`join`) `left join`
yapılınca 6 test düştü.
