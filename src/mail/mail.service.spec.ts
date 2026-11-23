import nodemailer from 'nodemailer';
import type { AppConfig } from '../config/env.schema';
import type { Brand } from './brand';
import {
  type Mailbox,
  MailboxNotConfiguredError,
  type MailMessage,
  MailService,
  type MailTransportFactory,
} from './mail.service';

function service(overrides: Partial<AppConfig> = {}) {
  const created: { brand: Brand; mailbox: Mailbox }[] = [];
  const sent: MailMessage[] = [];
  const factory: MailTransportFactory = {
    create: (brand, mailbox) => {
      created.push({ brand, mailbox });
      return {
        sendMail: (m) => {
          sent.push(m);
          return Promise.resolve();
        },
      };
    },
  };
  const config = {
    SMTP_HOST: 'smtp.example.test',
    SMTP_PORT: 465,
    SMTP_USER_DEV_ADIM: 'gonder@devadim.test',
    SMTP_PASS_DEV_ADIM: 'p1',
    SMTP_USER_PUBLIC: 'noreply@msp.test',
    SMTP_PASS_PUBLIC: 'p2',
    ...overrides,
  } as AppConfig;
  return { mail: new MailService(config, factory), created, sent };
}

describe('MailService', () => {
  it('her marka kendi kutusundan gönderir; bağlantı marka başına bir kez kurulur', async () => {
    const { mail, created, sent } = service();
    await mail.sendAuthEmail({
      brand: 'dev_adim',
      type: 'recovery',
      to: 'a@x.test',
      token: '123456',
    });
    await mail.sendAuthEmail({
      brand: 'dev_adim',
      type: 'recovery',
      to: 'b@x.test',
      token: '123456',
    });
    await mail.sendAuthEmail({
      brand: 'public',
      type: 'signup',
      to: 'c@x.test',
      token: '654321',
    });
    expect(
      created.map((c) => [c.brand, c.mailbox.user, c.mailbox.pass]),
    ).toEqual([
      ['dev_adim', 'gonder@devadim.test', 'p1'],
      ['public', 'noreply@msp.test', 'p2'],
    ]);
    expect(sent.map((m) => m.from)).toEqual([
      { name: 'Dev Adım Yönetim', address: 'gonder@devadim.test' },
      { name: 'Dev Adım Yönetim', address: 'gonder@devadim.test' },
      { name: 'Mobil Spor Okulu', address: 'noreply@msp.test' },
    ]);
    expect(sent[2].text).toContain('654321');
  });

  it('kutusu olmayan marka: gönderilmez, öbür markanın kutusuna düşmez', async () => {
    const { mail, created, sent } = service({ SMTP_PASS_PUBLIC: '' });
    expect(() => mail.assertMailbox('public')).toThrow(
      MailboxNotConfiguredError,
    );
    expect(() => mail.assertMailbox('dev_adim')).not.toThrow();
    await expect(
      mail.sendAuthEmail({
        brand: 'public',
        type: 'recovery',
        to: 'a@x.test',
        token: '1',
      }),
    ).rejects.toThrow(/SMTP_USER_PUBLIC \/ SMTP_PASS_PUBLIC/);
    expect(created).toHaveLength(0);
    expect(sent).toHaveLength(0);
  });

  it('desteklenmeyen tür hata verir', async () => {
    const { mail } = service();
    await expect(
      mail.sendAuthEmail({
        brand: 'public',
        type: 'email_change' as never,
        to: 'a@x.test',
      }),
    ).rejects.toThrow(/Desteklenmeyen/);
  });

  it('nodemailer mesajı kurar: gönderen, konu, gömülü logo (jsonTransport)', async () => {
    const { mail, sent } = service();
    await mail.sendAuthEmail({
      brand: 'dev_adim',
      type: 'invite',
      to: 'veli@x.test',
      name: 'Veli',
      tokenHash: 'abc',
      redirectTo: 'https://mobil.devadim.com/sifre-olusturma/',
    });
    const info = (await nodemailer
      .createTransport({ jsonTransport: true })
      .sendMail(sent[0])) as { message: string };
    const json = JSON.parse(info.message) as {
      from: { address: string; name: string };
      subject: string;
      attachments: { cid: string; contentType: string }[];
    };
    expect(json.from).toEqual({
      address: 'gonder@devadim.test',
      name: 'Dev Adım Yönetim',
    });
    expect(json.subject).toBe('Dev Adım Veli — şifrenizi oluşturun');
    expect(json.attachments[0]).toMatchObject({
      cid: 'brand-logo',
      contentType: 'image/png',
    });
  });
});
