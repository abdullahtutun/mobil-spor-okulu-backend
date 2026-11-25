# Canlıya geçiş runbook'u (S17)

Supabase'teki veri **yalnızca demo** ve mağaza uygulamalarını kimse
kullanmıyor (kullanıcı, 2026-11-25). Bu yüzden ayrı prova, bakım duyurusu,
okullara bildirim ve eski auth loglarının arşivi **yok**; geçiş doğrudan
yapılır. Veri adımının ayrıntısı `RUNBOOK-data.md`'de; burada sıra, sahip,
komut, doğrulama ve geri alma var.

Sahipler: **K** = kullanıcı (sunucu kökü, Supabase paneli, mağazalar,
Hostinger), **O** = orkestratör/ajan (repo işleri; SSH yok, canlı Supabase'e
yazmaz). Sırlar (Supabase bağlantı dizesi, service_role anahtarı) yalnızca
kullanıcıda kalır, sunucuda ortam değişkeniyle verilir; dosyaya, geçmişe,
sohbete yazılmaz.

## Durum (2026-11-25, hazırlık)

| | |
|---|---|
| API | `https://api.mobilsporokulu.com` canlı, `/health` doğrulandı; DB'de şema var, veri yok |
| DB konteyneri | `tyinwtkkazvfwgtpwru3xgcd` (Coolify), imaj `ghcr.io/abdullahtutun/mobil-spor-okulu-postgres:17` |
| Repo kopyası | `/opt/mso` |
| Dallar | `migrate/own-backend` yönetim, veli ve sitede `main`'e alındı (yerel, push yok) |
| Sürüm | yönetim ve veli **1.1.3+11** (`pubspec.yaml`; önceki mağaza sürümü 1.1.2+10, kapıyı taşıyan ilk sürüm) |
| Yedek | Coolify yerel 02:00 (7 kopya) + restic `/var/backups/mso-restic` 03:30 (30 gün) |

## Zorunlu güncelleme kapısı — hangi build nereye sorar

| Build | Kapıyı nereden okur | Geçişte ne yapılır |
|---|---|---|
| ≤ 9 | kapı yok | durdurulamaz (zaten kimse kullanmıyor) |
| 10 (1.1.2+10) | **Supabase** `get_min_app_version` | Supabase'te `min_build = 11` → "Güncelleme gerekli" |
| 11+ (1.1.3+11) | **yeni backend** `POST /rpc/get_min_app_version` (anon) | yeni DB'deki değer ≤ 11 kalmalı |

Dikkat: import `app_min_versions`'ı **Supabase'in değeriyle günceller**
(RUNBOOK-data: başvuru tabloları upsert). Supabase'te `min_build`'i export'tan
**önce** 12'ye çekerseniz yeni build'ler de kilitlenir. Sıra: export →
import → … → mağaza sürümleri yayında → **en son** Supabase'te 11.
iOS satırlarının `store_url`'ü iki tarafta da yazılmalı (yoksa iOS'ta
düğme çıkmaz); yeni DB'de adım 9'da.

## T-öncesi (geçiş gününden önce)

1. **O — bitti:** dallar `main`'de, sürüm 1.1.3+11, testler yeşil.
2. **K — mağaza build'leri** (her iki repoda, `main`'den, iki marka; Shorebird
   ile, yoksa patch alınamaz):

   ```bash
   cd ~/FlutterProjects/mobil_spor_okulu        # sonra aynısı mobil_spor_okulu_veli'de
   git switch main && flutter clean && flutter pub get
   tool/flavor.sh dev_adim shorebird release android
   tool/flavor.sh public   shorebird release android
   tool/flavor.sh dev_adim shorebird release ios
   tool/flavor.sh public   shorebird release ios
   ```

   `.aab` → Play Console, `.ipa` → App Store Connect (Transporter). İncelemeye
   gönderin, **elle yayın** ("manually release") seçin; onaylanınca
   bekletin. 8 build: 2 uygulama × 2 marka × 2 platform. Bu sürümler
   `api.mobilsporokulu.com`'a bağlıdır; veri taşınmadan yayınlanırsa boş bir
   sistemle açılır (zarar yok ama demo hesaplar giremez).
3. **K — iOS App Store adresleri:** her iOS uygulamasının
   `https://apps.apple.com/app/id<…>` adresini not edin (adım 9 ve 12).
4. **K — Supabase bağlantı bilgisi:** Supabase → Project Settings →
   Database → Connection string → **Session pooler** (5432). Ayrıca API
   Keys → `service_role`. Parola yöneticisinde tutun; ajana vermeyin.

## Geçiş günü

Tahmini toplam: veri adımı < 1 dk; web yüklemeleri ve mağaza yayınıyla
birlikte ~1 saat (mağaza onay süresi hariç).

### 1. K — Supabase'te cron ve push dürtmesini durdur (SQL editor)

```sql
-- a) cron işlerini kapat (silmeden; geri alınabilir)
select jobid, jobname, active from cron.job order by jobname;      -- önce bakın (≈9 iş)
update cron.job set active = false;

-- b) push dürtmesini kapat: request_push_dispatch() URL bulamazsa sessizce döner
update vault.secrets set name = 'push_dispatch_url_disabled'
 where name = 'push_dispatch_url';

-- doğrulama
select count(*) filter (where active) as aktif_cron from cron.job;   -- 0
select name from vault.secrets where name like 'push_dispatch%';     -- _disabled + secret
```

Neden: veri taşındıktan sonra iki taraf aynı push token'larına göndermesin,
Supabase'te gece işleri veri üretmesin (S11). Supabase'in Send Email Hook'u
açık kalabilir; yeni sistem kendi SMTP'siyle gönderir.

Geri alma: `update cron.job set active = true;` ve
`update vault.secrets set name='push_dispatch_url' where name='push_dispatch_url_disabled';`

### 2. K — Sunucuda hazırlık (VPS, root kabuğu)

```bash
docker ps --format '{{.Names}}  {{.Image}}'    # API konteynerinin adını bulun (Coolify uygulaması)
API=<api-konteyner-adı>
docker exec "$API" node dist/data-migration/cli.js --help
docker exec tyinwtkkazvfwgtpwru3xgcd psql -U postgres -Atc \
  "select count(*) from auth.users; select count(*) from public.schools;"   # 0 / 0 — hedef boş
```

**API açık kalabilir.** Kimse ona bağlı değil (eski build'ler Supabase'te,
yeni build'ler yayında değil, yeni site yüklenmedi); veri aracı API
konteynerinde koşar ve onun `DATABASE_URL`'ünü (postgres süper kullanıcısı)
ve `STORAGE_ROOT`'unu (`/data/storage`) kullanır. `MIGRATE_ON_START`'a
dokunmayın: şema zaten yüklü (0001–0010), API yeniden başlarsa `dbmate up`
yapacak bir şey bulmaz. `MIGRATE_ON_START=0` yalnızca API'yi bu sırada
yeniden dağıtmanız gerekir ve migration istemezseniz.

Not: import sırasında trigger'lar kapalıdır (replica kipi) ve cron'u import
kendisi durdurur; API'nin push süpürmesi 24 saatten eski bildirimleri
`skipped` yapar, demo veride son 24 saatte bildirim varsa demo cihazlara bir
push gidebilir — kabul edilebilir.

### 3. K — Export (Supabase'e yazmaz)

```bash
read -rs SOURCE_DATABASE_URL; export SOURCE_DATABASE_URL      # yapıştırın, Enter
read -rs SUPABASE_SERVICE_ROLE_KEY; export SUPABASE_SERVICE_ROLE_KEY
STAMP=$(date +%Y%m%d-%H%M); OUT=/tmp/exports/$STAMP
docker exec -e SOURCE_DATABASE_URL -e SUPABASE_SERVICE_ROLE_KEY \
  -e SUPABASE_URL=https://gcmeltwnryjscinptecb.supabase.co \
  "$API" node dist/data-migration/cli.js export --out "$OUT"
```

Beklenen son satır: `export bitti: … tablo, … satır, 15 dosya (~865 KB), 0 reddedilen`.
(`/app/exports` değil `/tmp`: konteyner `node` kullanıcısıyla koşar ve
`/app`'e yazamayabilir; `/tmp` geçicidir, konteyner yenilenince gider.)

### 4. K — Import

```bash
docker exec "$API" node dist/data-migration/cli.js import --from "$OUT" \
  --storage-prefix https://api.mobilsporokulu.com/storage/
```

Beklenen: "cron durduruldu: … iş", "import bitti". Hedef dolu derse →
yanlışlıkla bir şey yazılmış; demo veride `--replace` ile tekrar edin.

### 5. K — Verify (sıfır fark, çıkış 0)

```bash
docker exec "$API" node dist/data-migration/cli.js verify --from "$OUT" \
  --storage-prefix https://api.mobilsporokulu.com/storage/; echo "çıkış $?"
# giriş denemesiyle (demo yönetici hesabı; şifre supabase/seed/demo_dev_adim.sql başında):
read -rs VERIFY_LOGIN_PASSWORD; export VERIFY_LOGIN_PASSWORD
docker exec -e VERIFY_LOGIN_PASSWORD "$API" node dist/data-migration/cli.js verify \
  --from "$OUT" --storage-prefix https://api.mobilsporokulu.com/storage/ \
  --api-url https://api.mobilsporokulu.com --login-email demo.yonetici@devadim.com
```

Fark varsa: `import --replace`, sonra verify. Geçmezse **dur** (geri alma §G).

### 6. K — Cron'u yeni DB'de aç

```bash
docker exec "$API" node dist/data-migration/cli.js resume-cron --from "$OUT"
docker exec tyinwtkkazvfwgtpwru3xgcd psql -U postgres -Atc \
  "select jobname, active from cron.job order by 1"      # hepsi t (backend_* dahil)
```

### 7. K — Export'u ve sırları sil

```bash
docker exec "$API" rm -rf /tmp/exports
unset SOURCE_DATABASE_URL SUPABASE_SERVICE_ROLE_KEY VERIFY_LOGIN_PASSWORD
```

### 8. K — Sunucu smoke testleri

```bash
curl -fsS https://api.mobilsporokulu.com/health          # "database":"ok"
curl -fsS -X POST https://api.mobilsporokulu.com/rpc/get_min_app_version \
  -H 'content-type: application/json' \
  -d '{"p_app":"management","p_platform":"android","p_brand":"dev_adim"}'   # success:true, min_build ≤ 11
```

Sonra bir telefonda **yeni** build (TestFlight / Play iç test ya da
`tool/flavor.sh dev_adim run --release`): demo yönetici girişi, ana ekran
sayıları, bir sporcu fotoğrafı açılıyor, yoklama alınıyor, bir duyuru
gönderiliyor (push geliyor), veli uygulamasında demo veli girişi ve
duyuru görünüyor; "Şifremi unuttum" kodu e-postayla geliyor (marka
göndericisi doğru).

### 9. K — Yeni DB'de iOS `store_url`

```bash
docker exec -i tyinwtkkazvfwgtpwru3xgcd psql -U postgres -d postgres <<'SQL'
update public.app_min_versions set store_url = 'https://apps.apple.com/app/id<…>'
 where platform = 'ios' and app = 'management' and brand = 'dev_adim';
-- aynısı: management/public, parent/dev_adim, parent/public
select app, brand, platform, min_build, store_url from public.app_min_versions order by 1,2,3;
SQL
```

`min_build`'e dokunmayın (≤ 11 olmalı; Supabase'teki eski değer geldi).

### 10. K — Web paketleri

Yönetim reposunda (`main`):

```bash
tool/build_web.sh dev_adim all   # → build/web/dev-adim/{main,online-kayit,sifre-olusturma}/
tool/build_web.sh public   all   # → build/web/mobil-spor-okulu/{main,online-kayit,sifre-olusturma}/
```

| Klasörün **içeriği** (`.htaccess` dahil) | Hostinger'da |
|---|---|
| `dev-adim/main/` | mobil.devadim.com `public_html/` (boşaltmadan üzerine; iki alt paket içinde yaşar) |
| `dev-adim/online-kayit/` | mobil.devadim.com `public_html/online-onkayit/` |
| `dev-adim/sifre-olusturma/` | mobil.devadim.com `public_html/sifre-olusturma/` |
| `mobil-spor-okulu/main/` | yonetim.mobilsporokulu.com (`yonetim/` kökü) |
| `mobil-spor-okulu/online-kayit/` | … `online-onkayit/` |
| `mobil-spor-okulu/sifre-olusturma/` | … `sifre-olusturma/` |

`gizlilik/` (yeni aydınlatma metni) `dev-adim/main/gizlilik/` ile gelir;
Mobil Spor Okulu'nun gizlilik sayfası `build/web/mobil-spor-okulu/tanitim-sitesi/`
→ apex sitenin köküne (aşağıdaki site yüklemesiyle birlikte).

Veli reposunda (`main`):

```bash
tool/flavor.sh dev_adim build web   # → build/web/dev-adim/        → Dev Adım veli web alanı
tool/flavor.sh public   build web   # → build/web/mobil-spor-okulu/ → veli.mobilsporokulu.com
```

Site (`mobil_spor_okulu_site`, `main`): `npm run build` → `dist/` içeriği
`mobilsporokulu.com` köküne (site AGENTS.md; demo/iletişim formu artık
`api.mobilsporokulu.com/functions/site-lead`'e gider). Yükledikten sonra bir
deneme formu gönderin; `SITE_LEAD_NOTIFY_TO`'ya e-posta gelmeli.

Tarayıcıda: her alan adı açılıyor, demo hesapla giriş, ön kayıt QR'ının
bağlantısı açılıyor, sabit önbellek yok (`Ctrl+Shift+R` gerekmeden yeni sürüm).

### 11. K — Mağaza sürümlerini yayınla

App Store Connect ve Play Console'da bekletilen 1.1.3+11'leri yayınlayın
(8 build). Shorebird konsolunda 1.1.3+11 release'leri görünür.

### 12. K — Eski build'leri durdur (Supabase SQL editor, EN SON)

```sql
-- önce iOS adresleri (4 satır; adım 9'daki değerler)
update public.app_min_versions set store_url = 'https://apps.apple.com/app/id<…>'
 where platform = 'ios' and app = 'management' and brand = 'dev_adim';
-- … management/public, parent/dev_adim, parent/public
update public.app_min_versions set min_build = 11;
select * from public.app_min_versions order by 1,2,3;
```

1.1.2+10 açılışta (ve öne gelişte, 30 dk'da bir) "Güncelleme gerekli"
gösterir ve Supabase'e yazmaz.

### 13. K + O — İzleme (24 saat)

- UptimeRobot `/health`; Coolify → Logs (5xx, `ERROR`).
- Ertesi sabah: `docker exec tyinwtkkazvfwgtpwru3xgcd psql -U postgres -Atc
  "select jobname, status, return_message from cron.job_run_details where start_time > now() - interval '1 day' and status <> 'succeeded'"` → boş.
- 03:30 sonrası `journalctl -u mso-backup -n 30` → "Yedek tamam"; `restic snapshots`.
- Sonuçları PROGRESS.md'ye (O, kullanıcının çıktısıyla).

## G. Geri alma

| Ne zamana kadar | Nasıl |
|---|---|
| Adım 11'den önce | Supabase'e hiç yazılmadı. Supabase'te §1'in geri alma SQL'i; yeni DB'yi boşaltmak gerekirse sonraki denemede `import --replace`. Eski web paketlerini geri yükleyin (Hostinger'da önceki dosyalar; yüklemeden önce indirin). Yeni build'ler bekletmede kalır |
| Adım 11–12 sonrası | Yeni build'ler yeni backend'e bağlı; geri dönüş = 1.1.3'ü durdurmak değil, sorunu düzeltmek (Shorebird patch: `tool/flavor.sh <flavor> shorebird patch <platform> --release-version 1.1.3+11`, ya da backend düzeltmesi Coolify'dan). Supabase `min_build`'i 0'a çekmek 1.1.2+10'u yeniden açar (veri o tarafta eski kalır — demo olduğu için kabul) |

## Sonra

1. **K, 1–2 hafta sorunsuz çalıştıktan sonra — Supabase'in silinmesi:**
   kullanıcı kararı (2026-11-25): veri demo, güncelleme kapısı için ayrıca
   açık tutulmaz (eski build'leri kimse kullanmıyor). Silmeden önce
   istenirse son bir şema+veri dökümü **alınmaz** (KVKK: taşınan verinin
   eski kopyası tutulmaz). Supabase → Project Settings → General →
   **Delete project**. Ardından: Hostinger'daki eski `set-password.php`
   varsa silin; Supabase Edge Function sırları zaten projeyle gider.
2. **O:** Supabase silinince yönetim reposundaki `supabase/` klasörü silinir
   (bugün yalnızca tarihsel, `supabase/README.md`), AGENTS.md'lerdeki
   Supabase bölümleri ayıklanır.
3. **K:** export dosyaları — §7'de silindi; yerel makinede kopya yoksa iş
   bitti. Ekran görüntüsü/terminal kaydında bağlantı dizesi kalmadığını
   kontrol edin.
4. İkinci yedek lokasyonu (S3) — `docs/ops/backup.md` §6.
