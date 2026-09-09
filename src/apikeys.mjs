import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';

export const DEFAULT_REQUESTS_PER_HOUR = 200;

export function createApiKeyStore({ dir, requestsPerHour = DEFAULT_REQUESTS_PER_HOUR }) {
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

  return { issue, load };
}
