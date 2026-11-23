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
- [ ] `src/mail/`: nodemailer, marka başına transport (`SMTP_HOST`,
      `SMTP_PORT`, `SMTP_USER_*`, `SMTP_PASS_*`); bir markanın kutusu yoksa
      gönderme ve hata ver (bugünkü kural). Şablonlar ve konu satırları
      yönetim reposundan taşınır; içerik üretimi `email_content.ts`'ten.
      Testte sahte transport.
- [ ] `auth.one_time_tokens` (ya da `recovery_token`/`confirmation_token`
      sütunları — hangisi seçildiyse gerekçesiyle): kod hash'li, süreli,
      deneme sayısı sınırlı.
- [ ] `POST /auth/recover` `{ email }` — her zaman 200 (hesap var mı
      belli olmaz); 6 haneli kod e-postası.
- [ ] `POST /auth/verify` `{ type: recovery | signup, email, token }` ve
      `{ type: invite, token_hash }` → oturum (S05 yanıtı).
- [ ] `POST /auth/signup` `{ email, password, data }` → onaysız kullanıcı +
      kod e-postası; `POST /auth/resend` `{ type: signup, email }`. Sihirbazın
      davranışı Supabase'teki proje ayarlarıyla aynı olmalı (salt okunur
      kontrol et).
- [ ] `AuthAdminService` (yalnızca sunucu içi): `inviteUser(email, metadata,
      brand)` — kullanıcı + davet token'ı + davet e-postası (bağlantı
      `SchoolBrand.webOrigin` + `/sifre-olusturma/` + bugünkü sorgu
      parametreleri); `updateUser`, `banUser`, `deleteUser`. S09 ve S10
      bunu kullanır.
- [ ] Hız sınırları: e-posta ve IP başına.
- [ ] Testler: kodla şifre sıfırlama uçtan uca (sahte transport'tan kodu
      oku), yanlış/süresi dolmuş kod, kayıt + doğrulama + yeniden gönderme,
      davet bağlantısıyla şifre belirleme, iki markanın doğru gönderenden
      gitmesi.
- [ ] `docs/api/auth.md`'ye bu uçlar.

## Kapsam dışı
Hangi ekranın ne zaman davet gönderdiği (S09, S10).

## Kabul kriterleri
- E-posta HTML'leri bugünkülerle aynı içerikte (şablon dosyaları birebir
  kopya; farklar gerekçeli).
- lint/test/test:e2e geçiyor.

## Teslim notu
_(oturum sonunda doldurulur)_
