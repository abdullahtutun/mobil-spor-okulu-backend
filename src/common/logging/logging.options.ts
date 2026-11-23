import type { IncomingMessage } from 'node:http';
import type { Params } from 'nestjs-pino';
import type { AppConfig } from '../../config/env.schema';

/** Bu adlardaki alanlar hangi derinlikte olursa olsun loga yazılmaz. */
export const SENSITIVE_KEYS = [
  'password',
  'new_password',
  'token',
  'token_hash',
  'access_token',
  'refresh_token',
  'otp',
  'authorization',
  'cookie',
] as const;

export const REDACT_PATHS: string[] = [
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  ...SENSITIVE_KEYS.flatMap((key) => [key, `*.${key}`, `*.*.${key}`]),
];

export const REDACT_CENSOR = '[gizli]';

/** Sorgu dizesi tokenlar taşıyabilir (ör. `?token_hash=`); URL'den atılır. */
export function stripQuery(url: string | undefined): string | undefined {
  return url?.split('?')[0];
}

/** Sağlık kontrolleri saniyede bir gelir; otomatik istek logu yazılmaz. */
export function isHealthCheck(req: IncomingMessage): boolean {
  return stripQuery(req.url)?.startsWith('/health') ?? false;
}

export function buildLoggerParams(config: AppConfig): Params {
  return {
    pinoHttp: {
      level: config.LOG_LEVEL,
      redact: { paths: REDACT_PATHS, censor: REDACT_CENSOR },
      autoLogging: { ignore: isHealthCheck },
      serializers: {
        req: (req: { url?: string } & Record<string, unknown>) => ({
          ...req,
          url: stripQuery(req.url),
        }),
      },
      transport:
        config.NODE_ENV === 'development'
          ? { target: 'pino-pretty', options: { singleLine: true } }
          : undefined,
    },
  };
}
