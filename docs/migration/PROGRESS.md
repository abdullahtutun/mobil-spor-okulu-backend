# İlerleme

`/oturum` her oturumun başında bu dosyayı okur, sonunda günceller.

Durum değerleri: `bekliyor` · `devam` · `kısmen` (yarım kaldı; kalanlar
oturum dosyasında işaretli) · `tamam`.

| Oturum | Durum | Tarih | Not |
|---|---|---|---|
| S00 | tamam | 2026-10-25 | Plan, envanter, oturum dosyaları, `/oturum` skill'i |
| S01 | tamam | 2026-11-23 | NestJS 11 iskeleti, zod config, pino, pg+Kysely, /health, Postgres 17+pg_cron imajı, dbmate, Testcontainers e2e |
| S02 | tamam | 2026-11-23 | Kapı yayında; canlı migration kullanıcı tarafından uygulandı; mağaza sürümü 1.1.2+10 kullanıcıda |
| S03 | tamam | 2026-11-23 | Şema dump'ı + compat (roller, auth, storage, pg_notify), dbmate 0001–0004, seed, canlıyla 9 parmak izi aynı |
| S04 | tamam | 2026-11-23 | DbContextService (rol+claims+timeout), JWT doğrulama, `POST /rpc/:name` + 65'lik allow-list, PostgREST hata eşlemesi, CORS/gövde/hız sınırı |
| S05 | bekliyor | | |
| S06 | bekliyor | | |
| S07 | bekliyor | | |
| S08 | bekliyor | | |
| S09 | bekliyor | | |
| S10 | bekliyor | | |
| S11 | bekliyor | | |
| S12 | bekliyor | | |
| S13 | bekliyor | | |
| S14 | bekliyor | | |
| S15 | bekliyor | | |
| S16 | bekliyor | | |
| S17 | bekliyor | | |

## Açık sorular

Kullanıcıya sorulacak ya da ilgili oturumda karara bağlanacak konular.
Cevaplanınca buradan silinip ilgili oturumun günlüğüne yazılır.

- API alan adı: `api.mobilsporokulu.com` mu, marka başına ayrı mı? (S16)
- VPS'in boyutu ve Coolify'da çalışan diğer servisler (RAM bütçesi). (S16)
- Yedeklerin gideceği ikinci yurt içi S3 uyumlu depolama. (S16)

- S02: 1.1.2+10 mağazaya ne zaman çıkacak? (kullanıcıda)
- S02: iOS App Store adresleri (`app_min_versions.store_url`) S17'den önce
  yazılmalı.

VPS'te Coolify kurulu (2026-10-26) → PLAN.md K15, S16 buna göre yazıldı.

## Günlük

En yeni en üstte. Her oturum bir bölüm ekler: ne yapıldı, plandan sapmalar,
sonraki oturumların bilmesi gerekenler.

### S04 — DB istek bağlamı ve RPC kapısı (2026-11-23)
- Yapılanlar: oturum dosyasındaki teslim notuna bakın. Orkestratörle,
  kullanıcıya sorulmadan çalıştırıldı; karar gerektiren konu çıkmadı.
- Allow-list: iki uygulamanın `.rpc(` çağrılarından çıkarıldı — yönetim 61,
  veli 10 (envanterdeki 9 + S02'nin `get_min_app_version`'ı), toplam **65**;
  INVENTORY ile fark yok. Hepsi `jsonb` döner, hiçbiri overload'lu değil.
  Yerel veritabanının ACL'leri canlıyla aynı (S03 parmak izi) olduğu için
  yetkiler yerelden okundu; canlıya bakmak gerekmedi.
- Kendi verdiğim küçük kararlar:
  - **Ayrı bağlantı adresi** `API_DATABASE_URL` (api_authenticator); API
    `DATABASE_URL`'i artık kullanmıyor (yalnızca dbmate). Yerel parola
    `npm run db:api-password`; docker compose'un api profili
    `API_DATABASE_URL_DOCKER` (varsayılanı .env.example'daki yerel parola).
  - **`callers` veritabanı yetkilerinin aynısı**: anon yalnızca
    `get_min_app_version` ve üç `public_get_*_by_token`; dördü authenticated'a
    da açık (DB'de de öyle). Allow-list DB'nin önünde ikinci kapı; test
    ikisinin ayrışmasını yakalıyor.
  - Allow-list dışı ad → 404 `PGRST202` (varlık sızmasın); rolü uymayan →
    DB'nin cevabıyla aynı (anon 401 / authenticated 403, `42501`).
  - **Token kuralları**: `role: anon` token'ı (Supabase anon anahtarı) anon
    sayılır; `service_role` ve rolsüz/başka rol token'ları 401 `PGRST303` —
    service_role yalnızca sunucu içinden. Guard global değil, uç başına
    (`/health` ve S05'in `/auth/*`'ı süresi geçmiş token'la çağrılabilsin).
  - Parametre çevirme `json_to_record` ile (PostgREST'in yöntemi): diziler,
    enum'lar, jsonb, tarihler aynı kurallarla çevrilir; SQL'e giren ad/tip
    yalnızca `pg_proc`'tan.
  - Rol başına `statement_timeout`: anon 3 sn, authenticated 8 sn
    (Supabase), service_role 60 sn; `run(..., { statementTimeoutMs })` ile
    çağrı başına değiştirilebilir.
  - Hız sınırı varsayılanı 600 istek/dk/IP (salon Wi-Fi'ı arkasında çok
    cihaz), gövde 1 MB; Coolify'da `TRUST_PROXY=1` gerekecek (S16).
  - `x-powered-by` kapatıldı (S01'in S16'ya bıraktığı not).
- Sonraki oturumlar için:
  - S05: `JwtVerifier`'ın kabul ettiği token = S05'in üreteceği token
    (HS256, `role: authenticated`, `aud: authenticated`, UUID `sub`; claim
    adları `test/support/tokens.ts` → `supabaseUserToken`). Auth uçlarına
    `RequestAuthGuard` takılırsa süresi geçmiş token 401 olur — logout /
    refresh bunu bilerek seçmeli. `JWT_SECRET` canlıdakiyle aynı verilirse
    Supabase'in açık oturumları da geçer (e2e'de sınandı) — karar S12/S17.
  - S07: yeni okuma fonksiyonları `RPC_ALLOWLIST`'e `callers: USER`,
    `apps: [...]` ile; `test/rpc-allowlist.e2e-spec.ts` endpoint.dart'ta
    `.rpc(` ile çağrılanlara bakıyor — S14/S15'te `.from()` çağrıları
    `.rpc(`'ye dönünce liste kendiliğinden tutarlı olmalı. `setof`
    dönüşler dizi olarak çıkar (test edildi).
  - S08–S11: sunucu işleri `DbContextService.withRole('service_role', …)`
    (RLS'i aşar) ya da kullanıcı adına `withUser(auth.claims, …)`; SQL
    hatası için `isPgError` + `pgErrorToApiException`.
  - S13/S14: istemci `POST <api>/rpc/<ad>` (gövde aynı, `Authorization:
    Bearer`), hata gövdesi PostgREST'inkiyle aynı alanlar.
  - S16: `TRUST_PROXY`, `CORS_ORIGINS` (üretim kökenleri), api_authenticator
    parolası, hız sınırı tek süreç varsayımı.

### S03 — Veritabanı tabanı (2026-11-23)
- Yapılanlar: oturum dosyasındaki teslim notuna bakın. `npm run db:migrate`
  boş veritabanına canlı şemanın aynısını kuruyor; `test/schema.e2e-spec.ts`
  sayıları ve dokuz parmak izini (fonksiyon gövdeleri + ACL'ler, politikalar,
  trigger'lar, tablo ACL/RLS, sütunlar, index'ler, kısıtlar, storage
  politikaları, cron) canlıdan alınmış sabitlerle karşılaştırıyor — hepsi
  aynı. Tek bilinçli fark: `request_push_dispatch()` (pg_net + Vault →
  `pg_notify('push_dispatch', '')`).
- Kullanıcı eylemi gerekmedi: `supabase db dump --project-ref <ref>`
  parolasız çalıştı (CLI geçici giriş rolü + IPv4 pooler). Dump'a girmeyenler
  Supabase MCP ile salt okunur sorgularla alındı. Canlıya yazılmadı.
- S02 migration'ı (`20261027_app_min_versions.sql`) oturum sırasında
  kullanıcı tarafından canlıya uygulandı (orkestratör doğruladı). Önce
  `0005_app_min_versions.sql` olarak taşınmıştı; canlıda olduğu için dump
  yeniden alındı ve baseline'a girdi, 0005 silindi, 8 satırı
  `0004_reference_data.sql`'e eklendi. S02 satırı `tamam` yapıldı.
- Docker Compose sorunu (S01 açık sorusu) kullanıcı tarafından çözüldü
  (Homebrew docker-compose/buildx, `cliPluginsExtraDirs`, `credsStore`
  yok); açık sorulardan silindi, AGENTS.md'deki geçici çözüm notu kısaltıldı.
- Kendi verdiğim küçük kararlar:
  - **Collation**: canlı veritabanı ICU `en-US`; imajımız libc
    `en_US.utf8` ile kuruluyordu ve sıralama farklıydı (`_`, büyük/küçük
    harf). `docker/postgres/Dockerfile`'a `POSTGRES_INITDB_ARGS` (ICU en-US)
    ve `timezone = 'UTC'` eklendi. Var olan yerel volume'lar eski
    collation'ı korur → `docker compose down -v`.
  - **Başvuru verisi migration'ı (0004)**: `roles`, `role_permissions`,
    `app_min_versions` kişisel veri değil ama şemanın çalışması için şart;
    dump veri taşımadığı için canlıdan elle alındı.
  - **auth tabloları canlıdaki sütunlarla bire bir** (oturum dosyası alt
    küme diyordu): S12 tablo tablo kopyalayabilsin. `mfa_factors` ve
    `one_time_tokens` da var (`delete_own_account` bunlardan siliyor).
  - **storage tabloları canlının alt kümesi** (sürümleme/yaşam döngüsü
    sütunları yok); politikalar, yetkiler ve fonksiyonlar bire bir.
  - **9 cron işi**: canlıda migration'larda olmayan `expire_trials_job`
    (panelden açılmış) da var; alındı. INVENTORY'deki `0 17 * * *`
    zamanlaması canlıda yok.
  - **pg_stat_statements kurulmadı** (şema kullanmıyor, shared_preload ister).
  - Baseline **üretilmiş dosya** (`scripts/build-baseline.mjs`); compat
    kaynakları okunur dosyalar olarak `db/compat/`'ta.
  - Yönetim migration'ı taşıma aracı: `scripts/import-migration.mjs`
    (üst düzey begin/commit'i atar, `_rollback/` dosyasını `down`'a koyar).
  - `api_authenticator` parolasız oluşturuldu (sır repoya girmez).
  - Supabase CLI backend reposunda `supabase/.temp/` bırakıyor → gitignore.
- Sonraki oturumlar için:
  - S04: `api_authenticator`'a parola ver (env), DbContextService testte
    `asRole()` yardımcısının yaptığını yapar; seed: `startTestDatabase({
    seed: true })`, kimlikler `test/fixtures/seed-ids.ts` (şifre `Test1234!`).
  - S05: `auth.*` tabloları GoTrue'nunkiyle aynı; e-posta tekilliği
    `users_email_partial_key` (SSO dışı). `auth.users` insert'i
    `handle_new_user` trigger'ını tetikler (yalnızca `is_creator`).
  - S11: kanal `push_dispatch`, yük boş. Realtime yayını yok.
  - S12: yukarıdaki notlar S12 dosyasına eklendi (üretilen sütunlar,
    başvuru tabloları kopyalanmaz, audit_log_entries).
  - Yönetim reposuna yeni migration gelirse: AGENTS.md → "Schema sync".

### S02 — Zorunlu güncelleme kapısı (2026-11-23)
- Yapılanlar: oturum dosyasındaki teslim notuna bakın. Kod Y ve V `main`
  dallarında; migration `../mobil_spor_okulu/supabase/migrations/20261027_app_min_versions.sql`.
- **Kapıyı taşıyan sürümler (S17 bunu kullanır):** yönetim ve veli
  **1.1.2+10** (build 10), iki marka, Android + iOS — mağazaya çıktığında.
  Build ≤ 9 kapı taşımaz; onlar `min_build` ile durdurulamaz. Geçiş gecesi:
  `update public.app_min_versions set min_build = <yeni backend'e bağlı ilk
  build> where …;` (Supabase'te). Yükseltmeden önce iOS satırlarına
  `store_url` yazılmalı, yoksa iOS'ta "Güncelle" düğmesi çıkmaz.
- Kendi verdiğim küçük kararlar:
  - Anahtara **`brand`** eklendi (oturum dosyası `(app, platform)` diyordu):
    iki marka mağazaya ayrı zamanlarda çıkıyor; tek değer, son sürümü daha
    eski markanın güncel kullanıcılarını da kilitlerdi. RPC üç parametreli:
    `get_min_app_version(p_app, p_platform, p_brand)`; brand = derlemenin
    markası (`AppConfig.brand.key`).
  - RPC **SECURITY INVOKER** + tabloya `anon`/`authenticated` select
    politikası: 20261016 ve 20261017'nin denetim blokları `anon`'a açık
    SECURITY DEFINER fonksiyonu reddediyor (yeniden çalıştırınca patlardı).
  - Açılışa ek olarak **öne gelişte** (30 dk aralıkla) de soruluyor:
    arka planda açık kalan eski uygulama da geçişte durdurulsun.
  - Zaman aşımı 3 sn (çevrimdışı salon açılışı uzamasın); her hata açar.
  - `AppStatus.updateRequired` yapışkan: `setStatus` ondan çıkmaz.
  - Sürüm 1.1.2+10 (memory kuralı: patch ve build +1, iki uygulama birlikte).
  - Y'ye `url_launcher` eklendi; iki manifest'e `https` VIEW `<queries>`.
- Sonraki oturumlar için:
  - S03: şema dump'ında `app_min_versions` ve `get_min_app_version` gelir
    (canlıya uygulandıysa). Yeni backend'de de `anon` çağırabilmeli
    (K6 allow-list'ine `get_min_app_version` herkese açık olarak).
  - S13/S14: istemci `RpcEnvelope` ile okuyor; yeni backend aynı zarfı
    dönerse değişiklik gerekmez.
  - S17: yukarıdaki SQL; geçişten önce Supabase'teki `min_build` ile yeni
    backend'deki aynı tablonun değeri ayrı ayrı düşünülmeli (yeni backend'e
    bağlı build'ler yeni backend'den soracak).

### S01 — Temel iskelet (2026-11-23)
- Yapılanlar: oturum dosyasındaki teslim notuna bakın. Canlı Supabase
  Postgres **17.6** → K4 = 17 (PLAN.md güncellendi). Canlıda kurulu
  eklentiler: pg_cron 1.6.4, pg_net, pg_stat_statements, pgcrypto,
  supabase_vault, uuid-ossp; imajımızda pg_cron (1.6) + contrib var, pg_net
  ve vault yok (K10).
- Kendi verdiğim küçük kararlar:
  - **Kysely 0.28.x** sabitlendi: 0.29 yalnızca ESM, Jest (CJS + ts-jest)
    yükleyemiyor. Uygulama 0.29 ile de çalışıyordu.
  - NestJS **11** (npm'de 12 var; K1 11 diyor). TypeScript **5.9** (7.x
    ts-jest/typescript-eslint ile uyumsuz). ESLint 9.
  - dbmate **npm paketi** (Docker imajı değil); `--no-dump-schema`, yerelde
    `pg_dump` gerekmez. `0000_init.sql` no-op (boş klasörde `up` hata verir).
    `db:new` zaman damgalı ad üretir, `0001_baseline.sql`'den sonra sıralanır.
  - Veritabanı adı `postgres` (Supabase gibi), `cron.database_name` da o.
  - `@nestjs/config` yerine kendi `ConfigModule`'ümüz (`APP_CONFIG` token'ı,
    zod); `.env`'i `main.ts` `process.loadEnvFile` ile okur, testler ortamı
    kendi kurar.
  - `npm run lint` artık yalnızca denetler (`--fix` yok); `lint:fix` ayrı.
  - `no-explicit-any`, `no-floating-promises`, `no-unsafe-argument` hata
    seviyesinde.
- Sonraki oturumlar için:
  - Yeni env anahtarı → `src/config/env.schema.ts` + `.env.example` birlikte.
  - Hata gövdesi `ApiException.of(status, code, message, {details, hint})`;
    SQL hatası eşlemesi S04'te `toApiError`'a eklenecek.
  - Kysely'nin `destroy()`'u havuzu yalnızca Kysely bir sorgu çalıştırdıysa
    kapatır; `DbModule` havuzu ayrıca kapatıyor — S04 bunu bozmasın (e2e
    testi "uygulama kapanınca veritabanı havuzu kapanır" yakalar).
  - Postgres imajı Coolify'da da bu Dockerfile'dan (S16). API imajına
    dbmate girmiyor (dev bağımlılığı); üretimde migration'ın nasıl
    çalışacağı S16'nın kararı.
  - Express `x-powered-by` başlığı açık → S16 sertleştirme.
  - e2e testleri: `npm run test:e2e` yeterli; colima ayarlarını
    `test/support/docker-env.ts` kendisi yapar (AGENTS.md → "Docker on this Mac").

### Karar — PocketBase karşılaştırması (2026-11-22)
- Soru: public flavor PocketBase'e, Dev Adım Supabase'te mi kalsın? Karar:
  **hayır, iki marka birlikte NestJS'e** (PLAN.md K16).
- RAM ölçümü (colima, arm64; 1,5 M yoklama satırı; aynı uç nokta: sporcunun
  yoklama sayıları, PocketBase'te JS hook, NestJS'te transaction +
  `set_config('request.jwt.claims')`; cgroup `anon+file−inactive_file`):

  | Senaryo | PocketBase 0.40.6 | Postgres 17 + NestJS 11 |
  |---|---|---|
  | Boşta | 72 MB | 17 + 32 = 49 MB |
  | ~40 istek/sn | 137 MB | 58 + 66 = 124 MB |
  | 20 eşzamanlı (~5000 istek/sn) | 710–910 MB, yük bitince geri vermedi | 158 + 99 = 257 MB |
  | Aynısı, `shared_buffers=32MB`, `max_connections=25`, `work_mem=2MB` | — | 55 + 101 = 156 MB (~3700 istek/sn) |

  `GOMEMLIMIT` ve küçük `--hooksPool` PocketBase'in büyümesini durdurmadı.
  Ölçülen NestJS tek uç noktalıydı; gerçek API (auth, mail, firebase-admin,
  ws) boşta muhtemelen 80–150 MB olur. S16 RAM bütçesinde bu sayılar ve
  küçük Postgres ayarları kullanılabilir.

### S00 — Hazırlık (2026-10-25)
- Repo açıldı; `AGENTS.md`, `docs/migration/{PLAN,INVENTORY,PROGRESS}.md`,
  17 oturum dosyası ve `.claude/skills/oturum/` yazıldı.
- Envanter iki uygulamanın `lib/` ve yönetim uygulamasının `supabase/`
  klasörlerinden çıkarıldı (`INVENTORY.md`). Canlı veritabanına bakılmadı;
  S03 dump'ı alınca eksikleri tamamlar.
- Henüz kod yok; `AGENTS.md` → "Commands" bölümündeki komutları S01 kurar.
