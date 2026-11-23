# İlerleme

`/oturum` her oturumun başında bu dosyayı okur, sonunda günceller.

Durum değerleri: `bekliyor` · `devam` · `kısmen` (yarım kaldı; kalanlar
oturum dosyasında işaretli) · `tamam`.

| Oturum | Durum | Tarih | Not |
|---|---|---|---|
| S00 | tamam | 2026-10-25 | Plan, envanter, oturum dosyaları, `/oturum` skill'i |
| S01 | tamam | 2026-11-23 | NestJS 11 iskeleti, zod config, pino, pg+Kysely, /health, Postgres 17+pg_cron imajı, dbmate, Testcontainers e2e |
| S02 | tamam | 2026-11-23 | Kapı yayında; canlı migration kullanıcı tarafından uygulandı; mağaza sürümü 1.1.2+10 kullanıcıda |
| S03 | tamam | 2026-11-23 | Şema dump'ı + compat (roller, auth, storage, pg_notify), dbmate 0001–0004, seed, canlıyla 9 parmak izi aynı |
| S04 | tamam | 2026-11-23 | DbContextService (rol+claims+timeout), JWT doğrulama, `POST /rpc/:name` + 65'lik allow-list, PostgREST hata eşlemesi, CORS/gövde/hız sınırı |
| S05 | tamam | 2026-11-23 | Parola girişi, JWT (GoTrue claim'leri), hash'li dönen refresh token + çalınma tespiti, logout kapsamları, /auth/user, kaba kuvvet sınırları, `auth_service` rolü |
| S06 | tamam | 2026-11-23 | Kodla sıfırlama, açık kayıt + kod + resend, davet bağlantısı, `AuthAdminService`, marka başına SMTP (hook içeriği birebir), hash'li kodlar + deneme sayacı, taramasız yanıtlar, gönderim/doğrulama sınırları |
| S07 | tamam | 2026-11-23 | 26 `.from()` okuması → 23 SECURITY INVOKER fonksiyon (+ S11'e `get_notification`), allow-list `READS`; gerçek PostgREST'le 10 kullanıcıda JSON fark testi |
| S08 | tamam | 2026-11-23 | storage-api uyumlu `/storage/object/*` (yükleme/upsert, oturumlu ve public okuma, toplu silme), satırlar isteğin rolüyle (8 canlı politika aynen), disk `STORAGE_ROOT`, ad/tür/boyut/sembolik bağ korumaları |
| S09 | bekliyor | | |
| S10 | bekliyor | | |
| S11 | bekliyor | | |
| S12 | bekliyor | | |
| S13 | bekliyor | | |
| S14 | bekliyor | | |
| S15 | bekliyor | | |
| S16 | bekliyor | | |
| S17 | bekliyor | | |

## Açık sorular

Kullanıcıya sorulacak ya da ilgili oturumda karara bağlanacak konular.
Cevaplanınca buradan silinip ilgili oturumun günlüğüne yazılır.

- API alan adı: `api.mobilsporokulu.com` mu, marka başına ayrı mı? (S16)
- VPS'in boyutu ve Coolify'da çalışan diğer servisler (RAM bütçesi). (S16)
- Yedeklerin gideceği ikinci yurt içi S3 uyumlu depolama. (S16)

- S02: 1.1.2+10 mağazaya ne zaman çıkacak? (kullanıcıda)
- S02: iOS App Store adresleri (`app_min_versions.store_url`) S17'den önce
  yazılmalı.

VPS'te Coolify kurulu (2026-10-26) → PLAN.md K15, S16 buna göre yazıldı.

## Günlük

En yeni en üstte. Her oturum bir bölüm ekler: ne yapıldı, plandan sapmalar,
sonraki oturumların bilmesi gerekenler.

### S08 — Dosya depolama (2026-11-23)
- Yapılanlar: oturum dosyasındaki teslim notuna ve `docs/api/storage.md`'ye
  bakın. Orkestratörle, kullanıcıya sorulmadan çalıştırıldı; plan kararı
  (K1–K16) değişmedi, migration yok. Canlıya yalnızca salt okunur
  katalog/toplu sorgular: 8 storage politikası (0002 ile aynı), iki bucket
  (athlete-photos private 1 MB jpeg, school-logos public 2 MB png), 12 + 3
  nesne, metadata'nın 7 anahtarı ve biçimleri, `user_metadata = {}`,
  `version` uuid, logo adresinin kalıbı (2 okul). Fotoğraf indirilmedi.
- Kendi verdiğim kararlar:
  - **storage-api'nin yolları ve gövdeleri**, kök `<API>/storage`:
    `storage_client` (2.8.1) S13–S15'te yalnızca kökü değiştirerek
    kullanılabilir. Hata gövdesi `{statusCode, code, error, message}`, HTTP
    400 (storage-api'nin `userStatusCode`'u — gerçek sınıf gövdede);
    token hataları 401 + `PGRST30x` (uygulama token yeniler). Kaynağı
    storage-api'nin GitHub kodu (web'den okundu).
  - **Yetki = aynı SQL, isteğin rolüyle**: storage-api önce isteğin rolüyle
    deneme yapıp sonra süper kullanıcıyla yazıyor; biz doğrudan isteğin
    rolüyle yazıyoruz (aynı INSERT / ON CONFLICT DO UPDATE … RETURNING /
    DELETE … RETURNING), sonuç aynı. Public bucket okuması da `anon` rolüyle
    (storage-api süper kullanıcı) — politika `to public` olduğu için aynı
    sonuç, ama karar yine politikada.
  - **Dosya commit'ten önce yerine** (oturum dosyası "commit sonrası"
    diyordu) ve silmede çöpe-taşı-sonra-sil: gerekçe teslim notunda.
  - **Supabase'ten sıkı**: `..`/`.`/boş parça/gizli dosya adı, gövde imzası
    (JPEG/PNG), sembolik bağ izlenmez, geçersiz token public uç dışında 401.
  - Multipart için kendi ayrıştırıcımız: busboy Dart'ın `filename=""`
    parçasını metin alanı sayıp baytları bozuyor.
  - Sınırı aşan gövdenin kalanı okunup atılıyor (en çok 16 MB): bağlantı
    kapanınca istemci 413 yerine ağ hatası görüyordu (testte EPIPE).
  - İmzalı URL yok (uygulamalar kullanmıyor; yeni bir saldırı yüzeyi
    açmamak için yazılmadı).
- Sonraki oturumlar için:
  - S12: dosya ve satır taşıma biçimi, ad denetimi ve logo adresi SQL'i
    S12 dosyasına ve `docs/api/storage.md`'ye yazıldı.
  - S13/S15: istemci `storage_client` + `<API>/storage`; yönetimdeki
    `SessionRetryClient` storage reddini `/storage/v1/` yolundan tanıyor —
    yeni yol `/storage/`. CORS kökenleri `CORS_ORIGINS`'te (web'de logo).
  - S16: `STORAGE_ROOT` kalıcı volume (`/data/storage`, uid 1000), ayrı
    yedek; vekilin gövde sınırı ≥ 2 MB + pay. Açılışta 10 dk'dan eski
    `.tmp`/`.trash` temizlenir.

### S07 — Tablo okumaları SQL fonksiyonlarına (2026-11-23)
- Yapılanlar: oturum dosyasındaki teslim notuna ve
  `docs/migration/read-mapping.md`'ye bakın. Orkestratörle, kullanıcıya
  sorulmadan çalıştırıldı; plan kararı (K1–K16) değişmedi. Canlıya yalnızca
  bir salt okunur katalog sorgusu atıldı (`backend:` yorumlu ya da aynı adlı
  fonksiyon yok: 0 / 0).
- Kendi verdiğim kararlar:
  - **Fark testi gerçek PostgREST'le**: "aynı JSON" iddiasını elle yazılmış
    beklentilerle değil, aynı veritabanına bağlı `postgrest/postgrest:v12.2.12`
    konteynerine uygulamanın sorgusunu sorup karşılaştırarak sınadım (10
    kullanıcı × 27 durum). RLS kapsamı da böylece tek tek kural yazmadan
    bire bir sınanmış oluyor. Bedeli: e2e ilk koşuda bu imajı çeker.
  - **Sayfalı yanıt düz dizi**, `{items, total}` değil (oturum dosyası
    "ör." diyordu): `paged_query.dart` toplam kullanmıyor; `p_offset`/
    `p_limit` PostgREST'in `offset`/`limit`'i. Dart'ta yalnızca sayfa
    kapanışı değişir.
  - **Aynı okumayı yapan iki çağrı tek fonksiyon**: `fetchAttendances` ve
    `fetchClassAttendance` → `list_attendances` (gün aralığı = tek gün);
    gelen kutusu Y ve V'de aynı `list_notifications` /
    `count_unread_notifications`.
  - **Sırasız okumalar deterministik** (`created_at, id`; eşitlikte `+ id`).
  - **anon'a kapalı** (PostgREST anon'a boş liste dönerdi; bizde 401).
  - **`get_notification`** (S11 Realtime satırı) allow-list'te değil, yalnızca
    sunucu içinden `withUser`.
  - **Canlı parmak izi**: yorumu `backend:` ile başlayan fonksiyonlar
    `scripts/schema-fingerprint.sql`'den çıkarıldı (canlıda sonuç değişmez);
    sayı testi `BACKEND_ONLY.functions = 24`. Yeni bir yalnızca-backend
    fonksiyon aynı yorumu alır ve sayıyı artırır.
  - **Yönetim reposuna migration eklenmez** (kabul kriteri): fonksiyonlar
    yalnızca yeni backend'de lazım.
- Sonraki oturumlar için:
  - S11: Realtime mesajındaki `record` = `get_notification(id)` alıcı adına;
    `null` dönerse o istemciye gönderme (alıcı değil ya da pasif/silinmiş).
    Supabase Realtime'ın zaman damgası biçimi Postgres'in JSON biçiminden
    farklı olabilir; uygulamalar yalnızca `read_at`/`push_status`'un null/
    değerine bakıyor.
  - S13 (V): `fetchInbox` → `list_notifications {p_limit}`,
    `fetchUnreadCount` → `count_unread_notifications` (tam sayı döner).
  - S15 (Y): `read-mapping.md`'deki tablo; sayfalı olanlarda
    `p_offset: from, p_limit: to - from + 1`. Bir `.from()` kalmadığında
    `test/rpc-allowlist.e2e-spec.ts` her okuma fonksiyonunun `.rpc(` ile
    çağrıldığına bakar; uygulama yeni bir `.from()` eklerse (ya da bir
    okumayı değiştirirse) fonksiyon da burada eklenir/değişir ve fark
    testine bir durum eklenir.
  - Yönetim reposunda bir tablonun sütunu değişirse `*` okumaları
    kendiliğinden izler (`to_jsonb`); seçili sütunlu ve gömmeli okumalar
    elle güncellenir — fark testi bunu yakalar.

### S06 — Auth akışları ve e-posta (2026-11-23)
- Yapılanlar: oturum dosyasındaki teslim notuna bakın; sözleşme
  `docs/api/auth.md` → "Kodlu akışlar", "E-posta", "AuthAdminService".
  Orkestratörle, kullanıcıya sorulmadan çalıştırıldı; plan kararı (K1–K16)
  değişmedi. Canlıya yalnızca bir salt okunur toplu sorgu atıldı (sayılar,
  uzunluklar): 7 kullanıcı, onaysız 0, davetli 0, `one_time_tokens` 3
  (yalnızca `recovery_token`, 56/61 karakter: GoTrue'nun sha224 ve pkce
  biçimleri), kimlikler `email` sağlayıcısı.
- Kendi verdiğim kararlar:
  - **E-posta içeriği hook'tan**: Supabase'te Send Email Hook açık, yani
    bugünkü e-postalar `supabase/templates/*.html`'den değil
    `send-email/email_content.ts`'ten çıkıyor. O dosya (ve logolar) birebir
    kopyalandı; şablonlar (hook kapalıyken yedek) taşınmadı. Çıktı 28
    bileşimde karşılaştırıldı, fark yok.
  - **Kod saklama**: GoTrue'nun sütunları (`recovery_token`,
    `confirmation_token`, `one_time_tokens`) ama HMAC-SHA256 (anahtar
    JWT_SECRET'tan HKDF; ayrı sır yok — JWT_SECRET değişirse bekleyen kodlar
    düşer). Davet token'ı 32 bayt, DB'de SHA-256. Deneme sayacı ayrı tablo
    `auth.otp_attempts` (canlıyla bire bir auth tablolarına sütun eklenmedi).
  - **Süreler**: kod 600 sn, davet 86400 sn — e-posta metinleri öyle diyor
    (panel ayarı okunamıyor). Kod başına 5 yanlış deneme.
  - **Sınırlar hesap var mı bakılmadan**: aynı adrese 60 sn'de bir,
    adres başına saatte 5, IP başına saatte 30 gönderim; IP başına 5 dk'da
    30 doğrulama. Supabase bilinen adreste 429 dönerek hesabı belli
    ediyordu; bizde bilinmeyen adres de aynı sınıra takılır.
  - **Kayıt taraması**: var olan adreste sahte kullanıcı, gerçek yanıtla
    aynı şekilde (sahte kimlik dahil — Supabase'in boş `identities`'i hesabı
    belli ediyordu). Onaysız+davetsiz adrese yeniden kayıt şifreyi
    yeniler (GoTrue gibi; ön-ele-geçirme sırasında son kayıt kazanır);
    davetli hesaba kayıt dokunmaz (davet bağlantısı bozulmasın).
  - **Kayıtta sunucu metadata anahtarları** (`brand`, `created_by`,
    `created_by_manager`, GoTrue alanları) 422 — Supabase kabul ediyordu.
  - **E-posta yanıttan sonra** gider (kullanıcı tetiklediği akışlarda); hata
    loglanır. Supabase'in 4 sn hook bütçesi (`deadline.ts`) gerekmedi.
    Davette ise beklenir; kutu yoksa hiçbir şey yazılmaz, SMTP reddinde yeni
    kullanıcı silinir.
  - **Supabase'in eski biçimli davet bağlantıları** (56 karakter) geçiş
    gecesi yolda olanlar için kabul ediliyor (S17'den 24 saat sonra
    `LEGACY_INVITE_HASH` silinebilir).
  - `amr` her akışta `password` (kimse okumuyor).
- Sonraki oturumlar için:
  - S09: `AuthAdminService` (`app.get`/DI ile; `AuthModule` export eder):
    `createUser` (personel; `userMetadata.created_by` = çağıran),
    `inviteUser(email, {created_by_manager, name}, brand)` (veli; marka
    `schools.brand`'den — `schoolBrand` karşılığını S09 yazar, okunamazsa
    hata), `updateUserById`, `deleteUser` (geri alma). Hatalar
    `ApiException.code` (`email_exists`, `user_not_found`, `weak_password`).
    Hesap silme `delete_own_account`; `deleteUser` değil.
  - S10: ön kayıt aktarımındaki davetler aynı `inviteUser`.
  - S12: bekleyen kodlar/davetler taşınmaz (kısa ömürlü); `JWT_SECRET`
    değişirse bekleyen kodlar geçersiz olur.
  - S13/S14: istemci uçları `docs/api/auth.md`; sıfırlama iki adım kalır
    (verify → `PUT /auth/user`), davet sayfası verify(invite) →
    `PUT /auth/user` → `logout?scope=local`. Hata kodları bugünküyle aynı
    adlar (`otp_expired`, `over_email_send_rate_limit`, `weak_password`,
    `same_password`, `validation_failed`); yeni `email_address_invalid`.
  - S16: `SMTP_USER_DEV_ADIM`/`SMTP_PASS_DEV_ADIM`, `SMTP_USER_PUBLIC`/
    `SMTP_PASS_PUBLIC` (Supabase secrets'takiler; apex alan adı kutuları)
    Coolify env'ine; VPS'ten 465'e çıkış açık olmalı. Sayaçlar bellekte.
  - S17: e-posta gönderen artık bu backend — Supabase hook'u kapatılmadan
    önce yeni backend'in kutuları denenmeli.

### S05 — Auth çekirdeği (2026-11-23)
- Yapılanlar: oturum dosyasındaki teslim notuna bakın; sözleşme
  `docs/api/auth.md`. Orkestratörle, kullanıcıya sorulmadan çalıştırıldı;
  karar gerektiren konu çıkmadı. Canlıya yalnızca salt okunur, toplu
  sorgular atıldı (hash önekleri/maliyetleri, oturum ve refresh token
  sayıları/uzunlukları): 7 kullanıcı, hepsi `$2a$` (3'ü maliyet 10 —
  GoTrue; 4'ü maliyet 6 — pgcrypto ile elle eklenmiş demo hesapları),
  onaysız/yasaklı/silinmiş yok; 55 oturum, refresh token'lar 12 karakter
  düz metin.
- Kendi verdiğim küçük kararlar:
  - **Ayrı DB rolü `auth_service`** (0005): auth modülü auth tablolarına
    service_role ile değil, yalnızca o tablolara (ve `auth.users`'ta dört
    sütunun güncellemesine) yetkili, bypassrls olmayan bir rolle erişir.
    Hiçbir token bu role çözülmez.
  - **Refresh token DB'de SHA-256** (oturum dosyası "hash'li" diyordu).
    Bedeli: GoTrue'nun "yanıtı kaybolan yenilemede geçerli token'ı geri
    ver" kuralı uygulanamaz (düz metin yok); onun yerine geçerli token da
    döndürülüp yenisi verilir. Kabul kuralları GoTrue'nunkiyle aynı:
    geçerli token'ın ebeveyni süresiz (çevrimdışı salon), başka iptal
    edilmiş token 10 sn içinde; dışında **oturum silinir**
    (`refresh_token_already_used`) — GoTrue yalnızca token'ları iptal eder,
    biz oturumu da kapatıyoruz (`/auth/user` da düşsün).
  - **bcryptjs** (saf JS, yerel derleme yok); yeni hash'ler `$2a$10$`
    (bcryptjs'in `$2b$`'si yeniden adlandırılır — pgcrypto ve GoTrue okur,
    e2e'de pgcrypto ile sınandı).
  - **Şifre kuralı**: ≥ 6 karakter, ≤ 72 bayt, tür şartı yok. Supabase'in
    auth ayarları SQL ile okunamıyor; değer yönetim AGENTS.md'sinden
    ("Password rule", Supabase'in varsayılanı). PLAN.md K8'e yazıldı.
    Kullanıcı panelde farklı bir değer gördüyse `password-policy.ts`
    tek satır.
  - **Kaba kuvvet**: IP başına 30/5 dk (Supabase), IP+e-posta 10 yanlış/
    15 dk, e-posta başına 20 yanlış/saat (dağıtık tahmin; bedeli: biri bir
    hesabı bilerek bir saat kilitleyebilir). Hepsi bcrypt'ten önce ve hesap
    olup olmadığına bakmadan; bilinmeyen e-postada da maliyet-10 bcrypt
    (zamanlama testi var). Bellekte, tek süreç.
  - **Çıkış süresi geçmiş token'ı kabul eder** (imza doğruysa); çıkış
    erişimi yalnızca azaltır. Kapsam sorguda (`?scope=`, supabase-dart) ya
    da gövdede.
  - **Şifre değişince diğer oturumlar kapanır** (GoTrue gibi).
  - **`PUT /auth/user` `data`**: sunucunun yazdığı ve SQL'in güvendiği
    metadata anahtarları (`brand`, `created_by`, `is_creator` …)
    değiştirilemez — Supabase'te açıktı (`save_staff_profile`
    `created_by`'a güveniyor). Uygulamalar `data` göndermiyor.
  - Access token durumsuz (`/rpc/*` oturuma bakmaz), Supabase gibi.
  - Hata gövdesi `{code, message}`, `code` = GoTrue `error_code`; HTTP
    durumları GoTrue'nunkiler. Yasaklı kullanıcının yenilemesi 403
    `user_banned`.
- Sonraki oturumlar için:
  - S06: `AuthService.respond` mantığı (oturum + refresh + yanıt) verify
    uçlarında da kullanılmalı — `signInWithPassword`'un oturum açan kısmı
    bir yardımcıya çıkarılabilir. `auth_service`'e insert (users,
    identities), `recovery_token` vb. sütun güncellemeleri yeni migration'la
    eklenir; `test/schema.e2e-spec.ts`'teki yetki listesi güncellenir.
    Yeni şifre `PasswordHasher.hash` + `passwordPolicyError`.
  - S09: `delete_own_account` oturumları siliyor → refresh
    `refresh_token_not_found`, `/auth/user` `session_not_found` (sınandı,
    oturum silme taklidiyle).
  - S12: Supabase'in refresh token'ları 12 karakter düz metin. Açık
    oturumlar taşınacaksa `token` ve `parent` **SHA-256'ya çevrilerek**
    kopyalanmalı (`encode(sha256(token::bytea), 'hex')`), yoksa hiçbiri
    eşleşmez; `JWT_SECRET` de Supabase'inki olmalı.
  - S13/S14: istemci `POST <api>/auth/token?grant_type=…`, `/auth/logout?scope=`,
    `/auth/user`; hata `code`'u bugünkü `AuthException.code` yerine. RPC'de
    401 `PGRST303` → yenile → tekrar (bugünkü `SessionRetryClient`); yenileme
    400/403 → oturum bitti, ağ hatası → geçici.
  - S16: `TRUST_PROXY` IP sınırları için de şart; `JWT_ISSUER`; çok süreçte
    sınır sayaçları paylaşılmaz.

### S04 — DB istek bağlamı ve RPC kapısı (2026-11-23)
- Yapılanlar: oturum dosyasındaki teslim notuna bakın. Orkestratörle,
  kullanıcıya sorulmadan çalıştırıldı; karar gerektiren konu çıkmadı.
- Allow-list: iki uygulamanın `.rpc(` çağrılarından çıkarıldı — yönetim 61,
  veli 10 (envanterdeki 9 + S02'nin `get_min_app_version`'ı), toplam **65**;
  INVENTORY ile fark yok. Hepsi `jsonb` döner, hiçbiri overload'lu değil.
  Yerel veritabanının ACL'leri canlıyla aynı (S03 parmak izi) olduğu için
  yetkiler yerelden okundu; canlıya bakmak gerekmedi.
- Kendi verdiğim küçük kararlar:
  - **Ayrı bağlantı adresi** `API_DATABASE_URL` (api_authenticator); API
    `DATABASE_URL`'i artık kullanmıyor (yalnızca dbmate). Yerel parola
    `npm run db:api-password`; docker compose'un api profili
    `API_DATABASE_URL_DOCKER` (varsayılanı .env.example'daki yerel parola).
  - **`callers` veritabanı yetkilerinin aynısı**: anon yalnızca
    `get_min_app_version` ve üç `public_get_*_by_token`; dördü authenticated'a
    da açık (DB'de de öyle). Allow-list DB'nin önünde ikinci kapı; test
    ikisinin ayrışmasını yakalıyor.
  - Allow-list dışı ad → 404 `PGRST202` (varlık sızmasın); rolü uymayan →
    DB'nin cevabıyla aynı (anon 401 / authenticated 403, `42501`).
  - **Token kuralları**: `role: anon` token'ı (Supabase anon anahtarı) anon
    sayılır; `service_role` ve rolsüz/başka rol token'ları 401 `PGRST303` —
    service_role yalnızca sunucu içinden. Guard global değil, uç başına
    (`/health` ve S05'in `/auth/*`'ı süresi geçmiş token'la çağrılabilsin).
  - Parametre çevirme `json_to_record` ile (PostgREST'in yöntemi): diziler,
    enum'lar, jsonb, tarihler aynı kurallarla çevrilir; SQL'e giren ad/tip
    yalnızca `pg_proc`'tan.
  - Rol başına `statement_timeout`: anon 3 sn, authenticated 8 sn
    (Supabase), service_role 60 sn; `run(..., { statementTimeoutMs })` ile
    çağrı başına değiştirilebilir.
  - Hız sınırı varsayılanı 600 istek/dk/IP (salon Wi-Fi'ı arkasında çok
    cihaz), gövde 1 MB; Coolify'da `TRUST_PROXY=1` gerekecek (S16).
  - `x-powered-by` kapatıldı (S01'in S16'ya bıraktığı not).
- Sonraki oturumlar için:
  - S05: `JwtVerifier`'ın kabul ettiği token = S05'in üreteceği token
    (HS256, `role: authenticated`, `aud: authenticated`, UUID `sub`; claim
    adları `test/support/tokens.ts` → `supabaseUserToken`). Auth uçlarına
    `RequestAuthGuard` takılırsa süresi geçmiş token 401 olur — logout /
    refresh bunu bilerek seçmeli. `JWT_SECRET` canlıdakiyle aynı verilirse
    Supabase'in açık oturumları da geçer (e2e'de sınandı) — karar S12/S17.
  - S07: yeni okuma fonksiyonları `RPC_ALLOWLIST`'e `callers: USER`,
    `apps: [...]` ile; `test/rpc-allowlist.e2e-spec.ts` endpoint.dart'ta
    `.rpc(` ile çağrılanlara bakıyor — S14/S15'te `.from()` çağrıları
    `.rpc(`'ye dönünce liste kendiliğinden tutarlı olmalı. `setof`
    dönüşler dizi olarak çıkar (test edildi).
  - S08–S11: sunucu işleri `DbContextService.withRole('service_role', …)`
    (RLS'i aşar) ya da kullanıcı adına `withUser(auth.claims, …)`; SQL
    hatası için `isPgError` + `pgErrorToApiException`.
  - S13/S14: istemci `POST <api>/rpc/<ad>` (gövde aynı, `Authorization:
    Bearer`), hata gövdesi PostgREST'inkiyle aynı alanlar.
  - S16: `TRUST_PROXY`, `CORS_ORIGINS` (üretim kökenleri), api_authenticator
    parolası, hız sınırı tek süreç varsayımı.

### S03 — Veritabanı tabanı (2026-11-23)
- Yapılanlar: oturum dosyasındaki teslim notuna bakın. `npm run db:migrate`
  boş veritabanına canlı şemanın aynısını kuruyor; `test/schema.e2e-spec.ts`
  sayıları ve dokuz parmak izini (fonksiyon gövdeleri + ACL'ler, politikalar,
  trigger'lar, tablo ACL/RLS, sütunlar, index'ler, kısıtlar, storage
  politikaları, cron) canlıdan alınmış sabitlerle karşılaştırıyor — hepsi
  aynı. Tek bilinçli fark: `request_push_dispatch()` (pg_net + Vault →
  `pg_notify('push_dispatch', '')`).
- Kullanıcı eylemi gerekmedi: `supabase db dump --project-ref <ref>`
  parolasız çalıştı (CLI geçici giriş rolü + IPv4 pooler). Dump'a girmeyenler
  Supabase MCP ile salt okunur sorgularla alındı. Canlıya yazılmadı.
- S02 migration'ı (`20261027_app_min_versions.sql`) oturum sırasında
  kullanıcı tarafından canlıya uygulandı (orkestratör doğruladı). Önce
  `0005_app_min_versions.sql` olarak taşınmıştı; canlıda olduğu için dump
  yeniden alındı ve baseline'a girdi, 0005 silindi, 8 satırı
  `0004_reference_data.sql`'e eklendi. S02 satırı `tamam` yapıldı.
- Docker Compose sorunu (S01 açık sorusu) kullanıcı tarafından çözüldü
  (Homebrew docker-compose/buildx, `cliPluginsExtraDirs`, `credsStore`
  yok); açık sorulardan silindi, AGENTS.md'deki geçici çözüm notu kısaltıldı.
- Kendi verdiğim küçük kararlar:
  - **Collation**: canlı veritabanı ICU `en-US`; imajımız libc
    `en_US.utf8` ile kuruluyordu ve sıralama farklıydı (`_`, büyük/küçük
    harf). `docker/postgres/Dockerfile`'a `POSTGRES_INITDB_ARGS` (ICU en-US)
    ve `timezone = 'UTC'` eklendi. Var olan yerel volume'lar eski
    collation'ı korur → `docker compose down -v`.
  - **Başvuru verisi migration'ı (0004)**: `roles`, `role_permissions`,
    `app_min_versions` kişisel veri değil ama şemanın çalışması için şart;
    dump veri taşımadığı için canlıdan elle alındı.
  - **auth tabloları canlıdaki sütunlarla bire bir** (oturum dosyası alt
    küme diyordu): S12 tablo tablo kopyalayabilsin. `mfa_factors` ve
    `one_time_tokens` da var (`delete_own_account` bunlardan siliyor).
  - **storage tabloları canlının alt kümesi** (sürümleme/yaşam döngüsü
    sütunları yok); politikalar, yetkiler ve fonksiyonlar bire bir.
  - **9 cron işi**: canlıda migration'larda olmayan `expire_trials_job`
    (panelden açılmış) da var; alındı. INVENTORY'deki `0 17 * * *`
    zamanlaması canlıda yok.
  - **pg_stat_statements kurulmadı** (şema kullanmıyor, shared_preload ister).
  - Baseline **üretilmiş dosya** (`scripts/build-baseline.mjs`); compat
    kaynakları okunur dosyalar olarak `db/compat/`'ta.
  - Yönetim migration'ı taşıma aracı: `scripts/import-migration.mjs`
    (üst düzey begin/commit'i atar, `_rollback/` dosyasını `down`'a koyar).
  - `api_authenticator` parolasız oluşturuldu (sır repoya girmez).
  - Supabase CLI backend reposunda `supabase/.temp/` bırakıyor → gitignore.
- Sonraki oturumlar için:
  - S04: `api_authenticator`'a parola ver (env), DbContextService testte
    `asRole()` yardımcısının yaptığını yapar; seed: `startTestDatabase({
    seed: true })`, kimlikler `test/fixtures/seed-ids.ts` (şifre `Test1234!`).
  - S05: `auth.*` tabloları GoTrue'nunkiyle aynı; e-posta tekilliği
    `users_email_partial_key` (SSO dışı). `auth.users` insert'i
    `handle_new_user` trigger'ını tetikler (yalnızca `is_creator`).
  - S11: kanal `push_dispatch`, yük boş. Realtime yayını yok.
  - S12: yukarıdaki notlar S12 dosyasına eklendi (üretilen sütunlar,
    başvuru tabloları kopyalanmaz, audit_log_entries).
  - Yönetim reposuna yeni migration gelirse: AGENTS.md → "Schema sync".

### S02 — Zorunlu güncelleme kapısı (2026-11-23)
- Yapılanlar: oturum dosyasındaki teslim notuna bakın. Kod Y ve V `main`
  dallarında; migration `../mobil_spor_okulu/supabase/migrations/20261027_app_min_versions.sql`.
- **Kapıyı taşıyan sürümler (S17 bunu kullanır):** yönetim ve veli
  **1.1.2+10** (build 10), iki marka, Android + iOS — mağazaya çıktığında.
  Build ≤ 9 kapı taşımaz; onlar `min_build` ile durdurulamaz. Geçiş gecesi:
  `update public.app_min_versions set min_build = <yeni backend'e bağlı ilk
  build> where …;` (Supabase'te). Yükseltmeden önce iOS satırlarına
  `store_url` yazılmalı, yoksa iOS'ta "Güncelle" düğmesi çıkmaz.
- Kendi verdiğim küçük kararlar:
  - Anahtara **`brand`** eklendi (oturum dosyası `(app, platform)` diyordu):
    iki marka mağazaya ayrı zamanlarda çıkıyor; tek değer, son sürümü daha
    eski markanın güncel kullanıcılarını da kilitlerdi. RPC üç parametreli:
    `get_min_app_version(p_app, p_platform, p_brand)`; brand = derlemenin
    markası (`AppConfig.brand.key`).
  - RPC **SECURITY INVOKER** + tabloya `anon`/`authenticated` select
    politikası: 20261016 ve 20261017'nin denetim blokları `anon`'a açık
    SECURITY DEFINER fonksiyonu reddediyor (yeniden çalıştırınca patlardı).
  - Açılışa ek olarak **öne gelişte** (30 dk aralıkla) de soruluyor:
    arka planda açık kalan eski uygulama da geçişte durdurulsun.
  - Zaman aşımı 3 sn (çevrimdışı salon açılışı uzamasın); her hata açar.
  - `AppStatus.updateRequired` yapışkan: `setStatus` ondan çıkmaz.
  - Sürüm 1.1.2+10 (memory kuralı: patch ve build +1, iki uygulama birlikte).
  - Y'ye `url_launcher` eklendi; iki manifest'e `https` VIEW `<queries>`.
- Sonraki oturumlar için:
  - S03: şema dump'ında `app_min_versions` ve `get_min_app_version` gelir
    (canlıya uygulandıysa). Yeni backend'de de `anon` çağırabilmeli
    (K6 allow-list'ine `get_min_app_version` herkese açık olarak).
  - S13/S14: istemci `RpcEnvelope` ile okuyor; yeni backend aynı zarfı
    dönerse değişiklik gerekmez.
  - S17: yukarıdaki SQL; geçişten önce Supabase'teki `min_build` ile yeni
    backend'deki aynı tablonun değeri ayrı ayrı düşünülmeli (yeni backend'e
    bağlı build'ler yeni backend'den soracak).

### S01 — Temel iskelet (2026-11-23)
- Yapılanlar: oturum dosyasındaki teslim notuna bakın. Canlı Supabase
  Postgres **17.6** → K4 = 17 (PLAN.md güncellendi). Canlıda kurulu
  eklentiler: pg_cron 1.6.4, pg_net, pg_stat_statements, pgcrypto,
  supabase_vault, uuid-ossp; imajımızda pg_cron (1.6) + contrib var, pg_net
  ve vault yok (K10).
- Kendi verdiğim küçük kararlar:
  - **Kysely 0.28.x** sabitlendi: 0.29 yalnızca ESM, Jest (CJS + ts-jest)
    yükleyemiyor. Uygulama 0.29 ile de çalışıyordu.
  - NestJS **11** (npm'de 12 var; K1 11 diyor). TypeScript **5.9** (7.x
    ts-jest/typescript-eslint ile uyumsuz). ESLint 9.
  - dbmate **npm paketi** (Docker imajı değil); `--no-dump-schema`, yerelde
    `pg_dump` gerekmez. `0000_init.sql` no-op (boş klasörde `up` hata verir).
    `db:new` zaman damgalı ad üretir, `0001_baseline.sql`'den sonra sıralanır.
  - Veritabanı adı `postgres` (Supabase gibi), `cron.database_name` da o.
  - `@nestjs/config` yerine kendi `ConfigModule`'ümüz (`APP_CONFIG` token'ı,
    zod); `.env`'i `main.ts` `process.loadEnvFile` ile okur, testler ortamı
    kendi kurar.
  - `npm run lint` artık yalnızca denetler (`--fix` yok); `lint:fix` ayrı.
  - `no-explicit-any`, `no-floating-promises`, `no-unsafe-argument` hata
    seviyesinde.
- Sonraki oturumlar için:
  - Yeni env anahtarı → `src/config/env.schema.ts` + `.env.example` birlikte.
  - Hata gövdesi `ApiException.of(status, code, message, {details, hint})`;
    SQL hatası eşlemesi S04'te `toApiError`'a eklenecek.
  - Kysely'nin `destroy()`'u havuzu yalnızca Kysely bir sorgu çalıştırdıysa
    kapatır; `DbModule` havuzu ayrıca kapatıyor — S04 bunu bozmasın (e2e
    testi "uygulama kapanınca veritabanı havuzu kapanır" yakalar).
  - Postgres imajı Coolify'da da bu Dockerfile'dan (S16). API imajına
    dbmate girmiyor (dev bağımlılığı); üretimde migration'ın nasıl
    çalışacağı S16'nın kararı.
  - Express `x-powered-by` başlığı açık → S16 sertleştirme.
  - e2e testleri: `npm run test:e2e` yeterli; colima ayarlarını
    `test/support/docker-env.ts` kendisi yapar (AGENTS.md → "Docker on this Mac").

### Karar — PocketBase karşılaştırması (2026-11-22)
- Soru: public flavor PocketBase'e, Dev Adım Supabase'te mi kalsın? Karar:
  **hayır, iki marka birlikte NestJS'e** (PLAN.md K16).
- RAM ölçümü (colima, arm64; 1,5 M yoklama satırı; aynı uç nokta: sporcunun
  yoklama sayıları, PocketBase'te JS hook, NestJS'te transaction +
  `set_config('request.jwt.claims')`; cgroup `anon+file−inactive_file`):

  | Senaryo | PocketBase 0.40.6 | Postgres 17 + NestJS 11 |
  |---|---|---|
  | Boşta | 72 MB | 17 + 32 = 49 MB |
  | ~40 istek/sn | 137 MB | 58 + 66 = 124 MB |
  | 20 eşzamanlı (~5000 istek/sn) | 710–910 MB, yük bitince geri vermedi | 158 + 99 = 257 MB |
  | Aynısı, `shared_buffers=32MB`, `max_connections=25`, `work_mem=2MB` | — | 55 + 101 = 156 MB (~3700 istek/sn) |

  `GOMEMLIMIT` ve küçük `--hooksPool` PocketBase'in büyümesini durdurmadı.
  Ölçülen NestJS tek uç noktalıydı; gerçek API (auth, mail, firebase-admin,
  ws) boşta muhtemelen 80–150 MB olur. S16 RAM bütçesinde bu sayılar ve
  küçük Postgres ayarları kullanılabilir.

### S00 — Hazırlık (2026-10-25)
- Repo açıldı; `AGENTS.md`, `docs/migration/{PLAN,INVENTORY,PROGRESS}.md`,
  17 oturum dosyası ve `.claude/skills/oturum/` yazıldı.
- Envanter iki uygulamanın `lib/` ve yönetim uygulamasının `supabase/`
  klasörlerinden çıkarıldı (`INVENTORY.md`). Canlı veritabanına bakılmadı;
  S03 dump'ı alınca eksikleri tamamlar.
- Henüz kod yok; `AGENTS.md` → "Commands" bölümündeki komutları S01 kurar.
