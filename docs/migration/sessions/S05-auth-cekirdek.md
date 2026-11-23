# S05 — Auth çekirdeği

**Repo:** backend (uygulamalar okunur) · **Bağımlı:** S04

## Amaç
Şifreyle giriş, token yenileme, çıkış ve kullanıcı bilgisi. Supabase'teki
hesaplar aynen çalışmalı (aynı id, aynı bcrypt hash) ve uygulamaların
bugün ayırt ettiği hatalar aynı kalmalı (K8).

## Okunacaklar
- `INVENTORY.md` → 5
- İki uygulamada `features/auth/data/source/login/`, `logout/`, `session/`,
  `core/data/remote/session/` (`SessionRetryClient`, refresher), V
  `session_gate.dart` (ağ hatası ≠ çıkış), hata eşlemesi (yanlış şifre,
  e-posta onaysız, ağ)
- `db/compat/02_auth.sql`

## Yapılacaklar
- [x] Uç noktalar (gövde ve yanıtlar GoTrue'ya yakın; Dart tarafı S13/S14'te
      bunlara göre yazılacak — son hâlini `docs/api/auth.md`'ye yaz):
  - `POST /auth/token?grant_type=password` `{ email, password }`
  - `POST /auth/token?grant_type=refresh_token` `{ refresh_token }`
  - `POST /auth/logout` `{ scope: global | local | others }`
  - `GET /auth/user`, `PUT /auth/user` (`password`, `data`)
  - Yanıt: `{ access_token, token_type, expires_in, expires_at,
    refresh_token, user }`; `user` Supabase'in `User` JSON'una yakın
    (`id`, `email`, `user_metadata`, `app_metadata`, …).
- [x] Şifre doğrulama `bcrypt` (`$2a$`/`$2b$`), yeni şifreler de bcrypt.
      Asgari şifre kuralı Supabase projesindekiyle aynı (salt okunur kontrol
      et, `PLAN.md`'ye yaz).
- [x] JWT: HS256, `JWT_SECRET`, süre 3600 sn (Supabase ile aynı); claim'ler
      `sub`, `role=authenticated`, `aud=authenticated`, `email`,
      `session_id`, `user_metadata`, `app_metadata`, `iat`, `exp`.
- [x] Refresh token: rastgele, DB'de hash'li, her kullanımda döner;
      kullanılmış bir token tekrar gelirse o oturumun tüm token'ları iptal
      (çalınma tespiti); kısa bir yeniden deneme penceresi (ağ kopması
      yüzünden aynı token iki kez gelebilir — SessionRetryClient).
- [x] Giriş reddi: yanlış e-posta/şifre aynı hata (`invalid_credentials`);
      `email_confirmed_at` boş → `email_not_confirmed`; `banned_until`
      gelecekte ya da `deleted_at` dolu → yanlış şifreyle aynı. (Pasif hesap,
      rol ve marka kontrolü uygulamada `get_session_data` ile kalır.)
- [x] Kaba kuvvet koruması: IP + e-posta başına sınır.
- [x] `last_sign_in_at` güncellenir; oturum satırına user-agent ve IP.
- [x] Testler: doğru/yanlış şifre, Supabase'ten gelmiş bir bcrypt hash'iyle
      giriş, refresh dönüşü ve yeniden kullanım, global/local çıkış,
      süresi dolmuş token → 401 ve RPC kapısının bunu `JWT expired`
      benzeri kodla dönmesi (SessionRetryClient bunu bekliyor).

## Kapsam dışı
Şifre sıfırlama, kayıt, davet, e-posta (S06). Yönetici işlemleri (S09).

## Kabul kriterleri
- Seed'deki bir veli `POST /auth/token` ile giriş yapıp `/rpc/get_session_data`
  ve `/rpc/parent_get_athletes` çağırabiliyor (e2e).
- `docs/api/auth.md` yazıldı.
- lint/test/test:e2e geçiyor.

## Teslim notu
2026-11-23, orkestratörle (kullanıcıya sorulmadan; karar gerektiren konu çıkmadı).

**Yapılanlar**
- Uçlar `src/auth/auth.controller.ts`: `POST /auth/token?grant_type=password|refresh_token`,
  `POST /auth/logout` (`?scope=` ya da gövde), `GET`/`PUT /auth/user`. Sözleşme
  `docs/api/auth.md`.
- İş kuralları `src/auth/auth.service.ts`, SQL `src/auth/auth.repository.ts`,
  `User` JSON'u `src/auth/user.mapper.ts`, hata kodları `src/auth/auth.errors.ts`.
- bcrypt `src/auth/password/password-hasher.ts` (bcryptjs 3, saf JS; yeni hash
  `$2a$10$`), kural `password-policy.ts` (≥ 6 karakter, ≤ 72 bayt).
- Token'lar `src/auth/token/tokens.ts` (access: HS256, GoTrue claim'leri;
  refresh: 32 bayt base64url, DB'de SHA-256).
- Kaba kuvvet `src/auth/rate-limit/login-rate-limiter.ts` (IP; IP+e-posta;
  e-posta — üç sabit pencere, bellekte).
- DB rolü `db/migrations/0005_auth_service_role.sql` (`auth_service`, yalnızca
  auth tabloları) + `DbContextService.asAuthService`.
- `JwtVerifier.verify(token, { ignoreExpiration })` (yalnızca logout).
- Env: `JWT_EXPIRY_SEC`, `JWT_ISSUER`, `AUTH_REFRESH_REUSE_INTERVAL_SEC`,
  `AUTH_LOGIN_IP_LIMIT`, `AUTH_LOGIN_FAILURE_LIMIT`, `AUTH_LOGIN_EMAIL_FAILURE_LIMIT`.

**Testler** — `test/auth.e2e-spec.ts` (33): kabul kriteri (veli giriş → 
`get_session_data`, `parent_get_athletes`), yanıt/claim şekli, oturum
satırı (IP, UA, hash'li token), GoTrue hash'iyle giriş (Go bcrypt test
vektörü), yanlış şifre = bilinmeyen e-posta, onaysız, yasaklı/silinmiş =
yanlış şifre, şifresiz hesap, zamanlama, rotasyon, yanıtı kaybolan
yenileme, pencere dışı yeniden kullanım → oturum iptali, eşzamanlı
yenileme, yasaklı/silinmiş yenileme, local/global/others çıkış, süresi
geçmiş token'la çıkış, `/auth/user` hataları, süresi geçmiş token → RPC 401
`PGRST303 JWT expired` → yenile → geçer, şifre değişimi (diğer oturumlar
kapanır, pgcrypto yeni hash'i okur), metadata birleştirme/korunan anahtar,
üç hız sınırı (429 + Retry-After, bilinmeyen e-posta da). Birim:
`password-hasher.spec.ts`, `login-rate-limiter.spec.ts`, `tokens.spec.ts`.
`test/schema.e2e-spec.ts`: `auth_service`'in yetkileri sabitlendi.
İki negatif test mutasyonla doğrulandı (kural kaldırılınca düşüyorlar).

**Bilinen eksikler / sonraki oturumlara**
- Hız sınırı sayaçları bellekte (tek süreç; yeniden başlatınca sıfırlanır) — S16.
- Access token durumsuz: çıkıştan sonra `/rpc/*` en çok 1 saat daha kabul eder
  (Supabase ile aynı); `/auth/user` oturuma bakar.
- Refresh için ayrı IP sınırı yok (token 256 bit; genel 600/dk yeter).
- `auth.audit_log_entries` yazılmıyor (tablo yok; 5651 kararı S12/S16).
