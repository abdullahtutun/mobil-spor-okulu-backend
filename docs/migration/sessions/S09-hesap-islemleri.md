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
- [ ] `POST /functions/<ad>` (adlar aynı; yeni yol `docs/api/functions.md`'de).
      Gövde, yanıt, hata `reason` değerleri ve HTTP kodları bugünküyle aynı.
- [ ] Yetki: bugün fonksiyonun yaptığı kontrol aynen (çağıranın rolü/okulu,
      çoğunlukla bir SQL RPC'si ile); `service_role` gereken SQL çağrıları
      `DbContextService.run({ role: 'service_role' })` ile.
- [ ] Hesap açma/düzenleme: `AuthAdminService` ile kullanıcı + davet
      e-postası (marka `schools.brand` → `user_metadata.brand`), e-posta
      değişikliği, aktif/pasif.
- [ ] `delete-account`: şifre doğrulama (`wrong_password`), `delete_own_account`,
      kullanıcının bütün oturumlarını iptal.
- [ ] Testler: her fonksiyon için başarı + yetkisiz çağıran + doğrulama
      hatası; hesap silindikten sonra refresh token'ın reddedilmesi.

## Kapsam dışı
Ön kayıt fonksiyonları (S10), push (S11).

## Kabul kriterleri
- Her fonksiyonun Dart tarafında kullanılan yanıt alanları testte doğrulanmış.
- lint/test/test:e2e geçiyor.

## Teslim notu
_(oturum sonunda doldurulur)_
