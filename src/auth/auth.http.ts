import { HttpStatus } from '@nestjs/common';
import type { Request, Response } from 'express';
import type { z } from 'zod';
import { ApiException } from '../common/errors/api-error';
import { authError } from './auth.errors';
import type { ClientInfo } from './auth.repository';

/** Auth uçlarının gövde doğrulaması: hata 400 `validation_failed`. */
export function parseAuthBody<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw authError(
      HttpStatus.BAD_REQUEST,
      'validation_failed',
      result.error.issues
        .map((i) => `${i.path.join('.') || '(gövde)'}: ${i.message}`)
        .join('; '),
    );
  }
  return result.data;
}

/** Hız sınırı hatasının `retryAfterSec`'ini `Retry-After` başlığına yazar. */
export async function withRetryAfter<T>(
  res: Response,
  work: () => Promise<T>,
): Promise<T> {
  try {
    return await work();
  } catch (error) {
    const retryAfter = (error as { retryAfterSec?: number }).retryAfterSec;
    if (error instanceof ApiException && retryAfter !== undefined) {
      res.setHeader('Retry-After', String(retryAfter));
    }
    throw error;
  }
}

/** Oturum satırına yazılan istemci bilgisi (IP `trust proxy`'ye göre). */
export function clientInfo(req: Request): ClientInfo {
  const ua = req.headers['user-agent'];
  return {
    ip: normalizeIp(req.ip),
    userAgent: typeof ua === 'string' && ua !== '' ? ua.slice(0, 512) : null,
  };
}

function normalizeIp(ip: string | undefined): string | null {
  if (!ip) return null;
  // IPv4'ün IPv6 gösterimi (::ffff:1.2.3.4) düz IPv4'e: aynı istemci tek anahtar.
  const v4 = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  return v4 ? v4[1] : ip;
}
