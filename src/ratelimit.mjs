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

  // buckets never removed themselves — every distinct id (IP address, or
  // an issued key) that has ever called check() stayed in this Map for the
  // life of the process, whether or not its window had long since expired.
  // Since id is attacker-influenced (any IP, freely rotated on IPv6),
  // that's unbounded heap growth for the cost of ordinary requests, not
  // something that needs a bug to trigger. Removing anything past its own
  // resetAt is always safe: a ended window carries no state worth keeping,
  // and a fresh bucket gets created on the next check() regardless.
  function sweep({ now = Date.now() } = {}) {
    let removed = 0;
    for (const [id, bucket] of buckets) {
      if (now >= bucket.resetAt) {
        buckets.delete(id);
        removed++;
      }
    }
    return removed;
  }

  // For tests: peek() already returns a synthetic {count:0,...} for any
  // bucket past its own resetAt whether or not it was actually deleted, so
  // "count reads 0 after sweep" doesn't prove sweep() freed anything — a
  // sweep() that silently no-ops on buckets.delete() (the exact
  // unbounded-growth bug sweep() exists to fix) would pass that check too.
  // size() is the only way to observe the Map actually shrank.
  function size() {
    return buckets.size;
  }

  return { check, peek, sweep, size };
}
