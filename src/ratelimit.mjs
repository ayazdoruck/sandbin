export const DEFAULT_WINDOW_MS = 60 * 60 * 1000;

export function createRateLimiter({ windowMs = DEFAULT_WINDOW_MS } = {}) {
  const buckets = new Map();

  function bucketFor(id, now) {
    const existing = buckets.get(id);
    if (existing && now < existing.resetAt) return existing;
    const fresh = { count: 0, resetAt: now + windowMs };
    buckets.set(id, fresh);
    return fresh;
  }

  function check(id, limit, { now = Date.now() } = {}) {
    const bucket = bucketFor(id, now);
    if (bucket.count >= limit) {
      return { allowed: false, count: bucket.count, remaining: 0, resetAt: bucket.resetAt };
    }
    bucket.count++;
    return { allowed: true, count: bucket.count, remaining: limit - bucket.count, resetAt: bucket.resetAt };
  }

  function peek(id, limit, { now = Date.now() } = {}) {
    const existing = buckets.get(id);
    if (!existing || now >= existing.resetAt) {
      return { count: 0, remaining: limit, resetAt: now + windowMs };
    }
    return { count: existing.count, remaining: Math.max(0, limit - existing.count), resetAt: existing.resetAt };
  }

  return { check, peek };
}
