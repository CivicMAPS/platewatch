/**
 * PlateWatch backend entry point. Configuration by environment (docs/BACKEND.md):
 *   DATABASE_URL                 postgres://… (required)
 *   PLATEWATCH_DEVICE_TOKEN      bearer token handsets present (required, ≥ 24 chars)
 *   PLATEWATCH_CONSOLE_TOKEN     bearer token for the CommandMAPS console (required, ≥ 24 chars)
 *   PLATEWATCH_COUNCIL           council code the I-N statements must name (default "com")
 *   PLATEWATCH_CORS_ORIGINS      comma-separated origins, or * (default *; tokens are bearer, no cookies)
 *   PLATEWATCH_APP_DIR           built PlateWatch app to serve at / (default ./dist when present)
 *   PORT                         default 8787
 */
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pkg from '../package.json' with { type: 'json' };
import { createApp } from './app';
import { createPool, migrate } from './db';

const here = dirname(fileURLToPath(import.meta.url));
const env = process.env;

function required(name: string, minLength = 1): string {
  const v = env[name]?.trim() ?? '';
  if (v.length < minLength) {
    console.error(`[platewatch-server] ${name} is required${minLength > 1 ? ` (at least ${minLength} characters)` : ''}.`);
    process.exit(2);
  }
  return v;
}

const databaseUrl = required('DATABASE_URL');
const deviceToken = required('PLATEWATCH_DEVICE_TOKEN', 24);
const consoleToken = required('PLATEWATCH_CONSOLE_TOKEN', 24);
if (deviceToken === consoleToken) {
  console.error('[platewatch-server] PLATEWATCH_DEVICE_TOKEN and PLATEWATCH_CONSOLE_TOKEN must differ.');
  process.exit(2);
}
const appDirCandidate = resolve(env.PLATEWATCH_APP_DIR ?? resolve(here, '../dist'));
const consoleDir = [resolve(here, 'console'), resolve(here, '../server/console')].find((d) => existsSync(d))!;
const tokensDir = [resolve(here, 'civicmaps'), resolve(here, '../src/styles/civicmaps')].find((d) => existsSync(d));

const db = createPool(databaseUrl);
const applied = await migrate(db);
if (applied.length) console.log(`[platewatch-server] migrations applied: ${applied.join(', ')}`);

const handler = createApp(db, {
  council: (env.PLATEWATCH_COUNCIL ?? 'com').trim(),
  deviceToken,
  consoleToken,
  corsOrigins: (env.PLATEWATCH_CORS_ORIGINS ?? '*').split(',').map((s) => s.trim()).filter(Boolean),
  appDir: existsSync(resolve(appDirCandidate, 'index.html')) ? appDirCandidate : undefined,
  consoleDir,
  tokensDir,
  version: pkg.version,
});

const port = Number(env.PORT ?? 8787);
const server = createServer((req, res) => void handler(req, res));
server.listen(port, () => console.log(`[platewatch-server] listening on :${port} (console /console/, council ${env.PLATEWATCH_COUNCIL ?? 'com'})`));

const stop = () => server.close(() => void db.end().then(() => process.exit(0)));
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
