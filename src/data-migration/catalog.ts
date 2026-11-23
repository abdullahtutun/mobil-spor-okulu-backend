import type { ClientBase } from 'pg';
import { ident, isPicked, qualified, sqlLiteral } from './plan';

export interface TableInfo {
  /** `schema.tablo` */
  name: string;
  /** Yazılabilir sütunlar (üretilen sütunlar hariç), ada göre sıralı. */
  columns: string[];
  /** `generated always as (...) stored` sütunları. */
  generated: string[];
  /** Birincil anahtar sütunları. */
  primaryKey: string[];
}

/**
 * Veritabanındaki taşınacak tablolar (kaynakta export, hedefte import ve
 * verify aynı sorguyu çalıştırır). Yalnızca katalog okur.
 */
export async function listTables(
  client: ClientBase,
  withSessions: boolean,
): Promise<TableInfo[]> {
  const { rows } = await client.query<{
    name: string;
    columns: string[];
    generated: string[];
    pk: string[];
  }>(`
    select n.nspname || '.' || c.relname as name,
           array(select a.attname::text from pg_attribute a
                  where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
                    and a.attgenerated = '' order by a.attname) as columns,
           array(select a.attname::text from pg_attribute a
                  where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
                    and a.attgenerated <> '' order by a.attname) as generated,
           coalesce(array(select a.attname::text
                    from pg_constraint k
                    cross join lateral unnest(k.conkey) as u(attnum)
                    join pg_attribute a on a.attrelid = c.oid and a.attnum = u.attnum
                   where k.conrelid = c.oid and k.contype = 'p'
                   order by a.attname), '{}') as pk
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where c.relkind in ('r', 'p') and not c.relispartition
       and n.nspname in ('public', 'auth', 'storage')
     order by 1`);
  return rows
    .filter((r) => isPicked(r.name, withSessions))
    .map((r) => ({
      name: r.name,
      columns: r.columns,
      generated: r.generated,
      primaryKey: r.pk,
    }));
}

/**
 * Bir satır kümesinin parmak izi: satır sayısı ve satırların (jsonb metni)
 * md5'lerinin sıralı birleşiminin md5'i. Sıra bağımsız, tip ve değer
 * duyarlı. `rowExpr` her satır için bir jsonb ifadesi, `from` FROM kısmı.
 */
export function fingerprintSql(rowExpr: string, from: string): string {
  return `select count(*)::bigint as n,
                 md5(coalesce(string_agg(h, '' order by h), '')) as fp
            from (select md5((${rowExpr})::text) as h from ${from}) s`;
}

/** Kaynak tarafı ham parmak izi: `to_jsonb(satır)` eksi üretilen sütunlar. */
export function rawRowExpr(alias: string, generated: string[]): string {
  if (generated.length === 0) return `to_jsonb(${alias})`;
  const arr = generated.map(sqlLiteral).join(', ');
  return `(to_jsonb(${alias}) - array[${arr}]::text[])`;
}

/**
 * Hedefte karşılaştırılan satır: verilen sütunlar, dönüşümleri
 * uygulanarak (`exprs`). jsonb_build_object'in 100 argüman sınırı için
 * parçalara bölünüp `||` ile birleştirilir.
 */
export function projectedRowExpr(
  alias: string,
  columns: string[],
  transforms: Record<string, (col: string) => string> = {},
): string {
  const pairs = columns.map((c) => {
    const ref = `${alias}.${ident(c)}`;
    const expr = transforms[c] ? transforms[c](ref) : ref;
    return `${sqlLiteral(c)}, ${expr}`;
  });
  const chunks: string[] = [];
  for (let i = 0; i < pairs.length; i += 40) {
    chunks.push(`jsonb_build_object(${pairs.slice(i, i + 40).join(', ')})`);
  }
  return chunks.length ? chunks.join(' || ') : `'{}'::jsonb`;
}

export { qualified };
