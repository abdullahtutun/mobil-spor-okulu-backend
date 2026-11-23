#!/usr/bin/env node
// api_authenticator rolüne API_DATABASE_URL'deki parolayı yazar.
//
// Rol db/compat/00_roles.sql'de parolasız oluşturulur (sır repoya girmez).
// Yerelde bir kez, `npm run db:migrate`'ten sonra:
//
//   npm run db:api-password
//
// DATABASE_URL (postgres) ile bağlanır; parola hiçbir yere yazdırılmaz.
// Üretimde aynı işi S16 yapar.
import { existsSync } from 'node:fs';
import pg from 'pg';

if (existsSync('.env')) process.loadEnvFile('.env');

const { DATABASE_URL, API_DATABASE_URL } = process.env;
if (!DATABASE_URL || !API_DATABASE_URL) {
  console.error('DATABASE_URL ve API_DATABASE_URL gerekli (.env.example).');
  process.exit(1);
}

const apiUrl = new URL(API_DATABASE_URL);
const role = decodeURIComponent(apiUrl.username);
const password = decodeURIComponent(apiUrl.password);
if (role !== 'api_authenticator') {
  console.error(`API_DATABASE_URL api_authenticator olmalı, "${role}" değil.`);
  process.exit(1);
}
if (password.length < 12) {
  console.error('API_DATABASE_URL parolası en az 12 karakter olmalı.');
  process.exit(1);
}

const client = new pg.Client({ connectionString: DATABASE_URL });
await client.connect();
try {
  await client.query(
    `alter role api_authenticator password ${client.escapeLiteral(password)}`,
  );
  console.log('api_authenticator parolası ayarlandı.');
} finally {
  await client.end();
}
