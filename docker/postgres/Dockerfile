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

# Sıralama canlıdakiyle aynı olsun: Supabase veritabanı ICU sağlayıcısıyla
# `en-US` (datlocprovider = i, 2026-11-23). libc `en_US.utf8` '_' ve
# büyük/küçük harfi farklı sıralar; SQL fonksiyonlarındaki `order by ad`
# ve sayfalı okumalar canlıyla aynı sırayı vermeli. Yalnızca initdb'de
# (boş veri klasöründe) etkilidir. Saat dilimi de canlıdaki gibi UTC.
ENV POSTGRES_INITDB_ARGS="--encoding=UTF8 --locale=en_US.UTF-8 --locale-provider=icu --icu-locale=en-US"
RUN printf "timezone = 'UTC'\nlog_timezone = 'UTC'\n" >> /usr/share/postgresql/postgresql.conf.sample
