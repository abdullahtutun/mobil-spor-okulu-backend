# S05 — Auth çekirdeği

**Repo:** backend (uygulamalar okunur) · **Bağımlı:** S04

## Amaç
Şifreyle giriş, token yenileme, çıkış ve kullanıcı bilgisi. Supabase'teki
hesaplar aynen çalışmalı (aynı id, aynı bcrypt hash) ve uygulamaların
bugün ayırt ettiği hatalar aynı kalmalı (K8).

## Okunacaklar
- `INVENTORY.md` → 5
- İki uygulamada `features/auth/data/source/login/`, `logout/`, `session/`,
  `core/data/remote/session/` (`SessionRetryClient`, refresher), V
  `session_gate.dart` (ağ hatası ≠ çıkış), hata eşlemesi (yanlış şifre,
  e-posta onaysız, ağ)
- `db/compat/02_auth.sql`

## Yapılacaklar
- [ ] Uç noktalar (gövde ve yanıtlar GoTrue'ya yakın; Dart tarafı S13/S14'te
      bunlara göre yazılacak — son hâlini `docs/api/auth.md`'ye yaz):
  - `POST /auth/token?grant_type=password` `{ email, password }`
  - `POST /auth/token?grant_type=refresh_token` `{ refresh_token }`
  - `POST /auth/logout` `{ scope: global | local | others }`
  - `GET /auth/user`, `PUT /auth/user` (`password`, `data`)
  - Yanıt: `{ access_token, token_type, expires_in, expires_at,
    refresh_token, user }`; `user` Supabase'in `User` JSON'una yakın
    (`id`, `email`, `user_metadata`, `app_metadata`, …).
- [ ] Şifre doğrulama `bcrypt` (`$2a$`/`$2b$`), yeni şifreler de bcrypt.
      Asgari şifre kuralı Supabase projesindekiyle aynı (salt okunur kontrol
      et, `PLAN.md`'ye yaz).
- [ ] JWT: HS256, `JWT_SECRET`, süre 3600 sn (Supabase ile aynı); claim'ler
      `sub`, `role=authenticated`, `aud=authenticated`, `email`,
      `session_id`, `user_metadata`, `app_metadata`, `iat`, `exp`.
- [ ] Refresh token: rastgele, DB'de hash'li, her kullanımda döner;
      kullanılmış bir token tekrar gelirse o oturumun tüm token'ları iptal
      (çalınma tespiti); kısa bir yeniden deneme penceresi (ağ kopması
      yüzünden aynı token iki kez gelebilir — SessionRetryClient).
- [ ] Giriş reddi: yanlış e-posta/şifre aynı hata (`invalid_credentials`);
      `email_confirmed_at` boş → `email_not_confirmed`; `banned_until`
      gelecekte ya da `deleted_at` dolu → yanlış şifreyle aynı. (Pasif hesap,
      rol ve marka kontrolü uygulamada `get_session_data` ile kalır.)
- [ ] Kaba kuvvet koruması: IP + e-posta başına sınır.
- [ ] `last_sign_in_at` güncellenir; oturum satırına user-agent ve IP.
- [ ] Testler: doğru/yanlış şifre, Supabase'ten gelmiş bir bcrypt hash'iyle
      giriş, refresh dönüşü ve yeniden kullanım, global/local çıkış,
      süresi dolmuş token → 401 ve RPC kapısının bunu `JWT expired`
      benzeri kodla dönmesi (SessionRetryClient bunu bekliyor).

## Kapsam dışı
Şifre sıfırlama, kayıt, davet, e-posta (S06). Yönetici işlemleri (S09).

## Kabul kriterleri
- Seed'deki bir veli `POST /auth/token` ile giriş yapıp `/rpc/get_session_data`
  ve `/rpc/parent_get_athletes` çağırabiliyor (e2e).
- `docs/api/auth.md` yazıldı.
- lint/test/test:e2e geçiyor.

## Teslim notu
_(oturum sonunda doldurulur)_
