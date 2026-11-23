import { StorageError } from './storage-errors';

/**
 * Nesne adlarının (storage.objects.name) ve bucket kimliklerinin kuralı.
 *
 * Karakter kümesi Supabase storage-api'ninki (`limits.ts` → VALID_OBJECT_KEY):
 * harf, rakam ve `_ / ! . * ' ( ) boşluk & $ = @ ; : + , ? -`. Supabase
 * nesneleri S3'te tuttuğu için `..`, `.` ve boş parçaya izin veriyordu; biz
 * dosyayı diskte `STORAGE_ROOT/<bucket>/<ad>` olarak tuttuğumuz için ayrıca
 * reddediyoruz:
 *   - boş parça (`a//b`, baştaki ya da sondaki `/`),
 *   - `.` ve `..` parçaları,
 *   - `.` ile başlayan parça (diskte gizli dosya / `.tmp`, `.trash` ile karışmasın),
 *   - 1024 bayttan uzun ad, 255 bayttan uzun parça (dosya sistemi sınırı).
 * Null bayt, ters bölü ve ASCII dışı karakter zaten kümenin dışında.
 *
 * Uygulamaların yolları (`<okul>/<sporcu>/<uuid>.jpg`, `<okul>/logo.png`) bu
 * kuralın içinde; canlıdaki 15 nesne de (S12 taşırken yine bu fonksiyonla
 * denetler).
 */
const VALID_OBJECT_KEY = /^[A-Za-z0-9_/!.*'() &$=@;:+,?-]+$/;
const MAX_KEY_BYTES = 1024;
const MAX_SEGMENT_BYTES = 255;

/** Bucket kimliği diskte klasör adı olur: küçük harf, rakam, `-`, `_`. */
const VALID_BUCKET_ID = /^[a-z0-9][a-z0-9_-]{0,62}$/;

export function isValidObjectKey(key: string): boolean {
  if (!VALID_OBJECT_KEY.test(key)) return false;
  if (Buffer.byteLength(key, 'utf8') > MAX_KEY_BYTES) return false;
  return key
    .split('/')
    .every(
      (segment) =>
        segment.length > 0 &&
        !segment.startsWith('.') &&
        Buffer.byteLength(segment, 'utf8') <= MAX_SEGMENT_BYTES,
    );
}

export function mustBeValidObjectKey(key: string): string {
  if (!isValidObjectKey(key)) throw StorageError.invalidKey(key);
  return key;
}

export function isValidBucketId(bucketId: string): boolean {
  return VALID_BUCKET_ID.test(bucketId);
}

/**
 * URL yolunun nesne adı kısmını (hâlâ yüzde kodlu) çözer. Her parça ayrı
 * çözülür; çözülünce `/` içeren bir parça (`%2F`) ya da bozuk kodlama
 * reddedilir — yoksa `a%2F..%2Fb` çözüldükten sonra başka bir yol olurdu.
 */
export function decodeObjectKey(rawPath: string): string {
  const segments = rawPath.split('/').map((segment) => {
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      throw StorageError.invalidKey(rawPath);
    }
    if (decoded.includes('/')) throw StorageError.invalidKey(rawPath);
    return decoded;
  });
  return mustBeValidObjectKey(segments.join('/'));
}
