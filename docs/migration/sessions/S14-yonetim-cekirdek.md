# S14 — Yönetim uygulaması: istemci, auth ve RPC

**Repo:** yönetim (`../mobil_spor_okulu`), dal `migrate/own-backend`
· **Bağımlı:** S05, S06 (S13'ün `ApiClient`/`AuthSession` tasarımı varsa aynısı)

## Amaç
Yönetim uygulamasının çekirdeğini yeni backend'e geçirmek: istemci, oturum,
bütün auth akışları ve bütün `.rpc()` çağrıları. Okumalar, storage, eski
Edge Function'lar ve realtime S15'te.

## Okunacaklar
- `../mobil_spor_okulu/AGENTS.md` (tamamı)
- S13 teslim notu (veli uygulamasında ne nasıl yapıldı — aynı yapı
  kullanılır, kod kopyalanabilir)
- `docs/api/auth.md`
- Y `lib/main*.dart` (dört giriş noktası), `core/data/remote/`,
  `core/provider/{start_up_provider,session_refresh,data_invalidation}.dart`,
  `features/auth/`, `features/set_password/`, `features/wizard/`

## Yapılacaklar
- [ ] `migrate/own-backend` dalı.
- [ ] S13'teki `ApiClient` ve `AuthSession` (aynı tasarım; ortak paket
      çıkarmak gerekip gerekmediği günlüğe — varsayılan: kopya).
- [ ] Auth akışları: giriş, çıkış (global/local), şifre sıfırlama (kod),
      okul kaydı (`signUp` + kod + yeniden gönderme), davetle şifre belirleme
      (web `main_set_password.dart`), sihirbazdaki çıkışlar.
- [ ] Bütün RPC data source'ları `ApiClient.rpc`'ye (parametreler aynı).
- [ ] Başlangıç ve oturum yenileme mantığı (`start_up_provider`,
      `session_refresh`) yeni stream'e.
- [ ] Testler geçer; yeni birim testleri.

## Kapsam dışı
`.from()` okumaları, storage, `functions.invoke`, realtime (S15).

## Kabul kriterleri
- `.rpc(` ve `.auth.` çağrısı kalmadı.
- `flutter analyze`, `flutter test` geçiyor.
- Yerel backend ile giriş, şifre sıfırlama ve okul kaydı denendi.

## Teslim notu
_(oturum sonunda doldurulur)_
