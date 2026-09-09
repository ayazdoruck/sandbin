import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApiKeyStore } from './apikeys.mjs';

async function withStore(fn, opts = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'sandbin-apikeys-'));
  try {
    return await fn(createApiKeyStore({ dir, ...opts }));
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

const CASES = [
  testIssuedKeyHasExpectedShape,
  testIssuedKeyRespectsCustomQuota,
  testLoadRoundtrips,
  testUnknownKeyReturnsNull,
  testTwoIssuedKeysAreDistinct,
];

let passed = 0;
for (const testCase of CASES) {
  const { name, pass, detail } = await testCase();
  if (pass) passed++;
  console.log(`${pass ? '✅' : '❌'} ${name.padEnd(60)} ${detail}`);
}
console.log(`\n${passed}/${CASES.length} passed`);
process.exit(passed === CASES.length ? 0 : 1);
