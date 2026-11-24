# S16 — Üretim dağıtımı, yedekleme ve izleme

**Repo:** backend · **Bağımlı:** S01 (backend tamamlandıkça yeniden çalıştırılabilir)

## Amaç
Backend'in Türkiye'deki VPS'te güvenli, yedekli ve izlenen biçimde
çalışması. **VPS'te Coolify kurulu** (2026-10-26): proxy, TLS, git'ten
deploy ve veritabanı yedeği Coolify'dan yapılır; elle compose/Caddy
yönetilmez. Sunucuya ve Coolify paneline erişim kullanıcıdadır; oturum
dosyaları ve adım adım kontrol listesini hazırlar, kullanıcı panelde uygular
(ya da izin verirse SSH ile birlikte).

## Karar gerekiyor (oturum başında kullanıcıya sor)
- VPS'in boyutu ve üzerinde Coolify'la çalışan başka neler olduğu (RAM bütçesi).
- API alan adı (K13) ve DNS'i kimin yönettiği.
- Yedeklerin gideceği ikinci yurt içi S3 uyumlu depolama.
- Coolify'ın git erişimi (GitHub App / deploy key) ve repo'nun nerede durduğu.

## Yapılacaklar
- **S11'den:** vekil `/realtime`'da WebSocket'i (Upgrade/Connection
  başlıkları) geçirmeli, boşta kalma süresi sunucunun 30 sn'lik ping'inden
  uzun olmalı. Env: `FCM_SERVICE_ACCOUNT` (Supabase secrets'taki
  servis hesabı JSON'u — kullanıcıdan; boşsa push kapalı, kuyruk bekler),
  `PUSH_SWEEP_INTERVAL_MS`, `REALTIME_*`. API ile Postgres arasındaki
  bağlantı uzun ömürlü bir LISTEN bağlantısı da taşır (havuz + 1).
- [ ] Coolify'da proje + `production` ortamı. _(adımlar `docs/ops/deploy.md` §1; panelde kullanıcı)_
- [ ] _(repo kısmı hazır: `deploy.md` §2–3, `docker/postgres/tuning.sql`; panelde kullanıcı)_ Postgres: Coolify "Database" kaynağı, **özel imaj** (S01'in
      `docker/postgres/Dockerfile`'ı registry'ye ya da Coolify'ın Dockerfile
      build'iyle) — pg_cron şart. Dışarı port açılmaz; bellek ayarları VPS'e
      göre.
- [x] _(repo: girişte migration + parola, tini, dbmate `dependencies`'te; Coolify ayarları `deploy.md` §4–5 — panelde kullanıcı)_ API: Coolify "Application", repo'daki `Dockerfile` ile build;
      ortam değişkenleri Coolify'da (sırlar repoda değil); storage için
      kalıcı volume (`STORAGE_ROOT`, imajda `/data/storage`, sahibi `node`
      uid 1000; S08) — tek dosya sistemi (`rename` atomik), vekilin gövde
      sınırı ≥ 2 MB + multipart payı; healthcheck `/health`; deploy öncesi
      `db:migrate` (pre-deploy komutu ya da açılışta, hangisi seçildiyse
      gerekçeli).
- [ ] _(repo: güvenlik başlıkları API'de + e2e; doğrulama komutları `deploy.md` §6 — sunucuda kullanıcı)_ Alan adı + TLS Coolify proxy'sinden; WebSocket (`/realtime`),
      gövde boyutu sınırı, güvenlik başlıkları, gerçek istemci IP'sinin
      `X-Forwarded-For` ile API'ye gelmesi (S10'un hız sınırı buna bağlı)
      doğrulanır. S10: `TRUST_PROXY` yanlışsa bütün veliler vekilin tek
      IP'sinden gelir ve ön kayıtta saatte 15 sınırı herkese birden işler;
      fazlaysa istemci `X-Forwarded-For` uydurup sınırı aşar. Env:
      `IP_HASH_SALT` (Supabase secrets'taki değer — kullanıcıdan),
      `SITE_LEAD_NOTIFY_TO`, `SITE_ALLOWED_ORIGINS` (boş = varsayılan).
- [x] `docs/ops/server-setup.md`: sunucu sertleştirme kontrol listesi —
      SSH yalnızca anahtar, `ufw`, `unattended-upgrades`, `fail2ban`,
      Coolify panelinin alan adı + TLS arkasında olması ve 8000 portunun
      kapatılması, Coolify'ın kendi güncellemeleri.
- [x] _(repo: `scripts/backup/`, `ops/systemd/`, `docs/ops/backup.md`, restore e2e; sunucuda kurulum kullanıcıda)_ Yedekleme: Coolify'ın planlı veritabanı yedeği → ikinci lokasyondaki
      S3; **storage volume'u ayrıca** (Coolify bunu yedeklemez:
      `scripts/backup/` + `restic` ya da `rclone`, timer). Saklama politikası
      (ör. 7 gün/4 hafta/6 ay). **Geri yükleme adımları ve aylık geri
      yükleme testi.**
- [x] _(belge: `backup.md` §4–5; monitörleri kullanıcı açar)_ İzleme: `/health` için dış izleme (UptimeRobot ya da Uptime Kuma),
      disk/RAM uyarısı, yedek başarısızlığı bildirimi; log rotasyonu.
- [x] Güncelleme prosedürü: `docs/ops/deploy.md` (imaj build, migrate,
      sıfır/az kesintiyle yeniden başlatma, geri alma).
- [ ] Sunucuda prova: S12 araçlarıyla bir export'u yükle, uygulamaları
      geçici olarak sunucuya bağlayıp dene (kişisel veri sunucuda kalır,
      prova sonrası silinir ya da geçişe kadar tutulur — kullanıcıya sor).

## Kabul kriterleri
- Coolify'dan deploy edilen API `https://<alan adı>/health` 200 dönüyor;
  WebSocket bağlantısı proxy'den geçiyor.
- Bir yedek alınıp boş bir veritabanına geri yüklendi.
- Dış port taraması yalnızca 22/80/443 gösteriyor (Coolify paneli dahil
  her şey 443 arkasında).

## Teslim notu
**Durum: kısmen (2026-11-24)** — repo tarafı bitti; sunucu, DNS, S3 ve
sırlar kullanıcıda (PROGRESS.md → açık sorular, S16 bölümü).

Yapılanlar:
- **İmaj** (`Dockerfile`): giriş `scripts/docker-entrypoint.sh` (tini
  altında): `dbmate up` → `set-api-password.mjs` → `node dist/main.js`;
  `MIGRATE_ON_START=0` ilk ikisini atlar. `dbmate` `dependencies`'e taşındı,
  `db/migrations` imajda. Healthcheck start period 60 sn. Yerelde
  `docker compose -p s16try --profile api up --build` ile boş veritabanında
  denendi: migration'lar + parola + `/health` 200; yeniden başlatma 0,3 sn
  (SIGTERM doğru iletiliyor), ikinci açılışta migration'lar boş geçti.
- **Güvenlik başlıkları** (`SECURITY_HEADERS`, `src/app.setup.ts`): nosniff,
  `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, HSTS 1 yıl,
  CSP `default-src 'none'`. CORP bilerek yok (logolar e-postada `<img>`).
  `test/health.e2e-spec.ts`.
- **Yedekleme**: `scripts/backup/backup.sh` (restic: DB `pg_dump -Fc` stdin
  + storage volume, 7/4/6 saklama, haftalık `check`, ping), `restore-db.sh`
  (konteyner içinde, boş hedef şartı, `roles.sql` → `pg_restore
  --single-transaction`), `restore-test.sh` (aylık, ağsız geçici konteyner,
  canlıyla sayım), `backup.env.example`, `ops/systemd/` (iki service +
  timer). `test/backup-restore.e2e-spec.ts`: seed'li DB → dump → boş
  konteyner → parmak izi, her tablonun satır sayısı, cron, migration
  geçmişi ve roller birebir; API açılıyor, giriş yapılıyor. Restic
  betikleri yerelde `restic/restic` imajıyla bir kez koşuldu (DB yedeği ve
  geri yükleme testi geçti; dosya örneği colima'nın /private/tmp
  bağlamamasından boş kaldı, Linux'ta `shuf` var).
- **Belgeler**: `docs/ops/deploy.md` (Coolify adım adım, env tablosu,
  doğrulama, güncelleme, geri alma, tek süreç varsayımı, alan adı değişimi),
  `server-setup.md`, `backup.md` (yedek, geri yükleme, aylık test, izleme,
  loglar). `docker/postgres/tuning.sql` (ALTER SYSTEM; geçici konteynerde
  uygulandı, pg_cron yüklü kaldı).

Bulunanlar:
- `auth_service` rolü (0005) `00_roles.sql`'de değil: yalnızca 00_roles ile
  geri yükleme `role "auth_service" does not exist` ile düşüyordu →
  `scripts/backup/roles.sql` beş rolü birlikte taşır, test rolleri de
  karşılaştırır (yeni rol eklenirse test düşer).
- Coolify'ın "Custom PostgreSQL Configuration" alanı imajın
  `postgresql.conf`'unu (pg_cron preload) ezer → boş bırakılır, ayar
  `ALTER SYSTEM` ile.

Bilinen eksikler / kullanıcıda: Coolify kaynakları, DNS, TLS, port
taraması, S3, monitörler, sunucuda prova (S12 export'u) — kabul
kriterlerinin üçü de sunucuda doğrulanacak. `cron.job_run_details`
temizlenmiyor (Supabase'te de öyleydi; ~100 bin satır/yıl, şimdilik sorun
değil).
