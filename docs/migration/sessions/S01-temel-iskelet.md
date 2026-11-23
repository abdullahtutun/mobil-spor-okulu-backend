# S01 — Temel iskelet

**Repo:** backend · **Bağımlı:** —

## Amaç
Sonraki her oturumun üzerine kuracağı çalışan, test edilebilir bir NestJS
projesi ve yerelde ayağa kalkan Postgres. İş mantığı yok.

## Okunacaklar
- `AGENTS.md` (Layout, Conventions, Commands)
- `docs/migration/PLAN.md` → K1–K4, K12

## Yapılacaklar
- [x] Supabase projesinin Postgres sürümünü öğren (salt okunur):
      `cd ../mobil_spor_okulu && supabase db query --linked "select version()"`.
      Major sürümü `PLAN.md` K4'e yaz.
- [x] NestJS 11 projesi (npm, `strict`) bu repoda; `src/` `AGENTS.md`'deki
      yerleşime göre boş modül klasörleriyle. Varsayılan `AppController`
      örneğini sil.
- [x] `src/config/`: zod ile env şeması (`NODE_ENV`, `PORT`, `DATABASE_URL`,
      `JWT_SECRET`, `LOG_LEVEL`; sonraki oturumlar kendi anahtarlarını ekler),
      eksik/yanlış env'de açılışta net hata. `.env.example`.
- [x] `nestjs-pino` ile loglama; `authorization`, `cookie`, `password`,
      `token`, `refresh_token` alanları redakte.
- [x] `src/db/`: `pg` Pool + Kysely örneği, kapanışta havuzu kapatma.
      `DbContextService` yalnızca iskelet (S04 doldurur).
- [x] `src/health/`: `GET /health` (DB'ye `select 1`), `GET /health/live`.
- [x] `src/common/errors/`: global exception filter iskeleti; tek hata
      gövdesi `{ code, message, details?, hint? }` (K-ilkesi 8).
- [x] `docker/postgres/Dockerfile`: `postgres:<major>` + `postgresql-<major>-cron`;
      `shared_preload_libraries=pg_cron`, `cron.database_name`.
- [x] `docker-compose.yml`: `db` servisi (volume, healthcheck, yalnızca
      `127.0.0.1:5432`), isteğe bağlı `api` servisi; `Dockerfile` (çok aşamalı
      build, root olmayan kullanıcı).
- [x] dbmate: `db/migrations/` (boş), `npm run db:migrate`, `db:rollback`,
      `db:new` script'leri (dbmate Docker imajı ya da npm paketi — hangisi
      seçildiyse `AGENTS.md`'ye yaz).
- [x] Test altyapısı: Jest unit; `test/` altında Testcontainers ile projenin
      Postgres imajını başlatıp migration'ları çalıştıran yardımcı
      (`test/support/database.ts`) ve bunu kullanan bir örnek e2e testi
      (`/health` 200).
- [x] ESLint + Prettier; `npm run lint`, `npm test`, `npm run test:e2e`.
- [x] `.gitignore`: `node_modules`, `dist`, `.env*` (`.env.example` hariç),
      `/dumps/`, `/exports/`, `/storage-data/`, `coverage`.
- [x] Kısa `README.md`: kurulum ve komutlar (`AGENTS.md`'ye bağlantı).

## Kapsam dışı
Şema, auth, RPC — sonraki oturumlar.

## Kabul kriterleri
- `docker compose up -d db` sağlıklı; `select * from pg_extension` içinde
  `pg_cron` kurulabiliyor (`create extension pg_cron`).
- `npm run start:dev` açılıyor, `GET /health` 200.
- `npm run lint`, `npm test`, `npm run test:e2e` geçiyor.
- `AGENTS.md` → Commands gerçek komutlarla aynı.

## Teslim notu
**2026-11-23 — tamam.**

Ne yapıldı / nerede:
- Postgres sürümü: canlı Supabase **17.6** → K4 = 17. `supabase db query
  --linked` çalışmadı (repo `link`li değil); `supabase projects list -o json`
  (`database.postgres_engine`) salt okunur olarak sürümü verdi. Orkestratör
  `select version()` ile doğruladı.
- NestJS 11 (`@nestjs/*` 11.2, TypeScript 5.9 `strict`), `src/` AGENTS.md
  yerleşiminde; boş modül klasörlerinde `.gitkeep`. Örnek `AppController` yok.
- `src/config/`: `env.schema.ts` (zod 4, `loadConfig`, `InvalidConfigError`
  tüm hataları tek mesajda, değer yazmadan), `config.module.ts` (`APP_CONFIG`
  token'ı, global). `main.ts` `.env`'i `process.loadEnvFile` ile okur ve Nest
  açılmadan önce doğrular. `.env.example`.
- Loglama: `src/common/logging/logging.options.ts` (nestjs-pino; redaksiyon
  `authorization`, `cookie`, `set-cookie`, `password`, `new_password`,
  `token`, `token_hash`, `access_token`, `refresh_token`, `otp` — 0–2 derinlik;
  URL'den sorgu dizesi atılır; `/health*` otomatik loglanmaz; geliştirmede
  pino-pretty).
- `src/db/`: `db.module.ts` (`DB_POOL` pg Pool, `KYSELY`, havuzda `error`
  dinleyicisi, kapanışta Kysely + havuz kapatılır), `db.tokens.ts`,
  `database.ts` (boş tip), `db-context.service.ts` (iskelet + `ping()`).
- `src/health/`: `GET /health` (`select 1`, yoksa 503 `service_unavailable`),
  `GET /health/live`.
- `src/common/errors/`: `ApiErrorBody`, `ApiException`, `codeForStatus`,
  global `AllExceptionsFilter` (`APP_FILTER`); beklenmeyen hata 500
  `internal`, ayrıntı yalnızca logda.
- `docker/postgres/Dockerfile` (postgres:17-bookworm + postgresql-17-cron,
  `shared_preload_libraries=pg_cron`, `cron.database_name=postgres`),
  `docker-compose.yml` (db: volume, healthcheck, 127.0.0.1; `api` profili),
  `Dockerfile` (çok aşamalı, `node` kullanıcısı, HEALTHCHECK), `.dockerignore`.
- dbmate npm paketi; `db:migrate|rollback|status|new`; `db/migrations/0000_init.sql`
  (no-op, boş klasörde dbmate hata verdiği için).
- Test: Jest unit (4 suite, 15 test); `test/support/database.ts`
  (imajı build et, PostgreSqlContainer, dbmate up), `test/support/docker-env.ts`
  (colima soketi, Ryuk soket yolu, kopuk credsStore), `test/health.e2e-spec.ts`
  (7 test: /health, /health/live, 404 gövdesi, pg_cron kurulumu,
  pgcrypto/uuid-ossp mevcut, schema_migrations, kapanışta havuz kapanıyor).

Nasıl test edildi: `docker compose up -d --build --wait db` sağlıklı,
`create extension pg_cron` OK (sonra drop edildi); `npm run db:migrate`,
`db:rollback`, `db:new`; `npm run start:dev` + `curl /health` 200;
`docker compose --profile api up -d --build --wait` → api healthy, `uid=1000(node)`,
`/health` 200; `npm run lint`, `npm test`, `npm run test:e2e` (art arda 3 kez) geçti.

Bilinen eksikler: bu Mac'te `docker compose` eklentisi kopuk (Docker Desktop
kaldırılmış) — doğrulama geçici bir `DOCKER_CONFIG` ile yapıldı; kalıcı
düzeltme kullanıcıda (AGENTS.md → "Docker on this Mac"). Express'in
`x-powered-by` başlığı açık (S16 sertleştirme).
