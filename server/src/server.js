// Entry point: reads env, opens SQLite, serves HTTP, prunes stale data.
//   PORT=8787  DATA_DIR=/data  REGISTRATION=open|code|closed  REGISTRATION_CODE=...
//   TRUST_PROXY=<number of reverse proxies in front, 1 behind Coolify/Traefik>
//   MAX_DEVICES_PER_USER=20  MAX_USERS=10000
//   PUBLIC_URL=https://usage.example.com (optional; else the dashboard's origin is used for Telegram webhooks)
//   TELEGRAM_SECRET=... (optional; else a key file in DATA_DIR encrypts stored bot tokens)
import { mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createApp } from './app.js';
import { openDatabase } from './db.js';
import { loadSecretKey } from './telegram/secret-box.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const REPORT_RETENTION_MS = 30 * DAY_MS;
const UNUSED_ACCOUNT_MS = 7 * DAY_MS; // registered but no device ever reported
const INACTIVE_ACCOUNT_MS = 180 * DAY_MS;
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;
const MIN_CODE_LENGTH = 8;
const REGISTRATION_MODES = ['open', 'code', 'closed'];
const HTTP_LIMITS = Object.freeze({
  headersTimeout: 10_000,
  requestTimeout: 15_000,
  keepAliveTimeout: 5_000,
  maxConnections: 1_000,
});

function positiveInt(env, key, fallback) {
  const value = Number(env[key] ?? fallback);
  if (!Number.isInteger(value) || value < 1) throw new Error(`${key} must be an integer >= 1`);
  return value;
}

function proxyHops(value) {
  if (value === undefined || value === '' || value === '0' || value === 'false') return 0;
  if (value === 'true') return 1;
  const hops = Number(value);
  if (!Number.isInteger(hops) || hops < 0) throw new Error('TRUST_PROXY must be the number of proxies in front (0, 1, 2…)');
  return hops;
}

export function readSettings(env) {
  const mode = env.REGISTRATION ?? (env.REGISTRATION_CODE ? 'code' : 'open');
  if (!REGISTRATION_MODES.includes(mode)) throw new Error(`REGISTRATION must be one of ${REGISTRATION_MODES.join('|')}`);
  if (mode === 'code' && (env.REGISTRATION_CODE ?? '').length < MIN_CODE_LENGTH) {
    throw new Error(`REGISTRATION=code needs REGISTRATION_CODE (>= ${MIN_CODE_LENGTH} chars)`);
  }
  return {
    port: Number(env.PORT ?? 8787),
    dataDir: env.DATA_DIR ?? './data',
    registration: { mode, code: env.REGISTRATION_CODE },
    proxyHops: proxyHops(env.TRUST_PROXY),
    maxDevicesPerUser: positiveInt(env, 'MAX_DEVICES_PER_USER', 20),
    maxUsers: positiveInt(env, 'MAX_USERS', 10_000),
    publicUrl: env.PUBLIC_URL || undefined,
    telegramSecret: env.TELEGRAM_SECRET || undefined,
  };
}

export async function startServer(settings, log = () => {}) {
  mkdirSync(settings.dataDir, { recursive: true });
  const db = openDatabase(join(settings.dataDir, 'tracker.db'));
  const prune = () => {
    const now = Date.now();
    const iso = (ms) => new Date(now - ms).toISOString();
    db.prune({
      reportsBefore: iso(REPORT_RETENTION_MS),
      unusedUsersBefore: iso(UNUSED_ACCOUNT_MS),
      inactiveUsersBefore: iso(INACTIVE_ACCOUNT_MS),
    });
  };
  prune();
  const timer = setInterval(prune, PRUNE_INTERVAL_MS).unref();

  const telegram = { key: loadSecretKey({ dataDir: settings.dataDir, secret: settings.telegramSecret }), publicUrl: settings.publicUrl, ...settings.telegram };
  const server = Object.assign(createServer(createApp({ ...settings, db, log, telegram })), HTTP_LIMITS);
  server.on('clientError', (_error, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
  });
  server.on('close', () => {
    clearInterval(timer);
    db.close();
  });
  await new Promise((resolve) => server.listen(settings.port, resolve));
  return server;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const log = (msg) => process.stderr.write(`${new Date().toISOString()} ${msg}\n`);
  process.on('unhandledRejection', (reason) => log(`unhandled rejection: ${reason?.stack ?? reason}`));
  try {
    const settings = readSettings(process.env);
    const server = await startServer(settings, log);
    log(`usage tracker server on :${settings.port} (registration: ${settings.registration.mode})`);
    const shutdown = () => server.close(() => process.exit(0));
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
  } catch (error) {
    log(error.message);
    process.exit(1);
  }
}
