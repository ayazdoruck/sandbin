# sandbin

Runs untrusted code and survives it. No Docker, no root, no VM.

A submission gets its own PID namespace, its own network stack (empty), its own
filesystem view, a syscall allowlist, and hard ceilings on memory, CPU and
process count. When it misbehaves — and the test suite makes sure it does — it
dies, and the host doesn't notice.

Cold start is about **20 ms**, and the whole thing runs as an ordinary user.

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
| **Seccomp** | Syscall allowlist — everything not explicitly needed by Python/Bash is denied |
| **cgroup v2** | `memory.max`, `cpu.max`, `pids.max`, and `cgroup.kill` for instant teardown |
| **rlimits** | File size, open descriptors, no core dumps |

Plus a wall-clock deadline enforced by the supervisor itself.

Three details matter more than they look:

- **The guest is PID 1 in its own namespace.** When it exits, the kernel reaps
  everything it spawned. A classic fork bomb dies in ~15 ms without the pids
  ceiling ever being touched.
- **`cgroup.kill` kills the whole tree in one write.** No PID chasing, no
  processes surviving the reaper.
- **The seccomp filter is a strict allowlist, not a blocklist.** Roughly 90
  syscalls are permitted; everything else — `ptrace`, `mount`, `unshare`,
  `io_uring_setup`, raw sockets, nested user namespaces via `clone` — returns
  `EPERM` by default. `clone` itself stays allowed for ordinary fork/thread
  use; only the call is checked for the specific flags
  (`CLONE_NEWUSER`/`CLONE_NEWNS`/`CLONE_NEWPID`/`CLONE_NEWNET`/`CLONE_NEWUTS`/
  `CLONE_NEWIPC`/`CLONE_NEWCGROUP`) that would let an already-unprivileged
  guest create a fresh, "privileged-inside" namespace of its own. `clone3` is
  denied with `ENOSYS` specifically rather than `EPERM`, so glibc's built-in
  fallback to `clone()` runs the program normally instead of aborting it. The
  filter covers the native x86_64 syscall table plus the 32-bit and x32 compat
  ABIs, closing the classic bypass of reaching the kernel through a syscall
  table the filter forgot about.

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

`verdict` is one of `ok`, `error`, `timeout`, `memory_limit`, `output_limit`,
`killed`, `setup_failed`. The result also carries `cpuMs`, `peakBytes`,
`oomKills` and `pidsMaxHits`, read straight from the cgroup.

`run()` always settles within `wallClockMs + 2s`, no matter what the guest or
its descendants do. The deadline itself is `cgroup.kill`; the extra two
seconds are a hard backstop that force-closes the process and its pipes if
something downstream is still holding them open, so a misbehaving submission
can never wedge the supervisor itself.

The seccomp policy is compiled from `seccomp/policy.c` on first use and cached
as `seccomp/policy.bpf`; neither file is checked in, both are regenerated
automatically the first time `run()` is called.

## Tests

```bash
npm test
```

The suite is adversarial: every case is code that tries to break out, and a
pass means it was stopped. Assertions check observable evidence — cgroup
counters, host-side file checks, the specific errno a blocked syscall returns
— rather than the guest's own exit status, which a guest could lie about.

```
✅ ordinary program                       ✅ writes stay inside
✅ reads stdin                            ✅ host pids hidden
✅ subprocess chain                       ✅ output flood
✅ threading                              ✅ tmpfs bounded
✅ infinite loop                          ✅ nested user namespace blocked
✅ cpu throttled                          ✅ raw clone with new-user flag blocked
✅ memory bomb                            ✅ raw clone without dangerous flags still works
✅ fork bomb                              ✅ clone3 falls back instead of aborting
✅ sustained fork bomb                    ✅ ptrace blocked
✅ fork loop                              ✅ mount blocked
✅ network blocked                        ✅ io_uring blocked
✅ host fs invisible

23/23 contained
```

## Requirements

- Linux with cgroup v2 and unprivileged user namespaces
- `bubblewrap`, `gcc`, `libseccomp`
- `cpu`, `memory` and `pids` delegated somewhere in the caller's own cgroup
  ancestry. A normal desktop or SSH login session gets this from systemd for
  free. A plain systemd service unit usually does not — add
  `Delegate=yes` to it, or run under `systemd-run --scope --property=Delegate=yes`
  the way CI does. sandbin walks up from its own `/proc/self/cgroup` at
  startup and roots itself at the nearest ancestor that exposes all three;
  if none do, cgroup assignment fails loudly with the `setup_failed` verdict
  instead of silently running unconfined.
- Node 20+

## Status

Early. The isolation core — namespaces, cgroups, seccomp, rlimits — works and
is tested. Still to come: a job queue with bounded concurrency, live output
streaming over WebSocket, per-language root filesystems, and a browser
frontend. See [ROADMAP.md](ROADMAP.md).

### Known issues

- Threat model: this hardens the sandbox against careless or mildly malicious
  code, not against an attacker who already has a kernel exploit. Guest and
  host share one kernel; seccomp shrinks the reachable syscall surface, it
  does not add a second kernel between them the way a VM-based sandbox would.
