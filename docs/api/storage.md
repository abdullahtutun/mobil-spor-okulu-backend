# Dosya deposu API'si (S08)

Supabase storage-api'nin uygulamaların kullandığı kısmı, **aynı yollar ve
gövdelerle**; tek fark kök: `https://<proje>.supabase.co/storage/v1` yerine
`<API>/storage`. Uygulamalar `storage_client` paketini (2.8.1) değiştirmeden
bu köke yönlendirir (S13–S15): `StorageClient('<API>/storage', {Authorization})`
ya da supabase-dart'ın storage adresi.

Kod: `src/storage/`. Testler: `test/storage.e2e-spec.ts`, `src/storage/*.spec.ts`.

## Karar kimde (K9)

Dosyanın baytları diskte `STORAGE_ROOT/<bucket>/<ad>`; kim neyi okur, yazar,
siler kararını **`storage.objects` üzerindeki canlı politikalar** verir
(`db/migrations/0002_storage_policies.sql`, 8 politika, değiştirilmedi).
API her işte satırı isteğin rolüyle (token yoksa `anon`, varsa token'ın
claim'leriyle `authenticated`) okur/yazar/siler; disk işlemi ancak SQL
geçerse yapılır. SQL'ler storage-api'nin yetki denemesindekilerle aynı:

| İş | SQL (isteğin rolüyle) | Devreye giren politikalar |
|---|---|---|
| Yükleme | `insert` (RETURNING yok) | INSERT `with check` |
| Yükleme, `x-upsert: true` / PUT | `insert … on conflict do update … returning` | INSERT + var olan satırda UPDATE `using` + SELECT |
| İndirme | `select … where bucket_id, name` | SELECT `using` |
| Silme | `delete … where name = any(…) returning` | DELETE `using` + SELECT `using` |

Sonuçlar:

- **athlete-photos** (private, 1 MB, `image/jpeg`): personel `registration.manage`
  ve sporcunun şubesiyle yazar/siler (`can_write_athlete_photo`); okumak için
  sporcuyu görmek yeter (`can_read_athlete_photo`); veli yalnızca kendi
  çocuğunu okur, yalnızca **fotoğraf rızası geri alınmış ve `photo_path`
  boşken** siler (`can_parent_delete_athlete_photo`); silinmiş sporcunun
  fotoğrafına kimse erişemez. **UPDATE politikası yok → üzerine yazılamaz**
  (`x-upsert` de PUT de 403).
- **school-logos** (public, 2 MB, `image/png`): herkes okur
  (`school_logos_public_read`, `to public`); yazma/üzerine yazma/silme
  `school.manage` ve kendi okulunun klasörü (`<okul>/…`).
- Bucket ayarları (`public`, `file_size_limit`, `allowed_mime_types`)
  service_role ile okunur (buckets'ta istemciye politika yok; Supabase de
  süper kullanıcıyla okur).

## Uçlar

| Uç | Ne | storage_client |
|---|---|---|
| `GET /storage/object/public/:bucket/*ad` | Oturumsuz okuma; bucket `public` değilse `Bucket not found`. Authorization okunmaz, satır `anon` rolüyle okunur. | `getPublicUrl` |
| `GET /storage/object/authenticated/:bucket/*ad` | Oturumlu okuma | — |
| `GET /storage/object/:bucket/*ad` | Aynısı; tokensız istek private bucket'ta `Bucket not found` | `download` |
| `POST /storage/object/:bucket/*ad` | Yükleme; `x-upsert: true` → üzerine yaz | `upload`, `uploadBinary` |
| `PUT /storage/object/:bucket/*ad` | Üzerine yazarak yükleme | `update`, `updateBinary` |
| `DELETE /storage/object/:bucket` | Gövde `{"prefixes": ["ad", …]}` (1–1000 ad, tam ad — önek değil) | `remove` |

Uygulanmayanlar (uygulamalar kullanmıyor): imzalı URL'ler
(`createSignedUrl`, `createSignedUploadUrl`), `list`, `move`, `copy`, görsel
dönüştürme (`render/image`), `HEAD`, `Range`, bucket yönetimi.

### Yükleme

Gövde iki biçimde:

- `multipart/form-data` (storage_client): `cacheControl` alanı (saniye →
  `max-age=<n>`, yoksa `no-cache`), isteğe bağlı `contentType` ve `metadata`
  (JSON nesne), ilk dosya parçası. Dart'ın `http` paketi dosya parçasını
  `name=""; filename=""` ile yollar; `filename` parametresi olan (boş da
  olsa) ya da türü `text/plain` olmayan ilk parça dosyadır. İkinci dosya
  parçası 400.
- Ham gövde: tür `Content-Type` başlığından, önbellek `Cache-Control`
  başlığından, kullanıcı metadata'sı `x-metadata` (base64 JSON).

Yanıt `200 {"Id": "<satır id>", "Key": "<bucket>/<ad>"}` (üzerine yazmada var
olan satırın id'si).

Satır (canlıdaki 15 nesneyle aynı biçim):

```json
owner = owner_id = token'ın sub'ı, version = rastgele uuid, user_metadata = {} (ya da verilen)
metadata = { "eTag": "\"<md5>\"", "size": n, "mimetype": "image/jpeg",
             "cacheControl": "max-age=31536000",
             "lastModified": "2026-11-23T10:00:00.000Z",
             "contentLength": n, "httpStatusCode": 200 }
```

Sıra: gövde (sınırla) → tür doğrulaması → geçici dosya (`.tmp/`) → aynı
transaction'da satır INSERT + dosyayı yerine `rename` → commit. Taşıma
düşerse satır geri alınır; commit düşerse yeni dosya silinir.

### İndirme

`200`, gövde dosya; başlıklar metadata'dan: `Content-Type` (`text/html` →
`text/plain`), `Content-Length`, `Cache-Control` (yüklemedeki değer),
`ETag`, `Last-Modified`, `X-Content-Type-Options: nosniff`,
`X-Robots-Tag: none`. `If-None-Match` ETag'le eşleşirse `304` (gövdesiz).
Logo adresindeki `?v=<zaman>` sorgusu yok sayılır (önbellek kırıcı).

### Silme

İzin verilen ve var olan adların satırları silinir; yanıt
`200 [<satır>, …]` (`storage.objects` satırı, `path_tokens` hariç:
`id, bucket_id, name, owner, owner_id, metadata, user_metadata, version,
created_at, updated_at, last_accessed_at`). İzin verilmeyen ya da olmayan
adlar **sessizce düşer** (storage-api gibi), hepsi düşerse `[]`. Dosyalar
transaction açıkken `.trash/`'e taşınır; commit olursa silinir, geri
alınırsa yerine döner.

## Hatalar

storage-api'nin gövdesi ve durumu (uygulamalar `StorageException` okur;
gövdedeki `statusCode` HTTP durumundan önce gelir):

```json
HTTP 400  {"statusCode": "404", "code": "NoSuchKey", "error": "not_found", "message": "Object not found"}
```

| statusCode | code | error | message | Ne zaman |
|---|---|---|---|---|
| 404 | NoSuchKey | not_found | Object not found | satır yok ya da RLS gizledi (fark yok) |
| 404 | NoSuchBucket | Bucket not found | Bucket not found | bucket yok; private bucket'a oturumsuz/public uçtan |
| 409 | KeyAlreadyExists | Duplicate | The resource already exists | `x-upsert`'süz aynı ad |
| 403 | AccessDenied | Unauthorized | new row violates row-level security policy | yazma politikası reddetti |
| 413 | EntityTooLarge | Payload too large | The object exceeded the maximum allowed size | bucket sınırı / `STORAGE_MAX_FILE_SIZE` |
| 415 | InvalidMimeType | invalid_mime_type | mime type X is not supported / file content does not match mime type X | tür listede değil / gövde o türde değil |
| 400 | InvalidKey | InvalidKey | Invalid key: … | ad kuralı (aşağıda) |
| 400 | InvalidRequest | InvalidRequest | … | bozuk multipart, silme gövdesi |
| 500 | InternalError | internal | Internal Server Error | beklenmeyen (loglanır) |

HTTP durumu 400 (500 hariç) — storage-api'nin `userStatusCode`'u; yönetim
uygulamasının `SessionRetryClient`'ı storage reddini zaten 400/403 bekliyor.
**Token hataları** farklı: HTTP **401** ve
`{"statusCode": "401", "code": "PGRST303", "error": "InvalidJWT", "message": "JWT expired"}`
(`PGRST301` imza) — uygulamalar bu kodla token yeniler. Hız sınırı 429.
Sınırı aşan gövdenin kalanı okunup atılır (en çok 16 MB), bağlantı
kapanmaz: istemci 413'ü okur, ağ hatası görmez.

## Güvenlik kuralları (Supabase'ten sıkı)

- **Ad kuralı** (`object-key.ts`): storage-api'nin karakter kümesi
  (`A-Za-z0-9_/!.*'() &$=@;:+,?-`) **ve** boş parça, `.`/`..`, `.` ile
  başlayan parça, baştaki/sondaki `/`, 1024 bayttan uzun ad, 255 bayttan
  uzun parça yok. Yol ham URL'den parça parça çözülür; çözülünce `/` içeren
  parça (`%2F`) ya da bozuk kodlama reddedilir. Null bayt, ters bölü, ASCII
  dışı karakter zaten kümenin dışında.
- **Disk**: kök açılışta `realpath`; her işlemde dosyanın klasörünün gerçek
  yolu sözlük yoluyla aynı olmalı (kökün altında sembolik bağ izlenmez),
  dosya `O_NOFOLLOW` ile açılır, klasörler parça parça `lstat`'le açılır
  (`mkdir -p` bağı izleyip kök dışına klasör açmasın). Klasör 0700,
  dosya 0600.
- **Tür gövdeden**: bildirilen tür bucket'ın listesinde olmalı (Supabase)
  **ve** ilk baytlar o türün imzası olmalı (JPEG `FF D8 FF`, PNG, GIF,
  WebP). İmzası bilinmeyen resim türü reddedilir; uzantıya bakılmaz.
- **Boyut**: `min(bucket.file_size_limit, STORAGE_MAX_FILE_SIZE)`;
  `Content-Length` önce, gövde okunurken yine sayılır (chunked).
- **Varlık sızmaz**: başkasının fotoğrafı ile olmayan dosya aynı
  `NoSuchKey`; private bucket'a oturumsuz istek "bucket yok".

## Ortam

- `STORAGE_ROOT` (varsayılan `./storage-data`, Docker `/data/storage`):
  kalıcı volume (Coolify — S16). Kişisel veri; yedeklenir (S16), repoya
  girmez.
- `STORAGE_MAX_FILE_SIZE` (bayt, varsayılan 5 MB).
- Açılışta `.tmp/` ve `.trash/`'teki **10 dakikadan eski** yarım kalanlar
  temizlenir (satırı varsa çöpteki dosya yerine konur). Yaş sınırı:
  Coolify'ın kesintisiz dağıtımında eski süreç hâlâ çalışıyor olabilir.
- Tek dosya sistemi varsayımı: `.tmp` → yerine `rename` atomik olmalı
  (volume'un tamamı `STORAGE_ROOT`).

## Logo adresleri (S12)

`schools.logo_url` tam adres tutuyor (canlıda 2 okul, 2026-11-23):

```
https://gcmeltwnryjscinptecb.supabase.co/storage/v1/object/public/school-logos/<okul>/logo.png?v=<ms>
```

S12 veriyi taşırken öneki değiştirir, gerisi aynı kalır:

```sql
update public.schools
   set logo_url = replace(logo_url,
         'https://gcmeltwnryjscinptecb.supabase.co/storage/v1/',
         '<API>/storage/')
 where logo_url like 'https://gcmeltwnryjscinptecb.supabase.co/storage/v1/%';
-- → <API>/storage/object/public/school-logos/<okul>/logo.png?v=<ms>
```

Yönetim uygulaması yeni logoda adresi `getPublicUrl`'den üretir; storage
kökü `<API>/storage` olunca aynı biçim kendiliğinden çıkar (S15).
`athletes.photo_path` yalnızca yol tutar, değişmez.

Dosyaların taşınması (S12): her `storage.objects` satırı aynen kopyalanır
(`id, bucket_id, name, owner, owner_id, metadata, user_metadata, version,
created_at, updated_at, last_accessed_at`; `path_tokens` üretilen sütun),
baytlar `STORAGE_ROOT/<bucket>/<name>` yoluna, sahibi API kullanıcısı,
klasör 0700, dosya 0600. Her ad `isValidObjectKey`'den geçmeli; geçmeyen
ad taşınmaz, raporlanır. md5 metadata'daki `eTag` ile karşılaştırılır.
