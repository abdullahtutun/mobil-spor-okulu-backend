import {
  looksLikeBot,
  normalizeMobilePhone,
  notificationText,
  validateSiteLead,
} from './site-lead.validation';

// Yönetim reposu `supabase/functions/site-lead/validation_test.ts`'in
// karşılığı (aynı durumlar). Gövde sitenin gönderdiği
// (`../mobil_spor_okulu_site`, edge-function-lead-gateway.ts → toRequestBody).
const demo = {
  kind: 'demo',
  full_name: '  Ayşe   Yılmaz ',
  phone: '5321234567',
  email: null,
  school_name: 'Yıldızlar Spor Okulu',
  city: null,
  athlete_count: '51-150',
  message: null,
  privacy_notice_ack: true,
  source_page: '/demo/',
  utm_source: 'instagram',
  utm_medium: null,
  utm_campaign: 'ekim',
  website: '',
  elapsed_ms: 8124,
};

describe('site-lead doğrulaması', () => {
  it('sitenin gövdesini kabul edip normalize eder', () => {
    const result = validateSiteLead(demo);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.lead.full_name).toBe('Ayşe Yılmaz');
    expect(result.lead.phone).toBe('5321234567');
    expect(result.lead.email).toBeNull();
    expect(result.lead.utm_source).toBe('instagram');
  });

  it('telefon uygulamalarla aynı biçime iner', () => {
    expect(normalizeMobilePhone('0532 123 45 67')).toBe('5321234567');
    expect(normalizeMobilePhone('+90 532 123 45 67')).toBe('5321234567');
    expect(normalizeMobilePhone('0212 123 45 67')).toBeNull();
    expect(normalizeMobilePhone(5321234567)).toBeNull();
  });

  it('demo: okul ve sporcu sayısı; iletişim: mesaj zorunlu', () => {
    expect(validateSiteLead({ ...demo, school_name: '' }).ok).toBe(false);
    expect(validateSiteLead({ ...demo, athlete_count: null }).ok).toBe(false);
    expect(validateSiteLead({ ...demo, athlete_count: '1000' }).ok).toBe(false);
    const contact = {
      ...demo,
      kind: 'contact',
      school_name: null,
      athlete_count: null,
    };
    expect(validateSiteLead(contact).ok).toBe(false);
    expect(
      validateSiteLead({
        ...contact,
        message: 'Fiyat bilgisi almak istiyorum.',
      }).ok,
    ).toBe(true);
    expect(validateSiteLead({ ...contact, message: 'kısa' }).ok).toBe(false);
  });

  it('aydınlatma onayı yoksa reddeder', () => {
    expect(validateSiteLead({ ...demo, privacy_notice_ack: 'true' })).toEqual({
      ok: false,
      message: 'Aydınlatma metninin okunduğu onaylanmalı.',
    });
  });

  it('bilinmeyen tür ve geçersiz e-posta', () => {
    expect(validateSiteLead({ ...demo, kind: 'spam' }).ok).toBe(false);
    expect(validateSiteLead({ ...demo, email: 'ayse@' }).ok).toBe(false);
  });

  it('bot: bal küpü dolu ya da çok hızlı', () => {
    expect(looksLikeBot(demo)).toBe(false);
    expect(looksLikeBot({ ...demo, website: 'http://spam' })).toBe(true);
    expect(looksLikeBot({ ...demo, elapsed_ms: 900 })).toBe(true);
    // Süre gelmediyse (eski istemci) bot sayılmaz.
    expect(looksLikeBot({ ...demo, elapsed_ms: undefined })).toBe(false);
  });

  it('bildirim metni telefonu okunur biçimde yazar, boş alanları atlar', () => {
    const result = validateSiteLead(demo);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const text = notificationText(result.lead, 'abc');
    expect(text).toMatch(/Telefon: 0532 123 45 67/);
    expect(text).toMatch(/Kampanya: instagram \/ ekim/);
    expect(text).not.toMatch(/E-posta:/);
  });
});
