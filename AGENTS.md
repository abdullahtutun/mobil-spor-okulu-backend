# AGENTS.md — Mobil Spor Okulu Backend

## Overview
The self-hosted backend that replaces Supabase for the management app
(`../mobil_spor_okulu`), the parent app (`../mobil_spor_okulu_veli`) and the
marketing site's lead form (`../mobil_spor_okulu_site`). It exists so that
personal data is stored on our own VPS in Türkiye.

**NestJS 11 (TypeScript, strict) + PostgreSQL**. Locally with Docker
Compose; in production deployed by **Coolify** on the VPS (its proxy does
TLS; it builds the repo's `Dockerfile`). The migration from Supabase is split into numbered sessions;
`docs/migration/PLAN.md` is the plan, `docs/migration/PROGRESS.md` the
running log, `docs/migration/sessions/Sxx-*.md` one file per session. A
session is started with the `/oturum` skill (`.claude/skills/oturum/`).

Until the cutover (S17) **Supabase is production**. Nothing in this repo
writes to the live Supabase database or storage; dumps and exports are
read-only.

## Core decisions (do not change without updating PLAN.md → "Kararlar")

1. **The database stays the source of the business logic.** The schema, the
   ~180 SQL functions, triggers, RLS policies and pg_cron jobs come over from
   the management app's `supabase/migrations/` (as a schema dump in S03).
   NestJS does not reimplement what a SQL function already does; it calls it.
2. **RLS is kept, unchanged.** Every request runs in one transaction that
   first does `set local role <anon|authenticated|service_role>` and
   `select set_config('request.jwt.claims', <claims json>, true)`. The
   compatibility layer (S03) defines `auth.uid()`, `auth.jwt()` and
   `auth.role()` exactly as Supabase does, so the existing 127 `auth.uid()`
   uses and every policy keep working. The API logs in as a `api_authenticator`
   role that can only switch into those three roles (PostgREST's model).
3. **The RPC contract is kept.** `POST /rpc/:name` calls the SQL function
   with the same named `p_*` parameters PostgREST accepted and returns the
   same JSON, so `RpcEnvelope` and every DTO/mapper in the apps stay as they
   are. Only allow-listed functions are callable (`src/rpc/rpc-allowlist.ts`),
   each with the role it runs under.
4. **Table reads become SQL functions.** The apps' `.from(table).select(...)`
   reads are rewritten as `SECURITY INVOKER` functions returning the same JSON
   shape, served through the RPC gateway (S07). No PostgREST clone.
5. **Auth is ours but Supabase-compatible.** Users stay in `auth.users`
   (same ids, same bcrypt `encrypted_password`, same `raw_user_meta_data`), so
   nobody resets a password after the move. Access tokens are HS256 JWTs with
   Supabase's claim names (`sub`, `role`, `aud`, `email`, `session_id`,
   `user_metadata`, `app_metadata`); refresh tokens rotate and are stored
   hashed.
6. **Storage keeps `storage.objects` and its policies.** File bytes live on
   disk (`STORAGE_ROOT/<bucket>/<path>`); metadata rows go through
   `storage.objects` under the caller's role, so the existing bucket policies
   (`athlete-photos`, `school-logos`) still decide who may read, write or
   delete.
7. **No pg_net, no Vault.** The database signals the API with
   `pg_notify` (push dispatch, Realtime); the API `LISTEN`s.
8. **Same error ladder for the apps.** Errors leave the API in one shape
   (`{ "code", "message", "details"?, "hint"? }` with PostgREST-like codes for
   SQL errors) so the apps' `AppException` mapping changes as little as
   possible. See `src/common/errors/`.

## Layout

```
src/
  main.ts, app.module.ts
  config/            env schema (zod), typed ConfigService
  common/            errors, guards, decorators, interceptors, pipes
  db/                pg Pool, Kysely, DbContextService (withRole / withUser)
  rpc/               POST /rpc/:name gateway + allow-list
  auth/              login, refresh, logout, OTP flows, JWT, sessions
  mail/              per-brand SMTP + templates
  storage/           buckets on disk + storage.objects
  realtime/          WebSocket gateway fed by LISTEN/NOTIFY
  push/              FCM worker (ex send-push)
  accounts/          ex create-user, update-user, create-parent, update-parent, delete-account
  pre-registration/  ex submit-/convert-/bulk-convert-pre-registration
  site-lead/         ex site-lead
  health/
db/
  migrations/        dbmate SQL migrations (0001_baseline.sql = Supabase dump + compat, generated)
  compat/            sources of the compatibility layer, kept readable (00–03 before the dump, 04–05 after)
docker/postgres/     Postgres 17 image (pg_cron preloaded, cron.database_name=postgres, ICU en-US, UTC)
docker-compose.yml   local db (+ optional api profile); Dockerfile = API image
scripts/             build-baseline.mjs, import-migration.mjs, schema-fingerprint.sql; later data export/import, backup
dumps/               (gitignored) `supabase db dump` output — never committed
test/                e2e + integration (Testcontainers, real Postgres)
  support/           database.ts (build image, start, dbmate up, seed), docker-env.ts
  fixtures/          seed.sql (made-up data: two schools, two brands, every role) + seed-ids.ts
docs/migration/      plan, progress log, session files
```

Each feature module follows `controller → service → repository`; a
repository is the only place that talks to the database, always through
`DbContextService`. Providers are injected by interface token where a fake is
needed in tests (`I*` naming, same as the apps).

## Conventions

- Node 24 LTS, npm, TypeScript `strict`. ESLint + Prettier; `npm run lint`
  and `npm test` must pass before a session ends.
- Validation with **zod** at the edge (config, request bodies). SQL functions
  keep validating their own input; do not duplicate business rules in TS.
- Logging with `nestjs-pino`. Never log tokens, passwords, OTP codes, health
  data or full request bodies of personal-data endpoints.
- SQL migrations are plain SQL run by **dbmate** (`-- migrate:up`/`down`).
  A migration that changes behaviour the apps rely on gets a comment header
  in Turkish like the management app's migrations do.
- Comments are Turkish, identifiers English — same as the apps.
- Secrets only in `.env` (never committed); `.env.example` lists every key.
- Tests: unit tests next to code (`*.spec.ts`); integration/e2e tests in
  `test/` run against a real Postgres from the project's own image via
  Testcontainers. Security-relevant rules (a parent sees only their own
  children, passive accounts are refused, wrong brand looks like a wrong
  password) get an integration test.

## Commands

```bash
cp .env.example .env                    # once; every key is checked in src/config/env.schema.ts
docker compose up -d db                 # Postgres 17 + pg_cron on 127.0.0.1:5432
npm run db:migrate                      # dbmate up (db/migrations/, reads DATABASE_URL from .env)
npm run db:rollback                     # dbmate rollback (last migration)
npm run db:new -- <name>                # new dbmate migration file
npm run start:dev                       # API on :3000 — GET /health, GET /health/live
npm test                                # unit (src/**/*.spec.ts)
npm run test:e2e                        # integration (test/**/*.e2e-spec.ts, Testcontainers)
npm run lint                            # eslint + prettier (check only; lint:fix fixes)
docker compose --profile api up -d --build   # API image too (what Coolify builds)
```

- **dbmate** is the npm package (`node_modules/.bin/dbmate`), not a Docker
  image; scripts pass `--no-dump-schema` (no local `pg_dump` needed).
  `0000_init.sql` is a no-op: dbmate's `up` fails on an empty folder.
  dbmate runs every migration in one transaction; a migration must not
  contain its own `begin;`/`commit;`.
- The database is `postgres` (as on Supabase), because `pg_cron` runs in
  exactly one database (`cron.database_name`).
- **Kysely is pinned to 0.28.x**: 0.29 is ESM-only and Jest (CommonJS,
  ts-jest) cannot load it. The app itself would run with 0.29.

## Schema sync (until the cutover, S17)

Supabase stays production until S17, so schema changes keep being written
as migrations in `../mobil_spor_okulu/supabase/migrations/` and applied to
Supabase there. The baseline (dump of 2026-11-23) already contains every
management migration **up to and including `20261027_app_min_versions.sql`**.
**Every newer management migration is carried over here**:

```bash
node scripts/import-migration.mjs ../mobil_spor_okulu/supabase/migrations/<file>.sql
#   → db/migrations/00NN_<name>.sql (next number; top-level begin/commit removed,
#     _rollback/<file>_rollback.sql becomes `-- migrate:down` if it exists)
npm run db:migrate && npm run test:e2e
```

- The script refuses a file it already imported, and warns on
  Supabase-only references (pg_net, vault, realtime, storage.buckets,
  extensions) — adapt those by hand (see `db/compat/04_supabase_removed.sql`).
- `test/schema.e2e-spec.ts` pins counts and fingerprints of the live schema.
  An imported migration changes them: add its objects to `NOT_YET_LIVE`
  until it is applied to Supabase; once it is, take the live values again
  (run `scripts/schema-fingerprint.sql` read-only on Supabase) and fold the
  delta into `LIVE`. That is the check that our schema still equals live.
- `0001_baseline.sql` is generated and never edited by hand. It is
  regenerated only if the baseline itself must change (it should not after
  S03): `supabase db dump --project-ref <ref> -f dumps/schema.sql` (schema
  only, no DB password needed — the CLI opens a temporary login role; on
  colima export `DOCKER_HOST=unix://$HOME/.colima/default/docker.sock`),
  then `node scripts/build-baseline.mjs`.
- Things a schema dump does not carry live in their own migrations:
  storage policies (0002), pg_cron jobs (0003, UTC, includes the
  panel-made `expire_trials_job`), `roles` / `role_permissions` (0004),
  bucket rows (`db/compat/03`), the `auth.users` trigger (`db/compat/05`).
- The database collation must stay ICU `en-US` (as on Supabase): `order by`
  on names and the fingerprints depend on it. It is set at initdb in
  `docker/postgres/Dockerfile`; an existing volume keeps its old collation
  (`docker compose down -v`).
- `api_authenticator` is created without a password; the environment sets
  it (`alter role api_authenticator password …`, S04 locally, S16 in
  production).

### Docker on this Mac (colima)

Docker runs in **colima** (`colima start --cpu 2 --memory 4`); Docker
Desktop was removed. `docker compose` works directly (fixed 2026-11-23:
`docker-compose`/`docker-buildx` from Homebrew via `cliPluginsExtraDirs`
in `~/.docker/config.json`, no `credsStore`). Tools that do not read the
docker context (Testcontainers, `supabase db dump`) need
`DOCKER_HOST=unix://$HOME/.colima/default/docker.sock`.

Testcontainers needs none of that by hand: `test/support/docker-env.ts`
(jest-e2e `setupFiles`) sets `DOCKER_HOST=unix://~/.colima/default/docker.sock`
when unset, `TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE=/var/run/docker.sock` (Ryuk
mounts the socket path *inside* the VM), and points `DOCKER_CONFIG` at an
empty config when the `credsStore` helper is missing. Ryuk stays enabled.
The first e2e run builds the Postgres image (~1 min); later runs take ~3 s.
