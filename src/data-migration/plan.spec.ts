import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { columnTransforms, isPicked } from './plan';

describe('veri taşıma kapsamı', () => {
  it('public bütünüyle, auth/storage seçilerek, oturumlar yalnızca istenince', () => {
    expect(isPicked('public.athletes', false)).toBe(true);
    expect(isPicked('public.schema_migrations', false)).toBe(false);
    expect(isPicked('auth.users', false)).toBe(true);
    expect(isPicked('auth.otp_attempts', false)).toBe(false);
    expect(isPicked('auth.one_time_tokens', true)).toBe(false);
    expect(isPicked('storage.buckets', false)).toBe(false);
    expect(isPicked('storage.objects', false)).toBe(true);
    expect(isPicked('auth.refresh_tokens', false)).toBe(false);
    expect(isPicked('auth.refresh_tokens', true)).toBe(true);
  });

  it('dönüşümler yalnızca seçenek verilince', () => {
    const none = columnTransforms({
      oldStoragePrefix: 'a',
      withSessions: false,
    });
    expect(none).toEqual({});
    const all = columnTransforms({
      oldStoragePrefix: "https://x'/",
      newStoragePrefix: 'https://api/storage/',
      withSessions: true,
    });
    expect(all['public.schools'].logo_url('c')).toContain("'https://x''/'");
    expect(Object.keys(all['auth.refresh_tokens'])).toEqual([
      'token',
      'parent',
    ]);
  });

  /**
   * Kabul kriteri "hiçbir script canlıya yazmıyor": kaynağa dokunan iki
   * dosyada yazım SQL'i ya da GET dışı HTTP yöntemi olmamalı.
   */
  it('export kaynağa yazmaz (kaynak metni denetimi)', () => {
    for (const file of ['export.ts', 'storage-source.ts', 'catalog.ts']) {
      const text = readFileSync(join(__dirname, file), 'utf8');
      expect(text).not.toMatch(
        /\b(insert\s+into|update\s+\w+(\.\w+)?\s+set|delete\s+from|truncate|alter\s+table|create\s+table|drop\s+)/i,
      );
      expect(text).not.toMatch(/method:\s*'(POST|PUT|PATCH|DELETE)'/);
    }
    const exp = readFileSync(join(__dirname, 'export.ts'), 'utf8');
    expect(exp).toContain("'begin isolation level repeatable read read only'");
  });
});
