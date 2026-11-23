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
- [x] Uç noktalar (son hâli `docs/api/storage.md`):
  - `GET /storage/object/:bucket/*path` (oturumlu, private)
  - `GET /storage/public/:bucket/*path` (yalnızca `public` bucket; cache
    başlıkları, ETag)
  - `POST|PUT /storage/object/:bucket/*path` (yükleme; `x-upsert`,
    `content-type`)
  - `DELETE /storage/object/:bucket` `{ prefixes: [...] }`
- [x] Akış: çağıranın rolüyle `storage.objects` satırı insert/select/delete
      (RLS karar verir) → disk işlemi. Yüklemede geçici dosya + commit
      sonrası `rename`; silmede commit sonrası `unlink`. Yarım kalanlar için
      açılışta temizlik.
- [x] Güvenlik: yol normalleştirme (`..`, mutlak yol, null byte), bucket'ın
      `file_size_limit` ve `allowed_mime_types` değerleri, içerik tipini
      uzantıdan değil gövdeden doğrulama (resim).
- [x] `STORAGE_ROOT` env; Docker volume.
- [x] Logo URL'leri: veritabanında tam Supabase URL'i saklanıyorsa S12'nin
      yeniden yazması gereken biçimi `docs/api/storage.md`'ye yaz.
- [x] Testler: personel fotoğraf yükler/okur; veli yalnızca kendi çocuğunun
      fotoğrafını okur; veli fotoğrafı yalnızca rıza geri alındıktan sonra
      silebilir; public logo oturumsuz okunur; yol saldırıları reddedilir.

## Kapsam dışı
Mevcut dosyaların taşınması (S12).

## Kabul kriterleri
- Bugünkü 18 bucket politikasının her biri en az bir testle kapsanmış.
- lint/test/test:e2e geçiyor.

## Teslim notu
**Durum: tamam (2026-11-23).** Orkestratörle, kullanıcıya sorulmadan; plan
kararı (K1–K16) değişmedi. Canlıya yalnızca salt okunur katalog/toplu
sorgular atıldı (politikalar, bucket ayarları, nesne sayıları/boyutları,
metadata anahtarları ve biçimleri, logo adresinin kalıbı); fotoğraf
indirilmedi, canlıya yazılmadı.

Ne yapıldı, nerede:
- Sözleşme `docs/api/storage.md` (uçlar, satır biçimi, hatalar, güvenlik,
  ortam, S12'nin logo adresi dönüşümü ve dosya taşıma biçimi).
- `src/storage/`: `storage.controller.ts` (uçlar; ad ham URL'den),
  `storage.service.ts` (yükleme/indirme/silme akışı, gövde okuma ve sınır,
  açılış temizliği), `storage.repository.ts` (SQL'ler isteğin rolüyle;
  bucket ve temizlik service_role), `disk-store.ts` (disk: geçici dosya,
  `rename`, çöp, `O_NOFOLLOW`, sembolik bağ denetimi, temizlik),
  `object-key.ts` (ad kuralı), `mime.ts` (tür listesi + gövde imzası),
  `multipart.ts` (Dart'ın `name=""; filename=""` biçimini okuyan
  ayrıştırıcı), `storage-errors.ts` + `storage-exception.filter.ts`
  (storage-api gövdesi).
- Env `STORAGE_ROOT`, `STORAGE_MAX_FILE_SIZE` (`env.schema.ts`,
  `.env.example`); `Dockerfile` `/data/storage` (node sahibi),
  `docker-compose.yml` api profiline `storage-data` volume'u.
- CORS: `PUT` ve `x-upsert`, `x-metadata`, `cache-control`,
  `If-None-Match` başlıkları (`app.setup.ts`).
- Migration yok: politikalar (0002), bucket satırları (compat 03) ve
  fonksiyonlar S03'ten beri canlıyla aynı.

Plandan sapmalar (küçük, gerekçeli):
- **Yollar storage-api'ninki** (`/storage/object/public/:bucket/*`, oturum
  dosyasındaki `/storage/public/…` değil): `storage_client`'ın
  `getPublicUrl`'i `…/object/public/…` üretiyor; kök `<API>/storage`
  olunca istemci paketi değişmeden çalışır. `/object/authenticated/…` da var.
- **Dosya commit'ten önce yerine taşınıyor** (oturum dosyası "commit sonrası
  rename" diyordu): taşıma satırın kilidi altında, aynı transaction'da;
  taşıma düşerse satır kendiliğinden geri alınır (commit sonrası taşımada
  düşen taşıma için service_role ile satır silmek gerekirdi), eşzamanlı iki
  logo yüklemesi de sıraya girer. Commit düşerse yeni dosya silinir.
  Silmede dosya transaction açıkken çöpe taşınır, commit sonrası silinir —
  silme ile aynı ada hemen ardından gelen yükleme birbirinin dosyasını
  silemez.
- **"18 bucket politikası"** envanterin tahminiydi; canlıda (ve 0002'de)
  **8** politika var (athlete-photos 4, school-logos 4). Sekizi de test
  edildi.

Nasıl test edildi:
- `test/storage.e2e-spec.ts` (54 test, gerçek Postgres + disk, Dart'ın
  multipart biçimi):
  - `athlete_photos_insert`: genel müdür ve şube müdürü yükler (satır
    canlıdaki 15 nesneyle aynı biçim: metadata'nın 7 anahtarı, 34 karakterlik
    eTag, ISO `lastModified`, owner = sub, version uuid, dosya 0600);
    `set_athlete_photo` iki dosyayı görür; reddedilenler: başka şube,
    antrenör, muhasebeci, veli, başka okul (iki yön), silinmiş sporcu, yanlış
    klasör derinliği, oturumsuz, anon anahtarı — satır yok, dosya yok,
    `.tmp` boş.
  - üzerine yazma: aynı ad 409, `x-upsert` ve PUT 403 (UPDATE politikası yok).
  - `athlete_photos_select`: genel müdür, şube müdürü, antrenör (A1), veli
    (kendi çocuğu) okur; başlıklar ve 304; A2 antrenörü, başkasının çocuğu,
    pasif veli, B velisi, B genel müdürü, olmayan dosya `NoSuchKey`;
    oturumsuz/public uç `Bucket not found`; sporcu silinince okunamaz ve
    personel silemez.
  - `athlete_photos_delete`: antrenör, muhasebeci, A2 antrenörü, B genel
    müdürü `[]` (dosya durur); şube müdürü siler.
  - `athlete_photos_parent_delete`: rıza dururken `[]`; rıza geri alınınca
    (`photo_consent_at`, `photo_path` null) kendi çocuğununkini siler
    (yanıt satırları, dosyalar gider), başkasının çocuğu ve pasif veli `[]`.
  - `school_logos_admin_insert`/`_update`/`_delete`/`_public_read`: genel
    müdür upsert'le yükler, üzerine yazar (aynı satır id'si, yeni ETag),
    upsert'siz 409; şube müdürü, başka okul (iki yön), oturumsuz 403;
    oturumsuz public okuma (`?v=` ile), oturumlu uçtan veli ve B velisi
    okur; silmede şube müdürü/B/oturumsuz `[]`, genel müdür siler.
  - güvenlik: 7 yol saldırısı (`%2E%2E`, `%2F`, `%00`, `%5C`, baştaki `/`,
    gizli dosya, ASCII dışı) yükleme ve indirmede `InvalidKey`, bozuk yüzde
    kodlaması 400; 1 MB+ dosya 413 (Content-Length'li ve chunked — istemci
    yanıtı okuyabiliyor); listede olmayan tür, PNG baytlı "jpeg", HTML 415;
    ham gövdeli yükleme; diskte sembolik bağa dönüşmüş nesne sunulmaz;
    süresi geçmiş token 401 `PGRST303`, service_role anahtarı 401; silme
    gövdesi doğrulaması (boş, 1001 ad, sayı); CORS ön isteği.
- Birim: `object-key.spec.ts`, `mime.spec.ts`, `multipart.spec.ts`,
  `disk-store.spec.ts` (sembolik bağ dosya ve klasör, kök dışına klasör
  açmama, dosya/klasör çakışması, çöp, açılış temizliği).
- Kuralı bilerek bozma: nesne okumasını service_role'e çevirince 6 test
  düştü (RLS'in okuma kararı); ad kuralından `.`/boş parça denetimi
  kaldırılınca 3 test düştü. İkisi de geri alındı.
- `npm run lint`, `npm run typecheck`, `npm test` (19 suite, 120 test),
  `npm run test:e2e` (9 suite, 510 test) geçiyor.

Bilinen eksikler / bilinçli farklar:
- İmzalı URL, `list`/`move`/`copy`, görsel dönüştürme, `HEAD`, `Range`
  yok (uygulamalar kullanmıyor).
- Supabase'ten sıkı: ad kuralı (`..` vb.), gövde imzası; storage-api'nin
  `allowInvalidJwt`'si yok (geçersiz token her uçta 401, public uç hariç).
- Gövde bellekte tamponlanır (bucket sınırları 1–2 MB; genel tavan 5 MB).
- Satırı olup dosyası olmayan nesne `NoSuchKey` + hata logu; dosyası olup
  satırı olmayan (yalnızca elle müdahale ile) kimseye sunulmaz, temizlenmez.
- macOS'ta (büyük/küçük harf duyarsız APFS) yerel denemede `A.jpg`/`a.jpg`
  çakışır; üretim Linux (ext4).
