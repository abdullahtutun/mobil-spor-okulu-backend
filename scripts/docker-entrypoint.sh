#!/bin/sh
# API konteynerinin girişi (Dockerfile). Coolify her dağıtımda yeni
# konteyneri bununla açar:
#
#   1. dbmate up   — bekleyen migration'lar (DATABASE_URL, postgres).
#   2. api_authenticator parolası — API_DATABASE_URL'deki parola role yazılır
#      (rol parolasız oluşur; geri yüklenen yedekte de parola yoktur).
#   3. API (tini altında; SIGTERM Nest'in kapanış kancalarına gider).
#
# MIGRATE_ON_START=0 ile 1–2 atlanır (ör. veri taşıma sırasında API'yi
# migration'sız açmak için). Bir adım başarısızsa konteyner açılmaz ve
# Coolify eski konteyneri çalışır bırakır.
set -eu

if [ "${MIGRATE_ON_START:-1}" != "0" ]; then
  echo "[giriş] migration'lar"
  dbmate --url "$DATABASE_URL" --migrations-dir /app/db/migrations \
    --no-dump-schema --wait --wait-timeout 60s up
  echo "[giriş] api_authenticator parolası"
  node /app/scripts/set-api-password.mjs
fi

exec node /app/dist/main.js
