import {
  decodeObjectKey,
  isValidBucketId,
  isValidObjectKey,
} from './object-key';
import { StorageError } from './storage-errors';

describe('nesne adı kuralı', () => {
  it.each([
    'a0000000-0000-4000-8000-000000000001/a0000000-0000-4000-8000-000000000101/3f2c9b1e-0d4a-4c1b-9e0f-1a2b3c4d5e6f.jpg',
    'a0000000-0000-4000-8000-000000000001/a0000000-0000-4000-8000-000000000101/3f2c9b1e-0d4a-4c1b-9e0f-1a2b3c4d5e6f_thumb.jpg',
    'a0000000-0000-4000-8000-000000000001/logo.png',
    'dosya adi (1)!.png',
  ])('uygulamanın yolunu kabul eder: %s', (key) => {
    expect(isValidObjectKey(key)).toBe(true);
  });

  it.each([
    ['boş', ''],
    ['..', 'a/../b'],
    ['yalnız ..', '..'],
    ['.', 'a/./b'],
    ['baştaki /', '/etc/passwd'],
    ['sondaki /', 'a/b/'],
    ['boş parça', 'a//b'],
    ['gizli dosya', 'a/.tmp'],
    ['null bayt', 'a/b\0.jpg'],
    ['ters bölü', 'a\\..\\b'],
    ['ASCII dışı', 'çocuk.jpg'],
    ['yüzde', 'a%2Fb'],
    ['uzun ad', 'a/'.repeat(600) + 'b'],
    ['uzun parça', 'x'.repeat(256)],
  ])('reddeder: %s', (_, key) => {
    expect(isValidObjectKey(key)).toBe(false);
  });

  it('URL yolunu parça parça çözer', () => {
    expect(() => decodeObjectKey('okul/dosya%20ad%C4%B1')).toThrow(
      StorageError,
    );
    expect(decodeObjectKey('okul/dosya%20adi.png')).toBe('okul/dosya adi.png');
  });

  it.each([
    'okul%2F..%2Fx',
    'a/%2e%2e/b',
    'a/%00.jpg',
    'a/%E0%A4%A',
    'a/%5C..',
  ])('kodlanmış saldırıyı reddeder: %s', (raw) => {
    expect(() => decodeObjectKey(raw)).toThrow(StorageError);
  });

  it('bucket kimliği', () => {
    expect(isValidBucketId('athlete-photos')).toBe(true);
    expect(isValidBucketId('school-logos')).toBe(true);
    expect(isValidBucketId('..')).toBe(false);
    expect(isValidBucketId('.tmp')).toBe(false);
    expect(isValidBucketId('A')).toBe(false);
  });
});
