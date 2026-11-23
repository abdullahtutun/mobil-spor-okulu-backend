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
- [ ] Yönetim reposunda migration: `app_min_versions(app text, platform text,
      min_build int, store_url text)` (ya da tek satırlık bir yapı) ve
      **`anon` dahil herkese açık** `get_min_app_version(p_app, p_platform)`
      RPC'si. `app` değerleri: `management`, `parent`; `platform`: `android`,
      `ios`. Web için kapı yok (web her zaman son sürüm).
- [ ] Başlangıçta, girişten **önce** kontrol: build numarası küçükse tam
      ekran, kapatılamayan "Güncelleme gerekli" ekranı + mağaza bağlantısı.
      Ağ hatası ya da RPC yoksa uygulama **açılır** (kapı asla kendi başına
      kilitlemez).
- [ ] Router: yeni bir `AppStatus` (ör. `updateRequired`) ve `redirectFor`
      testleri.
- [ ] ARB metinleri (tr + diğer diller), parity testleri geçsin.
- [ ] Widget/birim testleri: küçük build → ekran; eşit/büyük → normal akış;
      hata → normal akış.
- [ ] İki uygulamanın `AGENTS.md`'sine kısa bir bölüm: kapının amacı ve
      asgari sürümün nasıl yükseltileceği (SQL tek satır).
- [ ] Migration'ı canlı Supabase'e uygulamak **kullanıcının onayıyla** yapılır
      (PLAN.md değişmez kuralının tek istisnası; bu bir geçiş işi değil, ürün
      değişikliği). Başlangıç değeri: `min_build = 0`.
- [ ] Sürüm numaralarını memory'deki kurala göre artır; mağaza sürümünü
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
_(oturum sonunda doldurulur)_
