import { Inject, Injectable, Logger } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type { Envelope } from '../accounts/accounts.repository';
import { APP_CONFIG } from '../config/config.module';
import type { AppConfig } from '../config/env.schema';
import { DbContextService } from '../db/db-context.service';
import { MailService } from '../mail/mail.service';
import {
  looksLikeBot,
  notificationText,
  type SiteLead,
  validateSiteLead,
} from './site-lead.validation';

/** Yanıt: HTTP durumu ve uygulamaların RPC zarfı. */
export interface SiteLeadReply {
  status: number;
  body: Record<string, unknown>;
}

const ok = (): SiteLeadReply => ({
  status: 200,
  body: { success: true, code: 'ok', message: null, data: null },
});

const err = (status: number, code: string, message: string): SiteLeadReply => ({
  status,
  body: { success: false, code, message, data: null, error: message },
});

/**
 * Ex `site-lead` (yönetim reposu `supabase/functions/site-lead/index.ts`):
 * tanıtım sitesinin demo ve iletişim formları. Koruma katmanları ve sıra
 * aynı:
 *   1. bal küpü / çok hızlı gönderim → sahte "başarılı", satır yok
 *   2. gövde boyutu (16 KB, `rawTextBody`) ve alan doğrulaması
 *   3. `submit_site_lead` (service_role): IP özeti ve telefon başına sınır,
 *      çift gönderim — tek çağrıda, kilit altında
 *   4. bildirim e-postası arka planda (yanıtı bekletmez), çift gönderimde yok
 *
 * HTTP: RPC reddi `conflict` → 429, `validation` → 400, diğer → 500.
 */
@Injectable()
export class SiteLeadService {
  private readonly logger = new Logger(SiteLeadService.name);
  /** Arka planda süren bildirimler (kapanışta ve testlerde beklemek için). */
  readonly pending = new Set<Promise<void>>();

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly db: DbContextService,
    private readonly mail: MailService,
  ) {}

  async submit(
    rawBody: unknown,
    tooLarge: boolean,
    ipHash: string | null,
  ): Promise<SiteLeadReply> {
    try {
      if (tooLarge) return err(413, 'validation', 'İstek çok büyük.');

      let body: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(
          typeof rawBody === 'string' ? rawBody : '',
        );
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw new Error('nesne değil');
        }
        body = parsed as Record<string, unknown>;
      } catch {
        return err(400, 'validation', 'İstek okunamadı.');
      }

      // 1. Bot: başarılı görünür, hiçbir şey yazılmaz — script neyin
      //    yakalandığını öğrenmesin.
      if (looksLikeBot(body)) {
        this.logger.warn('Bot olarak elendi (bal küpü ya da hız).');
        return ok();
      }

      // 2. Doğrulama
      const validation = validateSiteLead(body);
      if (!validation.ok) return err(400, 'validation', validation.message);
      const { lead } = validation;

      // 3. Sınırlar ve kayıt — RPC'de, tek çağrıda.
      let result: Envelope;
      try {
        result = await this.db.withRole('service_role', (c) =>
          submitLead(c, lead, ipHash),
        );
      } catch (error) {
        this.logger.error({ err: (error as Error).message }, 'RPC hatası');
        return err(500, 'internal', 'Talep kaydedilemedi.');
      }
      if (!result.success) {
        const code = result.code ?? 'internal';
        const status =
          code === 'conflict' ? 429 : code === 'validation' ? 400 : 500;
        return err(status, code, result.message ?? 'Talep kaydedilemedi.');
      }

      // 4. Bildirim — yanıtı bekletmez; çift gönderimde tekrar gitmez.
      const data = result.data as { id?: string; duplicate?: boolean } | null;
      if (!data?.duplicate) this.notifyInBackground(lead, data?.id ?? '?');

      return ok();
    } catch (error) {
      this.logger.error({ err: error }, 'Beklenmeyen hata');
      return err(500, 'internal', 'Beklenmeyen bir hata oluştu.');
    }
  }

  private notifyInBackground(lead: SiteLead, id: string): void {
    const to = this.config.SITE_LEAD_NOTIFY_TO;
    if (!to || !this.mail.hasMailbox('public')) {
      this.logger.warn(
        'Bildirim e-postası atlandı: SITE_LEAD_NOTIFY_TO ya da SMTP_*_PUBLIC tanımlı değil.',
      );
      return;
    }
    const subject = `${lead.kind === 'demo' ? 'Demo talebi' : 'Site mesajı'}: ${lead.full_name}`;
    const send = this.mail
      .sendPlain('public', {
        to,
        subject,
        text: notificationText(lead, id),
        replyTo: lead.email,
      })
      .catch((error: unknown) => {
        this.logger.error(
          { err: (error as Error).message },
          'Bildirim e-postası gönderilemedi',
        );
      })
      .finally(() => this.pending.delete(send));
    this.pending.add(send);
  }
}

/** `admin.rpc('submit_site_lead', {...})` (service_role). */
async function submitLead(
  c: PoolClient,
  lead: SiteLead,
  ipHash: string | null,
): Promise<Envelope> {
  const { rows } = await c.query<{ r: Envelope | null }>(
    `select public.submit_site_lead(
              p_kind => $1::text, p_full_name => $2::text, p_phone => $3::text,
              p_email => $4::text, p_school_name => $5::text, p_city => $6::text,
              p_athlete_count => $7::text, p_message => $8::text,
              p_source_page => $9::text, p_utm_source => $10::text,
              p_utm_medium => $11::text, p_utm_campaign => $12::text,
              p_ip_hash => $13::text) as r`,
    [
      lead.kind,
      lead.full_name,
      lead.phone,
      lead.email,
      lead.school_name,
      lead.city,
      lead.athlete_count,
      lead.message,
      lead.source_page,
      lead.utm_source,
      lead.utm_medium,
      lead.utm_campaign,
      ipHash,
    ],
  );
  return rows[0].r ?? {};
}
