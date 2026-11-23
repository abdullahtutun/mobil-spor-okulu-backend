# Mobil Spor Okulu Backend

Yönetim ve veli uygulamalarının Supabase yerine kullanacağı, Türkiye'deki
VPS'te çalışan NestJS + PostgreSQL backend'i.

- Mimari ve kurallar: [AGENTS.md](AGENTS.md)
- Geçiş planı: [docs/migration/PLAN.md](docs/migration/PLAN.md)
- İlerleme: [docs/migration/PROGRESS.md](docs/migration/PROGRESS.md)

## Kurulum

Gerekenler: Node 24, npm, Docker (bu makinede colima; Compose eklentisi
dahil — ayrıntı AGENTS.md → "Docker on this Mac").

```bash
npm ci
cp .env.example .env
docker compose up -d db      # Postgres 17 + pg_cron, yalnızca 127.0.0.1:5432
npm run db:migrate
npm run start:dev            # http://localhost:3000/health
```

## Komutlar

| Komut | Ne yapar |
|---|---|
| `npm run start:dev` | API'yi izleme modunda açar |
| `npm test` | birim testleri |
| `npm run test:e2e` | Testcontainers ile gerçek Postgres'e karşı testler |
| `npm run lint` | ESLint + Prettier denetimi (`lint:fix` düzeltir) |
| `npm run db:migrate` / `db:rollback` / `db:new -- <ad>` | dbmate |
| `docker compose --profile api up -d --build` | API imajını da (Coolify'ın build ettiği) çalıştırır |

## Bir geçiş oturumu çalıştırmak

```bash
cd ~/FlutterProjects/mobil_spor_okulu_backend
claude --add-dir ../mobil_spor_okulu --add-dir ../mobil_spor_okulu_veli --add-dir ../mobil_spor_okulu_site
```

Claude Code içinde `/oturum` (sıradaki oturum) ya da `/oturum S05`.
