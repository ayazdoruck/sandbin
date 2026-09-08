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

## Phase 2 — job queue and concurrency

- bounded worker pool; a run is queued, not spawned immediately
- per-tenant / per-IP concurrency and rate limits
- queue depth and wait time surfaced in the response
- backpressure: reject fast with a clear error once the queue is full, rather
  than degrading every run's limits

## Phase 3 — streaming API

- HTTP endpoint to submit a run, WebSocket to receive stdout/stderr as it
  happens rather than waiting for completion
- protocol: run accepted, run started, output chunk, run finished (verdict +
  resource stats), matching the shape `sandbox.mjs` already returns
- interactive stdin support for programs that prompt

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
