import { existsSync } from 'node:fs';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { APP_CONFIG } from './config/config.module';
import {
  InvalidConfigError,
  loadConfig,
  type AppConfig,
} from './config/env.schema';

async function bootstrap(): Promise<void> {
  // Yerelde `.env`; üretimde (Coolify) değişkenler ortamdan gelir.
  if (existsSync('.env')) process.loadEnvFile('.env');
  // Nest açılmadan önce doğrula: hata yığın izi olmadan, tek mesajla çıkar.
  loadConfig(process.env);

  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));
  app.enableShutdownHooks();

  const config = app.get<AppConfig>(APP_CONFIG);
  await app.listen(config.PORT);
}

bootstrap().catch((error: unknown) => {
  // Yapılandırma hatası logger kurulmadan olur; düz ve okunur yazılır.
  if (error instanceof InvalidConfigError) {
    console.error(error.message);
  } else {
    console.error('Açılış başarısız:', error);
  }
  process.exit(1);
});
