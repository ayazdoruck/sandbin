import { createMetricsStore } from './metrics.mjs';

function testFreshStoreStartsAtZero() {
  const metrics = createMetricsStore();
  const snap = metrics.snapshot();
  return {
    name: 'a fresh store reports zero for every counter',
    pass:
      snap.submitted === 0 &&
      snap.accepted === 0 &&
      Object.keys(snap.rejected).length === 0 &&
      snap.finished.total === 0 &&
      snap.averages.durationMs === 0 &&
      snap.keysIssued === 0,
    detail: JSON.stringify(snap),
  };
}

function testAcceptedAndRejectedAreCountedSeparately() {
  const metrics = createMetricsStore();
  metrics.recordSubmitted();
  metrics.recordAccepted();
  metrics.recordSubmitted();
  metrics.recordRejected('rate_limited');
  metrics.recordSubmitted();
  metrics.recordRejected('rate_limited');
  metrics.recordSubmitted();
  metrics.recordRejected('bad_request');
  const snap = metrics.snapshot();
  return {
    name: 'accepted and rejected runs are tallied independently, rejected broken down by verdict',
    pass: snap.submitted === 4 && snap.accepted === 1 && snap.rejected.rate_limited === 2 && snap.rejected.bad_request === 1,
    detail: JSON.stringify({ submitted: snap.submitted, accepted: snap.accepted, rejected: snap.rejected }),
  };
}

function testFinishedRunsBreakDownByVerdictAndLanguage() {
  const metrics = createMetricsStore();
  metrics.recordFinished('python', { verdict: 'ok', durationMs: 10, cpuMs: 5, peakBytes: 1000 });
  metrics.recordFinished('python', { verdict: 'ok', durationMs: 20, cpuMs: 15, peakBytes: 3000 });
  metrics.recordFinished('bash', { verdict: 'timeout', durationMs: 30, cpuMs: 10, peakBytes: 2000 });
  const snap = metrics.snapshot();
  return {
    name: 'finished runs are broken down by verdict and by language, not just totaled',
    pass:
      snap.finished.total === 3 &&
      snap.finished.byVerdict.ok === 2 &&
      snap.finished.byVerdict.timeout === 1 &&
      snap.finished.byLanguage.python === 2 &&
      snap.finished.byLanguage.bash === 1,
    detail: JSON.stringify(snap.finished),
  };
}

function testAveragesAreComputedAcrossFinishedRuns() {
  const metrics = createMetricsStore();
  metrics.recordFinished('python', { verdict: 'ok', durationMs: 10, cpuMs: 4, peakBytes: 1000 });
  metrics.recordFinished('python', { verdict: 'ok', durationMs: 30, cpuMs: 8, peakBytes: 3000 });
  const snap = metrics.snapshot();
  return {
    name: 'averages are the mean over finished runs, not a running total',
    pass: snap.averages.durationMs === 20 && snap.averages.cpuMs === 6 && snap.averages.peakBytes === 2000,
    detail: JSON.stringify(snap.averages),
  };
}

function testKeyIssuanceIsCountedIndependently() {
  const metrics = createMetricsStore();
  metrics.recordKeyIssued();
  metrics.recordKeyIssued();
  metrics.recordSubmitted();
  const snap = metrics.snapshot();
  return {
    name: 'key issuance has its own counter, unaffected by run submissions',
    pass: snap.keysIssued === 2 && snap.submitted === 1,
    detail: JSON.stringify({ keysIssued: snap.keysIssued, submitted: snap.submitted }),
  };
}

function testUptimeGrowsWithRealTime() {
  const metrics = createMetricsStore();
  const first = metrics.snapshot().uptimeMs;
  const start = Date.now();
  while (Date.now() - start < 5) {}
  const second = metrics.snapshot().uptimeMs;
  return {
    name: 'uptimeMs reflects real elapsed wall-clock time, not a fixed value',
    pass: second > first,
    detail: `first=${first}ms second=${second}ms`,
  };
}

const CASES = [
  testFreshStoreStartsAtZero,
  testAcceptedAndRejectedAreCountedSeparately,
  testFinishedRunsBreakDownByVerdictAndLanguage,
  testAveragesAreComputedAcrossFinishedRuns,
  testKeyIssuanceIsCountedIndependently,
  testUptimeGrowsWithRealTime,
];

let passed = 0;
for (const testCase of CASES) {
  const { name, pass, detail } = await testCase();
  if (pass) passed++;
  console.log(`${pass ? '✅' : '❌'} ${name.padEnd(60)} ${detail}`);
}
console.log(`\n${passed}/${CASES.length} passed`);
process.exit(passed === CASES.length ? 0 : 1);
