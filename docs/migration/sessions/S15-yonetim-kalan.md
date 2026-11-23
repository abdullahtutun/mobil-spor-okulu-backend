# S15 — Yönetim uygulaması: okumalar, storage, fonksiyonlar, realtime, web ve site

**Repo:** yönetim (dal `migrate/own-backend`), site (`../mobil_spor_okulu_site`,
aynı adlı dal), veli (yalnızca aydınlatma metni) · **Bağımlı:** S07–S11, S14

## Amaç
Yönetim uygulamasında Supabase'e kalan son bağları koparmak ve web
bundle'larını, tanıtım sitesini ve aydınlatma metnini yeni backend'e
hazırlamak.

## Okunacaklar
- `docs/migration/read-mapping.md`, `docs/api/{storage,functions}.md`,
  S11 teslim notu
- Y `AGENTS.md` → web build, "Legal"/aydınlatma, brands
- Y `tool/build_web.sh`, `lib/main_public_pre_registration.dart`
- Site `AGENTS.md`/README, `src/config/site.ts`, `src/infrastructure/lead/`

## Yapılacaklar
- [ ] `.from()` okumaları → `read-mapping.md`'deki fonksiyonlar
      (`paged_query.dart` yeni sayfalama şekline).
- [ ] Storage: sporcu fotoğrafı yükleme/okuma, okul logosu (public URL
      biçimi S08'deki gibi). S08: storage-api'yle aynı yollar, kök
      `<API>/storage` — `storage_client` paketi kalabilir
      (`StorageClient('<API>/storage', …)`); `getPublicUrl` yeni kökle doğru
      adresi üretir. Hata gövdesi aynı (`StorageException`); token hatası
      401 `PGRST303` (SessionRetryClient'ın yol kontrolü `/storage/v1/` →
      `/storage/` olmalı). Web'de logo `Image.network` ile çekiliyorsa
      kökenin `CORS_ORIGINS`'te olması gerek.
- [ ] `functions.invoke` çağrıları → `/functions/<ad>` (S09, S10).
      S10: `submit-pre-registration` başlık istemez (anon anahtarı
      gerekmez); aktarım iki fonksiyonu `Authorization: Bearer` ister.
      Form paketinin kökeni `CORS_ORIGINS`'te olmalı (Edge'de `*` idi).
- [ ] Realtime: gelen kutusu S11 protokolüyle.
- [ ] Web: üç bundle (`main`, `online-kayit`, `sifre-olusturma`) yeni API
      adresiyle; CORS kökenleri backend `.env.example`'a.
- [ ] `supabase_flutter` kalkar; Y `AGENTS.md` güncellenir (Supabase'ten söz
      eden bölümler; migration'ların artık backend reposunda olduğu).
- [ ] Site: `site-lead` adresi yeni backend'e (`<API>/functions/site-lead`,
      gövde ve yanıt aynı — `docs/api/functions.md`); sitenin kendi
      testleri/build'i. CORS backend'de `SITE_ALLOWED_ORIGINS`.
- [ ] Aydınlatma metni: Supabase/yurt dışı aktarım anlatımı yeni barındırma
      bilgisine göre güncellenir (`assets/legal/privacy_policy_tr.md`),
      `PrivacyPolicy.version` artırılır, metin veli uygulamasına birebir
      kopyalanır ve oradaki sürüm de artırılır (iki uygulamanın kuralı).
      Yeni metni kullanıcı onaylar.

## Kapsam dışı
Mağaza/web yayını (S17).

## Kabul kriterleri
- Yönetim reposunda `grep -r supabase lib` boş (gerekçeli istisnalar hariç).
- Y ve V'de `flutter analyze`, `flutter test`; sitede build geçiyor.
- Yerel backend ile ana akışlar (sporcu kaydı + fotoğraf, yoklama, aidat,
  duyuru → veli uygulamasında canlı görünmesi, online ön kayıt → aktarım)
  denendi ve günlüğe yazıldı.

## Teslim notu
_(oturum sonunda doldurulur)_
