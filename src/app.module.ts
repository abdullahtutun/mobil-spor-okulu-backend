import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { LoggerModule } from 'nestjs-pino';
import { AuthModule } from './auth/auth.module';
import { AllExceptionsFilter } from './common/errors/all-exceptions.filter';
import { buildLoggerParams } from './common/logging/logging.options';
import { APP_CONFIG, ConfigModule } from './config/config.module';
import type { AppConfig } from './config/env.schema';
import { DbModule } from './db/db.module';
import { HealthModule } from './health/health.module';
import { MailModule } from './mail/mail.module';
import { RpcModule } from './rpc/rpc.module';

@Module({
  imports: [
    ConfigModule,
    LoggerModule.forRootAsync({
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => buildLoggerParams(config),
    }),
    // IP başına hız sınırı (bellekte; tek API süreci). Sağlık uçları muaf.
    ThrottlerModule.forRootAsync({
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => [
        { ttl: config.THROTTLE_TTL_MS, limit: config.THROTTLE_LIMIT },
      ],
    }),
    DbModule,
    MailModule,
    AuthModule,
    HealthModule,
    RpcModule,
  ],
  providers: [
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    { provide: APP_GUARD, useClass: ThrottlerGuard },
  ],
})
export class AppModule {}
