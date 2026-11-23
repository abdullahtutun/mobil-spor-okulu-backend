import { HttpException, Logger } from '@nestjs/common';
import type { DbContextService } from '../db/db-context.service';
import { HealthController } from './health.controller';

function controllerWith(ping: () => Promise<void>): HealthController {
  return new HealthController({ ping } as unknown as DbContextService);
}

describe('HealthController', () => {
  it('veritabanı cevap verince ok döner', async () => {
    await expect(
      controllerWith(() => Promise.resolve()).ready(),
    ).resolves.toEqual({ status: 'ok', database: 'ok' });
  });

  it('veritabanı yoksa 503 service_unavailable fırlatır', async () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const error = await controllerWith(() =>
      Promise.reject(new Error('ECONNREFUSED')),
    )
      .ready()
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HttpException);
    expect((error as HttpException).getStatus()).toBe(503);
    expect((error as HttpException).getResponse()).toMatchObject({
      code: 'service_unavailable',
    });
  });

  it('live veritabanına bakmaz', () => {
    const ping = jest.fn();
    expect(controllerWith(ping).live()).toEqual({ status: 'ok' });
    expect(ping).not.toHaveBeenCalled();
  });
});
