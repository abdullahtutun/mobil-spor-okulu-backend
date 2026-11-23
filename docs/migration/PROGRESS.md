# İlerleme

`/oturum` her oturumun başında bu dosyayı okur, sonunda günceller.

Durum değerleri: `bekliyor` · `devam` · `kısmen` (yarım kaldı; kalanlar
oturum dosyasında işaretli) · `tamam`.

| Oturum | Durum | Tarih | Not |
|---|---|---|---|
| S00 | tamam | 2026-10-25 | Plan, envanter, oturum dosyaları, `/oturum` skill'i |
| S01 | tamam | 2026-11-23 | NestJS 11 iskeleti, zod config, pino, pg+Kysely, /health, Postgres 17+pg_cron imajı, dbmate, Testcontainers e2e |
| S02 | bekliyor | | |
| S03 | bekliyor | | |
| S04 | bekliyor | | |
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
- Bu Mac'te `docker compose` için kalıcı düzeltme (kullanıcı eylemi, S01'den):
  `brew install docker-compose docker-buildx`, `~/.docker/config.json`'a
  `cliPluginsExtraDirs`, `credsStore: desktop` satırını silmek. Ayrıntı:
  AGENTS.md → "Docker on this Mac".

VPS'te Coolify kurulu (2026-10-26) → PLAN.md K15, S16 buna göre yazıldı.

## Günlük

En yeni en üstte. Her oturum bir bölüm ekler: ne yapıldı, plandan sapmalar,
sonraki oturumların bilmesi gerekenler.

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
