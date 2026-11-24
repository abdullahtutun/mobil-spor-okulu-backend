# Yedekleme, geri yükleme ve izleme

İki kopya, iki araç:

| Ne | Araç | Nereye | Ne zaman | Saklama |
|---|---|---|---|---|
| Veritabanı (`pg_dump -Fc`) | Coolify planlı yedek | S3 (ikinci lokasyon) | 02:00 TR | 7 kopya (Coolify) |
| Veritabanı + **dosya deposu** | `scripts/backup/backup.sh` (restic, şifreli) | aynı S3, ayrı önek `mso/` | 03:30 TR | 7 gün / 4 hafta / 6 ay |

Coolify dosya volume'unu (`/data/storage`: çocuk fotoğrafları, okul
logoları) **yedeklemez**; restic onu ve ikinci bir DB kopyasını alır.
Restic deposu istemci tarafında şifrelidir: S3 sağlayıcısı içeriği göremez.

## 1. Kurulum (bir kez, VPS'te root)

1. S3 uyumlu depoda (yurt içi, VPS'ten farklı lokasyon) bir bucket ve
   yalnızca o bucket'a yazabilen bir erişim anahtarı açın.
2. Coolify → Settings → **S3 Storages** → ekle (endpoint, bucket, anahtar)
   → "Test connection". Database → Backups → bu S3'ü seçin (deploy.md §3).
3. Restic ve betikler:

   ```bash
   apt-get install -y restic curl && restic self-update
   # /opt/mso: repo kopyası (deploy.md §2)
   install -m 600 /opt/mso/scripts/backup/backup.env.example /etc/mso-backup.env
   nano /etc/mso-backup.env        # RESTIC_*, AWS_*, DB_CONTAINER, STORAGE_PATH, ping adresleri
   openssl rand -base64 32         # RESTIC_PASSWORD — parola yöneticisine DE yazın
   docker volume ls | grep storage # STORAGE_PATH: docker volume inspect <ad> --format '{{.Mountpoint}}'
   cp /opt/mso/ops/systemd/mso-*.{service,timer} /etc/systemd/system/
   systemctl daemon-reload
   systemctl enable --now mso-backup.timer mso-restore-test.timer
   systemctl start mso-backup.service && journalctl -u mso-backup -n 30
   restic snapshots                 # env'i yükleyip: set -a; . /etc/mso-backup.env; set +a
   ```

   `DB_CONTAINER` Coolify'ın verdiği addır; Coolify veritabanını yeniden
   oluşturursa (ör. imaj değişince) adı aynı kalır, ama kontrol edin.

## 2. Geri yükleme

Hedef her zaman **boş** bir Postgres (projenin imajından). Dolu veritabanına
`restore-db.sh` yüklemeyi reddeder. Roller dump'ta olmadığı için betik önce
`scripts/backup/roles.sql`'i çalıştırır; `api_authenticator` parolası API
açılışında yeniden yazılır.

```bash
set -a; . /etc/mso-backup.env; set +a
# a) restic'ten (ya da Coolify → Backups → indir; ikisi de pg_dump -Fc)
restic snapshots --tag db
restic dump --tag db <snapshot|latest> postgres.dump > /root/yedek.dump

# b) Coolify'da yeni bir PostgreSQL kaynağı (deploy.md §3 ayarlarıyla) ya da
#    mevcut olanı durdurup volume'unu silin (GERİ DÖNÜŞÜ YOK — önce a'yı alın)
docker exec <yeni-db> mkdir -p /restore
docker cp /opt/mso/scripts/backup/. <yeni-db>:/restore/
docker cp /root/yedek.dump <yeni-db>:/restore/yedek.dump
docker exec <yeni-db> sh /restore/restore-db.sh /restore/yedek.dump
docker exec -i <yeni-db> psql -U postgres < /opt/mso/docker/postgres/tuning.sql   # + Restart

# c) API'nin DATABASE_URL / API_DATABASE_URL'ünü yeni host'a çevirip Redeploy;
#    /health 200, bir hesapla giriş.
shred -u /root/yedek.dump
```

Dosya deposu:

```bash
restic snapshots --tag storage
restic restore latest --tag storage --target /                  # yerinde (aynı yol)
# ya da tek dosya: restic dump --tag storage latest <tam yol> > dosya
chown -R 1000:1000 <STORAGE_PATH>
```

Veritabanı ile dosyalar ayrı saatlerde yedeklenir: aradaki yüklemelerin
satırı var dosyası yoksa okuma 404 döner (uygulama baş harfleri gösterir).

## 3. Aylık geri yükleme testi

`mso-restore-test.timer` ayın ilk pazarı `scripts/backup/restore-test.sh`'ı
çalıştırır: son DB yedeğini **ağsız geçici** bir konteynere yükler, tablo ve
cron işi sayısını canlıyla karşılaştırır, dosya deposundan rastgele bir
dosyayı açar, konteyneri ve dosyayı siler. Sonuç `RESTORE_PING_URL`'e.

Elle: `systemctl start mso-restore-test && journalctl -u mso-restore-test -n 40`.
Yılda bir de §2'yi baştan sona (API'yi geri yüklenen veritabanına bağlayıp
giriş yaparak) prova edin.

Aynı yol repoda testli: `test/backup-restore.e2e-spec.ts` seed'li
veritabanını `pg_dump -Fc` ile alır, boş konteynere `restore-db.sh` ile
yükler; şema parmak izi, her tablonun satır sayısı, cron işleri, migration
geçmişi ve roller birebir aynı, API açılıyor ve giriş yapılıyor.

## 4. İzleme

Sunucunun dışından izlenmeli (sunucu düşünce kendi izleyicisi de düşer).

| Ne | Nasıl | Uyarı |
|---|---|---|
| API ayakta | UptimeRobot (ya da başka sunucudaki Uptime Kuma) HTTP(s) monitör: `https://api.mobilsporokulu.com/health`, 1–5 dk, anahtar kelime `"database":"ok"` | e-posta / Telegram |
| TLS sertifikası | aynı monitörün "SSL expiry" uyarısı (14 gün) | |
| Gece yedeği | Push/heartbeat monitör, aralık 24 s + 2 s tolerans → `BACKUP_PING_URL` | ping gelmezse ya da `/fail` |
| Geri yükleme testi | ikinci push monitör, aralık 31 gün → `RESTORE_PING_URL` | |
| Disk / RAM / CPU | Coolify → Servers → `<sunucu>` → Metrics açık; Settings → Notifications (e-posta/Telegram) → "Server disk usage" eşiği %80 | |
| Coolify DB yedeği | Coolify → Notifications → "Backup failure" | |
| Konteyner çöktü | Coolify → Notifications → "Container status changes" | |

`/health` veritabanını da sorar (`select 1`); `/health/live` yalnızca süreci.
healthchecks.io ping adresi biçimi `https://hc-ping.com/<uuid>` (betik
`/start`, `/fail` ekler); Uptime Kuma push adresinde `/fail` yoktur — hata
durumunda ping gitmez ve monitör zamanında uyarır, bu da yeterli.

## 5. Loglar

- API: pino JSON → stdout → Docker json-file (server-setup.md §6: 20 MB × 5).
  Coolify → Logs'ta görünür. Token, parola, kod ve kişisel veri gövdeleri
  loglanmaz (AGENTS.md).
- Postgres: 500 ms'den uzun sorgular (`tuning.sql`), parametresiz.
- Yedek/test: `journalctl -u mso-backup`, `-u mso-restore-test`.
- 5651 erişim kayıtları: açık soru (PROGRESS.md) — karara göre ayrı saklama.
