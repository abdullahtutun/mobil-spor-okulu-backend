// Kopya: yönetim reposu supabase/functions/send-push/fcm_error.ts — İKİSİ
// birlikte değişir (fcm-error.spec.ts kaynak varsa iki çıktıyı karşılaştırır).
//
// FCM'in hata yanıtından "bu token ölü, sil" kararı.
//
// Yanlış "evet" pahalıdır: geçerli bir token silinir ve kullanıcı uygulamayı
// yeniden açana kadar hiçbir push alamaz. Bu yüzden karar dar tutulur ve
// emin olunmayan her durum yeniden denemeye düşer — yeniden deneme en kötü
// ihtimalle beş denemeden sonra satırı `failed` yapar, token'a dokunmaz.
//
// Geçmiş:
// - Önce `text.includes('registration token')` vardı. O metin APNs kimlik
//   bilgisi hatalıyken dönen 401/THIRD_PARTY_AUTH_ERROR gövdesinde de geçiyor;
//   sunucudaki bir yapılandırma hatası geçerli token'ları sildiriyordu.
// - Sonra `errorCode` UNREGISTERED ya da INVALID_ARGUMENT ise silindi. Ama
//   INVALID_ARGUMENT yalnızca bozuk token değil, mesajın kendisindeki her
//   hata için de döner (çok büyük yük, geçersiz `data` değeri…). Bir duyuru
//   reddedilince alıcıların bütün token'ları silinirdi.

interface FcmErrorBody {
  error?: {
    message?: string;
    details?: Array<{
      errorCode?: unknown;
      fieldViolations?: Array<{ field?: unknown }>;
    }>;
  };
}

export function isDeadToken(body: string): boolean {
  let parsed: FcmErrorBody;
  try {
    parsed = JSON.parse(body) as FcmErrorBody;
  } catch {
    return false;
  }

  const details = Array.isArray(parsed?.error?.details)
    ? parsed.error.details
    : [];
  const errorCode = details.find(
    (d) => typeof d?.errorCode === 'string',
  )?.errorCode;

  // Uygulama kaldırıldı, verisi silindi ya da token yenilendi.
  if (errorCode === 'UNREGISTERED') return true;
  if (errorCode !== 'INVALID_ARGUMENT') return false;

  const fields = details
    .flatMap((d) =>
      Array.isArray(d?.fieldViolations) ? d.fieldViolations : [],
    )
    .map((v) => v?.field)
    .filter((f): f is string => typeof f === 'string');

  // Hatalı alan söylenmişse karar ona göre: yalnızca token.
  if (fields.length > 0) return fields.every((f) => f === 'message.token');

  // Bozuk token yanıtı çoğu zaman alan belirtmez, yalnızca şunu der:
  // "The registration token is not a valid FCM registration token".
  return /registration token/i.test(parsed?.error?.message ?? '');
}
