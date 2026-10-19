// HTTP client for the tracker server. Everything coming back is sanitized before use.
import { cleanText, sanitizeDeviceList, sanitizeStatus, sanitizeSummary } from './sanitize.js';

const HTTP_TIMEOUT_MS = 8000;
const TOKEN_RE = /^cut_[A-Za-z0-9_-]{43}$/;

async function request(serverUrl, token, method, path, body) {
  let res;
  try {
    res = await fetch(`${serverUrl}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      redirect: 'error', // never forward the bearer token to another origin
    });
  } catch (error) {
    throw new Error(`cannot reach ${serverUrl}: ${cleanText(error.cause?.code ?? error.message, 80)}`);
  }
  const payload = await res.json().catch(() => ({}));
  if (!res.ok || payload.success === false) {
    throw new Error(`server ${method} ${path} failed: HTTP ${res.status} ${cleanText(payload.error ?? '', 120)}`.trim());
  }
  return payload.data;
}

export async function registerAccount(serverUrl, code) {
  const data = await request(serverUrl, null, 'POST', '/api/register', code ? { code } : {});
  if (!TOKEN_RE.test(data?.token ?? '')) throw new Error('server returned an invalid token');
  return data.token;
}

export async function fetchMe(config) {
  const data = await request(config.serverUrl, config.token, 'GET', '/api/me');
  return { devices: sanitizeDeviceList(data?.devices) };
}

/** @returns {Promise<{ enforce: boolean, windows: object }>} this device's limit status */
export async function pushReport(config, report) {
  const data = await request(config.serverUrl, config.token, 'POST', '/api/report', report);
  return sanitizeStatus(data?.status);
}

export async function fetchSummary(config) {
  return sanitizeSummary(await request(config.serverUrl, config.token, 'GET', '/api/summary'));
}
