import { createHash } from 'node:crypto';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Client } from 'pg';
import { isValidBucketId, isValidObjectKey } from '../storage/object-key';
import { fingerprintSql, listTables, qualified, rawRowExpr } from './catalog';
import {
  MANIFEST_VERSION,
  type Manifest,
  type ObjectExport,
  type RejectedObject,
  type TableExport,
} from './manifest';
import type { StorageSource } from './storage-source';

export interface ExportOptions {
  /** Kaynak veritabanı (canlıda Supabase; yalnızca okunur). */
  sourceUrl: string;
  outDir: string;
  storage: StorageSource;
  withSessions?: boolean;
  log?: (line: string) => void;
}

const FETCH_SIZE = 1000;
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

/**
 * Kaynaktan bütün veriyi ve dosyaları `outDir`'e alır.
 *
 * KAYNAĞA YAZMAZ: tek bir `repeatable read read only` transaction'ında
 * yalnızca SELECT/FETCH çalışır (sunucu her yazımı reddeder); dosyalar
 * yalnızca HTTP GET ile indirilir. Bütün tablolar aynı anlık görüntüden
 * okunur, parmak izleri de aynı transaction'da hesaplanır.
 */
export async function exportData(options: ExportOptions): Promise<Manifest> {
  const log = options.log ?? (() => undefined);
  const started = Date.now();
  const withSessions = options.withSessions ?? false;
  await ensureEmptyDir(options.outDir);

  const client = new Client({ connectionString: options.sourceUrl });
  await client.connect();
  const tables: TableExport[] = [];
  const objects: ObjectExport[] = [];
  const rejectedObjects: RejectedObject[] = [];
  let bytes = 0;
  let sourceVersion = '';
  try {
    await client.query('begin isolation level repeatable read read only');
    sourceVersion = (
      await client.query<{ v: string }>(
        `select current_setting('server_version') as v`,
      )
    ).rows[0].v;

    for (const table of await listTables(client, withSessions)) {
      const file = join('tables', `${table.name}.ndjson`);
      const rowExpr = rawRowExpr('t', table.generated);
      const rows = await dumpTable(
        client,
        `select (${rowExpr})::text as r from ${qualified(table.name)} t`,
        join(options.outDir, file),
      );
      const fp = await client.query<{ n: string; fp: string }>(
        fingerprintSql(rowExpr, `${qualified(table.name)} t`),
      );
      if (Number(fp.rows[0].n) !== rows) {
        throw new Error(`${table.name}: satır sayısı tutmuyor`);
      }
      tables.push({
        name: table.name,
        columns: table.columns,
        generated: table.generated,
        primaryKey: table.primaryKey,
        file,
        rows,
        fingerprint: fp.rows[0].fp,
      });
      log(`${table.name}: ${rows} satır`);
    }

    const { rows: objectRows } = await client.query<{
      bucket_id: string;
      name: string;
      metadata: Record<string, unknown> | null;
    }>(
      `select bucket_id, name, metadata from storage.objects order by bucket_id, name`,
    );
    await client.query('commit');

    for (const row of objectRows) {
      if (!isValidBucketId(row.bucket_id) || !isValidObjectKey(row.name)) {
        rejectedObjects.push({
          bucket: row.bucket_id,
          name: row.name,
          reason: 'invalid_key',
        });
        log(`REDDEDİLDİ (geçersiz ad): ${row.bucket_id}/${row.name}`);
        continue;
      }
      const body = await options.storage.download(row.bucket_id, row.name);
      const path = join(options.outDir, 'storage', row.bucket_id, row.name);
      await mkdir(dirname(path), { recursive: true, mode: DIR_MODE });
      await writeFile(path, body, { mode: FILE_MODE });
      const md5 = createHash('md5').update(body).digest('hex');
      const meta = row.metadata ?? {};
      const etag =
        typeof meta.eTag === 'string' ? meta.eTag.replace(/"/g, '') : '';
      objects.push({
        bucket: row.bucket_id,
        name: row.name,
        size: body.length,
        md5,
        sizeMatchesMetadata: Number(meta.size) === body.length,
        md5MatchesEtag: /^[0-9a-f]{32}$/i.test(etag)
          ? etag.toLowerCase() === md5
          : null,
      });
      bytes += body.length;
    }
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }

  const manifest: Manifest = {
    version: MANIFEST_VERSION,
    createdAt: new Date(started).toISOString(),
    withSessions,
    sourceVersion,
    tables,
    objects,
    rejectedObjects,
    totals: {
      rows: tables.reduce((s, t) => s + t.rows, 0),
      objects: objects.length,
      bytes,
    },
    durationMs: Date.now() - started,
  };
  await writeFile(
    join(options.outDir, 'manifest.json'),
    JSON.stringify(manifest, null, 2),
    { mode: FILE_MODE },
  );
  log(
    `export bitti: ${tables.length} tablo, ${manifest.totals.rows} satır, ` +
      `${objects.length} dosya (${bytes} bayt), ${rejectedObjects.length} reddedilen, ` +
      `${manifest.durationMs} ms`,
  );
  return manifest;
}

/** Sorguyu imleçle okuyup her satırı bir NDJSON satırı olarak yazar. */
async function dumpTable(
  client: Client,
  sql: string,
  path: string,
): Promise<number> {
  await mkdir(dirname(path), { recursive: true, mode: DIR_MODE });
  const lines: string[] = [];
  await client.query(`declare export_cursor no scroll cursor for ${sql}`);
  for (;;) {
    const { rows } = await client.query<{ r: string }>(
      `fetch ${FETCH_SIZE} from export_cursor`,
    );
    for (const row of rows) lines.push(row.r);
    if (rows.length < FETCH_SIZE) break;
  }
  await client.query('close export_cursor');
  await writeFile(path, lines.length ? lines.join('\n') + '\n' : '', {
    mode: FILE_MODE,
  });
  return lines.length;
}

async function ensureEmptyDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: DIR_MODE });
  if ((await readdir(dir)).length > 0) {
    throw new Error(`${dir} boş değil; her export yeni bir klasöre yazılır`);
  }
}
