# S17 — Geçiş provası ve canlıya geçiş

**Repo:** hepsi · **Bağımlı:** hepsi

## Amaç
Supabase'ten yeni backend'e veri kaybı olmadan, planlı ve geri alınabilir
bir bakım penceresiyle geçmek; sonra Supabase'i güvenle kapatmak.

## Okunacaklar
- `PROGRESS.md` (bütün günlük), `RUNBOOK-data.md`, `docs/ops/*`
- S02 teslim notu (zorunlu güncelleme kapısını taşıyan sürümler)

## Yapılacaklar
- **S11'den:** geçişte Supabase'teki push dürtmesi (pg_net + Vault →
  send-push) kapanmalı, yoksa iki taraf aynı token'lara gönderir (veri
  taşındıktan sonra Supabase'te yazım olmamalı zaten). Yönetim reposundaki
  send-push'un `data`'sına kişisel veri sızıyor (`names`, `athlete_name`) —
  backend'de düzeltildi; canlıda da düzeltilmesi önerildi (PROGRESS, S11).
- [ ] `docs/migration/RUNBOOK-cutover.md`: dakika dakika plan, her adımın
      sahibi, doğrulama komutu ve geri alma noktası. İçermesi gerekenler:
  - **Önce (T-1 hafta):** S02 kapısının yaygınlığı (kaç kullanıcı kapılı
    sürümde); yeni uygulama sürümleri `migrate/own-backend` dalından build
    edilip mağaza incelemesine gönderilir, **elle yayın** seçeneğiyle
    bekletilir; tam prova (S16 sunucusunda, taze export ile, süre ölçülür);
    okullara bakım duyurusu.
  - **Pencere:** Supabase'te cron işleri durdurulur → yazmalar durdurulur
    (bakım modu) → export → import → verify → sunucuda smoke test →
    mağaza sürümleri yayınlanır, web bundle'ları ve site güncellenir →
    Supabase'te `app_min_versions.min_build` yeni build'e çekilir (S02:
    anahtar `(app, brand, platform)`, iki uygulama × iki marka × iki
    platform; iOS satırlarına önce `store_url` yazılmalı).
  - **Geri alma:** mağaza sürümü yayınlanmadan önce her adımda Supabase'e
    dönülebilir (bakım modunu kaldır, cron'u aç); sonrası için ne
    yapılacağı.
  - **Sonra:** 24 saat yakından izleme; Supabase projesi birkaç hafta yalnızca
    güncelleme kapısı için açık kalır, sonra veri ve proje silinir
    (KVKK: taşınan verinin eski kopyası tutulmaz); export dosyaları silinir.
- [ ] Geçiş dallarının (`migrate/own-backend`) `main`'e alınması.
- [ ] Yönetim reposundaki `supabase/` klasörünün akıbeti (arşiv ya da silme)
      ve migration'ların bundan sonra yalnızca backend reposunda olduğu
      `AGENTS.md`'lere.
- [ ] Prova: runbook'u baştan sona provada uygula, süreleri ve sorunları
      günlüğe yaz, runbook'u düzelt.
- [ ] Canlıya geçiş: kullanıcıyla birlikte, kullanıcının belirlediği gün.

## Kabul kriterleri
- Prova runbook'a göre sorunsuz tamamlandı.
- Canlıya geçişten sonra: verify sıfır fark, iki uygulamada giriş ve ana
  akışlar çalışıyor, push ve e-posta gidiyor, ilk gece cron işleri hatasız.

## Teslim notu
_(oturum sonunda doldurulur)_

> **S12'den:** veri adımı `docs/migration/RUNBOOK-data.md` (export → import
> `--storage-prefix <API>/storage/` → verify → resume-cron → API aç → export
> klasörünü sil). Oturumlar varsayılan olarak taşınmıyor (`--with-sessions`).
