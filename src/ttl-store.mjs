import { readFile, readdir, unlink } from 'node:fs/promises';
import path from 'node:path';

// Shared by permalinks.mjs and apikeys.mjs: both are a directory of
// TTL-stamped JSON records, only differing in which field holds each
// record's own timestamp. Expiry is checked in two places for the same
// reason in both stores: loadIfFresh() re-checks age inline at the point
// of use, rather than trusting that the periodic sweep already deleted
// anything expired — a record just past its own TTL would otherwise keep
// working, at full validity, for up to a whole sweep interval after
// expiring. sweepExpired() is what actually reclaims the disk space
// between individual load()s.

export async function loadIfFresh(filePath, ttlMs, timestampField, now = Date.now()) {
  let record;
  try {
    record = JSON.parse(await readFile(filePath, 'utf8'));
  } catch {
    return null;
  }
  if (now - record[timestampField] > ttlMs) {
    await unlink(filePath).catch(() => {});
    return null;
  }
  return record;
}

export async function sweepExpired(dir, ttlMs, timestampField, now = Date.now()) {
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
      if (now - record[timestampField] > ttlMs) {
        await unlink(full);
        removed++;
      }
    } catch {
      // corrupt or already-removed entry; leave it for the next sweep
    }
  }
  return removed;
}
