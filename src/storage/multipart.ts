import { StorageError } from './storage-errors';

/**
 * `multipart/form-data` gövdesinden storage-api'nin okuduğu parçalar.
 *
 * Neden busboy değil: Dart'ın `http` paketi (storage_client) dosya parçasını
 * `name=""; filename=""` ile gönderir. busboy boş `filename`'i yok sayar ve
 * `image/jpeg` türlü parçayı metin alanı sanar (baytları da bozar).
 * storage-api'nin (`@fastify/multipart`) yaptığı gibi burada `filename`
 * parametresi olan — boş da olsa — ya da türü `text/plain` olmayan ilk parça
 * dosyadır. Gövde en çok bucket sınırı kadar olduğu için (≤ birkaç MB)
 * bellekte ayrıştırmak yeterli; büyüklük sınırını çağıran uygular.
 */
export interface MultipartUpload {
  file: Buffer;
  /** Dosya parçasının Content-Type'ı; `contentType` alanı varsa o. */
  mimeType: string | undefined;
  fields: Record<string, string>;
}

const MAX_PARTS = 12;
const MAX_FIELD_BYTES = 64 * 1024;
const CRLF = Buffer.from('\r\n');
const HEADER_END = Buffer.from('\r\n\r\n');

export function boundaryOf(contentType: string): string {
  const match = /;\s*boundary=(?:"([^"]{1,70})"|([^\s;]{1,70}))/i.exec(
    contentType,
  );
  const boundary = match?.[1] ?? match?.[2];
  if (!boundary) {
    throw StorageError.invalidRequest('multipart boundary missing');
  }
  return boundary;
}

export function parseMultipart(
  body: Buffer,
  contentType: string,
): MultipartUpload {
  const delimiter = Buffer.from(`--${boundaryOf(contentType)}`);
  const malformed = () =>
    StorageError.invalidRequest('Malformed multipart body');

  let position = body.indexOf(delimiter);
  if (position < 0) throw malformed();

  const fields: Record<string, string> = {};
  let file: Buffer | undefined;
  let fileType: string | undefined;
  let parts = 0;

  for (;;) {
    position += delimiter.length;
    // Kapanış sınırı: `--boundary--`
    if (body[position] === 0x2d && body[position + 1] === 0x2d) break;
    if (!body.subarray(position, position + 2).equals(CRLF)) throw malformed();
    position += 2;

    if (++parts > MAX_PARTS) {
      throw StorageError.invalidRequest('Too many multipart parts');
    }

    const headerEnd = body.indexOf(HEADER_END, position);
    if (headerEnd < 0) throw malformed();
    const headers = parseHeaders(
      body.subarray(position, headerEnd).toString('latin1'),
    );
    const contentStart = headerEnd + HEADER_END.length;
    const next = body.indexOf(Buffer.concat([CRLF, delimiter]), contentStart);
    if (next < 0) throw malformed();
    const content = body.subarray(contentStart, next);

    const disposition = headers['content-disposition'];
    if (!disposition || !/^form-data\b/i.test(disposition)) throw malformed();
    const name = dispositionParam(disposition, 'name') ?? '';
    const filename = dispositionParam(disposition, 'filename');
    const partType = headers['content-type'];
    const isFile =
      filename !== undefined ||
      (partType !== undefined && !/^text\/plain\b/i.test(partType));

    if (isFile) {
      // storage-api ilk dosya parçasını alır; ikincisi sınır dışı.
      if (file !== undefined) {
        throw StorageError.invalidRequest('Only one file per request');
      }
      file = Buffer.from(content);
      fileType = partType;
    } else if (file === undefined) {
      // storage-api alanları dosya parçasına kadar okur.
      if (content.length > MAX_FIELD_BYTES) {
        throw StorageError.invalidRequest('Multipart field too large');
      }
      fields[name] = content.toString('utf8');
    }
    position = next + CRLF.length;
  }

  if (file === undefined) {
    throw StorageError.invalidRequest('No file in multipart body');
  }
  return {
    file,
    mimeType: fields.contentType ?? fileType,
    fields,
  };
}

function parseHeaders(raw: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const line of raw.split('\r\n')) {
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    headers[line.slice(0, colon).trim().toLowerCase()] = line
      .slice(colon + 1)
      .trim();
  }
  return headers;
}

/** `name="…"` ya da `name=…`; parametre yoksa `undefined`, boşsa `''`. */
function dispositionParam(
  disposition: string,
  param: string,
): string | undefined {
  const match = new RegExp(
    `;\\s*${param}=(?:"((?:[^"\\\\]|\\\\.)*)"|([^;\\s]*))`,
    'i',
  ).exec(disposition);
  if (!match) return undefined;
  return match[1] !== undefined ? match[1].replace(/\\(.)/g, '$1') : match[2];
}
