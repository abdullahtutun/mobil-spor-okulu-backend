# S06 — Şifre sıfırlama, kayıt, davet ve e-posta

**Repo:** backend (yönetim reposu okunur) · **Bağımlı:** S05

## Amaç
Kodla yapılan bütün auth akışları ve marka başına e-posta gönderimi.
Velinin ve okulun gördüğü e-postalar bugünküyle aynı.

## Okunacaklar
- `INVENTORY.md` → 4 (`send-email`), 5
- Y `supabase/functions/send-email/` (tamamı), `_shared/brand.ts`,
  `supabase/templates/` (`recovery`, `invite`, `confirmation`,
  `subjects.json`, README)
- Y `features/auth/data/source/{forgot_password,signup,otp_verify}/`,
  `features/set_password/`, `lib/main_set_password.dart`; V
  `features/auth/data/source/forgot_password/`
- Y `AGENTS.md` → "Brands", şifre sıfırlama bölümü

## Yapılacaklar
- **S05'ten:** oturum açan yanıt `AuthService` içinde (`signInWithPassword` →
  oturum + refresh + `respond`); verify uçları aynısını kullanmalı. Auth
  tablolarına `DbContextService.asAuthService` (rol `auth_service`) ile;
  ek yetkiler (users/identities insert, token sütunları) yeni migration +
  `test/schema.e2e-spec.ts`'teki yetki listesi. Şifre `PasswordHasher.hash`
  + `passwordPolicyError`; hız sınırı için `LoginRateLimiter` örnek.
- [x] `src/mail/`: nodemailer, marka başına transport (`SMTP_HOST`,
      `SMTP_PORT`, `SMTP_USER_*`, `SMTP_PASS_*`); bir markanın kutusu yoksa
      gönderme ve hata ver (bugünkü kural). Şablonlar ve konu satırları
      yönetim reposundan taşınır; içerik üretimi `email_content.ts`'ten.
      Testte sahte transport.
- [x] `auth.one_time_tokens` (ya da `recovery_token`/`confirmation_token`
      sütunları — hangisi seçildiyse gerekçesiyle): kod hash'li, süreli,
      deneme sayısı sınırlı.
- [x] `POST /auth/recover` `{ email }` — her zaman 200 (hesap var mı
      belli olmaz); 6 haneli kod e-postası.
- [x] `POST /auth/verify` `{ type: recovery | signup, email, token }` ve
      `{ type: invite, token_hash }` → oturum (S05 yanıtı).
- [x] `POST /auth/signup` `{ email, password, data }` → onaysız kullanıcı +
      kod e-postası; `POST /auth/resend` `{ type: signup, email }`. Sihirbazın
      davranışı Supabase'teki proje ayarlarıyla aynı olmalı (salt okunur
      kontrol et).
- [x] `AuthAdminService` (yalnızca sunucu içi): `inviteUser(email, metadata,
      brand)` — kullanıcı + davet token'ı + davet e-postası (bağlantı
      `SchoolBrand.webOrigin` + `/sifre-olusturma/` + bugünkü sorgu
      parametreleri); `updateUser`, `banUser`, `deleteUser`. S09 ve S10
      bunu kullanır.
- [x] Hız sınırları: e-posta ve IP başına.
- [x] Testler: kodla şifre sıfırlama uçtan uca (sahte transport'tan kodu
      oku), yanlış/süresi dolmuş kod, kayıt + doğrulama + yeniden gönderme,
      davet bağlantısıyla şifre belirleme, iki markanın doğru gönderenden
      gitmesi.
- [x] `docs/api/auth.md`'ye bu uçlar.

## Kapsam dışı
Hangi ekranın ne zaman davet gönderdiği (S09, S10).

## Kabul kriterleri
- E-posta HTML'leri bugünkülerle aynı içerikte (şablon dosyaları birebir
  kopya; farklar gerekçeli).
- lint/test/test:e2e geçiyor.

## Teslim notu
2026-11-23, orkestratörle (kullanıcıya sorulmadan; plan kararı değişmedi).

**Yapılanlar**
- E-posta `src/mail/`: `MailService` (nodemailer 7, marka başına transport,
  `SMTP_HOST`/`SMTP_PORT`/`SMTP_USER_*`/`SMTP_PASS_*`; kutusu olmayan marka →
  `MailboxNotConfiguredError`, öbür markaya düşmez), `email-content.ts` ve
  `brand-logos.ts` yönetim `send-email` hook'unun birebir kopyası, `brand.ts`
  (`_shared/brand.ts`'in tablosu). Testte `MAIL_TRANSPORT_FACTORY` →
  `test/support/fake-mail.ts`.
- Uçlar `src/auth/flows/auth-flows.controller.ts` + `auth-flows.service.ts` +
  `auth-flows.repository.ts`: `POST /auth/recover`, `/auth/signup`,
  `/auth/resend` (`signup`), `/auth/verify` (`recovery|signup` + e-posta + kod;
  `invite` + `token_hash`). Sözleşme `docs/api/auth.md` → "Kodlu akışlar".
- Sunucu içi `src/auth/admin/auth-admin.service.ts`: `inviteUser`,
  `createUser`, `updateUserById`, `banUser`, `deleteUser`.
- Ortak oturum açma `src/auth/session/session-opener.ts` (S05'in
  `signInWithPassword`/`respond`'u buraya çıktı); HTTP yardımcıları
  `src/auth/auth.http.ts`; kodlar `src/auth/otp/otp-codes.ts`; sınırlar
  `src/auth/rate-limit/email-rate-limiter.ts` (+ ortak
  `fixed-window-counter.ts`).
- Migration `db/migrations/0006_auth_flows.sql`: `auth.otp_attempts` +
  `auth_service` yetkileri (users insert/delete + token sütunları,
  identities insert/update, one_time_tokens).
- `ApiException.code` getter'ı (sunucu içi çağıranlar için).

**Saklama kararı** — GoTrue'nun yerleri (`auth.users.recovery_token` /
`confirmation_token` + `*_sent_at`, ayrıca `auth.one_time_tokens` satırı),
ama değer HMAC-SHA256(JWT_SECRET'tan HKDF, `tür:kullanıcı:kod`) — GoTrue'nun
tuzsuz sha224(e-posta+kod)'u sızıntıda 10^6 denemeyle çözülürdü. Davet:
32 baytlık token bağlantıda, SHA-256'sı DB'de. Deneme sayacı ayrı tablo
(`auth.otp_attempts`): canlıyla bire bir tutulan auth tablolarına sütun
eklenmedi (S12 tablo tablo kopyalar).

**Testler** — `test/auth-flows.e2e-spec.ts` (29): sıfırlama uçtan uca (kod
sahte kutudan → verify → `PUT /auth/user` → yeni şifreyle giriş), DB'de düz
kod yok, bilinmeyen adres aynı yanıt/e-posta yok, yanlış/geçersiz biçimli
kod, kullanılmış kod, süresi dolmuş kod, 5 yanlıştan sonra doğru kod da
reddedilir, yeni kod eskisini geçersiz kılar, kod başka hesapta/akışta
geçmez, yasaklı hesap, iki markanın doğru gönderen/konu/logo; kayıt uçtan
uca (onaysız giriş reddi, kurucu profili, doğrulama, kodun tekrar
kullanılamaması), resend, var olan onaylı adreste aynı şekilli sahte yanıt
(e-posta yok, hesap değişmez), onaysız adrese yeniden kayıt, korunan
metadata/zayıf şifre; davet uçtan uca (mobil.devadim.com bağlantısı →
verify → şifre → çıkış → giriş, ikinci kullanım reddi), public davet
yonetim.mobilsporokulu.com, süresi dolmuş/uydurma/DB hash'iyle bağlantı
reddi, yeniden davet, `email_exists`, eski biçimli (Supabase) davet,
davetli adrese kayıt dokunmaz, SMTP reddinde kullanıcı silinir, admin
create/update/ban/delete; ayrı uygulamada hız sınırları (adres başına
60 sn — bilinen ve bilinmeyen adreste aynı 429 —, IP başına gönderim,
IP başına doğrulama) ve kutusu olmayan marka. Birim: `email-content.spec.ts`
(yönetimdeki testin aynısı), `brand.spec.ts`, `mail.service.spec.ts`
(jsonTransport ile gerçek nodemailer mesajı), `otp-codes.spec.ts`,
`email-rate-limiter.spec.ts`. `test/schema.e2e-spec.ts` yetki listesi
güncellendi.
- Mutasyonla doğrulanan negatif testler: deneme sınırı kaldırılınca
  "5 yanlış denemeden sonra…" düştü; gönderim sınırı yalnızca var olan
  hesapta sayılınca "bilinen ve bilinmeyen adreste aynı 429" ve IP testi
  düştü. İkisi de geri alındı.
- E-posta içeriği: yönetimdeki `email_content.ts` ile bizim kopyamız
  `node --experimental-strip-types` ile 28 bileşimde (2 marka × 7 tür × 2 ad)
  karşılaştırıldı — fark yok; logo base64'leri aynı.

**Bilinen eksikler / sonraki oturumlara**
- Supabase'in auth ayarları (OTP süresi, onay zorunluluğu, gönderim
  sınırları) SQL ile okunamıyor. Değerler e-posta metinlerinden ("Kod 10
  dakika", "Bağlantı 24 saat"), istemcinin yorumundan ("60 sn'de bir") ve
  akıştan (kayıttan sonra kod ekranı → onay zorunlu) alındı; canlıda 7
  kullanıcının hepsi onaylı, `one_time_tokens`'ta yalnızca `recovery_token`.
- Sınır sayaçları bellekte (S16).
- `amr` her akışta `password`.
- Bilinen ve bilinmeyen adreste yanıt süresi birkaç ms farklı olabilir (DB
  yazımı); SMTP süresi yanıta girmez.
- Şablon dosyaları (`supabase/templates/`) taşınmadı: hook açık olduğu için
  kullanılmıyorlar, bizde Supabase SMTP yedeği yok.
