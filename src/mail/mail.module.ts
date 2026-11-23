import { Global, Module } from '@nestjs/common';
import {
  MAIL_TRANSPORT_FACTORY,
  MailService,
  smtpTransportFactory,
} from './mail.service';

/** Marka başına SMTP ve auth e-postaları (S06). */
@Global()
@Module({
  providers: [
    MailService,
    { provide: MAIL_TRANSPORT_FACTORY, useValue: smtpTransportFactory },
  ],
  exports: [MailService],
})
export class MailModule {}
