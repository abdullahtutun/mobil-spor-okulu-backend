/**
 * Veri taşımanın (S12) kapsamı: hangi tablolar, hangi kipte, hangi
 * dönüşümle. Export, import ve verify aynı tanımdan okur — üç araç aynı
 * kümeyi görmezse doğrulama yalan söyler.
 */

/** Export'un bütün tablolarını aldığı şema. */
export const FULL_SCHEMAS = ['public'] as const;

/** Bu şemalardan yalnızca adı geçen tablolar taşınır. */
export const PICKED_TABLES: Record<string, readonly string[]> = {
  // Hesaplar, kimlikler (aynı id, aynı bcrypt hash'i — K8), MFA (canlıda 0).
  auth: ['users', 'identities', 'mfa_factors'],
  // Bucket satırları db/compat/03'te; yalnızca nesneler taşınır.
  storage: ['objects'],
};

/**
 * Açık oturumlar: varsayılan olarak taşınmaz (S12 kararı: yeni sürümde
 * herkes bir kez giriş yapar). `--with-sessions` ile taşınır; refresh
 * token'lar SHA-256'ya çevrilir (S05).
 */
export const SESSION_TABLES: readonly string[] = [
  'auth.sessions',
  'auth.refresh_tokens',
];

/**
 * Migration'ların (0004) zaten doldurduğu başvuru tabloları: boşaltılmaz,
 * birincil anahtara göre canlının değeriyle güncellenir (`app_min_versions`
 * geçiş gecesine kadar canlıda değişebilir).
 */
export const REFERENCE_TABLES: readonly string[] = [
  'public.roles',
  'public.role_permissions',
  'public.app_min_versions',
];

/**
 * Kaynakta olup hedefte bilerek olmayan sütunlar (storage-api'nin sürümleme
 * sütunları; 03_storage.sql alt kümesi). Başka bir fark import'u durdurur.
 */
export const KNOWN_SOURCE_ONLY_COLUMNS: Record<string, readonly string[]> = {
  'storage.objects': ['archived_at', 'is_delete_marker', 'is_versioned'],
};

/** Canlı projenin storage öneki (docs/api/storage.md → "Logo adresleri"). */
export const DEFAULT_SUPABASE_STORAGE_PREFIX =
  'https://gcmeltwnryjscinptecb.supabase.co/storage/v1/';

export interface TransformOptions {
  /** Eski storage öneki (`https://<ref>.supabase.co/storage/v1/`). */
  oldStoragePrefix: string;
  /** Yeni API'nin storage kökü (`https://api…/storage/`); yoksa logo dönüşümü yok. */
  newStoragePrefix?: string;
  withSessions: boolean;
}

/**
 * Sütun başına SQL dönüşümü: `x` taşınan satırın kaydı. Import satırı bu
 * ifadeyle yazar, verify beklenen değeri aynı ifadeyle hesaplar.
 */
export function columnTransforms(
  options: TransformOptions,
): Record<string, Record<string, (col: string) => string>> {
  const out: Record<string, Record<string, (col: string) => string>> = {};
  if (options.newStoragePrefix) {
    const oldP = sqlLiteral(options.oldStoragePrefix);
    const newP = sqlLiteral(options.newStoragePrefix);
    out['public.schools'] = {
      logo_url: (col) =>
        `(case when starts_with(${col}, ${oldP}) then ${newP} || substr(${col}, length(${oldP}) + 1) else ${col} end)`,
    };
  }
  if (options.withSessions) {
    const sha = (col: string) =>
      `(case when ${col} is null then null else encode(sha256(convert_to(${col}, 'UTF8')), 'hex') end)`;
    out['auth.refresh_tokens'] = { token: sha, parent: sha };
  }
  return out;
}

/** Tek tırnaklı SQL metni (yalnızca araçların kendi sabitleri için). */
export function sqlLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** `"ad"` — tanımlayıcıyı tırnaklar. */
export function ident(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** `public.schools` → `"public"."schools"`. */
export function qualified(table: string): string {
  const [schema, name] = splitTable(table);
  return `${ident(schema)}.${ident(name)}`;
}

export function splitTable(table: string): [string, string] {
  const dot = table.indexOf('.');
  return [table.slice(0, dot), table.slice(dot + 1)];
}

/**
 * Hiç taşınmayan tablolar: hedefin kendi kayıtları. `schema_migrations`
 * dbmate'in geçmişi (boşaltılırsa migration'lar baştan çalışmaya kalkar).
 */
export const EXCLUDED_TABLES: readonly string[] = ['public.schema_migrations'];

/** Taşınan tablo kümesi; `--with-sessions` oturum tablolarını ekler. */
export function isPicked(table: string, withSessions: boolean): boolean {
  if (EXCLUDED_TABLES.includes(table)) return false;
  const [schema, name] = splitTable(table);
  if ((FULL_SCHEMAS as readonly string[]).includes(schema)) return true;
  if (PICKED_TABLES[schema]?.includes(name)) return true;
  return withSessions && SESSION_TABLES.includes(table);
}
