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
- [ ] Coolify'da proje + `production` ortamı.
- [ ] Postgres: Coolify "Database" kaynağı, **özel imaj** (S01'in
      `docker/postgres/Dockerfile`'ı registry'ye ya da Coolify'ın Dockerfile
      build'iyle) — pg_cron şart. Dışarı port açılmaz; bellek ayarları VPS'e
      göre.
- [ ] API: Coolify "Application", repo'daki `Dockerfile` ile build;
      ortam değişkenleri Coolify'da (sırlar repoda değil); storage için
      kalıcı volume (`STORAGE_ROOT`); healthcheck `/health`; deploy öncesi
      `db:migrate` (pre-deploy komutu ya da açılışta, hangisi seçildiyse
      gerekçeli).
- [ ] Alan adı + TLS Coolify proxy'sinden; WebSocket (`/realtime`),
      gövde boyutu sınırı, güvenlik başlıkları, gerçek istemci IP'sinin
      `X-Forwarded-For` ile API'ye gelmesi (S10'un hız sınırı buna bağlı)
      doğrulanır.
- [ ] `docs/ops/server-setup.md`: sunucu sertleştirme kontrol listesi —
      SSH yalnızca anahtar, `ufw`, `unattended-upgrades`, `fail2ban`,
      Coolify panelinin alan adı + TLS arkasında olması ve 8000 portunun
      kapatılması, Coolify'ın kendi güncellemeleri.
- [ ] Yedekleme: Coolify'ın planlı veritabanı yedeği → ikinci lokasyondaki
      S3; **storage volume'u ayrıca** (Coolify bunu yedeklemez:
      `scripts/backup/` + `restic` ya da `rclone`, timer). Saklama politikası
      (ör. 7 gün/4 hafta/6 ay). **Geri yükleme adımları ve aylık geri
      yükleme testi.**
- [ ] İzleme: `/health` için dış izleme (UptimeRobot ya da Uptime Kuma),
      disk/RAM uyarısı, yedek başarısızlığı bildirimi; log rotasyonu.
- [ ] Güncelleme prosedürü: `docs/ops/deploy.md` (imaj build, migrate,
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
_(oturum sonunda doldurulur)_
