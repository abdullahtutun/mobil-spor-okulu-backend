#!/usr/bin/env bash
# Sunucudaki gece yedeği (docs/ops/backup.md). VPS'te root olarak, systemd
# timer'ıyla (ops/systemd/mso-backup.timer) çalışır; ayarlar
# /etc/mso-backup.env'den (scripts/backup/backup.env.example).
#
#   1. Veritabanı: Postgres konteynerinde pg_dump -Fc → restic (stdin).
#      Coolify'ın kendi planlı yedeği de S3'e gider; bu ikinci kopya aynı
#      restic deposunda, aynı saklama politikasıyla durur.
#   2. Dosya deposu: API'nin STORAGE_ROOT volume'u (çocuk fotoğrafları,
#      logolar). Coolify bunu YEDEKLEMEZ.
#   3. Saklama: 7 günlük, 4 haftalık, 6 aylık (restic forget --prune).
#   4. Sonuç: BACKUP_PING_URL'e başarı, hata olursa /fail (Uptime Kuma push
#      ya da healthchecks.io). Ping gelmezse izleme uyarır.
#
# restic deposu şifrelidir (RESTIC_PASSWORD); şifre kaybolursa yedek açılmaz —
# parola yöneticisinde ve sunucu dışında saklayın.
set -Eeuo pipefail

ENV_FILE="${MSO_BACKUP_ENV:-/etc/mso-backup.env}"
# shellcheck disable=SC1090
[ -f "$ENV_FILE" ] && set -a && . "$ENV_FILE" && set +a

: "${RESTIC_REPOSITORY:?}" "${RESTIC_PASSWORD:?}"
: "${DB_CONTAINER:?Postgres konteynerinin adı (docker ps)}"
: "${STORAGE_PATH:?STORAGE_ROOT volume yolu (sunucuda)}"
KEEP_DAILY="${KEEP_DAILY:-7}"
KEEP_WEEKLY="${KEEP_WEEKLY:-4}"
KEEP_MONTHLY="${KEEP_MONTHLY:-6}"
HOST_TAG="${HOST_TAG:-mso-prod}"

ping_result() {
  [ -n "${BACKUP_PING_URL:-}" ] || return 0
  curl -fsS -m 10 --retry 3 -o /dev/null "${BACKUP_PING_URL}$1" || true
}
trap 'ping_result /fail; echo "YEDEK BAŞARISIZ (satır $LINENO)" >&2' ERR

ping_result /start

# Depo yoksa bir kez oluştur (ilk çalıştırma).
restic cat config >/dev/null 2>&1 || restic init

echo "== veritabanı"
docker exec "$DB_CONTAINER" pg_dump -U postgres -d postgres -Fc \
  | restic backup --host "$HOST_TAG" --tag db --stdin \
      --stdin-filename postgres.dump

echo "== dosya deposu"
[ -d "$STORAGE_PATH" ] || { echo "STORAGE_PATH yok: $STORAGE_PATH" >&2; false; }
restic backup --host "$HOST_TAG" --tag storage "$STORAGE_PATH"

echo "== saklama"
restic forget --host "$HOST_TAG" --group-by host,tags \
  --keep-daily "$KEEP_DAILY" --keep-weekly "$KEEP_WEEKLY" \
  --keep-monthly "$KEEP_MONTHLY" --prune

# Haftada bir (pazar) verinin bir kısmını okuyarak depoyu denetle.
if [ "$(date +%u)" = "7" ]; then
  restic check --read-data-subset=5%
fi

ping_result ""
echo "Yedek tamam."
