import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createPermalinkStore } from './permalinks.mjs';

async function withStore(ttlMs, fn) {
  const dir = await mkdtemp(path.join(tmpdir(), 'sandbin-permalinks-'));
  try {
    return await fn(createPermalinkStore({ dir, ttlMs }));
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

async function testSaveAndLoadRoundtrip() {
  return withStore(1000, async (store) => {
    await store.save('abc', { language: 'python', code: 'print(1)', result: { verdict: 'ok' } });
    const record = await store.load('abc');
    return {
      name: 'a saved record loads back with the same fields',
      pass: record?.language === 'python' && record?.code === 'print(1)' && record?.result.verdict === 'ok',
      detail: JSON.stringify(record),
    };
  });
}

async function testUnknownIdReturnsNull() {
  return withStore(1000, async (store) => {
    const record = await store.load('does-not-exist');
    return {
      name: 'loading an unknown id returns null, not an error',
      pass: record === null,
      detail: String(record),
    };
  });
}

async function testExpiredRecordIsEvictedOnLoad() {
  return withStore(1000, async (store) => {
    await store.save('old', { language: 'python', code: 'print(1)', result: { verdict: 'ok' } });
    const future = Date.now() + 2000;
    const record = await store.load('old', { now: future });
    const secondLoad = await store.load('old');
    return {
      name: 'a record past its TTL loads as null and is deleted, not just hidden',
      pass: record === null && secondLoad === null,
      detail: `firstLoad=${record} secondLoad=${secondLoad}`,
    };
  });
}

async function testFreshRecordSurvivesWithinTtl() {
  return withStore(60_000, async (store) => {
    await store.save('fresh', { language: 'bash', code: 'echo hi', result: { verdict: 'ok' } });
    const record = await store.load('fresh', { now: Date.now() + 5000 });
    return {
      name: 'a record well within its TTL still loads',
      pass: record?.language === 'bash',
      detail: JSON.stringify(record),
    };
  });
}

async function testSweepRemovesOnlyExpired() {
  return withStore(200, async (store) => {
    await store.save('drop', { language: 'python', code: 'b', result: {} });
    await new Promise((r) => setTimeout(r, 250));
    await store.save('keep', { language: 'python', code: 'a', result: {} });

    const removed = await store.sweep();
    const dropGone = await store.load('drop');
    const keepStillThere = await store.load('keep');
    return {
      name: 'sweep evicts only the record actually past its TTL, leaves the fresh one',
      pass: removed === 1 && dropGone === null && keepStillThere?.language === 'python' && keepStillThere?.code === 'a',
      detail: `removed=${removed} dropGone=${dropGone} keepStillThere=${JSON.stringify(keepStillThere)}`,
    };
  });
}

const CASES = [
  testSaveAndLoadRoundtrip,
  testUnknownIdReturnsNull,
  testExpiredRecordIsEvictedOnLoad,
  testFreshRecordSurvivesWithinTtl,
  testSweepRemovesOnlyExpired,
];

let passed = 0;
for (const testCase of CASES) {
  const { name, pass, detail } = await testCase();
  if (pass) passed++;
  console.log(`${pass ? '✅' : '❌'} ${name.padEnd(60)} ${detail}`);
}
console.log(`\n${passed}/${CASES.length} passed`);
process.exit(passed === CASES.length ? 0 : 1);
