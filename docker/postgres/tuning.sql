-- Üretim Postgres'inin bellek ayarları (docs/ops/deploy.md, adım 3).
-- Coolify'daki Postgres'e bir kez, postgres kullanıcısıyla:
--   docker exec -i <db> psql -U postgres -d postgres < docker/postgres/tuning.sql
--   ardından Coolify'dan veritabanını yeniden başlatın.
--
-- ALTER SYSTEM değerleri veri volume'undaki postgresql.auto.conf'a yazar;
-- imajdaki shared_preload_libraries = 'pg_cron' satırına dokunmaz. Coolify'ın
-- "Custom PostgreSQL Configuration" alanını BOŞ bırakın: o alan kendi
-- postgresql.conf'unu bağlar ve pg_cron'u yüklenmez hâle getirir.
--
-- Değerler Postgres'e ayrılan ~2 GB RAM içindir (4 GB'lık VPS, API ~300 MB,
-- Coolify ~500 MB). Farklı bütçede: shared_buffers ≈ %25, effective_cache_size
-- ≈ %60–70 (Postgres'in payı), work_mem bağlantı sayısına bölünür.
alter system set shared_buffers = '512MB';
alter system set effective_cache_size = '1536MB';
alter system set work_mem = '8MB';
alter system set maintenance_work_mem = '128MB';
-- API havuzu (DB_POOL, ~10) + LISTEN (1) + dbmate + yedek + yönetim payı
alter system set max_connections = 50;
alter system set random_page_cost = 1.1;          -- SSD
alter system set wal_compression = on;
alter system set checkpoint_completion_target = 0.9;
-- 500 ms'den uzun sorgular loglanır (yavaş sorgu izleme; parametre yazılmaz)
alter system set log_min_duration_statement = 500;
alter system set log_parameter_max_length = 0;
