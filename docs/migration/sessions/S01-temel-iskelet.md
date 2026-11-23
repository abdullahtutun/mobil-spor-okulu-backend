# S01 — Temel iskelet

**Repo:** backend · **Bağımlı:** —

## Amaç
Sonraki her oturumun üzerine kuracağı çalışan, test edilebilir bir NestJS
projesi ve yerelde ayağa kalkan Postgres. İş mantığı yok.

## Okunacaklar
- `AGENTS.md` (Layout, Conventions, Commands)
- `docs/migration/PLAN.md` → K1–K4, K12

## Yapılacaklar
- [ ] Supabase projesinin Postgres sürümünü öğren (salt okunur):
      `cd ../mobil_spor_okulu && supabase db query --linked "select version()"`.
      Major sürümü `PLAN.md` K4'e yaz.
- [ ] NestJS 11 projesi (npm, `strict`) bu repoda; `src/` `AGENTS.md`'deki
      yerleşime göre boş modül klasörleriyle. Varsayılan `AppController`
      örneğini sil.
- [ ] `src/config/`: zod ile env şeması (`NODE_ENV`, `PORT`, `DATABASE_URL`,
      `JWT_SECRET`, `LOG_LEVEL`; sonraki oturumlar kendi anahtarlarını ekler),
      eksik/yanlış env'de açılışta net hata. `.env.example`.
- [ ] `nestjs-pino` ile loglama; `authorization`, `cookie`, `password`,
      `token`, `refresh_token` alanları redakte.
- [ ] `src/db/`: `pg` Pool + Kysely örneği, kapanışta havuzu kapatma.
      `DbContextService` yalnızca iskelet (S04 doldurur).
- [ ] `src/health/`: `GET /health` (DB'ye `select 1`), `GET /health/live`.
- [ ] `src/common/errors/`: global exception filter iskeleti; tek hata
      gövdesi `{ code, message, details?, hint? }` (K-ilkesi 8).
- [ ] `docker/postgres/Dockerfile`: `postgres:<major>` + `postgresql-<major>-cron`;
      `shared_preload_libraries=pg_cron`, `cron.database_name`.
- [ ] `docker-compose.yml`: `db` servisi (volume, healthcheck, yalnızca
      `127.0.0.1:5432`), isteğe bağlı `api` servisi; `Dockerfile` (çok aşamalı
      build, root olmayan kullanıcı).
- [ ] dbmate: `db/migrations/` (boş), `npm run db:migrate`, `db:rollback`,
      `db:new` script'leri (dbmate Docker imajı ya da npm paketi — hangisi
      seçildiyse `AGENTS.md`'ye yaz).
- [ ] Test altyapısı: Jest unit; `test/` altında Testcontainers ile projenin
      Postgres imajını başlatıp migration'ları çalıştıran yardımcı
      (`test/support/database.ts`) ve bunu kullanan bir örnek e2e testi
      (`/health` 200).
- [ ] ESLint + Prettier; `npm run lint`, `npm test`, `npm run test:e2e`.
- [ ] `.gitignore`: `node_modules`, `dist`, `.env*` (`.env.example` hariç),
      `/dumps/`, `/exports/`, `/storage-data/`, `coverage`.
- [ ] Kısa `README.md`: kurulum ve komutlar (`AGENTS.md`'ye bağlantı).

## Kapsam dışı
Şema, auth, RPC — sonraki oturumlar.

## Kabul kriterleri
- `docker compose up -d db` sağlıklı; `select * from pg_extension` içinde
  `pg_cron` kurulabiliyor (`create extension pg_cron`).
- `npm run start:dev` açılıyor, `GET /health` 200.
- `npm run lint`, `npm test`, `npm run test:e2e` geçiyor.
- `AGENTS.md` → Commands gerçek komutlarla aynı.

## Teslim notu
_(oturum sonunda doldurulur)_
