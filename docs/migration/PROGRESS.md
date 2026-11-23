# İlerleme

`/oturum` her oturumun başında bu dosyayı okur, sonunda günceller.

Durum değerleri: `bekliyor` · `devam` · `kısmen` (yarım kaldı; kalanlar
oturum dosyasında işaretli) · `tamam`.

| Oturum | Durum | Tarih | Not |
|---|---|---|---|
| S00 | tamam | 2026-10-25 | Plan, envanter, oturum dosyaları, `/oturum` skill'i |
| S01 | bekliyor | | |
| S02 | bekliyor | | |
| S03 | bekliyor | | |
| S04 | bekliyor | | |
| S05 | bekliyor | | |
| S06 | bekliyor | | |
| S07 | bekliyor | | |
| S08 | bekliyor | | |
| S09 | bekliyor | | |
| S10 | bekliyor | | |
| S11 | bekliyor | | |
| S12 | bekliyor | | |
| S13 | bekliyor | | |
| S14 | bekliyor | | |
| S15 | bekliyor | | |
| S16 | bekliyor | | |
| S17 | bekliyor | | |

## Açık sorular

Kullanıcıya sorulacak ya da ilgili oturumda karara bağlanacak konular.
Cevaplanınca buradan silinip ilgili oturumun günlüğüne yazılır.

- API alan adı: `api.mobilsporokulu.com` mu, marka başına ayrı mı? (S16)
- VPS'in boyutu ve Coolify'da çalışan diğer servisler (RAM bütçesi). (S16)
- Yedeklerin gideceği ikinci yurt içi S3 uyumlu depolama. (S16)

VPS'te Coolify kurulu (2026-10-26) → PLAN.md K15, S16 buna göre yazıldı.

## Günlük

En yeni en üstte. Her oturum bir bölüm ekler: ne yapıldı, plandan sapmalar,
sonraki oturumların bilmesi gerekenler.

### Karar — PocketBase karşılaştırması (2026-11-22)
- Soru: public flavor PocketBase'e, Dev Adım Supabase'te mi kalsın? Karar:
  **hayır, iki marka birlikte NestJS'e** (PLAN.md K16).
- RAM ölçümü (colima, arm64; 1,5 M yoklama satırı; aynı uç nokta: sporcunun
  yoklama sayıları, PocketBase'te JS hook, NestJS'te transaction +
  `set_config('request.jwt.claims')`; cgroup `anon+file−inactive_file`):

  | Senaryo | PocketBase 0.40.6 | Postgres 17 + NestJS 11 |
  |---|---|---|
  | Boşta | 72 MB | 17 + 32 = 49 MB |
  | ~40 istek/sn | 137 MB | 58 + 66 = 124 MB |
  | 20 eşzamanlı (~5000 istek/sn) | 710–910 MB, yük bitince geri vermedi | 158 + 99 = 257 MB |
  | Aynısı, `shared_buffers=32MB`, `max_connections=25`, `work_mem=2MB` | — | 55 + 101 = 156 MB (~3700 istek/sn) |

  `GOMEMLIMIT` ve küçük `--hooksPool` PocketBase'in büyümesini durdurmadı.
  Ölçülen NestJS tek uç noktalıydı; gerçek API (auth, mail, firebase-admin,
  ws) boşta muhtemelen 80–150 MB olur. S16 RAM bütçesinde bu sayılar ve
  küçük Postgres ayarları kullanılabilir.

### S00 — Hazırlık (2026-10-25)
- Repo açıldı; `AGENTS.md`, `docs/migration/{PLAN,INVENTORY,PROGRESS}.md`,
  17 oturum dosyası ve `.claude/skills/oturum/` yazıldı.
- Envanter iki uygulamanın `lib/` ve yönetim uygulamasının `supabase/`
  klasörlerinden çıkarıldı (`INVENTORY.md`). Canlı veritabanına bakılmadı;
  S03 dump'ı alınca eksikleri tamamlar.
- Henüz kod yok; `AGENTS.md` → "Commands" bölümündeki komutları S01 kurar.
