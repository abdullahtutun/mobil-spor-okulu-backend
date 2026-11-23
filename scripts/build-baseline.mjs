#!/usr/bin/env node
// db/migrations/0001_baseline.sql'i üretir: uyumluluk katmanı + temizlenmiş
// Supabase şema dump'ı.
//
//   supabase db dump --project-ref <ref> -f dumps/schema.sql   # salt okunur, yalnızca şema
//   node scripts/build-baseline.mjs [dumps/schema.sql]
//
// Sıra: db/compat/00–03 (roller, eklentiler, auth, storage) → dump →
// db/compat/04–05 (dump'taki tanımların üzerine yazanlar, auth trigger'ı).
// Dump'tan ayıklanan her satır üretilen dosyanın başındaki yorumda listelenir.
// Aynı dump'tan her seferinde aynı dosya çıkar (tarih yok), böylece git diff
// yalnızca şema farkını gösterir.

import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const dumpPath = process.argv[2] ?? join(ROOT, 'dumps', 'schema.sql');
const compatDir = join(ROOT, 'db', 'compat');
const outPath = join(ROOT, 'db', 'migrations', '0001_baseline.sql');

/** Dump'tan çıkarılan satırlar: desen → neden. */
const REMOVALS = [
  [
    /^CREATE EXTENSION IF NOT EXISTS "(pg_cron|pgcrypto|uuid-ossp)"/,
    'eklenti db/compat/01_extensions.sql kurar',
  ],
  [
    /^CREATE EXTENSION IF NOT EXISTS "(pg_net|supabase_vault)"/,
    'K10: pg_net ve Vault yok (db/compat/04_supabase_removed.sql)',
  ],
  [
    /^CREATE EXTENSION IF NOT EXISTS "pg_stat_statements"/,
    'şema kullanmıyor; shared_preload ister',
  ],
  [/^ALTER PUBLICATION "supabase_realtime"/, 'K11: Realtime yayını yok'],
];

const dump = readFileSync(dumpPath, 'utf8');
if (!dump.includes('CREATE TABLE IF NOT EXISTS "public"')) {
  throw new Error(`${dumpPath} bir Supabase şema dump'ı gibi görünmüyor`);
}
if (/^(INSERT INTO|COPY) /m.test(dump)) {
  // Kişisel veri repoya girmez (PLAN.md değişmez kurallar).
  throw new Error(`${dumpPath} veri içeriyor; yalnızca şema dump'ı kullanın`);
}

const removed = [];
const kept = [];
for (const line of dump.split('\n')) {
  const hit = REMOVALS.find(([re]) => re.test(line));
  if (hit) removed.push(`${line.trim()}   -- ${hit[1]}`);
  else kept.push(line);
}
// pg_dump'ın art arda boş satırlarını sıkıştır.
const cleanedDump = kept
  .join('\n')
  .replace(/\n{4,}/g, '\n\n\n')
  .trim();

const compat = readdirSync(compatDir)
  .filter((f) => /^\d\d_.*\.sql$/.test(f))
  .sort();
const before = compat.filter((f) => Number(f.slice(0, 2)) < 4);
const after = compat.filter((f) => Number(f.slice(0, 2)) >= 4);
const section = (f) =>
  `-- ▼▼▼ db/compat/${f} ▼▼▼\n${readFileSync(join(compatDir, f), 'utf8').trim()}\n-- ▲▲▲ db/compat/${f} ▲▲▲`;

const header = `-- =============================================================================
-- 0001 — Taban şema: Supabase şema dump'ı + uyumluluk katmanı
-- =============================================================================
-- ÜRETİLMİŞ DOSYA, elle düzenlemeyin. Kaynaklar:
--   db/compat/*.sql            uyumluluk katmanı (okunur, yorumlu)
--   dumps/schema.sql           \`supabase db dump\` (yalnızca şema, repoda yok)
--   scripts/build-baseline.mjs bu dosyayı üretir
--
-- Yeniden üretmek (canlı şema değiştiyse; S03 → AGENTS.md "Schema sync"):
--   supabase db dump --project-ref <ref> -f dumps/schema.sql
--   node scripts/build-baseline.mjs
--
-- Dump: canlı Supabase projesinin public şeması, Postgres 17.6, 2026-11-23.
-- Dump'a girmeyen ve ayrıca eklenenler: auth şeması (02), storage şeması +
-- bucket satırları (03), auth.users trigger'ı (05), storage.objects
-- politikaları (0002), pg_cron işleri (0003).
--
-- Dump'tan ayıklananlar (${removed.length} satır):
${removed.map((r) => `--   ${r}`).join('\n')}
--
-- Dump'ta bırakılıp sonradan üzerine yazılan:
--   public.request_push_dispatch()  Vault + pg_net → pg_notify (04)
--
-- Sahiplik ve yetkiler dump'taki gibi: her nesne "postgres"in, GRANT'ler
-- anon / authenticated / service_role / postgres'e (supabase_admin vb.
-- Supabase iç rollerine giden yetki dump'ta yok).
-- =============================================================================
`;

const out = `-- migrate:up
${header}
${before.map(section).join('\n\n')}

-- ▼▼▼ Supabase şema dump'ı (temizlenmiş) ▼▼▼
${cleanedDump}
-- ▲▲▲ Supabase şema dump'ı ▲▲▲

-- Dump oturum ayarlarını değiştirir (search_path = '', row_security = off,
-- check_function_bodies = off). Sonraki dosyalar ve migration'lar normal
-- ayarlarla çalışsın.
RESET ALL;

${after.map(section).join('\n\n')}

-- migrate:down
-- Taban geri alınmaz: boş veritabanından yeniden kurun
-- (docker compose down -v && docker compose up -d db && npm run db:migrate).
do $$ begin raise exception '0001_baseline geri alınamaz'; end $$;
`;

writeFileSync(outPath, out);
console.log(
  `${outPath} yazıldı: ${removed.length} satır ayıklandı, compat: ${compat.join(', ')}`,
);
