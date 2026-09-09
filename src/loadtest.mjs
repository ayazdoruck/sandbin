import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import { createServer } from './server.mjs';

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
  return sorted[idx];
}

async function submitAndWait(baseUrl, language, code) {
  const startedAt = Date.now();
  const res = await fetch(`${baseUrl}/runs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ language, code }),
  });
  const body = await res.json();
  if (!body.accepted) {
    return { accepted: false, verdict: body.verdict, latencyMs: Date.now() - startedAt };
  }
  const result = await new Promise((resolve) => {
    const ws = new WebSocket(`${baseUrl.replace('http', 'ws')}/runs/${body.runId}/stream`);
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString('utf8'));
      if (msg.type === 'finished') {
        resolve(msg.result);
        ws.close();
      }
    });
    ws.on('error', () => resolve(null));
  });
  return { accepted: true, verdict: result?.verdict, latencyMs: Date.now() - startedAt };
}

async function runWithConcurrency(count, concurrency, task) {
  const results = new Array(count);
  let next = 0;
  async function worker() {
    while (next < count) {
      const i = next++;
      results[i] = await task(i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, count) }, worker));
  return results;
}

function summarize(results, wallClockMs) {
  const accepted = results.filter((r) => r.accepted);
  const rejected = results.filter((r) => !r.accepted);
  const latencies = accepted.map((r) => r.latencyMs).sort((a, b) => a - b);
  const rejectedLatencies = rejected.map((r) => r.latencyMs).sort((a, b) => a - b);
  return {
    total: results.length,
    accepted: accepted.length,
    rejected: rejected.length,
    rejectedByVerdict: rejected.reduce((acc, r) => ({ ...acc, [r.verdict]: (acc[r.verdict] ?? 0) + 1 }), {}),
    okVerdicts: accepted.filter((r) => r.verdict === 'ok').length,
    wallClockMs,
    reqPerSec: accepted.length > 0 ? Math.round((accepted.length / wallClockMs) * 1000 * 10) / 10 : 0,
    latency: {
      min: latencies[0] ?? 0,
      p50: percentile(latencies, 0.5),
      p95: percentile(latencies, 0.95),
      max: latencies.at(-1) ?? 0,
    },
    rejectedLatency: {
      min: rejectedLatencies[0] ?? 0,
      max: rejectedLatencies.at(-1) ?? 0,
    },
  };
}

async function withServer(serverOptions, fn) {
  const permalinkDir = await mkdtemp(path.join(tmpdir(), 'sandbin-loadtest-permalinks-'));
  const apiKeyDir = await mkdtemp(path.join(tmpdir(), 'sandbin-loadtest-apikeys-'));
  // Rate limiting is already covered by ratelimit-test.mjs and server-test.mjs
  // against synthetic clocks — it isn't what this script measures, and every
  // request here comes from the same loopback IP, so the real anonymous
  // quota (20/hour) would otherwise dominate the results long before the
  // queue's own limits ever came into play.
  const { httpServer } = createServer({ permalinkDir, apiKeyDir, anonymousRequestsPerHour: 100_000, ...serverOptions });
  await new Promise((resolve) => httpServer.listen(0, resolve));
  const port = httpServer.address().port;
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    httpServer.close();
    await rm(permalinkDir, { recursive: true, force: true }).catch(() => {});
    await rm(apiKeyDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function scenarioSustainedThroughput() {
  const queueLimits = { maxConcurrency: 4, maxQueueLength: 64, maxPerKey: 8 };
  return withServer({ queueLimits }, async (baseUrl) => {
    const total = 100;
    const startedAt = Date.now();
    const results = await runWithConcurrency(total, queueLimits.maxConcurrency, () =>
      submitAndWait(baseUrl, 'python', 'print(1)')
    );
    return {
      name: 'sustained throughput — client concurrency held at the queue default (maxConcurrency=4)',
      queueLimits,
      ...summarize(results, Date.now() - startedAt),
    };
  });
}

async function scenarioOverload() {
  // maxPerKey raised well past what this test could ever hit: every request
  // here shares one caller identity, and the point is to isolate the
  // *global* queue_full path from the *per-key* key_limit path, which is
  // already its own dedicated case in queue-test.mjs.
  const queueLimits = { maxConcurrency: 4, maxQueueLength: 16, maxPerKey: 1000 };
  const capacity = queueLimits.maxConcurrency + queueLimits.maxQueueLength;
  return withServer({ queueLimits }, async (baseUrl) => {
    const total = 60;
    const startedAt = Date.now();
    // Fired with no client-side throttling at all — concurrency == total —
    // specifically to arrive at the server faster than it can drain, which
    // is the one thing the sustained scenario above never exercises.
    const results = await runWithConcurrency(total, total, () => submitAndWait(baseUrl, 'python', 'print(1)'));
    return {
      name: `overload — ${total} requests at once against a ${capacity}-slot capacity (maxConcurrency=${queueLimits.maxConcurrency} + maxQueueLength=${queueLimits.maxQueueLength})`,
      queueLimits,
      ...summarize(results, Date.now() - startedAt),
    };
  });
}

function printReport(scenario) {
  console.log(`\n${scenario.name}`);
  console.log(`  requests            total=${scenario.total} accepted=${scenario.accepted} rejected=${scenario.rejected}`);
  if (scenario.rejected > 0) {
    console.log(`  rejected by verdict ${JSON.stringify(scenario.rejectedByVerdict)}`);
  }
  console.log(`  accepted verdicts   ok=${scenario.okVerdicts}/${scenario.accepted}`);
  console.log(`  wall clock          ${scenario.wallClockMs}ms`);
  console.log(`  throughput          ${scenario.reqPerSec} req/s (accepted requests only)`);
  console.log(
    `  latency, accepted   min=${scenario.latency.min}ms p50=${scenario.latency.p50}ms p95=${scenario.latency.p95}ms max=${scenario.latency.max}ms (submit -> finished)`
  );
  if (scenario.rejected > 0) {
    console.log(`  latency, rejected   min=${scenario.rejectedLatency.min}ms max=${scenario.rejectedLatency.max}ms (submit -> 202 with accepted:false)`);
  }
}

console.log('sandbin load test — two scenarios against a real server on an ephemeral port');
printReport(await scenarioSustainedThroughput());
printReport(await scenarioOverload());
