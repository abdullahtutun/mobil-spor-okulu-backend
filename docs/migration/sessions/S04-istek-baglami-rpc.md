# S04 — DB istek bağlamı ve RPC kapısı

**Repo:** backend (uygulamalar okunur) · **Bağımlı:** S03

## Amaç
Uygulamaların bugün PostgREST'e yaptığı `.rpc()` çağrılarını aynı parametre
ve aynı JSON ile karşılayan `POST /rpc/:name`, ve her isteği doğru rolde
ve doğru kullanıcı kimliğiyle çalıştıran DB katmanı (K5, K6).

## Okunacaklar
- **S03'ten:** `api_authenticator` rolü var (`login noinherit`, anon /
  authenticated / service_role'e geçebilir) ama **parolası yok**; S04
  yerel/test için verir (`alter role api_authenticator password …`, env'de
  ayrı bir bağlantı adresi). Test yardımcıları: `startTestDatabase({ seed:
  true })`, sabit kimlikler `test/fixtures/seed-ids.ts`; `test/schema.e2e-spec.ts`
  içindeki `asRole()` aynı bağlamı elle kuruyor (DbContextService gelince
  ona taşınabilir).
- `INVENTORY.md` → 2
- İki uygulamada `lib/core/data/remote/rpc_envelope.dart`,
  `network_error.dart`, `AppException` eşlemesi (hata gövdesinden ne
  okunuyor: `code`, `message`, `details`, `hint`, HTTP durumu)
- İki uygulamada `endpoint.dart` (RPC adları)

## Yapılacaklar
- [x] `DbContextService.run({ role, claims }, fn)`: tek transaction;
      `set local role`, `set_config('request.jwt.claims', …, true)` (ve
      eski tek claim ayarları `request.jwt.claim.sub`/`role`), `set local
      statement_timeout`. Bağlantı her durumda temiz döner.
- [x] JWT doğrulama guard'ı: `Authorization: Bearer` yoksa `anon`; varsa
      HS256 + `JWT_SECRET`, `exp`, `aud=authenticated` → `authenticated`.
      (Token üretimi S05'te; burada test için token yardımcı fonksiyonu.)
      Supabase'in ürettiği bir token'ın da kabul edildiğini test et (aynı
      secret kullanılırsa geçişte açık oturumlar bozulmaz — S12 kararı).
- [x] `src/rpc/rpc-allowlist.ts`: her fonksiyon için `{ name, roles }`
      (`anon` yalnızca `public_get_*_by_token` ve S02'nin
      `get_min_app_version`'ı). Uygulamaların çağırdığı tam liste
      `endpoint.dart` ve `.rpc(` çağrılarından çıkarılır; listede olmayan
      fonksiyon 404.
- [x] Açılışta `pg_proc`'tan allow-list'teki fonksiyonların imzaları
      (parametre adları/tipleri, varsayılanlar, dönüş tipi, `setof`) okunur
      ve önbelleğe alınır. Çağrı `select … from public.fn(p_a => $1::tip, …)`;
      gönderilmeyen parametre varsayılana bırakılır; bilinmeyen parametre
      PostgREST'teki gibi hata.
- [x] Dönüş: `json/jsonb`/skaler → değerin kendisi; `setof`/`table` → dizi;
      `void` → `null` (PostgREST ile aynı; `RpcEnvelope` bunu bekliyor).
- [x] Hata eşlemesi (`src/common/errors/pg-error.mapper.ts`): Postgres
      SQLSTATE → HTTP + `{ code, message, details, hint }`, PostgREST'in
      davranışıyla aynı (`P0001` → 400, `42501` → 401/403, `23505` → 409,
      `PGRST202` vb.). Uygulamanın gerçekten okuduğu alanlara göre test.
- [x] Hız sınırı (`@nestjs/throttler`), gövde boyutu sınırı, CORS (web
      kökenleri env'den).
- [x] Integration testleri (S03 seed'i ile):
      veli kendi çocuğunu görür, başkasınınkini `not_found` alır;
      pasif veli `forbidden`; `anon` yalnızca allow-list'teki anon
      fonksiyonları çağırabilir; `service_role`'e ait fonksiyonlar dışarıdan
      çağrılamaz; `get_session_data` beklenen şekli döner.

## Kapsam dışı
Token üretimi, giriş (S05). Tablo okumaları (S07).

## Kabul kriterleri
- Veli uygulamasının 9 RPC'sinin hepsi bir e2e testinde çağrılmış.
- Allow-list ile `endpoint.dart` arasında fark yok (fark varsa gerekçeli).
- lint/test/test:e2e geçiyor.

## Teslim notu
**Durum: tamam (2026-11-23).**

Ne yapıldı, nerede:
- `src/db/db-context.service.ts` — `run({ role, claims?, statementTimeoutMs? }, fn)`,
  `withRole`, `withUser`. Tek transaction: `set local role`, `set_config`
  ile `request.jwt.claims` + eski `request.jwt.claim.sub`/`.role` +
  `statement_timeout` (rol başına: anon 3 sn, authenticated 8 sn —
  Supabase'in varsayılanları —, service_role 60 sn). Hata → rollback;
  rollback da düşerse bağlantı havuza verilmez (`release(true)`). Rol adı
  yalnızca üç sabitten biri olabilir.
- Havuz artık **`API_DATABASE_URL`** ile `api_authenticator` olarak bağlanır
  (`src/db/db.module.ts`); `DATABASE_URL` (postgres) yalnızca dbmate'in.
  Parola: `npm run db:api-password` (`scripts/set-api-password.mjs`,
  API_DATABASE_URL'deki parolayı role yazar); testte `startTestDatabase`
  kendisi verir ve `apiUrl` döner.
- `src/auth/request/` — `JwtVerifier` (HS256 sabit, `exp`; `authenticated`
  için `aud` ve UUID `sub`; `role: anon` token'ı = anon; başka her rol,
  özellikle `service_role`, 401), `RequestAuthGuard` + `@ReqAuth()`.
  Hatalar PostgREST kodlarıyla: imza/biçim `PGRST301`, süre/claim
  `PGRST303` ("JWT expired") — uygulamaların `SessionRetryClient`'ı bunları
  okuyup token yeniliyor. `src/auth/auth.module.ts` (S05 genişletir).
- `src/rpc/` — `rpc-allowlist.ts` (65 fonksiyon, `callers` + `apps`),
  `rpc-catalog.service.ts` (açılışta `pg_proc`'tan imzalar, overload
  destekli), `rpc-call.ts` (eşleştirme + çağrı SQL'i: parametreler tek JSON,
  `json_to_record` ile fonksiyonun tiplerine — PostgREST'in yöntemi),
  `rpc.service.ts`, `rpc.controller.ts` (`POST /rpc/:name`, 200, `null`
  gövdesi de `null` yazılır).
- `src/common/errors/pg-error.mapper.ts` — SQLSTATE → HTTP, PostgREST 12'nin
  tablosu; gövde `{code: SQLSTATE, message, details, hint}` (yoksa `null`).
  `all-exceptions.filter.ts` body-parser hatalarını (413) 500 saymaz.
- `src/app.setup.ts` — `configureApp`: gövde sınırı (`BODY_LIMIT`), CORS
  (`CORS_ORIGINS`), `trust proxy` (`TRUST_PROXY`), `x-powered-by` kapalı;
  `main.ts` ve testler aynısını kullanır. Hız sınırı `@nestjs/throttler`
  global (`THROTTLE_LIMIT`/`THROTTLE_TTL_MS`, IP başına), `/health` muaf.

Nasıl test edildi:
- `test/rpc.e2e-spec.ts`: veli uygulamasının **10** RPC'si (9 + S02'nin
  `get_min_app_version`'ı) gerçek seed'le; veli kendi çocuğunu görür,
  başkasınınki (aynı okul, başka okul) `not_found`; pasif veli `forbidden`;
  anon yalnızca dört anon fonksiyonu çağırır, diğerleri 401 `42501`;
  service_role'e ait ve eski fonksiyonlar (`delete_own_account`,
  `claim_push_batch`, `convert_pre_registration`, `save_attendances` …) ve
  `__proto__` gibi adlar 404 `PGRST202`; service_role / süresi geçmiş /
  başka anahtarlı / `alg: none` / yanlış `aud` token 401; bilinmeyen ve eksik
  parametre 404, tip hatası 400 `22P02`, bozuk JSON 400, büyük gövde 413,
  CORS, hız sınırı 429. Supabase GoTrue biçimli token ve anon anahtarı kabul.
- `test/db-context.e2e-spec.ts`: api_authenticator kendi başına tablo
  okuyamaz; rol/`auth.uid()`/`auth.jwt()`; RLS; havuza temiz dönüş (10
  bağlantının hepsi); rollback; statement_timeout `57014`; setof/void/out
  parametreli çağrı SQL'i gerçek fonksiyonlarla.
- `test/rpc-allowlist.e2e-spec.ts`: allow-list, iki uygulamanın `.rpc(`
  çağrılarından (endpoint.dart sabitleriyle) yeniden çıkarılanla **fark
  yok** (kardeş repo yoksa atlanır; bir satır silinince düştüğü denendi);
  her fonksiyon veritabanında tek overload'lu var; `callers` veritabanının
  anon/authenticated EXECUTE yetkileriyle aynı.
- `npm run lint`, `npm run typecheck`, `npm test` (unit), `npm run test:e2e`
  geçiyor; derlenmiş API yerel Postgres'e `api_authenticator` ile bağlanıp
  curl'le denendi.

Bilinen eksikler / bilinçli farklar:
- `GET /rpc/:name` yok (uygulamalar POST kullanıyor).
- Bozuk JSON'un kodu `bad_request` (PostgREST `PGRST102`): Nest SyntaxError'ı
  filtreye gelmeden BadRequestException'a çeviriyor. İki uygulama da bu
  durumu üretmez (gövdeyi kendileri serileştirir).
- İmza önbelleği açılışta bir kez okunur; migration sonrası API yeniden
  başlatılmalı (Coolify her dağıtımda yapar).
- Hız sınırı bellekte (tek süreç); birden çok API örneği olursa S16'da
  paylaşılan depo gerekir.
