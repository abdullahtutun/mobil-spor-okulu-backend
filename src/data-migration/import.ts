import {
  chmod,
  copyFile,
  mkdir,
  readFile,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { Client } from 'pg';
import { isValidBucketId, isValidObjectKey } from '../storage/object-key';
import { listTables, type TableInfo } from './catalog';
import { readManifest, type Manifest, type TableExport } from './manifest';
import {
  columnTransforms,
  DEFAULT_SUPABASE_STORAGE_PREFIX,
  ident,
  KNOWN_SOURCE_ONLY_COLUMNS,
  qualified,
  REFERENCE_TABLES,
  type TransformOptions,
} from './plan';
import { batches, keepRow, readRows } from './rows';

export interface ImportOptions {
  /** Hedef veritabanı, süper kullanıcı (postgres): replica kipi için. */
  targetUrl: string;
  exportDir: string;
  storageRoot: string;
  /** Yeni storage kökü, ör. `https://api.mobilsporokulu.com/storage/`. */
  newStoragePrefix?: string;
  oldStoragePrefix?: string;
  /** Dolu hedefi boşaltıp yeniden yükle (prova tekrarı). */
  replace?: boolean;
  log?: (line: string) => void;
}

export interface ImportResult {
  tables: { name: string; rows: number }[];
  files: number;
  bytes: number;
  notes: string[];
  durationMs: number;
}

const BATCH = 500;
export const CRON_STATE_FILE = 'cron-paused.json';

export interface ColumnPlan {
  table: TableExport;
  target: TableInfo;
  /** Kopyalanan sütunlar (kaynak ∩ hedef). */
  columns: string[];
  reference: boolean;
}

/** Export'u hedef şemayla eşleştirir; açıklanamayan fark hata. */
export function planColumns(
  manifest: Manifest,
  targetTables: TableInfo[],
  notes: string[],
): ColumnPlan[] {
  const byName = new Map(targetTables.map((t) => [t.name, t]));
  const plans: ColumnPlan[] = [];
  for (const table of manifest.tables) {
    const target = byName.get(table.name);
    if (!target) throw new Error(`${table.name} hedef şemada yok`);
    const sourceOnly = table.columns.filter((c) => !target.columns.includes(c));
    const allowed = KNOWN_SOURCE_ONLY_COLUMNS[table.name] ?? [];
    const unexpected = sourceOnly.filter((c) => !allowed.includes(c));
    if (unexpected.length) {
      throw new Error(
        `${table.name}: hedefte olmayan sütunlar: ${unexpected.join(', ')}`,
      );
    }
    if (sourceOnly.length) {
      notes.push(
        `${table.name}: kaynağa özgü sütunlar atlandı: ${sourceOnly.join(', ')}`,
      );
    }
    const targetOnly = target.columns.filter((c) => !table.columns.includes(c));
    if (targetOnly.length) {
      notes.push(
        `${table.name}: hedefe özgü sütunlar varsayılanla: ${targetOnly.join(', ')}`,
      );
    }
    plans.push({
      table,
      target,
      columns: target.columns.filter((c) => table.columns.includes(c)),
      reference: REFERENCE_TABLES.includes(table.name),
    });
  }
  const exported = new Set(manifest.tables.map((t) => t.name));
  for (const t of targetTables) {
    if (!exported.has(t.name))
      notes.push(`${t.name}: kaynakta yok, dokunulmadı`);
  }
  return plans;
}

export function transformOptions(
  manifest: Manifest,
  options: { newStoragePrefix?: string; oldStoragePrefix?: string },
): TransformOptions {
  return {
    oldStoragePrefix:
      options.oldStoragePrefix ?? DEFAULT_SUPABASE_STORAGE_PREFIX,
    newStoragePrefix: options.newStoragePrefix,
    withSessions: manifest.withSessions,
  };
}

/**
 * Export'u boş (yalnızca migration'ları uygulanmış) hedefe yükler.
 *
 *   1. pg_cron işleri durdurulur (yükleme ile verify arasında bildirim
 *      üretmesinler); `resumeCron` geri açar.
 *   2. Tek transaction, `session_replication_role = replica`: trigger'lar
 *      (handle_new_user, bildirim/pg_notify, updated_at) ve FK denetimleri
 *      çalışmaz — veri kaynağın tutarlı anlık görüntüsü; FK'ler verify'da
 *      ayrıca sayılır.
 *   3. Başvuru tabloları birincil anahtara göre güncellenir, diğerleri
 *      boş olmalı (`replace` ise boşaltılır).
 *   4. Sequence'ler sütunun en büyük değerine ayarlanır.
 *   5. Dosyalar `STORAGE_ROOT/<bucket>/<ad>` (0700/0600).
 */
export async function importData(
  options: ImportOptions,
): Promise<ImportResult> {
  const log = options.log ?? (() => undefined);
  const started = Date.now();
  const manifest = await readManifest(options.exportDir);
  const notes: string[] = [];
  const transforms = columnTransforms(transformOptions(manifest, options));
  if (!options.newStoragePrefix) {
    notes.push('yeni storage öneki verilmedi: schools.logo_url değiştirilmedi');
  }

  const client = new Client({ connectionString: options.targetUrl });
  await client.connect();
  const loaded: { name: string; rows: number }[] = [];
  try {
    await pauseCron(client, options.exportDir, log);

    await client.query('begin');
    await client.query('set local session_replication_role = replica');
    const plans = planColumns(
      manifest,
      await listTables(client, manifest.withSessions),
      notes,
    );
    const data = plans.filter((p) => !p.reference);
    const nonEmpty: string[] = [];
    for (const p of data) {
      const { rows } = await client.query(
        `select 1 from ${qualified(p.table.name)} limit 1`,
      );
      if (rows.length) nonEmpty.push(p.table.name);
    }
    if (nonEmpty.length && !options.replace) {
      throw new Error(
        `hedef boş değil (${nonEmpty.join(', ')}); yeniden yüklemek için --replace`,
      );
    }
    if (nonEmpty.length) {
      await client.query(
        `truncate ${data.map((p) => qualified(p.table.name)).join(', ')} restart identity cascade`,
      );
      log(`boşaltıldı: ${nonEmpty.length} dolu tablo`);
    }

    for (const p of plans) {
      const lines = (await readRows(options.exportDir, p.table)).filter((l) =>
        keepRow(p.table.name, l),
      );
      const cols = p.columns.map(ident).join(', ');
      const exprs = p.columns
        .map((c) => {
          const ref = `x.${ident(c)}`;
          const t = transforms[p.table.name]?.[c];
          return t ? t(ref) : ref;
        })
        .join(', ');
      let conflict = '';
      if (p.reference) {
        if (!p.target.primaryKey.length) {
          throw new Error(
            `${p.table.name}: başvuru tablosunun birincil anahtarı yok`,
          );
        }
        const rest = p.columns.filter((c) => !p.target.primaryKey.includes(c));
        conflict =
          ` on conflict (${p.target.primaryKey.map(ident).join(', ')}) ` +
          (rest.length
            ? `do update set ${rest.map((c) => `${ident(c)} = excluded.${ident(c)}`).join(', ')}`
            : 'do nothing');
      }
      for (const batch of batches(lines, BATCH)) {
        await client.query(
          `insert into ${qualified(p.table.name)} (${cols}) overriding system value
           select ${exprs} from jsonb_populate_recordset(null::${qualified(p.table.name)}, $1::jsonb) x${conflict}`,
          [`[${batch.join(',')}]`],
        );
      }
      loaded.push({ name: p.table.name, rows: lines.length });
      log(
        `${p.table.name}: ${lines.length} satır${p.reference ? ' (güncelleme)' : ''}`,
      );
    }

    await resetSequences(
      client,
      plans.map((p) => p.table.name),
      log,
    );
    await client.query('commit');
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }

  let bytes = 0;
  for (const object of manifest.objects) {
    const target = diskPath(options.storageRoot, object.bucket, object.name);
    await mkdirs(options.storageRoot, dirname(target));
    await copyFile(
      join(options.exportDir, 'storage', object.bucket, object.name),
      target,
    );
    await chmod(target, 0o600);
    bytes += object.size;
  }
  for (const r of manifest.rejectedObjects) {
    notes.push(`taşınmadı (geçersiz ad): ${r.bucket}/${r.name}`);
  }
  log(`dosyalar: ${manifest.objects.length} (${bytes} bayt)`);

  const result: ImportResult = {
    tables: loaded,
    files: manifest.objects.length,
    bytes,
    notes,
    durationMs: Date.now() - started,
  };
  for (const n of notes) log(`not: ${n}`);
  log(`import bitti: ${result.durationMs} ms`);
  return result;
}

/** `<root>/<bucket>/<ad>`; ad kuralı DiskStore'unkiyle aynı. */
export function diskPath(root: string, bucket: string, name: string): string {
  if (!isValidBucketId(bucket) || !isValidObjectKey(name)) {
    throw new Error(`geçersiz nesne adı: ${bucket}/${name}`);
  }
  const base = resolve(root, bucket);
  const path = resolve(base, ...name.split('/'));
  if (!path.startsWith(base + sep)) throw new Error(`kök dışı yol: ${name}`);
  return path;
}

async function mkdirs(root: string, dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  // recursive mkdir umask'a tabi; kökün altındaki her klasör 0700.
  let current = dir;
  const top = resolve(root);
  while (current.startsWith(top + sep)) {
    await chmod(current, 0o700);
    current = dirname(current);
  }
}

async function resetSequences(
  client: Client,
  tables: string[],
  log: (line: string) => void,
): Promise<void> {
  const { rows } = await client.query<{
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
  for (const r of rows.filter((r) => tables.includes(r.tbl))) {
    const [schema, name] = r.tbl.split('.');
    await client.query(
      `select setval($1::regclass, coalesce(max(${ident(r.col)}), 1), max(${ident(r.col)}) is not null)
         from ${ident(schema)}.${ident(name)}`,
      [r.seq],
    );
    log(`sequence: ${r.seq}`);
  }
}

/** Bütün aktif cron işlerini durdurur, adlarını export klasörüne yazar. */
async function pauseCron(
  client: Client,
  exportDir: string,
  log: (line: string) => void,
): Promise<void> {
  const { rows } = await client.query<{ jobname: string }>(
    `update cron.job set active = false where active returning jobname`,
  );
  if (rows.length === 0) return;
  await writeFile(
    join(exportDir, CRON_STATE_FILE),
    JSON.stringify(rows.map((r) => r.jobname)),
    { mode: 0o600 },
  );
  log(`cron durduruldu: ${rows.length} iş (verify'dan sonra resume-cron)`);
}

/** `pauseCron`'un durdurduğu işleri yeniden açar. */
export async function resumeCron(
  targetUrl: string,
  exportDir: string,
): Promise<string[]> {
  const path = join(exportDir, CRON_STATE_FILE);
  const names = JSON.parse(await readFile(path, 'utf8')) as string[];
  const client = new Client({ connectionString: targetUrl });
  await client.connect();
  try {
    await client.query(
      `update cron.job set active = true where jobname = any($1)`,
      [names],
    );
  } finally {
    await client.end();
  }
  await unlink(path);
  return names;
}
