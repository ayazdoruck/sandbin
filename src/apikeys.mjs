import { mkdir, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { loadIfFresh, sweepExpired } from './ttl-store.mjs';

export const DEFAULT_REQUESTS_PER_HOUR = 200;
export const DEFAULT_KEY_TTL_MS = 90 * 24 * 60 * 60 * 1000;

// The single source of truth for what an issued key looks like — issue()
// below is the only place that generates one. server.mjs imports this
// rather than hand-matching the shape itself: a regex re-typed at the
// validation site can silently drift out of sync with what issue()
// actually produces, either rejecting every newly-issued key or, loosened
// without matching care, reopening the path-traversal-via-header issue
// this format check exists to close.
export const API_KEY_FORMAT = /^sb_[0-9a-f]{32}$/;

export function createApiKeyStore({ dir, requestsPerHour = DEFAULT_REQUESTS_PER_HOUR, ttlMs = DEFAULT_KEY_TTL_MS }) {
  const filePath = (key) => path.join(dir, `${key}.json`);

  async function issue() {
    await mkdir(dir, { recursive: true });
    const key = `sb_${randomBytes(16).toString('hex')}`;
    const record = { key, requestsPerHour, createdAt: Date.now() };
    await writeFile(filePath(key), JSON.stringify(record));
    return record;
  }

  async function load(key, { now = Date.now() } = {}) {
    return loadIfFresh(filePath(key), ttlMs, 'createdAt', now);
  }

  async function sweep({ now = Date.now() } = {}) {
    return sweepExpired(dir, ttlMs, 'createdAt', now);
  }

  return { issue, load, sweep };
}
