import {
  Global,
  Inject,
  Logger,
  Module,
  OnApplicationShutdown,
} from '@nestjs/common';
import { Kysely, PostgresDialect } from 'kysely';
import { Pool } from 'pg';
import { APP_CONFIG } from '../config/config.module';
import type { AppConfig } from '../config/env.schema';
import { DbContextService } from './db-context.service';
import type { Database } from './database';
import { DB_POOL, KYSELY } from './db.tokens';
import { PgListener } from './pg-listener.service';

const logger = new Logger('DbModule');

@Global()
@Module({
  providers: [
    {
      provide: DB_POOL,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => {
        // api_authenticator olarak (K5); her istek DbContextService.run ile
        // rol değiştirir. DATABASE_URL (postgres) API'de kullanılmaz.
        const pool = new Pool({
          connectionString: config.API_DATABASE_URL,
          max: 10,
          idleTimeoutMillis: 30_000,
          connectionTimeoutMillis: 5_000,
          application_name: 'mobil-spor-okulu-api',
        });
        // Boştaki bir bağlantı koparsa (Postgres yeniden başladı, ağ gitti)
        // pg havuzu 'error' yayar; dinleyici yoksa süreç çöker. Bağlantı
        // havuzdan zaten atılır, sonraki istek yenisini açar.
        pool.on('error', (err) => {
          logger.warn({ err }, 'Boştaki veritabanı bağlantısı koptu');
        });
        return pool;
      },
    },
    {
      provide: KYSELY,
      inject: [DB_POOL],
      useFactory: (pool: Pool) =>
        new Kysely<Database>({ dialect: new PostgresDialect({ pool }) }),
    },
    DbContextService,
    // S11: havuz dışı LISTEN bağlantısı (push dürtmesi, gelen kutusu olayları).
    PgListener,
  ],
  exports: [DB_POOL, KYSELY, DbContextService, PgListener],
})
export class DbModule implements OnApplicationShutdown {
  constructor(
    @Inject(KYSELY) private readonly db: Kysely<Database>,
    @Inject(DB_POOL) private readonly pool: Pool,
  ) {}

  /**
   * Kysely'nin `destroy()`'u havuzu yalnızca Kysely bir sorgu çalıştırdıysa
   * kapatır (sürücü havuzu ilk sorguda devralır). Havuz başka yerden
   * kullanılmış olabileceği için ayrıca kapatılır; açık bağlantı kalmaz.
   */
  async onApplicationShutdown(): Promise<void> {
    await this.db.destroy();
    if (!this.pool.ended) await this.pool.end();
  }
}
