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
- [ ] `scripts/export/`: public şema verisi (`supabase db dump --linked
      --data-only`), `auth.users` (yalnızca S03'teki sütunlar; salt okunur
      sorgu), `storage.objects` satırları ve iki bucket'ın bütün dosyaları
      (service role ile yalnızca okuma/indirme). Çıktı `exports/<tarih>/`
      (gitignore); bitince sayıları ve toplam boyutu yazan bir özet.
- [ ] `scripts/import/`: boş ve migrate edilmiş bir veritabanına yükleme
      (trigger'lar ve bildirim üreten yan etkiler yükleme sırasında kapalı —
      ör. `session_replication_role = replica`), sequence'lerin
      ayarlanması, dosyaların `STORAGE_ROOT`'a kopyalanması, logo URL'lerinin
      yeni biçime çevrilmesi.
- [ ] `scripts/verify/`: tablo başına satır sayısı karşılaştırması,
      `auth.users` sayısı, dosya sayısı ve toplam boyut, rastgele 20
      dosyanın hash karşılaştırması, test hesabıyla giriş + `get_session_data`.
- [ ] Yerel prova: export → import → verify uçtan uca; süreyi ölç (geçiş
      penceresi tahmini) ve günlüğe yaz.
- [ ] `docs/migration/RUNBOOK-data.md`: komutlar sırasıyla, beklenen
      çıktılar, sorun olursa ne yapılacağı.
- [ ] Export klasörlerinin prova sonrasında silinmesi (kişisel veri).

## Kapsam dışı
VPS üzerinde çalıştırma (S16/S17).

## Kabul kriterleri
- Prova sonunda verify sıfır fark veriyor (farklar gerekçeli).
- Hiçbir script canlı Supabase'e yazmıyor (kod incelemesiyle doğrula).

## Teslim notu
_(oturum sonunda doldurulur)_
