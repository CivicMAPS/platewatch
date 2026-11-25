/**
 * PlateWatch backend entry point. Configuration by environment (docs/BACKEND.md):
 *   DATABASE_URL                 postgres://… (or PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE)
 *   PLATEWATCH_DB_CA_FILE        CA bundle to verify the database's TLS certificate (Amazon RDS)
 *   PLATEWATCH_DEVICE_TOKEN      bearer token handsets present (required, ≥ 24 chars)
 *   PLATEWATCH_CONSOLE_TOKEN     bearer token for the CommandMAPS console (required, ≥ 24 chars)
 *   PLATEWATCH_COUNCIL           council code the I-N statements must name (default "com")
 *   PLATEWATCH_CORS_ORIGINS      comma-separated origins, or * (default *; tokens are bearer, no cookies)
 *   PLATEWATCH_APP_DIR           built PlateWatch app to serve at / (default ./dist when present)
 *   PLATEWATCH_TIMEZONE          council time zone for shift days (default Australia/Melbourne)
 *   PLATEWATCH_DEFAULT_BRANCH    branch for officers not in the roster (default parking)
 *   PLATEWATCH_HOT_ACK_SECONDS   seconds to acknowledge a hot-list pop-up before the soft Code 1 (default 60)
 *   PLATEWATCH_WATCHDOG_GRACE_SECONDS  extra wait before the server raises it itself (default 20)
 *   PLATEWATCH_RADIO_ESCALATE_SECONDS  auto-escalate to Code 1 with no radio response (default 0 = manual)
 *   PORT                         default 8787
 */
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pkg from '../package.json' with { type: 'json' };
import { createApp } from './app';
import { createPool, migrate } from './db';
import { runWatchdog, type SafetyConfig } from './safety';

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

// DATABASE_URL, or PGHOST + PGUSER + PGPASSWORD + PGDATABASE (AWS: from the RDS secret).
const databaseUrl = env.DATABASE_URL?.trim() || undefined;
if (!databaseUrl && !(env.PGHOST && env.PGUSER && env.PGDATABASE)) required('DATABASE_URL');
// PLATEWATCH_DB_CA_FILE: verify the database's TLS certificate against this CA bundle (RDS).
const dbCa = env.PLATEWATCH_DB_CA_FILE ? readFileSync(env.PLATEWATCH_DB_CA_FILE, 'utf8') : undefined;
const deviceToken = required('PLATEWATCH_DEVICE_TOKEN', 24);
const consoleToken = required('PLATEWATCH_CONSOLE_TOKEN', 24);
if (deviceToken === consoleToken) {
  console.error('[platewatch-server] PLATEWATCH_DEVICE_TOKEN and PLATEWATCH_CONSOLE_TOKEN must differ.');
  process.exit(2);
}
const appDirCandidate = resolve(env.PLATEWATCH_APP_DIR ?? resolve(here, '../dist'));
const consoleDir = [resolve(here, 'console'), resolve(here, '../server/console')].find((d) => existsSync(d))!;
const tokensDir = [resolve(here, 'civicmaps'), resolve(here, '../src/styles/civicmaps')].find((d) => existsSync(d));

const db = createPool(databaseUrl, { ca: dbCa });
const applied = await migrate(db);
if (applied.length) console.log(`[platewatch-server] migrations applied: ${applied.join(', ')}`);

const intEnv = (name: string, fallback: number) => (Number.isFinite(Number(env[name])) && env[name] !== '' && env[name] !== undefined ? Number(env[name]) : fallback);
const safety: SafetyConfig = {
  timeZone: env.PLATEWATCH_TIMEZONE ?? 'Australia/Melbourne',
  defaultBranch: env.PLATEWATCH_DEFAULT_BRANCH ?? 'parking',
  hotAckSeconds: intEnv('PLATEWATCH_HOT_ACK_SECONDS', 60),
  watchdogGraceSeconds: intEnv('PLATEWATCH_WATCHDOG_GRACE_SECONDS', 20),
  radioEscalateSeconds: intEnv('PLATEWATCH_RADIO_ESCALATE_SECONDS', 0),
};

const handler = createApp(db, {
  safety,
  council: (env.PLATEWATCH_COUNCIL ?? 'com').trim(),
  deviceToken,
  consoleToken,
  corsOrigins: (env.PLATEWATCH_CORS_ORIGINS ?? '*').split(',').map((s) => s.trim()).filter(Boolean),
  appDir: existsSync(resolve(appDirCandidate, 'index.html')) ? appDirCandidate : undefined,
  consoleDir,
  tokensDir,
  version: pkg.version,
});

// Raise the soft Code 1 for hits the handset could not report (and auto-escalate if configured).
setInterval(() => void runWatchdog(db, safety, Date.now()).then((r) => (r.softCode1.length || r.escalated.length) && console.log('[watchdog]', r)).catch((e) => console.error('[watchdog]', e)), 5000);

const port = Number(env.PORT ?? 8787);
const server = createServer((req, res) => void handler(req, res));
server.listen(port, () => console.log(`[platewatch-server] listening on :${port} (console /console/, council ${env.PLATEWATCH_COUNCIL ?? 'com'})`));

const stop = () => server.close(() => void db.end().then(() => process.exit(0)));
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
