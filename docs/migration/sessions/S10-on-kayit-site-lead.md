# S10 — Online ön kayıt ve site lead

**Repo:** backend (yönetim ve site repoları okunur) · **Bağımlı:** S06

## Amaç
Oturumsuz uçlar (ön kayıt formu, tanıtım sitesi formu) ve ön kayıtların
kesin kayda aktarılması; bugünkü kötüye kullanım korumalarıyla birlikte.

## Okunacaklar
- Y `supabase/functions/{submit-pre-registration,convert-pre-registration,bulk-convert-pre-registrations,site-lead}/`,
  `_shared/pre_registration_conversion.ts`
- Y migration'ları: `20260921_public_pre_registration_abuse_guards.sql`,
  `20260922_public_pre_registration_edge_only.sql`,
  `20260925_security_hardening.sql`, `20261026_site_leads.sql`
- Y `features/public_pre_registration/`, `features/registration/data/source/pre_registration/`
- Site `src/infrastructure/lead/`, `src/config/site.ts`

## Yapılacaklar
- [ ] `POST /functions/submit-pre-registration` (anon): Turnstile doğrulama,
      istemci IP'si (Caddy'den `X-Forwarded-For`, yalnızca güvenilen proxy),
      `IP_HASH_SALT` ile hash, hız sınırı; SQL tarafı
      `create_public_pre_registration_by_token` `service_role` ile.
- [ ] `POST /functions/convert-pre-registration`,
      `POST /functions/bulk-convert-pre-registrations`: kısmi başarı yanıtı
      aynen (`BulkConversionResult`), veliler `AuthAdminService.inviteUser` ile.
- [ ] `POST /functions/site-lead`: CORS yalnızca site kökenleri, Turnstile,
      bildirim e-postası; saklama süresi cron'u S03'te.
- [ ] `public_get_*_by_token` RPC'lerinin anon olarak çalıştığını e2e ile
      doğrula (S04 allow-list).
- [ ] Testler: geçerli/geçersiz token, Turnstile reddi (sahte doğrulayıcı),
      hız sınırı, toplu aktarımda bir kaydın hatası diğerlerini durdurmuyor.

## Kapsam dışı
Web bundle'larının yeni adrese geçmesi (S15).

## Kabul kriterleri
- Yanıt gövdeleri ve hata kodları bugünkü fonksiyonlarla aynı.
- lint/test/test:e2e geçiyor.

## Teslim notu
_(oturum sonunda doldurulur)_
