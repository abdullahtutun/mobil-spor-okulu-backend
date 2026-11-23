# S02 — Zorunlu güncelleme kapısı (mevcut Supabase üzerinde)

**Repo:** yönetim (`../mobil_spor_okulu`), veli (`../mobil_spor_okulu_veli`)
· **Bağımlı:** —

## Amaç
Geçiş gecesi mağazadaki eski sürümlerin Supabase'e yazmaya devam etmesini
engellemek (PLAN.md K14). Bunun için kapının **bugün**, Supabase üzerinde
yayına girmesi ve kullanıcıların çoğunun bu sürüme geçmiş olması gerekir.
Geçişte (S17) Supabase'teki asgari sürüm yükseltilir; eski uygulamalar
"güncelleyin" ekranında kalır.

Bu oturum `main` dalında, normal ürün işi olarak yapılır (geçiş dalı değil).

## Okunacaklar
- `../mobil_spor_okulu/AGENTS.md`, `../mobil_spor_okulu_veli/AGENTS.md`
- İki uygulamada başlangıç akışı: Y `lib/core/provider/start_up_provider.dart`,
  V `lib/core/provider/session_gate.dart` ve `StartUpService`,
  `redirectFor` (router)
- Memory: sürüm numaralandırma kuralı (1.0.N, build N, iki uygulama birlikte)

## Yapılacaklar
- [x] Yönetim reposunda migration: `app_min_versions(app text, platform text,
      min_build int, store_url text)` (ya da tek satırlık bir yapı) ve
      **`anon` dahil herkese açık** `get_min_app_version(p_app, p_platform)`
      RPC'si. `app` değerleri: `management`, `parent`; `platform`: `android`,
      `ios`. Web için kapı yok (web her zaman son sürüm).
- [x] Başlangıçta, girişten **önce** kontrol: build numarası küçükse tam
      ekran, kapatılamayan "Güncelleme gerekli" ekranı + mağaza bağlantısı.
      Ağ hatası ya da RPC yoksa uygulama **açılır** (kapı asla kendi başına
      kilitlemez).
- [x] Router: yeni bir `AppStatus` (ör. `updateRequired`) ve `redirectFor`
      testleri.
- [x] ARB metinleri (tr + diğer diller), parity testleri geçsin.
- [x] Widget/birim testleri: küçük build → ekran; eşit/büyük → normal akış;
      hata → normal akış.
- [x] İki uygulamanın `AGENTS.md`'sine kısa bir bölüm: kapının amacı ve
      asgari sürümün nasıl yükseltileceği (SQL tek satır).
- [ ] Migration'ı canlı Supabase'e uygulamak **kullanıcının onayıyla** yapılır
      (PLAN.md değişmez kuralının tek istisnası; bu bir geçiş işi değil, ürün
      değişikliği). Başlangıç değeri: `min_build = 0`.
- [x] Sürüm numaralarını memory'deki kurala göre artır; mağaza sürümünü
      kullanıcı yayınlar.

## Kapsam dışı
Yeni backend'e ait hiçbir şey. Kapının yeni backend'deki karşılığı şema
dump'ıyla (S03) kendiliğinden gelir.

## Kabul kriterleri
- İki repoda `flutter analyze` ve `flutter test` geçiyor.
- Migration yerelde/branch'te denendi; RPC `anon` ile çağrılabiliyor.
- `PROGRESS.md` günlüğüne: hangi sürümlerin kapıyı taşıdığı (S17 bunu
  kullanır).

## Teslim notu
**Ne yapıldı (2026-11-23):**
- Y `supabase/migrations/20261027_app_min_versions.sql` (+ `_rollback/`):
  `app_min_versions (app, brand, platform, min_build, store_url, updated_at)`,
  anahtar `(app, brand, platform)`, 8 satır `min_build = 0`;
  `get_min_app_version(p_app, p_platform, p_brand)` → `app_ok` zarfı,
  `data: {min_build, store_url}` ya da satır yoksa `data: null`. SECURITY
  INVOKER, `anon`/`authenticated` select + execute; istemci yazamaz. Sonunda
  kendi denetim bloğu var. **Canlıya henüz uygulanmadı** (kullanıcı onayı).
- İki uygulamada `lib/features/app_update/` (data source → repository →
  service → `UpdateGate` + `UpdateRequiredScreen` + `UpdateGateListener`),
  `AppStatus.updateRequired` (bir kez girilince `setStatus` çıkmaz).
  Y: `startUpProvider` önce kapıyı sorar, `updateGateRedirect` (router),
  yol `/update-required`, `url_launcher` eklendi. V: `SessionGate.start`
  önce kapıyı sorar, `redirectFor`'a durum, yol `/guncelleme`.
  Öne gelişte (en çok 30 dk'da bir) yeniden sorulur.
- Kapı kendi başına kilitlemez: ağ hatası, 3 sn zaman aşımı, satır/fonksiyon
  yok, build okunamıyor → uygulama açılır. Web'de kapı yok.
- Mağaza: satırdaki `store_url`; boşsa Android paket adından Play adresi,
  iOS'ta düğme yok (App Store kimliği bilinmiyor).
- ARB (tr/en) 4 anahtar; iki AGENTS.md'ye "Mandatory update gate" bölümü;
  Android manifest'lere `https` VIEW sorgusu; sürüm iki uygulamada
  **1.1.2+10**.

**Test:** yerelde `postgres:17-bookworm` konteynerinde (anon/authenticated
rolleri, `app_ok`/`set_updated_at` gerçek tanımları) migration iki kez
çalıştırıldı; `anon` RPC'yi çağırdı, 8 satırı okudu, update/insert
`permission denied` aldı. Y `test/app_update/update_gate_test.dart`
(servis, yönlendirme, ekran, migration sözleşmesi), V
`test/app_update/update_gate_test.dart` + `test/core/router_redirect_test.dart`.

**Bilinen eksikler / kullanıcıda:** canlıya migration; 1.1.2+10 mağaza
sürümü (iki uygulama, Android + iOS; native değişiklik olduğu için Shorebird
yaması değil); S17'den önce iOS satırlarına App Store adresleri.
