#!/usr/bin/env node
// Yönetim reposuna eklenen bir Supabase migration'ını bu repoya dbmate
// migration'ı olarak taşır (AGENTS.md → "Schema sync").
//
//   node scripts/import-migration.mjs ../mobil_spor_okulu/supabase/migrations/20261027_app_min_versions.sql
//
// Yaptığı:
//   * sıradaki numarayı verir: db/migrations/00NN_<ad>.sql (ad, tarih öneki
//     atılmış dosya adı);
//   * en üst düzeydeki `begin;` / `commit;` satırlarını atar — dbmate her
//     migration'ı zaten tek transaction'da çalıştırır, içerideki commit onun
//     transaction'ını erken bitirirdi;
//   * `_rollback/<ad>_rollback.sql` varsa onu `-- migrate:down`'a koyar,
//     yoksa geri almanın elle yapılacağını yazar.
// İçeriğe başka dokunmaz. Supabase'e özgü bir şey (pg_net, vault, publication,
// storage.buckets'a yazma …) içeriyorsa çıktı uyarır; elle uyarlayın.

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const migrationsDir = join(ROOT, 'db', 'migrations');

const source = process.argv[2];
if (!source) {
  console.error('kullanım: node scripts/import-migration.mjs <yönetim migration dosyası>');
  process.exit(2);
}

const file = basename(source, '.sql');
const name = file.replace(/^\d{8}_/, '');

const existing = readdirSync(migrationsDir).filter((f) => /^\d{4}_.*\.sql$/.test(f));
const already = existing.find((f) =>
  readFileSync(join(migrationsDir, f), 'utf8').includes(`(imported from ${file})`),
);
if (already) {
  console.error(`zaten taşınmış: db/migrations/${already}`);
  process.exit(1);
}
const next = Math.max(...existing.map((f) => Number(f.slice(0, 4)))) + 1;
const target = join(migrationsDir, `${String(next).padStart(4, '0')}_${name}.sql`);

const stripTx = (sql) =>
  sql
    .split('\n')
    .filter((line) => !/^\s*(begin|commit)\s*;\s*$/i.test(line))
    .join('\n')
    .trim();

const up = stripTx(readFileSync(source, 'utf8'));
const rollbackPath = join(dirname(source), '_rollback', `${file}_rollback.sql`);
const down = existsSync(rollbackPath)
  ? stripTx(readFileSync(rollbackPath, 'utf8'))
  : `-- Yönetim reposunda geri alma dosyası yok; gerekirse elle yazın.\nselect 1;`;

const out = `-- migrate:up
-- Yönetim reposundan taşındı (imported from ${file}):
--   ../mobil_spor_okulu/supabase/migrations/${file}.sql
-- İçerik aynı; yalnızca üst düzey begin/commit atıldı (dbmate transaction'ı).
${up}

-- migrate:down
${down}
`;

writeFileSync(target, out);
console.log(`yazıldı: ${target}`);

const supabaseOnly = /\b(net\.http_post|vault\.|supabase_realtime|storage\.buckets|extensions\.)/;
if (supabaseOnly.test(up)) {
  console.warn(
    'UYARI: Supabase\'e özgü bir referans var (pg_net / vault / realtime / storage.buckets / extensions). Dosyayı gözden geçirin.',
  );
}
