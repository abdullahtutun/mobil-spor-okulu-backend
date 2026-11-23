import { BRAND_WEB_ORIGINS, isBrand, passwordSetupUrl } from './brand';

// Yönetim reposundaki _shared/brand.ts ve lib/core/config/school_brand.dart
// ile aynı değerler (yönetim test/core/school_brand_test.dart onları eşler).
describe('brand', () => {
  it('marka → web kökeni ve şifre sayfası', () => {
    expect(BRAND_WEB_ORIGINS).toEqual({
      dev_adim: 'https://mobil.devadim.com',
      public: 'https://yonetim.mobilsporokulu.com',
    });
    expect(passwordSetupUrl('dev_adim')).toBe(
      'https://mobil.devadim.com/sifre-olusturma/',
    );
    expect(passwordSetupUrl('public')).toBe(
      'https://yonetim.mobilsporokulu.com/sifre-olusturma/',
    );
  });

  it('tanıma', () => {
    expect(isBrand('dev_adim')).toBe(true);
    expect(isBrand('public')).toBe(true);
    expect(isBrand('mobilsporokulu')).toBe(false);
    expect(isBrand(undefined)).toBe(false);
  });
});
