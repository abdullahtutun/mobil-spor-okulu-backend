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
  main.ts, app.module.ts, app.setup.ts (body limit, CORS, trust proxy — shared with e2e)
  config/            env schema (zod), typed ConfigService
  common/            errors, guards, decorators, interceptors, pipes
  db/                pg Pool, Kysely, DbContextService (withRole / withUser)
  rpc/               POST /rpc/:name gateway + allow-list (rpc-allowlist.ts), pg_proc signature cache
  auth/              request/ (S04: JwtVerifier, RequestAuthGuard, @ReqAuth); S05: /auth/token, /logout, /user (docs/api/auth.md);
                     S06: flows/ (/auth/recover, /signup, /resend, /verify), admin/ (AuthAdminService, server-only), otp/
  mail/              per-brand SMTP (MailService) + email-content.ts / brand-logos.ts (copies of the management send-email hook)
  storage/           S08: /storage/object/* (storage-api compatible, docs/api/storage.md); disk-store, object-key, mime, multipart
  realtime/          WebSocket gateway fed by LISTEN/NOTIFY
  push/              FCM worker (ex send-push)
  accounts/          S09: POST /functions/{create-user,update-user,create-parent,update-parent,delete-account} (docs/api/functions.md)
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
  support/           database.ts (build image, start, dbmate up, seed), docker-env.ts, fake-mail.ts (FakeMailbox),
                     postgrest.ts (a real PostgREST on the test db — S07's read functions are diffed against it)
  fixtures/          seed.sql (made-up data: two schools, two brands, every role) + seed-ids.ts
docs/migration/      plan, progress log, session files
docs/api/            API contracts the apps are rewritten against (auth.md, storage.md, functions.md)
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
npm run db:api-password                 # once per fresh db: sets api_authenticator's password from API_DATABASE_URL
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
`0008_parent_email_change.sql` (= `20261123_parent_email_change.sql`) is
imported but **not yet live**: its objects are in `NOT_YET_LIVE` /
`NOT_YET_LIVE_FINGERPRINT` of `test/schema.e2e-spec.ts`.
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

## Request context and RPC gateway (S04)

- The API's pool connects as **`api_authenticator`** (`API_DATABASE_URL`);
  that role can read nothing by itself. `DATABASE_URL` (postgres) is only for
  dbmate and tests' setup.
- Every database call goes through `DbContextService.run({ role, claims },
  fn)` (or `withRole` / `withUser`): one transaction, `set local role`,
  `request.jwt.claims` (+ legacy `request.jwt.claim.sub/role`),
  `statement_timeout` per role (anon 3 s, authenticated 8 s, service_role
  60 s). Never query the pool directly in a feature.
- `RequestAuthGuard` (per controller, not global) turns `Authorization:
  Bearer` into `anon` / `authenticated`; a `service_role` token is refused
  (401) — service_role exists only inside the server.
- `POST /rpc/:name` calls only functions in `src/rpc/rpc-allowlist.ts`
  (`callers` must equal the database's EXECUTE grants; `apps` must equal the
  apps' `.rpc(` calls — `test/rpc-allowlist.e2e-spec.ts` checks both). A new
  RPC the apps call = one line there. Functions called only by our own
  services (ex Edge Functions) are **not** listed.
- SQL errors leave as PostgREST does: `src/common/errors/pg-error.mapper.ts`
  (`code` = SQLSTATE, `details`/`hint` null if absent); token errors
  `PGRST301` / `PGRST303` (the apps refresh on these).

## Read functions (S07)

- The apps' `.from(table).select(...)` reads are `list_*` / `get_*` SQL
  functions (`db/migrations/0007_read_functions.sql`, mapping
  `docs/migration/read-mapping.md`): `SECURITY INVOKER`, `stable`,
  `search_path = public, extensions`, return the same JSON PostgREST did
  (`*` = `to_jsonb(row)`, embeds under the same keys, many-to-one → object
  or null, one-to-many → array or `[]`, `!inner` → inner join). No new
  permission rule: RLS of every table read decides, as it did in PostgREST.
- Paging is `p_offset` / `p_limit`, the reply a plain array (as
  `paged_query.dart` expects). Anon cannot call them.
- They are allow-listed under `READS` with `reads: [<table>]`. Their comment
  starts with `backend:` — that keeps them out of the live-schema fingerprint
  (`BACKEND_ONLY` in `test/schema.e2e-spec.ts`); do the same for any other
  backend-only function.
- `test/read-functions.e2e-spec.ts` asks a real PostgREST the app's query and
  our `/rpc` the function, for ten users, and compares the JSON. A changed or
  new app read = change the function **and** add/adjust the case there.

## Auth (S05)

- Contract: `docs/api/auth.md`. GoTrue-compatible: same `auth.users` rows and
  bcrypt hashes, access token claims as Supabase's, errors `{code, message}`
  with GoTrue's `error_code` values.
- The auth module reaches the auth tables only through
  `DbContextService.asAuthService` (role `auth_service`, 0005: auth tables
  only, no bypassrls, no public access). A later session that needs more
  (insert users, OTP columns) grants it in a new migration and updates the
  grant list pinned in `test/schema.e2e-spec.ts`.
- Refresh tokens are stored as SHA-256 hex in `auth.refresh_tokens.token`/
  `parent`, never in plain text. Reuse outside the rules deletes the whole
  session (`refresh_token_already_used`).
- Wrong password, unknown e-mail, banned and deleted accounts give the same
  `invalid_credentials`; rate limits apply before bcrypt and regardless of
  whether the account exists. Keep it that way.
- Passive accounts, roles and brands are **not** checked at login — that
  stays in the apps via `get_session_data`.

## Auth flows and e-mail (S06)

- Code flows (`/auth/recover`, `/signup`, `/resend`, `/verify`) and the
  server-only `AuthAdminService` (invite/create/update/ban/delete — S09/S10
  use it). Contract and rules: `docs/api/auth.md` → "Kodlu akışlar".
- **No account enumeration**: recover/resend always `{}`, signup on an
  existing address returns a same-shaped fake user, send limits count
  addresses whether or not they exist, every verify refusal is 403
  `otp_expired`. Keep it that way.
- Codes are stored as HMAC (key derived from `JWT_SECRET`), invite tokens as
  SHA-256; per-code wrong attempts in `auth.otp_attempts` (0006).
- **E-mail follows the account's brand** (`user_metadata.brand`; invite:
  the school's brand passed in). A brand without `SMTP_USER_*`/`SMTP_PASS_*`
  sends nothing and errors — never a fallback to the other brand.
  `src/mail/email-content.ts` and `brand-logos.ts` are copies of the
  management repo's `supabase/functions/send-email/`; change both together.
- Tests never use SMTP: `createTestApp` overrides `MAIL_TRANSPORT_FACTORY`
  with `FakeMailbox` (`mailboxOf(app)`; `codeOf`, `inviteLinkOf`).

## Storage (S08)

- Contract: `docs/api/storage.md`. Same paths and bodies as Supabase
  storage-api under `<API>/storage` (so `storage_client` keeps working with a
  new base URL); errors `{statusCode, code, error, message}` with HTTP 400,
  token errors 401 `PGRST30x`.
- **The policies decide**: every `storage.objects` read/insert/upsert/delete
  runs under the caller's role with the same SQL storage-api uses for its
  permission check; only bucket config and the startup sweep use
  service_role. Do not add a TS-side permission rule — change a policy in a
  migration instead. No UPDATE policy on athlete-photos = no overwrite.
- Bytes in `STORAGE_ROOT/<bucket>/<name>` (0700/0600). Never build a disk
  path without `DiskStore.pathFor` (`object-key.ts` rule: no `..`, `.`,
  empty or dot-leading segments); no symlink is followed under the root.
  Upload = temp file → row INSERT + `rename` in one transaction; delete =
  row DELETE + move to `.trash` → commit → purge.
- Content type is checked against the bucket list **and** the body's
  signature; a new image type for a bucket needs its signature in `mime.ts`.
- e2e: each app gets its own temp `STORAGE_ROOT` (`test/support/app.ts`);
  `app.get(StorageService).store.root` is the folder.

## Account functions (S09)

- Ex Edge Functions at `POST /functions/<name>` with the **same bodies,
  replies, HTTP codes and `reason`s** (`docs/api/functions.md`): the apps
  read them with `RpcEnvelope.fromEdge` / `fromFunctionException`. Shapes in
  `src/accounts/function-response.ts`; never return the API's generic
  `{code, message}` from a function except for token errors (401 `PGRST30x`,
  the old gateway's job).
- **Order of checks is the Edge Functions' order** and is security-relevant:
  validate (`save_staff_profile(p_validate_only)`, `can_manage_parent`,
  `has_branch_access`) before touching an auth user, e-mail or password,
  before an invite leaves, before deleting anything. The caller comes from
  the token only (`CallerResolver`, `/auth/user` rules), never the body.
- SQL runs **as the caller** (`withUser`) so RLS and the SQL functions
  decide; service_role only for `schoolBrand` and `delete_own_account`.
  Auth users only through `AuthAdminService`; account deletion is
  `delete_own_account` (tombstone), never `deleteUser`.
- A parent's e-mail change keeps the **same** auth user (20261123):
  profile + links, `reset_parent_login_email` and the invite
  (`AuthAdminService.reinviteWithin`) run in one transaction via
  `DbContextService.switchRole`; the mail leaves before commit, so any failure
  changes nothing.

## Docker on this Mac (colima)

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
