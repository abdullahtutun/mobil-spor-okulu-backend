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
- [x] `docs/migration/read-mapping.md`: her çağrı noktası için bir satır —
      Dart dosyası:satır, tablo, select ifadesi (embed'ler dahil), filtreler,
      sıralama, sayfalama, karşılık gelen yeni fonksiyon ve parametreleri.
- [x] Her okuma için migration'da bir fonksiyon (`list_*` / `get_*`;
      `jsonb` döner, `security invoker`, `stable`). Embed'ler `jsonb_build_object`
      / alt sorgu ile aynı anahtar adlarıyla; sıralama ve `null` davranışı
      PostgREST ile aynı.
- [x] Sayfalama: `paged_query.dart`'ın beklediği şekil (toplam sayı dahil)
      tek yanıtta, ör. `{ "items": [...], "total": n }`; şekil
      `read-mapping.md`'de tanımlanır.
- [x] Gelen kutusu (`notifications`, Y + V) için fonksiyon; Realtime'ın
      gönderdiği satırla aynı şekil (S11 bunu kullanır).
- [x] Yeni fonksiyonları RPC allow-list'ine ekle (doğru rollerle).
- [x] Integration testleri: her fonksiyon seed verisiyle çağrılır, çıkan
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
**Durum: tamam (2026-11-23).**

Ne yapıldı, nerede:
- `docs/migration/read-mapping.md` — 26 çağrı noktası (Y 24, V 2) → 23
  fonksiyon; ortak sözleşme (gömme, `!inner`, sıra, NULL, sayfalama, tek
  satır, sayı, anon, hata) ve Dart'ta sayfalı çağrının şekli.
- `db/migrations/0007_read_functions.sql` — 23 okuma fonksiyonu + S11 için
  `get_notification(p_id)`. Hepsi `language sql stable security invoker`,
  `search_path = public, extensions` (Supabase PostgREST'inin ortamı),
  `jsonb` döner (`count_unread_notifications` → `integer`), anon'a kapalı,
  authenticated + service_role'e açık, yorumu `backend:` ile başlar.
- `src/rpc/rpc-allowlist.ts` — `READS` (23 satır, `callers: USER`,
  `reads: [<yerine geçtiği tablo>]`). `get_notification` listede değil
  (sunucu içi).
- `scripts/schema-fingerprint.sql` yorumu `backend:` ile başlayan
  fonksiyonları canlı karşılaştırmasından çıkarır (canlıda 0 tane, salt
  okunur sorguyla bakıldı); `test/schema.e2e-spec.ts` → `BACKEND_ONLY`
  (functions: 24).
- `test/support/postgrest.ts` — gerçek PostgREST konteyneri
  (`postgrest/postgrest:v12.2.12`, aynı Docker ağında, `api_authenticator`
  ile).
- `test/read-functions.e2e-spec.ts` — fark testi (aşağıda).
- `test/rpc-allowlist.e2e-spec.ts` — okuma girdileri için: uygulamanın her
  `.from(<x>Table)` tablosunun bir okuma fonksiyonu var; her okuma
  fonksiyonu ya `.rpc(` ile çağrılıyor ya da yerine geçtiği `.from()` hâlâ
  duruyor (S13/S15 çevirdikçe kendiliğinden doğru kalır); her biri
  read-mapping.md'de. `.rpc(` eşitliği okuma dışı girdiler için aynı.

Nasıl test edildi:
- Fark testi: aynı veritabanına bağlı PostgREST'e uygulamanın sorgusu
  (supabase-dart'ın ürettiği adres), bize fonksiyon; 27 durum × 10 kullanıcı
  (A: genel müdür, şube müdürü, müdür yardımcısı, antrenör, muhasebeci, veli,
  pasif veli, silinmiş hesap; B: genel müdür, veli) JSON eşitliği; sayfalı
  olanlar 2'lik sayfalarla da; okunmamış sayısı `Content-Range` ile;
  `get_notification` PostgREST `select=*` satırıyla. Ek veriler: silinmiş
  sporcu, silinmiş bağ, indirimler (şubeli/okul geneli/B), harici cari,
  gider, silinmiş tahsilat, ön kayıtlar, duyuru, bildirimler, tercihler.
- Açık beklentiler: genel müdür okulunun 3 sporcusunu görür (silinmiş ve B
  yok), şube müdürü yalnızca A1, B okulu A'nın okulunu `null` görür, veli
  okul tablolarında `[]` ve yalnızca kendi bildirimi, pasif ve silinmiş
  hesap hiçbir şey, antrenör finans görmez, anon 401 `42501`, yanlış enum
  400 `22P02`, genel müdürde hiçbir okuma boş değil (eşitlik boşa geçmesin).
- Katalog: hepsi SECURITY INVOKER, stable, anon'a kapalı, `backend:` yorumlu.
- Kuralı bilerek bozma: `list_athletes` SECURITY DEFINER → 16 test düştü;
  `list_branches`'ta `!inner` yerine `left join` → 6 test düştü;
  allow-list'ten `list_sports` silinince "her .from() okumasının fonksiyonu
  var" testi düştü. Hepsi geri alındı.
- `npm run lint`, `npm run typecheck`, `npm test` (79), `npm run test:e2e`
  (8 suite, 456 test) geçiyor.

Bilinen eksikler / bilinçli farklar:
- Oturumsuz çağrı 401 (PostgREST anon'a boş liste dönerdi); uygulamalar bu
  okumaları oturumsuz yapmıyor.
- Sırasız okumalar ve eşit değerli sıralar deterministik (`created_at, id`
  / `+ id`); PostgREST'te tanımsızdı.
- `list_branches`'taki yönetici rol listesi (1, 2, 3, 9) ve `list_parents`/
  `list_coaches`'un rolleri fonksiyonda sabit (uygulamada da sabitti).
- PostgREST sürümü testte v12.2.12; Supabase'in kullandığı sürüm SQL'den
  okunamadı. Gömme anlamı (null / [] / !inner) bu sürümler arasında aynı.
- Yönetim reposuna migration eklenmez: fonksiyonlar yalnızca yeni backend'de
  lazım.
