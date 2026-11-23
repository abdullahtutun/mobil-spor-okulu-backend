/**
 * Yalnızca sunucunun kendi servislerinin (ex Edge Function'lar) PostgREST
 * kurallarıyla — gönderilen anahtar kümesine göre imza seçimi, eksik
 * opsiyonelin varsayılanı, `json_to_record` tip çevirisi — çağırdığı SQL
 * fonksiyonları (`RpcService.callAs`). Bunlar `POST /rpc/:name`'den
 * çağrılamaz: gateway allow-list'e bakar, bu listeye değil.
 *
 * Neden PostgREST kuralıyla: istemcinin gövdesi (online ön kayıt formu,
 * aktarım formu) bugün olduğu gibi fonksiyona geçiyor; bilinmeyen bir anahtar
 * ya da tipe uymayan bir değer Supabase'te nasıl düşüyorsa burada da öyle
 * düşmeli.
 */
export const SERVER_RPCS = ['create_public_pre_registration_by_token'] as const;
