// Request handling for the tracker server: website, registration, per-user device reports and limits.
import { readFileSync } from 'node:fs';
import { computeShares, isValidDeviceName, validateReport } from '../../plugin/scripts/core.js';
import { applyLimits, deviceStatus, NO_LIMITS, validateLimits } from '../../plugin/scripts/limits.js';
import { generateToken, hashToken, isWellFormedToken, safeEqual } from './auth.js';
import { bearerToken, clientIp, HttpError, readJsonBody, sendFile, sendJson } from './http.js';
import { createRateLimiter } from './ratelimit.js';

const MINUTE_MS = 60 * 1000;
const REGISTER_LIMIT_PER_HOUR = 5;
const REPORTS_PER_MINUTE = 30;
const REQUESTS_PER_MINUTE_PER_IP = 300;
const ACTIVE_WINDOW_DAYS = 7;
const DAY_MS = 24 * 60 * MINUTE_MS;

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

const STATIC_FILES = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/favicon.svg': ['favicon.svg', 'image/svg+xml'],
};

function loadStatic() {
  const dir = new URL('../public/', import.meta.url);
  return Object.fromEntries(
    Object.entries(STATIC_FILES).map(([path, [file, type]]) => [
      path,
      { body: readFileSync(new URL(file, dir)), type, csp: type.startsWith('text/html') ? CSP : null },
    ]),
  );
}

function parsePath(rawUrl) {
  try {
    return new URL(rawUrl, 'http://localhost').pathname;
  } catch {
    throw new HttpError(400, 'bad request');
  }
}

function decodeDeviceName(encoded) {
  let name;
  try {
    name = decodeURIComponent(encoded);
  } catch {
    throw new HttpError(400, 'invalid device name');
  }
  if (!isValidDeviceName(name)) throw new HttpError(400, 'invalid device name');
  return name;
}

async function readValidated(req, validate) {
  try {
    return validate(await readJsonBody(req));
  } catch (error) {
    throw error instanceof HttpError ? error : new HttpError(400, error.message);
  }
}

/**
 * @param {{ db: object, registration: { mode: 'open'|'code'|'closed', code?: string }, proxyHops?: number,
 *           maxDevicesPerUser?: number, maxUsers?: number, log?: (msg: string) => void }} options
 */
export function createApp({ db, registration, proxyHops = 0, maxDevicesPerUser = 20, maxUsers = 10_000, log = () => {} }) {
  const staticFiles = loadStatic();
  const ipLimiter = createRateLimiter({ limit: REQUESTS_PER_MINUTE_PER_IP, windowMs: MINUTE_MS });
  const registerLimiter = createRateLimiter({ limit: REGISTER_LIMIT_PER_HOUR, windowMs: 60 * MINUTE_MS });
  const reportLimiter = createRateLimiter({ limit: REPORTS_PER_MINUTE, windowMs: MINUTE_MS });

  function authenticate(req) {
    const token = bearerToken(req);
    const user = isWellFormedToken(token) ? db.findUserByTokenHash(hashToken(token)) : null;
    if (!user) throw new HttpError(401, 'invalid or missing token');
    return user;
  }

  async function register(req) {
    if (registration.mode === 'closed') throw new HttpError(403, 'registration is closed on this server');
    if (!registerLimiter(clientIp(req, proxyHops))) throw new HttpError(429, 'too many registrations, try later');
    const body = await readJsonBody(req);
    if (registration.mode === 'code' && !safeEqual(body?.code ?? '', registration.code)) {
      throw new HttpError(403, 'invalid registration code');
    }
    if (db.countUsers() >= maxUsers) throw new HttpError(503, 'this server has reached its account limit');
    const token = generateToken();
    db.createUser(hashToken(token), new Date().toISOString());
    return { token };
  }

  function limitedSummary(user) {
    const reports = db.listReports(user.id);
    const limits = db.listLimits(user.id);
    const devices = reports.map((r) => ({ name: r.device, reportedAt: r.reportedAt, limits: limits[r.device] ?? NO_LIMITS }));
    return { summary: { ...applyLimits(computeShares(reports), limits), devices }, limits };
  }

  async function report(req, user) {
    if (!reportLimiter(`u${user.id}`)) throw new HttpError(429, 'too many reports');
    const clean = await readValidated(req, validateReport);
    if (!db.hasDevice(user.id, clean.device) && db.countDevices(user.id) >= maxDevicesPerUser) {
      throw new HttpError(403, `device limit (${maxDevicesPerUser}) reached — remove an old device on the website`);
    }
    db.upsertReport(user.id, clean);
    const { summary, limits } = limitedSummary(user);
    return { device: clean.device, status: deviceStatus(summary, clean.device, limits[clean.device]) };
  }

  async function setLimits(req, user, encodedName) {
    const name = decodeDeviceName(encodedName);
    const limits = await readValidated(req, validateLimits);
    if (!db.hasDevice(user.id, name)) throw new HttpError(404, 'device not found');
    db.setLimits(user.id, name, limits);
    return { device: name, limits };
  }

  function removeDevice(user, encodedName) {
    const name = decodeDeviceName(encodedName);
    if (!db.deleteDevice(user.id, name)) throw new HttpError(404, 'device not found');
    return { removed: name };
  }

  /** Public, aggregate only: how many accounts and devices reported recently. */
  function stats() {
    const since = new Date(Date.now() - ACTIVE_WINDOW_DAYS * DAY_MS).toISOString();
    const { users, devices } = db.countActive(since);
    return { activeUsers: users, activeDevices: devices, windowDays: ACTIVE_WINDOW_DAYS };
  }

  function me(user) {
    const devices = db.listReports(user.id).map((r) => ({ name: r.device, reportedAt: r.reportedAt }));
    return { createdAt: user.createdAt, devices, maxDevices: maxDevicesPerUser };
  }

  function deleteMe(user) {
    db.deleteUser(user.id);
    return { deleted: true };
  }

  const routes = [
    ['GET', /^\/health$/, () => ({ ok: true })],
    ['GET', /^\/api\/config$/, () => ({ registration: registration.mode })],
    ['GET', /^\/api\/stats$/, () => stats()],
    ['POST', /^\/api\/register$/, (req) => register(req)],
    ['GET', /^\/api\/me$/, (req) => me(authenticate(req))],
    ['DELETE', /^\/api\/me$/, (req) => deleteMe(authenticate(req))],
    ['POST', /^\/api\/report$/, (req) => report(req, authenticate(req))],
    ['GET', /^\/api\/summary$/, (req) => limitedSummary(authenticate(req)).summary],
    ['PUT', /^\/api\/devices\/([^/]+)\/limits$/, (req, m) => setLimits(req, authenticate(req), m[1])],
    ['DELETE', /^\/api\/devices\/([^/]+)$/, (req, m) => removeDevice(authenticate(req), m[1])],
  ];

  return async function handle(req, res) {
    let pathname = req.url;
    try {
      pathname = parsePath(req.url);
      if (!ipLimiter(clientIp(req, proxyHops))) throw new HttpError(429, 'too many requests');
      if (req.method === 'GET' && staticFiles[pathname]) return sendFile(res, staticFiles[pathname]);
      const route = routes.find(([method, re]) => method === req.method && re.test(pathname));
      if (!route) throw new HttpError(404, 'not found');
      const data = await route[2](req, pathname.match(route[1]));
      const status = req.method === 'POST' && pathname === '/api/register' ? 201 : 200;
      sendJson(res, status, { success: true, data, error: null });
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      if (status === 500) log(`error ${req.method} ${pathname}: ${error.stack}`);
      sendJson(res, status, { success: false, data: null, error: status === 500 ? 'internal error' : error.message });
    }
  };
}
