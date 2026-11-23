import { Writable } from 'node:stream';
import pino from 'pino';
import {
  REDACT_CENSOR,
  REDACT_PATHS,
  buildLoggerParams,
  stripQuery,
} from './logging.options';

function capture(): { logger: pino.Logger; output: () => string } {
  let buffer = '';
  const stream = new Writable({
    write(chunk: Buffer, _enc, done) {
      buffer += chunk.toString();
      done();
    },
  });
  const logger = pino(
    { redact: { paths: REDACT_PATHS, censor: REDACT_CENSOR } },
    stream,
  );
  return { logger, output: () => buffer };
}

describe('log redaksiyonu', () => {
  it('başlıktaki ve gövdedeki sırları yazmaz', () => {
    const { logger, output } = capture();
    logger.info(
      {
        password: 'sifre-1',
        refresh_token: 'rt-1',
        body: { password: 'sifre-2', token: 'tok-2' },
        req: {
          headers: { authorization: 'Bearer jwt-3', cookie: 'sid=c-3' },
          query: { token_hash: 'th-3' },
        },
        res: { headers: { 'set-cookie': 'sid=c-4' } },
        email: 'gorunur@ornek.com',
      },
      'istek',
    );
    const line = output();
    for (const secret of [
      'sifre-1',
      'rt-1',
      'sifre-2',
      'tok-2',
      'jwt-3',
      'c-3',
      'th-3',
      'c-4',
    ]) {
      expect(line).not.toContain(secret);
    }
    expect(line).toContain(REDACT_CENSOR);
    expect(line).toContain('gorunur@ornek.com');
  });

  it("URL'nin sorgu dizesini atar", () => {
    expect(stripQuery('/sifre?token_hash=abc&type=invite')).toBe('/sifre');
    expect(stripQuery('/health')).toBe('/health');
  });

  it('pino-pretty yalnızca geliştirmede açılır', () => {
    const base = {
      PORT: 3000,
      DATABASE_URL: 'postgres://x',
      JWT_SECRET: 'x'.repeat(32),
      LOG_LEVEL: 'info' as const,
    };
    const dev = buildLoggerParams({ ...base, NODE_ENV: 'development' });
    const prod = buildLoggerParams({ ...base, NODE_ENV: 'production' });
    expect(dev.pinoHttp).toHaveProperty('transport.target', 'pino-pretty');
    expect(prod.pinoHttp).toHaveProperty('transport', undefined);
  });
});
