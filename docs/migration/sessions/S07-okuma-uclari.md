# S07 — Tablo okumalarının SQL fonksiyonlarına çevrilmesi

**Repo:** backend (Y ve V okunur, değiştirilmez) · **Bağımlı:** S04

## Amaç
Uygulamaların PostgREST'e yaptığı her `.from(table).select(...)` okumasının
karşılığı olan, **aynı JSON şeklini** dönen bir `SECURITY INVOKER` SQL
fonksiyonu (K7). RLS çağıranın rolüyle çalışır; yeni yetki kuralı yazılmaz.
Dart tarafı S13/S15'te bu fonksiyonlara geçer.

## Okunacaklar
- `INVENTORY.md` → 3
- Y ve V'de her `.from(` çağrısı (`grep -rn "\.from(" lib --include=*.dart`
  içinden tablo sabitleriyle olanlar), ilgili DTO'nun `fromJson`'u,
  Y `lib/core/data/remote/paged_query.dart` (sayfalama, sıralama, `count`)
- Y `endpoint.dart` → `profilePermissionsEmbed`, `attendancesCoachFk`

## Yapılacaklar
- [ ] `docs/migration/read-mapping.md`: her çağrı noktası için bir satır —
      Dart dosyası:satır, tablo, select ifadesi (embed'ler dahil), filtreler,
      sıralama, sayfalama, karşılık gelen yeni fonksiyon ve parametreleri.
- [ ] Her okuma için migration'da bir fonksiyon (`list_*` / `get_*`;
      `jsonb` döner, `security invoker`, `stable`). Embed'ler `jsonb_build_object`
      / alt sorgu ile aynı anahtar adlarıyla; sıralama ve `null` davranışı
      PostgREST ile aynı.
- [ ] Sayfalama: `paged_query.dart`'ın beklediği şekil (toplam sayı dahil)
      tek yanıtta, ör. `{ "items": [...], "total": n }`; şekil
      `read-mapping.md`'de tanımlanır.
- [ ] Gelen kutusu (`notifications`, Y + V) için fonksiyon; Realtime'ın
      gönderdiği satırla aynı şekil (S11 bunu kullanır).
- [ ] Yeni fonksiyonları RPC allow-list'ine ekle (doğru rollerle).
- [ ] Integration testleri: her fonksiyon seed verisiyle çağrılır, çıkan
      JSON'un anahtarları ilgili DTO'nun okuduğu anahtarları içerir; bir
      başka okulun verisi dönmez.

## Kapsam dışı
Dart değişiklikleri (S13, S15).

## Kabul kriterleri
- `read-mapping.md`'deki her satırın fonksiyonu ve testi var.
- Yönetim reposuna da aynı migration'ı eklemek gerekip gerekmediği
  günlüğe yazıldı (gerekmez: fonksiyonlar yalnızca yeni backend'de lazım).
- lint/test/test:e2e geçiyor.

## Teslim notu
_(oturum sonunda doldurulur)_
