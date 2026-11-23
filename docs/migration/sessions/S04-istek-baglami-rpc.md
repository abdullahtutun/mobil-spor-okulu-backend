# S04 — DB istek bağlamı ve RPC kapısı

**Repo:** backend (uygulamalar okunur) · **Bağımlı:** S03

## Amaç
Uygulamaların bugün PostgREST'e yaptığı `.rpc()` çağrılarını aynı parametre
ve aynı JSON ile karşılayan `POST /rpc/:name`, ve her isteği doğru rolde
ve doğru kullanıcı kimliğiyle çalıştıran DB katmanı (K5, K6).

## Okunacaklar
- `INVENTORY.md` → 2
- İki uygulamada `lib/core/data/remote/rpc_envelope.dart`,
  `network_error.dart`, `AppException` eşlemesi (hata gövdesinden ne
  okunuyor: `code`, `message`, `details`, `hint`, HTTP durumu)
- İki uygulamada `endpoint.dart` (RPC adları)

## Yapılacaklar
- [ ] `DbContextService.run({ role, claims }, fn)`: tek transaction;
      `set local role`, `set_config('request.jwt.claims', …, true)` (ve
      eski tek claim ayarları `request.jwt.claim.sub`/`role`), `set local
      statement_timeout`. Bağlantı her durumda temiz döner.
- [ ] JWT doğrulama guard'ı: `Authorization: Bearer` yoksa `anon`; varsa
      HS256 + `JWT_SECRET`, `exp`, `aud=authenticated` → `authenticated`.
      (Token üretimi S05'te; burada test için token yardımcı fonksiyonu.)
      Supabase'in ürettiği bir token'ın da kabul edildiğini test et (aynı
      secret kullanılırsa geçişte açık oturumlar bozulmaz — S12 kararı).
- [ ] `src/rpc/rpc-allowlist.ts`: her fonksiyon için `{ name, roles }`
      (`anon` yalnızca `public_get_*_by_token` ve S02'nin
      `get_min_app_version`'ı). Uygulamaların çağırdığı tam liste
      `endpoint.dart` ve `.rpc(` çağrılarından çıkarılır; listede olmayan
      fonksiyon 404.
- [ ] Açılışta `pg_proc`'tan allow-list'teki fonksiyonların imzaları
      (parametre adları/tipleri, varsayılanlar, dönüş tipi, `setof`) okunur
      ve önbelleğe alınır. Çağrı `select … from public.fn(p_a => $1::tip, …)`;
      gönderilmeyen parametre varsayılana bırakılır; bilinmeyen parametre
      PostgREST'teki gibi hata.
- [ ] Dönüş: `json/jsonb`/skaler → değerin kendisi; `setof`/`table` → dizi;
      `void` → `null` (PostgREST ile aynı; `RpcEnvelope` bunu bekliyor).
- [ ] Hata eşlemesi (`src/common/errors/pg-error.mapper.ts`): Postgres
      SQLSTATE → HTTP + `{ code, message, details, hint }`, PostgREST'in
      davranışıyla aynı (`P0001` → 400, `42501` → 401/403, `23505` → 409,
      `PGRST202` vb.). Uygulamanın gerçekten okuduğu alanlara göre test.
- [ ] Hız sınırı (`@nestjs/throttler`), gövde boyutu sınırı, CORS (web
      kökenleri env'den).
- [ ] Integration testleri (S03 seed'i ile):
      veli kendi çocuğunu görür, başkasınınkini `not_found` alır;
      pasif veli `forbidden`; `anon` yalnızca allow-list'teki anon
      fonksiyonları çağırabilir; `service_role`'e ait fonksiyonlar dışarıdan
      çağrılamaz; `get_session_data` beklenen şekli döner.

## Kapsam dışı
Token üretimi, giriş (S05). Tablo okumaları (S07).

## Kabul kriterleri
- Veli uygulamasının 9 RPC'sinin hepsi bir e2e testinde çağrılmış.
- Allow-list ile `endpoint.dart` arasında fark yok (fark varsa gerekçeli).
- lint/test/test:e2e geçiyor.

## Teslim notu
_(oturum sonunda doldurulur)_
