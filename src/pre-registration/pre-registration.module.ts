import { Module } from '@nestjs/common';
import { AccountsModule } from '../accounts/accounts.module';
import { IpHasher } from '../common/http/ip-hash';
import { RpcModule } from '../rpc/rpc.module';
import { PreRegistrationConversionService } from './pre-registration-conversion.service';
import {
  PreRegistrationConversionController,
  PublicPreRegistrationController,
} from './pre-registration.controller';
import { PreRegistrationRepository } from './pre-registration.repository';
import { PublicPreRegistrationService } from './public-pre-registration.service';

/**
 * S10: online ön kayıt ve aktarım — ex `submit-pre-registration`,
 * `convert-pre-registration`, `bulk-convert-pre-registrations`
 * (`docs/api/functions.md`). Kurallar SQL'de
 * (`create_public_pre_registration_by_token`, `record_pre_registration_attempt`,
 * `update_pre_registration`, `convert_pre_registration`, RLS).
 */
@Module({
  imports: [AccountsModule, RpcModule],
  controllers: [
    PreRegistrationConversionController,
    PublicPreRegistrationController,
  ],
  providers: [
    PreRegistrationRepository,
    PreRegistrationConversionService,
    PublicPreRegistrationService,
    IpHasher,
  ],
})
export class PreRegistrationModule {}
