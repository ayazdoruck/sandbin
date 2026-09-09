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

`language` is `python`, `bash`, `node`, `c` or `go` (Go only if a toolchain
was actually found on the host — see below). Python/Bash/Node run directly;
`c` and `go` compile first under their own more permissive limits (256 MB,
10 s — compiling legitimately needs more of both than running a script does)
and only execute the result if that succeeds. A compile failure returns
verdict `compile_error` with the compiler's diagnostic as `stderr`, without
ever reaching the execute phase.

Go's toolchain is resolved the same way Node's is: `go env GOROOT` rather
than assuming `/usr/bin/go`, since it's commonly managed by a version
switcher (mise, asdf) that lives outside `/usr`. `go` is only added to the
language list when that resolves to something real — clone the repo without
Go installed and `language: 'go'` just isn't offered, no broken option left
behind. Its build cache is a real, persistent, shared directory under the
OS temp dir (not `process.cwd()` — see [ROADMAP.md](ROADMAP.md#phase-16--a-real-ci-only-bug-found-by-actually-checking-ci-done) for why)
rather than a fresh empty one per run: an empty cache means compiling the
entire Go standard library from source before it can compile anything
else, which blows straight through the compile sandbox's memory and
file-size ceilings sized for a one-file program. It's warmed once,
unsandboxed, the first time `sandbox.mjs` loads with Go available — after
that, every real sandboxed compile only ever has its own small package
left to build. `CGO_ENABLED=0` keeps Go's own network code from needing
to shell out to `gcc` at compile time for cgo-based resolution.

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
HTTP 429 for `queue_full`/`key_limit`/`rate_limited`, 400 for a malformed
request (unknown language, missing code). The submitter's `key` for
per-key concurrency limiting is the `X-Sandbin-Key` header if present,
otherwise their IP.

**API keys and rate limits.** Anonymous callers, keyed by IP, get 20
runs/hour. `POST /keys` issues a free key with a 200/hour quota, no
signup:

```bash
curl -s -X POST localhost:8080/keys
# -> {"key":"sb_...","requestsPerHour":200}
```

Send it back as `X-Sandbin-Key` on `POST /runs` to run under that quota
instead. `GET /keys/:key` reports the current window without consuming
it. The quota is a separate concern from that same header's existing job
of partitioning `maxPerKey` concurrency — an arbitrary caller-chosen
string still works for that, and only resolves to the higher rate-limit
tier when it matches a key actually issued by `POST /keys`. Key issuance
is itself rate-limited by IP (5/hour) so it can't be used to mint
unlimited fresh quotas.

**`GET /runs/:runId/stream`** (WebSocket) delivers the run's story as JSON
messages, one per frame:

```
{ "type": "queued", "position": 2 }
{ "type": "started" }
{ "type": "stats", "t": 150, "memBytes": 20971520, "cpuMs": 8 }
{ "type": "chunk", "stream": "stdout", "text": "2\n" }
{ "type": "finished", "result": { "verdict": "ok", "stdout": "2\n", ... } }
```

`stats` is a live cgroup sample — `memory.current` and cumulative CPU time,
polled every 50ms while the guest runs — enough to draw a live resource
graph for anything longer-lived than a one-liner; short runs may finish
before a single sample lands, which is expected.

Connecting after the run has already started replays every chunk (and
`stats` sample) seen so far before continuing live; connecting after it's
finished replays just the final `finished` message and closes. Sending
`{ "type": "stdin", "text": "..." }` over the socket writes to the guest's
stdin while it's running — this is what makes a real `input()` call work,
not just a fixed string supplied up front. `{ "type": "stdin_close" }`
sends EOF.

**`GET /r/:runId`** is a permalink: an HTML page that replays the code,
the streamed output and the resource graph exactly as they happened, timed
from the real recorded `chunk`/`stats` timestamps (capped at 800ms per
step, so a run that hit a long timeout doesn't force a visitor to sit
through the dead air). **`GET /r/:runId/data`** is the JSON it's built
from. Every finished run is saved automatically — no opt-in — as one JSON
file per run under `data/runs/`, no database. Links expire after 30 days,
checked lazily on read and swept hourly. The id is the same UUID `runId`
already returned by `POST /runs`: unguessable, unlisted, not secret.

### Frontend

`npm start` serves it at `/` — plain HTML, CSS and JS, no framework, no
build step, black and white only. Pick a language, write code, run, watch
it stream. The stdin box stays live for the duration of the run, so a
program that calls `input()` actually works, not just one given its input
up front. A live graph tracks `memory.current` for anything that runs long
enough to plot — fed straight off the `stats` WebSocket messages, nothing
faked client-side. Every finished run gets a permalink shown right below
its results, ready to copy and share.

### Metrics dashboard

**`GET /metrics`** is a live dashboard of the server process itself —
submitted/accepted/rejected counts, finished runs broken down by verdict
and by language, average duration/CPU/peak memory, current queue depth,
and API keys issued — polling **`GET /metrics/data`** every two seconds
for the same JSON it renders from. Counters live in memory
(`src/metrics.mjs`) and reset on restart, same as everything else in this
project that isn't explicitly persisted to `data/` — there's no metrics
database, just counters incremented at the exact points `server.mjs`
already handles a submission, a rejection, a finished run or an issued
key, plus `queue.stats()` reused as-is for the live running/waiting
numbers rather than duplicating that state.

```bash
curl -s localhost:8080/metrics/data | python3 -m json.tool
```

It's open by default — fine for a local clone, not for anything reachable
by strangers, since it hands out real operational detail (rejection
counts, per-language usage, exactly how many API keys have been issued).
Set both `SANDBIN_METRICS_USER` and `SANDBIN_METRICS_PASS` to put it
behind HTTP Basic Auth instead — the browser's own native credential
prompt handles the HTML page, and `curl -u user:pass` handles the JSON
route, so nothing on the frontend had to change to support it:

```bash
SANDBIN_METRICS_USER=admin SANDBIN_METRICS_PASS=secret npm start
curl -u admin:secret localhost:8080/metrics/data
```

### CLI

```bash
npm link   # or: node bin/sandbin.mjs ...
sandbin run script.py
```

Runs code straight through the sandbox, no server required — `sandbin`
imports `sandbox.mjs` directly and calls `run()` itself, streaming stdout
and stderr to the terminal live as they arrive, then printing a summary
(verdict, duration, CPU, peak memory, exit code) once it finishes. The
process exits `0` for verdict `ok`, `1` otherwise, so it's safe to use in
scripts and CI.

```bash
sandbin run -l python -e 'print(1 + 1)'
cat script.sh | sandbin run -l bash
sandbin run main.go --json                    # full result object, no live streaming
sandbin run server.js --server localhost:8080 # submit to a running server instead
```

Language is auto-detected from the file extension when a file is given;
otherwise pass `-l/--language` explicitly. Without `--server`, `sandbin`
runs locally and needs the same host requirements as `npm start` itself
(bubblewrap, libseccomp, cgroup v2). With `--server <url>`, it instead
submits over HTTP and streams the result back over the same WebSocket
protocol the web frontend uses — useful for driving a sandbin instance
running somewhere else. `-k/--key` (or `SANDBIN_KEY`) sends an issued API
key along; `SANDBIN_SERVER` sets a default server so `--server` doesn't
need repeating on every call.

`sandbin languages` lists what the current host can actually run (`go`
only appears if a toolchain was found). `sandbin keys create` and
`sandbin keys status <key>` wrap `POST /keys` and `GET /keys/:key` against
a running server. `sandbin --help` covers every flag, including the
`--memory`/`--cpu`/`--timeout`/`--pids` limit overrides.

A compile failure (`c`, `go`) is the one case with nothing to stream live —
the compile phase runs before the execute phase that streaming is wired
to — so the CLI prints the compiler's captured `stderr` in full once the
result comes back, rather than a bare `verdict compile_error` with no
explanation.

### GitHub Action

`action.yml` at the repo root turns this into a composite GitHub Action —
any workflow can run untrusted code through the real sandbox as a step,
without vendoring the CLI or standing up a server:

```yaml
- uses: ayazdoruck/sandbin@main
  id: run
  with:
    language: python
    code: |
      print("hello from CI")

- run: echo "${{ steps.run.outputs.stdout }}"
```

Inputs mirror the CLI's own flags: `code` or `code-file` (exactly one),
`language` (required), `stdin`, `memory`/`cpu`/`timeout`/`pids` for limit
overrides, and `fail-on-error` (default `true`) to control whether a
non-`ok` verdict fails the step or is only reported through outputs.
Outputs are `verdict`, `exit-code`, `stdout` and `stderr`.

It installs the same host requirements this project's own CI does
(`bubblewrap`, `libseccomp`, `gcc`, `golang-go` when `language: go`, the
AppArmor unprivileged-userns sysctl) — so it needs an Ubuntu-family
runner, same as everywhere else this runs. User-supplied inputs
(`code`, `stdin`, and the rest) are passed to every shell step through
`env:`, never interpolated directly into a `run:` script — the standard
mitigation for the well-known class of Actions injection where untrusted
input becomes part of the script text itself, which would be a strange
thing to get wrong in an action whose entire purpose is running untrusted
input safely.

`.github/workflows/action-test.yml` exercises the action against itself
on every push: a success case (asserting `verdict`/`exit-code`/`stdout`),
a `fail-on-error: false` failure case (asserting the failure is reported
via outputs rather than either silently swallowed or killing the job),
and the `code-file` input path.

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
✅ writes stay inside                     ✅ go: compiles and runs
✅ host pids hidden                       ✅ go: syntax error reported as compile_error
✅ output flood                           ✅ go: network blocked at the syscall level
✅ tmpfs bounded                          ✅ go: sustained memory bomb caught
✅ nested user namespace blocked
✅ raw clone with new-user flag blocked
✅ raw clone without dangerous flags still works
✅ clone3 falls back instead of aborting

36/36 contained
```

The four `go:` cases only run — and only count toward the total — on a host
where a Go toolchain was actually found.

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

`npm run test:permalinks` covers the on-disk store directly, against a
real temp directory — no mocks, TTL expiry driven by an injected clock
rather than actually waiting 30 days:

```
✅ a saved record loads back with the same fields
✅ loading an unknown id returns null, not an error
✅ a record past its TTL loads as null and is deleted, not just hidden
✅ a record well within its TTL still loads
✅ sweep evicts only the record actually past its TTL, leaves the fresh one

5/5 passed
```

`npm run test:ratelimit` and `npm run test:apikeys` cover the fixed-window
counter and the on-disk key store directly — independent ids never
interfere with each other, and a window reset is driven by an injected
clock rather than actually waiting an hour:

```
✅ the first N requests within the limit are all allowed
✅ the request past the limit is rejected, not silently allowed
✅ one id being throttled does not affect a different id
✅ a new window resets the count instead of accumulating forever
✅ peek reports usage without counting as a request itself

5/5 passed
```

```
✅ an issued key is sb_-prefixed and carries a default quota
✅ a store configured with a custom quota applies it to new keys
✅ loading an issued key returns the same record
✅ loading an unknown key returns null, not an error
✅ two calls to issue produce two different keys

5/5 passed
```

`npm run test:metrics` covers the counters directly, no server involved —
a fresh store starts at zero, accepted/rejected/finished are tallied
independently and broken down correctly, averages are a real mean rather
than a running total:

```
✅ a fresh store reports zero for every counter
✅ accepted and rejected runs are tallied independently, rejected broken down by verdict
✅ finished runs are broken down by verdict and by language, not just totaled
✅ averages are the mean over finished runs, not a running total
✅ key issuance has its own counter, unaffected by run submissions
✅ uptimeMs reflects real elapsed wall-clock time, not a fixed value

6/6 passed
```

`npm run test:server` spins up the real HTTP + WebSocket server on an
ephemeral port — no mocks — and drives it end to end:

```
✅ basic run streams started -> chunk -> finished       queued,started,stats,stats,chunk,finished
✅ chunks arrive incrementally, not all at once         chunks=3 gaps=300,300
✅ live stats stream reports growing memory.current     samples=6 memBytes=9367552,...,35581952
✅ GET /r/:id/data returns the saved run right after finish, no race
✅ GET /r/:id serves the permalink HTML page
✅ GET /r/:id/data for an unknown id returns 404
✅ POST /keys issues an sb_-prefixed key with a quota
✅ GET /keys/:key reports fresh, unused quota right after issuance
✅ GET /keys/:key for an unissued key returns 404
✅ the request past the anonymous per-IP quota is rate_limited     statuses=202,202,429
✅ a request carrying an issued key is not throttled by the exhausted anonymous bucket
✅ interactive stdin: reply sent only after seeing the prompt name: hello ayaz
✅ queue_full over HTTP returns 429                     202,202,429,429
✅ unknown language returns 400 immediately             {"accepted":false,"verdict":"bad_request",...}
✅ reconnecting after finish replays the final result   finished
✅ unknown run id over WS returns an error event        [{"type":"error",...}]
✅ GET /metrics/data reflects a real finished run, not just a submission
✅ GET /metrics/data counts a rejection and a key issuance from real requests
✅ GET /metrics/data returns 401 with no credentials when metrics auth is configured
✅ GET /metrics (the HTML page, not just the data route) also requires auth when configured
✅ GET /metrics/data rejects incorrect credentials, not just missing ones
✅ GET /metrics/data returns real data with correct Basic credentials

22/22 passed
```

`npm run test:cli` spawns the built binary as a real subprocess, both in
local mode and against a real ephemeral server — no mocking the CLI's own
internals:

```
✅ local: eval runs, streams stdout live, exits 0
✅ local: guest exit(3) reports verdict error, cli exits 1 not 3
✅ local: unknown language rejected with a clean message, not a stack trace
✅ --json: prints one parseable result object with stdout and verdict
✅ local: language auto-detected from the .py extension, no -l needed
✅ languages: lists python as available on this host
✅ local: c compile error prints the compiler diagnostic, not just a bare verdict
✅ remote: run streams stdout over a real HTTP+WS server
✅ remote: server-side rejection (bad_request) exits nonzero with the server's message
✅ keys: create then status round-trips through a real server

10/10 passed
```

## Benchmarks

```bash
npm run loadtest
```

`npm test` proves correctness; this measures performance, against a real
server on an ephemeral port, no mocks. Two scenarios: sustained throughput
with client concurrency held at the queue's own default (`maxConcurrency`,
100 requests, 0 rejections, ~120 req/s, p50 ~30ms), and overload (60
requests fired at once with no client-side throttling, against a queue
shrunk to a 20-slot capacity) — which lands exactly 20 accepted and 40
`queue_full` on every run, rejected in 36-62ms rather than left waiting.
Full methodology, raw numbers and the cold-start-vs-Docker comparison are
on the [benchmarks page](https://sandbin.vercel.app/benchmarks).

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
- A Go toolchain, only if you want the `go` language option — entirely
  optional, resolved at startup via `go env GOROOT`; without one, `go` just
  isn't in the language list

## Status

All seventeen roadmap phases are done: namespace/cgroup/seccomp/rlimit
isolation, a bounded and backpressured job queue, a streaming HTTP +
WebSocket API, Python/Bash/Node/C support plus Go wherever a toolchain is
available, a minimal browser frontend with a live resource graph and
shareable permalinks, API keys with per-tier rate limits, a live
`/metrics` dashboard (optionally behind Basic Auth), a `sandbin` CLI that
runs either locally or against a remote server, a real concurrency/
throughput benchmark (`npm run loadtest`) alongside the cold-start
comparison, a composite GitHub Action (`action.yml`) for running
untrusted code as a CI step, and CI running all eight test suites on
every push — plus a full, on-request audit of the control plane that
found and fixed a real unauthenticated RCE and a real path-traversal
bug, alongside several resource leaks (see
[Phase 17](ROADMAP.md#phase-17--a-full-audit-of-the-control-plane-on-request-done)
for the complete, reproduced trail). `npm start` and open it, or
`npm link` and run `sandbin run script.py`. See [ROADMAP.md](ROADMAP.md) for what was
actually found building each phase — several real bugs, not just a
feature checklist.

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
- Rust was attempted alongside Go and shelved, not shipped half-working:
  `rustc`, sandboxed, fails invoking its own linker with a bare `EPERM`
  and zero observable `fork`/`vfork`/`posix_spawn`/`execve` calls at the
  point of failure — checked via `LD_PRELOAD` interposition on every one of
  those symbols, which reliably catches the same call for every other
  binary tested this way, `rustc` included when run unsandboxed. Whatever
  syscall it actually makes isn't going through a libc entry point at all,
  which is as far as this can be diagnosed without `strace` or root on the
  box that found it. See [ROADMAP.md](ROADMAP.md#phase-10--go-support-done-rust-attempted-and-shelved)
  for the full trail, kept rather than deleted so the next attempt doesn't
  repeat it.
