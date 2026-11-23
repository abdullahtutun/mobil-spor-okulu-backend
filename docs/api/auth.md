# Auth API (`/auth/*`)

GoTrue'nun (Supabase Auth, `/auth/v1/*`) yerini alan uçlar. Gövdeler ve
yanıtlar GoTrue'ya yakın tutuldu; uygulamaların Dart tarafı (S13/S14) bunlara
göre yazılır. Hata gövdesi API'nin tek biçimi: `{ "code", "message" }`;
`code` GoTrue'nun `error_code` değeri (`invalid_credentials` …).

Kaynak: `src/auth/` (S05). Testler: `test/auth.e2e-spec.ts`,
`src/auth/**/*.spec.ts`.

## Token'lar

**Access token** — JWT, HS256, `JWT_SECRET` ile; süre `JWT_EXPIRY_SEC`
(3600 sn, Supabase ile aynı). Claim'ler GoTrue'nunkiyle aynı adlarda:

```json
{
  "iss": "<JWT_ISSUER>", "sub": "<user id>", "aud": "authenticated",
  "exp": 0, "iat": 0, "email": "…", "phone": "",
  "app_metadata": {}, "user_metadata": {},
  "role": "authenticated", "aal": "aal1",
  "amr": [{ "method": "password", "timestamp": <oturumun açıldığı an> }],
  "session_id": "<auth.sessions.id>", "is_anonymous": false
}
```

SQL `auth.uid()`, `auth.jwt()` ve RLS bunu Supabase'in token'ı gibi okur.
Access token **durumsuzdur**: `/rpc/*` oturumun hâlâ açık olup olmadığına
bakmaz (Supabase/PostgREST gibi) — çıkıştan sonra en çok `exp`'e kadar
geçerli kalır. `/auth/user` ise oturuma bakar.

**Refresh token** — 32 rastgele bayt, base64url (43 karakter). Veritabanında
yalnızca SHA-256'sı (`auth.refresh_tokens.token`, `parent`). Her kullanımda
döner (rotasyon).

## `POST /auth/token?grant_type=password`

```json
{ "email": "veli@ornek.com", "password": "…" }
```

E-posta `trim` + küçük harfle aranır (GoTrue gibi). Başarılı yanıt (200):

```json
{
  "access_token": "…", "token_type": "bearer",
  "expires_in": 3600, "expires_at": 1767225600,
  "refresh_token": "…",
  "user": { "id": "…", "aud": "authenticated", "role": "authenticated",
            "email": "…", "email_confirmed_at": "…", "phone": "",
            "confirmed_at": "…", "last_sign_in_at": "…",
            "app_metadata": {}, "user_metadata": {}, "identities": [ … ],
            "created_at": "…", "updated_at": "…", "is_anonymous": false }
}
```

`user`: GoTrue'nun `User` JSON'u; boş tarih alanları yanıtta yoktur.
Girişte `auth.users.last_sign_in_at` güncellenir, `auth.sessions` satırına
IP (`trust proxy`'ye göre) ve user-agent yazılır.

| Durum | HTTP | `code` |
|---|---|---|
| Yanlış şifre, bilinmeyen e-posta, şifresiz hesap | 400 | `invalid_credentials` (mesaj: `Invalid login credentials`) |
| `banned_until` gelecekte ya da `deleted_at` dolu (doğru şifreyle de) | 400 | `invalid_credentials` — aynı gövde |
| Şifre doğru, `email_confirmed_at` boş | 400 | `email_not_confirmed` |
| Eksik/hatalı alan | 400 | `validation_failed` |
| Kaba kuvvet sınırı (aşağıda) | 429 | `over_request_rate_limit` + `Retry-After` |

Şifre doğrulama bcrypt (`$2a$`/`$2b$`/`$2y$`); canlıdaki hash'ler `$2a$`
(GoTrue maliyet 10, elle eklenmiş demo hesapları maliyet 6) — kimse şifre
sıfırlamaz. Bilinmeyen e-postada da maliyet-10 bir karşılaştırma yapılır,
yanıt süresi hesabın varlığını söylemez. Pasif hesap, rol ve marka
kontrolü burada **yoktur**; uygulamalarda `get_session_data` ile kalır
(yönetim AGENTS.md → "A brand's accounts…", "A passive account is closed").

### Kaba kuvvet koruması

Hesap var mı bakılmadan, bcrypt'ten önce uygulanır (bellekte, tek süreç):

| Sayaç | Pencere | Varsayılan | Env |
|---|---|---|---|
| IP başına deneme (doğrular dahil) | 5 dk | 30 | `AUTH_LOGIN_IP_LIMIT` |
| IP + e-posta başına yanlış şifre (doğru şifre sıfırlar) | 15 dk | 10 | `AUTH_LOGIN_FAILURE_LIMIT` |
| E-posta başına yanlış şifre, tüm IP'ler | 1 saat | 20 | `AUTH_LOGIN_EMAIL_FAILURE_LIMIT` |

Ayrıca tüm uçlarda S04'ün IP başına genel sınırı (600/dk).

## `POST /auth/token?grant_type=refresh_token`

```json
{ "refresh_token": "…" }
```

Yanıt parola girişiyle aynı (yeni access **ve** yeni refresh token). Kurallar:

- Geçerli token → iptal edilir, yerine yenisi (`parent` = eskinin hash'i).
- İptal edilmiş token ama oturumun geçerli token'ının **ebeveyni** → kabul
  (yanıtı ağda kaybolmuş yenileme; süre sınırı yok — cihaz saatlerce
  çevrimdışı kalabilir). GoTrue burada geçerli token'ı geri verir; biz
  token'ı hash'li tuttuğumuz için onu da döndürüp yenisini veririz.
- İptal edilmiş başka bir token, iptalinden `AUTH_REFRESH_REUSE_INTERVAL_SEC`
  (10 sn) içinde → kabul (eşzamanlı yenilemeler).
- Diğer her yeniden kullanım → çalınma şüphesi: **oturum silinir** (bütün
  token'larıyla), 400 `refresh_token_already_used`.
- Aynı oturumdaki eşzamanlı yenilemeler oturum satırının kilidinde sıraya girer.

| Durum | HTTP | `code` |
|---|---|---|
| Token yok / oturum kapanmış / kullanıcı silinmiş | 400 | `refresh_token_not_found` |
| Yeniden kullanım (yukarıda) | 400 | `refresh_token_already_used` |
| Kullanıcı yasaklı | 403 | `user_banned` |

Bilinmeyen `grant_type` → 400 `unsupported_grant_type`.

## `POST /auth/logout?scope=global|local|others`

`Authorization: Bearer <access token>`. Kapsam sorguda (supabase-dart böyle
gönderir) ya da gövdede `{ "scope": … }`; varsayılan `global`.

- `local`: yalnızca token'ın oturumu; `others`: bu oturum dışındakiler;
  `global`: kullanıcının bütün oturumları. Oturum silinince refresh
  token'ları da gider.
- **Süresi geçmiş ama imzası doğru** token kabul edilir (çıkış erişimi
  yalnızca azaltır). Zaten kapalı oturum → yine 204 (idempotent).
- 204, gövdesiz. Tokensız → 401 `no_authorization`; sahte imza → 401 `PGRST301`.

Push token'ı silmek (önce `delete_push_token`) istemcinin işi, bugünkü gibi.

## `GET /auth/user`

`Authorization: Bearer <access token>` → `user` JSON'u (200).

| Durum | HTTP | `code` |
|---|---|---|
| Tokensız ya da anon token | 401 | `no_authorization` |
| Süresi geçmiş | 401 | `PGRST303` (`JWT expired`) |
| İmza/biçim hatalı | 401 | `PGRST301` |
| Oturum kapanmış (çıkış, hesap silme) | 403 | `session_not_found` |
| Kullanıcı yok/silinmiş | 403 | `user_not_found` |
| Yasaklı | 403 | `user_banned` |

## `PUT /auth/user`

```json
{ "password": "yeni-sifre", "data": { "anahtar": "değer", "silinecek": null } }
```

- `password`: en az 6 karakter, en çok 72 bayt (Supabase'teki kural; rakam
  şartı yok) → aksi 422 `weak_password`; eskisiyle aynı → 422
  `same_password`. Yeni hash `$2a$10$` (GoTrue ve pgcrypto okur). Şifre
  değişince **bu oturum dışındaki** oturumlar kapanır.
- `data`: `user_metadata`'ya birleşir, `null` anahtarı siler. Sunucunun
  yazdığı anahtarlar değiştirilemez (422 `validation_failed`): `brand`,
  `created_by`, `is_creator`, `full_name`, `phone_number`,
  `privacy_notice_version`, `email_verified`, `phone_verified`, `sub`,
  `email` — SQL bunlara güvenir (`sync_user_brand`, `save_staff_profile`,
  `handle_new_user`). Supabase bunları istemciye açıktı; uygulamalar
  `data` göndermiyor.
- `email`/`phone` değişikliği yok (bilinmeyen alan → 400 `validation_failed`).
- Hatalar ve oturum kontrolü `GET /auth/user` ile aynı.

## RPC kapısıyla ilişkisi

`/rpc/*` süresi geçmiş token'a 401 `PGRST303` `JWT expired` döner;
`SessionRetryClient` bunu "yenile ve bir kez tekrar dene" diye okur
(e2e'de sınandı: yenilenmiş token'la aynı istek geçer).

## Veritabanı

Auth modülü auth tablolarına `auth_service` rolüyle erişir
(`db/migrations/0005_auth_service_role.sql`; `DbContextService.asAuthService`).
Bu rol yalnızca `auth.users` (okuma; `last_sign_in_at`, `updated_at`,
`encrypted_password`, `raw_user_meta_data` güncelleme), `auth.identities`
(okuma), `auth.sessions` ve `auth.refresh_tokens` (tam) yetkisine sahip;
public şemasına erişemez, RLS'i aşamaz. S06/S09 gerektikçe genişletir.

## Sonraki oturumlar

S06 buraya `/auth/recover`, `/auth/verify`, `/auth/signup`, `/auth/resend`
uçlarını ekler (oturum yanıtı yukarıdaki token yanıtıyla aynı).
