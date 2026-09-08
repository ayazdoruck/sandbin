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
