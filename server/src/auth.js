// Account tokens: random, shown once, stored only as SHA-256.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const TOKEN_PREFIX = 'cut_';
const TOKEN_BYTES = 32;
const TOKEN_RE = /^cut_[A-Za-z0-9_-]{43}$/;

export const generateToken = () => `${TOKEN_PREFIX}${randomBytes(TOKEN_BYTES).toString('base64url')}`;

export const isWellFormedToken = (token) => TOKEN_RE.test(token);

export const hashToken = (token) => createHash('sha256').update(token).digest('hex');

/** Constant-time string comparison (for the optional registration code). */
export function safeEqual(a, b) {
  const digest = (s) => createHash('sha256').update(String(s)).digest();
  return timingSafeEqual(digest(a), digest(b));
}
