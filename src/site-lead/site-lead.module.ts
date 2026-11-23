import { Module } from '@nestjs/common';
import { IpHasher } from '../common/http/ip-hash';
import { SiteLeadController } from './site-lead.controller';
import { SiteLeadService } from './site-lead.service';

/**
 * S10: tanıtım sitesinin formu — ex `site-lead` (`docs/api/functions.md`).
 * Sınırlar ve kayıt `submit_site_lead`'de; saklama süresi cron'u
 * (`purge_expired_site_leads`) S03'ün 0003'ünde.
 */
@Module({
  controllers: [SiteLeadController],
  providers: [SiteLeadService, IpHasher],
})
export class SiteLeadModule {}
