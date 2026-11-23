-- migrate:up
-- Boş başlangıç. dbmate, klasörde hiç migration yokken `up` komutunda hata
-- verir; bu dosya `npm run db:migrate`'in S01'den itibaren çalışmasını sağlar.
-- Şema S03'te 0001_baseline.sql (Supabase dump'ı + uyumluluk katmanı) ile gelir.
select 1;

-- migrate:down
select 1;
