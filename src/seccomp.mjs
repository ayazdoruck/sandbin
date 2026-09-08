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

let cachedPath = null;

export function ensureSeccompProgram() {
  if (cachedPath) return cachedPath;
  if (isStale(GENERATOR_BINARY, POLICY_SOURCE)) compileGenerator();
  if (isStale(BPF_PROGRAM, GENERATOR_BINARY)) exportBpfProgram();
  cachedPath = BPF_PROGRAM;
  return cachedPath;
}
