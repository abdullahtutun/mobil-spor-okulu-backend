// Yönetim reposundaki supabase/functions/send-email/email_content_test.ts'in
// karşılığı (aynı iddialar): taşınan metnin davranışı değişmedi.
import { BRAND_LOGOS_PNG_BASE64 } from './brand-logos';
import { brandOf, inviteLink, renderEmail } from './email-content';

const base = {
  token: '123456',
  tokenHash: 'hash+/=',
  redirectTo: 'https://mobil.devadim.com/sifre-olusturma/',
};

describe('email-content (send-email hook’unun içeriği)', () => {
  it("marka user_metadata.brand'den; yoksa public", () => {
    expect(brandOf({ brand: 'dev_adim' })).toBe('dev_adim');
    expect(brandOf({ brand: 'public' })).toBe('public');
    expect(brandOf({})).toBe('public');
    expect(brandOf(null)).toBe('public');
    expect(brandOf({ brand: 'başka' })).toBe('public');
  });

  it('davet: markanın veli uygulaması ve şifre sayfası bağlantısı', () => {
    const dev = renderEmail({
      ...base,
      brand: 'dev_adim',
      actionType: 'invite',
      name: 'Ayşe',
    })!;
    expect(dev.subject).toMatch(/^Dev Adım Veli/);
    expect(dev.html).toContain('>Dev Adım Yönetim</span>');
    expect(dev.html).toContain('Merhaba Ayşe,');
    expect(dev.text).toContain(
      'https://mobil.devadim.com/sifre-olusturma/?token_hash=hash%2B%2F%3D&type=invite',
    );
    expect(dev.html).toContain('src="cid:brand-logo"');
    expect(dev.html).not.toContain('/icons/');

    const pub = renderEmail({
      ...base,
      brand: 'public',
      actionType: 'invite',
      redirectTo: 'https://yonetim.mobilsporokulu.com/sifre-olusturma/',
    })!;
    expect(pub.subject).toMatch(/^Mobil Spor Okulu Veli/);
    expect(pub.text).toContain(
      'https://yonetim.mobilsporokulu.com/sifre-olusturma/?token_hash=',
    );
    expect(pub.html).not.toContain('Dev Adım');
  });

  it('sıfırlama ve kayıt kodu gövdede', () => {
    const r = renderEmail({
      ...base,
      brand: 'dev_adim',
      actionType: 'recovery',
    })!;
    expect(r.subject).toMatch(/^Dev Adım Yönetim — şifre sıfırlama/);
    expect(r.text).toContain('123456');
    const s = renderEmail({
      ...base,
      brand: 'public',
      actionType: 'signup',
      name: 'Ali',
    })!;
    expect(s.subject).toMatch(/^Mobil Spor Okulu/);
    expect(s.html).toContain('123456');
  });

  it('ad HTML olarak yorumlanmaz', () => {
    const r = renderEmail({
      ...base,
      brand: 'public',
      actionType: 'invite',
      name: '<b>x</b>',
    })!;
    expect(r.html).toContain('&lt;b&gt;x&lt;/b&gt;');
    expect(r.html).not.toContain('<b>x</b>');
  });

  it('e-posta değişikliği desteklenmez — sessizce yanlış e-posta gitmez', () => {
    expect(
      renderEmail({ ...base, brand: 'public', actionType: 'email_change' }),
    ).toBeNull();
  });

  it('sorgu içeren adrese & ile eklenir', () => {
    expect(inviteLink('https://a.com/x?y=1', 't')).toBe(
      'https://a.com/x?y=1&token_hash=t&type=invite',
    );
  });

  it('her markanın gömülü logosu geçerli 96x96 PNG', () => {
    for (const [brand, b64] of Object.entries(BRAND_LOGOS_PNG_BASE64)) {
      const bytes = Buffer.from(b64, 'base64');
      expect([...bytes.subarray(0, 8)]).toEqual([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      ]);
      expect([brand, bytes.readUInt32BE(16), bytes.readUInt32BE(20)]).toEqual([
        brand,
        96,
        96,
      ]);
    }
  });
});
