import { parseMultipart } from './multipart';
import { StorageError } from './storage-errors';

/** Dart `http` paketinin MultipartRequest'i (storage_client'ın gönderdiği). */
function dartMultipart(file: Buffer, type: string, cacheControl = '3600') {
  const boundary = 'dart-http-boundary-abc123';
  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\ncontent-disposition: form-data; name="cacheControl"\r\n\r\n${cacheControl}\r\n` +
        `--${boundary}\r\ncontent-type: ${type}\r\ncontent-disposition: form-data; name=""; filename=""\r\n\r\n`,
    ),
    file,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}

describe('multipart', () => {
  it('Dart biçimini (boş name ve filename) dosya olarak okur, baytlar bozulmaz', () => {
    const file = Buffer.from([
      0xff, 0xd8, 0xff, 0x00, 0x0d, 0x0a, 0x2d, 0x2d, 0x80, 0xfe,
    ]);
    const { body, contentType } = dartMultipart(file, 'image/jpeg');
    const parsed = parseMultipart(body, contentType);
    expect(parsed.file.equals(file)).toBe(true);
    expect(parsed.mimeType).toBe('image/jpeg');
    expect(parsed.fields.cacheControl).toBe('3600');
  });

  it('contentType alanı parça türünü ezer (storage-api)', () => {
    const boundary = 'b';
    const body = Buffer.from(
      `--b\r\ncontent-disposition: form-data; name="contentType"\r\n\r\nimage/png\r\n` +
        `--b\r\ncontent-disposition: form-data; name="file"; filename="x.bin"\r\ncontent-type: application/octet-stream\r\n\r\nABC\r\n--b--`,
    );
    const parsed = parseMultipart(
      body,
      `multipart/form-data; boundary="${boundary}"`,
    );
    expect(parsed.mimeType).toBe('image/png');
    expect(parsed.file.toString()).toBe('ABC');
  });

  it.each([
    ['sınırsız', 'multipart/form-data', 'x'],
    [
      'dosyasız',
      'multipart/form-data; boundary=b',
      '--b\r\ncontent-disposition: form-data; name="a"\r\n\r\n1\r\n--b--',
    ],
    [
      'kapanmamış',
      'multipart/form-data; boundary=b',
      '--b\r\ncontent-disposition: form-data; name=""; filename=""\r\n\r\nABC',
    ],
    [
      'iki dosya',
      'multipart/form-data; boundary=b',
      '--b\r\ncontent-disposition: form-data; name=""; filename=""\r\n\r\nA\r\n--b\r\ncontent-disposition: form-data; name=""; filename=""\r\n\r\nB\r\n--b--',
    ],
  ])('bozuk gövdeyi reddeder: %s', (_, type, raw) => {
    expect(() => parseMultipart(Buffer.from(raw), type)).toThrow(StorageError);
  });
});
