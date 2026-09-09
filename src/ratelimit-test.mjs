import { createRateLimiter } from './ratelimit.mjs';

function testAllowsUpToTheLimit() {
  const limiter = createRateLimiter({ windowMs: 60_000 });
  const results = [1, 2, 3].map(() => limiter.check('a', 3).allowed);
  return {
    name: 'the first N requests within the limit are all allowed',
    pass: results.every(Boolean),
    detail: results.join(','),
  };
}

function testBlocksOnceOverTheLimit() {
  const limiter = createRateLimiter({ windowMs: 60_000 });
  limiter.check('a', 2);
  limiter.check('a', 2);
  const third = limiter.check('a', 2);
  return {
    name: 'the request past the limit is rejected, not silently allowed',
    pass: third.allowed === false && third.remaining === 0,
    detail: JSON.stringify(third),
  };
}

function testIdsAreIndependent() {
  const limiter = createRateLimiter({ windowMs: 60_000 });
  limiter.check('a', 1);
  const blockedA = limiter.check('a', 1);
  const allowedB = limiter.check('b', 1);
  return {
    name: 'one id being throttled does not affect a different id',
    pass: blockedA.allowed === false && allowedB.allowed === true,
    detail: `a=${blockedA.allowed} b=${allowedB.allowed}`,
  };
}

function testResetsAfterTheWindowPasses() {
  const limiter = createRateLimiter({ windowMs: 1000 });
  const start = Date.now();
  limiter.check('a', 1, { now: start });
  const stillBlocked = limiter.check('a', 1, { now: start + 500 });
  const afterReset = limiter.check('a', 1, { now: start + 1500 });
  return {
    name: 'a new window resets the count instead of accumulating forever',
    pass: stillBlocked.allowed === false && afterReset.allowed === true,
    detail: `stillBlocked=${stillBlocked.allowed} afterReset=${afterReset.allowed}`,
  };
}

function testPeekDoesNotConsumeASlot() {
  const limiter = createRateLimiter({ windowMs: 60_000 });
  limiter.check('a', 1);
  const peeked = limiter.peek('a', 1);
  const stillBlocked = limiter.check('a', 1);
  return {
    name: 'peek reports usage without counting as a request itself',
    pass: peeked.remaining === 0 && stillBlocked.allowed === false,
    detail: JSON.stringify({ peeked, stillBlockedAllowed: stillBlocked.allowed }),
  };
}

const CASES = [
  testAllowsUpToTheLimit,
  testBlocksOnceOverTheLimit,
  testIdsAreIndependent,
  testResetsAfterTheWindowPasses,
  testPeekDoesNotConsumeASlot,
];

let passed = 0;
for (const testCase of CASES) {
  const { name, pass, detail } = testCase();
  if (pass) passed++;
  console.log(`${pass ? '✅' : '❌'} ${name.padEnd(60)} ${detail}`);
}
console.log(`\n${passed}/${CASES.length} passed`);
process.exit(passed === CASES.length ? 0 : 1);
