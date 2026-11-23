// Okulun markası ve markanın web adresleri. Yönetim reposunun
// `supabase/functions/_shared/brand.ts`'iyle (ve Dart'ta
// `lib/core/config/school_brand.dart`) aynı tablo: davet bağlantısının alan
// adını gönderen uygulama değil, velinin okulunun markası belirler
// (yönetim AGENTS.md → "Brands"). Biri değişirse öbürleri de değişmeli;
// `src/mail/brand.spec.ts` değerleri sabitler.

export type Brand = 'dev_adim' | 'public';

export const BRANDS: readonly Brand[] = ['dev_adim', 'public'];

export const BRAND_WEB_ORIGINS: Record<Brand, string> = {
  dev_adim: 'https://mobil.devadim.com',
  public: 'https://yonetim.mobilsporokulu.com',
};

/** Şifre oluşturma sayfasının yolu (yönetim `lib/main_set_password.dart`). */
export const PASSWORD_SETUP_PATH = '/sifre-olusturma/';

export const passwordSetupUrl = (brand: Brand): string =>
  `${BRAND_WEB_ORIGINS[brand]}${PASSWORD_SETUP_PATH}`;

export const isBrand = (value: unknown): value is Brand =>
  value === 'dev_adim' || value === 'public';
