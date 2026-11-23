# Supabase → NestJS + PostgreSQL geçiş planı

## Hedef

Yönetim uygulaması, veli uygulaması ve tanıtım sitesinin bugün Supabase'ten
aldığı her şeyi (veritabanı, auth, RPC, tablo okumaları, storage, realtime,
Edge Function'lar, e-posta, push) Türkiye'deki VPS'te çalışan bu backend'e
taşımak. Bunu yaparken:

- **kullanıcı fark etmez:** aynı hesaplar, aynı şifreler, aynı veriler;
- **iş mantığı yeniden yazılmaz:** SQL fonksiyonları, RLS ve cron aynen kalır;
- **uygulamalarda yalnızca `data/source` katmanı değişir:** DTO'lar,
  `RpcEnvelope`, repository'ler ve üstü olduğu gibi kalır.

## Mimari

```
Flutter (Y, V, web)  ─┐   Coolify      ┌─ PostgreSQL (+ pg_cron)
Astro site (S)       ─┼─► proxy  ─► NestJS ┤    şema + SQL fonksiyonları + RLS
                      │   (TLS)    ├ /auth/*        auth.users, oturumlar
                      │            ├ /rpc/:name     set local role + jwt claims
                      │            ├ /storage/*     disk + storage.objects
                      │            ├ /realtime (WS) LISTEN/NOTIFY
                      │            └ /functions/*   eski Edge Function'lar
                      │                 ├─ SMTP (marka başına)
                      │                 └─ FCM (push)
```

## Kararlar

Gerekçeleriyle birlikte. Bir oturum bunlardan birini değiştirirse burayı ve
`AGENTS.md`'yi günceller, `PROGRESS.md`'ye yazar.

| # | Karar | Gerekçe |
|---|---|---|
| K1 | NestJS 11 + TypeScript, Node 24, npm | Edge Function'lar zaten TS; resmi `firebase-admin`; katmanlı DI yapısı uygulamalara benzer |
| K2 | Kysely (query builder) + `pg`; ORM yok | Şema SQL öncelikli; ORM şemayı yönetmeye kalkar |
| K3 | Migration: dbmate, düz SQL | Mevcut migration'lar düz SQL; araç bağımsız |
| K4 | Postgres major sürümü Supabase projesiyle aynı: **17** (canlı: 17.6, 2026-11-23); imaj `postgres:17-bookworm` + `pg_cron` (`docker/postgres/Dockerfile`). Supabase'te kurulu eklentilerden pgcrypto, uuid-ossp contrib olarak imajda var; pg_net ve supabase_vault bilerek yok (K10) | Dump'ın sorunsuz yüklenmesi |
| K5 | RLS korunur: istek başına `set local role` + `request.jwt.claims` | 127 `auth.uid()` ve tüm politikalar değişmeden çalışır |
| K6 | `POST /rpc/:name` + allow-list, PostgREST ile aynı parametre adları ve JSON | Uygulamalarda DTO/mapper değişmez |
| K7 | `.from()` okumaları `SECURITY INVOKER` SQL fonksiyonlarına çevrilir | PostgREST klonu yazmamak; tek kapı RPC |
| K8 | Auth bizim, Supabase uyumlu: `auth.users` aynı id/hash, JWT HS256 aynı claim adlarıyla, dönen refresh token | Kimse şifre sıfırlamaz; SQL'deki `auth.*` kullanımı çalışır |
| K9 | Storage: dosya diskte, metadata `storage.objects`'te, politikalar aynen | 18 bucket politikası yeniden yazılmaz |
| K10 | pg_net ve Vault yok; `pg_notify` + API'de `LISTEN` | Dışa HTTP çağıran veritabanı yok, sır DB'de değil |
| K11 | Realtime: `ws` tabanlı Nest gateway, kanal başına kullanıcı | Supabase Realtime'ın bizdeki tek kullanımı gelen kutusu |
| K12 | Testler Testcontainers ile gerçek Postgres'e karşı | RLS ve SQL fonksiyonları mock'lanamaz |
| K13 | API adresi varsayılan `https://api.mobilsporokulu.com` (S16'da kesinleşir) | Tek API, iki marka; marka verinin içinde |
| K14 | Eski uygulama sürümleri için zorunlu güncelleme kapısı **geçişten önce** yayınlanır (S02) | Mağazadaki eski sürümler Supabase'e yazmaya devam etmesin |
| K15 | Üretimde dağıtım Coolify ile (VPS'te kurulu): proxy/TLS, git'ten Dockerfile build, DB yedeği Coolify'da; S01'in `Dockerfile`'ı ve Postgres imajı Coolify'a uygun olmalı | Sunucuda zaten var; elle compose/Caddy yönetimi gerekmez |
| K16 | İki marka (Dev Adım ve public) **birlikte** bu backend'e taşınır; flavor başına ayrı backend yok. PocketBase değerlendirildi ve reddedildi (2026-11-22) | İki backend her özelliği ve her güvenlik düzeltmesini iki kez yazdırır; PocketBase'te SQL fonksiyonu/RLS/trigger/pg_cron yok, 282 fonksiyon hook'a yeniden yazılırdı. RAM gerekçesi ölçümle çürüdü: bkz. `PROGRESS.md` → "PocketBase karşılaştırması" |

## Oturumlar

Her oturum yeni bir Claude Code oturumunda `/oturum Sxx` ile çalıştırılır
(argümansız `/oturum` sıradaki uygun oturumu seçer). Durumlar
`PROGRESS.md`'de tutulur.

| Oturum | Konu | Bağımlı | Çalışılan repo |
|---|---|---|---|
| [S01](sessions/S01-temel-iskelet.md) | NestJS iskeleti, config, Docker Postgres, test altyapısı | — | backend |
| [S02](sessions/S02-zorunlu-guncelleme.md) | Zorunlu güncelleme kapısı (mevcut Supabase üzerinde) | — | Y, V |
| [S03](sessions/S03-veritabani-tabani.md) | Şema dump'ı, uyumluluk katmanı, dbmate | S01 | backend |
| [S04](sessions/S04-istek-baglami-rpc.md) | DB istek bağlamı + RPC kapısı | S03 | backend |
| [S05](sessions/S05-auth-cekirdek.md) | Auth çekirdeği: giriş, JWT, refresh, çıkış | S04 | backend |
| [S06](sessions/S06-auth-akislari-eposta.md) | Şifre sıfırlama, kayıt, davet, e-posta | S05 | backend |
| [S07](sessions/S07-okuma-uclari.md) | `.from()` okumalarının SQL fonksiyonlarına çevrilmesi | S04 | backend (Y, V yalnızca okunur) |
| [S08](sessions/S08-dosya-depolama.md) | Storage: fotoğraflar ve logolar | S04, S05 | backend |
| [S09](sessions/S09-hesap-islemleri.md) | create/update-user, create/update-parent, delete-account | S06 | backend |
| [S10](sessions/S10-on-kayit-site-lead.md) | Online ön kayıt, aktarım, site lead | S06 | backend |
| [S11](sessions/S11-bildirim-realtime-push.md) | Realtime gateway, push worker, cron | S05 | backend |
| [S12](sessions/S12-veri-tasima.md) | Veri, kullanıcı ve dosya taşıma araçları + prova | S03–S11 | backend |
| [S13](sessions/S13-veli-uygulamasi.md) | Veli uygulamasının yeni backend'e geçişi | S05–S08, S11 | V |
| [S14](sessions/S14-yonetim-cekirdek.md) | Yönetim uygulaması: istemci, auth, RPC | S05, S06 | Y |
| [S15](sessions/S15-yonetim-kalan.md) | Yönetim uygulaması: okumalar, storage, fonksiyonlar, realtime, web, site | S07–S11, S14 | Y, S |
| [S16](sessions/S16-uretim-dagitimi.md) | VPS, Caddy, yedekleme, izleme, sertleştirme | S01 | backend |
| [S17](sessions/S17-gecis.md) | Geçiş provası ve canlıya geçiş | hepsi | hepsi |

Önerilen sıra: **S01 → S02 → S03 → S04 → S05 → S06 → S07 → S08 → S09 → S10 →
S11 → S12 → S13 → S14 → S15 → S16 → S17.** S02 erken yapılmalı, çünkü
kullanıcıların güncellemesi zaman alır. S16, S01'den sonra herhangi bir
zaman yapılabilir.

## Ortam ve çalıştırma

Oturumlar bu repodan başlatılır, kardeş repolar ek dizin olarak verilir:

```bash
cd ~/FlutterProjects/mobil_spor_okulu_backend
claude --add-dir ../mobil_spor_okulu --add-dir ../mobil_spor_okulu_veli --add-dir ../mobil_spor_okulu_site
```

## Değişmez kurallar

- Canlı Supabase'e **yazılmaz** (migration, `execute_sql` ile DML, storage
  silme yok). Okuma ve dump serbest. Tek istisna S02'nin ürün migration'ı
  ve S17'deki geçiş adımları; ikisi de kullanıcının onayıyla.
- Uygulama ve site repolarındaki geçiş işi `migrate/own-backend` dalında
  yapılır ve S17'de `main`'e alınır; `main` geçişe kadar Supabase'le
  yayında kalır (S02 `main`'de yapılır). Geçiş süresince `main`'e gelen
  değişiklikler dala alınır.
- Geçiş sürerken yönetim reposuna eklenen her yeni Supabase migration'ı bu
  repoya da taşınır (S03 → `AGENTS.md`'deki yöntem).
- Uygulama repolarında bir değişiklik o reponun `AGENTS.md`'sine uyar ve
  `flutter analyze` + `flutter test` ile biter.
- Kişisel veri içeren dump ve export dosyaları repoya girmez (`.gitignore`:
  `/dumps/`, `/exports/`).
