import { z } from 'zod';
import { edgeFailure } from './function-response';

// Gövde şemaları: uygulamaların bugün gönderdiği alanlar
// (yönetim `features/registration/data/source/{users,coaches,parents}/`).
// Edge Function'lar gövdeyi doğrulamadan PostgREST'e veriyordu; burada yalnızca
// **tip** denetlenir (metin alanı metin, liste liste). İş kuralları — zorunlu
// alanlar, rol, şube, yetki — SQL fonksiyonlarında kalır (AGENTS.md →
// Conventions). Bilinmeyen anahtarlar yok sayılır (ör. personelde `school_id`).

const text = z.string().max(1000).nullish();
const ids = z.array(z.string().max(100)).max(1000).nullish();

export const staffBody = z.object({
  id: z.string().max(100).nullish(),
  email: text,
  password: z.string().max(1024).nullish(),
  full_name: text,
  phone_number: text,
  birth_of_date: text,
  status: text,
  role_id: z.union([z.number().int(), z.string().max(20)]).nullish(),
  branch_ids: ids,
  permissions: ids,
  class_ids: ids,
});
export type StaffBody = z.infer<typeof staffBody>;

export const parentBody = z.object({
  id: z.string().max(100).nullish(),
  school_id: z.string().max(100).nullish(),
  branch_id: z.string().max(100).nullish(),
  email: text,
  full_name: text,
  phone_number: text,
  birth_of_date: text,
  status: text,
  athlete_ids: ids,
});
export type ParentBody = z.infer<typeof parentBody>;

/** Tip hatası: Edge Function'ın hata yolu (400 `{success:false, error}`). */
export function parseFunctionBody<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value ?? {});
  if (!result.success) {
    throw edgeFailure(
      `Geçersiz istek: ${result.error.issues
        .map((i) => `${i.path.join('.') || '(gövde)'} ${i.message}`)
        .join('; ')}`,
    );
  }
  return result.data;
}
