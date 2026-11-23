-- =============================================================================
-- Uyumluluk katmanı 00 — roller (PLAN.md K5, AGENTS.md karar 2)
-- =============================================================================
-- Supabase'teki üç istek rolü aynı adlarla. Şemadaki 200'ü aşkın GRANT ve
-- 72 politika bu adlara yazılı; adlar değişirse hiçbiri çalışmaz.
--
--   anon           oturumsuz istek. RLS uygulanır.
--   authenticated  giriş yapmış kullanıcı. RLS uygulanır, auth.uid() dolu.
--   service_role   sunucunun kendi işleri (eski Edge Function'lar). RLS'i
--                  aşar (bypassrls) — Supabase'teki gibi.
--
-- Üçü de giriş yapamaz (nologin). API `api_authenticator` olarak bağlanır
-- ve her istekte `set local role <rol>` ile bunlardan birine geçer
-- (PostgREST'in `authenticator` modeli). `noinherit`: bağlantı kendi başına
-- hiçbir rolün yetkisini taşımaz, yalnızca geçiş yapabilir.
--
-- Parola burada verilmez (sır repoya girmez). Ortam kurulurken:
--   alter role api_authenticator password '<.env içindeki parola>';
-- (S04 yerel/test için, S16 üretim için.)
--
-- Roller küme genelidir; aynı sunucuda ikinci bir veritabanı kurulursa
-- zaten vardır, bu yüzden "yoksa oluştur".
-- =============================================================================

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin noinherit bypassrls;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'api_authenticator') then
    create role api_authenticator login noinherit;
  end if;
end;
$$;

grant anon, authenticated, service_role to api_authenticator;
