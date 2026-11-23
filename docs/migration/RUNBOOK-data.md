# Veri taşıma runbook'u (S12 araçları, S17'de çalıştırılır)

Kaynak: canlı Supabase (yalnızca okunur). Hedef: yeni Postgres (migration'ları
uygulanmış, **boş**) ve API'nin `STORAGE_ROOT`'u. Araçlar
`src/data-migration/`'da; derlenmiş hâli API imajında da var
(`node dist/data-migration/cli.js …`, yerelde `npm run build && npm run data -- …`).

## Ne taşınır, ne taşınmaz

| Taşınır | Nasıl |
|---|---|
| `public` şemasının bütün tabloları | aynen; `public.schema_migrations` (dbmate) hariç |
| `roles`, `role_permissions`, `app_min_versions` | 0004 zaten doldurdu → birincil anahtara göre canlının değeriyle güncellenir |
| `auth.users`, `auth.identities`, `auth.mfa_factors` | aynen (aynı id, aynı bcrypt hash'i — K8); üretilen sütunlar (`confirmed_at`, `identities.email`) hedefte yeniden hesaplanır |
| `storage.objects` | aynen; Supabase'e özgü `archived_at`, `is_delete_marker`, `is_versioned` atılır; `path_tokens` üretilir |
| Dosyalar | `STORAGE_ROOT/<bucket>/<ad>`, klasör 0700, dosya 0600 |
| `schools.logo_url` | `https://gcmeltwnryjscinptecb.supabase.co/storage/v1/` öneki → `--storage-prefix` (ör. `https://api.mobilsporokulu.com/storage/`) |

| Taşınmaz | Neden |
|---|---|
| `auth.sessions`, `auth.refresh_tokens` | Karar (S12 varsayılanı): yeni sürümde herkes bir kez giriş yapar. `--with-sessions` ile taşınır; refresh token'lar SHA-256'ya çevrilir (S05) ve eski token'la yenileme çalışır (provada sınandı). Access token'lar zaten 1 saatlik; yenileme JWT_SECRET'tan bağımsız |
| `one_time_tokens`, `flow_state`, bekleyen kodlar/davetler | kısa ömürlü (S06) |
| `auth.audit_log_entries` | hedefte tablo yok (5651 saklaması ayrıca: S16/S17) |
| `storage.buckets` | `db/compat/03_storage.sql` |
| cron işleri | `0003_cron_jobs.sql` |
| Adı `isValidObjectKey`'den geçmeyen nesne | satırı da dosyası da taşınmaz, manifest'te `rejectedObjects`; verify "gerekçeli" not olarak yazar |

Canlı 2026-11-23 (salt okunur sayım): 7 kullanıcı, 55 oturum, 15 nesne,
0 MFA; S09'un e-posta değişikliği hatasından **yetim veli hesabı yok**
(davetli/onaysız kullanıcı 0, profilsiz kullanıcı 0, aynı sporcuya aynı
adla bağlı iki veli 0).

## Gereken sırlar (yalnızca ortam değişkeni, dosyaya yazılmaz)

| Değişken | Komut | Nereden |
|---|---|---|
| `SOURCE_DATABASE_URL` | export | Supabase → Project Settings → Database → Connection string, **Session pooler** (5432; COPY/cursor için transaction pooler değil). Salt okunur bir rol tercih edilir |
| `SUPABASE_URL` | export | `https://gcmeltwnryjscinptecb.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | export | API Keys → service_role (yalnızca GET indirme için) |
| `DATABASE_URL` | import, verify, resume-cron | hedef, `postgres` süper kullanıcısı (replica kipi için) |
| `STORAGE_ROOT` | import, verify | API'nin aynı değeri |
| `VERIFY_LOGIN_PASSWORD` | verify (isteğe bağlı) | test hesabının şifresi |

## Komutlar (sırasıyla)

```bash
# 0) API kapalı (dosyalar ve satırlar yazılmasın); hedef boş + migrate edilmiş
npm run db:migrate            # ya da Coolify'daki migrate adımı

# 1) Export — kaynağa yazmaz: tek "repeatable read read only" transaction, dosyalar yalnızca GET
STAMP=$(date +%Y%m%d-%H%M)
SOURCE_DATABASE_URL=… SUPABASE_URL=https://gcmeltwnryjscinptecb.supabase.co SUPABASE_SERVICE_ROLE_KEY=… \
  node dist/data-migration/cli.js export --out exports/$STAMP
#   beklenen: tablo başına "<tablo>: N satır", sonda
#   "export bitti: T tablo, R satır, 15 dosya (~865 KB), 0 reddedilen, … ms"
#   exports/$STAMP/manifest.json: satır sayıları + kaynakta hesaplanmış parmak izleri

# 2) Import — cron'u durdurur, tek transaction, trigger'lar kapalı
DATABASE_URL=… STORAGE_ROOT=… \
  node dist/data-migration/cli.js import --from exports/$STAMP \
  --storage-prefix https://api.mobilsporokulu.com/storage/
#   beklenen notlar: storage.objects'in kaynağa özgü üç sütunu atlandı;
#   "cron durduruldu: 9 iş"; "import bitti: … ms"

# 3) Verify — sıfır fark beklenir (çıkış kodu 0); rapor exports/$STAMP/verify-report.json
DATABASE_URL=… STORAGE_ROOT=… \
  node dist/data-migration/cli.js verify --from exports/$STAMP \
  --storage-prefix https://api.mobilsporokulu.com/storage/
#   API açıldıktan sonra giriş denemesiyle tekrar:
VERIFY_LOGIN_PASSWORD=… … verify --from exports/$STAMP --storage-prefix … \
  --api-url https://api.mobilsporokulu.com --login-email <test hesabı>

# 4) Cron'u aç, API'yi başlat
DATABASE_URL=… node dist/data-migration/cli.js resume-cron --from exports/$STAMP

# 5) Export klasörünü sil (kişisel veri)
rm -rf exports/$STAMP
```

`import`'u tekrar çalıştırmak: dolu hedef reddedilir; `--replace` bütün
taşınan tabloları boşaltıp yeniden yükler (başvuru tabloları ve
`schema_migrations` dokunulmaz), dosyaların üzerine yazar. Sonuç aynıdır
(provada sınandı).

## Verify neye bakar

- Tablo başına: kaynak parmak izi (manifest) = export dosyası → dosya
  bozulmamış; export (dönüşümler uygulanmış, reddedilen nesneler süzülmüş) =
  hedef → yükleme eksiksiz ve değerler aynı. Parmak izi = satırların jsonb
  metinlerinin md5'lerinin sıralı birleşiminin md5'i (sıra bağımsız).
- `auth.users` sayısı.
- FK yetimleri (replica kipi FK denetlemediği için her FK sayılır).
- Sequence'ler sütunun en büyük değerinin gerisinde değil.
- Dosyalar: satır sayısı = dosya sayısı, toplam boyut, eksik/fazla dosya,
  boyut farkı, rastgele 20 dosyanın md5'i (hedef = export = kaynak),
  kaynakta metadata `size`/`eTag` ile indirilen dosyanın uyuşması.
- İsteğe bağlı: test hesabıyla `POST /auth/token` + `/rpc/get_session_data`.

## Sorun olursa

| Belirti | Ne yapılır |
|---|---|
| export: `… boş değil` | her export yeni klasöre; eski klasörü silin ya da yeni ad verin |
| export: `indirilemedi: HTTP 4xx` | service key yanlış / nesne storage'da yok (satır var, dosya yok): nesneyi listeleyin; dosyasız satır taşınamaz, kullanıcıya sorun |
| import: `… hedef şemada yok` / `hedefte olmayan sütunlar` | yönetim reposunda backend'e taşınmamış migration var (AGENTS.md → "Schema sync"); taşıyın, hedefi baştan kurun |
| import: `hedef boş değil` | prova tekrarıysa `--replace`; geçiş gecesiyse hedefin neden dolu olduğunu anlayın |
| verify: `hedef beklenenden farklı` | import'tan sonra bir şey yazdı (API açık mı? cron?) → `import --replace`, sonra verify |
| verify: `kaynak metadata … uyuşmuyor` | dosya Supabase'te metadata'sından farklı; dosya esas alınır, not düşülür |
| verify: `giriş denemesi` | API'nin `DATABASE_URL`/`JWT_SECRET`'ı; şifre hash'leri aynen taşındığı için şifre hatası beklenmez |
| Geri dönüş | Supabase'e hiç yazılmadı; uygulamalar eski adreste kalır (S17) |

## Süre (prova, 2026-11-23)

Testcontainers'ta, seed verisi (iki okul, her rol) + 5 dosya: export ~0,1 sn,
import ~0,06 sn, verify ~0,15 sn. Canlı veri bunun birkaç katı (7 kullanıcı,
15 dosya / ~865 KB); süreyi ağ belirler (Supabase'ten indirme). Geçiş
penceresi için veri adımı < 1 dk tahmini; gerçek ölçüm canlı export
provasında (KULLANICI EYLEMİ) alınır.
