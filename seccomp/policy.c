#include <errno.h>
#include <seccomp.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#ifndef CLONE_NEWNS
#define CLONE_NEWNS 0x00020000
#endif
#ifndef CLONE_NEWCGROUP
#define CLONE_NEWCGROUP 0x02000000
#endif
#ifndef CLONE_NEWUTS
#define CLONE_NEWUTS 0x04000000
#endif
#ifndef CLONE_NEWIPC
#define CLONE_NEWIPC 0x08000000
#endif
#ifndef CLONE_NEWUSER
#define CLONE_NEWUSER 0x10000000
#endif
#ifndef CLONE_NEWPID
#define CLONE_NEWPID 0x20000000
#endif
#ifndef CLONE_NEWNET
#define CLONE_NEWNET 0x40000000
#endif

static scmp_filter_ctx ctx;
static int failures = 0;

static void allow(const char *name) {
    int rc = seccomp_rule_add(ctx, SCMP_ACT_ALLOW, seccomp_syscall_resolve_name(name), 0);
    if (rc != 0 && rc != -EDOM) {
        fprintf(stderr, "allow(%s) failed: %s\n", name, strerror(-rc));
        failures++;
    }
}

static void allow_many(const char *const names[], size_t count) {
    for (size_t i = 0; i < count; i++) allow(names[i]);
}

static void deny_errno(const char *name, int err) {
    int rc = seccomp_rule_add(ctx, SCMP_ACT_ERRNO(err), seccomp_syscall_resolve_name(name), 0);
    if (rc != 0 && rc != -EDOM) {
        fprintf(stderr, "deny(%s) failed: %s\n", name, strerror(-rc));
        failures++;
    }
}

static void allow_clone_without_new_namespaces(void) {
    unsigned long dangerous = CLONE_NEWUSER | CLONE_NEWNS | CLONE_NEWPID |
                               CLONE_NEWNET | CLONE_NEWUTS | CLONE_NEWIPC |
                               CLONE_NEWCGROUP;
    int rc = seccomp_rule_add(
        ctx, SCMP_ACT_ALLOW, seccomp_syscall_resolve_name("clone"), 1,
        SCMP_A0(SCMP_CMP_MASKED_EQ, dangerous, 0));
    if (rc != 0 && rc != -EDOM) {
        fprintf(stderr, "allow_clone_without_new_namespaces failed: %s\n", strerror(-rc));
        failures++;
    }
}

static const char *const process_lifecycle[] = {
    "exit", "exit_group", "wait4", "waitid", "rseq", "set_tid_address",
    "set_robust_list", "get_robust_list", "execve", "fork", "vfork",
};

static const char *const memory[] = {
    "mmap", "munmap", "mprotect", "mremap", "madvise", "brk", "mincore",
};

static const char *const fd_io[] = {
    "read", "write", "pread64", "pwrite64", "readv", "writev", "preadv",
    "pwritev", "preadv2", "pwritev2", "close", "lseek", "dup", "dup2", "dup3",
    "fcntl", "ioctl", "sendfile", "splice", "copy_file_range",
};

static const char *const filesystem[] = {
    "open", "openat", "openat2", "stat", "fstat", "lstat", "newfstatat",
    "statx", "access", "faccessat", "faccessat2", "getcwd", "chdir",
    "readlink", "readlinkat", "getdents", "getdents64", "unlink", "unlinkat",
    "rename", "renameat", "renameat2", "mkdir", "mkdirat", "rmdir", "chmod",
    "fchmod", "fchmodat", "truncate", "ftruncate", "flock", "fsync",
    "fdatasync", "utimensat", "futimesat", "statfs", "fstatfs", "umask",
};

static const char *const signals[] = {
    "rt_sigaction", "rt_sigprocmask", "rt_sigreturn", "rt_sigpending",
    "rt_sigtimedwait", "rt_sigqueueinfo", "rt_sigsuspend", "sigaltstack",
    "signalfd", "signalfd4",
};

static const char *const time_syscalls[] = {
    "clock_gettime", "clock_getres", "clock_nanosleep", "nanosleep",
    "gettimeofday", "time", "times",
};

static const char *const scheduling[] = {
    "sched_yield", "sched_getaffinity", "sched_getparam", "sched_getscheduler",
    "sched_get_priority_max", "sched_get_priority_min", "getpriority",
};

static const char *const identity[] = {
    "getpid", "gettid", "getppid", "getpgrp", "getpgid", "setpgid", "getsid",
    "setsid", "getuid", "geteuid", "getgid", "getegid", "getresuid",
    "getresgid", "getgroups", "setuid", "setgid", "setresuid", "setresgid",
};

static const char *const misc_info[] = {
    "uname", "sysinfo", "getrandom", "arch_prctl", "prctl", "capget",
    "getrlimit", "prlimit64",
};

static const char *const fd_type_probe[] = {
    "getsockopt", "getsockname",
};

static const char *const futex_group[] = {
    "futex",
};

static const char *const polling[] = {
    "poll", "ppoll", "select", "pselect6", "epoll_create1", "epoll_ctl",
    "epoll_wait", "epoll_pwait", "eventfd", "eventfd2", "pipe", "pipe2",
    "timerfd_create", "timerfd_settime", "timerfd_gettime",
};

int main(void) {
    ctx = seccomp_init(SCMP_ACT_ERRNO(EPERM));
    if (!ctx) {
        fprintf(stderr, "seccomp_init failed\n");
        return 1;
    }

    seccomp_arch_add(ctx, SCMP_ARCH_X86);
    seccomp_arch_add(ctx, SCMP_ARCH_X32);

    allow_many(process_lifecycle, sizeof(process_lifecycle) / sizeof(*process_lifecycle));
    allow_many(memory, sizeof(memory) / sizeof(*memory));
    allow_many(fd_io, sizeof(fd_io) / sizeof(*fd_io));
    allow_many(filesystem, sizeof(filesystem) / sizeof(*filesystem));
    allow_many(signals, sizeof(signals) / sizeof(*signals));
    allow_many(time_syscalls, sizeof(time_syscalls) / sizeof(*time_syscalls));
    allow_many(scheduling, sizeof(scheduling) / sizeof(*scheduling));
    allow_many(identity, sizeof(identity) / sizeof(*identity));
    allow_many(misc_info, sizeof(misc_info) / sizeof(*misc_info));
    allow_many(fd_type_probe, sizeof(fd_type_probe) / sizeof(*fd_type_probe));
    allow_many(futex_group, sizeof(futex_group) / sizeof(*futex_group));
    allow_many(polling, sizeof(polling) / sizeof(*polling));

    allow_clone_without_new_namespaces();
    deny_errno("clone3", ENOSYS);

    if (failures > 0) {
        fprintf(stderr, "%d rule(s) failed to add\n", failures);
        return 1;
    }

    if (seccomp_export_bpf(ctx, STDOUT_FILENO) != 0) {
        fprintf(stderr, "seccomp_export_bpf failed\n");
        return 1;
    }

    seccomp_release(ctx);
    return 0;
}
