import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { DbContextService } from '../db/db-context.service';
import { RPC_ALLOWLIST } from './rpc-allowlist';

/** Bir SQL fonksiyonunun çağrı için gereken imzası (`pg_proc`'tan). */
export interface RpcSignature {
  name: string;
  /** Girdi parametreleri, tanımdaki sırayla. */
  params: readonly RpcParam[];
  /** `setof` / `returns table`: sonuç dizi olarak döner. */
  returnsSet: boolean;
  /** `void`: sonuç `null`. */
  returnsVoid: boolean;
}

export interface RpcParam {
  name: string;
  /** `format_type` çıktısı (`uuid[]`, `gender_type`, `timestamp with time zone` …). */
  type: string;
  hasDefault: boolean;
}

interface ProcRow {
  proname: string;
  proretset: boolean;
  rettype: string;
  arg_names: string[] | null;
  arg_modes: string[] | null;
  in_types: string[];
  pronargdefaults: number;
}

/**
 * Allow-list'teki fonksiyonların imzalarını açılışta bir kez okur ve
 * bellekte tutar (PostgREST'in "schema cache"i gibi). Şema değişikliği
 * (dbmate migration) API yeniden başlatılınca görünür — Coolify her
 * dağıtımda zaten yeniden başlatır.
 *
 * Aynı adla birden fazla fonksiyon (overload) olabilir; çağrıda gönderilen
 * anahtarlara uyan seçilir (`RpcService`).
 */
@Injectable()
export class RpcCatalog implements OnApplicationBootstrap {
  private readonly logger = new Logger(RpcCatalog.name);
  private signatures = new Map<string, RpcSignature[]>();

  constructor(private readonly db: DbContextService) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.load();
  }

  async load(): Promise<void> {
    const names = Object.keys(RPC_ALLOWLIST);
    // pg_catalog herkese açık; en dar rolle okunur.
    const rows = await this.db.withRole('anon', async (client) => {
      const result = await client.query<ProcRow>(
        `select p.proname,
                p.proretset,
                format_type(p.prorettype, null) as rettype,
                p.proargnames as arg_names,
                p.proargmodes::text[] as arg_modes,
                array(select format_type(t.oid_, null)
                        from unnest(p.proargtypes::oid[]) with ordinality as t(oid_, i)
                       order by t.i) as in_types,
                p.pronargdefaults
           from pg_proc p
          where p.pronamespace = 'public'::regnamespace
            and p.prokind = 'f'
            and p.proname = any($1::text[])`,
        [names],
      );
      return result.rows;
    });

    const next = new Map<string, RpcSignature[]>();
    for (const row of rows) {
      const signature = toSignature(row);
      if (!signature) {
        this.logger.warn(
          { fn: row.proname },
          'Adsız parametreli fonksiyon RPC olarak çağrılamaz; atlandı',
        );
        continue;
      }
      next.set(row.proname, [...(next.get(row.proname) ?? []), signature]);
    }
    const missing = names.filter((name) => !next.has(name));
    if (missing.length > 0) {
      // Açılışı durdurmaz: o fonksiyon çağrılınca 404 olur. Migration'ı
      // uygulanmamış bir veritabanında API yine de ayağa kalkar.
      this.logger.warn(
        { missing },
        "Allow-list'teki fonksiyonlar veritabanında yok",
      );
    }
    this.signatures = next;
  }

  find(name: string): readonly RpcSignature[] {
    return this.signatures.get(name) ?? [];
  }
}

function toSignature(row: ProcRow): RpcSignature | undefined {
  const allNames = row.arg_names ?? [];
  // proargmodes null ise hepsi girdi; değilse yalnızca i/b/v girdi sayılır
  // (o = OUT, t = returns table sütunu).
  const inputNames = row.arg_modes
    ? allNames.filter((_, i) => ['i', 'b', 'v'].includes(row.arg_modes![i]))
    : allNames.slice(0, row.in_types.length);
  if (
    inputNames.length !== row.in_types.length ||
    inputNames.some((name) => !name)
  ) {
    return undefined;
  }
  const firstDefault = row.in_types.length - row.pronargdefaults;
  return {
    name: row.proname,
    params: row.in_types.map((type, i) => ({
      name: inputNames[i],
      type,
      hasDefault: i >= firstDefault,
    })),
    returnsSet: row.proretset,
    returnsVoid: row.rettype === 'void',
  };
}
