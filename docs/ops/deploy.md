# Üretim dağıtımı (Coolify)

PLAN.md K15: VPS'te Coolify kurulu; proxy (Traefik), TLS, git'ten build ve
veritabanı yedeği Coolify'dan. Bu dosya ilk kurulumu, her güncellemeyi ve
geri almayı adım adım anlatır. Sunucunun kendisi: `server-setup.md`;
yedek ve izleme: `backup.md`. `<…>` ile yazılanlar kullanıcının değerleri
(alan adı, sırlar) — repoya girmez.

Varsayılan alan adı **`api.mobilsporokulu.com`** (K13): yönetim ve veli
uygulamalarının `config/*.json` → `API_BASE_URL`, sitenin
`src/config/site.ts` + `public/.htaccess` CSP `connect-src`'i bunu
yazıyor. Alan adı değişirse **dördü birlikte** değişir (`api-domain`
bölümü, aşağıda).

## 0. Önkoşullar

- `server-setup.md` tamam (SSH anahtarı, ufw 22/80/443, Coolify paneli
  alan adı + TLS arkasında, 8000 kapalı).
- DNS: `api.mobilsporokulu.com` → VPS IP'si, **A kaydı, vekilsiz** (Cloudflare
  kullanılıyorsa gri bulut / "DNS only": turuncu bulutta TLS yurt dışında
  açılır, aydınlatma metni de değişir; `TRUST_PROXY` 2 olur).
- Repo Coolify'ın erişebileceği bir yerde (özel GitHub reposu + Coolify
  GitHub App önerilir; ya da deploy key).

## 1. Proje

Coolify → Projects → **New** → ad `mobil-spor-okulu` → ortam
`production`. Aşağıdaki iki kaynak aynı ortamda ve aynı sunucu ağında
(`coolify`) durur; birbirlerini iç adla bulur.

## 2. Postgres imajı

Coolify'ın "Database" kaynağı bir imaj adı ister, Dockerfile build etmez.
pg_cron'lu imaj (`docker/postgres/Dockerfile`) VPS'te bir kez build edilir
(Postgres sürümü değişmedikçe yeniden gerekmez):

```bash
# VPS'te (repo erişimi olan bir kullanıcıyla)
git clone <repo> /opt/mso && cd /opt/mso
docker build -t mobil-spor-okulu-postgres:17 docker/postgres
```

`/opt/mso` aynı zamanda yedek betiklerinin yeri (`backup.md`).

Coolify'ın Database kaynağı imajı **her açılışta registry'den çeker**; yerel
imajı kullanmaz (`pull access denied`). İmaj GHCR'a konur ve paket **Public**
yapılır (içinde sır yok: postgres + pg_cron):

```bash
# klasik token, yalnızca write:packages
echo '<ghp_…>' | docker login ghcr.io -u <kullanıcı> --password-stdin
docker tag mobil-spor-okulu-postgres:17 ghcr.io/<kullanıcı>/mobil-spor-okulu-postgres:17
docker push ghcr.io/<kullanıcı>/mobil-spor-okulu-postgres:17
docker logout ghcr.io
# GitHub → Packages → mobil-spor-okulu-postgres → Package settings → Change visibility → Public
```

## 3. Veritabanı kaynağı

Coolify → `production` → **+ New** → Databases → **PostgreSQL**:

| Ayar | Değer |
|---|---|
| Image | `ghcr.io/<kullanıcı>/mobil-spor-okulu-postgres:17` |
| Username / Database | `postgres` / `postgres` (pg_cron yalnızca `postgres`'te çalışır) |
| Password | uzun rastgele (`openssl rand -base64 32`), parola yöneticisine |
| Make it publicly available | **kapalı** (dışarı port yok) |
| Custom PostgreSQL Configuration | **boş** (doluysa pg_cron yüklenmez) |
| Backups | Scheduled: `0 23 * * *` (02:00 TR), S3: `backup.md` §1, saklama 7 |

İlk açılıştan sonra:

```bash
DB=$(docker ps --format '{{.Names}} {{.Image}}' | awk '/mobil-spor-okulu-postgres/{print $1}')   # <db> = $DB
docker exec <db> psql -U postgres -Atc "show shared_preload_libraries"   # pg_cron
docker exec -i <db> psql -U postgres -d postgres < /opt/mso/docker/postgres/tuning.sql
# Coolify → Database → Restart; değerler VPS RAM'ine göre (dosyanın başı)
docker exec <db> psql -U postgres -Atc "select datlocprovider, datlocale from pg_database where datname='postgres'"   # i | en-US
```

Coolify'daki **"Postgres URL (internal)"** adresi `DATABASE_URL`'in
kaynağıdır (`postgres://postgres:<parola>@<iç ad>:5432/postgres`).

## 4. API uygulaması

Coolify → `production` → **+ New** → Application → (GitHub App / deploy
key) → repo, dal `main`:

| Ayar | Değer |
|---|---|
| Build Pack | **Dockerfile** |
| Base Directory / Dockerfile Location | `/` / `/Dockerfile` |
| Ports Exposes | `3000` |
| Domains | `https://api.mobilsporokulu.com` |
| Health Check | açık, path **`/health`** (DB'yi de sorar), port 3000, interval 15 s, start period 60 s |
| Persistent Storage | Volume, ad `mso-storage`, hedef **`/data/storage`** |
| Replicas | **1** (hız sınırları ve realtime tek süreçte; aşağıda) |
| Pre/Post-deployment command | boş (migration açılışta, aşağıda) |
| Custom Docker options | boş (tini imajda) |
| Automatic deploy (webhook) | isteğe bağlı; önerilen: **elle** (geçiş döneminde) |

Traefik varsayılanları yeterli; ek label gerekmez:

- **WebSocket** (`/realtime`): Traefik `Upgrade`/`Connection` başlıklarını
  geçirir; boşta kalma sınırı yok, sunucu 30 sn'de bir ping atar.
- **Gövde boyutu**: Traefik sınır koymaz; sınır API'de (`BODY_LIMIT` JSON,
  storage bucket başına 1–2 MB, `STORAGE_MAX_FILE_SIZE` 5 MB).
- **İstemci IP'si**: Traefik `X-Forwarded-For`'a gerçek IP'yi ekler;
  `TRUST_PROXY=1` ile API onu okur (önde ikinci vekil yoksa).
- **Güvenlik başlıkları** API'den gelir (`SECURITY_HEADERS`,
  `src/app.setup.ts`: nosniff, DENY, no-referrer, HSTS, CSP `default-src
  'none'`); HTTP→HTTPS yönlendirmesini Coolify yapar.

### Açılışta migration — neden pre-deploy değil

İmajın girişi (`scripts/docker-entrypoint.sh`) sırayla `dbmate up`,
`api_authenticator` parolasını `API_DATABASE_URL`'den yazma ve API'yi
çalıştırır. Bir adım düşerse yeni konteyner sağlıklı olmaz ve Coolify eski
konteyneri bırakır. Coolify belgelerine göre "pre-deployment command" eski (çalışan)
konteynerde koşar — yeni migration dosyaları orada yoktur. Tek replika
olduğu için iki konteynerin aynı anda migration yapması söz konusu değil;
dbmate her dosyayı tek transaction'da uygular.
`MIGRATE_ON_START=0` iki adımı atlar (S17'de veri yüklerken).

**Migration kuralı (az kesinti):** yeni konteyner eski konteyner hâlâ
trafik alırken migration yapar. Bir migration eski kodu kırmamalı (sütun
silme/yeniden adlandırma iki dağıtıma bölünür: önce kod, sonra şema).

## 5. Ortam değişkenleri (Coolify → Application → Environment Variables)

Hepsi `src/config/env.schema.ts`'te doğrulanır; eksik/hatalıysa API açılmaz
ve logda tek satır söyler. Sırlar yalnızca Coolify'da ("Is Secret"
işaretli), repoda yalnız `.env.example`.

| Anahtar | Üretim değeri | Kaynak |
|---|---|---|
| `NODE_ENV` | `production` | |
| `LOG_LEVEL` | `info` | |
| `DATABASE_URL` | Coolify'ın iç Postgres URL'si, sonuna `?sslmode=disable` | §3 |
| `API_DATABASE_URL` | aynı host, kullanıcı `api_authenticator`, **ayrı** uzun parola | yeni üretin |
| `JWT_SECRET` | `openssl rand -base64 48` | yeni (Supabase'inki gerekmez, S12) |
| `JWT_EXPIRY_SEC` / `JWT_ISSUER` | `3600` / `mobil-spor-okulu-api` | |
| `TRUST_PROXY` | **`1`** (Traefik). Cloudflare turuncu bulut varsa `2` | §4 |
| `CORS_ORIGINS` | `https://mobil.devadim.com,https://yonetim.mobilsporokulu.com,https://veli.mobilsporokulu.com,<Dev Adım veli web kökeni varsa>` | web paketleri |
| `SITE_ALLOWED_ORIGINS` | boş (= `https://mobilsporokulu.com`, `www`, localhost) ya da localhost'suz liste | site |
| `SITE_LEAD_NOTIFY_TO` | Supabase secrets'taki değer | kullanıcı |
| `IP_HASH_SALT` | **Supabase secrets'taki değer** (aynı olursa özetler süreklilik taşır) | kullanıcı |
| `SMTP_HOST` / `SMTP_PORT` | `smtp.hostinger.com` / `465` | |
| `SMTP_USER_DEV_ADIM` / `SMTP_PASS_DEV_ADIM` | `gonder@devadim.com` kutusu | Supabase secrets |
| `SMTP_USER_PUBLIC` / `SMTP_PASS_PUBLIC` | `noreply@mobilsporokulu.com` kutusu | Supabase secrets |
| `FCM_SERVICE_ACCOUNT` | servis hesabı JSON'u **tek satır** (boş = push kapalı, kuyruk bekler) | Supabase secrets |
| `PUSH_SWEEP_INTERVAL_MS` | `300000` | |
| `STORAGE_ROOT` | `/data/storage` (imaj varsayılanı; volume buraya) | §4 |
| `STORAGE_MAX_FILE_SIZE` | `5242880` | |
| `BODY_LIMIT` / `THROTTLE_LIMIT` / `THROTTLE_TTL_MS` | `1mb` / `600` / `60000` | |
| `AUTH_*` | `.env.example`'daki varsayılanlar | |
| `REALTIME_*` | `.env.example`'daki varsayılanlar | |
| `MIGRATE_ON_START` | boş/`1` (yalnızca S17 yüklemesinde `0`) | §4 |

`PORT` verilmez (imaj 3000). Supabase secrets'taki değerler panelde
görünmez (yalnızca özet); kullanıcı kendi kaydından ya da Hostinger/
Firebase'den yeniden alır.

## 6. İlk dağıtım ve doğrulama (kabul kriterleri)

```bash
curl -si https://api.mobilsporokulu.com/health          # 200 {"status":"ok","database":"ok"} + güvenlik başlıkları
curl -si https://api.mobilsporokulu.com/health/live     # 200
# WebSocket vekilden geçiyor mu (101 Switching Protocols, sonra kapatın):
curl -si --http1.1 -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
  -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' \
  https://api.mobilsporokulu.com/realtime | head -1
# Gerçek IP: API loglarında (Coolify → Logs) kendi ev IP'niz görünmeli, 10.x/172.x değil.
# CORS: yönetim web kökeninden ön uçuş
curl -si -X OPTIONS -H 'Origin: https://yonetim.mobilsporokulu.com' \
  -H 'Access-Control-Request-Method: POST' https://api.mobilsporokulu.com/rpc/get_session_data | grep -i access-control-allow-origin
# Dışarıdan port taraması (başka bir makineden): yalnızca 22, 80, 443
nmap -Pn -p- --min-rate 2000 <VPS IP>
```

Tek seferlik: `docker exec <api> ls -ld /data/storage` sahibi `node`
(uid 1000) olmalı (boş volume imajdaki sahipliği alır).

## 7. Güncelleme (her sürüm)

1. Yerelde: `npm run lint && npm run typecheck && npm test && npm run test:e2e`,
   `main`'e commit, push.
2. Coolify → Application → **Deploy** (ya da webhook). Coolify imajı build
   eder, yeni konteyner migration + sağlık kontrolünden geçince trafiği
   ona verir, eskisini SIGTERM'le kapatır (tini → Nest kapanış kancaları:
   WebSocket'ler 1001 ile kapanır, istemciler yeniden bağlanır).
3. §6'daki ilk iki `curl`; Coolify → Logs'ta `[giriş]` satırları.

Kesinti: build sırasında yok; geçişte açık WebSocket'ler yeniden bağlanır,
bellekteki hız sınırı sayaçları sıfırlanır (aşağıda).

## 8. Geri alma

- **Kod**: Coolify → Application → Deployments → önceki başarılı dağıtım →
  **Redeploy** (ya da `main`'de `git revert` + deploy).
- **Şema**: dbmate migration'ları ileri yönlüdür; geri almak gerekiyorsa
  önce yeni bir düzeltme migration'ı yazın. `npm run db:rollback` yalnızca
  `-- migrate:down`'u olan ve henüz veri yazılmamış son migration içindir:
  `docker exec <api> dbmate --url "$DATABASE_URL" --migrations-dir /app/db/migrations rollback`.
- **Veri**: `backup.md` → "Geri yükleme".

## Tek süreç varsayımı

Şunlar API sürecinin belleğinde tutulur; Replicas **1** kalmalı:

- hız sınırları (`ThrottlerModule`, giriş/OTP/e-posta pencereleri, S04–S06;
  ön kayıt ve site lead sınırları DB'de, onlar etkilenmez) — dağıtımda
  sıfırlanır, bu kabul edildi;
- realtime abonelikleri (kullanıcının soketi hangi süreçteyse NOTIFY o
  süreçte işlenir);
- push süpürme zamanlayıcısı.

İkinci replika gerekirse: hız sınırları Redis/DB'ye, realtime için her
süreç zaten kendi LISTEN'ini açıyor (çalışır), push worker'da
`claim_push_batch` `skip locked` (çalışır) — yalnızca sayaçlar taşınmalı.

## S12 araçları sunucuda (prova / S17)

```bash
docker exec -it <api> node dist/data-migration/cli.js --help
# hedef DATABASE_URL zaten postgres (süper kullanıcı); STORAGE_ROOT API'ninkiyle aynı
```

Export klasörü konteynerin içinde geçicidir; `RUNBOOK-data.md`'deki sırayı
izleyin, iş bitince silin.

## API alan adı değişirse (`api-domain`)

Birlikte değişir: yönetim `config/dev_adim.json` + `config/public.json`,
veli `config/*.json` (`API_BASE_URL`), site `src/config/site.ts`
(varsayılan uç) + `public/.htaccess` (CSP `connect-src`), bu dosya,
Coolify Domains. Mağaza sürümü gerektirir (yerel yapılandırma).
