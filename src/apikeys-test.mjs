import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApiKeyStore } from './apikeys.mjs';

async function withStore(fn, opts = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'sandbin-apikeys-'));
  try {
    return await fn(createApiKeyStore({ dir, ...opts }), dir);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

async function testIssuedKeyHasExpectedShape() {
  return withStore(async (store) => {
    const record = await store.issue();
    return {
      name: 'an issued key is sb_-prefixed and carries a default quota',
      pass: record.key.startsWith('sb_') && record.key.length > 10 && record.requestsPerHour === 200,
      detail: JSON.stringify(record),
    };
  });
}

async function testIssuedKeyRespectsCustomQuota() {
  return withStore(async (store) => {
    const record = await store.issue();
    return {
      name: 'a store configured with a custom quota applies it to new keys',
      pass: record.requestsPerHour === 50,
      detail: JSON.stringify(record),
    };
  }, { requestsPerHour: 50 });
}

async function testLoadRoundtrips() {
  return withStore(async (store) => {
    const issued = await store.issue();
    const loaded = await store.load(issued.key);
    return {
      name: 'loading an issued key returns the same record',
      pass: loaded?.key === issued.key && loaded?.requestsPerHour === issued.requestsPerHour,
      detail: JSON.stringify(loaded),
    };
  });
}

async function testUnknownKeyReturnsNull() {
  return withStore(async (store) => {
    const loaded = await store.load('sb_does_not_exist');
    return {
      name: 'loading an unknown key returns null, not an error',
      pass: loaded === null,
      detail: String(loaded),
    };
  });
}

async function testLoadRejectsExpiredKeyBeforeSweepEverRuns() {
  return withStore(async (store, dir) => {
    const issued = await store.issue();
    const filePath = path.join(dir, `${issued.key}.json`);
    const record = JSON.parse(await readFile(filePath, 'utf8'));
    record.createdAt = Date.now() - 5000;
    await writeFile(filePath, JSON.stringify(record));

    // sweep() is never called here — load() itself must refuse a key past
    // its own ttlMs, not rely on the hourly sweep having deleted the file
    // first.
    const loaded = await store.load(issued.key);
    return {
      name: 'load rejects an expired key even before sweep ever runs',
      pass: loaded === null,
      detail: JSON.stringify(loaded),
    };
  }, { ttlMs: 1000 });
}

async function testTwoIssuedKeysAreDistinct() {
  return withStore(async (store) => {
    const a = await store.issue();
    const b = await store.issue();
    return {
      name: 'two calls to issue produce two different keys',
      pass: a.key !== b.key,
      detail: `${a.key} vs ${b.key}`,
    };
  });
}

async function testSweepRemovesOnlyExpiredKeys() {
  return withStore(async (store, dir) => {
    // Fully clock-injected, not just the expired side: the original version
    // backdated `old` by a fixed amount but left `fresh`'s "still valid"
    // check riding on however much real wall-clock time the actual disk
    // I/O (issue, backdate, sweep, reload) happened to take against a
    // 1000ms TTL with zero margin — confirmed flaky by replaying the same
    // sequence with a simulated 1100ms slowdown inserted, which flipped
    // freshStillLoads to null. Pinning every check to one fixed `now`
    // removes real time from the test entirely.
    const now = Date.now();
    const fresh = await store.issue();
    const old = await store.issue();

    const freshPath = path.join(dir, `${fresh.key}.json`);
    const freshRecord = JSON.parse(await readFile(freshPath, 'utf8'));
    freshRecord.createdAt = now;
    await writeFile(freshPath, JSON.stringify(freshRecord));

    const oldPath = path.join(dir, `${old.key}.json`);
    const oldRecord = JSON.parse(await readFile(oldPath, 'utf8'));
    oldRecord.createdAt = now - 5000;
    await writeFile(oldPath, JSON.stringify(oldRecord));

    const removed = await store.sweep({ now });
    const freshStillLoads = await store.load(fresh.key, { now });
    const oldIsGone = await store.load(old.key, { now });

    return {
      name: 'sweep removes keys past their TTL, leaves ones still within it',
      pass: removed === 1 && freshStillLoads?.key === fresh.key && oldIsGone === null,
      detail: `removed=${removed} freshStillLoads=${JSON.stringify(freshStillLoads)} oldIsGone=${oldIsGone}`,
    };
  }, { ttlMs: 1000 });
}

const CASES = [
  testIssuedKeyHasExpectedShape,
  testIssuedKeyRespectsCustomQuota,
  testLoadRoundtrips,
  testUnknownKeyReturnsNull,
  testLoadRejectsExpiredKeyBeforeSweepEverRuns,
  testTwoIssuedKeysAreDistinct,
  testSweepRemovesOnlyExpiredKeys,
];

let passed = 0;
for (const testCase of CASES) {
  const { name, pass, detail } = await testCase();
  if (pass) passed++;
  console.log(`${pass ? '✅' : '❌'} ${name.padEnd(60)} ${detail}`);
}
console.log(`\n${passed}/${CASES.length} passed`);
process.exit(passed === CASES.length ? 0 : 1);
