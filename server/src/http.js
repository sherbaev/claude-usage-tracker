// Small HTTP helpers: errors, JSON bodies, responses, client IP.
const MAX_BODY_BYTES = 16 * 1024;

const BASE_HEADERS = Object.freeze({
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
});

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new HttpError(413, 'body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (text.trim() === '') return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new HttpError(400, 'invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

export function sendJson(res, status, payload) {
  res.writeHead(status, { ...BASE_HEADERS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(payload));
}

export function sendFile(res, { body, type, csp }) {
  res.writeHead(200, {
    ...BASE_HEADERS,
    'Content-Type': type,
    'Cache-Control': 'no-cache',
    ...(csp ? { 'Content-Security-Policy': csp } : {}),
  });
  res.end(body);
}

/**
 * Client IP for rate limiting. Proxies append to X-Forwarded-For, so with `proxyHops` trusted
 * proxies in front the real client is the hops-th entry from the right; anything left of it is
 * client-controlled and ignored.
 */
export function clientIp(req, proxyHops) {
  const forwarded = proxyHops > 0 ? req.headers['x-forwarded-for'] : undefined;
  const entries = typeof forwarded === 'string' ? forwarded.split(',').map((s) => s.trim()).filter(Boolean) : [];
  const fromProxy = entries.length >= proxyHops ? entries[entries.length - proxyHops] : undefined;
  return fromProxy || req.socket.remoteAddress || 'unknown';
}

export function bearerToken(req) {
  const header = req.headers.authorization ?? '';
  return header.startsWith('Bearer ') ? header.slice(7).trim() : '';
}
