# sandbin

[![CI](https://github.com/ayazdoruck/sandbin/actions/workflows/ci.yml/badge.svg)](https://github.com/ayazdoruck/sandbin/actions/workflows/ci.yml)

Runs untrusted code and survives it. No Docker, no root, no VM.

A submission gets its own PID namespace, its own network stack (empty), its own
filesystem view, a syscall allowlist, and hard ceilings on memory, CPU and
process count. When it misbehaves — and the test suite makes sure it does — it
dies, and the host doesn't notice.

Cold start is about **20 ms**, and the whole thing runs as an ordinary user.

**[Read the docs →](https://sandbin.vercel.app/)** — architecture,
API reference, per-language notes, and the real bugs found building this,
written up in full.

## Why not Docker

Docker needs a daemon, root or rootless plumbing, and image pulls, and costs
hundreds of milliseconds per container. Everything sandbin needs is already in
the kernel: namespaces, cgroup v2, seccomp and rlimits. Skipping the container
runtime is what buys the 20 ms start and lets the same code run somewhere as
small as a phone.

## How it is contained

Four independent layers, so no single bug is an escape:

| Layer | Enforces |
| --- | --- |
| **Namespaces** (bubblewrap) | No network, no host filesystem, no host processes, private tmpfs root |
| **Seccomp** | Syscall allowlist — everything not explicitly needed by the guest runtime is denied |
| **cgroup v2** | `memory.max`, `cpu.max`, `pids.max`, and `cgroup.kill` for instant teardown |
| **rlimits** | File size, open descriptors, no core dumps |

Plus a wall-clock deadline enforced by the supervisor itself.

Three details matter more than they look:

- **The guest is PID 1 in its own namespace.** When it exits, the kernel reaps
  everything it spawned. A classic fork bomb dies in ~15 ms without the pids
  ceiling ever being touched.
- **`cgroup.kill` kills the whole tree in one write.** No PID chasing, no
  processes surviving the reaper.
- **The seccomp filter is a strict allowlist, not a blocklist.** 142
  syscalls are permitted — enough for Python, Bash, Node and a compiled C
  binary, nothing more; everything else — `ptrace`, `mount`, `unshare`,
  `io_uring_setup`, raw sockets, nested user namespaces via `clone` — returns
  `EPERM` by default. `clone` itself stays allowed for ordinary fork/thread
  use; only the call is checked for the specific flags
  (`CLONE_NEWUSER`/`CLONE_NEWNS`/`CLONE_NEWPID`/`CLONE_NEWNET`/`CLONE_NEWUTS`/
  `CLONE_NEWIPC`/`CLONE_NEWCGROUP`) that would let an already-unprivileged
  guest create a fresh, "privileged-inside" namespace of its own. `clone3` is
  denied with `ENOSYS` specifically rather than `EPERM`, so glibc's built-in
  fallback to `clone()` runs the program normally instead of aborting it.
  `getsockopt`/`getsockname` are allowed too — runtimes like Node's libuv
  probe any stdio fd with them to tell a pipe from a socket, regardless of
  what it actually is — but only as metadata reads on an fd the guest already
  holds; `socket()` itself, which would actually create one, stays denied.
  The filter covers the native x86_64 syscall table plus the 32-bit and x32
  compat ABIs, closing the classic bypass of reaching the kernel through a
  syscall table the filter forgot about.

## Usage

```js
import { run } from './src/sandbox.mjs';

const result = await run({
  language: 'python',
  code: 'print(sum(range(100)))',
  stdin: '',
  limits: { memoryBytes: 128 << 20, cpuPercent: 50, wallClockMs: 5000 },
});

console.log(result.verdict, result.stdout);
// -> ok  '4950\n'
```

`language` is `python`, `bash`, `node` or `c`. The first three run directly;
`c` compiles with `gcc` under its own more permissive limits first (256 MB,
10 s — compiling legitimately needs more of both than running a script does)
and only executes the result if that succeeds. A compile failure returns
verdict `compile_error` with the compiler's diagnostic as `stderr`, without
ever reaching the execute phase.

`verdict` is one of `ok`, `error`, `timeout`, `memory_limit`, `output_limit`,
`killed`, `setup_failed`, `compile_error`. The result also carries `cpuMs`,
`peakBytes`, `oomKills` and `pidsMaxHits`, read straight from the cgroup.

`run()` always settles within `wallClockMs + 2s`, no matter what the guest or
its descendants do. The deadline itself is `cgroup.kill`; the extra two
seconds are a hard backstop that force-closes the process and its pipes if
something downstream is still holding them open, so a misbehaving submission
can never wedge the supervisor itself.

The seccomp policy is compiled from `seccomp/policy.c` on first use and cached
as `seccomp/policy.bpf`; neither file is checked in, both are regenerated
automatically the first time `run()` is called.

### Queue

Calling `run()` directly spawns a sandbox immediately, with no limit on how
many run at once. `queue.mjs` sits in front of it for anything with more than
one caller:

```js
import { createQueue } from './src/queue.mjs';

const queue = createQueue({ maxConcurrency: 4, maxQueueLength: 64, maxPerKey: 8 });

const ticket = queue.submit(
  { language: 'python', code: 'print("hi")' },
  { key: 'user-123' }
);

if (!ticket.accepted) {
  console.log(ticket.verdict); // 'queue_full' or 'key_limit'
} else {
  console.log('queued at position', ticket.position);
  const result = await ticket.result; // same shape as run()'s, plus queuedMs
}
```

`submit()` never throws and never blocks: it returns synchronously, either
accepted with a queue position or rejected on the spot if the global backlog
or the caller's own `key` is already at capacity.

### Server

```bash
npm start
```

Starts an HTTP + WebSocket server on `PORT` (default `8080`) in front of the
queue.

**`POST /runs`** submits a job and returns immediately:

```bash
curl -s -X POST localhost:8080/runs \
  -H 'content-type: application/json' \
  -d '{"language":"python","code":"print(1+1)"}'
# -> {"accepted":true,"runId":"...","position":0}
```

A rejection looks the same shape, with `accepted: false` and no `runId` —
HTTP 429 for `queue_full`/`key_limit`, 400 for a malformed request (unknown
language, missing code). The submitter's `key` for per-key limiting is the
`X-Sandbin-Key` header if present, otherwise their IP.

**`GET /runs/:runId/stream`** (WebSocket) delivers the run's story as JSON
messages, one per frame:

```
{ "type": "queued", "position": 2 }
{ "type": "started" }
{ "type": "chunk", "stream": "stdout", "text": "2\n" }
{ "type": "finished", "result": { "verdict": "ok", "stdout": "2\n", ... } }
```

Connecting after the run has already started replays every chunk seen so
far before continuing live; connecting after it's finished replays just the
final `finished` message and closes. Sending `{ "type": "stdin", "text":
"..." }` over the socket writes to the guest's stdin while it's running —
this is what makes a real `input()` call work, not just a fixed string
supplied up front. `{ "type": "stdin_close" }` sends EOF.

### Frontend

`npm start` serves it at `/` — plain HTML, CSS and JS, no framework, no
build step, black and white only. Pick a language, write code, run, watch
it stream. The stdin box stays live for the duration of the run, so a
program that calls `input()` actually works, not just one given its input
up front.

## Tests

```bash
npm test
```

The suite is adversarial: every case is code that tries to break out, and a
pass means it was stopped. Assertions check observable evidence — cgroup
counters, host-side file checks, the specific errno a blocked syscall returns
— rather than the guest's own exit status, which a guest could lie about.

```
✅ ordinary program                       ✅ ptrace blocked
✅ reads stdin                            ✅ mount blocked
✅ subprocess chain                       ✅ io_uring blocked
✅ threading                              ✅ node: ordinary program
✅ infinite loop                          ✅ node: stdin via readline
✅ cpu throttled                          ✅ node: network blocked at the syscall level
✅ memory bomb                            ✅ node: sustained memory bomb caught
✅ fork bomb                              ✅ c: compiles and runs
✅ sustained fork bomb                    ✅ c: syntax error reported as compile_error
✅ fork loop                              ✅ c: nonzero exit code surfaces as error
✅ network blocked                        ✅ c: sustained memory bomb caught
✅ host fs invisible                      ✅ c: network blocked at the syscall level
✅ writes stay inside
✅ host pids hidden
✅ output flood
✅ tmpfs bounded
✅ nested user namespace blocked
✅ raw clone with new-user flag blocked
✅ raw clone without dangerous flags still works
✅ clone3 falls back instead of aborting

32/32 contained
```

`npm run test:queue` covers the queue separately, against real spawned
sandbox runs rather than mocks — actual concurrency observed under load,
backpressure firing exactly at capacity, a crashing job still freeing its
slot:

```
✅ concurrency is bounded                           peakRunning=3
✅ queue_full rejects past capacity, immediately    accepted=3 rejected=2
✅ per-key limit is independent of other keys       acceptedA=2 rejectedA=2 ticketsB.accepted=true
✅ queuedMs reflects real wait time                 first=0ms second=523ms
✅ queue returns to idle after draining             running=0 waiting=0 keys=0
✅ a failing job still releases its concurrency slot crash=error after=ok

6/6 passed
```

`npm run test:server` spins up the real HTTP + WebSocket server on an
ephemeral port — no mocks — and drives it end to end:

```
✅ basic run streams started -> chunk -> finished       queued,started,chunk,finished
✅ chunks arrive incrementally, not all at once         chunks=3 gaps=300,300
✅ interactive stdin: reply sent only after seeing the prompt name: hello ayaz
✅ queue_full over HTTP returns 429                     202,202,429,429
✅ unknown language returns 400 immediately             {"accepted":false,"verdict":"bad_request",...}
✅ reconnecting after finish replays the final result   finished
✅ unknown run id over WS returns an error event        [{"type":"error",...}]

7/7 passed
```

## Requirements

- Linux with cgroup v2 and unprivileged user namespaces
- `bubblewrap`, `gcc`, `libseccomp` — `gcc` doubles as the C language's own
  compiler and is required regardless of whether you ever run C, since it
  also builds the seccomp policy from `seccomp/policy.c` on first use
- `cpu`, `memory` and `pids` delegated somewhere in the caller's own cgroup
  ancestry, at a level holding no processes of its own. A normal desktop or
  SSH login session gets this from systemd for free — sandbin walks up from
  its own `/proc/self/cgroup` at startup and roots itself at the nearest
  ancestor that qualifies. A raw CI job or a plain systemd service without
  `Delegate=yes` usually has no such ancestor anywhere in its tree; running
  as root sidesteps that (root owns the whole cgroup filesystem), which is
  what this project's own CI does. Either way, if delegation genuinely isn't
  available, cgroup assignment fails loudly with the `setup_failed` verdict
  instead of silently running unconfined.
- Node 20+
- `ws` — the only runtime dependency, used for the WebSocket server

## Status

All six roadmap phases are done: namespace/cgroup/seccomp/rlimit isolation,
a bounded and backpressured job queue, a streaming HTTP + WebSocket API,
Python/Bash/Node/C support, a minimal browser frontend, and CI running all
three test suites on every push. `npm start` and open it. See
[ROADMAP.md](ROADMAP.md) for what was actually found building each phase —
several real bugs, not just a feature checklist.

### Known issues

- Threat model: this hardens the sandbox against careless or mildly malicious
  code, not against an attacker who already has a kernel exploit. Guest and
  host share one kernel; seccomp shrinks the reachable syscall surface, it
  does not add a second kernel between them the way a VM-based sandbox would.
- A memory spike brief enough to allocate, get used, and exit before cgroup
  v2 escalates from reclaim to an OOM kill can slip through `memory.max`
  without being caught. This is a property of the kernel's reclaim-before-kill
  behavior, not something sandbin controls, and applies equally to any
  language — see the C findings in [ROADMAP.md](ROADMAP.md#phase-4--per-language-runtime-images-done)
  for how this was found. A *sustained* excess is always caught; the gap is
  specifically for spikes fast enough to free themselves first.
