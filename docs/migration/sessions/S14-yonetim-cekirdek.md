# S14 — Yönetim uygulaması: istemci, auth ve RPC

**Repo:** yönetim (`../mobil_spor_okulu`), dal `migrate/own-backend`
· **Bağımlı:** S05, S06 (S13'ün `ApiClient`/`AuthSession` tasarımı: veli `migrate/own-backend`, `lib/core/data/remote/api/`)

## Amaç
Yönetim uygulamasının çekirdeğini yeni backend'e geçirmek: istemci, oturum,
bütün auth akışları ve bütün `.rpc()` çağrıları. Okumalar, storage, eski
Edge Function'lar ve realtime S15'te.

## Okunacaklar
- `../mobil_spor_okulu/AGENTS.md` (tamamı)
- S13 teslim notu (veli uygulamasında ne nasıl yapıldı — aynı yapı
  kullanılır, kod kopyalanabilir)
- `docs/api/auth.md`
- Y `lib/main*.dart` (dört giriş noktası), `core/data/remote/`,
  `core/provider/{start_up_provider,session_refresh,data_invalidation}.dart`,
  `features/auth/`, `features/set_password/`, `features/wizard/`

## Yapılacaklar
- **S05'ten:** auth uçları ve hata kodları `docs/api/auth.md`'de
  (`/auth/token?grant_type=password|refresh_token`, `/auth/logout?scope=`,
  `/auth/user`). Refresh token her kullanımda döner — yanıttaki yenisi
  saklanmalı; 400/403 = oturum bitti (çıkış), ağ hatası = geçici. RPC'de
  401 `PGRST303`/`PGRST301` → bir kez yenile, tekrar gönder.
- [x] `migrate/own-backend` dalı.
- [x] S13'teki `ApiClient` ve `AuthSession` (aynı tasarım; ortak paket
      çıkarmak gerekip gerekmediği günlüğe — varsayılan: kopya).
- [x] Auth akışları: giriş, çıkış (global/local), şifre sıfırlama (kod),
      okul kaydı (`signUp` + kod + yeniden gönderme), davetle şifre belirleme
      (web `main_set_password.dart`), sihirbazdaki çıkışlar.
- [x] Bütün RPC data source'ları `ApiClient.rpc`'ye (parametreler aynı).
- [x] Başlangıç ve oturum yenileme mantığı (`start_up_provider`,
      `session_refresh`) yeni stream'e.
- [x] Testler geçer; yeni birim testleri.

## Kapsam dışı
`.from()` okumaları, storage, `functions.invoke`, realtime (S15).

## Kabul kriterleri
- `.rpc(` ve `.auth.` çağrısı kalmadı.
- `flutter analyze`, `flutter test` geçiyor.
- Yerel backend ile giriş, şifre sıfırlama ve okul kaydı denendi.

## Teslim notu
2026-11-23, yönetim reposu `migrate/own-backend` (commit `ba3b4fd`, `main`'den;
`main` Supabase'te kaldı).

**Ne, nerede** (`../mobil_spor_okulu/lib/core/data/remote/api/`, veli S13
tasarımının kopyası — ortak paket çıkarılmadı, varsayılan "kopya"):
- `api_config.dart`, `session_store.dart` (veliyle aynı), `auth_session.dart`
  (+ `signUp`, `resendSignupCode`; `verifyOtp` recovery/signup/invite),
  `api_client.dart` (yalnızca `rpc`; functions/storage/realtime S15),
  `core/provider/api_provider.dart`. `config/{dev_adim,public}.json`'a
  `API_BASE_URL`.
- `main.dart`: taşıma zinciri tek (`SessionRetryClient → SupabaseHttpLogger →
  TimeoutHttpClient → NetworkAwareHttpClient`), `AuthSession` zincirin
  retry'sız kısmını kullanır. `main_set_password.dart` ve
  `main_public_pre_registration.dart` `MemorySessionStore`'lu birer `ApiClient`.
- Data source'lar: auth'un hepsi (login, logout, forgot password, signup,
  OTP + resend, set password), 28 dosyadaki bütün `.rpc(` → `ApiClient.rpc`
  (parametreler aynı), `start_up_provider` / sihirbaz / hesap silme /
  `rpc_context_provider` / gelen kutusu `currentUser` → `AuthSession`.
  `SupabaseAccessTokenRefresher` kalktı; `SessionRetryClient`'ın muaf yolları
  backend'in `/auth/<uç>`'ları + `/auth/v1/`, storage `/storage/(object|v1)/`.
- **Geçiş durumu:** `.from()`, storage, `functions.invoke`, realtime S15'e
  kadar Supabase istemcisinde; `Supabase.initialize(accessToken:
  auth.accessTokenForRequest)` — `supabase.auth` kapalı, o istekler yeni
  backend'in token'ını taşır ve Supabase reddeder. Dal S15 bitene kadar hiçbir
  backend'e karşı kullanılabilir değil (derlenir, testler geçer).
- **Supabase türleri geçici olarak korundu:** `AuthSession`/`ApiClient`
  supabase-dart'ın `Session`, `User`, `AuthResponse`, `UserResponse`,
  `AuthApiException`, `AuthRetryableFetchException`, `PostgrestException`
  türlerini kullanıyor (auth_session.dart yeniden dışa veriyor): 29
  repository'nin `on AuthException` / 25'inin `on PostgrestException` dalı ve
  `localizeAuthError` değişmeden kaldı. Ağdan düşen yenileme
  `AuthRetryableFetchException` (yönetimin `isNetworkError`'ı onu tanıyor),
  JSON olmayan 2xx/ağ geçidi gövdesi `PostgrestException(code: '<status>')`
  (gateway kuralı). S15 paketi çıkarırken aynı adlarla yerel türler yazılır.
- Şifre oluşturma sayfası: eski `#access_token` bağlantısı (`SessionLink`)
  "süresi dolmuş" görünümüne düşer (yalnızca Supabase açabiliyordu);
  `token_hash` bağlantıları backend'de doğrulanır.

**Test:** `flutter analyze` → 52 sorun, hepsi `main`'de de var (main 53;
yeni yok). `flutter test` → 1219 geçti, 1 atlandı (e2e). Yeni:
`test/core/api_client_test.dart` (16), `session_retry_client_test.dart`'a
yeni yollar testi, `test/helpers/fake_api_client.dart`. `flutter build web`
(public, `main.dart`) derlendi.

**Yerel deneme (backend + seed):** `docker compose down -v db && up`,
`db:migrate`, `db:api-password`, `test/fixtures/seed.sql`; `node dist/main`
`SMTP_HOST=127.0.0.1 SMTP_PORT=2525 SMTP_USER_*=… AUTH_EMAIL_SEND_INTERVAL_SEC=0`
ile; 2525'te her e-postayı `{to, code, token_hash}` JSON satırı yazan küçük
bir SMTP alıcısı (repoya girmedi). `API_E2E_BASE_URL=http://127.0.0.1:3000
API_E2E_MAILBOX=<dosya> flutter test test/e2e/local_backend_test.dart` iki
kez (aradaki seed sıfırlamasıyla) geçti: güncelleme kapısı (anon), yanlış
şifre → `InvalidCredentialsException`, genel müdür girişi +
`get_session_data` (dev_adim, okul A), `create_branch` + `get_setup_progress`,
antrenöre `get_setup_progress` → `RpcException`, bilinmeyen fonksiyon →
`PGRST202`, `get_pre_registration_link` + oturumsuz
`public_get_branches_by_token`, refresh rotasyonu, `create-parent` daveti →
gerçek e-postadaki `token_hash` ile şifre oluşturma + giriş, **gerçek kodla
şifre sıfırlama** (eski şifre `invalid_credentials`, yenisi girer), **okul
kaydı** (signup → onaysız giriş `email_not_confirmed` → resend → eski kod
`otp_expired` → yeni kodla verify → `create_school` → oturumda yeni okul,
marka public), çıkış → eski refresh token 400. Ekranlar cihazda denenmedi.

**Bilinen eksikler / sonraki oturumlar:**
- S15: supabase türlerinin yerel karşılıkları (veli `api_exception.dart`,
  `auth_session.dart`'taki `Session`/`AuthUser`… — adlar korunursa
  çağıranlar değişmez), `supabaseClientProvider` ve `SupabaseClient`
  parametreli data source kurucuları (S14 ikinci parametre olarak
  `ApiClient` ekledi), `SupabaseHttpLogger` adı, `supabase/` klasörüne
  atıflar.
- Eski Supabase oturumu taşınmaz: yeni sürüme geçen personel bir kez yeniden
  giriş yapar (veliyle aynı, S12/S17).
- Bağımlılık eklenmedi (flutter_secure_storage zaten vardı); supabase_flutter
  çıkınca mağaza sürümü gerekir (S17).
