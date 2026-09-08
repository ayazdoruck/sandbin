import { spawn } from 'node:child_process';
import { mkdir, writeFile, readFile, rm, mkdtemp } from 'node:fs/promises';
import { readFileSync, realpathSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ensureSeccompProgram } from './seccomp.mjs';

const NODE_BIN = realpathSync(process.execPath);
const NODE_ROOT = path.dirname(path.dirname(NODE_BIN));

const NEEDED_CONTROLLERS = ['cpu', 'memory', 'pids'];
const CGROUP_FS_ROOT = '/sys/fs/cgroup';

function availableControllers(dir) {
  try {
    return new Set(readFileSync(path.join(dir, 'cgroup.controllers'), 'utf8').trim().split(/\s+/));
  } catch {
    return new Set();
  }
}

function isProcessFree(dir) {
  try {
    return readFileSync(path.join(dir, 'cgroup.procs'), 'utf8').trim() === '';
  } catch {
    return false;
  }
}

function alreadyEnabled(dir) {
  try {
    const enabled = new Set(
      readFileSync(path.join(dir, 'cgroup.subtree_control'), 'utf8').trim().split(/\s+/).filter(Boolean)
    );
    return NEEDED_CONTROLLERS.every((c) => enabled.has(c));
  } catch {
    return false;
  }
}

function canHostDelegation(dir) {
  const hasAllControllers = NEEDED_CONTROLLERS.every((c) => availableControllers(dir).has(c));
  return hasAllControllers && (alreadyEnabled(dir) || isProcessFree(dir));
}

function findDelegatedRoot() {
  const ownPath = readFileSync('/proc/self/cgroup', 'utf8').trim().replace(/^0::/, '');
  let dir = path.join(CGROUP_FS_ROOT, ownPath);
  while (dir !== CGROUP_FS_ROOT && dir !== path.dirname(dir)) {
    if (canHostDelegation(dir)) return dir;
    dir = path.dirname(dir);
  }
  return path.join(CGROUP_FS_ROOT, ownPath);
}

const CG_ROOT = findDelegatedRoot();
const CG_PARENT = path.join(CG_ROOT, 'sandbin.slice');

export const DEFAULT_LIMITS = {
  memoryBytes: 128 * 1024 * 1024,
  cpuPercent: 50,
  pids: 32,
  wallClockMs: 5_000,
  outputBytes: 64 * 1024,
  fileSizeBytes: 1024 * 1024,
  openFiles: 64,
  tmpfsBytes: 16 * 1024 * 1024,
};

const COMPILE_LIMITS = {
  memoryBytes: 256 * 1024 * 1024,
  cpuPercent: 100,
  pids: 16,
  wallClockMs: 10_000,
  outputBytes: 64 * 1024,
  fileSizeBytes: 8 * 1024 * 1024,
  openFiles: 64,
  tmpfsBytes: 32 * 1024 * 1024,
};

export const IMAGES = {
  python: { file: 'main.py', argv: ['/usr/bin/python3', '-I', '-B', '-u', '/box/main.py'] },
  bash: { file: 'main.sh', argv: ['/usr/bin/bash', '--noprofile', '--norc', '/box/main.sh'] },
  node: { file: 'main.js', argv: [NODE_BIN, '/box/main.js'], extraBinds: [NODE_ROOT] },
  c: {
    file: 'main.c',
    compile: ['/usr/bin/gcc', '-O2', '-o', '/box/a.out', '/box/main.c'],
    argv: ['/box/a.out'],
  },
};

const DEBUG = !!process.env.SANDBIN_DEBUG;

async function enableControllers(dir) {
  const toEnable = NEEDED_CONTROLLERS.filter((c) => availableControllers(dir).has(c));
  if (toEnable.length === 0) {
    if (DEBUG) console.error(`[sandbin] ${dir}: no needed controllers available, skipping`);
    return;
  }
  try {
    await writeFile(path.join(dir, 'cgroup.subtree_control'), toEnable.map((c) => `+${c}`).join(' '));
    if (DEBUG) console.error(`[sandbin] ${dir}: enabled ${toEnable.join(',')}`);
  } catch (err) {
    if (DEBUG) console.error(`[sandbin] ${dir}: enable failed ${err.code} ${err.message}`);
    if (err.code !== 'EBUSY' && err.code !== 'EINVAL' && err.code !== 'EACCES' && err.code !== 'ENOENT') {
      throw err;
    }
  }
}

async function ensureParentSlice() {
  if (DEBUG) console.error(`[sandbin] CG_ROOT=${CG_ROOT}`);
  await mkdir(CG_PARENT, { recursive: true });
  await enableControllers(CG_ROOT);
  await enableControllers(CG_PARENT);
}

async function createCgroup(id, limits) {
  const dir = path.join(CG_PARENT, `run-${id}`);
  await mkdir(dir, { recursive: true });
  if (DEBUG) {
    console.error(`[sandbin] ${dir}: created, own controllers=${[...availableControllers(dir)].join(',')}`);
  }
  await writeFile(path.join(dir, 'memory.max'), String(limits.memoryBytes));
  await writeFile(path.join(dir, 'memory.swap.max'), '0');
  await writeFile(path.join(dir, 'pids.max'), String(limits.pids));
  if (availableControllers(dir).has('cpu')) {
    await writeFile(path.join(dir, 'cpu.max'), `${limits.cpuPercent * 1000} 100000`);
  }
  return dir;
}

async function killCgroup(dir) {
  try {
    await writeFile(path.join(dir, 'cgroup.kill'), '1');
  } catch {}
}

async function readStat(dir, file, fallback = '') {
  try {
    return (await readFile(path.join(dir, file), 'utf8')).trim();
  } catch {
    return fallback;
  }
}

function buildBwrapArgs({ hostDir, argv, extraBinds, boxWritable }, lim, seccompFd) {
  const extraBindArgs = (extraBinds ?? []).flatMap((p) => ['--ro-bind', p, p]);
  const boxBindFlag = boxWritable ? '--bind' : '--ro-bind';
  return [
    '--unshare-all',
    '--die-with-parent',
    '--new-session',
    '--clearenv',
    '--setenv', 'PATH', '/usr/bin',
    '--setenv', 'HOME', '/tmp',
    '--setenv', 'LANG', 'C.UTF-8',
    '--ro-bind', '/usr', '/usr',
    '--ro-bind', '/etc/ld.so.cache', '/etc/ld.so.cache',
    ...extraBindArgs,
    '--symlink', 'usr/lib', '/lib',
    '--symlink', 'usr/lib64', '/lib64',
    '--symlink', 'usr/bin', '/bin',
    '--symlink', 'usr/sbin', '/sbin',
    '--proc', '/proc',
    '--dev', '/dev',
    '--size', String(lim.tmpfsBytes), '--tmpfs', '/tmp',
    boxBindFlag, hostDir, '/box',
    '--chdir', '/box',
    '--seccomp', String(seccompFd),
    '--',
    ...argv,
  ];
}

const CGROUP_ASSIGN_FAILED = 91;

async function spawnInSandbox({ id, hostDir, argv, extraBinds, boxWritable, lim, stdin = '', onChunk, onSpawn }) {
  const seccompBpfPath = ensureSeccompProgram();
  await ensureParentSlice();
  const cgroup = await createCgroup(id, lim);

  const seccompFd = 9;
  const bwrapArgs = buildBwrapArgs({ hostDir, argv, extraBinds, boxWritable }, lim, seccompFd);

  const script =
    `echo $$ > '${cgroup}/cgroup.procs' || exit ${CGROUP_ASSIGN_FAILED}; ` +
    `ulimit -f ${Math.floor(lim.fileSizeBytes / 1024)}; ` +
    `ulimit -n ${lim.openFiles}; ` +
    `ulimit -c 0; ` +
    `exec ${seccompFd}< '${seccompBpfPath}'; ` +
    `exec bwrap "$@"`;

  const child = spawn('/bin/sh', ['-c', script, 'sandbin', ...bwrapArgs], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let stdout = '', stderr = '', truncated = false, verdict = null;
  const collect = (chunk, which) => {
    const room = lim.outputBytes - (stdout.length + stderr.length);
    if (room <= 0) {
      if (!truncated) {
        truncated = true;
        verdict ??= 'output_limit';
        killCgroup(cgroup);
      }
      return;
    }
    const text = chunk.toString('utf8').slice(0, room);
    if (which === 'out') stdout += text; else stderr += text;
    if (onChunk) onChunk({ stream: which === 'out' ? 'stdout' : 'stderr', text });
  };
  child.stdout.on('data', (c) => collect(c, 'out'));
  child.stderr.on('data', (c) => collect(c, 'err'));

  child.stdin.on('error', () => {});
  if (onSpawn) {
    if (stdin) child.stdin.write(stdin);
    onSpawn({
      write: (text) => { try { child.stdin.write(text); } catch {} },
      endStdin: () => { try { child.stdin.end(); } catch {} },
    });
  } else {
    child.stdin.end(stdin);
  }

  const startedAt = Date.now();
  const hardStopGraceMs = 2_000;

  const exit = await new Promise((resolve) => {
    let settled = false;
    const settle = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    child.on('close', (code, signal) => settle({ code, signal }));

    const softTimer = setTimeout(() => {
      verdict ??= 'timeout';
      killCgroup(cgroup);
    }, lim.wallClockMs);

    const hardTimer = setTimeout(() => {
      verdict ??= 'killed';
      child.stdout.destroy();
      child.stderr.destroy();
      child.kill('SIGKILL');
      settle({ code: null, signal: 'SIGKILL' });
    }, lim.wallClockMs + hardStopGraceMs);

    child.on('close', () => {
      clearTimeout(softTimer);
      clearTimeout(hardTimer);
    });
  });

  const durationMs = Date.now() - startedAt;
  const events = await readStat(cgroup, 'memory.events');
  const oomKills = Number(/oom_kill (\d+)/.exec(events)?.[1] ?? 0);
  const peakBytes = Number(await readStat(cgroup, 'memory.peak', '0'));
  const cpuUsec = Number(/usage_usec (\d+)/.exec(await readStat(cgroup, 'cpu.stat'))?.[1] ?? 0);
  const pidsMaxHits = Number(/max (\d+)/.exec(await readStat(cgroup, 'pids.events'))?.[1] ?? 0);

  if (!verdict && exit.code === CGROUP_ASSIGN_FAILED) verdict = 'setup_failed';
  if (!verdict && oomKills > 0) verdict = 'memory_limit';
  if (!verdict && exit.signal) verdict = 'killed';
  if (!verdict) verdict = exit.code === 0 ? 'ok' : 'error';

  await killCgroup(cgroup);
  await rm(cgroup, { recursive: true, force: true }).catch(() => {});

  return {
    verdict, exitCode: exit.code, signal: exit.signal,
    stdout, stderr, truncated,
    durationMs, cpuMs: Math.round(cpuUsec / 1000), peakBytes, oomKills, pidsMaxHits,
  };
}

export async function run({ language = 'python', code = '', stdin = '', limits = {}, onChunk, onSpawn } = {}) {
  const spec = IMAGES[language];
  if (!spec) throw new Error(`unknown language: ${language}`);
  const lim = { ...DEFAULT_LIMITS, ...limits };
  const id = randomUUID().slice(0, 8);

  const hostDir = await mkdtemp(path.join(tmpdir(), 'sandbin-'));
  await writeFile(path.join(hostDir, spec.file), code);

  if (spec.compile) {
    const compileResult = await spawnInSandbox({
      id: `${id}c`, hostDir, argv: spec.compile, extraBinds: spec.extraBinds,
      boxWritable: true, lim: COMPILE_LIMITS,
    });
    if (compileResult.verdict !== 'ok') {
      await rm(hostDir, { recursive: true, force: true }).catch(() => {});
      const verdict = compileResult.verdict === 'error' ? 'compile_error' : compileResult.verdict;
      return { id, ...compileResult, verdict };
    }
  }

  const result = await spawnInSandbox({
    id, hostDir, argv: spec.argv, extraBinds: spec.extraBinds, lim, stdin, onChunk, onSpawn,
  });
  await rm(hostDir, { recursive: true, force: true }).catch(() => {});
  return { id, ...result };
}
