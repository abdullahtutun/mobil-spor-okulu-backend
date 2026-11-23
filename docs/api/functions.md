# Fonksiyonlar (eski Edge Function'lar) — `POST <API>/functions/<ad>`

Supabase'teki `<proje>/functions/v1/<ad>` uçlarının karşılığı. Adlar,
gövdeler, yanıtlar, HTTP kodları ve `reason` değerleri bugünküyle aynı;
uygulamada yalnızca adres değişir (S13–S15). Yanıtlar `RpcEnvelope.fromEdge`
(200) ve `RpcEnvelope.fromFunctionException` (4xx/5xx gövdesi) ile okunur.

Kaynak: yönetim reposu `supabase/functions/<ad>/index.ts`. Kod:
`src/accounts/` (S09), `src/pre-registration/` ve `src/site-lead/` (S10).

## Ortak: token

Oturumlu fonksiyonlar (S09'un beşi, S10'un iki aktarımı). Supabase'te hepsi `verify_jwt: true` ile dağıtılmıştı (ağ geçidi token'ı
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

## Ön kayıt aktarımı: `convert-pre-registration`, `bulk-convert-pre-registrations` (yönetim)

Token kapısı yukarıdaki gibi (`verify_jwt: true`). Yanıt `app_ok`/`app_err`
zarfı (`reason` yok):

- Başarı: **200** `{success: true, code: "ok", message, data}`
- Hata: `{success: false, code, message, data: null, error: message}`

| Durum | HTTP | `code` | `message` |
|---|---|---|---|
| Tekli: `id` yok / metin değil | 400 | `validation` | İşlem için 'id' (pre_registration_id) parametresi zorunludur. |
| Toplu: `ids` dizi değil ya da boş | 400 | `validation` | Aktarılacak kayıt seçilmedi. |
| Toplu: uuid olmayan kimlik | 400 | `validation` | Geçersiz kayıt kimliği gönderildi. |
| Toplu: tekilleştikten sonra > 50 | 400 | `validation` | Tek seferde en fazla 50 kayıt aktarılabilir. |
| Anon anahtarı / kapanmış oturum | 401 | `forbidden` | Oturum doğrulanamadı. Lütfen tekrar giriş yapın. |
| Çağıranın canlı profili yok / okulsuz | 404 | `not_found` | Kullanıcı profili bulunamadı. |
| `registration.manage` yok | 403 | `forbidden` | Bu işlemi gerçekleştirmek için yetkiniz yok. |
| Tekli: gövdedeki `school_id` başka okul | 403 | `forbidden` | Bu okul üzerinde işlem yapma yetkiniz yok. |
| Tekli: kayıt RLS'le görünmüyor | 404 | `not_found` | Ön kayıt bulunamadı veya bu kayıt üzerinde işlem yetkiniz yok. |
| İş kuralı (aktarılmış, sınıfsız, adres başka hesapta, RPC reddi) | 400 | SQL'in / kuralın kodu | metni |
| Beklenmeyen hata, SQL hatası, PostgREST imza hatası | 400 | `internal` | hatanın metni |

Sıra (Edge'le aynı): token → (tekli: `id`; toplu: `ids` denetimleri) →
çağıran → profili (service_role) → `has_permission('registration.manage')`
(çağıran) → okulun markası → tekli: `school_id` uyuşmazlığı →
`update_pre_registration` (çağıran; formun alanları, `undefined` gönderilmez
— PostgREST kuralıyla imza seçimi, eksik zorunlu alan `Could not find the
function …`) → kayıtlar çağıranın rolüyle okunur (RLS: okul + şube) → kayıt
başına: aktarılmış mı (`conflict`), sınıfı var mı (`validation`) → veliler
(anne/baba; adres küçük harfe, aynı adres tek hesap) → `convert_pre_registration`
(çağıran; kilit, yetki, şube, durum, sporcu, bağlar tek transaction).

Veli çözümü: aynı istekte bulunan veli yeniden kullanılır (kardeşler);
yoksa `profiles.email ILIKE` (`\`, `%`, `_` kaçışlı, service_role, bütün
okullar) — okulun canlı velisi (rol 8) ise o, başka okul / personel / silinmiş
ise `conflict` "<adres> adresi başka bir hesapta kullanılıyor.". Bulunamazsa
`AuthAdminService.inviteUser` (okulun markasının şifre sayfası; e-posta
gitmezse hesap açılmaz) + profil (service_role, rol 8, `active`). Kayıt
başarısız olursa **o kayıt için** açılan auth hesapları silinir (profil
cascade); önceden var olana dokunulmaz.

Tekli başarı: `message` "Ön kayıt kesin kayda aktarıldı. Veli hesapları ve
davetleri tamamlandı.", `data: {athlete_id}`. Form kaydı aktarımdan ayrıdır:
aktarım düşerse düzenlemeler kayıtlı kalır.

Toplu başarı (kısmi başarı dahil **200**): `data: {converted_count,
converted: [{id, athlete_id}], failed: [{id, full_name, code, message}]}`;
`message` "N ön kayıt kesin kayda aktarıldı." ya da "N ön kayıt aktarıldı, M
kayıt aktarılamadı.". Kayıtlar sırayla işlenir; görünmeyen kayıt
`{full_name: null, code: "not_found"}`.

## `submit-pre-registration` (online ön kayıt formu, oturumsuz)

Supabase'te `verify_jwt: true` idi ama istemci herkese açık anon anahtarını
taşıyordu; burada **başlık istenmez**, gelirse bakılmaz. CORS genel
`CORS_ORIGINS`'le (formun paketi yönetim alan adlarında; Edge'de `*` idi).
Gövde `create_public_pre_registration_by_token`'ın `p_*` parametreleri
(formun gönderdiği gibi); `turnstile_token` atılır.

| Durum | HTTP | `code` | `message` |
|---|---|---|---|
| Başarı | 200 | `ok` | Ön kayıt başarıyla alındı. (`data: {id}`) |
| `p_token` yok/boş | 400 | `validation` | Bağlantı bilgisi eksik. |
| IP başına saatte 15 aşıldı | 429 | `conflict` | Kısa sürede çok fazla ön kayıt gönderildi. … |
| RPC reddi: geçersiz token, KVKK, şube/sınıf okulun değil | 400 | RPC'nin kodu | RPC'nin metni |
| RPC reddi: 24 saatte aynı sporcu, telefon başına saatte 5 | 409 | `conflict` | RPC'nin metni |
| Bilinmeyen parametre, tipe uymayan değer, SQL hatası | 500 | `internal` | Kayıt sırasında bir hata oluştu. |
| Bozuk JSON, beklenmeyen hata | 500 | `internal` | Beklenmeyen bir hata oluştu. |
| Gövde `BODY_LIMIT`'ten büyük | 413 | `validation` | İstek çok büyük. |

Sıra: token var mı → IP sınırı (`record_pre_registration_attempt`,
service_role; sayma + kaydetme tek çağrıda; sayaç arızası isteği durdurmaz;
IP çözülemezse sınır yok) → RPC (service_role; eksik parametreler `null`).
IP: Express `trust proxy` (`TRUST_PROXY`) ile — istemcinin yazdığı
`X-Forwarded-For` değeri değil, vekilin eklediği; özet
`sha256("<IP_HASH_SALT>:<ip>")`.

Token: `pre_registration_links.token` (canlı, silinmemiş) ya da eski QR'lar
için okulun kimliği (geçiş dönemi). Sunucu tarafında çözülür; istemci okul
göndermez.

## `site-lead` (tanıtım sitesi, oturumsuz)

Supabase'te `--no-verify-jwt`. **Kendi CORS'u**: yalnızca
`SITE_ALLOWED_ORIGINS` (boşsa `https://mobilsporokulu.com`,
`https://www.mobilsporokulu.com`, `http://localhost:4321`); genel
`CORS_ORIGINS` bu yola uygulanmaz. `OPTIONS` 204, izinli kökene
`Access-Control-Allow-Origin: <köken>`, `Allow-Headers: content-type`,
`Allow-Methods: POST, OPTIONS`, `Max-Age: 86400`, `Vary: Origin`.

Gövde: sitenin `toRequestBody`'si (`kind`, `full_name`, `phone`, `email`,
`school_name`, `city`, `athlete_count`, `message`, `privacy_notice_ack`,
`source_page`, `utm_*`, `website` (bal küpü), `elapsed_ms`). Yanıt zarfı
`{success, code, message, data}` (+ hatada `error`).

| Durum | HTTP | `code` | `message` |
|---|---|---|---|
| Başarı (çift gönderim dahil) | 200 | `ok` | `null` |
| Bal küpü dolu ya da `elapsed_ms` < 3000 | **200** (sahte başarı, satır/e-posta yok) | `ok` | `null` |
| Gövde > 16 KB | 413 | `validation` | İstek çok büyük. |
| JSON değil / nesne değil | 400 | `validation` | İstek okunamadı. |
| Alan doğrulaması (`site-lead.validation.ts`) | 400 | `validation` | doğrulamanın metni |
| IP başına saatte 5, telefon başına 24 saatte 3 | 429 | `conflict` | RPC'nin metni |
| CHECK ihlali | 400 | `validation` | Form bilgileri geçersiz. … |
| SQL hatası | 500 | `internal` | Talep kaydedilemedi. |
| POST dışı | 405 | `validation` | POST bekleniyor. |

Aynı telefon + tür 10 dakika içinde: çift gönderim, yeni satır ve e-posta yok
(200). Bildirim e-postası (`SITE_LEAD_NOTIFY_TO`'ya, public markanın
kutusundan, `Reply-To` talebin e-postası, düz metin) yanıttan sonra gider;
adres ya da kutu yoksa atlanır (talep yine kaydedilir).
