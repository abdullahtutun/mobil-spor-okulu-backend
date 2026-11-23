import { Controller, Get, HttpStatus, Logger } from '@nestjs/common';
import { ApiException } from '../common/errors/api-error';
import { DbContextService } from '../db/db-context.service';

@Controller('health')
export class HealthController {
  private readonly logger = new Logger(HealthController.name);

  constructor(private readonly db: DbContextService) {}

  /** Hazır mı: veritabanına `select 1` gidiyor mu. Coolify/izleme bunu sorar. */
  @Get()
  async ready(): Promise<{ status: 'ok'; database: 'ok' }> {
    try {
      await this.db.ping();
    } catch (err) {
      this.logger.warn({ err }, 'Sağlık kontrolü: veritabanına ulaşılamadı');
      throw ApiException.of(
        HttpStatus.SERVICE_UNAVAILABLE,
        'service_unavailable',
        'Veritabanına ulaşılamıyor.',
      );
    }
    return { status: 'ok', database: 'ok' };
  }

  /** Canlı mı: süreç cevap veriyor; veritabanına bakmaz. */
  @Get('live')
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }
}
