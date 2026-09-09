import { mkdir, writeFile, readFile, readdir, unlink } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';

export const DEFAULT_REQUESTS_PER_HOUR = 200;
export const DEFAULT_KEY_TTL_MS = 90 * 24 * 60 * 60 * 1000;

export function createApiKeyStore({ dir, requestsPerHour = DEFAULT_REQUESTS_PER_HOUR, ttlMs = DEFAULT_KEY_TTL_MS }) {
  const filePath = (key) => path.join(dir, `${key}.json`);

  async function issue() {
    await mkdir(dir, { recursive: true });
    const key = `sb_${randomBytes(16).toString('hex')}`;
    const record = { key, requestsPerHour, createdAt: Date.now() };
    await writeFile(filePath(key), JSON.stringify(record));
    return record;
  }

  async function load(key) {
    try {
      return JSON.parse(await readFile(filePath(key), 'utf8'));
    } catch {
      return null;
    }
  }

  // Unlike permalinks.mjs, which this deliberately mirrors, nothing here
  // ever expired: createdAt was written to every record and never once
  // read back. A key issued by anyone, ever, stayed on disk forever —
  // issuance is rate-limited (5/hour/IP) but that only slows unbounded
  // growth down, it doesn't stop it. TTL is measured from issuance, not
  // last use, same tradeoff permalinks already makes: simple, and correct
  // enough for a free, no-signup key with no billing or SLA behind it.
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
        if (now - record.createdAt > ttlMs) {
          await unlink(full);
          removed++;
        }
      } catch {
        // corrupt or already-removed entry; leave it for the next sweep
      }
    }
    return removed;
  }

  return { issue, load, sweep };
}
