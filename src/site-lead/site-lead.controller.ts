import { All, Controller, Inject, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { bodyTooLarge } from '../common/http/raw-text-body';
import { IpHasher } from '../common/http/ip-hash';
import { APP_CONFIG } from '../config/config.module';
import type { AppConfig } from '../config/env.schema';
import { SiteLeadService } from './site-lead.service';

/**
 * `POST /functions/site-lead` — ex `site-lead` (Supabase'te
 * `--no-verify-jwt`: site anahtar göndermez, başlık istenmez). Kendi
 * CORS'u var (Edge Function'daki gibi yalnızca `SITE_ALLOWED_ORIGINS`;
 * genel CORS bu yolu atlar, `app.setup.ts`). CORS bir güvenlik sınırı
 * değildir (curl'ü durdurmaz); başka sitelerin formu gömmesini zorlaştırır.
 */
@Controller('functions')
export class SiteLeadController {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly service: SiteLeadService,
    private readonly ip: IpHasher,
  ) {}

  @All('site-lead')
  async handle(@Req() req: Request, @Res() res: Response): Promise<void> {
    res.set(this.corsHeaders(req));
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    if (req.method !== 'POST') {
      res.status(405).json({
        success: false,
        code: 'validation',
        message: 'POST bekleniyor.',
        data: null,
        error: 'POST bekleniyor.',
      });
      return;
    }
    const ip = this.ip.clientIp(req);
    const reply = await this.service.submit(
      req.body,
      bodyTooLarge(req),
      ip ? this.ip.hash(ip) : null,
    );
    res.status(reply.status).json(reply.body);
  }

  private corsHeaders(req: Request): Record<string, string> {
    const origin = req.headers.origin ?? '';
    return {
      ...(this.config.SITE_ALLOWED_ORIGINS.includes(origin)
        ? { 'Access-Control-Allow-Origin': origin }
        : {}),
      'Access-Control-Allow-Headers': 'content-type',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Max-Age': '86400',
      Vary: 'Origin',
    };
  }
}
