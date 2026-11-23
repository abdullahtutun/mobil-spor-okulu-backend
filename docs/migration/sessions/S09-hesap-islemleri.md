# S09 — Hesap işlemleri (eski Edge Function'lar)

**Repo:** backend (yönetim reposu okunur) · **Bağımlı:** S06

## Amaç
`create-user`, `update-user`, `create-parent`, `update-parent`,
`delete-account` fonksiyonlarını aynı istek/yanıt gövdeleriyle Nest'e
taşımak. Dart tarafında yalnızca adres değişmeli.

## Okunacaklar
- Y `supabase/functions/{create-user,update-user,create-parent,update-parent,delete-account}/`
  ve `_shared/`
- Y `features/registration/data/source/{users,coaches,parents}/`,
  `features/account_deletion/`; V `features/account_deletion/`
- Y `AGENTS.md` → "Account deletion", "Brands", pasif hesaplar
- S06'nın `AuthAdminService`'i (`src/auth/admin/auth-admin.service.ts`;
  metotlar ve hatalar `docs/api/auth.md` → "AuthAdminService"). Okulun
  markasını okuyan `schoolBrand` karşılığı S09'da yazılır (okunamazsa hata).

## Yapılacaklar
- [x] `POST /functions/<ad>` (adlar aynı; yeni yol `docs/api/functions.md`'de).
      Gövde, yanıt, hata `reason` değerleri ve HTTP kodları bugünküyle aynı.
- [x] Yetki: bugün fonksiyonun yaptığı kontrol aynen (çağıranın rolü/okulu,
      çoğunlukla bir SQL RPC'si ile); `service_role` gereken SQL çağrıları
      `DbContextService.run({ role: 'service_role' })` ile.
- [x] Hesap açma/düzenleme: `AuthAdminService` ile kullanıcı + davet
      e-postası (marka `schools.brand` → `user_metadata.brand`), e-posta
      değişikliği, aktif/pasif.
- [x] `delete-account`: şifre doğrulama (`wrong_password`), `delete_own_account`,
      kullanıcının bütün oturumlarını iptal.
- [x] Testler: her fonksiyon için başarı + yetkisiz çağıran + doğrulama
      hatası; hesap silindikten sonra refresh token'ın reddedilmesi.

## Kapsam dışı
Ön kayıt fonksiyonları (S10), push (S11).

## Kabul kriterleri
- Her fonksiyonun Dart tarafında kullanılan yanıt alanları testte doğrulanmış.
- lint/test/test:e2e geçiyor.

## Teslim notu
2026-11-23, orkestratörle (kullanıcıya sorulmadan; plan kararı değişmedi,
migration yok).

**Yapılanlar**
- `src/accounts/`: `FunctionsController` (`POST /functions/{create-user,
  update-user,create-parent,update-parent,delete-account}`, `delete-account`
  için POST dışı 405), `StaffAccountsService`, `ParentAccountsService`,
  `AccountDeletionService`, `AccountsRepository` (SQL), `CallerResolver`
  (token → `/auth/user` kuralıyla çağıran), `accounts.schemas.ts` (zod, yalnızca
  tip), `function-response.ts` (Edge gövdeleri + `FunctionsExceptionFilter`).
  Sözleşme `docs/api/functions.md`.
- `AuthService.verifyPassword` (oturum açmadan şifre; girişin kaba kuvvet
  sayaçları) ve `AuthModule` artık `AuthService`'i dışa veriyor.
- Denetim sırası Edge Function'larla bire bir (doğrulama → auth → yazım;
  veli: yetki/okul/şube/`can_manage_parent` → davet → yazım → en son eski
  hesabın silinmesi; hesap silme: token → şifre var mı → validate_only →
  şifre → `delete_own_account`). SQL çağrıları çağıranın rolüyle
  (`withUser`), `schoolBrand` ve `delete_own_account` service_role ile.

**Testler** — `test/accounts.e2e-spec.ts` (61): beş uçta başlıksız 401,
süresi geçmiş token 401 `PGRST303`, anon anahtarı ve çıkış yapılmış oturum →
fonksiyonun kendi hatası. create-user: genel müdür/şube müdürü başarı
(onaylı hesap, `created_by`, profil, şube, girişi), hiyerarşi (şube müdürü →
genel müdür), şube kapsamı, users.manage yok (antrenör, muhasebeci), başka
okul, SQL doğrulaması, rolün sunmadığı yetki, sahip olmadığın yetki
(finance'ı alınmış genel müdür → muhasebeci), şifresiz, zayıf şifre, kayıtlı
e-posta, tip hatası, yazım düşünce auth kullanıcısının silinmesi — her
retten sonra auth kullanıcısı yok. update-user: başarı (e-posta + şifre),
**şube müdürü genel müdürün şifre/e-postasını değiştiremez (eski şifre hâlâ
geçer)**, başka şube, kendi rol/durum, antrenör, id yok/hesap yok, veli
hedefi, `permissions` gönderilmezse yetkiler kalır. create-parent: Dev Adım
ve public davet alan adları, metadata `brand`, profil/bağlar; antrenör,
muhasebeci, okul uyuşmazlığı, şube yok, başka şube, veli çağıran → davet
gitmez ve hesap açılmaz; başka okulun sporcusu → geri alma; kayıtlı adres.
update-parent: aynı e-posta, şube müdürü başka şubenin velisi (davet yok),
hedef genel müdür (hesabı yerinde), kapsam dışı şubeye taşıma, id/antrenör/
başka okul/şube yok, e-posta değişikliği başarısı (bağsız veli: eski auth
hesabı silinir, yeni davet + bağlar) ve bağlı velide canlının hatası.
delete-account: şifre yok/metin değil, yanlış şifre, son genel müdür (iki
metin, yanlış şifreyle bile önce bu), başarı + iki cihazın refresh'i
`refresh_token_not_found`, `/auth/user` `session_not_found`, giriş
`invalid_credentials`, mezar taşı, gövdedeki başka kimlik yok sayılır, aynı
token'la ikinci deneme 401; veli; 405; ayrı uygulamada hız sınırı (iki
yanlıştan sonra doğru şifre de 429 `rate_limited`, hesap silinmez).
- Mutasyonla doğrulandı: update-user'da şifre doğrulamadan önce
  değiştirilince 6 test düştü (genel müdür şifresi dahil);
  update-parent'ta `can_manage_parent` kaldırılınca 3 test düştü. İkisi geri
  alındı.

**Bilinen eksikler / farklar**
- **E-posta değişikliği düzeltildi (kullanıcı kararı, aynı gün):** eski
  hesabı silmek yerine aynı hesabın adresi değişir (`reset_parent_login_email`,
  migration 0008 = yönetim `20261123_parent_email_change.sql`), hesap davetli
  hâle döner, yeni adrese davet gider; backend'de hepsi tek transaction.
  Yönetim reposunda da düzeltildi (dağıtım kullanıcıda). Ayrıntı:
  PROGRESS.md → "S09 düzeltmesi".
- Bilinçli farklar: veli yazımları (profil + şube + sporcu) tek transaction
  (Edge'de ayrı istekler, biri düşerse öncekiler kalıyordu); gövde tip
  denetimi; okulsuz çağıran okul denetiminde de reddedilir; hesap silmede
  şifre denetimi oturum açmaz ve sayaç isteği yapanın IP'sine bağlı (Edge'de
  fonksiyonun IP'siydi); bozuk JSON gövdesi `PGRST102` (fonksiyon şekli değil).
- Hata metinlerinde Postgres/GoTrue metni geçer (Edge Function da
  `error.message`'ı veriyordu); beklenmeyen hatanın metni dışarı çıkmaz.
