const DEMOS = {
  hello: {
    label: 'hello',
    language: 'python',
    code: 'import time\nprint("booting sandbox...")\ntime.sleep(0.4)\nprint("namespace: isolated")\ntime.sleep(0.3)\nprint("seccomp: 142 syscalls allowed")\ntime.sleep(0.3)\nprint("cgroup: memory=128MB cpu=50%")\ntime.sleep(0.3)\nprint("done.")',
    events: [
      { t: 0, type: 'started' },
      { t: 40, type: 'chunk', stream: 'stdout', text: 'booting sandbox...\n' },
      { t: 440, type: 'chunk', stream: 'stdout', text: 'namespace: isolated\n' },
      { t: 740, type: 'chunk', stream: 'stdout', text: 'seccomp: 142 syscalls allowed\n' },
      { t: 1040, type: 'chunk', stream: 'stdout', text: 'cgroup: memory=128MB cpu=50%\n' },
      { t: 1340, type: 'chunk', stream: 'stdout', text: 'done.\n' },
    ],
    result: {
      verdict: 'ok', exitCode: 0, durationMs: 1318, cpuMs: 14, peakBytes: 4124672,
      oomKills: 0, pidsMaxHits: 0,
    },
  },

  forkbomb: {
    label: 'fork bomb',
    language: 'bash',
    code: 'echo "spawning as many processes as possible..."\n:(){ :|:& };:\nsleep 10',
    events: [
      { t: 0, type: 'started' },
      { t: 40, type: 'chunk', stream: 'stdout', text: 'spawning as many processes as possible...\n' },
      { t: 300, type: 'chunk', stream: 'stderr', text: 'fork: retry: Resource temporarily unavailable\n' },
      { t: 340, type: 'chunk', stream: 'stderr', text: 'fork: retry: Resource temporarily unavailable\n' },
      { t: 380, type: 'chunk', stream: 'stderr', text: 'fork: retry: Resource temporarily unavailable\n' },
      { t: 420, type: 'chunk', stream: 'stderr', text: '... (pids.max hit 86 times) ...\n' },
    ],
    result: {
      verdict: 'timeout', exitCode: null, signal: 'SIGKILL', durationMs: 5006, cpuMs: 33,
      peakBytes: 11739136, oomKills: 0, pidsMaxHits: 86,
    },
  },

  memory: {
    label: 'memory limit',
    language: 'python',
    code: 'print("allocating 512MB...")\nx = bytearray(512 * 1024 * 1024)\nprint("should not get here")',
    events: [
      { t: 0, type: 'started' },
      { t: 30, type: 'chunk', stream: 'stdout', text: 'allocating 512MB...\n' },
    ],
    result: {
      verdict: 'memory_limit', exitCode: null, signal: null, durationMs: 34, cpuMs: 12,
      peakBytes: 134217728, oomKills: 1, pidsMaxHits: 0,
    },
  },

  compiled: {
    label: 'compiled c',
    language: 'c',
    code: '#include <stdio.h>\nint main(){\n  printf("compiling and running inside the sandbox\\n");\n  printf("pid namespace: isolated\\n");\n  return 0;\n}',
    events: [
      { t: 0, type: 'started' },
      { t: 60, type: 'chunk', stream: 'stdout', text: 'compiling and running inside the sandbox\npid namespace: isolated\n' },
    ],
    result: {
      verdict: 'ok', exitCode: 0, durationMs: 9, cpuMs: 4, peakBytes: 1224704,
      oomKills: 0, pidsMaxHits: 0,
    },
  },

  breakout: {
    label: 'breakout attempt',
    language: 'python',
    note: 'paced for readability — the real run took 27ms start to finish',
    code: "import ctypes\nlibc = ctypes.CDLL(None, use_errno=True)\n\ndef attempt(name, fn):\n    r = fn()\n    err = ctypes.get_errno()\n    print(f'[{name}] blocked (errno {err})' if r == -1 else f'[{name}] SUCCEEDED - this would be bad')\n\nprint('attempting to break out of the sandbox, four ways:')\nattempt('ptrace a sibling process',      lambda: libc.ptrace(0, 0, 0, 0))\nattempt('mount a filesystem',            lambda: libc.mount(b'none', b'/tmp', b'tmpfs', 0, 0))\nattempt('create a nested user namespace',lambda: libc.unshare(0x10000000))\nattempt('io_uring_setup',                lambda: libc.syscall(425, 8, 0))\nprint('still contained.')",
    events: [
      { t: 0, type: 'started' },
      { t: 30, type: 'chunk', stream: 'stdout', text: 'attempting to break out of the sandbox, four ways:\n' },
      { t: 430, type: 'chunk', stream: 'stdout', text: '[ptrace a sibling process] blocked (errno 1)\n' },
      { t: 830, type: 'chunk', stream: 'stdout', text: '[mount a filesystem] blocked (errno 1)\n' },
      { t: 1230, type: 'chunk', stream: 'stdout', text: '[create a nested user namespace] blocked (errno 1)\n' },
      { t: 1630, type: 'chunk', stream: 'stdout', text: '[io_uring_setup] blocked (errno 1)\n' },
      { t: 2030, type: 'chunk', stream: 'stdout', text: 'still contained.\n' },
    ],
    result: {
      verdict: 'ok', exitCode: 0, durationMs: 27, cpuMs: 20, peakBytes: 5173248,
      oomKills: 0, pidsMaxHits: 0,
    },
  },
};
