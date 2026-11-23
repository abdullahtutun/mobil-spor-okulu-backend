import type { NextFunction, Request, Response } from 'express';

/**
 * Gövdeyi ham metin olarak okuyan ara katman (oturumsuz formlar, S10).
 *
 * Ex Edge Function'lar gövdeyi kendileri okuyordu (`req.json()` /
 * `req.text()`): bozuk JSON, içerik türü ve boyut onların yanıt zarfıyla
 * dönüyordu. Express'in JSON ayrıştırıcısı bu yolların önüne geçerse bozuk
 * gövde bizim genel `{code, message}` hatamıza düşer ve istemcilerin okuduğu
 * zarf bozulur. Bu yüzden bu yollar gövdeyi metin olarak alır; ayrıştırmayı
 * ve sınırı fonksiyonun kendisi uygular.
 *
 * - İçerik türüne bakılmaz (Edge'de de bakılmıyordu).
 * - `maxBytes`'ı aşan gövde saklanmaz: okunur ve atılır, `rawBodyTooLarge`
 *   işaretlenir (bağlantıyı kesmek istemciye 413 yerine ağ hatası
 *   gösterirdi — S08'deki ders). `drainLimit`'ten sonrası okunmaz, istek
 *   kapatılır.
 * - Sonuç `req.body` (string) ve `req._body = true`: arkadan gelen JSON
 *   ayrıştırıcısı bu isteği atlar.
 */
export function rawTextBody(maxBytes: number, drainLimit: number) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const state = req as Request & {
      _body?: boolean;
      rawBodyTooLarge?: boolean;
    };
    if (state._body || req.method === 'GET' || req.method === 'OPTIONS') {
      next();
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const finish = (error?: Error) => {
      if (done) return;
      done = true;
      if (error) {
        next(error);
        return;
      }
      state._body = true;
      state.rawBodyTooLarge = size > maxBytes;
      req.body = state.rawBodyTooLarge
        ? ''
        : Buffer.concat(chunks).toString('utf8');
      next();
    };
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size <= maxBytes) chunks.push(chunk);
      else chunks.length = 0;
      if (size > drainLimit) {
        done = true;
        req.pause();
        res.status(413).setHeader('Connection', 'close');
        res.json({
          success: false,
          code: 'validation',
          message: 'İstek çok büyük.',
          data: null,
          error: 'İstek çok büyük.',
        });
        req.destroy();
      }
    });
    req.on('end', () => finish());
    req.on('error', (error) => finish(error));
  };
}

/** `rawTextBody`'nin işareti: gövde `maxBytes`'ı aştı. */
export function bodyTooLarge(req: Request): boolean {
  return (
    (req as Request & { rawBodyTooLarge?: boolean }).rawBodyTooLarge === true
  );
}
