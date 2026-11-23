# Supabase bağımlılık envanteri

25 Ekim 2026'da, iki uygulamanın `lib/` klasörleri ve yönetim uygulamasının
`supabase/` klasörü taranarak çıkarıldı. Bir oturum kendi alanında eksik
bir şey bulursa buraya ekler.

Kısaltmalar: **Y** = yönetim uygulaması (`../mobil_spor_okulu`),
**V** = veli uygulaması (`../mobil_spor_okulu_veli`), **S** = tanıtım sitesi
(`../mobil_spor_okulu_site`).

## 1. Sunucu adresi

| Yer | Değer |
|---|---|
| Y `lib/core/data/remote/endpoint.dart` | `baseURL = 'https://gcmeltwnryjscinptecb.supabase.co'` |
| V `lib/core/data/remote/endpoint.dart` | aynı |
| S `src/config/site.ts:67` | `…supabase.co/functions/v1/site-lead` |

## 2. RPC'ler (uygulamalardan çağrılan)

Ad sabitleri `lib/core/data/remote/endpoint.dart` dosyalarında.

**V (9):** `get_session_data`, `acknowledge_privacy_notice`,
`parent_get_athletes`, `parent_get_attendance`, `parent_get_payments`,
`parent_set_consents`, `register_push_token`, `unregister_push_token`,
`mark_notifications_read`.

**Y (~65):**
- Okul: `create_school`, `update_school`, `delete_school`, `get_setup_progress`
- Oturum/yasal: `get_session_data`, `acknowledge_privacy_notice`
- Şube/sınıf/branş: `create_branch`, `update_branch`, `delete_branch`,
  `create_class`, `update_class`, `delete_class`, `create_sport`,
  `update_sport`, `delete_sport`
- Sporcu: `create_athlete`, `update_athlete`, `delete_athlete`,
  `bulk_delete_athletes`, `set_athlete_photo`, `get_athlete_profile_summary`
- Personel/veli: `delete_coach`, `delete_parent`, `delete_user`
- Ön kayıt: `create_pre_registration`, `update_pre_registration`,
  `delete_pre_registration`, `bulk_delete_pre_registrations`,
  `get_pre_registration_link`
- Ön kayıt (oturumsuz, `anon`): `public_get_school_branding_by_token`,
  `public_get_branches_by_token`, `public_get_classes_by_token`
- Muhasebe: `create_discount`, `update_discount`, `delete_discount`,
  `create_income_expense_item`, `update_income_expense_item`,
  `delete_income_expense_item`, `process_financial_operation`,
  `process_bulk_dues`, `update_financial_record`, `delete_financial_record`,
  `create_transaction`, `create_customer`, `update_customer`, `delete_customer`
- Yoklama: `get_daily_attendance`, `get_coach_sole_classes`,
  `submit_attendances`, `delete_class_attendance`, `get_attendance_analytics`
- Ana ekran: `get_dashboard_overview`
- Bildirim: `register_push_token`, `unregister_push_token`,
  `mark_notifications_read`, `set_notification_preference`,
  `send_announcement`, `get_direct_message_targets`, `send_direct_message`,
  `get_sent_direct_messages`

Kesin liste S04'te `endpoint.dart` dosyalarından ve `.rpc(` çağrılarından
yeniden çıkarıldı (`src/rpc/rpc-allowlist.ts`, 2026-11-23): Y 61, V 10 —
yukarıdakilere ek olarak iki uygulamada da S02'nin `get_min_app_version`'ı
(anon). `test/rpc-allowlist.e2e-spec.ts` farkı yakalar. Edge Function'ların
`service_role` ile çağırdığı RPC'ler (ör. `convert_pre_registration`,
`create_public_pre_registration_by_token`, `delete_own_account`,
`claim_push_batch`, `complete_push_batch`) allow-list'e **girmez**; yalnızca
ilgili Nest servisleri çağırır.

## 3. Doğrudan tablo okumaları (`.from(table)`) → S07

**Y:** `athletes` (5), `profiles` (3), `attendances` (2), `notifications` (2),
`schools`, `branches`, `classes`, `sports`, `roles`, `role_permissions`,
`customers`, `discounts`, `financial_records`, `income_expense_items`,
`notification_announcements`, `notification_preferences`, `pre_registrations`
(birer). Bazıları PostgREST embed'i kullanıyor
(`profilePermissionsEmbed`, `attendancesCoachFk`), sayfalama
`lib/core/data/remote/paged_query.dart` ile.

**V:** yalnızca `notifications` (gelen kutusu).

## 4. Edge Function'lar → Nest modülleri

| Fonksiyon | Satır | Kim çağırır | Hedef oturum |
|---|---|---|---|
| `create-user` | 110 | Y (kullanıcı/eğitmen formu) | S09 |
| `update-user` | 109 | Y | S09 |
| `create-parent` | 193 | Y | S09 |
| `update-parent` | 280 | Y | S09 |
| `delete-account` | 134 | Y, V | S09 |
| `submit-pre-registration` | 174 | Y web (`/online-onkayit`), `anon` | S10 |
| `convert-pre-registration` | 102 | Y | S10 |
| `bulk-convert-pre-registrations` | 102 | Y | S10 |
| `site-lead` | 182 | S | S10 |
| `send-email` | 146 | GoTrue Send Email Hook | S06 |
| `send-push` | 449 | pg_net (`push_dispatch_url`) + cron | S11 |

Ortak kod: `functions/_shared/brand.ts`, `pre_registration_conversion.ts`.
Ortam değişkenleri: `FCM_SERVICE_ACCOUNT`, `PUSH_DISPATCH_SECRET`,
`IP_HASH_SALT`, `SEND_EMAIL_HOOK_SECRET`, `SMTP_HOST`, `SMTP_PORT`,
`SMTP_USER_DEV_ADIM`, `SMTP_PASS_DEV_ADIM`, `SMTP_USER_PUBLIC`,
`SMTP_PASS_PUBLIC`, Turnstile secret, `SUPABASE_*`.

## 5. Auth akışları (`supabase_flutter`)

| Akış | Y | V | Not |
|---|---|---|---|
| `signInWithPassword` | ✓ | ✓ | |
| `signOut` (global + `SignOutScope.local`) | ✓ | ✓ | Push token önce silinir |
| `refreshSession`, `onAuthStateChange`, `currentSession` | ✓ | ✓ | `SessionRetryClient`, `SessionGate` |
| `resetPasswordForEmail` + `verifyOTP(recovery)` + `updateUser(password)` | ✓ | ✓ | 6 haneli kod, `AuthFlowType.implicit` |
| `signUp` + `verifyOTP(signup)` + `resend(signup)` | ✓ | | Okulun kendi kaydı (sihirbaz) |
| `verifyOTP(tokenHash, invite)` | ✓ web | | `/sifre-olusturma/` (`main_set_password.dart`) |
| Davet e-postası (`inviteUserByEmail`) | Edge | | create-user/create-parent/convert |

E-posta şablonları: Y `supabase/templates/` (`recovery`, `invite`,
`confirmation`, `subjects.json`); marka `user_metadata.brand`'den.

## 6. SQL'in Supabase'e özgü bağımlılıkları (migration'larda)

| Referans | Adet | Karşılığı |
|---|---|---|
| `auth.uid()` | 127 | uyumluluk katmanı (S03) |
| `auth.users` (`raw_user_meta_data`, `raw_app_meta_data`, `encrypted_password`, `banned_until`, `confirmation_token`, `recovery_token`) | 11 | kendi `auth.users` tablomuz, aynı sütun adları |
| `auth.sessions`, `auth.refresh_tokens`, `auth.identities` | 1'er | `20261023_account_deletion.sql`; kendi tablolarımız ya da fonksiyonun güncellenmesi |
| `storage.objects`, `storage.buckets`, `storage.foldername()` | 28 / 2 / 12 | minimal `storage` şeması (S03), politikalar aynen |
| `vault.decrypted_secrets` | 2 | kaldırılır |
| `net.http_post` (pg_net) | 2 | `pg_notify('push_dispatch')` |
| `supabase_realtime` publication | 2 | kaldırılır; `notifications` trigger'ı `pg_notify` |
| `cron.schedule` | 11 (8 iş) | pg_cron kalır |

### pg_cron işleri
`notifications_attendance_reminder` (`*/15 * * * *` ve `0 17 * * *`),
`notifications_morning` (`0 6 * * *`), `notifications_push_sweep`
(`*/5 * * * *`), `notifications_birthday_upcoming` (`0 6 * * *`),
`notifications_parent_payments` (`0 6 * * *`),
`athletes_sensitive_data_purge` (`35 0 * * *`),
`pre_registrations_retention_purge` (`30 0 * * *`),
`site_leads_retention_purge` (`45 0 * * *`).

## 7. Storage

| Bucket | Tür | Kullanan |
|---|---|---|
| `athlete-photos` | private (12 politika, `can_read_athlete_photo`) | Y yükler/okur, V okur ve rıza geri alınınca siler; `_thumb` 128px + 512px |
| `school-logos` | public (6 politika) | Y yükler, herkes okur |

## 8. Realtime

`notifications` tablosu, kanal `notifications:<userId>`; V INSERT ve UPDATE
(`isRevived`), Y INSERT dinliyor. Yeniden bağlanınca ve uygulama öne
gelince gelen kutusu yeniden okunuyor.
