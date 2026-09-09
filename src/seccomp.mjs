import { spawnSync } from 'node:child_process';
import { existsSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SECCOMP_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'seccomp');
const POLICY_SOURCE = path.join(SECCOMP_DIR, 'policy.c');
const GENERATOR_BINARY = path.join(SECCOMP_DIR, 'gen-policy');
const BPF_PROGRAM = path.join(SECCOMP_DIR, 'policy.bpf');

function isStale(target, dependency) {
  if (!existsSync(target)) return true;
  return statSync(target).mtimeMs < statSync(dependency).mtimeMs;
}

function compileGenerator() {
  const result = spawnSync(
    'gcc',
    ['-O2', '-Wall', '-Wextra', '-o', GENERATOR_BINARY, POLICY_SOURCE, '-lseccomp'],
    { encoding: 'utf8' }
  );
  if (result.status !== 0) {
    throw new Error(`seccomp policy compile failed: ${result.stderr}`);
  }
}

function exportBpfProgram() {
  const result = spawnSync(GENERATOR_BINARY, [], { encoding: 'buffer' });
  if (result.status !== 0) {
    throw new Error(`seccomp policy export failed: ${result.stderr.toString('utf8')}`);
  }
  writeFileSync(BPF_PROGRAM, result.stdout);
}

// Deliberately no "already checked once, trust it forever" shortcut: this
// runs once per sandboxed spawn already, and a stat() call or two is not
// measurable next to actually spawning bwrap and a cgroup for that same
// run. Caching the *path* is fine (it never changes); caching the
// *validity* meant a long-running server process would never notice if
// policy.bpf changed on disk after its first request — a narrow window
// (it requires host filesystem write access to matter at all), but a
// free one to close.
export function ensureSeccompProgram() {
  if (isStale(GENERATOR_BINARY, POLICY_SOURCE)) compileGenerator();
  if (isStale(BPF_PROGRAM, GENERATOR_BINARY)) exportBpfProgram();
  return BPF_PROGRAM;
}
