#!/bin/sh
# Veritabanı yedeğini (pg_dump -Fc; Coolify'ın planlı yedeği de bu biçimde)
# BOŞ bir Postgres'e geri yükler. Postgres konteynerinin İÇİNDE çalışır
# (psql/pg_restore oradadır):
#
#   docker cp scripts/backup/.  <db>:/restore/
#   docker cp yedek.dump        <db>:/restore/yedek.dump
#   docker exec <db> sh /restore/restore-db.sh /restore/yedek.dump
#
# Hedef: projenin imajından (docker/postgres) yeni açılmış, migration
# uygulanmamış bir küme — ICU en-US ve pg_cron initdb/açılışta gelir.
# Dolu bir veritabanına yüklemeyi reddeder.
#
# Roller küme geneli olduğu için pg_dump'ta yoktur; önce yanındaki
# roles.sql (anon, authenticated, service_role, auth_service,
# api_authenticator) çalışır. Rol
# parolası da dump'ta yoktur: API açılışta API_DATABASE_URL'deki parolayı
# yeniden yazar (scripts/docker-entrypoint.sh).
set -eu

DUMP="${1:?kullanım: restore-db.sh <yedek.dump>}"
DB="${PGDATABASE:-postgres}"
PGUSER="${PGUSER:-postgres}"
export PGUSER
HERE="$(cd "$(dirname "$0")" && pwd)"
ROLES_SQL="${ROLES_SQL:-$HERE/roles.sql}"

[ -f "$DUMP" ] || { echo "Yedek yok: $DUMP" >&2; exit 1; }
[ -f "$ROLES_SQL" ] || { echo "roles.sql yok: $ROLES_SQL" >&2; exit 1; }

tables=$(psql -d "$DB" -Atc "select count(*) from pg_tables where schemaname = 'public'")
if [ "$tables" != "0" ]; then
  echo "Hedef boş değil (public'te $tables tablo). Yeni bir Postgres açın." >&2
  exit 1
fi

echo "1/3 roller"
psql -d "$DB" -v ON_ERROR_STOP=1 -q -f "$ROLES_SQL"

echo "2/3 pg_restore"
# Tek transaction: yarım yüklenmiş veritabanı kalmaz.
pg_restore -d "$DB" --exit-on-error --single-transaction "$DUMP"

echo "3/3 denetim"
psql -d "$DB" -v ON_ERROR_STOP=1 -Atc "
  select 'tablo (public): ' || count(*) from pg_tables where schemaname = 'public';
  select 'kullanıcı: ' || count(*) from auth.users;
  select 'cron işi: ' || count(*) from cron.job;
  select 'son migration: ' || max(version) from public.schema_migrations;"
echo "Geri yükleme bitti. API'yi bu veritabanına bağlayıp /health'e bakın."
