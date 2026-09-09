import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { createQueue } from './queue.mjs';
import { IMAGES } from './sandbox.mjs';
import { createPermalinkStore } from './permalinks.mjs';
import { createApiKeyStore } from './apikeys.mjs';
import { createRateLimiter } from './ratelimit.mjs';

const CLEANUP_DELAY_MS = 30_000;
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const ANONYMOUS_REQUESTS_PER_HOUR = 20;
const KEY_ISSUANCE_PER_HOUR = 5;
const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const DEFAULT_PERMALINK_DIR = path.join(process.cwd(), 'data', 'runs');
const DEFAULT_APIKEY_DIR = path.join(process.cwd(), 'data', 'keys');

const STATIC_ROUTES = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/styles.css': { file: 'styles.css', type: 'text/css; charset=utf-8' },
  '/app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8' },
  '/permalink.js': { file: 'permalink.js', type: 'text/javascript; charset=utf-8' },
};

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        req.destroy();
        reject(new Error('request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

export function createServer({
  queueLimits = {},
  permalinkDir = DEFAULT_PERMALINK_DIR,
  apiKeyDir = DEFAULT_APIKEY_DIR,
  rateLimitWindowMs,
  anonymousRequestsPerHour = ANONYMOUS_REQUESTS_PER_HOUR,
} = {}) {
  const queue = createQueue(queueLimits);
  const runs = new Map();
  const permalinks = createPermalinkStore({ dir: permalinkDir });
  const apiKeys = createApiKeyStore({ dir: apiKeyDir });
  const rateLimiter = createRateLimiter(rateLimitWindowMs ? { windowMs: rateLimitWindowMs } : {});
  const keyIssuanceLimiter = createRateLimiter(rateLimitWindowMs ? { windowMs: rateLimitWindowMs } : {});

  function broadcast(record, message) {
    const payload = JSON.stringify(message);
    for (const socket of record.sockets) {
      if (socket.readyState === socket.OPEN) socket.send(payload);
    }
  }

  function scheduleCleanup(runId) {
    setTimeout(() => runs.delete(runId), CLEANUP_DELAY_MS).unref();
  }

  function submitRun(body, key, rateLimitId, requestsPerHour) {
    const limit = rateLimiter.check(rateLimitId, requestsPerHour);
    if (!limit.allowed) {
      return {
        accepted: false,
        verdict: 'rate_limited',
        message: `rate limit exceeded (${requestsPerHour}/hour)`,
        retryAfterMs: limit.resetAt - Date.now(),
      };
    }
    if (!IMAGES[body?.language]) {
      return { accepted: false, verdict: 'bad_request', message: `unknown language: ${body?.language}` };
    }
    if (typeof body.code !== 'string') {
      return { accepted: false, verdict: 'bad_request', message: 'code must be a string' };
    }

    const record = {
      status: 'queued', position: null, chunks: [], stats: [], result: null,
      sockets: new Set(), stdinHandle: null,
    };

    const language = body.language;
    const code = body.code;
    const stdin = typeof body.stdin === 'string' ? body.stdin : '';

    const ticket = queue.submit(
      {
        language,
        code,
        stdin,
        limits: body.limits ?? {},
        onSpawn: (handle) => {
          record.status = 'running';
          record.stdinHandle = handle;
          broadcast(record, { type: 'started' });
        },
        onChunk: (chunk) => {
          record.chunks.push(chunk);
          broadcast(record, { type: 'chunk', ...chunk });
        },
        onStats: (stats) => {
          record.stats.push(stats);
          broadcast(record, { type: 'stats', ...stats });
        },
      },
      { key }
    );

    if (!ticket.accepted) return { accepted: false, verdict: ticket.verdict };

    const runId = randomUUID();
    const createdAt = Date.now();
    record.position = ticket.position;
    runs.set(runId, record);

    ticket.result.then(async (result) => {
      record.status = 'finished';
      record.result = result;
      await permalinks
        .save(runId, { id: runId, language, code, stdin, createdAt, chunks: record.chunks, stats: record.stats, result })
        .catch(() => {});
      broadcast(record, { type: 'finished', result });
      for (const socket of record.sockets) socket.close();
      scheduleCleanup(runId);
    });

    return { accepted: true, runId, position: ticket.position };
  }

  function attachSocket(runId, socket) {
    const record = runs.get(runId);
    if (!record) {
      socket.send(JSON.stringify({ type: 'error', message: 'unknown run id' }));
      socket.close();
      return;
    }

    if (record.status === 'finished') {
      socket.send(JSON.stringify({ type: 'finished', result: record.result }));
      socket.close();
      return;
    }

    if (record.status === 'running') {
      socket.send(JSON.stringify({ type: 'started' }));
      for (const chunk of record.chunks) socket.send(JSON.stringify({ type: 'chunk', ...chunk }));
      for (const stats of record.stats) socket.send(JSON.stringify({ type: 'stats', ...stats }));
    } else {
      socket.send(JSON.stringify({ type: 'queued', position: record.position }));
    }

    record.sockets.add(socket);
    socket.on('close', () => record.sockets.delete(socket));
    socket.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString('utf8'));
      } catch {
        return;
      }
      if (msg.type === 'stdin') record.stdinHandle?.write(String(msg.text ?? ''));
      if (msg.type === 'stdin_close') record.stdinHandle?.endStdin();
    });
  }

  const httpServer = http.createServer((req, res) => {
    if (req.method === 'GET' && STATIC_ROUTES[req.url]) {
      const route = STATIC_ROUTES[req.url];
      readFile(path.join(PUBLIC_DIR, route.file))
        .then((data) => {
          res.writeHead(200, { 'content-type': route.type });
          res.end(data);
        })
        .catch(() => {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ message: 'failed to read static asset' }));
        });
      return;
    }

    const permalinkDataMatch = req.method === 'GET' && /^\/r\/([^/]+)\/data$/.exec(req.url ?? '');
    if (permalinkDataMatch) {
      permalinks.load(permalinkDataMatch[1]).then((record) => {
        if (!record) {
          res.writeHead(404, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ message: 'not found' }));
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(record));
      });
      return;
    }

    const permalinkPageMatch = req.method === 'GET' && /^\/r\/[^/]+$/.exec(req.url ?? '');
    if (permalinkPageMatch) {
      readFile(path.join(PUBLIC_DIR, 'permalink.html'))
        .then((data) => {
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
          res.end(data);
        })
        .catch(() => {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ message: 'failed to read static asset' }));
        });
      return;
    }

    if (req.method === 'POST' && req.url === '/runs') {
      const ip = req.socket.remoteAddress;
      const headerKey = req.headers['x-sandbin-key'];
      const concurrencyKey = headerKey || ip;
      readJsonBody(req)
        .then(async (body) => {
          const issuedKey = headerKey ? await apiKeys.load(headerKey) : null;
          const rateLimitId = issuedKey ? `key:${issuedKey.key}` : `ip:${ip}`;
          const requestsPerHour = issuedKey ? issuedKey.requestsPerHour : anonymousRequestsPerHour;
          const outcome = submitRun(body, concurrencyKey, rateLimitId, requestsPerHour);
          const status = outcome.accepted ? 202 : outcome.verdict === 'bad_request' ? 400 : 429;
          res.writeHead(status, { 'content-type': 'application/json' });
          res.end(JSON.stringify(outcome));
        })
        .catch((err) => {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ accepted: false, verdict: 'bad_request', message: err.message }));
        });
      return;
    }

    if (req.method === 'POST' && req.url === '/keys') {
      const ip = req.socket.remoteAddress;
      const limit = keyIssuanceLimiter.check(`ip:${ip}`, KEY_ISSUANCE_PER_HOUR);
      if (!limit.allowed) {
        res.writeHead(429, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          message: `key issuance rate limit exceeded (${KEY_ISSUANCE_PER_HOUR}/hour)`,
          retryAfterMs: limit.resetAt - Date.now(),
        }));
        return;
      }
      apiKeys.issue().then((record) => {
        res.writeHead(201, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ key: record.key, requestsPerHour: record.requestsPerHour }));
      });
      return;
    }

    const keyUsageMatch = req.method === 'GET' && /^\/keys\/([^/]+)$/.exec(req.url ?? '');
    if (keyUsageMatch) {
      apiKeys.load(keyUsageMatch[1]).then((record) => {
        if (!record) {
          res.writeHead(404, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ message: 'not found' }));
          return;
        }
        const usage = rateLimiter.peek(`key:${record.key}`, record.requestsPerHour);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          key: record.key,
          requestsPerHour: record.requestsPerHour,
          used: usage.count,
          remaining: usage.remaining,
          resetAt: usage.resetAt,
        }));
      });
      return;
    }

    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ message: 'not found' }));
  });

  const wss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (req, socket, head) => {
    const match = /^\/runs\/([^/]+)\/stream$/.exec(req.url ?? '');
    if (!match) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => attachSocket(match[1], ws));
  });

  return { httpServer, queue, runs, permalinks };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT ?? 8080);
  const { httpServer, permalinks } = createServer();
  permalinks.sweep().catch(() => {});
  setInterval(() => permalinks.sweep().catch(() => {}), SWEEP_INTERVAL_MS).unref();
  httpServer.listen(port, () => console.log(`sandbin listening on :${port}`));
}
