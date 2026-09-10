import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { loadIfFresh, sweepExpired } from './ttl-store.mjs';

export const PERMALINK_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export function createPermalinkStore({ dir, ttlMs = PERMALINK_TTL_MS }) {
  const filePath = (id) => path.join(dir, `${id}.json`);

  async function save(id, record) {
    await mkdir(dir, { recursive: true });
    await writeFile(filePath(id), JSON.stringify({ ...record, savedAt: Date.now() }));
  }

  async function load(id, { now = Date.now() } = {}) {
    return loadIfFresh(filePath(id), ttlMs, 'savedAt', now);
  }

  async function sweep({ now = Date.now() } = {}) {
    return sweepExpired(dir, ttlMs, 'savedAt', now);
  }

  return { save, load, sweep };
}
