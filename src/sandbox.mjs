import { spawn, execFileSync } from 'node:child_process';
import { mkdir, writeFile, readFile, rm, mkdtemp } from 'node:fs/promises';
import { readFileSync, realpathSync, mkdirSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ensureSeccompProgram } from './seccomp.mjs';

const DEBUG = !!process.env.SANDBIN_DEBUG;

const NODE_BIN = realpathSync(process.execPath);
const NODE_ROOT = path.dirname(path.dirname(NODE_BIN));

function resolveToolchain(command, args) {
  try {
    return execFileSync(command, args, { encoding: 'utf8' }).trim() || null;
  } catch {
    return null;
  }
}

// go is frequently managed by a version-switching shim (mise, asdf) that
// lives outside /usr and needs host state to resolve a version. Rather than
// expose that shim into the sandbox, resolve it once here and bind the real
// toolchain install straight in, the same way NODE_BIN above sidesteps
// needing to know where node itself happens to be installed.
const GO_ROOT = resolveToolchain('go', ['env', 'GOROOT']);
const GO_BIN = GO_ROOT ? path.join(GO_ROOT, 'bin', 'go') : null;

// Not under process.cwd() — bwrap, running under --unshare-all, can fail to
// bind a source path with a plain "Can't find source path: Permission
// denied" if any ancestor directory in that path isn't world-traversable,
// even when the caller is real root. This is invisible on a normal dev
// machine (you own your own home directory outright) but bites in exactly
// the CI setup this project's own workflow uses: the whole process runs as
// root for cgroup access, while the checkout itself — and therefore
// process.cwd() — is owned by an unprivileged runner user whose home
// directory isn't world-readable. os.tmpdir() is universally traversable
// regardless of that privilege mismatch, which is also exactly why hostDir
// below already uses it rather than cwd.
const GO_CACHE_DIR = path.join(tmpdir(), 'sandbin-go-cache');

// A guest's own GOCACHE is this same directory every time (shared, writable
// — see IMAGES.go below), but it starts out empty on a fresh checkout. With
// an empty cache, compiling anything at all means compiling the Go runtime
// and standard library from source first, which blows straight through the
// compile sandbox's file-size and memory ceilings sized for a one-file
// program. Warm the shared cache once, outside the sandbox entirely, so
// every real guest compile only ever has its own tiny package left to do.
//
// Importing fmt/net/time specifically, not an empty main(): a no-import
// warm-up program only compiles the bare runtime, leaving fmt (and its own
// dependency tree — errors, os, reflect, syscall...) still cold the first
// time any real program actually imports it. That gap was invisible on a
// fast, uncontended dev machine — the cold fmt compile finished within the
// compile sandbox's limits anyway — but showed up intermittently in CI on
// a slower or more contended runner as the exact pids.max/cold-cache
// failure this function exists to prevent in the first place.
function warmGoCache() {
  let dir;
  try {
    dir = mkdtempSync(path.join(tmpdir(), 'sandbin-gowarm-'));
    const warmupSource =
      'package main\n' +
      'import ("fmt"; "net"; "time")\n' +
      'func main() { fmt.Println(time.Now(), net.ParseIP("127.0.0.1")) }\n';
    writeFileSync(path.join(dir, 'main.go'), warmupSource);
    execFileSync(GO_BIN, ['build', '-o', path.join(dir, 'a.out'), path.join(dir, 'main.go')], {
      env: { ...process.env, GOCACHE: GO_CACHE_DIR, GOPATH: path.join(dir, 'gopath'), CGO_ENABLED: '0' },
      timeout: 180_000,
    });
  } catch (err) {
    // Not gated behind DEBUG: a failed warm-up leaves every real compile
    // to silently hit the exact cold-cache pids/ulimit failure this exists
    // to prevent, with nothing in a normal run's output explaining why —
    // worth a line even outside debug mode.
    console.error(`[sandbin] go cache warm-up failed: ${err.message}`);
  } finally {
    // GOCACHE itself is meant to persist (that's the whole point) — but the
    // scratch dir holding the warm-up program and GOPATH is not, and was
    // never being removed: a real, if small, leftover on every single
    // process start with Go available.
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
}

if (GO_BIN) {
  mkdirSync(GO_CACHE_DIR, { recursive: true });
  warmGoCache();
}

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

// caller-supplied limits (ultimately from an HTTP request body) end up
// interpolated into a shell script (openFiles, into `ulimit -n`) and
// written into cgroup control files (the rest) — every field here MUST be
// a plain, bounded integer by the time it leaves this function, no matter
// what shape or type the caller actually sent. A non-numeric value falls
// back to the default; a numeric one is clamped into a sane range, never
// passed through as-is.
const LIMIT_BOUNDS = {
  memoryBytes: { min: 1 * 1024 * 1024, max: 512 * 1024 * 1024 },
  cpuPercent: { min: 1, max: 100 },
  // bwrap's own setup needs at least 3 concurrent processes even for a
  // single-process guest program (confirmed empirically: pids=2 fails
  // pids.max on ordinary "print(1)", pids=3 doesn't) — a floor of 1 or 2
  // would make sanitizeLimits() itself the reason a legitimate run fails.
  pids: { min: 4, max: 256 },
  wallClockMs: { min: 100, max: 60_000 },
  outputBytes: { min: 1024, max: 4 * 1024 * 1024 },
  fileSizeBytes: { min: 1024, max: 64 * 1024 * 1024 },
  openFiles: { min: 4, max: 1024 },
  tmpfsBytes: { min: 1 * 1024 * 1024, max: 256 * 1024 * 1024 },
};

function sanitizeLimits(rawLimits) {
  const clean = {};
  for (const key of Object.keys(DEFAULT_LIMITS)) {
    const bounds = LIMIT_BOUNDS[key];
    const value = Number(rawLimits?.[key]);
    clean[key] = Number.isFinite(value)
      ? Math.min(bounds.max, Math.max(bounds.min, Math.trunc(value)))
      : DEFAULT_LIMITS[key];
  }
  return clean;
}

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

// Go is only registered when its toolchain was actually found on this host
// (see resolveToolchain above) — sandbin offers exactly the languages the
// machine it's running on can actually compile, rather than assuming a
// fixed install.
if (GO_BIN) {
  IMAGES.go = {
    file: 'main.go',
    compile: [GO_BIN, 'build', '-o', '/box/a.out', '/box/main.go'],
    argv: ['/box/a.out'],
    extraBinds: [GO_ROOT, { host: GO_CACHE_DIR, guest: '/gocache', writable: true }],
    env: { GOCACHE: '/gocache', GOPATH: '/tmp/go', GOFLAGS: '-p=2', GOMAXPROCS: '2', CGO_ENABLED: '0' },
  };
}

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

function cgroupPath(id) {
  return path.join(CG_PARENT, `run-${id}`);
}

async function configureCgroup(dir, limits) {
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

function buildBwrapArgs({ hostDir, argv, extraBinds, env, boxWritable }, lim, seccompFd) {
  const extraBindArgs = (extraBinds ?? []).flatMap((b) => {
    if (typeof b === 'string') return ['--ro-bind', b, b];
    return [b.writable ? '--bind' : '--ro-bind', b.host, b.guest ?? b.host];
  });
  const envArgs = Object.entries(env ?? {}).flatMap(([k, v]) => ['--setenv', k, v]);
  const boxBindFlag = boxWritable ? '--bind' : '--ro-bind';
  return [
    '--unshare-all',
    '--die-with-parent',
    '--new-session',
    '--clearenv',
    '--setenv', 'PATH', '/usr/bin',
    '--setenv', 'HOME', '/tmp',
    '--setenv', 'LANG', 'C.UTF-8',
    ...envArgs,
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
const STATS_INTERVAL_MS = 50;
const MAX_CHUNKS = 4_000;

async function spawnInSandbox({ id, hostDir, argv, extraBinds, env, boxWritable, lim, stdin = '', onChunk, onSpawn, onStats }) {
  const seccompBpfPath = ensureSeccompProgram();
  await ensureParentSlice();
  // The path itself is pure (just string joining) and can't fail; computing
  // it before the try block means the finally below always knows what to
  // clean up, even if configureCgroup's own mkdir/writeFile calls are what
  // throws — a directory that got as far as being created but not fully
  // configured is exactly as much of a leak as one left over after a later
  // failure, and deserves the same guaranteed cleanup.
  const cgroup = cgroupPath(id);

  // Everything from here on can throw for reasons that have nothing to do
  // with the guest (a spawn failure, a stats read racing teardown, a bug) —
  // the cgroup this function is about to create must be torn down
  // regardless of how this block exits, not only on the path that happens
  // to fall through to the end. A cgroup left behind here doesn't just
  // waste a kernel object: it's the same kind of resource a caller could
  // trigger on purpose, repeatedly, with no cap.
  try {
    await configureCgroup(cgroup, lim);

    const seccompFd = 9;
    const bwrapArgs = buildBwrapArgs({ hostDir, argv, extraBinds, env, boxWritable }, lim, seccompFd);

    // lim is sanitizeLimits()'s output by the time it reaches here — every
    // field is already a plain bounded integer — but this is also exactly
    // the point a raw value once reached `sh -c` unescaped and became a
    // shell-injection vector (ulimit -n), so it gets re-asserted as an
    // integer right at the interpolation site too, not just trusted from
    // upstream. Never build this script from anything that hasn't been
    // through that same coercion.
    const fileSizeKb = Math.max(0, Math.trunc(Number(lim.fileSizeBytes)) || 0) >> 10;
    const openFiles = Math.max(1, Math.trunc(Number(lim.openFiles)) || DEFAULT_LIMITS.openFiles);
    const script =
      `echo $$ > '${cgroup}/cgroup.procs' || exit ${CGROUP_ASSIGN_FAILED}; ` +
      `ulimit -f ${fileSizeKb}; ` +
      `ulimit -n ${openFiles}; ` +
      `ulimit -c 0; ` +
      `exec ${seccompFd}< '${seccompBpfPath}'; ` +
      `exec bwrap "$@"`;

    const child = spawn('/bin/sh', ['-c', script, 'sandbin', ...bwrapArgs], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const startedAt = Date.now();

    let stdout = '', stderr = '', truncated = false, verdict = null, chunkCount = 0;
    const collect = (chunk, which) => {
      const room = lim.outputBytes - (stdout.length + stderr.length);
      if (room <= 0 || chunkCount >= MAX_CHUNKS) {
        if (!truncated) {
          truncated = true;
          verdict ??= 'output_limit';
          killCgroup(cgroup);
        }
        return;
      }
      chunkCount++;
      const text = chunk.toString('utf8').slice(0, room);
      if (which === 'out') stdout += text; else stderr += text;
      if (onChunk) onChunk({ stream: which === 'out' ? 'stdout' : 'stderr', text, t: Date.now() - startedAt });
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

    const hardStopGraceMs = 2_000;

    const statsTimer = onStats
      ? setInterval(async () => {
          const memBytes = Number(await readStat(cgroup, 'memory.current', '0'));
          const cpuUsec = Number(/usage_usec (\d+)/.exec(await readStat(cgroup, 'cpu.stat'))?.[1] ?? 0);
          onStats({ t: Date.now() - startedAt, memBytes, cpuMs: Math.round(cpuUsec / 1000) });
        }, STATS_INTERVAL_MS)
      : null;

    const exit = await new Promise((resolve) => {
      let settled = false;
      // Clearing the timers/interval happens here, inside settle() itself,
      // not in a separate 'close' listener: the hard timer resolves this
      // promise directly, without waiting for 'close', and JS's own
      // microtask-before-next-macrotask ordering guarantees the code after
      // this await always runs before a same-tick-or-later 'close' could —
      // so a 'close'-only cleanup is *never* run in time on that path. The
      // practical effect was a live statsTimer still firing (and the
      // eventual cgroup rm() racing it) after the result had already been
      // returned to the caller — the exact scenario the hard timer exists
      // to handle in the first place.
      const settle = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(softTimer);
        clearTimeout(hardTimer);
        clearInterval(statsTimer);
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

    return {
      verdict, exitCode: exit.code, signal: exit.signal,
      stdout, stderr, truncated,
      durationMs, cpuMs: Math.round(cpuUsec / 1000), peakBytes, oomKills, pidsMaxHits,
    };
  } finally {
    await killCgroup(cgroup);
    await rm(cgroup, { recursive: true, force: true }).catch(() => {});
  }
}

export async function run({ language = 'python', code = '', stdin = '', limits = {}, onChunk, onSpawn, onStats } = {}) {
  const spec = IMAGES[language];
  if (!spec) throw new Error(`unknown language: ${language}`);
  const lim = sanitizeLimits(limits);
  const id = randomUUID().slice(0, 8);

  const hostDir = await mkdtemp(path.join(tmpdir(), 'sandbin-'));
  // Every exit from here on — normal completion, the early compile_error
  // return, or spawnInSandbox throwing outright — must remove hostDir.
  // It used to only happen on the paths that fell through to the bottom of
  // this function, which meant any exception in between (a malformed-limit
  // write failure was the one actually found) left the guest's own
  // submitted source sitting in /tmp forever, on demand, for free.
  try {
    await writeFile(path.join(hostDir, spec.file), code);

    if (spec.compile) {
      const compileResult = await spawnInSandbox({
        id: `${id}c`, hostDir, argv: spec.compile, extraBinds: spec.extraBinds, env: spec.env,
        boxWritable: true, lim: COMPILE_LIMITS,
      });
      if (compileResult.verdict !== 'ok') {
        const verdict = compileResult.verdict === 'error' ? 'compile_error' : compileResult.verdict;
        return { id, ...compileResult, verdict };
      }
    }

    const result = await spawnInSandbox({
      id, hostDir, argv: spec.argv, extraBinds: spec.extraBinds, env: spec.env, lim, stdin, onChunk, onSpawn, onStats,
    });
    return { id, ...result };
  } finally {
    await rm(hostDir, { recursive: true, force: true }).catch(() => {});
  }
}
