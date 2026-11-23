// Yönetim reposunun supabase/functions/send-email/email_content.ts'inin
// birebir taşınmış hâli (2026-11-23; yalnızca import yolu ve biçim farklı).
// Supabase'te Send Email Hook açık: bugün velinin ve okulun aldığı e-postalar
// supabase/templates/*.html'den değil, bu fonksiyondan çıkıyor. Metin
// değişirse iki repoda birlikte değişmeli.
//
// Send Email Hook'un içeriği: hangi markayla, hangi metinle. Saf fonksiyonlar —
// ağ yok, ortam değişkeni yok — `node --experimental-strip-types --test` ya da
// `deno test` ile sınanır (email_content_test.ts).
//
// Supabase'in kendi şablonları proje başına tek ve tek gönderen adresi var;
// hook, e-postayı velinin okulunun markasıyla ve o markanın adresinden
// göndermek için var (AGENTS.md → Brands).
import type { Brand } from './brand';

/// Başlıktaki logonun e-postaya gömülü ekinin kimliği (`cid:`). Logo web
/// sitesinden çekilmez: alan adı taşınırken ya da SSL kurulurken kırık
/// görünüyordu. Ekin kendisini index.ts ekler (brand_logos.ts).
export const LOGO_CID = 'brand-logo';

interface BrandProfile {
  /// "From" adı, e-postanın üst başlığı ve kod e-postalarının konusu.
  name: string;
  /// Veli uygulamasının adı — davet e-postası veliye gider.
  parentApp: string;
  primary: string;
  accent: string;
}

export const BRAND_PROFILES: Record<Brand, BrandProfile> = {
  dev_adim: {
    name: 'Dev Adım Yönetim',
    parentApp: 'Dev Adım Veli',
    primary: '#1B3A6B',
    accent: '#F2E33B',
  },
  public: {
    name: 'Mobil Spor Okulu',
    parentApp: 'Mobil Spor Okulu Veli',
    primary: '#14284B',
    accent: '#F26A21',
  },
};

/// `user_metadata.brand` → marka. Değeri okulun markasından veritabanı
/// tetikleyicisi (sync_user_brand) ya da davet eden Edge Function yazar.
/// Yoksa (ör. henüz okulu olmayan yeni kayıt) public — `schools.brand`'in
/// varsayılanıyla aynı.
export const brandOf = (userMetadata: unknown): Brand =>
  (userMetadata as Record<string, unknown> | null)?.brand === 'dev_adim'
    ? 'dev_adim'
    : 'public';

export interface EmailInput {
  brand: Brand;
  /// GoTrue'nun `email_action_type`'ı.
  actionType: string;
  /// `user_metadata.name` (davet) ya da `full_name` (kayıt).
  name?: string;
  token: string;
  tokenHash: string;
  redirectTo: string;
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

const escapeHtml = (s: string) =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/// Davet bağlantısı: token sayfada, "Kaydet"e basınca doğrulanır
/// (AGENTS.md → Set-password page). `redirectTo` okulun alan adındaki şifre
/// sayfası; GoTrue onu Redirect URLs listesine karşı zaten doğruladı.
export const inviteLink = (redirectTo: string, tokenHash: string) =>
  `${redirectTo}${redirectTo.includes('?') ? '&' : '?'}token_hash=${encodeURIComponent(tokenHash)}&type=invite`;

interface Body {
  subject: string;
  heading: string;
  paragraphs: string[];
  code?: string;
  button?: { label: string; url: string };
  footnote: string;
}

const layout = (brand: Brand, b: Body): RenderedEmail => {
  const p = BRAND_PROFILES[brand];
  const html = `<!doctype html>
<html lang="tr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head>
<body style="margin:0;background:#f4f5f7;font-family:Arial,Helvetica,sans-serif;color:#1f2933">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f7;padding:24px 12px">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border-radius:12px;overflow:hidden">
<tr><td style="background:${p.primary};padding:20px 24px;border-bottom:4px solid ${p.accent}">
<span style="display:inline-block;vertical-align:middle;background:#ffffff;border-radius:10px;padding:4px;line-height:0"><img src="cid:${LOGO_CID}" width="40" height="40" alt="${escapeHtml(p.name)}" style="display:block;border:0"></span>
<span style="color:#ffffff;font-size:18px;font-weight:bold;vertical-align:middle;margin-left:10px">${escapeHtml(p.name)}</span>
</td></tr>
<tr><td style="padding:28px 24px">
<h1 style="margin:0 0 16px;font-size:20px;color:${p.primary}">${escapeHtml(b.heading)}</h1>
${b.paragraphs.map((t) => `<p style="margin:0 0 14px;font-size:15px;line-height:1.5">${t}</p>`).join('\n')}
${b.code ? `<p style="margin:20px 0;font-size:30px;font-weight:bold;letter-spacing:6px;color:${p.primary}">${escapeHtml(b.code)}</p>` : ''}
${
  b.button
    ? `<p style="margin:24px 0"><a href="${escapeHtml(b.button.url)}" style="background:${p.primary};color:#ffffff;text-decoration:none;padding:12px 22px;border-radius:8px;font-weight:bold;display:inline-block">${escapeHtml(b.button.label)}</a></p>
<p style="margin:0 0 14px;font-size:12px;color:#6b7280;word-break:break-all">Düğme çalışmazsa bu adresi tarayıcınıza yapıştırın:<br>${escapeHtml(b.button.url)}</p>`
    : ''
}
<p style="margin:20px 0 0;font-size:13px;color:#6b7280">${b.footnote}</p>
</td></tr>
</table>
</td></tr>
</table>
</body></html>`;

  const strip = (s: string) =>
    s
      .replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"');
  const text = [
    p.name,
    '',
    b.heading,
    '',
    ...b.paragraphs.map(strip),
    ...(b.code ? ['', b.code] : []),
    ...(b.button ? ['', `${b.button.label}: ${b.button.url}`] : []),
    '',
    strip(b.footnote),
  ].join('\n');

  return { subject: b.subject, html, text };
};

const IGNORE =
  'Bu işlemi siz başlatmadıysanız bu e-postayı dikkate almayabilirsiniz.';

/// E-postanın konusu ve gövdesi; desteklenmeyen tür için `null`.
///
/// Uygulamaların kullandığı türler: davet (velinin ilk şifresi), şifre
/// sıfırlama kodu (iki uygulama), kayıt doğrulama kodu (public açık kayıt).
/// Kodla giriş ve yeniden doğrulama aynı kod e-postasını alır. E-posta
/// değişikliği hiçbir uygulamada yok; hook onu reddeder ki biri açarsa
/// sessizce yanlış e-posta gitmesin, hata görünsün.
export function renderEmail(input: EmailInput): RenderedEmail | null {
  const p = BRAND_PROFILES[input.brand];
  const hello = input.name ? `Merhaba ${escapeHtml(input.name)},` : 'Merhaba,';

  switch (input.actionType) {
    case 'invite':
      return layout(input.brand, {
        subject: `${p.parentApp} — şifrenizi oluşturun`,
        heading: 'Şifrenizi oluşturun',
        paragraphs: [
          hello,
          `Çocuğunuzun okulu sizin için bir <strong>${escapeHtml(p.parentApp)}</strong> hesabı açtı. Uygulamaya giriş yapabilmek için önce şifrenizi oluşturmanız gerekiyor.`,
        ],
        button: {
          label: 'Şifremi oluştur',
          url: inviteLink(input.redirectTo, input.tokenHash),
        },
        footnote: `Bağlantı 24 saat geçerlidir. Bu e-postayı beklemiyorsanız dikkate almayabilirsiniz.`,
      });
    case 'recovery':
      return layout(input.brand, {
        subject: `${p.name} — şifre sıfırlama kodu`,
        heading: 'Şifre sıfırlama kodunuz',
        paragraphs: [
          hello,
          'Uygulamada şifrenizi sıfırlamak için bu kodu girin:',
        ],
        code: input.token,
        footnote: `Kod 10 dakika geçerlidir. ${IGNORE}`,
      });
    case 'signup':
      return layout(input.brand, {
        subject: `${p.name} — e-posta doğrulama kodu`,
        heading: 'E-posta adresinizi doğrulayın',
        paragraphs: [
          hello,
          `${escapeHtml(p.name)} kaydınızı tamamlamak için bu kodu girin:`,
        ],
        code: input.token,
        footnote: `Kod 10 dakika geçerlidir. ${IGNORE}`,
      });
    case 'magiclink':
    case 'email':
    case 'reauthentication':
      return layout(input.brand, {
        subject: `${p.name} — doğrulama kodu`,
        heading: 'Doğrulama kodunuz',
        paragraphs: [hello, 'İşleminize devam etmek için bu kodu girin:'],
        code: input.token,
        footnote: `Kod 10 dakika geçerlidir. ${IGNORE}`,
      });
    default:
      return null;
  }
}
