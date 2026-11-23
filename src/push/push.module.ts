import { Logger, Module } from '@nestjs/common';
import { APP_CONFIG } from '../config/config.module';
import type { AppConfig } from '../config/env.schema';
import {
  FCM_TRANSPORT,
  HttpFcmTransport,
  parseServiceAccount,
} from './fcm.transport';
import { PushRepository } from './push.repository';
import { PushWorker } from './push.worker';

/**
 * S11: push kuyruğunun FCM'e boşaltılması (ex `send-push`). HTTP ucu yok:
 * veritabanı `pg_notify('push_dispatch')` ile dürter (K10), paylaşılan sır
 * (`PUSH_DISPATCH_SECRET`) da bu yüzden gerekmez.
 */
@Module({
  providers: [
    {
      provide: FCM_TRANSPORT,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => {
        const { account, error } = parseServiceAccount(
          config.FCM_SERVICE_ACCOUNT,
        );
        if (error) new Logger('PushModule').error(`${error} Push kapalı.`);
        return new HttpFcmTransport(account);
      },
    },
    PushRepository,
    PushWorker,
  ],
  exports: [PushWorker],
})
export class PushModule {}
