import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from './server.mjs';

const CLI_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'sandbin.mjs');

function runCli(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI_PATH, ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    child.stdin.end();
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

async function withServer(fn) {
  const permalinkDir = await mkdtemp(path.join(tmpdir(), 'sandbin-cli-permalinks-'));
  const apiKeyDir = await mkdtemp(path.join(tmpdir(), 'sandbin-cli-apikeys-'));
  const { httpServer } = createServer({ permalinkDir, apiKeyDir });
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

async function testLocalEvalPrintsOutputAndExitsZero() {
  const { code, stdout } = await runCli(['run', '-l', 'python', '-e', 'print(1 + 1)']);
  return {
    name: 'local: eval runs, streams stdout live, exits 0',
    pass: code === 0 && stdout.includes('2'),
    detail: stdout.trim(),
  };
}

async function testLocalNonOkVerdictExitsOne() {
  const { code, stderr } = await runCli(['run', '-l', 'python', '-e', 'import sys; sys.exit(3)']);
  return {
    name: 'local: guest exit(3) reports verdict error, cli exits 1 not 3',
    pass: code === 1 && /verdict\s+error/.test(stderr),
    detail: stderr.trim().replace(/\n/g, ' | '),
  };
}

async function testUnknownLanguageFailsCleanly() {
  const { code, stderr } = await runCli(['run', '-l', 'nope', '-e', 'whatever']);
  return {
    name: 'local: unknown language rejected with a clean message, not a stack trace',
    pass: code === 1 && stderr.includes('unknown language'),
    detail: stderr.trim(),
  };
}

async function testJsonModeOutputsStructuredResult() {
  const { code, stdout } = await runCli(['run', '-l', 'python', '-e', 'print("hi")', '--json']);
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {}
  return {
    name: '--json: prints one parseable result object with stdout and verdict',
    pass: code === 0 && parsed?.verdict === 'ok' && parsed.stdout.includes('hi'),
    detail: stdout.trim().slice(0, 120),
  };
}

async function testLanguageAutoDetectedFromExtension() {
  const dir = await mkdtemp(path.join(tmpdir(), 'sandbin-cli-file-'));
  const file = path.join(dir, 'main.py');
  await writeFile(file, 'print("from a file")');
  const { code, stdout } = await runCli(['run', file]);
  await rm(dir, { recursive: true, force: true }).catch(() => {});
  return {
    name: 'local: language auto-detected from the .py extension, no -l needed',
    pass: code === 0 && stdout.includes('from a file'),
    detail: stdout.trim(),
  };
}

async function testLanguagesListsPython() {
  const { code, stdout } = await runCli(['languages']);
  return {
    name: 'languages: lists python as available on this host',
    pass: code === 0 && stdout.split('\n').includes('python'),
    detail: stdout.trim().split('\n').join(','),
  };
}

async function testCompileErrorPrintsCompilerDiagnostic() {
  const { code, stderr } = await runCli(['run', '-l', 'c', '-e', 'this is not valid c']);
  return {
    name: 'local: c compile error prints the compiler diagnostic, not just a bare verdict',
    pass: code === 1 && /verdict\s+compile_error/.test(stderr) && stderr.length > 40,
    detail: stderr.trim().slice(0, 160).replace(/\n/g, ' '),
  };
}

async function testRemoteRunStreamsOverServer() {
  return withServer(async (baseUrl) => {
    const { code, stdout } = await runCli(['run', '-l', 'python', '-e', 'print("remote hello")', '--server', baseUrl]);
    return {
      name: 'remote: run streams stdout over a real HTTP+WS server',
      pass: code === 0 && stdout.includes('remote hello'),
      detail: stdout.trim(),
    };
  });
}

async function testRemoteRejectionExitsNonZero() {
  return withServer(async (baseUrl) => {
    const { code, stderr } = await runCli(['run', '-l', 'nope', '-e', 'x', '--server', baseUrl]);
    return {
      name: "remote: server-side rejection (bad_request) exits nonzero with the server's message",
      pass: code === 1 && stderr.includes('bad_request'),
      detail: stderr.trim(),
    };
  });
}

async function testReconnectReplaysAFinishedRun() {
  return withServer(async (baseUrl) => {
    // The server-assigned runId only ever surfaces in this acceptance
    // message — sandbox.run()'s own `id` field (in the --json result) is an
    // unrelated internal slug used for cgroup/bwrap naming, not the HTTP
    // layer's runId, so it can't be used to reconnect.
    const first = await runCli(['run', '-l', 'python', '-e', 'print("first pass")', '--server', baseUrl, '--json']);
    const runId = /run ([0-9a-f-]+) accepted/.exec(first.stderr)?.[1];
    if (!runId) return { name: 'reconnect: replays a finished run by id', pass: false, detail: `no runId in stderr: ${first.stderr.trim()}` };
    const { code, stdout } = await runCli(['run', '--server', baseUrl, '--reconnect', runId, '--json']);
    const parsed = JSON.parse(stdout || '{}');
    return {
      name: 'reconnect: replays a finished run by id instead of resubmitting',
      pass: code === 0 && parsed.stdout?.includes('first pass'),
      detail: stdout.trim().slice(0, 120),
    };
  });
}

async function testReconnectUnknownRunIdFailsCleanly() {
  return withServer(async (baseUrl) => {
    const { code, stderr } = await runCli(['run', '--server', baseUrl, '--reconnect', 'not-a-real-run-id']);
    return {
      name: 'reconnect: unknown run id reported cleanly, not a hang or a stack trace',
      pass: code === 1 && stderr.includes('unknown run id'),
      detail: stderr.trim(),
    };
  });
}

async function testReconnectWithoutServerFailsCleanly() {
  const { code, stderr } = await runCli(['run', '--reconnect', 'whatever']);
  return {
    name: 'reconnect: requires --server, rejected immediately without one',
    pass: code === 1 && stderr.includes('--reconnect requires --server'),
    detail: stderr.trim(),
  };
}

async function testRemoteKeysCreateAndStatus() {
  return withServer(async (baseUrl) => {
    const created = await runCli(['keys', 'create', '--server', baseUrl]);
    const key = /key\s+(\S+)/.exec(created.stdout)?.[1];
    const status = key ? await runCli(['keys', 'status', key, '--server', baseUrl]) : { code: 1, stdout: '' };
    return {
      name: 'keys: create then status round-trips through a real server',
      pass: created.code === 0 && !!key && status.code === 0 && status.stdout.includes('remaining'),
      detail: `${created.stdout.trim().split('\n')[0]} | ${status.stdout.trim().split('\n')[0]}`,
    };
  });
}

const CASES = [
  testLocalEvalPrintsOutputAndExitsZero,
  testLocalNonOkVerdictExitsOne,
  testUnknownLanguageFailsCleanly,
  testJsonModeOutputsStructuredResult,
  testLanguageAutoDetectedFromExtension,
  testLanguagesListsPython,
  testCompileErrorPrintsCompilerDiagnostic,
  testRemoteRunStreamsOverServer,
  testRemoteRejectionExitsNonZero,
  testReconnectReplaysAFinishedRun,
  testReconnectUnknownRunIdFailsCleanly,
  testReconnectWithoutServerFailsCleanly,
  testRemoteKeysCreateAndStatus,
];

let passed = 0;
for (const testCase of CASES) {
  const { name, pass, detail } = await testCase();
  if (pass) passed++;
  console.log(`${pass ? '✅' : '❌'} ${name.padEnd(58)} ${detail}`);
}
console.log(`\n${passed}/${CASES.length} passed`);
process.exit(passed === CASES.length ? 0 : 1);
