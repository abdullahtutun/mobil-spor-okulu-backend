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
| S09 | tamam | 2026-11-23 | `POST /functions/{create-user,update-user,create-parent,update-parent,delete-account}`, Edge gövdeleri/kodları bire bir, denetim sırası aynı; 61 e2e (hiyerarşi, yetki, şube, kendi hesap, rol 8, e-posta değişikliği, son genel müdür, hız sınırı) |
| S10 | tamam | 2026-11-23 | `POST /functions/{submit-pre-registration,convert-pre-registration,bulk-convert-pre-registrations,site-lead}`, Edge gövdeleri/kodları ve denetim sırası aynı; IP özeti + trust proxy; 50 e2e (sınırlar, token, kapsam, kardeş veli, ILIKE, geri alma, CORS) |
| S11 | tamam | 2026-11-23 | `GET /realtime` (WS, ilk mesajla token, kendi kanalı, her olay abone adına RLS'le), 0009 notifications trigger'ı → pg_notify, PgListener, send-push portu (sahte FCM ile), 9 cron komutu testli; 59 e2e |
| S12 | tamam | 2026-11-23 | `src/data-migration/` export (salt okunur tek anlık görüntü) / import (replica, cron durur, logo öneki) / verify (parmak izi, FK, sequence, dosya md5, giriş); iki konteynerli prova sıfır fark; `RUNBOOK-data.md` |
| S13 | tamam | 2026-11-23 | Veli `migrate/own-backend`: `supabase_flutter` yerine `AuthSession` + `ApiClient` + `RealtimeClient`; 178 test, yerel backend + seed'e karşı uçtan uca veri kaynağı testi |
| S14 | tamam | 2026-11-23 | Yönetim `migrate/own-backend`: auth akışları `AuthSession`'da, bütün `.rpc(` `ApiClient.rpc`'de; `.from`/storage/functions/realtime S15'e kadar Supabase istemcisinde (dal arada kullanılamaz); 1219 test + yerel backend'e karşı gerçek e-posta koduyla uçtan uca |
| S15 | tamam | 2026-11-25 | Yönetim `migrate/own-backend`: `supabase_flutter` çıktı (okumalar, storage, functions, realtime backend'de, yerel türler); site formu `/functions/site-lead`'e; 1235 test + iki e2e koşusu. Aydınlatma metni 2026-11-25 (sürüm iki uygulamada + site) |
| S16 | kısmen | 2026-11-24 | Repo tarafı: girişte migration + parola (tini), güvenlik başlıkları, restic yedek/geri yükleme/aylık test + systemd, restore e2e, `docs/ops/{deploy,server-setup,backup}.md`. Kalan: sunucu/DNS/S3/sırlar kullanıcıda |
| S17 | kısmen | 2026-11-25 | Hazırlık bitti: `RUNBOOK-cutover.md`, dallar `main`'de (Y/V/site), sürüm 1.1.3+11, yedek 30 gün. Geçiş kullanıcıda |

## Açık sorular

Kullanıcıya sorulacak ya da ilgili oturumda karara bağlanacak konular.
Cevaplanınca buradan silinip ilgili oturumun günlüğüne yazılır.

- **S16 (kullanıcıya soruldu 2026-11-24, `docs/ops/deploy.md`):**
  VPS sağlayıcısı/şehri/boyutu ve üzerindeki diğer servisler; API alan adı
  (öneri `api.mobilsporokulu.com`, uygulamalar ve site bunu yazıyor) ve
  DNS'in kimde olduğu; Coolify paneli alan adı; repo'nun Coolify'a erişimi
  (şu an git remote yok); ikinci lokasyon S3 (sağlayıcı/şehir) ve saklama
  (7 gün/4 hafta/6 ay); izleme aracı ve bildirim kanalı; prova verisi
  provadan sonra silinsin mi. **Cevaplananlar (2026-11-25):** VPS
  hosting.com.tr, Türkiye; yedekler şimdilik aynı VPS'te (restic yerel +
  Coolify yerel, ikinci lokasyon yok); API `api.mobilsporokulu.com`
  (Coolify/Traefik); izleme UptimeRobot (yalnızca `/health`); DNS
  sağlayıcısı bilinmiyor; Supabase'teki veri yalnızca demo.
- S02: iOS App Store adresleri (`app_min_versions.store_url`) S17'den önce
  yazılmalı.
- S11: send-push `data` sızıntısı yönetim reposunda düzeltildi
  (`send-push/data_params.ts`, kullanıcı onayıyla); dağıtım kullanıcıda:
  `supabase functions deploy send-push --no-verify-jwt`.
- S16: Coolify'a girilecek sırlar kullanıcıdan: `FCM_SERVICE_ACCOUNT`, `IP_HASH_SALT`, `SITE_LEAD_NOTIFY_TO`, iki markanın SMTP kutusu (Supabase secrets'taki değerler; `deploy.md` §5).

VPS'te Coolify kurulu (2026-10-26) → PLAN.md K15, S16 buna göre yazıldı.

## Günlük

En yeni en üstte. Her oturum bir bölüm ekler: ne yapıldı, plandan sapmalar,
sonraki oturumların bilmesi gerekenler.

### S17 — Geçiş hazırlığı (2026-11-25)
- Kullanıcı (2026-11-25): Supabase verisi demo, mağaza uygulamalarını
  kimse kullanmıyor → ayrı prova, bakım duyurusu, eski auth log arşivi yok;
  Supabase yeni sistem doğrulanınca silinebilir. Üretim API'si canlı
  (`api.mobilsporokulu.com`, DB'de yalnızca şema); yedekler Coolify yerel
  (7 kopya) + restic yerel; saklama **30 gün** seçildi.
- Yedek: `backup.sh` `restic forget --keep-within ${KEEP_WITHIN:-30d}`
  (KEEP_DAILY/WEEKLY/MONTHLY kalktı, okunmuyor); `backup.env.example`
  yerel depoyu varsayılan yaptı; `docs/ops/backup.md` bugünkü kuruluma
  göre yeniden yazıldı (§6: S3 ikinci lokasyon sonraki iş). Aydınlatma
  metni §9 yedek satırı "en fazla 30 gün" (Y+V birebir, sürüm aynı);
  sitede yedek süresi geçmiyor.
- `RUNBOOK-cutover.md`: Supabase cron (`update cron.job set active=false`)
  ve push dürtmesi (Vault `push_dispatch_url` adını değiştirerek) SQL'leri,
  veri aracı API konteynerinde `docker exec` ile (`/tmp/exports`,
  `MIGRATE_ON_START`'a dokunulmaz), smoke, web paketleri, mağaza
  sürümleri, kapı sırası, geri alma, Supabase silme.
- **Kapı:** 1.1.2+10 Supabase'e, 1.1.3+11 yeni backend'e sorar. Import
  `app_min_versions`'ı Supabase değeriyle günceller → Supabase'te
  `min_build = 11` **en son** (mağaza yayınından sonra), yeni DB'de ≤ 11.
- Dallar `main`'e alındı (yerel, push yok): yönetim (main'deki a05d103 ile
  birleştirme, çakışma yok), veli ve site ileri sarma. Sürüm 1.1.3+11
  (iki uygulama). AGENTS.md'lerin başına backend notu; `supabase/` salt
  okunur `supabase/README.md` ile kalır, Supabase kapanınca silinir;
  AGENTS.md'deki Supabase bölümlerinin ayıklanması sonraya.
- Kabul: dalda Y `flutter test` 1235, V 178, site build 29 sayfa + 104;
  `main`'de birleştirmeden sonra Y 1243, V 178, site 104; analyze iki
  uygulamada hata yok (Y 46 uyarı/info, V 3 info — öncekiyle aynı tür).
  Backend: lint temiz, `npm test` 181, `npm run test:e2e` 693. Allow-list
  e2e testi artık `ApiClient.read(xRpc)` ve `fetchAllRpc(api, xRpc)`
  çağrılarını da tanıyor (yönetim `main`'e alınınca 25 okuma "yetim" görünüyordu).

### 5651 erişim kaydı + aydınlatma metni (S15 kalanı) (2026-11-25)
- Kullanıcı kararları (2026-11-25): VPS hosting.com.tr (Türkiye, şehir
  belirtilmedi), yedekler aynı sağlayıcıda, ikinci lokasyon yok; izleme
  UptimeRobot; yurt dışı hizmetler Firebase (push), Hostinger (e-posta),
  UptimeRobot (kişisel veri yok); Supabase geçişten sonra kalkar; yeni
  metin geçiş tamamlandığında geçerli, güncel metin olarak yazıldı.
  **Supabase'teki veri yalnızca demo**: `auth.audit_log_entries`'in
  arşivlenmesi (eski öneri) gerekmiyor, yapılmadı.
- Backend: `0010_access_log.sql` — `auth.access_log` (zaman, olay
  `password|otp|invite|refresh|password_failed`, kullanıcı/oturum kimliği,
  IP, user agent; e-posta/token yok), RLS açık, tek politika
  `auth_service` INSERT, istek rollerine yetki yok; `auth.purge_expired_access_log()`
  + cron `backend_access_log_purge` (01:15 UTC, 1 yıl). Yazan yerler:
  `SessionOpener.open` (oturumla aynı transaction), `AuthService.refresh`,
  başarısız parola girişi (ayrı transaction, hata yanıtı değiştirmez).
  auth şemasında olduğu için public parmak izleri değişmedi; fingerprint
  betiği `backend_` cron işlerini dışarıda bırakıyor, `BACKEND_ONLY.cronJobs = 1`,
  auth_service yetki listesine `auth.access_log: INSERT`, bildirim testinin
  cron listesine yeni iş.
- Aydınlatma metni (sürüm `2026-11-25`, yönetim + veli `migrate/own-backend`,
  birebir kopya): Supabase satırı çıktı; barındırma Türkiye (hosting.com.tr),
  yedekler aynı sağlayıcıda Türkiye'de şifreli; yurt dışı tablosu Firebase,
  Hostinger (iki gönderici adresi), Apple/Google; UptimeRobot kişisel veri
  almadan izleme; sağlık verisi yurt dışına çıkmıyor; erişim kayıtları 1
  yıl (5651), işlem logları 1–2 yıl kaldı; **yedek satırı 30 gün → 6 ay**
  (restic 7 gün / 4 hafta / 6 ay; eski metin bununla çelişiyordu).
  Yürürlük tarihi 25.11.2026 yazıldı — geçiş günü farklıysa iki uygulamada
  satır ve sürüm o güne çekilmeli. `tool/render_privacy_policy.dart` ve
  testler değişiklik istemedi. Site: aydınlatma metni "Aktarım" bölümü,
  `features.ts` (iki yer) ve `faq.ts` (bir yer) Türkiye'ye çevrildi.
- Kabul: backend lint, typecheck, `npm test` 181, `npm run test:e2e` 693;
  yönetim `flutter test` 1235 (analyze: hata yok), veli 178 (analyze: hata
  yok); site `npm run build` (29 sayfa) + `npm test` 104.
- Sonrakiler için: canlıya uygulanmayacak (yalnızca backend). Yedekler
  ikinci lokasyona taşınırsa (yurt dışı S3 gibi) aydınlatma metni ve sürüm
  değişir. Coolify'ın DB yedeği ve restic aynı VPS'te: disk kaybında ikisi
  birden gider — ikinci lokasyon hâlâ açık iş.

### S16 — Üretim dağıtımı, yedekleme, izleme (2026-11-24)
- Yapılanlar: oturum dosyasındaki teslim notuna ve `docs/ops/`'a bakın.
  Orkestratörle, kullanıcıya sorulmadan çalıştırıldı; repo'da yapılabilen
  her şey yapıldı, sunucuya/DNS'e/S3'e dokunulmadı, canlı Supabase'e hiçbir
  sorgu atılmadı. Plan kararı (K1–K16) değişmedi. Durum **kısmen**: üç
  kabul kriteri de sunucuda doğrulanacak.
- Kendi verdiğim kararlar:
  - **Migration açılışta** (pre-deploy değil): Coolify'ın pre-deployment
    komutu çalışan eski konteynerde koşar, yeni migration dosyaları orada
    yok. Tek replika; bir adım düşerse yeni konteyner sağlıksız kalır ve
    Coolify eskisini bırakır. Aynı yerde `api_authenticator` parolası
    yazılır (geri yüklenen yedekte rol parolası yok).
  - **`dbmate` `dependencies`'e** taşındı (imajda migration için).
  - **tini** (Coolify `--init` vermiyor); kapanış 0,3 sn, SIGTERM Nest'e
    ulaşıyor.
  - **Güvenlik başlıkları API'de** (vekil label'ı yerine): Coolify'a özgü
    yapılandırma olmadan testlenebilir; CORP yok (logolar e-postada).
  - **İki yedek**: Coolify'ın DB yedeği (panel) + restic (DB'nin ikinci
    kopyası ve Coolify'ın almadığı storage volume'u), aynı S3'te ayrı
    önek, restic istemci tarafında şifreli. Geri yükleme hedefi daima boş,
    projenin imajından bir küme.
  - **`roles.sql` ayrı dosya**: rolleri `00_roles.sql` + 0005'ten toplar;
    e2e roller dahil karşılaştırdığı için kayma testte düşer.
  - **Bellek ayarı `ALTER SYSTEM`** ile (`tuning.sql`): Coolify'ın özel
    config alanı pg_cron preload'unu ezer.
  - **Bellekteki hız sınırları kabul** (tek replika, dağıtımda sıfırlanır);
    ikinci replikada ne taşınacağı `deploy.md`'de.
  - **DNS vekilsiz** önerisi (Cloudflare turuncu bulut TLS'i yurt dışında
    açar; aydınlatma metnini de değiştirir, `TRUST_PROXY` 2 olur).
- Kabul (repo): lint, typecheck, `npm test` 181, `npm run test:e2e` 689
  (yeni: geri yükleme + güvenlik başlıkları); imaj yerelde build + boş
  DB'de açılış; restic betikleri yerelde bir kez.
- Sonraki oturumlar için:
  - S16'nın kalanı: kullanıcı cevaplarıyla sunucuda `deploy.md` →
    `server-setup.md` → `backup.md`; kabul komutları `deploy.md` §6 ve
    `server-setup.md` §8. Sonuçlar bu günlüğe.
  - S15'in kalanı (aydınlatma metni): S16 sorularının cevaplarına bağlı
    (sağlayıcı unvanı/şehri, yedek yeri, kalan yurt dışı hizmetler, tarih).
  - S17: şema boş üretim veritabanına API'nin ilk açılışında gelir
    (girişteki dbmate); import'tan önce API durdurulur. `MIGRATE_ON_START=0`
    API'yi migration'sız açmak gerekirse hazır. Yeni bir migration rol eklerse `scripts/backup/roles.sql`'e de.

### S15 — Yönetim uygulaması: okumalar, storage, fonksiyonlar, realtime, site (2026-11-23)
- Yapılanlar: oturum dosyasındaki teslim notuna bakın. Orkestratörle,
  kullanıcıya sorulmadan çalıştırıldı; plan kararı (K1–K16) değişmedi,
  backend kodu değişmedi (hata bulunmadı), canlıya hiçbir sorgu atılmadı.
  Yönetim `migrate/own-backend` `d9ad2a0`, site `migrate/own-backend`
  `1c4cd4a`; iki repo da sonunda `main`'de. Durum **kısmen**: aydınlatma
  metni kullanıcı kararı bekliyor (açık sorular), veli reposuna dokunulmadı.
- Kendi verdiğim kararlar:
  - **Yerel türler supabase-dart'ın adlarıyla** (S14 kararı 2):
    `api_types.dart`; repository'ler, `isNetworkError`, `localizeAuthError`
    ve fonksiyon hata eşlemesi değişmedi. Veli `ApiException`/
    `FunctionHttpException` adlarını seçmişti; yönetimde 29 repository'ye
    dokunmamak için adlar korundu (iki uygulamanın `api/` klasörü bu yüzden
    birebir değil).
  - **`storage_client` yok**, kendi dört metodumuz (veli S13 gibi); yükleme
    ham gövdeyle (multipart değil, `docs/api/storage.md` ikisini de kabul
    ediyor).
  - **Okumalar bir kez yeniden denenir** (`ApiClient.read`): PostgREST'in
    GET'i `retryCount: 1` ile ağ değişiminden sonra yeni ağdan tekrar
    gidiyordu (AGENTS.md "HTTP transport"); `/rpc` POST olduğu için bu
    kendiliğinden kaybolurdu. Yalnızca ağ hatası, zaman aşımı değil;
    yazmalar hiç.
  - **`toSupabaseString` → `toDbString`** (kod satırında `supabase` kalmasın
    diye; yorumlardaki Supabase anlatımları büyük ölçüde tarihçe, yollar
    `supabase/` klasörüne — o klasör testlerin sözleşme kaynağı olarak kaldı).
  - **Site varsayılan ucu `https://api.mobilsporokulu.com/functions/site-lead`**:
    yönetim/veli `config/*.json`'daki `API_BASE_URL` ile aynı (alan adı S16'da
    kesinleşir; `PUBLIC_LEAD_ENDPOINT` ezer). CSP `connect-src` de oraya.
  - **Uçtan uca deneme ayrı konteynerde** (`-p s15e2e`, port 55432): 5432'de
    bir SSH tüneli dinliyordu; seed sıfırlaması yanlış veritabanına gitmesin.
- Kabul: `grep -ri supabase lib` yalnızca yorum; `flutter analyze` 51 (yeni
  yok), `flutter test` 1235 + 2 atlanan, e2e iki kez geçti, web üç paket
  derlendi; site test 104 + build. Veli `flutter analyze/test` bu oturumda
  koşulmadı (repo değişmedi).
- Sonraki oturumlar için:
  - S15'in kalanı (aydınlatma metni) kullanıcı kararıyla: yönetimde metin +
    `PrivacyPolicy.version`, veliye birebir kopya + sürüm, site aydınlatma
    metni ve `features.ts`. Ayrı küçük bir oturum ya da S16'nın başı.
  - S16: `CORS_ORIGINS` (üç web paketi + veli web), `SITE_ALLOWED_ORIGINS`
    (site); API alan adı değişirse site `site.ts` + `.htaccess` CSP ve iki
    uygulamanın `config/*.json`'ı birlikte.
  - S17: yönetim de mağaza sürümü (yerel eklenti `app_links` çıktı);
    `main`'e birleştirme yönetimde `migrate/own-backend`'den.

### S14 — Yönetim uygulaması: istemci, auth, RPC (2026-11-23)
- Yapılanlar: oturum dosyasındaki teslim notuna bakın. Orkestratörle,
  kullanıcıya sorulmadan çalıştırıldı; plan kararı (K1–K16) değişmedi,
  backend kodu değişmedi (hata bulunmadı), canlıya hiçbir sorgu atılmadı.
  Yönetim reposu `migrate/own-backend` dalında (`ba3b4fd`), `main` Supabase'te
  ve oturum sonunda yeniden `main`'e geçildi.
- Kendi verdiğim kararlar:
  - **Ara durumda derlenebilirlik:** oturum dosyası bölünmenin arada ne
    olacağını söylemiyordu. `supabase_flutter` S15'e kadar kalıyor;
    `Supabase.initialize(accessToken: AuthSession.accessTokenForRequest)` ile
    `supabase.auth` kapatıldı (çağrılırsa istisna — `.auth.` kalmadığının
    çalışma anı güvencesi). Dal derlenir, testler geçer; ama `.from()`
    okumaları yeni token'la Supabase'e gittiği için S15'e kadar uygulama
    hiçbir backend'le çalışmaz. `main` yayın dalı olarak kaldı.
  - **supabase-dart'ın oturum/hata türleri geçici olarak yeniden
    kullanıldı** (veli S13'te yerel türler yazmıştı): `.from()` çağrıları
    aynı repository'lerde sürerken iki ayrı "sunucu reddi" türü olmasın,
    29+25 repository ve `localizeAuthError` dokunulmadan kalsın diye. S15
    paketi çıkarırken aynı adlarla yerel türlere geçer.
  - **Ortak paket çıkarılmadı** (oturum dosyasının varsayılanı): iki
    uygulamanın `api/` klasörü neredeyse aynı; S15'ten sonra fark kalırsa
    düşünülebilir.
  - **Uçtan uca denemede gerçek e-posta kodu:** backend'i
    `SMTP_HOST=127.0.0.1 SMTP_PORT=2525` ile 2525'teki küçük bir SMTP
    alıcısına bağladım (465 dışı port STARTTLS'siz düz SMTP); kod ve davet
    `token_hash`'i e-postadan okundu. Böylece S13'te yalnızca birim testiyle
    sınanan şifre sıfırlama, kayıt kodu, yeniden gönderme ve davet gerçek
    backend'le denendi. Alıcı repoya girmedi (test başlığında tarif var).
- Kabul: `.rpc(`/`.auth.` yalnızca `ApiClient.rpc` ve `ApiClient.auth`
  (AuthSession) olarak kaldı; `flutter analyze` 52 (main 53, yeni yok);
  `flutter test` 1219 + 1 atlanan; e2e iki kez geçti; `flutter build web`
  derlendi.
- Sonraki oturumlar için:
  - S15: teslim notundaki "bilinen eksikler" listesi (yerel türler,
    `SupabaseClient` kurucu parametreleri, `supabaseClientProvider`,
    logger adı). `SessionRetryClient` storage yolunu zaten `/storage/object/`
    olarak tanıyor. Şifre oluşturma sayfası S14'te yeni backend'e geçti
    (S13 notundaki S15 maddesi yapıldı); sayfa ve ön kayıt paketi
    `apiClientProvider`'ı kendi giriş noktalarında override ediyor.
  - S15: `test/e2e/local_backend_test.dart` genişletilebilir (aynı
    `API_E2E_MAILBOX` düzeniyle).
  - S17: personel de bir kez yeniden giriş yapar (oturumlar taşınmıyorsa).

### S13 — Veli uygulaması yeni backend'de (2026-11-23)
- Yapılanlar: oturum dosyasındaki teslim notuna bakın. Orkestratörle,
  kullanıcıya sorulmadan çalıştırıldı; plan kararı (K1–K16) değişmedi,
  backend kodu değişmedi (hata bulunmadı), canlıya hiçbir sorgu atılmadı.
  Veli reposu `migrate/own-backend` dalında (`af2b905`), `main` Supabase'te.
- Kendi verdiğim kararlar:
  - **Kendi küçük istemcimiz**, `storage_client` değil (oturum dosyası
    "kullanılabilir" diyordu): veli yalnızca indirme ve toplu silme yapıyor;
    iki uç için supabase ailesinden bir paket tutmak `grep supabase` kabul
    kriterini de bulandırırdı. Yollar ve gövdeler storage-api'ninkiyle aynı.
  - **Oturum `flutter_secure_storage`'da** (supabase_flutter
    SharedPreferences'ta tutuyordu): oturum dosyası güvenli depolama
    istiyordu, yönetim uygulaması da bunu kullanıyor. Yerel eklenti →
    mağaza sürümü (S17).
  - **`AuthSession.onAuthStateChange` supabase-dart'ın olay adlarını
    taşıyor** ve her dinleyiciye `initialSession` veriyor: `SessionGate`'in
    kararları (ağ hatası çıkış değil, ret `signedOut`) aynı kaldı.
  - **İstekten önce cihaz saatiyle yenileme** (30 sn pay) +
    `SessionRetryClient`'ın sunucu reddinde tek tekrarı: supabase-dart'taki
    ikili davranış korunsun.
  - **Repository katmanında istisna adları değişti** (davranış değil):
    `AuthException`/`PostgrestException`/`StorageException`/`FunctionException`
    yerine `AuthApiException`/`ApiException`/`FunctionHttpException`; aksi
    hâlde repository'ler supabase paketine bağlı kalırdı.
  - **Uçtan uca deneme bir Dart testi** (`test/e2e/local_backend_test.dart`,
    `API_E2E_BASE_URL` ile açılır): uygulamanın gerçek veri kaynaklarını
    gerçek backend'e karşı çalıştırıyor; cihaz/simülatör gerekmedi. Ekranlar
    cihazda denenmedi.
- Kabul: veli `flutter analyze` (3 bilgi, `main` ile aynı), `flutter test`
  (178 + 1 atlanan), e2e iki kez geçti, `flutter build web` derlendi.
- Sonraki oturumlar için:
  - S14: aynı tasarım `../mobil_spor_okulu_veli/lib/core/data/remote/api/`;
    yönetimde `TimeoutHttpClient`/`NetworkAwareHttpClient` zinciri
    `SessionRetryClient`'ın altında kalır, `AuthSession` kendi istekleri için
    zincirin auth'suz kısmını (logger ve altı) kullanmalı. Yönetimin
    `isNetworkError`'ı (captive portal, gateway kodları) veli
    `isNetworkError`'ından geniş — birleştirilirken onunki esas.
    `SessionRetryClient`'ın muaf yolları yeni yollara göre (`/auth/<uç>`,
    `/storage/object/`).
  - S15: şifre oluşturma sayfası `AuthSession.verifyOtp(type: 'invite',
    tokenHash:)` + `updatePassword` + `signOut(scope: local)` ile yazılabilir
    (bellek deposu: `MemorySessionStore`). Veli aydınlatma metni hâlâ
    Supabase'i anıyor.
  - S17: veli `migrate/own-backend` mağaza sürümü olmalı (yerel bağımlılık
    değişti); veliler bir kez yeniden giriş yapar (oturumlar taşınmıyorsa).
    `config/*.json`'daki `API_BASE_URL` S16'nın alan adıyla aynı olmalı.

### S12 — Veri, kullanıcı ve dosya taşıma (2026-11-23)
- Yapılanlar: oturum dosyasındaki teslim notuna ve
  `docs/migration/RUNBOOK-data.md`'ye bakın. Orkestratörle, kullanıcıya
  sorulmadan çalıştırıldı; plan kararı (K1–K16) değişmedi, migration yok.
  Canlıya yalnızca bir salt okunur sayım sorgusu (kişisel veri yok).
- Kendi verdiğim kararlar:
  - **Açık oturumlar taşınmaz** (oturum dosyasının varsayılanı);
    `--with-sessions` hazır ve testli (SHA-256, eski token yenileniyor).
    `JWT_SECRET`'ın Supabase'inki olması bunun için gerekmiyor.
  - **Araçlar `src/data-migration/`'da** (dosya `scripts/` diyordu): lint ve
    typecheck kapsamında, API imajında; S17 VPS'te çalıştırabilir.
  - **Export `supabase db dump --data-only` değil**, tek `repeatable read
    read only` transaction'da NDJSON + parmak izi: verify'ın kaynağın
    parmak izine ihtiyacı var, yol sentetik kaynakta da aynı. Bedeli: canlı
    export için DB bağlantı adresi gerekir (KULLANICI EYLEMİ).
  - **Verify kaynağa bağlanmaz**: kaynağın değeri export anının anlık
    görüntüsü (cron kaynağı sonradan değiştirse de yanlış fark çıkmaz).
  - **Import cron'u durdurur**, `resume-cron` açar: yükleme ile verify
    arasında cron bildirim yazmasın.
  - **Başvuru tabloları upsert** (`app_min_versions` canlıda değişebilir);
    `public.schema_migrations` (dbmate) hiç taşınmaz — prova `--replace`'te
    bunu boşaltıyordu, yakalandı.
  - Geçersiz adlı nesne satırı da dosyası da taşınmaz, gerekçeli not.
  - Yetim veli hesabı (S09): canlıda 0 — açık soru kapandı.
- Kabul: lint, typecheck, `npm test` (181), `npm run test:e2e` (687).
- Sonraki oturumlar için:
  - S16: imajda `node dist/data-migration/cli.js`; hedef `DATABASE_URL`
    süper kullanıcı (replica kipi); `STORAGE_ROOT` API'ninkiyle aynı.
  - S17: runbook sırası; API kapalıyken; `--storage-prefix` = üretim
    `<API>/storage/`; export klasörü iş bitince silinir; `--with-sessions`
    kararı orada değiştirilebilir. `auth.audit_log_entries` (5651) ayrıca.
  - Yönetim reposuna yeni tablo/sütun gelirse araç kendiliğinden alır
    (katalogdan okur); Supabase'e özgü yeni bir sütun import'u durdurur →
    `KNOWN_SOURCE_ONLY_COLUMNS`.

### S11 — Bildirimler: realtime, push, cron (2026-11-23)
- Yapılanlar: oturum dosyasındaki teslim notuna ve `docs/api/realtime.md`'ye
  bakın. Orkestratörle, kullanıcıya sorulmadan çalıştırıldı; plan kararı
  (K1–K16) değişmedi. Canlıya hiçbir sorgu atılmadı (gerek olmadı; şema
  0001'de, kaynak davranış yönetim reposunda).
- Kendi verdiğim kararlar:
  - **Kendi küçük JSON protokolü** (Phoenix taklidi değil): tek kullanım
    gelen kutusu, istemci S13/S15'te zaten yeniden yazılıyor. Token ilk
    mesajda (tarayıcıda WS başlığı yok, adres vekil loglarına düşer);
    kanal adı Supabase'tekiyle aynı (`notifications:<uid>`).
  - **Yetki teslim anında, abone adına RLS'le** (`get_notification`,
    `withUser`); NOTIFY yükündeki alıcı yalnızca yönlendirme. Pasif/silinmiş
    hesap ve uydurma NOTIFY böylece kod kuralı yazmadan kapanıyor. Oturum
    (çıkış/silme) `REALTIME_SESSION_CHECK_MS`'de bir yeniden denetlenir;
    süresi dolan token 4001.
  - **UPDATE olayı yalnızca yeniden canlanan satır** (trigger `WHEN`):
    Supabase her UPDATE'i yolluyordu, veli `isRevived` dışındakileri
    atıyordu, yönetim hiç dinlemiyordu; push worker'ın her gönderimdeki iki
    yazımı olay fırtınası olmasın. İstemcinin gördüğü sonuç aynı.
  - **Satır trigger'ı** (statement değil): duyuru N satır = N küçük NOTIFY;
    yükü 8000 bayt sınırına sokmamak için. Alıcı bağlı değilse sorgu yok.
  - **firebase-admin yerine ham FCM HTTP v1** (oturum dosyası firebase-admin
    diyordu; K1'in gerekçesindeki bir örnek, karar değil): `isDeadToken`
    FCM'in ham hata gövdesine (`fieldViolations`) bakıyor, firebase-admin
    gövdeyi kendi koduna çevirip bu bilgiyi kaybediyor — ölü token kararı
    send-push'unkinden farklılaşırdı. JWT RS256 `node:crypto` ile.
  - **`data.params` izin listesi** (send-push'tan bilinçli fark): canlıdaki
    sürüm personel türlerinde bütün `params`'ı yolluyor; `names` (ilk beş
    sporcu adı) ve `athlete_name` FCM `data`'sına giriyor. Yalnızca
    uygulamanın yönlendirmede okuduğu alanlar kaldı. Açık sorulara yazıldı.
  - **Ağ hatası yeniden deneme**, beş tur dolarsa hemen yeni boşaltma; API
    içi süpürme `PUSH_SWEEP_INTERVAL_MS` (DB cron'una ek, LISTEN koptuğunda
    kaçanlar için); her LISTEN açılışında kuyruğa bakılır.
  - **FCM sırrı bozuksa API açılır**, push kapalı kalır ve hata loglanır
    (Edge her çağrıda 500 dönüyordu; tek sır yüzünden bütün API durmasın).
  - **Kapanış kodları** 4000/4001/4003/4029; bağlantı sınırında en eski
    kapanır (heartbeat'in düşürmediği ölü soketler yenisini engellemesin).
  - **Çoklu süreç güvenli** (AGENTS.md): talep `skip locked`, her süreç
    kendi soketlerine; ortak durum yok.
  - `ws` 8.22.2 (8.23.0 iki haftadan yeni).
- Kabul: lint, typecheck, `npm test` (178), `npm run test:e2e` (683, üç tam
  koşu). İlk tam koşuda düşen tek test S07'nin katalog testiydi (bütün
  `backend:` fonksiyonlarını okuma fonksiyonu sayıyordu; `backend: S07`
  ile daraltıldı) — zamanlamaya bağlı değil. S10'un tanımlanamayan düşen
  testi bu oturumdaki koşularda tekrarlanmadı.
- Sonraki oturumlar için:
  - S13/S15: protokol `docs/api/realtime.md`; notlar oturum dosyalarında.
  - S16: vekilde WebSocket, `FCM_SERVICE_ACCOUNT`, havuz + 1 LISTEN
    bağlantısı.
  - S17: Supabase'teki push dürtmesi geçişte kapanmalı (iki taraf aynı
    token'lara göndermesin).
  - Yönetim reposuna yeni bildirim türü eklenirse: `render()` (birim test
    kaynağı karşılaştırır) ve `DATA_KEYS` burada da.

### S10 — Online ön kayıt ve site lead (2026-11-23)
- Yapılanlar: oturum dosyasındaki teslim notuna ve `docs/api/functions.md`'ye
  bakın. Orkestratörle, kullanıcıya sorulmadan çalıştırıldı; plan kararı
  (K1–K16) değişmedi, migration yok. Canlıya yalnızca salt okunur
  `list_edge_functions` (submit + iki aktarım `verify_jwt: true`, site-lead
  `false`) ve 0008 için parmak izi sorgusu.
- Kendi verdiğim kararlar:
  - **Turnstile yok**: oturum dosyası istiyordu, ama Edge Function'lar ve
    yönetim AGENTS.md'si Ekim 2026'da kaldırıldığını söylüyor (kaynak
    davranış esas). `turnstile_token` atılıyor. Bot koruması site'de bal küpü
    + `elapsed_ms`, ön kayıtta IP + telefon sınırları.
  - **İstemci IP'si `trust proxy`'den** (`req.ip`), Edge gibi
    `x-forwarded-for`'un ilk değerinden değil: ilk değeri istemci yazar,
    sınır her istekte başka IP uydurularak aşılırdı (testli). Bedeli:
    `TRUST_PROXY` üretimde doğru olmalı (S16'ya yazıldı).
  - **Tuz yoksa** JWT_SECRET'tan HMAC ile türetilir (Edge: service key'in
    ilk 32 karakteri) ve bir kez uyarılır. Aynı `IP_HASH_SALT` verilirse
    özetler Supabase'tekiyle aynı.
  - **`submit-pre-registration` başlık istemez** (Supabase'te `verify_jwt`
    vardı ama istemci herkese açık anon anahtarını taşıyordu — koruma değil);
    gelen `Authorization` yok sayılır. CORS genel `CORS_ORIGINS`'le (Edge'de
    `*`): formun paketi zaten `/rpc` okumaları için orada olmalı.
  - **site-lead'in kendi CORS'u**: genel CORS artık istek başına
    (`enableCors` delegesi); site-lead yolu atlanır, controller Edge'deki
    başlıkları yazar. Yönetim kökeni site-lead'e CORS alamaz (testli).
  - **İki oturumsuz yolun gövdesi ham metin** (`rawTextBody`): bozuk JSON ve
    büyük gövde Edge'in kendi zarfıyla (500 / 400 / 413) dönsün, genel
    `PGRST102`'ye düşmesin. Gövde sınırı aşan istek okunup atılır (bağlantı
    kesilmez); `BODY_LIMIT`'ten sonrası okunmaz.
  - **PostgREST kuralıyla sunucu içi çağrı** (`RpcService.callAs`):
    formların gövdesi `create_public_pre_registration_by_token` ve
    `update_pre_registration`'a bugün olduğu gibi geçiyor; bilinmeyen anahtar
    / eksik zorunlu alan / tipe uymayan değer Supabase'teki gibi düşüyor
    (imza hatası metni PostgREST'inki). Gateway'den çağrılamaz.
  - **Aktarımda yazımlar Edge'deki gibi ayrı adımlar** (S09'un veli
    yazımlarından farklı olarak tek transaction'a alınmadı): davet e-postası
    geri alınamıyor, profil davetle açılan hesaba bağlı; RPC zaten tek
    transaction. Kayıt düşerse o kayıt için açılan hesaplar silinir (testli:
    ikinci veli reddi, RPC reddi, SMTP reddi).
  - **Beklenmeyen hata metni**: Edge `error.message`'ı aynen döndürüyordu;
    burada SQL/auth hatasının metni geçer, iç (TS) hata metni sızmaz
    (`messageOf`).
  - **ILIKE**: PostgREST `*`'ı da `%`'ye çeviriyordu; bizde `*` düz karakter
    (daha sıkı).
- Sonraki oturumlar için:
  - S12: `site_leads`, `pre_registration_attempts`, `pre_registration_links`
    taşınır; IP özetleri aynı tuzla üretildiyse geçerli kalır.
  - S15: istemci notları S15 dosyasında (submit başlıksız, site-lead adresi,
    CORS kökenleri).
  - S16: `TRUST_PROXY`, `IP_HASH_SALT` (Supabase secrets'taki değer
    kullanıcıdan), `SITE_LEAD_NOTIFY_TO`, `SITE_ALLOWED_ORIGINS`; site-lead
    bildirimi `SMTP_*_PUBLIC` kutusundan.
  - Tam e2e bir koşuda 1 test düştü, sonraki üç koşuda (iki tam, üç yalnızca
    S10) hepsi geçti; düşen test çıktıda kaydedilmemişti (filtrelenmiş
    çıktı). Zamanlamaya bağlı bir test olabilir; tekrarlarsa bakılmalı.

### Bakım — 0008 canlıda (2026-11-23)
- Kullanıcı `20261123_parent_email_change.sql`'i canlıya uyguladı ve
  `update-parent` v25'i dağıttı (orkestratör doğruladı: SECURITY DEFINER,
  yalnızca service_role). `scripts/schema-fingerprint.sql` canlıda salt okunur
  çalıştırıldı: `fn` = `c31f6c33…` (yerelle aynı), fonksiyon sayısı 168;
  diğer sekiz parmak izi değişmedi. `test/schema.e2e-spec.ts`'te
  `NOT_YET_LIVE*` boşaltıldı, değerler `LIVE`'a alındı.

### S09 düzeltmesi — veli e-posta değişikliği (2026-11-23)
- Karar (kullanıcı, orkestratör üzerinden): `update-parent`'ta e-posta
  değişince eski hesabı silip yeni hesap açmak yerine **aynı** auth hesabının
  adresi değişir; profil kimliği, bağlar, geçmiş kalır; yeni adrese şifre
  oluşturma daveti gider. İki yerde düzeltildi.
- Yönetim reposu (`main`, commit'te; dağıtılmadı): migration
  `20261123_parent_email_change.sql` → `reset_parent_login_email(uuid, text)`
  (service_role; rol 8 değilse `not_found`, adres başka hesaptaysa
  `conflict`; adresi değiştirir, hesabı onaysız + şifresiz + oturumsuz yapar).
  GoTrue kaynağından (supabase/auth master) doğrulandı: admin API bir hesabı
  onaysız yapamıyor (`email_confirm: false` etkisiz), onaylı hesaba davet
  `email_exists`, onaysız var olan hesaba `inviteUserByEmail` daveti yeniden
  gönderiyor (send-email hook'u, `invite`; `redirect_to` sorgudan),
  `generateLink` e-posta göndermiyor. Bu yüzden şifre sayfası değişmedi
  (`type=invite`). Edge Function sırası: denetimler → marka → RPC → davet →
  profil (+ e-posta) → bağlar (aynı id); bir adım düşerse yeniden göndermek
  yolu tamamlar.
- Backend: migration `0008_parent_email_change.sql` (import), `update-parent`
  aynı karar ama **tek transaction** (çağıranın rolüyle profil + bağlar →
  `switchRole(service_role)` + RPC → `AuthAdminService.reinviteWithin`
  (auth_service, e-posta commit'ten önce)). Düşen her adımda — e-posta dahil —
  hiçbir şey değişmez (testli). Yeni: `DbContextService.switchRole`.
  Testler: bağlı velinin başarı yolu uçtan uca (aynı id, bağlar, eski adres
  ve refresh reddi, davet bağlantısı → verify → şifre → giriş), üç düşme
  durumu (adres başkasında, SMTP reddi, bağ yazımı) için durum anlık
  görüntüsü aynı, RPC istemciye kapalı ve personeli reddediyor. Mutasyon:
  davet hatası yutulunca 3 test düştü.
- Sonraki oturumlar için: canlıya uygulanınca schema testindeki
  `NOT_YET_LIVE*` canlı değerlere taşınır (açık sorular). S12: eski hatadan
  yetim veli hesabı kalmış olabilir (not yerinde).

### S09 — Hesap işlemleri (2026-11-23)
- Yapılanlar: oturum dosyasındaki teslim notuna ve `docs/api/functions.md`'ye
  bakın. Orkestratörle, kullanıcıya sorulmadan çalıştırıldı; plan kararı
  (K1–K16) değişmedi, migration yok. Canlıya yalnızca salt okunur
  `list_edge_functions` (beşi de `verify_jwt: true`).
- Kendi verdiğim kararlar:
  - **Yol `POST /functions/<ad>`**, gövde/yanıt/HTTP kodu/`reason` Edge
    Function'larınkiyle aynı (personel/veli: 200 `{success, message}`, 400
    `{success:false, error}`; delete-account: `app_ok/app_err` + `reason`).
    `verify_jwt`'nin karşılığı: başlıksız 401, geçersiz token 401 `PGRST30x`
    (SessionRetryClient yeniler), anon anahtarı fonksiyonun kendi hatası.
  - **Çağıran = `/auth/user` kuralı** (oturum açık, hesap silinmemiş/
    yasaklı değil): GoTrue'nun `getUser()`'ı. Çıkış yapılmış ya da silinmiş
    hesabın süresi geçmemiş token'ı da reddedilir.
  - **SQL çağrıları çağıranın rolüyle** (Edge'in `supabaseCaller`'ı);
    service_role yalnızca `schoolBrand` ve `delete_own_account`.
  - **Veli yazımları tek transaction** (Edge'de ayrı istekler). Yanıtlar
    aynı; fark yalnızca yarım yazım kalmaması.
  - **Hesap silmede şifre** `AuthService.verifyPassword`: oturum açmaz,
    girişin kaba kuvvet sayaçlarını paylaşır (sınır 429 `rate_limited`).
  - Gövdede zod ile yalnızca tip denetimi (metin/liste); kurallar SQL'de.
  - Canlının e-posta değişikliği hatası ilk sürümde bire bir taşındı;
    kullanıcı kararıyla aynı gün düzeltildi (yukarıdaki bölüm).
- Sonraki oturumlar için:
  - S10: ön kayıt fonksiyonlarını aynı `/functions/` köküne ekle, ama
    `FunctionsController` sınıf düzeyinde `AuthorizationHeaderGuard`
    (başlık zorunlu) taşıyor — `submit-pre-registration` (anon, Supabase'te
    `verify_jwt: true` ama anon anahtarıyla) ve `site-lead`
    (`--no-verify-jwt`, başlık yok) için ayrı controller ya da metot
    düzeyinde guard gerekir. Gövde şekilleri için `function-response.ts`
    (`edgeFailure`, `envelopeFailure`, `FunctionsExceptionFilter`) ve
    `CallerResolver`; davet `AuthAdminService.inviteUser`, marka
    `AccountsRepository.schoolBrand`.
  - S13/S14/S15: `functions.invoke(ad)` → `POST <API>/functions/<ad>`
    (aynı gövde, `Authorization: Bearer`). supabase-dart'ın
    `FunctionException`'ına bağlı `RpcEnvelope.fromFunctionException` ve
    `mapDeleteAccountFailure` yeni istemcide HTTP hata gövdesinden aynı
    alanları okumalı (`reason`, `message`, `error`, `code`).
  - S12: canlıda e-posta değişikliği hatasından kalmış yetim veli hesapları
    olabilir (davet edilmiş, onaysız, bağlı); taşımadan önce sayılmalı.

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
