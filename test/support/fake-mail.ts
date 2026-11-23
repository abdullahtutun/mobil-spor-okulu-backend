import type { Brand } from '../../src/mail/brand';
import type {
  Mailbox,
  MailMessage,
  MailTransport,
  MailTransportFactory,
} from '../../src/mail/mail.service';

export interface SentMail {
  brand: Brand;
  mailbox: Mailbox;
  message: MailMessage;
}

/**
 * Testlerin posta kutusu: gerçek SMTP yerine gönderilenleri bellekte tutar
 * (`createTestApp` her uygulamaya bunu takar). `failNext` bir sonraki
 * gönderimi SMTP reddi gibi düşürür.
 */
export class FakeMailbox implements MailTransportFactory {
  readonly sent: SentMail[] = [];
  private failures = 0;
  private waiters: (() => void)[] = [];

  create(brand: Brand, mailbox: Mailbox): MailTransport {
    return {
      sendMail: (message: MailMessage) => {
        if (this.failures > 0) {
          this.failures -= 1;
          return Promise.reject(new Error('550 sahte SMTP reddi'));
        }
        this.sent.push({ brand, mailbox, message });
        const waiters = this.waiters;
        this.waiters = [];
        waiters.forEach((w) => w());
        return Promise.resolve({ messageId: `<${this.sent.length}@fake>` });
      },
    };
  }

  failNext(count = 1): void {
    this.failures += count;
  }

  /** `to` adresine giden e-postalar (en yeni sonda). */
  to(address: string): SentMail[] {
    return this.sent.filter((m) => m.message.to === address);
  }

  /** `to` adresine en az `count` e-posta gidene kadar bekler (gönderim yanıttan sonra). */
  async waitFor(
    address: string,
    count = 1,
    timeoutMs = 3000,
  ): Promise<SentMail> {
    const deadline = Date.now() + timeoutMs;
    while (this.to(address).length < count) {
      if (Date.now() > deadline) {
        throw new Error(`${address} adresine ${count}. e-posta gelmedi`);
      }
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve);
        setTimeout(resolve, 50);
      });
    }
    return this.to(address)[count - 1];
  }

  /** Gönderilmesi beklenmeyen e-postanın gitmediğini görmek için biraz bekler. */
  async settle(ms = 150): Promise<void> {
    await new Promise((r) => setTimeout(r, ms));
  }
}

/** E-postadaki 6 haneli kod. */
export function codeOf(mail: SentMail): string {
  const m = /\n(\d{6})\n/.exec(mail.message.text);
  if (!m) throw new Error('E-postada kod yok');
  return m[1];
}

/** Davet e-postasındaki şifre sayfası bağlantısı. */
export function inviteLinkOf(mail: SentMail): URL {
  const m = /Şifremi oluştur: (\S+)/.exec(mail.message.text);
  if (!m) throw new Error('E-postada davet bağlantısı yok');
  return new URL(m[1]);
}
