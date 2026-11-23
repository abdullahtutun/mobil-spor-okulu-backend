import type { RpcSignature } from './rpc-catalog.service';

/** SQL tanımlayıcısını tırnaklar (`"ad"`, içteki `"` ikilenir). */
export function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

/**
 * Gönderilen anahtarlara uyan imzayı seçer — PostgREST'in kuralı: her
 * anahtar bir parametre adı olmalı, varsayılanı olmayan her parametre
 * gönderilmiş olmalı. Bilinmeyen bir anahtar da eksik zorunlu parametre de
 * "fonksiyon bulunamadı" demektir (PGRST202). Birden çok imza uyarsa
 * belirsiz (PGRST203).
 */
export function matchSignature(
  candidates: readonly RpcSignature[],
  keys: readonly string[],
): { match?: RpcSignature; ambiguous: boolean } {
  const matches = candidates.filter((signature) => {
    const names = new Set(signature.params.map((p) => p.name));
    return (
      keys.every((key) => names.has(key)) &&
      signature.params.every((p) => p.hasDefault || keys.includes(p.name))
    );
  });
  return { match: matches[0], ambiguous: matches.length > 1 };
}

/**
 * Çağrı SQL'i. Parametreler tek bir JSON (`$1`) olarak gider ve
 * `json_to_record` ile fonksiyonun kendi tiplerine çevrilir — PostgREST'in
 * yaptığının aynısı; böylece dizi (`uuid[]`), enum, `jsonb`, tarih
 * dönüşümleri PostgREST'teki gibi olur. Gönderilmeyen parametre çağrıya hiç
 * yazılmaz, fonksiyonun varsayılanı kullanılır.
 *
 * SQL'e giren adlar ve tipler `pg_proc`'tan gelir, istemciden değil:
 * istemcinin anahtarları yalnızca bilinen adlarla eşleştirilir.
 *
 * Sonuç tek sütun `result` (json):
 *   tek değer  → değerin kendisi (jsonb zarf, skaler, satır nesnesi)
 *   setof      → dizi (boşsa `[]`)
 *   void       → null
 */
export function buildCallSql(
  signature: RpcSignature,
  keys: readonly string[],
): string {
  const fn = `public.${quoteIdent(signature.name)}`;
  const sent = signature.params.filter((p) => keys.includes(p.name));

  const args = sent
    .map((p) => `${quoteIdent(p.name)} => _a.${quoteIdent(p.name)}`)
    .join(', ');
  const from =
    sent.length > 0
      ? `json_to_record($1::json) as _a(${sent
          .map((p) => `${quoteIdent(p.name)} ${p.type}`)
          .join(', ')}), lateral `
      : '';

  if (signature.returnsVoid) {
    return sent.length > 0
      ? `select ${fn}(${args}), null::json as result from json_to_record($1::json) as _a(${sent
          .map((p) => `${quoteIdent(p.name)} ${p.type}`)
          .join(', ')})`
      : `select ${fn}(), null::json as result`;
  }
  if (signature.returnsSet) {
    return `select coalesce(json_agg(_r), '[]'::json) as result from ${from}${fn}(${args}) as _r`;
  }
  return `select to_json(_r) as result from ${from}${fn}(${args}) as _r`;
}
