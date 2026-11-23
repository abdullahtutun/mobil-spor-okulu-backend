import { checkUploadType, isAllowedMimeType, normalizeMimeType } from './mime';
import { StorageError } from './storage-errors';

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]);

describe('dosya türü', () => {
  it('normalleştirir', () => {
    expect(normalizeMimeType('Image/JPEG; charset=binary')).toBe('image/jpeg');
    // İstekte joker kabul edilmez (storage-api).
    expect(normalizeMimeType('image/*')).toBeNull();
    expect(normalizeMimeType('jpeg')).toBeNull();
    expect(normalizeMimeType(undefined)).toBeNull();
  });

  it('bucket listesi: aynı tür ya da alt tür jokeri', () => {
    expect(isAllowedMimeType('image/jpeg', ['image/jpeg'])).toBe(true);
    expect(isAllowedMimeType('image/png', ['image/jpeg'])).toBe(false);
    expect(isAllowedMimeType('image/png', ['image/*'])).toBe(true);
    expect(isAllowedMimeType('image/png', ['*/*'])).toBe(false);
    expect(isAllowedMimeType('text/plain', null)).toBe(true);
  });

  it('bildirilen tür ve gövde uyuşmalı', () => {
    expect(checkUploadType('image/jpeg', ['image/jpeg'], JPEG)).toBe(
      'image/jpeg',
    );
    expect(checkUploadType('image/png', ['image/png'], PNG)).toBe('image/png');
    // Listede değil
    expect(() => checkUploadType('image/png', ['image/jpeg'], PNG)).toThrow(
      StorageError,
    );
    // Uzantı/tür jpeg ama içerik PNG ya da HTML
    expect(() => checkUploadType('image/jpeg', ['image/jpeg'], PNG)).toThrow(
      /does not match/,
    );
    expect(() =>
      checkUploadType('image/jpeg', ['image/jpeg'], Buffer.from('<html>')),
    ).toThrow(/does not match/);
    // İmzası bilinmeyen resim türü
    expect(() =>
      checkUploadType('image/svg+xml', ['image/*'], Buffer.from('<svg')),
    ).toThrow(StorageError);
    // Bozuk tür
    expect(() => checkUploadType('bozuk', null, JPEG)).toThrow(/not supported/);
  });
});
