# Auth API (`/auth/*`)

GoTrue'nun (Supabase Auth, `/auth/v1/*`) yerini alan uçlar. Gövdeler ve
yanıtlar GoTrue'ya yakın tutuldu; uygulamaların Dart tarafı (S13/S14) bunlara
göre yazılır. Hata gövdesi API'nin tek biçimi: `{ "code", "message" }`;
`code` GoTrue'nun `error_code` değeri (`invalid_credentials` …).

Kaynak: `src/auth/` (S05; S06: `src/auth/flows/`, `src/auth/admin/`,
`src/mail/`). Testler: `test/auth.e2e-spec.ts`, `test/auth-flows.e2e-spec.ts`,
`src/auth/**/*.spec.ts`, `src/mail/*.spec.ts`.

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

## Kodlu akışlar (S06)

Supabase'teki `resetPasswordForEmail` + `verifyOTP(recovery)`,
`signUp` + `verifyOTP(signup)` + `resend(signup)` ve
`verifyOTP(tokenHash, invite)` akışlarının karşılığı. Hiçbiri token istemez.
Ortak kurallar:

- **Hesap taraması kapalı.** `recover` ve `resend` hesap olsun olmasın
  200 `{}`; `signup` var olan adreste de aynı biçimde bir `user` döner
  (rastgele id, sahte bir kimlik dahil — Supabase'in boş `identities`'i
  hesabın varlığını söylüyordu). Gönderim sınırları adres var mı bakılmadan
  sayılır. E-posta yanıttan **sonra** gönderilir (SMTP süresi yanıta girmez);
  gönderim hatası yalnızca loglanır.
- **Her doğrulama reddi aynı:** 403 `otp_expired` ("Token has expired or is
  invalid") — yanlış, süresi dolmuş, kullanılmış, çok kez denenmiş kod;
  bilinmeyen adres; yasaklı hesap; uydurma ya da kullanılmış davet
  bağlantısı. Uygulamalar bu kodu bugün de tanıyor (`localizeAuthError`,
  `PasswordSetupLink`).
- **Kodlar hash'li saklanır:** `auth.users.recovery_token` /
  `confirmation_token` (+ `*_sent_at`) ve `auth.one_time_tokens` satırında
  HMAC-SHA256(JWT_SECRET'tan HKDF ile türetilmiş anahtar, `tür:kullanıcı:kod`).
  Davet bağlantısının token'ı 32 rastgele bayt; veritabanında SHA-256'sı.
- **Süreler:** kod `AUTH_OTP_EXPIRY_SEC` (600 sn — e-posta "10 dakika"
  diyor), davet `AUTH_INVITE_EXPIRY_SEC` (86400 sn — e-posta "24 saat").
  Kod başına `AUTH_OTP_MAX_ATTEMPTS` (5) yanlış denemeden sonra kod silinir
  (sayaç `auth.otp_attempts`'ta, API yeniden başlasa da kalır); yeni kod
  istenince eskisi geçersiz, sayaç sıfır.
- E-posta adresi `trim` + küçük harf; biçim hatalıysa 400
  `email_address_invalid`.

### Sınırlar

Bellekte, tek süreç; hepsi 429 + `Retry-After`.

| Sayaç | Pencere | Varsayılan | Env | `code` |
|---|---|---|---|---|
| Aynı adrese gönderim (recover/signup/resend ortak) | — | 60 sn'de 1 | `AUTH_EMAIL_SEND_INTERVAL_SEC` | `over_email_send_rate_limit` |
| Adres başına gönderim | 1 saat | 5 | `AUTH_EMAIL_HOURLY_LIMIT` | `over_email_send_rate_limit` |
| IP başına gönderim | 1 saat | 30 | `AUTH_EMAIL_IP_HOURLY_LIMIT` | `over_email_send_rate_limit` |
| IP başına doğrulama | 5 dk | 30 | `AUTH_VERIFY_IP_LIMIT` | `over_request_rate_limit` |

### `POST /auth/recover`

```json
{ "email": "veli@ornek.com" }
```

200 `{}`. Hesap varsa ve yasaklı/silinmiş değilse 6 haneli kod e-postası
(`recovery`, markanın metni ve kutusu). Uygulama sonra `POST /auth/verify`
(`type: recovery`) ile oturum alır ve `PUT /auth/user` ile şifreyi yazar
(bugünkü iki adım; ikisi tek data-source çağrısında kalır).

### `POST /auth/signup`

```json
{ "email": "…", "password": "…",
  "data": { "full_name": "…", "phone_number": "…", "is_creator": "true",
            "privacy_notice_version": "…" } }
```

200, gövde `user` JSON'u (oturum yok; onay gerekli — GoTrue'nun
`email_confirmations` açık davranışı). `user_metadata` = `data` + `sub`,
`email`, `email_verified: false`, `phone_verified: false` (canlıdaki
kayıtlar gibi). `auth.users` insert'i `handle_new_user`'ı tetikler
(`is_creator` → genel müdür profili). Kayıt kodu e-postası (`signup`) —
yeni kayıt okulsuz olduğu için marka `public`.

- Onaysız ve davetsiz var olan adres → şifre ve `data` yenilenir, yeni kod
  (son kayıt kazanır, önceki kod geçersiz).
- Onaylı, davetle açılmış ya da yasaklı adres → dokunulmaz, e-posta gitmez;
  yanıt yeni kayıtla aynı şekilde (rastgele id).
- Şifre kuralı `PUT /auth/user` ile aynı → 422 `weak_password`.
- `data`'da sunucunun anahtarları (`brand`, `created_by`,
  `created_by_manager`, `sub`, `email`, `email_verified`, `phone_verified`)
  → 422 `validation_failed`. Supabase bunları kabul ediyordu; `brand`
  e-postanın markasını, `created_by` `save_staff_profile`'ın doğrulamasını
  belirler.
- Onaysız hesapla parola girişi → 400 `email_not_confirmed` (S05).

### `POST /auth/resend`

```json
{ "type": "signup", "email": "…" }
```

200 `{}`. Onaysız, davetsiz hesaba yeni kayıt kodu; aksi hâlde hiçbir şey.
Başka `type` → 400 `validation_failed`.

### `POST /auth/verify`

```json
{ "type": "recovery", "email": "…", "token": "123456" }
{ "type": "signup",   "email": "…", "token": "123456" }
{ "type": "invite",   "token_hash": "<bağlantıdaki token_hash>" }
```

200, yanıt `POST /auth/token`'ınkiyle aynı (yeni oturum, access + refresh
token). Başarıda kod/bağlantı silinir, `email_confirmed_at` dolar
(`email_verified: true`), `last_sign_in_at` güncellenir. Ret: 403
`otp_expired` (yukarıda); sınır: 429.

- `invite`: şifre oluşturma sayfası (`main_set_password.dart`) bağlantıdaki
  `token_hash`'i gönderir, sonra `PUT /auth/user` ile şifreyi yazar ve
  `POST /auth/logout?scope=local` ile oturumu kapatır — bugünkü akış.
  Supabase'in gönderdiği eski biçimli bağlantılar (56 karakter sha224 hex)
  geçiş gecesi yolda olanlar için kabul edilir (S17'den 24 saat sonra
  `LEGACY_INVITE_HASH` kaldırılabilir).
- `access_token`'daki `amr` her akışta `password` (GoTrue `otp`/`invite`
  yazar; SQL ve uygulamalar `amr` okumuyor).

## E-posta (`src/mail/`)

Yönetim reposundaki `send-email` hook'unun karşılığı. Supabase'te hook açık
olduğu için bugünkü e-postalar `supabase/templates/*.html`'den değil
hook'un `email_content.ts`'inden çıkıyor; `src/mail/email-content.ts` onun
birebir kopyası (28 tür×marka×ad bileşiminde çıktısı karşılaştırıldı, fark
yok), logolar `brand-logos.ts` (aynı base64). Şablon dosyaları (hook
kapalıyken Supabase'in yedeği) taşınmadı: bizde yedek SMTP yolu yok.

- Marka `user_metadata.brand`'den (`sync_user_brand` yazar; yoksa `public`).
  Davette marka çağıranın verdiği okul markası, metadata'ya da yazılır.
- Gönderen: `<marka adı> <SMTP_USER_<MARKA>>`; adres yalnızca env'de.
  Bir markanın kutusu tanımlı değilse o markanın e-postası **gitmez**
  (`MailboxNotConfiguredError`; açılışta uyarı loglanır) — öbür markanın
  adresine düşmek yok. Kullanıcı tetiklediği akışta (recover/signup/resend)
  hata loglanır, yanıt değişmez; davette hata fırlar ve hiçbir şey yazılmaz.
- `SMTP_HOST`/`SMTP_PORT` (varsayılan Hostinger 465, SMTPS). Bağlantı
  zaman aşımları 10/10/20 sn. Supabase'teki 4 sn'lik hook bütçesi
  (`deadline.ts`) gerekmedi: e-posta yanıttan sonra gider.
- Testler gerçek SMTP'ye gitmez: `MAIL_TRANSPORT_FACTORY`
  (`test/support/fake-mail.ts` → `FakeMailbox`).

## `AuthAdminService` (yalnızca sunucu içi)

GoTrue'nun `auth.admin.*` karşılığı; HTTP ucu **yok**. S09 (hesap işlemleri)
ve S10 (ön kayıt aktarımı) yetkiyi SQL'e sorduktan sonra çağırır.

| Metot | GoTrue | Davranış |
|---|---|---|
| `inviteUser(email, metadata, brand)` | `inviteUserByEmail(email, parentInviteOptions(brand, name))` | Onaysız kullanıcı (`invited_at`, şifresiz) + kimlik + davet bağlantısı `passwordSetupUrl(brand)?token_hash=…&type=invite`; `metadata` + `brand` → `user_metadata`. Onaylı adres → `email_exists` (422). Onaysız var olan → yeniden davet (eski bağlantı geçersiz). Kutusu yoksa hiçbir şey yazmadan `MailboxNotConfiguredError`; SMTP reddederse yeni açılan kullanıcı silinir ve hata fırlar. |
| `createUser({ email, password, emailConfirm, userMetadata })` | `admin.createUser` | Şifre kuralı; var olan adres → `email_exists`. |
| `updateUserById(id, { email?, password? })` | `admin.updateUserById` | Yeni e-posta onaylı sayılır, kimlik de güncellenir; şifre değişince bütün oturumlar kapanır; çakışan adres → `email_exists`; yok → `user_not_found`. |
| `banUser(id, until \| null)` | `ban_duration` | `banned_until`; yasakta oturumlar kapanır. |
| `deleteUser(id)` | `admin.deleteUser` | Kalıcı silme (kimlik, oturum, `profiles` cascade). Yalnızca geri alma adımı için; hesap silme (KVKK) `delete_own_account`'tur (S09). |

Hatalar `ApiException` (`.code`: `email_exists`, `user_not_found`,
`weak_password`, `email_address_invalid`).

## Veritabanı

Auth modülü auth tablolarına `auth_service` rolüyle erişir
(`db/migrations/0005_auth_service_role.sql`; `DbContextService.asAuthService`).
Bu rol yalnızca `auth.users` (okuma, ekleme, silme; `last_sign_in_at`,
`updated_at`, `encrypted_password`, `raw_user_meta_data`, `email`,
`email_confirmed_at`, `invited_at`, `confirmation_token`/`_sent_at`,
`recovery_token`/`_sent_at`, `banned_until` güncelleme), `auth.identities`
(okuma, ekleme, güncelleme), `auth.sessions`, `auth.refresh_tokens`,
`auth.one_time_tokens` ve `auth.otp_attempts` (tam) yetkisine sahip
(0005 + `0006_auth_flows.sql`); public şemasına erişemez, RLS'i aşamaz.
`auth.users` insert'i `handle_new_user`'ı tetikler; o SECURITY DEFINER
olduğu için profil satırını postgres olarak açar. Yetki listesi
`test/schema.e2e-spec.ts`'te sabit.

## Sonraki oturumlar

- S09/S10: `AuthAdminService` (yukarıda); okulun markası `schools.brand`'den
  (S09'da `schoolBrand` karşılığı yazılır).
- S13/S14: istemci `POST <api>/auth/recover|signup|resend|verify`; hata
  `code`'ları GoTrue'nunkilerle aynı adlarda.
