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

## Phase 4 — per-language runtime images

- Python and Bash exist today; add Node.js, and one compiled language (C or
  Go) to prove the design isn't interpreter-only
- each language gets its own minimal read-only rootfs directory and its own
  syscall allowlist where the two differ meaningfully (a compiled language
  needs no scripting-language startup syscalls, for instance)
- image build step separate from the request path, so adding a language never
  touches the hot path

## Phase 5 — frontend

- single-page editor: language picker, code area, stdin box, run button
- live output panel fed by the Phase 3 WebSocket
- resource panel: wall time, CPU time, peak memory, verdict — the numbers
  `sandbox.mjs` already computes, just rendered
- deployed as a static build talking to the API; no server-rendered pages
  needed for this surface

## Phase 6 — CI and publish

- GitHub Actions: run the adversarial suite on every push, fail the build on
  any uncontained case
- README finalized with the real numbers from CI, not hand-typed ones
- repository pushed to GitHub under a single author
