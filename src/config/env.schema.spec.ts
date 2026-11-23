import { InvalidConfigError, loadConfig } from './env.schema';

const valid = {
  DATABASE_URL: 'postgres://u:p@localhost:5432/postgres',
  API_DATABASE_URL: 'postgres://api_authenticator:p@localhost:5432/postgres',
  JWT_SECRET: 'x'.repeat(32),
};

describe('loadConfig', () => {
  it('varsayılanları doldurur', () => {
    const config = loadConfig(valid);
    expect(config).toMatchObject({
      NODE_ENV: 'development',
      PORT: 3000,
      LOG_LEVEL: 'info',
    });
  });

  it('CORS_ORIGINS virgülle ayrılmış listeyi diziye çevirir', () => {
    expect(loadConfig(valid).CORS_ORIGINS).toEqual([]);
    expect(
      loadConfig({
        ...valid,
        CORS_ORIGINS: 'https://a.example.com, https://b.example.com',
      }).CORS_ORIGINS,
    ).toEqual(['https://a.example.com', 'https://b.example.com']);
    expect(() => loadConfig({ ...valid, CORS_ORIGINS: 'bozuk' })).toThrow(
      InvalidConfigError,
    );
  });

  it('SITE_ALLOWED_ORIGINS boşsa site-lead’in varsayılan kökenleri', () => {
    expect(loadConfig(valid).SITE_ALLOWED_ORIGINS).toEqual([
      'https://mobilsporokulu.com',
      'https://www.mobilsporokulu.com',
      'http://localhost:4321',
    ]);
    expect(
      loadConfig({ ...valid, SITE_ALLOWED_ORIGINS: ' https://x.test ,' })
        .SITE_ALLOWED_ORIGINS,
    ).toEqual(['https://x.test']);
  });

  it('PORT metnini sayıya çevirir', () => {
    expect(loadConfig({ ...valid, PORT: '8080' }).PORT).toBe(8080);
  });

  it('eksik ve hatalı anahtarların hepsini tek hatada sayar', () => {
    let error: unknown;
    try {
      loadConfig({ JWT_SECRET: 'kisa', LOG_LEVEL: 'loud' });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(InvalidConfigError);
    const { issues } = error as InvalidConfigError;
    expect(issues.some((i) => i.startsWith('DATABASE_URL'))).toBe(true);
    expect(issues.some((i) => i.startsWith('JWT_SECRET'))).toBe(true);
    expect(issues.some((i) => i.startsWith('LOG_LEVEL'))).toBe(true);
  });

  it('sırrın değerini hata mesajına yazmaz', () => {
    expect(() => loadConfig({ ...valid, JWT_SECRET: 'gizli-kisa' })).toThrow(
      InvalidConfigError,
    );
    try {
      loadConfig({ ...valid, JWT_SECRET: 'gizli-kisa' });
    } catch (e) {
      expect((e as Error).message).not.toContain('gizli-kisa');
    }
  });

  it('postgres olmayan bir DATABASE_URL reddedilir', () => {
    expect(() =>
      loadConfig({ ...valid, DATABASE_URL: 'mysql://localhost/x' }),
    ).toThrow(InvalidConfigError);
  });
});
