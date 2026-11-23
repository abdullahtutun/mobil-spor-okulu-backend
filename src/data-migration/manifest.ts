import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export const MANIFEST_VERSION = 1;

export interface TableExport {
  name: string;
  /** Dosyadaki sütunlar (kaynağın yazılabilir sütunları). */
  columns: string[];
  /** Kaynakta üretilen sütunlar (dosyada yok). */
  generated: string[];
  primaryKey: string[];
  file: string;
  rows: number;
  /** Kaynakta, export transaction'ı içinde hesaplanan ham parmak izi. */
  fingerprint: string;
}

export interface ObjectExport {
  bucket: string;
  name: string;
  size: number;
  md5: string;
  /** metadata.size / eTag ile uyuşuyor mu (eTag md5 değilse null). */
  sizeMatchesMetadata: boolean;
  md5MatchesEtag: boolean | null;
}

export interface RejectedObject {
  bucket: string;
  name: string;
  reason: string;
}

export interface Manifest {
  version: number;
  createdAt: string;
  withSessions: boolean;
  /** Kaynağın Postgres sürümü (`server_version`). */
  sourceVersion: string;
  tables: TableExport[];
  objects: ObjectExport[];
  rejectedObjects: RejectedObject[];
  totals: { rows: number; objects: number; bytes: number };
  durationMs: number;
}

export async function readManifest(dir: string): Promise<Manifest> {
  const manifest = JSON.parse(
    await readFile(join(dir, 'manifest.json'), 'utf8'),
  ) as Manifest;
  if (manifest.version !== MANIFEST_VERSION) {
    throw new Error(`manifest sürümü ${manifest.version} desteklenmiyor`);
  }
  return manifest;
}
