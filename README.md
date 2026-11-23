# Mobil Spor Okulu Backend

Yönetim ve veli uygulamalarının Supabase yerine kullanacağı, Türkiye'deki
VPS'te çalışan NestJS + PostgreSQL backend'i.

- Mimari ve kurallar: [AGENTS.md](AGENTS.md)
- Geçiş planı: [docs/migration/PLAN.md](docs/migration/PLAN.md)
- İlerleme: [docs/migration/PROGRESS.md](docs/migration/PROGRESS.md)

## Bir geçiş oturumu çalıştırmak

```bash
cd ~/FlutterProjects/mobil_spor_okulu_backend
claude --add-dir ../mobil_spor_okulu --add-dir ../mobil_spor_okulu_veli --add-dir ../mobil_spor_okulu_site
```

Claude Code içinde `/oturum` (sıradaki oturum) ya da `/oturum S05`.
