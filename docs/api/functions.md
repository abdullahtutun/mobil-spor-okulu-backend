# Fonksiyonlar (eski Edge Function'lar) — `POST <API>/functions/<ad>`

Supabase'teki `<proje>/functions/v1/<ad>` uçlarının karşılığı. Adlar,
gövdeler, yanıtlar, HTTP kodları ve `reason` değerleri bugünküyle aynı;
uygulamada yalnızca adres değişir (S13–S15). Yanıtlar `RpcEnvelope.fromEdge`
(200) ve `RpcEnvelope.fromFunctionException` (4xx/5xx gövdesi) ile okunur.

Kaynak: yönetim reposu `supabase/functions/<ad>/index.ts`. Kod:
`src/accounts/` (S09). Ön kayıt ve site lead fonksiyonları S10'da eklenir.

## Ortak: token

Supabase'te beşi de `verify_jwt: true` ile dağıtılmıştı (ağ geçidi token'ı
fonksiyondan önce denetliyordu). Burada:

| İstek | Yanıt |
|---|---|
| `Authorization` yok | 401 `{code: "UNAUTHORIZED_NO_AUTH_HEADER", message: "Missing authorization header"}` |
| Geçersiz / süresi geçmiş token | 401 `{code: "PGRST301" \| "PGRST303", message}` — uygulamanın `SessionRetryClient`'ı yeniler ve tekrar dener |
| Anon anahtarı, kapanmış oturumun ya da silinmiş/yasaklı hesabın token'ı | fonksiyonun kendi "oturum" hatası (aşağıda) |

Çağıranın kimliği yalnızca token'dan (`sub`) gelir; oturum `auth.sessions`'ta
açık olmalı (`GET /auth/user` ile aynı kural). Gövdedeki hiçbir alan
çağıranı ya da silinecek hesabı belirlemez.

Gövde tip denetimi (metin alanı metin, liste liste) 400
`{success: false, error: "Geçersiz istek: …"}`; iş kuralları SQL'de.
Bozuk JSON gövdesi (uygulamalar üretmez) genel ayrıştırıcıdan 400
`{code: "PGRST102", …}` alır.

## Personel ve veli: `create-user`, `update-user`, `create-parent`, `update-parent`

- Başarı: **200** `{success: true, message: "<metin>"}`
- Hata: **400** `{success: false, error: "<metin>"}` (`code` yok; istemci
  "yetkiniz yok" geçen metni `forbidden` sayar)

### `create-user` (kullanıcı formu, eğitmen formu)

Gövde: `email, password, full_name, phone_number, birth_of_date, status,
role_id, branch_ids, permissions, class_ids?` (`school_id` yok sayılır —
okul çağıranın oturumundan).

Sıra: çağıran → `save_staff_profile(p_validate_only := true)` çağıranın
rolüyle (hiyerarşi, sahip olmadığın yetki, şube kapsamı, kendi hesabın) →
şifre zorunlu → onaylı auth kullanıcısı (`user_metadata`: `created_by_manager:
true`, `created_by: <çağıran>`, `name`) → `save_staff_profile` yazım.
Yazım düşerse auth kullanıcısı silinir. Reddedilen istekte auth kullanıcısı
açılmaz.

Metinler: `Kullanıcı başarıyla oluşturuldu` · `Oturum doğrulanamadı. Lütfen
tekrar giriş yapın.` · `Parola zorunludur.` · SQL'in metinleri · GoTrue'nun
(`A user with this email address has already been registered`, zayıf şifre).

### `update-user`

Gövde: `id` + create-user'ın alanları. `branch_ids` / `permissions` /
`class_ids` gönderilmezse dokunulmaz. `status` gönderilmezse `active`
(Edge Function'daki gibi: eğitmen formu `status` göndermiyor).

Sıra: `id` zorunlu → çağıran → doğrulama (`data.is_new` `false` olmalı,
yoksa `Kullanıcı bulunamadı veya yetkiniz yok.`) → **ancak sonra** auth
(e-posta ve/veya şifre; şifre değişince hesabın açık oturumları kapanır) →
yazım (düşerse `Giriş bilgileri güncellendi ama profil kaydedilemedi: …`).

### `create-parent`

Gövde: `school_id, branch_id, full_name, phone_number, email, birth_of_date,
status, athlete_ids`.

Sıra (hepsi davet e-postası gitmeden): çağıran (`Admin girişi yapılmamış.`) →
çağıranın profili, RLS ile (`Admin profili bulunamadı.` — veli hesabı burada
düşer) → `has_permission('registration.manage')` (`Bu işlemi
gerçekleştirmek için yetkiniz yok.`) → gövdedeki okul = çağıranın okulu
(`Bu okul üzerinde işlem yapma yetkiniz yok.`) → şube zorunlu (`Velinin
şubesi seçilmelidir.`) ve `has_branch_access` (`Seçilen şubeye erişiminiz
yok.`) → okulun markası (`schools.brand`, okunamazsa `Okulun markası
okunamadı: …`) → davet (`<marka kökeni>/sifre-olusturma/?token_hash=…`,
metadata `brand`) → profil (rol 8, çağıranın rolüyle: `profiles_insert_policy`)
+ `sync_profile_branch_links` + `sync_parent_athlete_links` **tek
transaction'da**; düşerse geri alınır ve davetli auth kullanıcısı silinir.

### `update-parent`

Gövde: `id` + create-parent'ın alanları.

Sıra: `id` zorunlu → create-parent'ın ilk dört adımı → şube zorunlu →
`can_manage_parent(id)` (`Güncellenecek veli profili bulunamadı veya
yetkiniz yok.`) → `has_branch_access(branch_id)` → velinin profili (RLS;
rol 8 ve aynı okul olmalı) → e-posta değişti mi (büyük/küçük harf duyarsız):

- **Aynı**: profil güncellemesi (`profiles_update_policy`) + şube ve sporcu
  bağları, tek transaction.
- **Değişti** (20261123; yönetim reposunda da aynı karar): **aynı** auth
  hesabı kalır — profil kimliği, şube/sporcu bağları, geçmiş yerinde. Tek
  transaction'da: profil (yeni e-postayla) + bağlar, çağıranın rolüyle →
  `reset_parent_login_email` (service_role: adres değişir; hesap onaysız,
  şifresiz ve oturumsuz olur; adres başka hesaptaysa `Yeni e-posta için davet
  oluşturulamadı: Bu e-posta adresi başka bir hesapta kayıtlı.`) → davet
  token'ı ve **yeni adrese** okulun markasının şifre oluşturma bağlantısı
  (`type=invite`). Bir adım — e-postanın gönderimi dahil — düşerse hepsi geri
  alınır; eski adres ve şifre geçerli kalır. Başarıda eski adresle giriş ve
  eski refresh token'lar geçmez; veli yeni adresteki davetle şifresini koyar.

  Eskiden (20261123'e kadar) eski auth hesabı silinip yeni hesap açılıyordu;
  velinin bağ satırları `profiles`'a `NO ACTION` ile bağlı olduğu için bu,
  bağı olan her velide `Database error deleting user` ile düşüyordu.

Metinler: `Veli bilgileri ve bağlantıları başarıyla güncellendi.` · `Veli
e-postası değiştirildi; yeni adrese şifre oluşturma daveti gönderildi.`

## `delete-account` (yönetim ve veli uygulaması)

Gövde: `{password}`. Yanıt `app_ok`/`app_err` zarfı:

- Başarı: **200** `{success: true, code: "ok", message: "Hesabınız silindi.", data: null}`
- Hata: `{success: false, code, reason, message, data: null, error: message}`

| Durum | HTTP | `code` | `reason` | `message` |
|---|---|---|---|---|
| Oturum yok/kapalı | 401 | `forbidden` | `null` | Oturumunuz doğrulanamadı. Lütfen yeniden giriş yapın. |
| Şifre yok / metin değil | 400 | `validation` | `password_required` | Şifrenizi girin. |
| Okulun son (aktif) genel müdürü — şifre sorulmadan | 400 | `conflict` | `null` | SQL'in metni (self-service okulda "…ya da Okul Bilgileri ekranından okulu silin.") |
| Hesabın e-postası yok | 400 | `validation` | `null` | Bu hesabın e-posta adresi yok; … |
| Çok deneme | 429 | `conflict` | `rate_limited` | Çok fazla deneme yapıldı. … |
| Yanlış şifre | 400 | `validation` | `wrong_password` | Şifre hatalı. |
| SQL/iç hata | 500 | `internal` | `null` | Hesabınız şu anda silinemiyor. Lütfen tekrar deneyin. |
| POST dışı yöntem | 405 | `validation` | `null` | Desteklenmeyen istek. |

Sıra: çağıran (token) → şifre var mı → `delete_own_account(p_validate_only
:= true)` (service_role) → şifre (girişin kaba kuvvet sayaçlarıyla: IP, IP +
e-posta, e-posta; **oturum açılmaz**) → `delete_own_account` (tek
transaction: mezar taşı profil, boşaltılmış `auth.users`, bütün oturumlar ve
refresh token'lar silinir). Sonra: refresh `refresh_token_not_found`, `/auth/user`
`session_not_found`, giriş `invalid_credentials`, aynı token'la ikinci silme
401.
