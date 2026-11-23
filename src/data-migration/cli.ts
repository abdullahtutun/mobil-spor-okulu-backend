/**
 * Veri taşıma komutları (S12; geçiş gecesi S17). Kullanım:
 * docs/migration/RUNBOOK-data.md.
 *
 *   node dist/data-migration/cli.js export --out exports/<tarih> [--with-sessions]
 *       SOURCE_DATABASE_URL, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 *   node dist/data-migration/cli.js import --from exports/<tarih> [--storage-prefix <API>/storage/] [--replace]
 *       DATABASE_URL (hedef, postgres), STORAGE_ROOT
 *   node dist/data-migration/cli.js verify --from exports/<tarih> [--storage-prefix …]
 *       [--api-url … --login-email … ] (şifre: VERIFY_LOGIN_PASSWORD)
 *   node dist/data-migration/cli.js resume-cron --from exports/<tarih>
 */
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { exportData } from './export';
import { importData, resumeCron } from './import';
import { SupabaseStorageSource } from './storage-source';
import { verifyData } from './verify';

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} tanımlı değil`);
  return value;
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  const { values } = parseArgs({
    args: rest,
    options: {
      out: { type: 'string' },
      from: { type: 'string' },
      'with-sessions': { type: 'boolean', default: false },
      replace: { type: 'boolean', default: false },
      'storage-prefix': { type: 'string' },
      'old-storage-prefix': { type: 'string' },
      'api-url': { type: 'string' },
      'login-email': { type: 'string' },
      sample: { type: 'string' },
    },
  });
  const log = (line: string) => console.log(line);
  const started = Date.now();
  switch (command) {
    case 'export': {
      if (!values.out) throw new Error('--out gerekli');
      await exportData({
        sourceUrl: env('SOURCE_DATABASE_URL'),
        outDir: values.out,
        storage: new SupabaseStorageSource(
          env('SUPABASE_URL'),
          env('SUPABASE_SERVICE_ROLE_KEY'),
        ),
        withSessions: values['with-sessions'],
        log,
      });
      break;
    }
    case 'import': {
      if (!values.from) throw new Error('--from gerekli');
      await importData({
        targetUrl: env('DATABASE_URL'),
        exportDir: values.from,
        storageRoot: env('STORAGE_ROOT'),
        newStoragePrefix: values['storage-prefix'],
        oldStoragePrefix: values['old-storage-prefix'],
        replace: values.replace,
        log,
      });
      break;
    }
    case 'verify': {
      if (!values.from) throw new Error('--from gerekli');
      const report = await verifyData({
        targetUrl: env('DATABASE_URL'),
        exportDir: values.from,
        storageRoot: env('STORAGE_ROOT'),
        newStoragePrefix: values['storage-prefix'],
        oldStoragePrefix: values['old-storage-prefix'],
        sampleSize: values.sample ? Number(values.sample) : undefined,
        login:
          values['api-url'] && values['login-email']
            ? {
                apiUrl: values['api-url'],
                email: values['login-email'],
                password: env('VERIFY_LOGIN_PASSWORD'),
              }
            : undefined,
        log,
      });
      await writeFile(
        join(values.from, 'verify-report.json'),
        JSON.stringify(report, null, 2),
        { mode: 0o600 },
      );
      log(
        `rapor: ${join(values.from, 'verify-report.json')} (${Date.now() - started} ms)`,
      );
      return report.ok ? 0 : 1;
    }
    case 'resume-cron': {
      if (!values.from) throw new Error('--from gerekli');
      const names = await resumeCron(env('DATABASE_URL'), values.from);
      log(`cron açıldı: ${names.join(', ')}`);
      break;
    }
    default:
      throw new Error('komut: export | import | verify | resume-cron');
  }
  log(`${command}: ${Date.now() - started} ms`);
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(2);
  },
);
