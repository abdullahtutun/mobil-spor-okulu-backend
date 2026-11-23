# Projenin Postgres imajı: Supabase projesiyle aynı major sürüm (PLAN.md K4)
# + pg_cron. Yerelde docker compose, testlerde Testcontainers, üretimde
# Coolify bu dosyadan build eder.
ARG PG_MAJOR=17
FROM postgres:${PG_MAJOR}-bookworm

ARG PG_MAJOR
# Resmî imajda PGDG apt deposu zaten tanımlı.
RUN apt-get update \
 && apt-get install -y --no-install-recommends "postgresql-${PG_MAJOR}-cron" \
 && rm -rf /var/lib/apt/lists/*

# pg_cron açılışta yüklenmeli ve tek bir veritabanında çalışır. Supabase'te
# o veritabanı `postgres`; şema dump'ı (S03) da oraya yüklenir.
RUN printf "\n# --- mobil-spor-okulu ---\nshared_preload_libraries = 'pg_cron'\ncron.database_name = 'postgres'\ncron.timezone = 'UTC'\n" \
    >> /usr/share/postgresql/postgresql.conf.sample
