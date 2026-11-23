import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type { RequestAuth } from '../auth/request/jwt-verifier.service';
import { DbContextService } from '../db/db-context.service';

export interface BucketRow {
  id: string;
  public: boolean;
  file_size_limit: number | null;
  allowed_mime_types: string[] | null;
}

export interface ObjectRow {
  id: string;
  metadata: Record<string, unknown> | null;
}

export interface NewObject {
  id: string;
  bucketId: string;
  name: string;
  owner: string | null;
  metadata: Record<string, unknown>;
  userMetadata: Record<string, unknown>;
  version: string;
}

/**
 * `storage.buckets` / `storage.objects`'e tek kapı. Nesne satırlarının hepsi
 * **isteğin rolüyle** (anon ya da token'ın claim'leriyle authenticated) okunur
 * ve yazılır; kimin neyi görebileceğine 0002'deki politikalar karar verir
 * (K9). Yalnızca bucket ayarları (buckets'ta istemciye politika yok) ve
 * açılış temizliği service_role ile — Supabase de bucket'ı süper kullanıcıyla
 * okur.
 *
 * Yazma SQL'leri storage-api'nin yetki denemesiyle aynı:
 *   - üzerine yazmasız yükleme: düz INSERT, RETURNING yok → yalnızca INSERT
 *     politikası; aynı ad 23505.
 *   - `x-upsert`: INSERT … ON CONFLICT DO UPDATE … RETURNING → INSERT
 *     WITH CHECK, var olan satır için UPDATE USING, RETURNING için SELECT.
 *     athlete-photos'ta UPDATE politikası yok → var olanın üzerine yazmak
 *     42501.
 *   - silme: DELETE … RETURNING → DELETE USING ve SELECT USING; izin
 *     verilmeyen adlar sessizce düşer (storage-api de öyle).
 */
@Injectable()
export class StorageRepository {
  constructor(private readonly db: DbContextService) {}

  findBucket(bucketId: string): Promise<BucketRow | null> {
    return this.db.withRole('service_role', async (client) => {
      const result = await client.query<BucketRow>(
        `select id, public, file_size_limit, allowed_mime_types
           from storage.buckets where id = $1`,
        [bucketId],
      );
      return result.rows[0] ?? null;
    });
  }

  findObject(
    auth: RequestAuth,
    bucketId: string,
    name: string,
  ): Promise<ObjectRow | null> {
    return this.db.run(
      { role: auth.role, claims: auth.claims },
      async (client) => {
        const result = await client.query<ObjectRow>(
          `select id, metadata from storage.objects
          where bucket_id = $1 and name = $2`,
          [bucketId, name],
        );
        return result.rows[0] ?? null;
      },
    );
  }

  /**
   * Satırı yazar ve aynı transaction içinde `place`'i çağırır (dosyayı yerine
   * taşır); `place` hata verirse satır da geri alınır. Dönüş: satırın id'si
   * (üzerine yazmada var olan satırınki).
   */
  insertObject(
    auth: RequestAuth,
    object: NewObject,
    upsert: boolean,
    place: () => Promise<void>,
  ): Promise<string> {
    return this.db.run(
      { role: auth.role, claims: auth.claims },
      async (client) => {
        const id = upsert
          ? await upsertRow(client, object)
          : await insertRow(client, object);
        await place();
        return id;
      },
    );
  }

  /**
   * Adları isteğin rolüyle siler; `onDeleted` silinen her satır için
   * transaction açıkken çağrılır (dosyayı çöpe taşımak için).
   */
  deleteObjects(
    auth: RequestAuth,
    bucketId: string,
    names: string[],
    onDeleted: (rows: Record<string, unknown>[]) => Promise<void>,
  ): Promise<Record<string, unknown>[]> {
    return this.db.run(
      { role: auth.role, claims: auth.claims },
      async (client) => {
        const result = await client.query<{ row: Record<string, unknown> }>(
          `delete from storage.objects o
          where o.bucket_id = $1 and o.name = any($2::text[])
         returning to_jsonb(o) - 'path_tokens' as row`,
          [bucketId, names],
        );
        const rows = result.rows.map((r) => r.row);
        await onDeleted(rows);
        return rows;
      },
    );
  }

  /** Açılış temizliği için: satır var mı (RLS'siz). */
  objectExists(bucketId: string, name: string): Promise<boolean> {
    return this.db.withRole('service_role', async (client) => {
      const result = await client.query(
        `select 1 from storage.objects where bucket_id = $1 and name = $2`,
        [bucketId, name],
      );
      return (result.rowCount ?? 0) > 0;
    });
  }

  /** Dosyası yerine konamayan satırı geri alır (commit sonrası hata). */
  deleteObjectRow(bucketId: string, name: string, id: string): Promise<void> {
    return this.db.withRole('service_role', async (client) => {
      await client.query(
        `delete from storage.objects where bucket_id = $1 and name = $2 and id = $3`,
        [bucketId, name, id],
      );
    });
  }
}

const COLUMNS = `(id, bucket_id, name, owner, owner_id, metadata, user_metadata, version)`;
const VALUES = `($1, $2, $3, $4::uuid, $5, $6::jsonb, $7::jsonb, $8)`;

function params(object: NewObject): unknown[] {
  return [
    object.id,
    object.bucketId,
    object.name,
    object.owner,
    object.owner,
    JSON.stringify(object.metadata),
    JSON.stringify(object.userMetadata),
    object.version,
  ];
}

async function insertRow(
  client: PoolClient,
  object: NewObject,
): Promise<string> {
  await client.query(
    `insert into storage.objects ${COLUMNS} values ${VALUES}`,
    params(object),
  );
  return object.id;
}

async function upsertRow(
  client: PoolClient,
  object: NewObject,
): Promise<string> {
  const result = await client.query<{ id: string }>(
    `insert into storage.objects as o ${COLUMNS} values ${VALUES}
     on conflict (bucket_id, name) do update
        set owner = excluded.owner,
            owner_id = excluded.owner_id,
            metadata = excluded.metadata,
            user_metadata = excluded.user_metadata,
            version = excluded.version,
            last_accessed_at = now()
     returning o.id`,
    params(object),
  );
  return result.rows[0].id;
}
