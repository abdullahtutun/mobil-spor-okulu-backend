import { createHash, randomInt } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { Client } from 'pg';
import { fingerprintSql, listTables, projectedRowExpr } from './catalog';
import { diskPath, planColumns, transformOptions } from './import';
import { readManifest } from './manifest';
import { columnTransforms, ident, qualified } from './plan';
import { batches, keepRow, readRows } from './rows';

export interface VerifyOptions {
  targetUrl: string;
  exportDir: string;
  storageRoot: string;
  newStoragePrefix?: string;
  oldStoragePrefix?: string;
  /** Rastgele hash karşılaştırılacak dosya sayısı. */
  sampleSize?: number;
  /** Uçtan uca giriş denemesi (çalışan API). */
  login?: { apiUrl: string; email: string; password: string };
  log?: (line: string) => void;
}

export interface TableCheck {
  name: string;
  sourceRows: number;
  expectedRows: number;
  targetRows: number;
  fileMatchesSource: boolean;
  targetMatchesExpected: boolean;
}

export interface VerifyReport {
  ok: boolean;
  tables: TableCheck[];
  authUsers: { source: number; target: number };
  foreignKeyOrphans: { constraint: string; rows: number }[];
  sequencesBehind: string[];
  storage: {
    expectedObjects: number;
    targetRows: number;
    filesOnDisk: number;
    expectedBytes: number;
    bytesOnDisk: number;
    missingFiles: string[];
    sizeMismatches: string[];
    extraFiles: string[];
    sampled: number;
    hashMismatches: string[];
    exportMetadataMismatches: string[];
  };
  rejectedObjects: string[];
  login?: { ok: boolean; detail: string };
  differences: string[];
  notes: string[];
}

/**
 * Hedefi export'la karşılaştırır. Kaynağa bağlanmaz: kaynağın değerleri
 * export anındaki anlık görüntüden (manifest'teki parmak izleri) gelir.
 *
 *   kaynak (manifest) == export dosyası      → dosya bozulmamış
 *   export (dönüşümlü, süzülmüş) == hedef    → yükleme eksiksiz ve aynı
 */
export async function verifyData(
  options: VerifyOptions,
): Promise<VerifyReport> {
  const log = options.log ?? (() => undefined);
  const manifest = await readManifest(options.exportDir);
  const transforms = columnTransforms(transformOptions(manifest, options));
  const notes: string[] = [];
  const differences: string[] = [];
  const tables: TableCheck[] = [];
  const foreignKeyOrphans: { constraint: string; rows: number }[] = [];
  const sequencesBehind: string[] = [];
  let storageRows = 0;
  let authTarget = 0;

  const client = new Client({ connectionString: options.targetUrl });
  await client.connect();
  try {
    await client.query('begin isolation level repeatable read');
    const plans = planColumns(
      manifest,
      await listTables(client, manifest.withSessions),
      notes,
    );
    await client.query(
      'create temp table _exp (r jsonb not null, keep boolean not null) on commit drop',
    );
    for (const p of plans) {
      await client.query('truncate _exp');
      const lines = await readRows(options.exportDir, p.table);
      for (const batch of batches(lines, 500)) {
        await client.query(
          `insert into _exp select e, ($2::boolean[])[o] from jsonb_array_elements($1::jsonb) with ordinality as a(e, o)`,
          [`[${batch.join(',')}]`, batch.map((l) => keepRow(p.table.name, l))],
        );
      }
      const raw = await one(client, fingerprintSql('e.r', '_exp e'));
      const rowExpr = (alias: string) =>
        projectedRowExpr(alias, p.columns, transforms[p.table.name]);
      const expected = await one(
        client,
        fingerprintSql(
          rowExpr('x'),
          `_exp e cross join lateral jsonb_populate_record(null::${qualified(p.table.name)}, e.r) x where e.keep`,
        ),
      );
      const actual = await one(
        client,
        fingerprintSql(
          projectedRowExpr('x', p.columns),
          `${qualified(p.table.name)} x`,
        ),
      );
      const check: TableCheck = {
        name: p.table.name,
        sourceRows: p.table.rows,
        expectedRows: expected.n,
        targetRows: actual.n,
        fileMatchesSource:
          raw.n === p.table.rows && raw.fp === p.table.fingerprint,
        targetMatchesExpected:
          expected.n === actual.n && expected.fp === actual.fp,
      };
      tables.push(check);
      if (!check.fileMatchesSource)
        differences.push(`${p.table.name}: export dosyası kaynakla aynı değil`);
      if (!check.targetMatchesExpected) {
        differences.push(
          `${p.table.name}: hedef beklenenden farklı (beklenen ${expected.n}, hedef ${actual.n} satır)`,
        );
      }
      if (p.table.name === 'storage.objects') storageRows = actual.n;
      if (p.table.name === 'auth.users') authTarget = actual.n;
      log(
        `${check.targetMatchesExpected && check.fileMatchesSource ? 'ok  ' : 'FARK'} ${p.table.name}: ${actual.n}`,
      );
    }

    // trigger'sız (replica) yükleme FK'leri denetlemedi: yetim satır sayılır.
    const names = plans.map((p) => p.table.name);
    const { rows: fks } = await client.query<{
      name: string;
      child: string;
      parent: string;
      ccols: string[];
      pcols: string[];
    }>(
      `select k.conname as name,
              cn.nspname || '.' || c.relname as child, pn.nspname || '.' || pc.relname as parent,
              array(select a.attname::text from unnest(k.conkey) with ordinality u(n, o)
                      join pg_attribute a on a.attrelid = k.conrelid and a.attnum = u.n order by u.o) as ccols,
              array(select a.attname::text from unnest(k.confkey) with ordinality u(n, o)
                      join pg_attribute a on a.attrelid = k.confrelid and a.attnum = u.n order by u.o) as pcols
         from pg_constraint k
         join pg_class c on c.oid = k.conrelid join pg_namespace cn on cn.oid = c.relnamespace
         join pg_class pc on pc.oid = k.confrelid join pg_namespace pn on pn.oid = pc.relnamespace
        where k.contype = 'f'`,
    );
    for (const fk of fks.filter((f) => names.includes(f.child))) {
      const notNull = fk.ccols
        .map((c) => `c.${ident(c)} is not null`)
        .join(' and ');
      const match = fk.ccols
        .map((c, i) => `p.${ident(fk.pcols[i])} = c.${ident(c)}`)
        .join(' and ');
      const { rows } = await client.query<{ n: string }>(
        `select count(*) as n from ${qualified(fk.child)} c
          where ${notNull} and not exists (select 1 from ${qualified(fk.parent)} p where ${match})`,
      );
      const n = Number(rows[0].n);
      if (n > 0) {
        foreignKeyOrphans.push({
          constraint: `${fk.child}.${fk.name}`,
          rows: n,
        });
        differences.push(`${fk.child}.${fk.name}: ${n} yetim satır`);
      }
    }

    const { rows: seqs } = await client.query<{
      seq: string;
      tbl: string;
      col: string;
    }>(
      `select s.oid::regclass::text as seq, n.nspname || '.' || c.relname as tbl, a.attname as col
         from pg_depend d
         join pg_class s on s.oid = d.objid and s.relkind = 'S'
         join pg_class c on c.oid = d.refobjid
         join pg_namespace n on n.oid = c.relnamespace
         join pg_attribute a on a.attrelid = c.oid and a.attnum = d.refobjsubid
        where d.deptype in ('a', 'i')`,
    );
    for (const s of seqs.filter((s) => names.includes(s.tbl))) {
      const { rows } = await client.query<{ behind: boolean }>(
        `select coalesce(max(${ident(s.col)}) > (select case when is_called then last_value else last_value - 1 end from ${s.seq}), false) as behind
           from ${qualified(s.tbl)}`,
      );
      if (rows[0].behind) {
        sequencesBehind.push(s.seq);
        differences.push(`${s.seq}: sequence en büyük değerin gerisinde`);
      }
    }
    await client.query('commit');
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }

  // Dosyalar
  const storage: VerifyReport['storage'] = {
    expectedObjects: manifest.objects.length,
    targetRows: storageRows,
    filesOnDisk: 0,
    expectedBytes: manifest.totals.bytes,
    bytesOnDisk: 0,
    missingFiles: [],
    sizeMismatches: [],
    extraFiles: [],
    sampled: 0,
    hashMismatches: [],
    exportMetadataMismatches: [],
  };
  const expectedPaths = new Map<string, (typeof manifest.objects)[number]>();
  for (const o of manifest.objects) {
    expectedPaths.set(diskPath(options.storageRoot, o.bucket, o.name), o);
    if (!o.sizeMatchesMetadata || o.md5MatchesEtag === false) {
      storage.exportMetadataMismatches.push(`${o.bucket}/${o.name}`);
    }
  }
  for (const file of await walk(resolve(options.storageRoot))) {
    const object = expectedPaths.get(file);
    if (!object) {
      storage.extraFiles.push(relative(resolve(options.storageRoot), file));
      continue;
    }
    const size = (await stat(file)).size;
    storage.filesOnDisk += 1;
    storage.bytesOnDisk += size;
    if (size !== object.size)
      storage.sizeMismatches.push(`${object.bucket}/${object.name}`);
  }
  for (const [path, o] of expectedPaths) {
    try {
      await stat(path);
    } catch {
      storage.missingFiles.push(`${o.bucket}/${o.name}`);
    }
  }
  const pool = [...expectedPaths.entries()].filter(
    ([, o]) => !storage.missingFiles.includes(`${o.bucket}/${o.name}`),
  );
  const sample = Math.min(options.sampleSize ?? 20, pool.length);
  for (let i = 0; i < sample; i++) {
    const [path, o] = pool.splice(randomInt(pool.length), 1)[0];
    const target = md5(await readFile(path));
    const exported = md5(
      await readFile(join(options.exportDir, 'storage', o.bucket, o.name)),
    );
    if (target !== o.md5 || exported !== o.md5)
      storage.hashMismatches.push(`${o.bucket}/${o.name}`);
    storage.sampled += 1;
  }
  if (storage.targetRows !== storage.expectedObjects) {
    differences.push(
      `storage.objects: ${storage.targetRows} satır, ${storage.expectedObjects} dosya bekleniyordu`,
    );
  }
  if (storage.bytesOnDisk !== storage.expectedBytes) {
    differences.push(
      `dosya boyutu: ${storage.bytesOnDisk} bayt, beklenen ${storage.expectedBytes}`,
    );
  }
  for (const m of storage.missingFiles) differences.push(`eksik dosya: ${m}`);
  for (const m of storage.sizeMismatches) differences.push(`boyut farkı: ${m}`);
  for (const m of storage.hashMismatches) differences.push(`hash farkı: ${m}`);
  for (const m of storage.extraFiles) differences.push(`fazla dosya: ${m}`);
  for (const m of storage.exportMetadataMismatches) {
    differences.push(`kaynak metadata (size/eTag) dosyayla uyuşmuyor: ${m}`);
  }
  const rejectedObjects = manifest.rejectedObjects.map(
    (r) => `${r.bucket}/${r.name}`,
  );
  for (const r of rejectedObjects)
    notes.push(`taşınmadı (geçersiz ad, gerekçeli): ${r}`);

  const authSource =
    manifest.tables.find((t) => t.name === 'auth.users')?.rows ?? 0;
  if (authSource !== authTarget)
    differences.push(`auth.users: ${authTarget} / ${authSource}`);

  let login: VerifyReport['login'];
  if (options.login) {
    login = await tryLogin(options.login);
    if (!login.ok) differences.push(`giriş denemesi: ${login.detail}`);
  }

  const report: VerifyReport = {
    ok: differences.length === 0,
    tables,
    authUsers: { source: authSource, target: authTarget },
    foreignKeyOrphans,
    sequencesBehind,
    storage,
    rejectedObjects,
    login,
    differences,
    notes,
  };
  log(report.ok ? 'verify: fark yok' : `verify: ${differences.length} fark`);
  for (const d of differences) log(`  - ${d}`);
  return report;
}

/** Test hesabıyla giriş + `get_session_data` (yeni API'ye karşı). */
async function tryLogin(login: NonNullable<VerifyOptions['login']>) {
  const base = login.apiUrl.replace(/\/+$/, '');
  const token = await fetch(`${base}/auth/token?grant_type=password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: login.email, password: login.password }),
  });
  if (!token.ok) return { ok: false, detail: `giriş HTTP ${token.status}` };
  const { access_token } = (await token.json()) as { access_token: string };
  const session = await fetch(`${base}/rpc/get_session_data`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${access_token}`,
    },
    body: '{}',
  });
  if (!session.ok)
    return { ok: false, detail: `get_session_data HTTP ${session.status}` };
  const body = (await session.json()) as { success?: boolean; code?: string };
  return body.success
    ? { ok: true, detail: 'giriş ve get_session_data başarılı' }
    : { ok: false, detail: `get_session_data: ${body.code}` };
}

async function one(
  client: Client,
  sql: string,
): Promise<{ n: number; fp: string }> {
  const { rows } = await client.query<{ n: string; fp: string }>(sql);
  return { n: Number(rows[0].n), fp: rows[0].fp };
}

function md5(data: Buffer): string {
  return createHash('md5').update(data).digest('hex');
}

/** Kökün altındaki dosyalar; `.tmp`/`.trash` (API'nin çalışma klasörleri) hariç. */
async function walk(root: string): Promise<string[]> {
  const out: string[] = [];
  const visit = async (dir: string, top: boolean) => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (top && (e.name === '.tmp' || e.name === '.trash')) continue;
      const path = join(dir, e.name);
      if (e.isDirectory()) await visit(path, false);
      else out.push(path);
    }
  };
  await visit(root, true);
  return out;
}
