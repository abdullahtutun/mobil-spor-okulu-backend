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

- **S09'dan:** `src/accounts/` — `FunctionsController` (`/functions/` kökü;
  sınıf düzeyinde `AuthorizationHeaderGuard` başlığı zorunlu kılar: anon ve
  `--no-verify-jwt` fonksiyonları için ayrı controller ya da metot düzeyinde
  guard), `function-response.ts` (Edge gövdeleri, `FunctionsExceptionFilter`),
  `CallerResolver`, `AccountsRepository.schoolBrand`, `AuthAdminService.inviteUser`.

## Yapılacaklar
- [x] `POST /functions/submit-pre-registration` (anon): ~~Turnstile
      doğrulama~~ (Turnstile Ekim 2026'da kaldırıldı; `turnstile_token`
      atılır), istemci IP'si (`trust proxy` ile yalnızca güvenilen vekilin
      eklediği), `IP_HASH_SALT` ile hash, hız sınırı; SQL tarafı
      `create_public_pre_registration_by_token` `service_role` ile.
- [x] `POST /functions/convert-pre-registration`,
      `POST /functions/bulk-convert-pre-registrations`: kısmi başarı yanıtı
      aynen (`BulkConversionResult`), veliler `AuthAdminService.inviteUser` ile.
- [x] `POST /functions/site-lead`: CORS yalnızca site kökenleri, ~~Turnstile~~
      (bal küpü + `elapsed_ms`), bildirim e-postası; saklama süresi cron'u S03'te.
- [x] `public_get_*_by_token` RPC'lerinin anon olarak çalıştığını e2e ile
      doğrula (S04 allow-list).
- [x] Testler: geçerli/geçersiz token, ~~Turnstile reddi~~ bal küpü/hız,
      hız sınırı, toplu aktarımda bir kaydın hatası diğerlerini durdurmuyor.

## Kapsam dışı
Web bundle'larının yeni adrese geçmesi (S15).

## Kabul kriterleri
- Yanıt gövdeleri ve hata kodları bugünkü fonksiyonlarla aynı.
- lint/test/test:e2e geçiyor.

## Teslim notu

**Yapılanlar** (2026-11-23):

- `src/pre-registration/`: `PreRegistrationConversionController`
  (`convert-pre-registration`, `bulk-convert-pre-registrations`; S09'un kapısı
  `AuthorizationHeaderGuard` + `RequestAuthGuard`), `PublicPreRegistrationController`
  (`submit-pre-registration`, kapısız), `PreRegistrationConversionService`
  (ex `_shared/pre_registration_conversion.ts` + iki index.ts),
  `PublicPreRegistrationService`, `PreRegistrationRepository`
  (`escapeLikePattern`).
- `src/site-lead/`: `SiteLeadController` (kendi CORS'u, `OPTIONS` 204, POST
  dışı 405), `SiteLeadService`, `site-lead.validation.ts` (yönetim reposundaki
  `validation.ts`'in kopyası + spec'i).
- Ortak: `src/common/http/raw-text-body.ts` (iki oturumsuz yolun gövdesi
  metin olarak; Edge'in kendi ayrıştırma/413 yanıtları), `ip-hash.ts`
  (`IpHasher`: `sha256("<tuz>:<ip>")`, IP `trust proxy`'den),
  `RpcService.callAs` + `src/rpc/server-rpcs.ts` (sunucu içi, PostgREST
  kurallarıyla çağrı: anahtar kümesine göre imza, null doldurma, tip
  çevirisi; gateway'den çağrılamaz), `MailService.sendPlain`,
  `function-response.ts` → `appOk`/`appFailure`.
- `app.setup.ts`: CORS artık istek başına (site-lead yolu genel CORS'u
  atlar; `CORS_ORIGINS` boşsa diğer yollarda CORS kapalı, önceki gibi).
- Env: `IP_HASH_SALT`, `SITE_ALLOWED_ORIGINS`, `SITE_LEAD_NOTIFY_TO`
  (`env.schema.ts`, `.env.example`).
- Sözleşme: `docs/api/functions.md` (üç yeni bölüm). Migration yok.
- Bakım (ayrı commit): 0008 canlıda → `test/schema.e2e-spec.ts` `LIVE`.

**Nasıl test edildi:** `test/pre-registration.e2e-spec.ts` (50 test, gerçek
Postgres + seed; uygulama `TRUST_PROXY=1`, her istek kendi IP'si): geçerli
token, eksik/bilinmeyen/silinmiş token, eski okul kimliği, başka okulun
sınıfı/şubesi, KVKK, 24 saat kopya, telefon başına 5, IP başına 15 (+ özet
değeri), istemcinin uydurduğu XFF'nin işe yaramaması, bilinmeyen parametre/
tip hatası 500, bozuk JSON; anon'un RPC'lere doğrudan erişemediği (gateway
404 + DB `has_function_privilege`); `public_get_*_by_token` anon. Aktarım:
token kapısı, yetkisiz roller (antrenör, muhasebeci) 403 ve davet yok, okul
uyuşmazlığı, `id`/`ids` doğrulamaları, 51 kayıt, tekilleşme, tekli başarı
(form kaydı, marka bağlantısı), çift aktarım, şube kapsamı (tekli/toplu),
kısmi başarı (personel e-postası, başka okulun velisi, görünmeyen kayıt),
kardeşlerin ortak velisi (aynı istek ve sonraki istek), anne=baba adresi,
ILIKE `_`/`%`, davet geri alma (ikinci veli reddi, RPC reddi, SMTP reddi),
sınıfsız kayıt. Site: başarı + bildirim e-postası, CORS (site/yabancı/
yönetim kökeni), bal küpü ve hız, doğrulama, bozuk JSON, 16 KB, GET 405,
çift gönderim, telefon 3/24 sa, IP 5/sa, `site_leads` istemcilere kapalı.

Mutasyonla doğrulandı: ILIKE kaçışı kapatılınca ILIKE testi; IP sınırı ve bal
küpü kapatılınca 3 test düştü.

**Bilinen eksikler / farklar:** aşağıda PROGRESS.md günlüğünde ("Kendi
verdiğim kararlar").
