/**
 * Kysely'nin tablo tipleri. Şema S03'te gelir; o zamana kadar boş.
 * Tablolar eklendikçe `interface Database { athletes: AthletesTable; … }`.
 */
export type Database = Record<string, never>;
