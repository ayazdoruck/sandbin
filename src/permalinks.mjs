import { mkdir, writeFile, readFile, readdir, unlink } from 'node:fs/promises';
import path from 'node:path';

export const PERMALINK_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export function createPermalinkStore({ dir, ttlMs = PERMALINK_TTL_MS }) {
  const filePath = (id) => path.join(dir, `${id}.json`);

  async function save(id, record) {
    await mkdir(dir, { recursive: true });
    await writeFile(filePath(id), JSON.stringify({ ...record, savedAt: Date.now() }));
  }

  async function load(id, { now = Date.now() } = {}) {
    let raw;
    try {
      raw = await readFile(filePath(id), 'utf8');
    } catch {
      return null;
    }
    let record;
    try {
      record = JSON.parse(raw);
    } catch {
      return null;
    }
    if (now - record.savedAt > ttlMs) {
      await unlink(filePath(id)).catch(() => {});
      return null;
    }
    return record;
  }

  async function sweep({ now = Date.now() } = {}) {
    let entries;
    try {
      entries = await readdir(dir);
    } catch {
      return 0;
    }
    let removed = 0;
    for (const entry of entries) {
      const full = path.join(dir, entry);
      try {
        const record = JSON.parse(await readFile(full, 'utf8'));
        if (now - record.savedAt > ttlMs) {
          await unlink(full);
          removed++;
        }
      } catch {
        // corrupt or already-removed entry; leave it for the next sweep
      }
    }
    return removed;
  }

  return { save, load, sweep };
}
