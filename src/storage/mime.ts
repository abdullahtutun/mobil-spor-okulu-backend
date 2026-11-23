import { StorageError } from './storage-errors';

/**
 * `type/subtype` biçimi (RFC 6838 token'ları); parametreler (`; charset=…`)
 * atılır, tür küçük harfe çevrilir. Joker (`*`) istekte kabul edilmez.
 */
const TOKEN = '[A-Za-z0-9!#$&^_.+-]+';
const MEDIA_TYPE = new RegExp(`^\\s*(${TOKEN})/(${TOKEN})\\s*(;.*)?$`);

export function normalizeMimeType(value: string | undefined): string | null {
  if (value === undefined) return null;
  const match = MEDIA_TYPE.exec(value);
  if (!match) return null;
  return `${match[1]}/${match[2]}`.toLowerCase();
}

/**
 * storage-api'nin kuralı: liste boşsa her tür; değilse ya aynı tür ya da
 * listedeki `image/*` gibi alt tür jokeri. `*\/*` hiçbir şeyle eşleşmez.
 */
export function isAllowedMimeType(
  mimeType: string,
  allowed: readonly string[] | null,
): boolean {
  if (!allowed || allowed.length === 0) return true;
  const wildcard = `${mimeType.slice(0, mimeType.indexOf('/') + 1)}*`;
  return allowed.some((entry) => {
    const normalized = entry.trim().toLowerCase();
    return normalized === mimeType || normalized === wildcard;
  });
}

/** İçeriğin ilk baytlarından tanınabilen türler. */
const SIGNATURES: Record<string, (bytes: Buffer) => boolean> = {
  'image/jpeg': (b) =>
    b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/png': (b) =>
    b.length >= 8 &&
    b
      .subarray(0, 8)
      .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  'image/gif': (b) =>
    b.length >= 6 && /^GIF8[79]a$/.test(b.subarray(0, 6).toString('latin1')),
  'image/webp': (b) =>
    b.length >= 12 &&
    b.subarray(0, 4).toString('latin1') === 'RIFF' &&
    b.subarray(8, 12).toString('latin1') === 'WEBP',
};

/**
 * Yüklemenin türünü doğrular: bildirilen tür bucket'ın listesinde olmalı
 * (Supabase'in yaptığı) **ve** gövde gerçekten o türde olmalı (Supabase'te
 * yok; S08 kuralı). Uzantıya bakılmaz. Resim türleri imzayla sınanır;
 * imzasını tanımadığımız bir `image/*` türü reddedilir — bir bucket'a yeni
 * resim türü açılırsa önce imzası buraya eklenir. Resim dışı türler yalnızca
 * listeyle denetlenir (bugünkü iki bucket'ta yok).
 *
 * Dönüş: saklanacak (normalleştirilmiş) tür.
 */
export function checkUploadType(
  declared: string | undefined,
  allowed: readonly string[] | null,
  bytes: Buffer,
): string {
  const mimeType = normalizeMimeType(declared);
  if (!mimeType) {
    throw StorageError.invalidMimeType(String(declared ?? ''));
  }
  if (!isAllowedMimeType(mimeType, allowed)) {
    throw StorageError.invalidMimeType(mimeType);
  }
  const signature = SIGNATURES[mimeType];
  if (signature) {
    if (!signature(bytes)) throw StorageError.contentMismatch(mimeType);
  } else if (mimeType.startsWith('image/')) {
    throw StorageError.contentMismatch(mimeType);
  }
  return mimeType;
}
