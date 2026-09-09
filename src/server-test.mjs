import { WebSocket } from 'ws';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from './server.mjs';

function post(baseUrl, path, body, headers = {}) {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  }).then(async (res) => ({ status: res.status, body: await res.json() }));
}

function streamRun(baseUrl, runId, { onEvent } = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${baseUrl.replace('http', 'ws')}/runs/${runId}/stream`);
    const events = [];
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString('utf8'));
      const event = { ...msg, t: Date.now() };
      events.push(event);
      onEvent?.(event, ws);
      if (msg.type === 'finished' || msg.type === 'error') resolve(events);
    });
    ws.on('error', reject);
  });
}

async function withServer(queueLimits, fn, serverOptions = {}) {
  const permalinkDir = await mkdtemp(path.join(tmpdir(), 'sandbin-permalinks-'));
  const apiKeyDir = await mkdtemp(path.join(tmpdir(), 'sandbin-apikeys-'));
  const { httpServer } = createServer({ queueLimits, permalinkDir, apiKeyDir, ...serverOptions });
  await new Promise((resolve) => httpServer.listen(0, resolve));
  const port = httpServer.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    return await fn(baseUrl);
  } finally {
    httpServer.close();
    await rm(permalinkDir, { recursive: true, force: true }).catch(() => {});
    await rm(apiKeyDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function testBasicRunStreams() {
  return withServer({}, async (baseUrl) => {
    const submit = await post(baseUrl, '/runs', {
      language: 'python',
      code: 'import time; time.sleep(0.1); print("hello")',
    });
    const events = await streamRun(baseUrl, submit.body.runId);
    const types = events.map((e) => e.type);
    const finished = events.find((e) => e.type === 'finished');
    return {
      name: 'basic run streams started -> chunk -> finished',
      pass:
        submit.status === 202 &&
        types.includes('started') &&
        types.includes('chunk') &&
        types.indexOf('started') < types.indexOf('chunk') &&
        types.indexOf('chunk') < types.indexOf('finished') &&
        types.at(-1) === 'finished' &&
        finished.result.verdict === 'ok' &&
        finished.result.stdout.includes('hello'),
      detail: types.join(','),
    };
  });
}

async function testChunksArriveIncrementally() {
  return withServer({}, async (baseUrl) => {
    const submit = await post(baseUrl, '/runs', {
      language: 'python',
      code: 'import time\nprint("a")\ntime.sleep(0.3)\nprint("b")\ntime.sleep(0.3)\nprint("c")',
    });
    const events = await streamRun(baseUrl, submit.body.runId);
    const chunkTimes = events.filter((e) => e.type === 'chunk').map((e) => e.t);
    const gaps = chunkTimes.slice(1).map((t, i) => t - chunkTimes[i]);
    return {
      name: 'chunks arrive incrementally, not all at once',
      pass: chunkTimes.length >= 3 && gaps.some((g) => g > 200),
      detail: `chunks=${chunkTimes.length} gaps=${gaps.join(',')}`,
    };
  });
}

async function testLiveStatsStream() {
  return withServer({}, async (baseUrl) => {
    const submit = await post(baseUrl, '/runs', {
      language: 'python',
      code:
        'import time\n' +
        'data = bytearray()\n' +
        'for i in range(5):\n' +
        '    data += bytearray(5 * 1024 * 1024)\n' +
        '    time.sleep(0.06)\n' +
        'print("done")',
    });
    const events = await streamRun(baseUrl, submit.body.runId);
    const stats = events.filter((e) => e.type === 'stats');
    const memBytes = stats.map((s) => s.memBytes);
    return {
      name: 'live stats stream reports growing memory.current while it runs',
      pass: stats.length >= 3 && memBytes.at(-1) > memBytes[0],
      detail: `samples=${stats.length} memBytes=${memBytes.join(',')}`,
    };
  });
}

async function testPermalinkDataAvailableAfterFinish() {
  return withServer({}, async (baseUrl) => {
    const submit = await post(baseUrl, '/runs', { language: 'python', code: 'print("shareable")' });
    await streamRun(baseUrl, submit.body.runId);
    const res = await fetch(`${baseUrl}/r/${submit.body.runId}/data`);
    const body = await res.json();
    return {
      name: 'GET /r/:id/data returns the saved run right after finish, no race',
      pass:
        res.status === 200 &&
        body.language === 'python' &&
        body.code === 'print("shareable")' &&
        body.result.verdict === 'ok' &&
        body.result.stdout.includes('shareable'),
      detail: JSON.stringify(body).slice(0, 120),
    };
  });
}

async function testPermalinkPageServesHtml() {
  return withServer({}, async (baseUrl) => {
    const submit = await post(baseUrl, '/runs', { language: 'python', code: 'print(1)' });
    await streamRun(baseUrl, submit.body.runId);
    const res = await fetch(`${baseUrl}/r/${submit.body.runId}`);
    const contentType = res.headers.get('content-type') ?? '';
    return {
      name: 'GET /r/:id serves the permalink HTML page',
      pass: res.status === 200 && contentType.includes('text/html'),
      detail: `status=${res.status} content-type=${contentType}`,
    };
  });
}

async function testUnknownPermalinkReturns404() {
  return withServer({}, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/r/not-a-real-id/data`);
    return {
      name: 'GET /r/:id/data for an unknown id returns 404',
      pass: res.status === 404,
      detail: `status=${res.status}`,
    };
  });
}

async function testApiKeyIssuance() {
  return withServer({}, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/keys`, { method: 'POST' });
    const body = await res.json();
    return {
      name: 'POST /keys issues an sb_-prefixed key with a quota',
      pass: res.status === 201 && typeof body.key === 'string' && body.key.startsWith('sb_') && body.requestsPerHour > 0,
      detail: JSON.stringify(body),
    };
  });
}

async function testApiKeyUsageEndpoint() {
  return withServer({}, async (baseUrl) => {
    const issueRes = await fetch(`${baseUrl}/keys`, { method: 'POST' });
    const { key, requestsPerHour } = await issueRes.json();
    const usageRes = await fetch(`${baseUrl}/keys/${key}`);
    const usage = await usageRes.json();
    return {
      name: 'GET /keys/:key reports fresh, unused quota right after issuance',
      pass: usageRes.status === 200 && usage.used === 0 && usage.remaining === requestsPerHour,
      detail: JSON.stringify(usage),
    };
  });
}

async function testUnknownApiKeyReturns404() {
  return withServer({}, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/keys/sb_not_a_real_key`);
    return {
      name: 'GET /keys/:key for an unissued key returns 404',
      pass: res.status === 404,
      detail: `status=${res.status}`,
    };
  });
}

async function testAnonymousRateLimitBlocksExcessRequests() {
  return withServer(
    {},
    async (baseUrl) => {
      const results = [];
      for (let i = 0; i < 3; i++) {
        results.push(await post(baseUrl, '/runs', { language: 'python', code: 'print(1)' }));
      }
      const statuses = results.map((r) => r.status);
      const verdicts = results.map((r) => r.body.verdict ?? 'accepted');
      return {
        name: 'the request past the anonymous per-IP quota is rate_limited',
        pass: statuses[0] === 202 && statuses[1] === 202 && statuses[2] === 429 && verdicts[2] === 'rate_limited',
        detail: `statuses=${statuses.join(',')} verdicts=${verdicts.join(',')}`,
      };
    },
    { anonymousRequestsPerHour: 2 }
  );
}

async function testIssuedKeyHasItsOwnRateLimitBucket() {
  return withServer(
    {},
    async (baseUrl) => {
      const exhausted = await post(baseUrl, '/runs', { language: 'python', code: 'print(1)' });
      const blocked = await post(baseUrl, '/runs', { language: 'python', code: 'print(1)' });

      const { key } = await (await fetch(`${baseUrl}/keys`, { method: 'POST' })).json();
      const withKey = await post(
        baseUrl,
        '/runs',
        { language: 'python', code: 'print(1)' },
        { 'x-sandbin-key': key }
      );

      return {
        name: 'a request carrying an issued key is not throttled by the exhausted anonymous bucket',
        pass: exhausted.status === 202 && blocked.status === 429 && withKey.status === 202,
        detail: `exhausted=${exhausted.status} blocked=${blocked.status} withKey=${withKey.status}`,
      };
    },
    { anonymousRequestsPerHour: 1 }
  );
}

async function testInteractiveStdin() {
  return withServer({}, async (baseUrl) => {
    const submit = await post(baseUrl, '/runs', {
      language: 'python',
      code: 'name = input("name: ")\nprint("hello " + name)',
    });
    let sent = false;
    const events = await streamRun(baseUrl, submit.body.runId, {
      onEvent: (event, ws) => {
        if (!sent && event.type === 'chunk' && event.text.includes('name:')) {
          sent = true;
          ws.send(JSON.stringify({ type: 'stdin', text: 'ayaz\n' }));
        }
      },
    });
    const finished = events.find((e) => e.type === 'finished');
    return {
      name: 'interactive stdin: reply sent only after seeing the prompt',
      pass: sent && !!finished?.result.stdout.includes('hello ayaz'),
      detail: finished?.result.stdout.trim() ?? '(no result)',
    };
  });
}

async function testQueueFullReturns429() {
  return withServer({ maxConcurrency: 1, maxQueueLength: 1, maxPerKey: 64 }, async (baseUrl) => {
    const jobs = Array.from({ length: 4 }, () =>
      post(baseUrl, '/runs', { language: 'python', code: 'import time; time.sleep(0.3)' })
    );
    const results = await Promise.all(jobs);
    const statuses = results.map((r) => r.status).sort();
    return {
      name: 'queue_full over HTTP returns 429',
      pass: statuses.filter((s) => s === 202).length === 2 && statuses.filter((s) => s === 429).length === 2,
      detail: statuses.join(','),
    };
  });
}

async function testBadRequestReturns400() {
  return withServer({}, async (baseUrl) => {
    const res = await post(baseUrl, '/runs', { language: 'ruby', code: 'puts 1' });
    return {
      name: 'unknown language returns 400 immediately',
      pass: res.status === 400 && res.body.verdict === 'bad_request',
      detail: JSON.stringify(res.body),
    };
  });
}

async function testApiKeyHeaderTraversalDoesNotGrantElevatedQuota() {
  return withServer({}, async (baseUrl) => {
    const fs = await import('node:fs/promises');
    const outsideDir = await mkdtemp(path.join(tmpdir(), 'sandbin-outside-'));
    await fs.writeFile(
      path.join(outsideDir, 'canary.json'),
      JSON.stringify({ key: 'STOLEN', requestsPerHour: 999999 })
    );
    const traversalHeader = `../${path.basename(outsideDir)}/canary`;

    // If X-Sandbin-Key ever reaches apiKeys.load() unvalidated again, this
    // resolves outside apiKeyDir to the canary above and every one of
    // these requests gets accepted under its fake 999999/hour quota. With
    // the header format checked first, they all fall back to the real
    // anonymous limit instead.
    const results = [];
    for (let i = 0; i < 5; i++) {
      const res = await post(baseUrl, '/runs', { language: 'python', code: 'print(1)' }, { 'x-sandbin-key': traversalHeader });
      results.push(res.body.accepted ? 'accepted' : res.body.verdict);
    }
    await rm(outsideDir, { recursive: true, force: true }).catch(() => {});

    return {
      name: 'X-Sandbin-Key path traversal does not grant an elevated rate-limit quota',
      pass: results.filter((r) => r === 'rate_limited').length > 0,
      detail: results.join(','),
    };
  }, { anonymousRequestsPerHour: 3 });
}

async function testUnverifiedKeyHeaderCannotBypassMaxPerKey() {
  return withServer({ maxPerKey: 1 }, async (baseUrl) => {
    // Each request below carries a different, never-issued X-Sandbin-Key.
    // If an unverified header were still allowed to pick its own
    // concurrencyKey, every request would land in its own partition and
    // all four would be accepted despite maxPerKey: 1. With the fix, an
    // unverified header falls back to the shared IP key, so only the
    // first run in flight is accepted and the rest are key_limit-rejected.
    const jobs = Array.from({ length: 4 }, (_, i) =>
      post(
        baseUrl,
        '/runs',
        { language: 'python', code: 'import time; time.sleep(0.3)' },
        { 'x-sandbin-key': `sb_${'0'.repeat(31)}${i}` }
      )
    );
    const results = await Promise.all(jobs);
    const accepted = results.filter((r) => r.body.accepted).length;
    const keyLimited = results.filter((r) => r.body.verdict === 'key_limit').length;
    return {
      name: 'rotating an unverified X-Sandbin-Key header cannot bypass maxPerKey',
      pass: accepted === 1 && keyLimited === 3,
      detail: results.map((r) => r.body.accepted ? 'accepted' : r.body.verdict).join(','),
    };
  });
}

async function testKeyUsageRejectsPathTraversal() {
  return withServer({}, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/keys/${encodeURIComponent('../etc/passwd')}`);
    return {
      name: 'GET /keys/:key rejects a traversal-shaped key as 404, never touches the filesystem',
      pass: res.status === 404,
      detail: `status=${res.status}`,
    };
  });
}

async function testPermalinkDataRejectsPathTraversal() {
  return withServer({}, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/r/${encodeURIComponent('../../etc/passwd')}/data`);
    return {
      name: 'GET /r/:id/data rejects a non-UUID id as 404, never touches the filesystem',
      pass: res.status === 404,
      detail: `status=${res.status}`,
    };
  });
}

async function testReconnectAfterFinish() {
  return withServer({}, async (baseUrl) => {
    const submit = await post(baseUrl, '/runs', { language: 'python', code: 'print("done")' });
    await streamRun(baseUrl, submit.body.runId);
    const events2 = await streamRun(baseUrl, submit.body.runId);
    return {
      name: 'reconnecting after finish replays the final result',
      pass: events2.length === 1 && events2[0].type === 'finished' && events2[0].result.stdout.includes('done'),
      detail: events2.map((e) => e.type).join(','),
    };
  });
}

async function testMetricsReflectARealFinishedRun() {
  return withServer({}, async (baseUrl) => {
    const submit = await post(baseUrl, '/runs', { language: 'python', code: 'print("metered")' });
    await streamRun(baseUrl, submit.body.runId);
    const res = await fetch(`${baseUrl}/metrics/data`);
    const body = await res.json();
    return {
      name: 'GET /metrics/data reflects a real finished run, not just a submission',
      pass:
        res.status === 200 &&
        body.submitted >= 1 &&
        body.accepted >= 1 &&
        body.finished.total >= 1 &&
        body.finished.byVerdict.ok >= 1 &&
        body.finished.byLanguage.python >= 1,
      detail: JSON.stringify({ submitted: body.submitted, finished: body.finished }),
    };
  });
}

async function testMetricsCountRejectionsAndKeyIssuance() {
  return withServer({}, async (baseUrl) => {
    await post(baseUrl, '/runs', { language: 'ruby', code: 'puts 1' });
    await fetch(`${baseUrl}/keys`, { method: 'POST' });
    const res = await fetch(`${baseUrl}/metrics/data`);
    const body = await res.json();
    return {
      name: 'GET /metrics/data counts a rejection and a key issuance from real requests',
      pass: body.rejected.bad_request === 1 && body.keysIssued === 1 && typeof body.queue.running === 'number',
      detail: JSON.stringify({ rejected: body.rejected, keysIssued: body.keysIssued, queue: body.queue }),
    };
  });
}

async function testUnknownRunIdReturnsError() {
  return withServer({}, async (baseUrl) => {
    const events = await streamRun(baseUrl, 'not-a-real-id');
    return {
      name: 'unknown run id over WS returns an error event',
      pass: events.length === 1 && events[0].type === 'error',
      detail: JSON.stringify(events),
    };
  });
}

async function testMetricsRequiresAuthWhenConfigured() {
  return withServer({}, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/metrics/data`);
    return {
      name: 'GET /metrics/data returns 401 with no credentials when metrics auth is configured',
      pass: res.status === 401 && (res.headers.get('www-authenticate') ?? '').includes('Basic'),
      detail: `status=${res.status} www-authenticate=${res.headers.get('www-authenticate')}`,
    };
  }, { metricsAuth: { user: 'admin', pass: 'secret' } });
}

async function testMetricsPageAlsoRequiresAuthWhenConfigured() {
  return withServer({}, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/metrics`);
    return {
      name: 'GET /metrics (the HTML page, not just the data route) also requires auth when configured',
      pass: res.status === 401,
      detail: `status=${res.status}`,
    };
  }, { metricsAuth: { user: 'admin', pass: 'secret' } });
}

async function testMetricsRejectsWrongCredentials() {
  return withServer({}, async (baseUrl) => {
    const wrong = Buffer.from('admin:wrong').toString('base64');
    const res = await fetch(`${baseUrl}/metrics/data`, { headers: { authorization: `Basic ${wrong}` } });
    return {
      name: 'GET /metrics/data rejects incorrect credentials, not just missing ones',
      pass: res.status === 401,
      detail: `status=${res.status}`,
    };
  }, { metricsAuth: { user: 'admin', pass: 'secret' } });
}

async function testMetricsAcceptsCorrectBasicAuth() {
  return withServer({}, async (baseUrl) => {
    const correct = Buffer.from('admin:secret').toString('base64');
    const res = await fetch(`${baseUrl}/metrics/data`, { headers: { authorization: `Basic ${correct}` } });
    const body = await res.json();
    return {
      name: 'GET /metrics/data returns real data with correct Basic credentials',
      pass: res.status === 200 && typeof body.submitted === 'number',
      detail: `status=${res.status} submitted=${body.submitted}`,
    };
  }, { metricsAuth: { user: 'admin', pass: 'secret' } });
}

const CASES = [
  testBasicRunStreams,
  testChunksArriveIncrementally,
  testLiveStatsStream,
  testPermalinkDataAvailableAfterFinish,
  testPermalinkPageServesHtml,
  testUnknownPermalinkReturns404,
  testApiKeyIssuance,
  testApiKeyUsageEndpoint,
  testUnknownApiKeyReturns404,
  testAnonymousRateLimitBlocksExcessRequests,
  testIssuedKeyHasItsOwnRateLimitBucket,
  testInteractiveStdin,
  testQueueFullReturns429,
  testBadRequestReturns400,
  testApiKeyHeaderTraversalDoesNotGrantElevatedQuota,
  testUnverifiedKeyHeaderCannotBypassMaxPerKey,
  testKeyUsageRejectsPathTraversal,
  testPermalinkDataRejectsPathTraversal,
  testReconnectAfterFinish,
  testUnknownRunIdReturnsError,
  testMetricsReflectARealFinishedRun,
  testMetricsCountRejectionsAndKeyIssuance,
  testMetricsRequiresAuthWhenConfigured,
  testMetricsPageAlsoRequiresAuthWhenConfigured,
  testMetricsRejectsWrongCredentials,
  testMetricsAcceptsCorrectBasicAuth,
];

let passed = 0;
for (const testCase of CASES) {
  const { name, pass, detail } = await testCase();
  if (pass) passed++;
  console.log(`${pass ? '✅' : '❌'} ${name.padEnd(52)} ${detail}`);
}
console.log(`\n${passed}/${CASES.length} passed`);
process.exit(passed === CASES.length ? 0 : 1);
