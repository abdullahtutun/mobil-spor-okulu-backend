# S08 — Dosya depolama

**Repo:** backend (Y ve V okunur) · **Bağımlı:** S04, S05

## Amaç
`athlete-photos` (private) ve `school-logos` (public) bucket'ları. Dosya
diskte, metadata `storage.objects`'te; kim neyi okuyup yazabileceğine
mevcut storage politikaları karar verir (K9).

## Okunacaklar
- `INVENTORY.md` → 7
- Y `features/registration/data/source/athletes/athlete_photo_data_source.dart`,
  `features/school/data/source/school_data_source.dart` (logo; public URL
  nasıl üretiliyor ve nerede saklanıyor)
- V `features/athlete/data/source/athlete_photo_data_source.dart`,
  `ConsentService` (rıza geri alınınca silme)
- `db/migrations/0002_storage_policies.sql`, `can_read_athlete_photo`

## Yapılacaklar
- [ ] Uç noktalar (son hâli `docs/api/storage.md`):
  - `GET /storage/object/:bucket/*path` (oturumlu, private)
  - `GET /storage/public/:bucket/*path` (yalnızca `public` bucket; cache
    başlıkları, ETag)
  - `POST|PUT /storage/object/:bucket/*path` (yükleme; `x-upsert`,
    `content-type`)
  - `DELETE /storage/object/:bucket` `{ prefixes: [...] }`
- [ ] Akış: çağıranın rolüyle `storage.objects` satırı insert/select/delete
      (RLS karar verir) → disk işlemi. Yüklemede geçici dosya + commit
      sonrası `rename`; silmede commit sonrası `unlink`. Yarım kalanlar için
      açılışta temizlik.
- [ ] Güvenlik: yol normalleştirme (`..`, mutlak yol, null byte), bucket'ın
      `file_size_limit` ve `allowed_mime_types` değerleri, içerik tipini
      uzantıdan değil gövdeden doğrulama (resim).
- [ ] `STORAGE_ROOT` env; Docker volume.
- [ ] Logo URL'leri: veritabanında tam Supabase URL'i saklanıyorsa S12'nin
      yeniden yazması gereken biçimi `docs/api/storage.md`'ye yaz.
- [ ] Testler: personel fotoğraf yükler/okur; veli yalnızca kendi çocuğunun
      fotoğrafını okur; veli fotoğrafı yalnızca rıza geri alındıktan sonra
      silebilir; public logo oturumsuz okunur; yol saldırıları reddedilir.

## Kapsam dışı
Mevcut dosyaların taşınması (S12).

## Kabul kriterleri
- Bugünkü 18 bucket politikasının her biri en az bir testle kapsanmış.
- lint/test/test:e2e geçiyor.

## Teslim notu
_(oturum sonunda doldurulur)_
