// Ex `site-lead` Edge Function'ının doğrulaması: yönetim reposu
// `supabase/functions/site-lead/validation.ts`'in birebir kopyası (yalnızca
// biçim/lint farkı). Biri değişirse öbürü de değişmeli; testleri
// `site-lead.validation.spec.ts` (oradaki `validation_test.ts`'in karşılığı).
//
// Sitenin kendi doğrulaması (../mobil_spor_okulu_site, src/domain/lead/)
// kullanıcıya hatayı göndermeden göstermek içindir; asıl sınır burası ve
// site_leads tablosunun CHECK kısıtları. Üçü aynı sınırları taşır:
//
//              ad    telefon  okul  sporcu sayısı  mesaj
//   demo       ✓     ✓        ✓     ✓              –
//   contact    ✓     ✓        –     –              ✓ (10–2000)

export const ATHLETE_COUNT_RANGES = [
  '1-50',
  '51-150',
  '151-300',
  '300+',
] as const;

/** Bal küpü dolu ya da sayfa açılışından bu kadar kısa sürede gönderildiyse bot. */
export const MIN_HUMAN_ELAPSED_MS = 3000;

export interface SiteLead {
  kind: 'demo' | 'contact';
  full_name: string;
  phone: string;
  email: string | null;
  school_name: string | null;
  city: string | null;
  athlete_count: string | null;
  message: string | null;
  source_page: string | null;
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
}

export type Validation =
  { ok: true; lead: SiteLead } | { ok: false; message: string };

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

const str = (value: unknown): string =>
  typeof value === 'string' ? value : '';
const clean = (value: unknown): string =>
  str(value).replace(/\s+/g, ' ').trim();
const optional = (value: unknown, max: number): string | null => {
  const text = clean(value).slice(0, max);
  return text === '' ? null : text;
};

/** Uygulamaların `PhoneNumber.toStorage` kuralı: 5XXXXXXXXX ya da null. */
export function normalizeMobilePhone(raw: unknown): string | null {
  let digits = str(raw).replace(/\D/g, '');
  if (digits.length === 12 && digits.startsWith('90')) digits = digits.slice(2);
  if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1);
  return /^5\d{9}$/.test(digits) ? digits : null;
}

/** Bal küpü ya da insan için imkânsız hız. */
export function looksLikeBot(body: Record<string, unknown>): boolean {
  if (clean(body.website) !== '') return true;
  const elapsed = Number(body.elapsed_ms);
  return Number.isFinite(elapsed) && elapsed < MIN_HUMAN_ELAPSED_MS;
}

export function validateSiteLead(body: Record<string, unknown>): Validation {
  const kind = body.kind;
  if (kind !== 'demo' && kind !== 'contact')
    return { ok: false, message: 'Talep türü geçersiz.' };

  if (body.privacy_notice_ack !== true) {
    return { ok: false, message: 'Aydınlatma metninin okunduğu onaylanmalı.' };
  }

  const fullName = clean(body.full_name);
  if (fullName.length < 2 || fullName.length > 100)
    return { ok: false, message: 'Ad soyad geçersiz.' };

  const phone = normalizeMobilePhone(body.phone);
  if (!phone) return { ok: false, message: 'Geçerli bir cep telefonu girin.' };

  const email = clean(body.email).toLowerCase();
  if (email && (email.length > 254 || !EMAIL.test(email))) {
    return { ok: false, message: 'Geçerli bir e-posta adresi girin.' };
  }

  const schoolName = clean(body.school_name);
  if (schoolName.length > 120)
    return { ok: false, message: 'Okul adı çok uzun.' };
  if (kind === 'demo' && !schoolName)
    return { ok: false, message: 'Okul adı gerekli.' };

  const city = clean(body.city);
  if (city.length > 60) return { ok: false, message: 'Şehir çok uzun.' };

  const athleteCount = clean(body.athlete_count);
  if (
    athleteCount &&
    !(ATHLETE_COUNT_RANGES as readonly string[]).includes(athleteCount)
  ) {
    return { ok: false, message: 'Sporcu sayısı geçersiz.' };
  }
  if (kind === 'demo' && !athleteCount)
    return { ok: false, message: 'Sporcu sayısı gerekli.' };

  const message = str(body.message).trim();
  if (kind === 'contact' && !message)
    return { ok: false, message: 'Mesaj gerekli.' };
  if (message && (message.length < 10 || message.length > 2000)) {
    return {
      ok: false,
      message: 'Mesaj 10 ile 2000 karakter arasında olmalı.',
    };
  }

  return {
    ok: true,
    lead: {
      kind,
      full_name: fullName,
      phone,
      email: email || null,
      school_name: schoolName || null,
      city: city || null,
      athlete_count: athleteCount || null,
      message: message || null,
      source_page: optional(body.source_page, 200),
      utm_source: optional(body.utm_source, 100),
      utm_medium: optional(body.utm_medium, 100),
      utm_campaign: optional(body.utm_campaign, 100),
    },
  };
}

/** Bildirim e-postasının düz metni. */
export function notificationText(lead: SiteLead, id: string): string {
  const phone = `0${lead.phone.slice(0, 3)} ${lead.phone.slice(3, 6)} ${lead.phone.slice(6, 8)} ${lead.phone.slice(8)}`;
  const rows: [string, string | null][] = [
    ['Tür', lead.kind === 'demo' ? 'Demo talebi' : 'İletişim'],
    ['Ad soyad', lead.full_name],
    ['Telefon', phone],
    ['E-posta', lead.email],
    ['Okul', lead.school_name],
    ['Şehir', lead.city],
    ['Sporcu sayısı', lead.athlete_count],
    ['Sayfa', lead.source_page],
    [
      'Kampanya',
      [lead.utm_source, lead.utm_medium, lead.utm_campaign]
        .filter(Boolean)
        .join(' / ') || null,
    ],
  ];
  const lines = rows
    .filter(([, value]) => value)
    .map(([label, value]) => `${label}: ${value}`);
  if (lead.message) lines.push('', 'Mesaj:', lead.message);
  lines.push('', `Kayıt: site_leads / ${id}`);
  return lines.join('\n');
}
