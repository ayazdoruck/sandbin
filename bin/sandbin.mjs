#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG = JSON.parse(readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));

const EXTENSION_LANGUAGES = {
  '.py': 'python',
  '.sh': 'bash',
  '.bash': 'bash',
  '.js': 'node',
  '.mjs': 'node',
  '.cjs': 'node',
  '.c': 'c',
  '.go': 'go',
};

function usage() {
  console.log(`sandbin v${PKG.version} — run untrusted code and survive it

Usage:
  sandbin run [file] [options]      run code through the sandbox
  sandbin languages                 list languages this host can run
  sandbin keys create [options]     issue an API key from a running server
  sandbin keys status [key] [opts]  check an API key's quota
  sandbin --version                 print the version
  sandbin --help                    show this help

Run options:
  -l, --language <lang>  language (auto-detected from the file extension)
  -e, --eval <code>      inline code instead of a file
  -i, --stdin <file>     file whose contents become the guest's stdin
                          ('-' reads from this process's own stdin)
  -s, --server <url>     submit to a running sandbin server instead of
                          running locally (env SANDBIN_SERVER)
  -k, --key <key>        API key sent as X-Sandbin-Key (env SANDBIN_KEY)
  --reconnect <runId>    skip submission, reattach to a run already in
                          flight on --server (printed when a run is
                          accepted, and again if the connection drops)
  --json                 print the full result as JSON instead of streaming
  --memory <bytes>       override the memory limit
  --cpu <percent>        override the CPU limit
  --timeout <ms>         override the wall-clock limit
  --pids <n>             override the process-count limit

Examples:
  sandbin run script.py
  sandbin run -l python -e 'print(1 + 1)'
  cat script.sh | sandbin run -l bash
  sandbin run server.js --server localhost:8080 --json
  sandbin run --server localhost:8080 --reconnect a1b2c3d4-...
  sandbin keys create --server sandbin.example.com`);
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => (data += chunk));
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

function normalizeServer(url) {
  const withScheme = /^https?:\/\//.test(url) ? url : `http://${url}`;
  return withScheme.replace(/\/$/, '');
}

function formatBytes(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function printSummary(result) {
  const lines = [
    ['verdict', result.verdict],
    ['duration', `${result.durationMs}ms`],
    ['cpu', `${result.cpuMs}ms`],
    ['peak memory', formatBytes(result.peakBytes)],
    ['exit code', result.exitCode ?? '-'],
  ];
  if (result.signal) lines.push(['signal', result.signal]);
  if (result.pidsMaxHits) lines.push(['pids.max hit', `${result.pidsMaxHits}x`]);
  if (result.oomKills) lines.push(['oom kills', String(result.oomKills)]);
  if (result.truncated) lines.push(['output', 'truncated']);

  const width = Math.max(...lines.map(([key]) => key.length));
  process.stderr.write('\n');
  for (const [key, value] of lines) process.stderr.write(`${key.padEnd(width)}  ${value}\n`);
}

// The compile phase (c, go) never streams through onChunk — only the
// execute phase does — so a compile failure would otherwise print a bare
// verdict with no hint of what the compiler actually said.
function printOutputIfMissed(result) {
  if (result.verdict !== 'compile_error' && result.verdict !== 'setup_failed') return;
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
}

async function runLocal({ language, code, stdin, limits, json }) {
  let sandbox;
  try {
    sandbox = await import('../src/sandbox.mjs');
  } catch (err) {
    console.error(`sandbin: local execution unavailable on this host (${err.message})`);
    console.error('sandbin: pass --server <url> to run against a running sandbin instance instead');
    return null;
  }
  if (!sandbox.IMAGES[language]) {
    console.error(`sandbin: unknown language '${language}' — run 'sandbin languages' to see what this host supports`);
    return null;
  }
  return sandbox.run({
    language,
    code,
    stdin,
    limits,
    // LIMIT_BOUNDS is sized for an anonymous HTTP-facing playground; this is
    // a local run on the user's own machine with no other tenants to
    // protect, so --timeout/--memory get real headroom instead of being
    // silently capped at the same 60s/512MB an anonymous web caller gets.
    limitBounds: sandbox.LOCAL_LIMIT_BOUNDS,
    onChunk: json ? undefined : (chunk) => process[chunk.stream === 'stdout' ? 'stdout' : 'stderr'].write(chunk.text),
  });
}

// Shared by a fresh submission and a bare --reconnect: attaches to an
// existing runId's stream and resolves once the run is done, one way or
// another. The `settled` guard matters because a clean 'close' can arrive
// after we've already resolved via 'finished'/'error' (we call ws.close()
// ourselves in both cases) — without it, the close handler below would fire
// a second, misleading "connection closed before it finished" message.
function watchRun({ base, runId, json }) {
  const wsUrl = `${base.replace(/^http/, 'ws')}/runs/${runId}/stream`;
  return new Promise((resolve) => {
    let settled = false;
    const settle = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const ws = new WebSocket(wsUrl);
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString('utf8'));
      if (msg.type === 'chunk' && !json) {
        process[msg.stream === 'stdout' ? 'stdout' : 'stderr'].write(msg.text);
      }
      if (msg.type === 'finished') {
        settle(msg.result);
        ws.close();
      }
      if (msg.type === 'error') {
        console.error(`sandbin: ${msg.message}`);
        settle(null);
        ws.close();
      }
    });
    ws.on('error', (err) => {
      console.error(`sandbin: websocket error (${err.message})`);
      settle(null);
    });
    // A drop that never surfaces a socket-level 'error' (server restart,
    // proxy timeout, network blip) still fires 'close'. The run itself keeps
    // going server-side either way — only this connection died — so point
    // the caller at --reconnect instead of leaving the promise hanging.
    ws.on('close', () => {
      if (settled) return;
      console.error(`sandbin: connection to run ${runId} closed before it finished`);
      console.error(`sandbin: the run may still be in progress — reconnect with: sandbin run --server ${base} --reconnect ${runId}`);
      settle(null);
    });
  });
}

async function runRemote({ server, key, language, code, stdin, limits, json }) {
  const base = normalizeServer(server);
  let res;
  try {
    res = await fetch(`${base}/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(key ? { 'x-sandbin-key': key } : {}) },
      body: JSON.stringify({ language, code, stdin, limits }),
    });
  } catch (err) {
    console.error(`sandbin: could not reach ${base} (${err.message})`);
    return null;
  }

  const body = await res.json().catch(() => ({}));
  if (!body.accepted) {
    console.error(`sandbin: ${body.verdict ?? 'rejected'} — ${body.message ?? 'run was not accepted'}`);
    return null;
  }

  console.error(`sandbin: run ${body.runId} accepted — if this connection drops, reconnect with: sandbin run --server ${base} --reconnect ${body.runId}`);
  return watchRun({ base, runId: body.runId, json });
}

function emitResult(result, opts) {
  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    printOutputIfMissed(result);
    printSummary(result);
  }
  process.exitCode = result.verdict === 'ok' ? 0 : 1;
}

async function cmdRun(argv) {
  const opts = {
    language: null,
    eval: null,
    stdinFile: null,
    server: process.env.SANDBIN_SERVER || null,
    key: process.env.SANDBIN_KEY || null,
    json: false,
    reconnect: null,
    limits: {},
  };
  const positional = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '-l': case '--language': opts.language = argv[++i]; break;
      case '-e': case '--eval': opts.eval = argv[++i]; break;
      case '-i': case '--stdin': opts.stdinFile = argv[++i]; break;
      case '-s': case '--server': opts.server = argv[++i]; break;
      case '-k': case '--key': opts.key = argv[++i]; break;
      case '--json': opts.json = true; break;
      case '--reconnect': opts.reconnect = argv[++i]; break;
      case '--memory': opts.limits.memoryBytes = Number(argv[++i]); break;
      case '--cpu': opts.limits.cpuPercent = Number(argv[++i]); break;
      case '--timeout': opts.limits.wallClockMs = Number(argv[++i]); break;
      case '--pids': opts.limits.pids = Number(argv[++i]); break;
      default:
        if (arg.startsWith('-')) {
          console.error(`sandbin: unknown option '${arg}'`);
          process.exitCode = 1;
          return;
        }
        positional.push(arg);
    }
  }

  // A bare reconnect skips submission entirely — it attaches to a runId a
  // previous invocation already got back (see the "run accepted" / "closed
  // before it finished" messages runRemote and watchRun print), so no
  // code/language is needed at all.
  if (opts.reconnect) {
    if (!opts.server) {
      console.error('sandbin: --reconnect requires --server <url>');
      process.exitCode = 1;
      return;
    }
    const result = await watchRun({ base: normalizeServer(opts.server), runId: opts.reconnect, json: opts.json });
    if (!result) {
      process.exitCode = 1;
      return;
    }
    return emitResult(result, opts);
  }

  const file = positional[0] ?? null;
  const readsCodeFromStdin = opts.eval === null && !file;

  if (readsCodeFromStdin && opts.stdinFile === '-') {
    console.error('sandbin: cannot read both code and guest stdin from this process\'s stdin');
    process.exitCode = 1;
    return;
  }

  const code = opts.eval !== null ? opts.eval : file ? readFileSync(file, 'utf8') : await readStdin();

  if (!opts.language) opts.language = file ? EXTENSION_LANGUAGES[path.extname(file)] : null;
  if (!opts.language) {
    console.error('sandbin: could not determine the language — pass -l/--language explicitly');
    process.exitCode = 1;
    return;
  }

  const stdin = opts.stdinFile === '-' ? await readStdin() : opts.stdinFile ? readFileSync(opts.stdinFile, 'utf8') : '';

  const result = opts.server
    ? await runRemote({ ...opts, code, stdin, language: opts.language })
    : await runLocal({ ...opts, code, stdin, language: opts.language });

  if (!result) {
    process.exitCode = 1;
    return;
  }

  emitResult(result, opts);
}

async function cmdLanguages() {
  let sandbox;
  try {
    sandbox = await import('../src/sandbox.mjs');
  } catch (err) {
    console.error(`sandbin: could not resolve this host's toolchains (${err.message})`);
    process.exitCode = 1;
    return;
  }
  for (const language of Object.keys(sandbox.IMAGES)) console.log(language);
}

function extractServer(argv) {
  const i = argv.findIndex((a) => a === '-s' || a === '--server');
  return i === -1 ? null : argv[i + 1];
}

async function cmdKeys(argv) {
  const sub = argv[0];
  const server = normalizeServer(extractServer(argv.slice(1)) || process.env.SANDBIN_SERVER || 'localhost:8080');

  if (sub === 'create') {
    let res;
    try {
      res = await fetch(`${server}/keys`, { method: 'POST' });
    } catch (err) {
      console.error(`sandbin: could not reach ${server} (${err.message})`);
      process.exitCode = 1;
      return;
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.error(`sandbin: ${body.message ?? 'key issuance failed'}`);
      process.exitCode = 1;
      return;
    }
    console.log(`key             ${body.key}`);
    console.log(`requestsPerHour ${body.requestsPerHour}`);
    console.log(`\nexport SANDBIN_KEY=${body.key}`);
    return;
  }

  if (sub === 'status') {
    const key = argv[1] && !argv[1].startsWith('-') ? argv[1] : process.env.SANDBIN_KEY;
    if (!key) {
      console.error('sandbin: pass a key or set SANDBIN_KEY');
      process.exitCode = 1;
      return;
    }
    let res;
    try {
      res = await fetch(`${server}/keys/${encodeURIComponent(key)}`);
    } catch (err) {
      console.error(`sandbin: could not reach ${server} (${err.message})`);
      process.exitCode = 1;
      return;
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.error(`sandbin: ${body.message ?? 'key not found'}`);
      process.exitCode = 1;
      return;
    }
    console.log(`key             ${body.key}`);
    console.log(`requestsPerHour ${body.requestsPerHour}`);
    console.log(`used            ${body.used}`);
    console.log(`remaining       ${body.remaining}`);
    console.log(`resetAt         ${new Date(body.resetAt).toISOString()}`);
    return;
  }

  console.error(`sandbin: unknown keys subcommand '${sub ?? ''}'`);
  console.error('usage: sandbin keys create|status [key] [--server <url>]');
  process.exitCode = 1;
}

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];

  if (!cmd || cmd === '--help' || cmd === '-h' || cmd === 'help') return usage();
  if (cmd === '--version' || cmd === '-v') return console.log(PKG.version);
  if (cmd === 'run') return cmdRun(argv.slice(1));
  if (cmd === 'languages') return cmdLanguages();
  if (cmd === 'keys') return cmdKeys(argv.slice(1));

  console.error(`sandbin: unknown command '${cmd}'\n`);
  usage();
  process.exitCode = 1;
}

main().catch((err) => {
  console.error(`sandbin: ${err.message}`);
  process.exitCode = 1;
});
