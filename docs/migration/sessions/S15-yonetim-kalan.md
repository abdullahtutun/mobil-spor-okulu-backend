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
- **S14'ten:** auth ve bütün `.rpc(` yeni backend'de (`lib/core/data/remote/api/`).
  Kalan Supabase bağları ve geçici olarak kullanılan supabase-dart türleri
  (`Session`, `User`, `AuthResponse`, `AuthApiException`,
  `AuthRetryableFetchException`, `PostgrestException`) S14 teslim notunda;
  paket çıkarken bunlar aynı adlarla yerel türlere geçer (veli S13'teki
  gibi). Şifre oluşturma sayfası S14'te taşındı. Data source'ların çoğu
  `(SupabaseClient, ApiClient)` alıyor — `.from()` taşınınca ilki düşer.
- **S11'den:** gelen kutusu realtime'ı `docs/api/realtime.md` (yönetim
  yalnızca INSERT'e bakar; `UPDATE` olayları yok sayılabilir). Push'un
  `data.params`'ı artık tür başına izin listesi (`class_id`, `date`,
  `count`, `days`, kimlikler) — `NotificationDestination`'ın okuduklarıyla
  aynı; `athlete_name` / `names` gelmez.
- [x] `.from()` okumaları → `read-mapping.md`'deki fonksiyonlar
      (`paged_query.dart` yeni sayfalama şekline).
- [x] Storage: sporcu fotoğrafı yükleme/okuma, okul logosu (public URL
      biçimi S08'deki gibi). S08: storage-api'yle aynı yollar, kök
      `<API>/storage` — `storage_client` paketi kalabilir
      (`StorageClient('<API>/storage', …)`); `getPublicUrl` yeni kökle doğru
      adresi üretir. Hata gövdesi aynı (`StorageException`); token hatası
      401 `PGRST303` (SessionRetryClient'ın yol kontrolü `/storage/v1/` →
      `/storage/` olmalı). Web'de logo `Image.network` ile çekiliyorsa
      kökenin `CORS_ORIGINS`'te olması gerek.
- [x] `functions.invoke` çağrıları → `/functions/<ad>` (S09, S10).
      S10: `submit-pre-registration` başlık istemez (anon anahtarı
      gerekmez); aktarım iki fonksiyonu `Authorization: Bearer` ister.
      Form paketinin kökeni `CORS_ORIGINS`'te olmalı (Edge'de `*` idi).
- [x] Realtime: gelen kutusu S11 protokolüyle.
- [x] Web: üç bundle (`main`, `online-kayit`, `sifre-olusturma`) yeni API
      adresiyle; CORS kökenleri backend `.env.example`'a.
- [x] `supabase_flutter` kalkar; Y `AGENTS.md` güncellenir (Supabase'ten söz
      eden bölümler; migration'ların artık backend reposunda olduğu).
- [x] Site: `site-lead` adresi yeni backend'e (`<API>/functions/site-lead`,
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
2026-11-23, **kısmen**: aydınlatma metni dışında her şey yapıldı. Yönetim
`migrate/own-backend` `d9ad2a0`, site `migrate/own-backend` `1c4cd4a`
(`main`'den). İki repoda da sonunda `main`'e dönüldü.

**Yönetim** (`../mobil_spor_okulu`):
- `supabase_flutter` `pubspec.yaml`'dan çıktı (yerine doğrudan
  `web_socket_channel`); `Supabase.initialize`, `supabaseClientProvider`,
  `constant.dart` (anon anahtarı) ve `baseURL` silindi. Data source'lar
  yalnızca `ApiClient` alıyor.
- `lib/core/data/remote/api/api_types.dart`: supabase-dart'ın adlarıyla yerel
  `Session`, `User`, `AuthResponse`, `UserResponse`, `AuthState`,
  `AuthChangeEvent`, `SignOutScope`, `AuthException`/`AuthApiException`/
  `AuthRetryableFetchException`, `PostgrestException`, `FunctionResponse`/
  `FunctionException`, `StorageException` (S14 kararı 2). Repository'lerin
  `on …` dalları, `isNetworkError`, `localizeAuthError`,
  `RpcEnvelope.fromEdge/fromFunctionException`, `mapDeleteAccountFailure`
  değişmedi.
- `ApiClient`: `read` (okuma fonksiyonu; ağ hatasında bir kez hemen tekrar —
  PostgREST'in GET `retryCount: 1`'inin karşılığı; zaman aşımı ve ret
  tekrarlanmaz), `invokeFunction` (`/functions/<ad>`), `uploadObject` (ham
  gövde, `Content-Type`, `Cache-Control: max-age`, `x-upsert`),
  `downloadObject`, `removeObjects`, `publicObjectUrl`, `realtimeUri`.
  `storage_client` paketi kullanılmadı (veli S13 kararıyla aynı).
- 24 `.from()` okuması → `read-mapping.md`'deki fonksiyonlar (adlar
  `endpoint.dart`), sayfalılar `PagedQuery.fetchAllRpc` (`p_offset`/`p_limit`).
- `RealtimeClient` velininkinin kopyası; `watchInbox` INSERT + rejoin +
  resync'te sinyal verir, UPDATE'i yok sayar.
- `SessionRetryClient` muaf yolları yalnızca backend'inkiler
  (`/auth/<uç>`, `/storage/object/`); `TimeoutHttpClient` fonksiyon bütçesi
  `/functions/`. `SupabaseHttpLogger` → `ApiHttpLogger`
  (`api_http_logger.dart`), `toSupabaseString` → `toDbString`.
- `grep -ri supabase lib`: yalnızca yorumlar (çoğu tarihçe ya da
  `supabase/migrations|functions` yolları; o klasör repoda tarihçe ve test
  sözleşmesi olarak kaldı). Kod satırı yok.
- AGENTS.md: "Own backend" bölümü (S15 durumu), Overview, Backend, Paged
  reads, Logging.

**Site** (`../mobil_spor_okulu_site`): uç
`https://api.mobilsporokulu.com/functions/site-lead` (`PUBLIC_LEAD_ENDPOINT`
ezer), CSP `connect-src` aynı köke, `EdgeFunctionLeadGateway` →
`ApiLeadGateway`, `.env.example`, AGENTS.md, README.

**Test:** yönetim `flutter analyze` 51 sorun (main 53, S14 52; yeni yok),
`flutter test` 1235 geçti + 2 atlanan (e2e). Yeni: `api_client_test`'e
okuma tekrarı, functions ve storage (10), `realtime_client_test.dart`
(veliden, yönetim kuralıyla), `paged_query_test` yeni istek şekli.
`tool/build_web.sh public all` üç paketi derledi. Site `npm test` 104,
`npm run build` 29 sayfa.

**Yerel uçtan uca:** canlıya değil, ayrı bir konteynerde
(`docker compose -p s15e2e`, `POSTGRES_PORT=55432`; 5432'de bir SSH tüneli
dinliyordu, ona dokunulmadı) migration + seed, `node dist/main`
(`SMTP_HOST=127.0.0.1 SMTP_PORT=2525`, yerel SMTP alıcısı, `STORAGE_ROOT`
geçici klasör). `test/e2e/local_backend_test.dart`'a S15 testi eklendi ve iki
kez (aradaki sıfırlamayla) geçti: bütün okumalar (antrenör başka şubenin
sporcusunu görmüyor, başka okul yok, rol süzgeci, cari kapsamı), duyuru →
antrenörün ve **velinin** gelen kutusunda `/realtime` ile canlı + okunmamış
sayısı, online ön kayıt (oturumsuz `submit-pre-registration`, fotoğraf
rızasıyla) → `bulk-convert-pre-registrations` → veli daveti e-postası,
`create-user` + yeni hesapla giriş, `delete-account` yanlış şifre →
`WrongPasswordException`, sporcu fotoğrafı yükle/`set_athlete_photo`/indir
(antrenör okur, başka velinin okuması 404)/sil, okul logosu yükle → public
adres oturumsuz 200 → sil. Site formu: yerel backend'e `Origin:
http://localhost:4321` ile aynı gövde → 200 + CORS başlığı + `site_leads`'te
satır. Ekranlar cihazda denenmedi; Android/iOS derlenmedi (yalnızca web).

**Yapılmayan — aydınlatma metni:** `assets/legal/privacy_policy_tr.md`
(§ hizmet sağlayıcılar tablosu: "Supabase Pte. Ltd. … İsviçre (Zürih)"), site
`iletisim-formu-aydinlatma-metni.astro` ve `content/features.ts`'teki
"veriler Supabase altyapısında, İsviçre'de" cümleleri yeni barındırmaya göre
yazılmalı. Barındırma bilgisi (VPS sağlayıcısı ve konumu, yedek deposu —
S16'nın açık soruları) henüz yok ve metni kullanıcı onaylamalı; veli
reposuna da bu oturumda dokunulmadı. PROGRESS.md açık sorularda.

**Bilinen eksikler / sonraki oturumlar:**
- Aydınlatma metni (yukarıda) + `PrivacyPolicy.version` iki uygulamada.
- S16: site CSP ve uç `api.mobilsporokulu.com` varsayıyor (alan adı açık
  soru); değişirse `site.ts`, `.htaccess`, `config/*.json` birlikte.
  `CORS_ORIGINS` web paketlerinin kökenlerini, `SITE_ALLOWED_ORIGINS` siteyi
  içermeli (`.env.example` zaten öyle).
- S17: yönetim de mağaza sürümü ister (supabase_flutter'ın yerel eklentisi
  `app_links` çıktı); personel bir kez yeniden giriş yapar.
