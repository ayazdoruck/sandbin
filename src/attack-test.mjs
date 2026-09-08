import { run } from './sandbox.mjs';
import { existsSync } from 'node:fs';

const CASES = [
  { name: 'ordinary program', language: 'python',
    code: 'print("hello from inside"); print(2 ** 64)',
    check: (r) => r.verdict === 'ok' && r.stdout.includes('18446744073709551616') },

  { name: 'reads stdin', language: 'python', stdin: 'ayaz\n',
    code: 'print("merhaba", input())',
    check: (r) => r.verdict === 'ok' && r.stdout.includes('merhaba ayaz') },

  { name: 'subprocess chain', language: 'python',
    code: 'import subprocess\nr = subprocess.run(["/usr/bin/bash", "-c", "echo child ok"], capture_output=True, text=True)\nprint(r.stdout.strip())',
    check: (r) => r.verdict === 'ok' && r.stdout.includes('child ok') },

  { name: 'threading', language: 'python',
    code: 'import threading\ndef f():\n    print("thread ok")\nt = threading.Thread(target=f)\nt.start()\nt.join()',
    check: (r) => r.verdict === 'ok' && r.stdout.includes('thread ok') },

  { name: 'infinite loop', language: 'python',
    code: 'while True: pass',
    check: (r) => r.verdict === 'timeout' },

  { name: 'cpu throttled', language: 'python',
    code: 'while True: pass',
    check: (r) => r.cpuMs < 3200 },

  { name: 'memory bomb', language: 'python',
    code: 'x = bytearray(512 * 1024 * 1024)',
    check: (r) => r.verdict === 'memory_limit' && r.oomKills > 0 },

  { name: 'fork bomb', language: 'bash',
    code: ':(){ :|:& };:',
    check: (r) => r.verdict === 'ok' && r.durationMs < 500 },

  { name: 'sustained fork bomb', language: 'bash',
    code: ':(){ :|:& };: ; sleep 10',
    check: (r) => r.pidsMaxHits > 0 && r.verdict === 'timeout' },

  { name: 'fork loop', language: 'python',
    code: 'import os\nwhile True:\n    os.fork()',
    check: (r) => r.pidsMaxHits > 0 },

  { name: 'network blocked', language: 'python',
    code: 'import socket\ntry:\n    socket.socket(socket.AF_INET, socket.SOCK_STREAM)\n    print("CONNECTED")\nexcept OSError as e:\n    print("blocked:", e)',
    check: (r) => !r.stdout.includes('CONNECTED') },

  { name: 'host fs invisible', language: 'python',
    code: 'print(open("/home/archy/.ssh/id_rsa").read())',
    check: (r) => r.verdict === 'error' },

  { name: 'writes stay inside', language: 'python',
    code: 'open("/pwned", "w").write("x"); print("wrote to my own tmpfs")',
    check: (r) => r.verdict === 'ok' && !existsSync('/pwned') },

  { name: 'host pids hidden', language: 'bash',
    code: 'ls -d /proc/[0-9]* | wc -l',
    check: (r) => Number(r.stdout.trim()) < 10 },

  { name: 'output flood', language: 'python',
    code: 'while True: print("A" * 1000)',
    check: (r) => r.verdict === 'output_limit' && r.truncated },

  { name: 'tmpfs bounded', language: 'python',
    code: 'open("/tmp/big","wb").write(b"A" * (64*1024*1024)); print("FILLED")',
    check: (r) => !r.stdout.includes('FILLED') },

  { name: 'nested user namespace blocked', language: 'python',
    code: 'import ctypes\nlibc = ctypes.CDLL(None, use_errno=True)\nr = libc.unshare(0x10000000)\nprint("unshare", r, ctypes.get_errno())',
    check: (r) => r.stdout.includes('unshare -1') },

  { name: 'raw clone with new-user flag blocked', language: 'python',
    code: 'import ctypes, signal, os\nlibc = ctypes.CDLL(None, use_errno=True)\npid = libc.syscall(56, 0x10000000 | signal.SIGCHLD, 0, 0, 0, 0)\nprint("clone", pid, ctypes.get_errno())',
    check: (r) => r.stdout.includes('clone -1') },

  { name: 'raw clone without dangerous flags still works', language: 'python',
    code: 'import ctypes, signal, os\nlibc = ctypes.CDLL(None, use_errno=True)\npid = libc.syscall(56, signal.SIGCHLD, 0, 0, 0, 0)\nif pid == 0:\n    os._exit(0)\nos.waitpid(pid, 0)\nprint("clone", pid)',
    check: (r) => r.verdict === 'ok' && !r.stdout.includes('clone -1') },

  { name: 'clone3 falls back instead of aborting', language: 'python',
    code: 'import ctypes\nlibc = ctypes.CDLL(None, use_errno=True)\nr = libc.syscall(435, 0, 0)\nprint("clone3", r, ctypes.get_errno())',
    check: (r) => r.stdout.includes('clone3 -1 38') },

  { name: 'ptrace blocked', language: 'python',
    code: 'import ctypes\nlibc = ctypes.CDLL(None, use_errno=True)\nr = libc.ptrace(0, 0, 0, 0)\nprint("ptrace", r, ctypes.get_errno())',
    check: (r) => r.stdout.includes('ptrace -1') },

  { name: 'mount blocked', language: 'python',
    code: 'import ctypes\nlibc = ctypes.CDLL(None, use_errno=True)\nr = libc.mount(b"none", b"/tmp", b"tmpfs", 0, 0)\nprint("mount", r, ctypes.get_errno())',
    check: (r) => r.stdout.includes('mount -1') },

  { name: 'io_uring blocked', language: 'python',
    code: 'import ctypes\nlibc = ctypes.CDLL(None, use_errno=True)\nr = libc.syscall(425, 8, 0)\nprint("io_uring_setup", r, ctypes.get_errno())',
    check: (r) => r.stdout.includes('io_uring_setup -1') },
];

let passed = 0;
for (const c of CASES) {
  const r = await run(c);
  if (r.verdict === 'error' && r.durationMs < 50) console.error('DEBUG', c.name, JSON.stringify(r.stderr));
  const good = !!c.check(r);
  if (good) passed++;
  console.log(
    `${good ? '✅' : '❌'} ${c.name.padEnd(38)} ${r.verdict.padEnd(14)}` +
    `${String(r.durationMs).padStart(5)}ms  cpu ${String(r.cpuMs).padStart(4)}ms  ` +
    `peak ${String(Math.round(r.peakBytes / 1048576)).padStart(3)}MB  ` +
    `oom ${r.oomKills}  pidcap ${r.pidsMaxHits}`
  );
}
console.log(`\n${passed}/${CASES.length} contained`);
process.exit(passed === CASES.length ? 0 : 1);
