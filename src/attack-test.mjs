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

  { name: 'node: ordinary program', language: 'node',
    code: 'console.log("hello from node"); console.log(2 ** 10)',
    check: (r) => r.verdict === 'ok' && r.stdout.includes('hello from node') && r.stdout.includes('1024') },

  { name: 'node: stdin via readline', language: 'node', stdin: 'ayaz\n',
    code: 'const rl = require("readline").createInterface({ input: process.stdin });\nrl.on("line", (l) => { console.log("hello " + l); rl.close(); })',
    check: (r) => r.verdict === 'ok' && r.stdout.includes('hello ayaz') },

  { name: 'node: network blocked at the syscall level', language: 'node',
    code: 'require("net").connect(80, "1.1.1.1")',
    check: (r) => r.verdict === 'error' && r.stderr.includes('EPERM') },

  { name: 'node: sustained memory bomb caught', language: 'node',
    code: 'const buf = Buffer.alloc(200 * 1024 * 1024, 1);\nconst start = Date.now();\nwhile (Date.now() - start < 2000) { buf[0] = 1; }',
    check: (r) => r.verdict === 'memory_limit' && r.oomKills > 0 },

  { name: 'c: compiles and runs', language: 'c',
    code: '#include <stdio.h>\nint main(){ printf("hello from c\\n"); return 0; }',
    check: (r) => r.verdict === 'ok' && r.stdout.includes('hello from c') },

  { name: 'c: syntax error reported as compile_error', language: 'c',
    code: '#include <stdio.h>\nint main() { this is not c',
    check: (r) => r.verdict === 'compile_error' && r.stderr.length > 0 },

  { name: 'c: nonzero exit code surfaces as error', language: 'c',
    code: '#include <stdio.h>\nint main(){ printf("ran\\n"); return 7; }',
    check: (r) => r.verdict === 'error' && r.exitCode === 7 && r.stdout.includes('ran') },

  { name: 'c: sustained memory bomb caught', language: 'c',
    code: '#include <stdio.h>\n#include <stdlib.h>\n#include <string.h>\n#include <unistd.h>\nint main(){ size_t n = 200*1024*1024; char *p = malloc(n); memset(p,1,n); sleep(3); printf("sum=%d\\n", p[0]+p[n-1]); return 0; }',
    check: (r) => r.verdict === 'memory_limit' && r.oomKills > 0 },

  { name: 'c: network blocked at the syscall level', language: 'c',
    code: '#include <sys/socket.h>\n#include <netinet/in.h>\n#include <arpa/inet.h>\n#include <stdio.h>\nint main(){ int fd = socket(AF_INET, SOCK_STREAM, 0); struct sockaddr_in a = {0}; a.sin_family = AF_INET; a.sin_port = htons(80); inet_pton(AF_INET, "1.1.1.1", &a.sin_addr); int r = connect(fd, (struct sockaddr*)&a, sizeof(a)); printf("connect=%d\\n", r); return 0; }',
    check: (r) => !r.stdout.includes('connect=0') },
];

let passed = 0;
for (const c of CASES) {
  const r = await run(c);
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
