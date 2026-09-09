import { WebSocket } from 'ws';
import { createServer } from './server.mjs';

function post(baseUrl, path, body) {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
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

async function withServer(queueLimits, fn) {
  const { httpServer } = createServer({ queueLimits });
  await new Promise((resolve) => httpServer.listen(0, resolve));
  const port = httpServer.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    return await fn(baseUrl);
  } finally {
    httpServer.close();
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

const CASES = [
  testBasicRunStreams,
  testChunksArriveIncrementally,
  testLiveStatsStream,
  testInteractiveStdin,
  testQueueFullReturns429,
  testBadRequestReturns400,
  testReconnectAfterFinish,
  testUnknownRunIdReturnsError,
];

let passed = 0;
for (const testCase of CASES) {
  const { name, pass, detail } = await testCase();
  if (pass) passed++;
  console.log(`${pass ? '✅' : '❌'} ${name.padEnd(52)} ${detail}`);
}
console.log(`\n${passed}/${CASES.length} passed`);
process.exit(passed === CASES.length ? 0 : 1);
