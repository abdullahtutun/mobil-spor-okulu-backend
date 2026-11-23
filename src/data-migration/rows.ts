import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isValidBucketId, isValidObjectKey } from '../storage/object-key';
import type { TableExport } from './manifest';

/** Export dosyasının satırları (her satır kaynağın jsonb metni). */
export async function readRows(
  dir: string,
  table: TableExport,
): Promise<string[]> {
  const text = await readFile(join(dir, table.file), 'utf8');
  return text.split('\n').filter((line) => line.length > 0);
}

/**
 * Taşınacak satır mı: adı disk kuralından geçmeyen storage nesnesi taşınmaz
 * (export onu indirmedi, `rejectedObjects`'te). Import ve verify aynı kuralı
 * kullanır.
 */
export function keepRow(table: string, line: string): boolean {
  if (table !== 'storage.objects') return true;
  const row = JSON.parse(line) as { bucket_id?: unknown; name?: unknown };
  return (
    typeof row.bucket_id === 'string' &&
    typeof row.name === 'string' &&
    isValidBucketId(row.bucket_id) &&
    isValidObjectKey(row.name)
  );
}

export function* batches<T>(items: T[], size: number): Generator<T[]> {
  for (let i = 0; i < items.length; i += size) yield items.slice(i, i + size);
}
