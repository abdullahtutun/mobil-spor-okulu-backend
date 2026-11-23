# S13 — Veli uygulamasının yeni backend'e geçişi

**Repo:** veli (`../mobil_spor_okulu_veli`), dal `migrate/own-backend`
· **Bağımlı:** S05–S08, S11

## Amaç
Veli uygulamasında `supabase_flutter`'ı kaldırıp yeni backend'e geçmek.
Değişiklik yalnızca `data/source` ve `core/data/remote` katmanında;
repository'ler, DTO'lar, `RpcEnvelope` ve ekranlar aynı kalır.

## Okunacaklar
- `../mobil_spor_okulu_veli/AGENTS.md` (tamamı) ve yönetim uygulamasının
  `AGENTS.md`'si (ortak kurallar)
- `docs/api/{auth,storage,functions}.md`, `docs/migration/read-mapping.md`,
  S11 teslim notu (realtime protokolü)
- V `lib/main.dart`, `core/data/remote/`, `core/provider/session_gate.dart`,
  `features/*/data/source/`

## Yapılacaklar
- **S11'den:** realtime protokolü `docs/api/realtime.md` (`GET /realtime`
  WebSocket; ilk mesaj `{type:'auth', token}`, sonra
  `{type:'subscribe', channel:'notifications:<uid>'}`; olay
  `{type:'event', event, record}`, `resync` = yeniden oku; token yenilenince
  `auth` tekrar gönderilir; 4001 = token yenile + yeniden bağlan, 4003 =
  hata). UPDATE olayları zaten yalnızca `isRevived` satırlar. Push token
  kaydı (`register_push_token`) değişmez; push metinleri sunucuda.
- **S05'ten:** auth uçları ve hata kodları `docs/api/auth.md`'de
  (`/auth/token?grant_type=password|refresh_token`, `/auth/logout?scope=`,
  `/auth/user`). Refresh token her kullanımda döner — yanıttaki yenisi
  saklanmalı; 400/403 = oturum bitti (çıkış), ağ hatası = geçici. RPC'de
  401 `PGRST303`/`PGRST301` → bir kez yenile, tekrar gönder.
- [x] `migrate/own-backend` dalı (yoksa aç).
- [x] API adresi flavor/ortam yapılandırmasından (`config/*.json` ya da
      `--dart-define`), yerel geliştirme için `http://localhost:<port>`.
- [x] `core/data/remote/api/`: mevcut HTTP yığınının (`SessionRetryClient`,
      zaman aşımı, ağ farkındalığı) üzerinde `ApiClient` (`rpc`, `get`,
      `post`, `upload`, `download`).
- [x] `AuthSession` servisi: token saklama (güvenli depolama), açılışta
      oturumu geri yükleme, refresh, `onAuthStateChange` yerine bir stream;
      **ağ hatasıyla kaybedilen refresh çıkış değildir** (`connectionError`),
      reddedilen refresh `signedOut`. `IAccessTokenRefresher` yeni
      implementasyonu.
- [x] Data source'lar: giriş, çıkış (push token önce), şifre sıfırlama,
      oturum, 9 RPC, gelen kutusu okuması (S07 fonksiyonu), realtime (S11
      protokolü, yeniden bağlanınca ve öne gelince yeniden okuma), fotoğraf
      indirme/silme (S08: `GET /storage/object/athlete-photos/<yol>`,
      `DELETE /storage/object/athlete-photos {prefixes}`; `storage_client`
      `<API>/storage` köküyle kullanılabilir — `docs/api/storage.md`),
      hesap silme (S09).
- [x] `supabase_flutter` bağımlılığı ve `AuthFlowType` notları kalkar;
      `AGENTS.md`'de Supabase'ten söz eden bölümler yeni backend'e göre
      güncellenir.
- [x] Testler: mevcut testler geçer (sahte repository'ler değişmez), yeni
      `ApiClient`/`AuthSession` için birim testleri (refresh, ağ hatası,
      401'de tek refresh + yeniden gönderme).
- [x] Yerelde backend (seed verisi) ile uygulamayı çalıştırıp giriş, sporcu,
      yoklama, ödemeler, duyurular (canlı), fotoğraf ve rızalar akışlarını
      dene; sonucu günlüğe yaz.

## Kapsam dışı
Mağaza yayını (S17). Aydınlatma metni (S15).

## Kabul kriterleri
- `grep -r supabase lib` boş (yorumlar hariç ve gerekçeli).
- `flutter analyze`, `flutter test` geçiyor; yerel deneme günlükte.

## Teslim notu
2026-11-23, veli reposu `migrate/own-backend` (commit `af2b905`, `main`'den).

**Ne, nerede** (`../mobil_spor_okulu_veli/lib/core/data/remote/api/`):
- `api_config.dart` — `API_BASE_URL` (`config/dev_adim.json` ve
  `config/public.json`'da `https://api.mobilsporokulu.com`); komut satırındaki
  `--dart-define=API_BASE_URL=…` dosyadakini ezer (denendi).
- `auth_session.dart` — `AuthSession` (`IAccessTokenRefresher`): parola
  girişi, `recover`, `verifyOtp` (recovery/signup/invite), `PUT /auth/user`,
  refresh (tek uçuş; dönen refresh token hemen saklanır), `signOut(scope)`
  (sunucuya ulaşılamasa da cihazdan siler), `onAuthStateChange`
  (her dinleyiciye önce `initialSession`, sonra signedIn / tokenRefreshed /
  signedOut — supabase-dart'ınkiyle aynı adlar, `SessionGate` aynı kaldı).
  Ağdan düşen yenileme `NetworkException` (oturum kalır); 400/403 oturumu
  siler + `signedOut` + `AuthApiException`; 5xx oturuma dokunmaz. Cihaz
  saatine göre 30 sn kala istekten önce yenilenir.
- `session_store.dart` — `flutter_secure_storage` (yönetimle aynı paket,
  10.x); testlerde `MemorySessionStore`.
- `api_client.dart` — `rpc`, `invokeFunction`, `downloadObject`,
  `removeObjects`, `realtimeUri`; `SessionRetryClient` zincirinin üstünde.
  Hatalar: `/auth/*` `AuthApiException(code)`, `/rpc`+`/storage`
  `ApiException`, `/functions` `FunctionHttpException(status, details)`,
  taşıma `NetworkException`. Oturum yoksa `Authorization` gitmez (anon
  anahtarı yok).
- `realtime_client.dart` — S11 protokolü; yeniden abonelik ve `resync`
  gelen kutusunu yeniden okutur; 4001 → yenile + bağlan, 4000/4003/4029/1009
  dur, diğerleri üstel bekleme (1–30 sn); her token yenilemesinde `auth`
  yeniden gönderilir; `signedOut`'ta kapanır.
- `SessionRetryClient`: muaf yollar `/auth/(token|logout|user|recover|verify|signup|resend)`,
  storage reddi yolu `/storage/object/`. `ApiHttpLogger` (eski
  `SupabaseHttpLogger`, aynı davranış).
- Data source'lar: hepsi `ApiClient`'la; gelen kutusu `list_notifications
  {p_limit}` / `count_unread_notifications`. Repository katmanında yalnızca
  istisna türlerinin adı değişti (`athlete_photo_repository`,
  `auth_error_localizer`, `result_guard`, `RpcEnvelope.fromFunctionException`);
  davranış aynı. `RpcEnvelope.fromEdge` kalktı (gövde doğrudan `from`'a).
- `grep -ri supabase lib`: yalnızca yönetim reposunun
  `supabase/migrations/…` yollarına atıflar (klasör adı) ve "supabase-dart'taki
  gibi" eşdeğerlik notları.

**Test:** `flutter analyze` → 3 bilgi, hepsi `main`'de de var (yeni yok);
`flutter test` → 178 geçti, 1 atlandı (e2e). Yeni:
`test/core/api_client_test.dart` (17: giriş, açılış, bozuk kayıt, rotasyon +
tek uçuş, ağ hatası çıkış değil, ret → signedOut, cihaz saatiyle yenileme,
401 PGRST303'te tek refresh + aynı gövdeyle tekrar, anon istek, fonksiyon ve
storage gövdeleri), `test/core/realtime_client_test.dart` (6, gerçek yerel
WebSocket sunucusu: protokol, yeniden bağlanma, 4001, 4003, token yenileme,
gelen kutusu süzgeci). `flutter build web` (public) derlendi.

**Yerel deneme (backend + seed):** dbmate 0001–0009 + `test/fixtures/seed.sql`
yerel docker Postgres'e, `node dist/main` :3000. `API_E2E_BASE_URL=http://127.0.0.1:3000
flutter test test/e2e/local_backend_test.dart` geçti (iki koşu, aradaki seed
sıfırlamasıyla): güncelleme kapısı (anon), veli girişi + `get_session_data`
(rol, marka dev_adim, aktif), yanlış şifre `invalid_credentials`, gizlilik
onayı, çocuklar / yoklama / ödemeler, başka çocuk `not_found`, fotoğraf rızası
→ personel yükler + `set_athlete_photo` → veli indirir → rıza geri →
`removed_photo_path` → veli siler → indirme reddi, canlı kanal (personelin
duyurusu sinyal verdi) + gelen kutusu + okunmamış sayısı + okundu, push token
kaydı/silme, refresh rotasyonu, çıkış, hesap silme (yanlış şifre →
`WrongPasswordException`, doğru şifre → sonra giriş reddi). Uygulamanın
kendisi (ekranlar) bir cihazda/simülatörde çalıştırılmadı — veri kaynakları
gerçek backend'le, ekranlar sahte repository'lerle sınandı.

**Bilinen eksikler / sonraki oturumlar:**
- Şifre sıfırlama kodu e-postası yerelde gitmez (SMTP yok); akış birim
  testiyle (istek sırası ve gövdeler) sınandı, gerçek kodla değil.
- Eski Supabase oturumu taşınmaz: yeni sürüme geçen veli bir kez yeniden
  giriş yapar (S12 kararı; `--with-sessions` S17'de değiştirilebilir).
- Bağımlılık değişikliği (supabase_flutter çıktı, flutter_secure_storage
  girdi) yerel kod: Shorebird yaması olamaz, mağaza sürümü gerekir (S17).
- Aydınlatma metni (`assets/legal/privacy_policy_tr.md`) hâlâ Supabase'i
  işleyen olarak anıyor — S15.
