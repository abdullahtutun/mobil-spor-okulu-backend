import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import nodemailer from 'nodemailer';
import { APP_CONFIG } from '../config/config.module';
import type { AppConfig } from '../config/env.schema';
import { BRAND_LOGOS_PNG_BASE64 } from './brand-logos';
import { type Brand, BRANDS } from './brand';
import { BRAND_PROFILES, LOGO_CID, renderEmail } from './email-content';

/** Gönderilecek bir e-posta (nodemailer'ın `sendMail` seçeneklerinin alt kümesi). */
export interface MailMessage {
  from: { name: string; address: string };
  to: string;
  replyTo?: string;
  subject: string;
  /** Düz metin e-postada (site talebi bildirimi) yok. */
  html?: string;
  text: string;
  attachments?: {
    filename: string;
    content: string;
    encoding: 'base64';
    contentType: string;
    cid: string;
    contentDisposition: 'inline';
  }[];
}

export interface MailTransport {
  sendMail(message: MailMessage): Promise<unknown>;
}

export interface Mailbox {
  host: string;
  port: number;
  user: string;
  pass: string;
}

/**
 * Marka başına SMTP bağlantısı kurar. Testler bunu sahte bir kutuyla
 * değiştirir (`test/support/fake-mail.ts`): testler hiçbir zaman gerçek
 * SMTP'ye gitmez.
 */
export interface MailTransportFactory {
  create(brand: Brand, mailbox: Mailbox): MailTransport;
}

export const MAIL_TRANSPORT_FACTORY = Symbol('MAIL_TRANSPORT_FACTORY');

/** Gerçek SMTP (nodemailer). 465 → SMTPS, diğer portlar STARTTLS. */
export const smtpTransportFactory: MailTransportFactory = {
  create: (_brand, mailbox) =>
    nodemailer.createTransport({
      host: mailbox.host,
      port: mailbox.port,
      secure: mailbox.port === 465,
      auth: { user: mailbox.user, pass: mailbox.pass },
      // Bir SMTP takılması isteği (ve davet eden yöneticiyi) dakikalarca
      // bekletmesin.
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
    }),
};

/** Markanın posta kutusu tanımlı değil — e-posta gitmez (bugünkü kural). */
export class MailboxNotConfiguredError extends Error {
  constructor(readonly brand: Brand) {
    const suffix = brand === 'dev_adim' ? 'DEV_ADIM' : 'PUBLIC';
    super(
      `${brand} markasının posta kutusu tanımlı değil (SMTP_USER_${suffix} / SMTP_PASS_${suffix}).`,
    );
    this.name = 'MailboxNotConfiguredError';
  }
}

/** Auth e-postasının türü: GoTrue'nun `email_action_type`'ı. */
export type AuthEmailType = 'invite' | 'recovery' | 'signup';

export interface AuthEmail {
  brand: Brand;
  type: AuthEmailType;
  to: string;
  /** `user_metadata.name` ya da `full_name`. */
  name?: string;
  /** 6 haneli kod (recovery, signup). */
  token?: string;
  /** Davet bağlantısının token'ı (invite). */
  tokenHash?: string;
  /** Davet bağlantısının sayfası: `passwordSetupUrl(brand)`. */
  redirectTo?: string;
}

/**
 * Yönetim reposundaki `send-email` hook'unun karşılığı: auth e-postalarını
 * markanın metniyle ve **markanın kendi posta kutusundan** gönderir.
 * Gönderen adresi kodda değil, yalnızca `SMTP_USER_*` ortam değişkenlerinde.
 * Bir markanın kutusu yoksa gönderilmez ve `MailboxNotConfiguredError`;
 * öbür markanın adresine düşmek yok.
 */
@Injectable()
export class MailService implements OnModuleInit {
  private readonly logger = new Logger(MailService.name);
  private readonly transports = new Map<Brand, MailTransport>();

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(MAIL_TRANSPORT_FACTORY)
    private readonly factory: MailTransportFactory,
  ) {}

  onModuleInit(): void {
    for (const brand of BRANDS) {
      if (!this.mailbox(brand)) {
        this.logger.warn(
          { brand },
          'Markanın posta kutusu tanımlı değil; bu markanın auth e-postaları gitmeyecek',
        );
      }
    }
  }

  /** Markanın kutusu tanımlı mı; değilse fırlatır (yazmadan önce sormak için). */
  assertMailbox(brand: Brand): void {
    if (!this.mailbox(brand)) throw new MailboxNotConfiguredError(brand);
  }

  async sendAuthEmail(email: AuthEmail): Promise<void> {
    const mailbox = this.mailbox(email.brand);
    if (!mailbox) throw new MailboxNotConfiguredError(email.brand);

    const rendered = renderEmail({
      brand: email.brand,
      actionType: email.type,
      name: email.name,
      token: email.token ?? '',
      tokenHash: email.tokenHash ?? '',
      redirectTo: email.redirectTo ?? '',
    });
    if (!rendered)
      throw new Error(`Desteklenmeyen e-posta türü: ${email.type}`);

    await this.transport(email.brand, mailbox).sendMail({
      from: { name: BRAND_PROFILES[email.brand].name, address: mailbox.user },
      to: email.to,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
      // Logo ek olarak gömülü (cid:), web sitesinden çekilmez.
      attachments: [
        {
          filename: 'logo.png',
          content: BRAND_LOGOS_PNG_BASE64[email.brand],
          encoding: 'base64',
          contentType: 'image/png',
          cid: LOGO_CID,
          contentDisposition: 'inline',
        },
      ],
    });
    // Adres ve token loglanmaz; tür ve marka yeter.
    this.logger.log(
      { type: email.type, brand: email.brand },
      'Auth e-postası gönderildi',
    );
  }

  /** Markanın kutusu tanımlı mı (sormak için; fırlatmaz). */
  hasMailbox(brand: Brand): boolean {
    return this.mailbox(brand) !== null;
  }

  /**
   * Markanın kutusundan düz metin e-posta (S10: site talebi bildirimi;
   * ex `site-lead`'in `notify`'ı). Kutu yoksa `MailboxNotConfiguredError`.
   */
  async sendPlain(
    brand: Brand,
    mail: {
      to: string;
      subject: string;
      text: string;
      replyTo?: string | null;
    },
  ): Promise<void> {
    const mailbox = this.mailbox(brand);
    if (!mailbox) throw new MailboxNotConfiguredError(brand);
    await this.transport(brand, mailbox).sendMail({
      from: { name: BRAND_PROFILES[brand].name, address: mailbox.user },
      to: mail.to,
      ...(mail.replyTo ? { replyTo: mail.replyTo } : {}),
      subject: mail.subject,
      text: mail.text,
    });
  }

  private mailbox(brand: Brand): Mailbox | null {
    const user =
      brand === 'dev_adim'
        ? this.config.SMTP_USER_DEV_ADIM
        : this.config.SMTP_USER_PUBLIC;
    const pass =
      brand === 'dev_adim'
        ? this.config.SMTP_PASS_DEV_ADIM
        : this.config.SMTP_PASS_PUBLIC;
    if (!user || !pass) return null;
    return {
      host: this.config.SMTP_HOST,
      port: this.config.SMTP_PORT,
      user,
      pass,
    };
  }

  private transport(brand: Brand, mailbox: Mailbox): MailTransport {
    let transport = this.transports.get(brand);
    if (!transport) {
      transport = this.factory.create(brand, mailbox);
      this.transports.set(brand, transport);
    }
    return transport;
  }
}
