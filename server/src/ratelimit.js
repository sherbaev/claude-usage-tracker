// Fixed-window in-memory rate limiter with a hard cap on tracked keys. Fine for a single container.
const DEFAULT_MAX_KEYS = 10_000;

export function createRateLimiter({ limit, windowMs, maxKeys = DEFAULT_MAX_KEYS, now = Date.now }) {
  const buckets = new Map();

  /** @returns {boolean} true when the call is allowed */
  return function hit(key) {
    const t = now();
    const current = buckets.get(key);
    const bucket = current && current.resetAt > t ? current : { count: 0, resetAt: t + windowMs };
    const next = { ...bucket, count: bucket.count + 1 };
    // Re-insert so Map order is least-recently-used first; evict the oldest key when full (O(1)).
    buckets.delete(key);
    if (buckets.size >= maxKeys) buckets.delete(buckets.keys().next().value);
    buckets.set(key, next);
    return next.count <= limit;
  };
}
