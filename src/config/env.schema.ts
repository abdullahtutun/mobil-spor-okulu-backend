import { z } from 'zod';

/**
 * Ortam değişkenlerinin tek şeması. Sonraki oturumlar kendi anahtarlarını
 * buraya ve `.env.example`'a birlikte ekler.
 */
export const envSchema = z.object({
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_URL: z
    .string()
    .min(1)
    .refine(
      (value) => /^postgres(ql)?:\/\//.test(value),
      'postgres:// ya da postgresql:// ile başlamalı',
    ),
  // HS256 imza anahtarı; Supabase'in JWT secret'ı gibi en az 32 karakter.
  JWT_SECRET: z.string().min(32, 'en az 32 karakter olmalı'),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),
});

export type AppConfig = z.infer<typeof envSchema>;

export class InvalidConfigError extends Error {
  constructor(readonly issues: string[]) {
    super(
      `Geçersiz ortam değişkenleri (.env.example'a bakın):\n  - ${issues.join('\n  - ')}`,
    );
    this.name = 'InvalidConfigError';
  }
}

/**
 * Ortamı doğrular; eksik ya da hatalı bir anahtar varsa hepsini tek
 * mesajda sayan bir hata fırlatır. Değerler mesaja yazılmaz (sır olabilir).
 */
export function loadConfig(env: Record<string, string | undefined>): AppConfig {
  const result = envSchema.safeParse(env);
  if (!result.success) {
    throw new InvalidConfigError(
      result.error.issues.map(
        (issue) => `${issue.path.join('.') || '(kök)'}: ${issue.message}`,
      ),
    );
  }
  return result.data;
}
