---
name: oturum
description: Supabase → NestJS geçişinin bir oturumunu (S01…S17) yürütür. Kullanıcı "/oturum S05", "/oturum" ya da "sıradaki oturumu çalıştır" dediğinde kullanılır.
argument-hint: "[Sxx]  (boş bırakılırsa sıradaki uygun oturum)"
---

# Geçiş oturumu

Bu skill `docs/migration/` altındaki plana göre **tek bir oturumu** baştan
sona yürütür. Her oturum bağımsız bir Claude Code oturumunda çalışır; önceki
oturumların bilgisi yalnızca repodaki dosyalardan gelir. Bu yüzden okumak
ve sonunda yazmak, kod yazmak kadar önemlidir.

## 1. Bağlamı yükle

Sırayla oku:

1. `AGENTS.md` — mimari kararlar ve kurallar.
2. `docs/migration/PLAN.md` — kararlar tablosu, oturum listesi, değişmez kurallar.
3. `docs/migration/PROGRESS.md` — durumlar, açık sorular, günlük (önceki
   oturumların notları; özellikle "sonraki oturumların bilmesi gerekenler").
4. Hedef oturum dosyası `docs/migration/sessions/Sxx-*.md`.
5. Oturum dosyasının "Okunacaklar" bölümündeki dosyalar. Kardeş repolarda
   çalışılacaksa o reponun `AGENTS.md`'si de (yönetim uygulamasınınki ortak
   kuralları tanımlar).

## 2. Oturumu seç ve doğrula

- Argüman verildiyse (`S05`) o oturum. Verilmediyse `PROGRESS.md`'de durumu
  `kısmen` olan ilk oturum, yoksa bağımlılıkları `tamam` olan ilk `bekliyor`
  oturum (PLAN.md'deki önerilen sıra).
- Bağımlılıklardan biri `tamam` değilse **dur** ve kullanıcıya hangisinin
  eksik olduğunu söyle; kullanıcı açıkça "yine de devam et" derse devam et
  ve bunu günlüğe yaz.
- Kardeş repo gerekiyorsa erişilebilir olduğunu kontrol et
  (`../mobil_spor_okulu`, `../mobil_spor_okulu_veli`, `../mobil_spor_okulu_site`).
  Erişilemiyorsa kullanıcıya oturumu şu komutla başlatmasını söyle:
  `claude --add-dir ../mobil_spor_okulu --add-dir ../mobil_spor_okulu_veli --add-dir ../mobil_spor_okulu_site`
- Kardeş repolarda çalışmaya başlamadan önce `git status` ile temiz
  olduklarını kontrol et; temiz değilse kullanıcıya sor.

## 3. Başla

- `PROGRESS.md`'de oturumun durumunu `devam` yap, tarihi yaz.
- Kullanıcıya 3–6 maddelik kısa bir plan göster: oturum dosyasındaki
  yapılacaklardan bu oturumda neyi nasıl yapacağın, varsa önceki
  oturumlardan gelen sapmalar. Oturum dosyasında "Karar gerekiyor" diye
  işaretli bir konu varsa önce onu sor. Başka bir şey için onay bekleme.

## 4. Uygula

- Oturum dosyasındaki "Yapılacaklar" listesini izle, bitirdikçe `[x]` yap.
- Kapsam dışı işe girme. Sonraki bir oturuma ait bir eksik görürsen
  yapma; `PROGRESS.md` → günlüğe "sonraki oturumlar için" notu olarak yaz.
- Plandaki bir karar uygulanamıyorsa ya da daha iyi bir yol görürsen:
  küçükse uygula ve günlüğe gerekçesiyle yaz; bir kararı (K1…K15)
  değiştiriyorsa önce kullanıcıya sor, sonra `PLAN.md` ve `AGENTS.md`'yi
  güncelle.
- Değişmez kurallar: canlı Supabase'e yazma yok; kişisel veri içeren dosya
  repoya girmez; sır `.env` dışında durmaz.
- Bağlam dolmaya yaklaşırsa ya da iş bir oturuma sığmıyorsa tutarlı bir
  noktada dur (testler geçiyor olmalı), kalanları oturum dosyasında
  işaretsiz bırak ve durumu `kısmen` yap.

## 5. Doğrula

Oturum dosyasındaki "Kabul kriterleri"nin her birini gerçekten çalıştırarak
kontrol et. En az:

- backend: `npm run lint`, `npm test`, ilgiliyse `npm run test:e2e`
- Flutter repoları: `flutter analyze`, `flutter test`

Geçmeyen bir kriter varsa düzelt; düzeltemiyorsan oturumu `kısmen` bırak ve
sebebini çıktısıyla birlikte günlüğe yaz. Geçti diye yazmak için çalıştırmış
olmak gerekir.

## 6. Devret

1. Oturum dosyasının sonundaki "Teslim notu" bölümünü doldur: ne yapıldı,
   nerede (dosya yolları), nasıl test edildi, bilinen eksikler.
2. `PROGRESS.md`:
   - tablo satırı: durum (`tamam` / `kısmen`), tarih, tek satır not;
   - günlüğün **en üstüne** yeni bölüm: yapılanlar, sapmalar, sonraki
     oturumların bilmesi gerekenler;
   - açık sorular listesini güncelle.
3. Bir oturum dosyasının varsayımını değiştirdiysen (ör. bir endpoint adı)
   etkilenen sonraki oturum dosyalarını da güncelle.
4. `AGENTS.md`'deki komutlar, klasör yapısı ya da kurallar değiştiyse güncelle.
5. Değişiklikleri repo repo özetle ve commit için kullanıcıya sor. Onay
   gelirse her repoda ayrı commit at; mesaj `feat(migration): S05 auth core`
   biçiminde, sonunda sistemin verdiği attribution satırı.
6. Kullanıcıya son mesajda: oturumun sonucu, doğrulama çıktılarının özeti ve
   sıradaki oturum (`/oturum S06`).
