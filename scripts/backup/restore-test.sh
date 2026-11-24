#!/usr/bin/env bash
# Aylık geri yükleme testi (docs/ops/backup.md). Son veritabanı yedeğini
# restic'ten alır, projenin Postgres imajından GEÇİCİ bir konteyner açar,
# restore-db.sh ile yükler, canlıyla tablo/kullanıcı sayısını karşılaştırır
# ve konteyneri siler. Canlı veritabanına yalnızca sayım sorgusu gider.
# Dosya deposunun son yedeğinden rastgele bir dosya da geri açılır.
#
#   /opt/mso/scripts/backup/restore-test.sh      (root, /etc/mso-backup.env)
set -Eeuo pipefail

ENV_FILE="${MSO_BACKUP_ENV:-/etc/mso-backup.env}"
# shellcheck disable=SC1090
[ -f "$ENV_FILE" ] && set -a && . "$ENV_FILE" && set +a
: "${RESTIC_REPOSITORY:?}" "${RESTIC_PASSWORD:?}" "${DB_CONTAINER:?}"
PG_IMAGE="${PG_IMAGE:-mobil-spor-okulu-postgres:17}"
HOST_TAG="${HOST_TAG:-mso-prod}"
HERE="$(cd "$(dirname "$0")" && pwd)"
WORK="$(mktemp -d)"
NAME="mso-restore-test-$$"

ping_result() {
  [ -n "${RESTORE_PING_URL:-}" ] || return 0
  curl -fsS -m 10 --retry 3 -o /dev/null "${RESTORE_PING_URL}$1" || true
}
cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; rm -rf "$WORK"; }
trap cleanup EXIT
trap 'ping_result /fail; echo "GERİ YÜKLEME TESTİ BAŞARISIZ (satır $LINENO)" >&2' ERR

echo "== son veritabanı yedeği"
restic dump --host "$HOST_TAG" --tag db latest postgres.dump > "$WORK/yedek.dump"

echo "== geçici Postgres"
docker run -d --name "$NAME" --network none \
  -e POSTGRES_PASSWORD="$(openssl rand -hex 16)" "$PG_IMAGE" >/dev/null
for _ in $(seq 1 60); do
  docker exec "$NAME" pg_isready -U postgres -d postgres >/dev/null 2>&1 && break
  sleep 1
done
sleep 2 # initdb sonrası yeniden başlama
docker exec "$NAME" mkdir -p /restore
docker cp "$HERE/restore-db.sh" "$NAME:/restore/restore-db.sh"
docker cp "$HERE/roles.sql" "$NAME:/restore/roles.sql"
docker cp "$WORK/yedek.dump" "$NAME:/restore/yedek.dump"
docker exec "$NAME" sh /restore/restore-db.sh /restore/yedek.dump

COUNT_SQL="select (select count(*) from pg_tables where schemaname='public') || '/' || (select count(*) from auth.users) || '/' || (select count(*) from cron.job)"
restored=$(docker exec "$NAME" psql -U postgres -d postgres -Atc "$COUNT_SQL")
live=$(docker exec "$DB_CONTAINER" psql -U postgres -d postgres -Atc "$COUNT_SQL")
echo "tablo/kullanıcı/cron — yedek: $restored · canlı: $live"
# Tablo ve cron sayısı aynı olmalı; kullanıcı sayısı yedekten bu yana artmış olabilir.
[ "${restored%%/*}" = "${live%%/*}" ] && [ "${restored##*/}" = "${live##*/}" ]

echo "== dosya deposundan bir örnek"
file=$(restic ls --host "$HOST_TAG" --tag storage latest --json \
  | grep '"type":"file"' | shuf -n 1 | sed -E 's/.*"path":"([^"]+)".*/\1/' || true)
if [ -n "$file" ]; then
  restic dump --host "$HOST_TAG" --tag storage latest "$file" | head -c 1 >/dev/null
  echo "açıldı: $(basename "$file")"
fi

ping_result ""
echo "Geri yükleme testi tamam."
