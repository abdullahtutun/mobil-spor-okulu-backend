# S12 — Veri, kullanıcı ve dosya taşıma araçları

**Repo:** backend · **Bağımlı:** S03–S11

## Amaç
Canlı Supabase'ten (salt okunur) yeni veritabanına bütün verinin,
kullanıcıların ve dosyaların tekrarlanabilir şekilde taşınması, doğrulanması
ve yerelde provası. S17 bu araçları geçiş gecesi çalıştırır.

## Okunacaklar
- `INVENTORY.md` (tamamı), `db/compat/02_auth.sql`, `03_storage.sql`
- S08 teslim notu (logo URL biçimi), S05 teslim notu (oturum/token tabloları)
- Memory: canlı DB kontrolü

## Karar gerekiyor (oturum başında kullanıcıya sor)
- **Açık oturumlar taşınsın mı?** Varsayılan: hayır — yeni uygulama
  sürümünde herkes bir kez yeniden giriş yapar (oturum saklama biçimi zaten
  değişiyor). Evet denirse `JWT_SECRET` Supabase'in legacy secret'ı olur ve
  refresh token'lar taşınır.

- **S09'dan:** canlıdaki `update-parent` e-posta değişikliği hatası yetim veli
  hesapları bırakmış olabilir (davetli, onaysız, bağlı; eski hesap da duruyor).
  Taşımadan önce salt okunur sayılmalı (bkz. PROGRESS.md açık sorular).

## Yapılacaklar
- **S03'ten bilinmesi gerekenler:**
  - `roles`, `role_permissions` ve `app_min_versions` `0004_reference_data.sql`
    ile zaten dolu: kopyalanmaz (ya da `on conflict do nothing`).
  - Üretilen sütunlar kopyaya girmez (`generated always`): `auth.users.confirmed_at`,
    `auth.identities.email`, `storage.objects.path_tokens`.
  - `auth.*` tablolarının sütunları canlıyla bire bir (`db/compat/02_auth.sql`);
    `storage.objects`/`buckets` canlıdaki sütunların alt kümesi (sürümleme,
    yaşam döngüsü sütunları yok, `03_storage.sql`).
  - `auth.audit_log_entries` tablosu yok (5651 saklaması için ayrıca karar).
  - **S05:** refresh token'lar bizde SHA-256 hex (`token`, `parent`);
    Supabase'te 12 karakter düz metin. Oturumlar taşınacaksa ikisi de
    `encode(sha256(convert_to(token, 'UTF8')), 'hex')` ile çevrilerek
    kopyalanır. Şifre hash'leri olduğu gibi (`$2a$`, S05 doğruluyor).
  - Şema dump'ı CLI ile parolasız alınabiliyor:
    `supabase db dump --project-ref <ref> [--data-only] -f dumps/…`
    (geçici giriş rolü, IPv4 pooler; colima'da `DOCKER_HOST` gerekli).
- **S08:** dosyalar `STORAGE_ROOT/<bucket>/<name>` yoluna (klasör 0700,
    dosya 0600, sahibi API kullanıcısı); `storage.objects` satırları aynen
    (`path_tokens` hariç). Her ad `src/storage/object-key.ts` →
    `isValidObjectKey`'den geçmeli (geçmeyen raporlanır); md5 = metadata
    `eTag`. Logo adresi: `schools.logo_url`'de
    `https://gcmeltwnryjscinptecb.supabase.co/storage/v1/` öneki
    `<API>/storage/` olur (SQL `docs/api/storage.md` → "Logo adresleri").
    Canlı 2026-11-23: athlete-photos 12 nesne / ~285 KB, school-logos 3 / ~580 KB.
    Dosyalar `.tmp`/`.trash`'e değil doğrudan yerine; API kapalıyken
    kopyalanır.
- [x] `scripts/export/`: public şema verisi (`supabase db dump --linked
      --data-only`), `auth.users` (yalnızca S03'teki sütunlar; salt okunur
      sorgu), `storage.objects` satırları ve iki bucket'ın bütün dosyaları
      (service role ile yalnızca okuma/indirme). Çıktı `exports/<tarih>/`
      (gitignore); bitince sayıları ve toplam boyutu yazan bir özet.
- [x] `scripts/import/`: boş ve migrate edilmiş bir veritabanına yükleme
      (trigger'lar ve bildirim üreten yan etkiler yükleme sırasında kapalı —
      ör. `session_replication_role = replica`), sequence'lerin
      ayarlanması, dosyaların `STORAGE_ROOT`'a kopyalanması, logo URL'lerinin
      yeni biçime çevrilmesi.
- [x] `scripts/verify/`: tablo başına satır sayısı karşılaştırması,
      `auth.users` sayısı, dosya sayısı ve toplam boyut, rastgele 20
      dosyanın hash karşılaştırması, test hesabıyla giriş + `get_session_data`.
- [x] Yerel prova: export → import → verify uçtan uca; süreyi ölç (geçiş
      penceresi tahmini) ve günlüğe yaz.
- [x] `docs/migration/RUNBOOK-data.md`: komutlar sırasıyla, beklenen
      çıktılar, sorun olursa ne yapılacağı.
- [x] Export klasörlerinin prova sonrasında silinmesi (kişisel veri).

## Kapsam dışı
VPS üzerinde çalıştırma (S16/S17).

## Kabul kriterleri
- Prova sonunda verify sıfır fark veriyor (farklar gerekçeli).
- Hiçbir script canlı Supabase'e yazmıyor (kod incelemesiyle doğrula).

## Teslim notu
2026-11-23, orkestratörle (kullanıcıya sorulmadan).

**Karar (oturum başı soru):** açık oturumlar **varsayılan olarak taşınmaz**
(dosyadaki varsayılan). `--with-sessions` ile taşınabilir: refresh
token'lar SHA-256'ya çevrilir, eski düz token'la yenileme çalışır (e2e).
Bunun için `JWT_SECRET`'ın Supabase'inki olması **gerekmiyor** — yalnızca
süresi dolmamış eski access token'lar için gerekirdi (1 saat). Karar S17'de
tek bayrakla değişebilir.

**Yetim veli hesapları (S09):** canlıda salt okunur sayım 0 (davetli+onaysız
0, profilsiz kullanıcı 0, aynı sporcuya aynı adla iki veli 0).

**Ne, nerede:**
- `src/data-migration/` (oturum dosyası `scripts/` diyordu; `src/`'de
  olunca lint/typecheck kapsamında ve API imajında — S17 VPS'te
  `node dist/data-migration/cli.js` ile çalıştırır):
  `plan.ts` (kapsam, başvuru tabloları, kaynağa özgü sütunlar, dönüşümler),
  `catalog.ts` (katalog + parmak izi SQL'i), `export.ts`, `import.ts`
  (+ `resumeCron`), `verify.ts`, `storage-source.ts` (Supabase storage-api,
  yalnızca GET), `rows.ts`, `manifest.ts`, `cli.ts`; `npm run data -- …`.
- Biçim: `exports/<tarih>/manifest.json` + `tables/<şema.tablo>.ndjson`
  (satır = kaynağın `to_jsonb` metni, üretilen sütunlar hariç) +
  `storage/<bucket>/<ad>`; hepsi 0600/0700.
- Export tek `repeatable read read only` transaction (bütün tablolar aynı
  anlık görüntü, parmak izleri aynı transaction'da); `supabase db dump
  --data-only` yerine bu, çünkü verify kaynağın parmak izine ihtiyaç duyuyor
  ve sentetik kaynakta aynı yol sınanabiliyor.
- Import: cron durdurulur (`cron-paused.json`), tek transaction +
  `session_replication_role = replica` (handle_new_user, bildirim
  trigger'ları, FK denetimi çalışmaz), `jsonb_populate_recordset` ile
  500'lük partiler, `overriding system value`, başvuru tabloları upsert,
  sequence'ler `setval`, dosyalar 0700/0600, logo öneki dönüşümü. Dolu
  hedef reddedilir; `--replace` boşaltıp yeniden yükler.
- Verify: kaynak fp = dosya fp; dosya (dönüşümlü, süzülmüş) = hedef;
  auth.users; FK yetimleri; sequence'ler; dosya sayısı/boyutu/eksik/fazla,
  rastgele 20 md5, kaynak metadata size/eTag; isteğe bağlı giriş +
  `get_session_data`. Fark varsa çıkış kodu 1.
- Runbook: `docs/migration/RUNBOOK-data.md`.

**Test:** `test/data-migration.e2e-spec.ts` (iki konteyner: seed'li kaynak
+ Supabase'in fazladan storage sütunları + açık oturum + 5 dosya + geçersiz
adlı nesne + eski logo adresi → boş hedef; sahte storage-api yalnızca GET
kabul eder): sıfır fark, kaynak parmak izi export'tan önce/sonra aynı,
eski şifreyle giriş + get_session_data, logo API'den aynı bayt ve ETag,
trigger yan etkisi yok, cron durup açılıyor, dolu hedef reddi, bozulmayı
(silinen satır, değişen dosya, yetim FK) yakalama, `--replace` ile aynı
sonuç, `--with-sessions` ile hash'li token ve yenileme, sequence ileride.
`src/data-migration/plan.spec.ts`: kapsam + export/kaynak dosyalarında
yazım SQL'i ve GET dışı yöntem yok. Prova süresi: export ~0,1 sn, import
~0,06 sn, verify ~0,15 sn.

**Bilinen eksikler / sonraki:** gerçek veriyle prova kullanıcının
kimlik bilgileriyle (runbook komutları hazır); `auth.audit_log_entries`
(5651) taşınmıyor — S16/S17 kararı; export klasörleri gitignore'da, prova
geçici klasörde yapıldı (silinecek gerçek export yok).
