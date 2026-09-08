import { spawn } from 'node:child_process';
import { mkdir, writeFile, readFile, rm, mkdtemp } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ensureSeccompProgram } from './seccomp.mjs';

const UID = process.getuid();
const CG_ROOT = `/sys/fs/cgroup/user.slice/user-${UID}.slice/user@${UID}.service`;
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

export const IMAGES = {
  python: { file: 'main.py', argv: ['/usr/bin/python3', '-I', '-B', '/box/main.py'] },
  bash: { file: 'main.sh', argv: ['/usr/bin/bash', '--noprofile', '--norc', '/box/main.sh'] },
};

async function ensureParentSlice() {
  await mkdir(CG_PARENT, { recursive: true });
  try {
    await writeFile(path.join(CG_PARENT, 'cgroup.subtree_control'), '+cpu +memory +pids');
  } catch (err) {
    if (err.code !== 'EBUSY' && err.code !== 'EINVAL') throw err;
  }
}

async function createCgroup(id, limits) {
  const dir = path.join(CG_PARENT, `run-${id}`);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'memory.max'), String(limits.memoryBytes));
  await writeFile(path.join(dir, 'memory.swap.max'), '0');
  await writeFile(path.join(dir, 'pids.max'), String(limits.pids));
  await writeFile(path.join(dir, 'cpu.max'), `${limits.cpuPercent * 1000} 100000`);
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

function buildBwrapArgs(image, lim, seccompFd) {
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
    '--symlink', 'usr/lib', '/lib',
    '--symlink', 'usr/lib64', '/lib64',
    '--symlink', 'usr/bin', '/bin',
    '--symlink', 'usr/sbin', '/sbin',
    '--proc', '/proc',
    '--dev', '/dev',
    '--size', String(lim.tmpfsBytes), '--tmpfs', '/tmp',
    '--ro-bind', image.hostDir, '/box',
    '--chdir', '/box',
    '--seccomp', String(seccompFd),
    '--',
    ...image.argv,
  ];
}

export async function run({ language = 'python', code = '', stdin = '', limits = {} } = {}) {
  const spec = IMAGES[language];
  if (!spec) throw new Error(`unknown language: ${language}`);
  const lim = { ...DEFAULT_LIMITS, ...limits };
  const id = randomUUID().slice(0, 8);

  const seccompBpfPath = ensureSeccompProgram();
  await ensureParentSlice();
  const cgroup = await createCgroup(id, lim);
  const hostDir = await mkdtemp(path.join(tmpdir(), 'sandbin-'));
  await writeFile(path.join(hostDir, spec.file), code);

  const seccompFd = 9;
  const bwrapArgs = buildBwrapArgs({ ...spec, hostDir }, lim, seccompFd);

  const script =
    `echo $$ > ${cgroup}/cgroup.procs; ` +
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
  };
  child.stdout.on('data', (c) => collect(c, 'out'));
  child.stderr.on('data', (c) => collect(c, 'err'));

  child.stdin.on('error', () => {});
  child.stdin.end(stdin);

  const startedAt = Date.now();
  const timer = setTimeout(() => {
    verdict ??= 'timeout';
    killCgroup(cgroup);
  }, lim.wallClockMs);

  const exit = await new Promise((resolve) => {
    child.on('close', (code, signal) => resolve({ code, signal }));
  });
  clearTimeout(timer);

  const durationMs = Date.now() - startedAt;
  const events = await readStat(cgroup, 'memory.events');
  const oomKills = Number(/oom_kill (\d+)/.exec(events)?.[1] ?? 0);
  const peakBytes = Number(await readStat(cgroup, 'memory.peak', '0'));
  const cpuUsec = Number(/usage_usec (\d+)/.exec(await readStat(cgroup, 'cpu.stat'))?.[1] ?? 0);
  const pidsMaxHits = Number(/max (\d+)/.exec(await readStat(cgroup, 'pids.events'))?.[1] ?? 0);

  if (!verdict && oomKills > 0) verdict = 'memory_limit';
  if (!verdict && exit.signal) verdict = 'killed';
  if (!verdict) verdict = exit.code === 0 ? 'ok' : 'error';

  await killCgroup(cgroup);
  await rm(cgroup, { recursive: true, force: true }).catch(() => {});
  await rm(hostDir, { recursive: true, force: true }).catch(() => {});

  return {
    id, verdict, exitCode: exit.code, signal: exit.signal,
    stdout, stderr, truncated,
    durationMs, cpuMs: Math.round(cpuUsec / 1000), peakBytes, oomKills, pidsMaxHits,
  };
}
