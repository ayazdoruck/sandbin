import { createQueue } from './queue.mjs';

function sleepJob(seconds) {
  return { language: 'python', code: `import time; time.sleep(${seconds})` };
}

async function testConcurrencyIsBounded() {
  const queue = createQueue({ maxConcurrency: 3, maxQueueLength: 64, maxPerKey: 64 });
  const jobCount = 9;
  let peakRunning = 0;

  const poll = setInterval(() => {
    peakRunning = Math.max(peakRunning, queue.stats().running);
  }, 15);

  const tickets = Array.from({ length: jobCount }, () => queue.submit(sleepJob(0.3)));
  await Promise.all(tickets.map((t) => t.result));
  clearInterval(poll);

  return {
    name: 'concurrency is bounded',
    pass: peakRunning > 0 && peakRunning <= 3 && tickets.every((t) => t.accepted),
    detail: `peakRunning=${peakRunning}`,
  };
}

async function testQueueFullRejectsImmediately() {
  const queue = createQueue({ maxConcurrency: 1, maxQueueLength: 2, maxPerKey: 64 });
  const tickets = Array.from({ length: 5 }, () => queue.submit(sleepJob(0.3)));

  const accepted = tickets.filter((t) => t.accepted).length;
  const rejected = tickets.filter((t) => !t.accepted);
  const results = await Promise.all(tickets.map((t) => t.result));

  return {
    name: 'queue_full rejects past capacity, immediately',
    pass:
      accepted === 3 &&
      rejected.length === 2 &&
      rejected.every((t) => t.verdict === 'queue_full') &&
      results.filter((r) => r.verdict === 'queue_full').length === 2 &&
      results.filter((r) => r.verdict === 'ok').length === 3,
    detail: `accepted=${accepted} rejected=${rejected.length}`,
  };
}

async function testPerKeyLimit() {
  const queue = createQueue({ maxConcurrency: 8, maxQueueLength: 64, maxPerKey: 2 });
  const ticketsA = Array.from({ length: 4 }, () => queue.submit(sleepJob(0.3), { key: 'tenant-a' }));
  const ticketsB = queue.submit(sleepJob(0.3), { key: 'tenant-b' });

  const acceptedA = ticketsA.filter((t) => t.accepted).length;
  const rejectedA = ticketsA.filter((t) => !t.accepted && t.verdict === 'key_limit').length;

  await Promise.all([...ticketsA.map((t) => t.result), ticketsB.result]);

  return {
    name: 'per-key limit is independent of other keys',
    pass: acceptedA === 2 && rejectedA === 2 && ticketsB.accepted === true,
    detail: `acceptedA=${acceptedA} rejectedA=${rejectedA} ticketsB.accepted=${ticketsB.accepted}`,
  };
}

async function testQueuedMsReflectsWaiting() {
  const queue = createQueue({ maxConcurrency: 1, maxQueueLength: 64, maxPerKey: 64 });
  const first = queue.submit(sleepJob(0.5));
  const second = queue.submit(sleepJob(0.01));

  const [firstResult, secondResult] = await Promise.all([first.result, second.result]);

  return {
    name: 'queuedMs reflects real wait time',
    pass: firstResult.queuedMs < 50 && secondResult.queuedMs > 400,
    detail: `first=${firstResult.queuedMs}ms second=${secondResult.queuedMs}ms`,
  };
}

async function testQueueDrainsToIdle() {
  const queue = createQueue({ maxConcurrency: 2, maxQueueLength: 64, maxPerKey: 64 });
  const tickets = Array.from({ length: 6 }, () => queue.submit(sleepJob(0.05)));
  await Promise.all(tickets.map((t) => t.result));
  const stats = queue.stats();

  return {
    name: 'queue returns to idle after draining',
    pass: stats.running === 0 && stats.waiting === 0 && stats.keys === 0,
    detail: JSON.stringify(stats),
  };
}

async function testFailingJobsStillFreeTheirSlot() {
  const queue = createQueue({ maxConcurrency: 1, maxQueueLength: 64, maxPerKey: 64 });
  const crashing = queue.submit({ language: 'python', code: 'raise SystemExit(1)' });
  const after = queue.submit(sleepJob(0.01));

  const [crashResult, afterResult] = await Promise.all([crashing.result, after.result]);

  return {
    name: 'a failing job still releases its concurrency slot',
    pass: crashResult.verdict === 'error' && afterResult.verdict === 'ok',
    detail: `crash=${crashResult.verdict} after=${afterResult.verdict}`,
  };
}

const CASES = [
  testConcurrencyIsBounded,
  testQueueFullRejectsImmediately,
  testPerKeyLimit,
  testQueuedMsReflectsWaiting,
  testQueueDrainsToIdle,
  testFailingJobsStillFreeTheirSlot,
];

let passed = 0;
for (const testCase of CASES) {
  const { name, pass, detail } = await testCase();
  if (pass) passed++;
  console.log(`${pass ? '✅' : '❌'} ${name.padEnd(48)} ${detail}`);
}
console.log(`\n${passed}/${CASES.length} passed`);
process.exit(passed === CASES.length ? 0 : 1);
