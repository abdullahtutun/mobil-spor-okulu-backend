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
- **S05'ten:** auth uçları ve hata kodları `docs/api/auth.md`'de
  (`/auth/token?grant_type=password|refresh_token`, `/auth/logout?scope=`,
  `/auth/user`). Refresh token her kullanımda döner — yanıttaki yenisi
  saklanmalı; 400/403 = oturum bitti (çıkış), ağ hatası = geçici. RPC'de
  401 `PGRST303`/`PGRST301` → bir kez yenile, tekrar gönder.
- [ ] `migrate/own-backend` dalı (yoksa aç).
- [ ] API adresi flavor/ortam yapılandırmasından (`config/*.json` ya da
      `--dart-define`), yerel geliştirme için `http://localhost:<port>`.
- [ ] `core/data/remote/api/`: mevcut HTTP yığınının (`SessionRetryClient`,
      zaman aşımı, ağ farkındalığı) üzerinde `ApiClient` (`rpc`, `get`,
      `post`, `upload`, `download`).
- [ ] `AuthSession` servisi: token saklama (güvenli depolama), açılışta
      oturumu geri yükleme, refresh, `onAuthStateChange` yerine bir stream;
      **ağ hatasıyla kaybedilen refresh çıkış değildir** (`connectionError`),
      reddedilen refresh `signedOut`. `IAccessTokenRefresher` yeni
      implementasyonu.
- [ ] Data source'lar: giriş, çıkış (push token önce), şifre sıfırlama,
      oturum, 9 RPC, gelen kutusu okuması (S07 fonksiyonu), realtime (S11
      protokolü, yeniden bağlanınca ve öne gelince yeniden okuma), fotoğraf
      indirme/silme (S08: `GET /storage/object/athlete-photos/<yol>`,
      `DELETE /storage/object/athlete-photos {prefixes}`; `storage_client`
      `<API>/storage` köküyle kullanılabilir — `docs/api/storage.md`),
      hesap silme (S09).
- [ ] `supabase_flutter` bağımlılığı ve `AuthFlowType` notları kalkar;
      `AGENTS.md`'de Supabase'ten söz eden bölümler yeni backend'e göre
      güncellenir.
- [ ] Testler: mevcut testler geçer (sahte repository'ler değişmez), yeni
      `ApiClient`/`AuthSession` için birim testleri (refresh, ağ hatası,
      401'de tek refresh + yeniden gönderme).
- [ ] Yerelde backend (seed verisi) ile uygulamayı çalıştırıp giriş, sporcu,
      yoklama, ödemeler, duyurular (canlı), fotoğraf ve rızalar akışlarını
      dene; sonucu günlüğe yaz.

## Kapsam dışı
Mağaza yayını (S17). Aydınlatma metni (S15).

## Kabul kriterleri
- `grep -r supabase lib` boş (yorumlar hariç ve gerekçeli).
- `flutter analyze`, `flutter test` geçiyor; yerel deneme günlükte.

## Teslim notu
_(oturum sonunda doldurulur)_
