# S03 — Veritabanı tabanı ve uyumluluk katmanı

**Repo:** backend (yönetim reposu okunur) · **Bağımlı:** S01

## Amaç
Boş bir Postgres'e tek komutla (`npm run db:migrate`) canlı Supabase'teki
şemanın aynısını kurmak: tablolar, SQL fonksiyonları, trigger'lar, RLS
politikaları, grant'ler ve cron işleri. Supabase'e özgü parçaların yerine
kendi uyumluluk katmanımız.

## Okunacaklar
- `docs/migration/INVENTORY.md` → 6 (SQL bağımlılıkları), 7 (storage)
- `../mobil_spor_okulu/supabase/migrations/` — özellikle
  `20260927_notifications.sql` (pg_net/Vault/publication, push dispatch),
  `20261023_account_deletion.sql` (auth tabloları), `20261001_athlete_photos.sql`
  ve storage politikası olan diğerleri
- `../mobil_spor_okulu/supabase/seed/` (test verisi için)
- Memory: canlı DB kontrolü (`supabase db query --linked`)

## Yapılacaklar
- [ ] Salt okunur şema dump'ı: `supabase db dump --linked -f dumps/schema.sql`
      (`dumps/` gitignore'da). Dump'a **girmeyenleri** ayrıca çıkar:
      `storage.objects` politikaları, `auth.users` üzerindeki trigger'lar,
      `cron.job` satırları, `storage.buckets` satırları
      (`file_size_limit`, `allowed_mime_types`, `public`).
- [ ] `db/compat/` (okunur, yorumlu kaynaklar):
  - `00_roles.sql` — `anon`, `authenticated`, `service_role` (`bypassrls`),
    giriş yapabilen `api_authenticator` (`noinherit`, üç role üye).
  - `01_extensions.sql` — dump'ın istediği eklentiler (pgcrypto, uuid-ossp,
    pg_cron …).
  - `02_auth.sql` — `auth` şeması: `users` (SQL'in kullandığı sütunlar +
    S05'in ihtiyacı: `id`, `email`, `encrypted_password`, `email_confirmed_at`,
    `raw_user_meta_data`, `raw_app_meta_data`, `banned_until`,
    `confirmation_token`, `recovery_token`, `last_sign_in_at`, `created_at`,
    `updated_at`, `deleted_at`), `sessions`, `refresh_tokens`, `identities`
    (sütunlar S05'te kesinleşir, account_deletion'ın sildiği sütunlar
    şimdiden olmalı); `auth.uid()`, `auth.jwt()`, `auth.role()`,
    `auth.email()` Supabase'deki tanımlarıyla aynı (`request.jwt.claims`).
  - `03_storage.sql` — `storage.buckets`, `storage.objects` (RLS açık),
    `storage.foldername()`, `filename()`, `extension()`; iki bucket satırı.
  - `04_supabase_removed.sql` — pg_net/Vault yerine push dispatch'in
    `pg_notify('push_dispatch', …)` sürümü; `supabase_realtime` yayını yok.
- [ ] `db/migrations/0001_baseline.sql`: compat + temizlenmiş dump
      (`supabase_admin` sahiplikleri/grant'leri, `extensions`/`graphql`/
      `realtime` gibi bizde olmayan şemalara referanslar ayıklanır). Ne
      ayıklandıysa dosya başındaki yorumda listelenir.
- [ ] `0002_storage_policies.sql`, `0003_cron_jobs.sql` (8 iş, INVENTORY 6).
- [ ] `test/fixtures/seed.sql`: iki okul (iki marka), her rolden personel,
      iki veli (biri pasif), çocuklar, yoklama ve ödeme kayıtları. Kişisel
      veri değil, uydurma veri.
- [ ] Integration testi: boş DB'ye migrate up; ardından canlıdan salt
      okunur alınan sayılarla karşılaştırma (public şemadaki tablo, fonksiyon,
      politika, trigger sayıları — beklenen sayılar test içinde sabit,
      nasıl alındıkları yorumda).
- [ ] Yönetim reposundaki migration'ların bundan sonra nasıl
      senkronlanacağını `AGENTS.md`'ye yaz (geçişe kadar şema değişiklikleri
      Supabase'te de yapılmaya devam eder: yeni bir yönetim migration'ı bu
      repoya `00NN_<ad>.sql` olarak kopyalanır).

## Kapsam dışı
Veri taşıma (S12). API kodu (S04).

## Kabul kriterleri
- `docker compose down -v && docker compose up -d db && npm run db:migrate`
  hatasız.
- Sayı karşılaştırma testi geçiyor; farklar varsa her biri gerekçesiyle
  günlükte.
- `select auth.uid()` doğru claim verilince doğru uuid'yi dönüyor (test).

## Teslim notu
_(oturum sonunda doldurulur)_
