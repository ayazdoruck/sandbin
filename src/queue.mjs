import { run } from './sandbox.mjs';

export const DEFAULT_QUEUE_LIMITS = {
  maxConcurrency: 4,
  maxQueueLength: 64,
  maxPerKey: 8,
};

function rejection(verdict, message) {
  return {
    id: null, verdict, exitCode: null, signal: null,
    stdout: '', stderr: message, truncated: false,
    durationMs: 0, cpuMs: 0, peakBytes: 0, oomKills: 0, pidsMaxHits: 0,
    queuedMs: 0,
  };
}

export function createQueue(limits = {}) {
  const cfg = { ...DEFAULT_QUEUE_LIMITS, ...limits };
  const waiting = [];
  const perKeyCount = new Map();
  let runningCount = 0;

  function countFor(key) {
    return perKeyCount.get(key) ?? 0;
  }

  function adjustKeyCount(key, delta) {
    const next = countFor(key) + delta;
    if (next <= 0) perKeyCount.delete(key);
    else perKeyCount.set(key, next);
  }

  function settle(task, queuedMs, outcome) {
    runningCount--;
    adjustKeyCount(task.key, -1);
    pump();
    task.resolve({ ...outcome, queuedMs });
  }

  function pump() {
    while (runningCount < cfg.maxConcurrency && waiting.length > 0) {
      const task = waiting.shift();
      runningCount++;
      const queuedMs = Date.now() - task.enqueuedAt;
      run(task.args).then(
        (result) => settle(task, queuedMs, result),
        (err) => settle(task, queuedMs, rejection('error', String(err?.message ?? err)))
      );
    }
  }

  function submit(args, { key = 'default' } = {}) {
    if (countFor(key) >= cfg.maxPerKey) {
      return {
        accepted: false, verdict: 'key_limit', position: null,
        result: Promise.resolve(rejection('key_limit', `key "${key}" already has ${cfg.maxPerKey} runs in flight`)),
      };
    }
    if (waiting.length >= cfg.maxQueueLength) {
      return {
        accepted: false, verdict: 'queue_full', position: null,
        result: Promise.resolve(rejection('queue_full', `queue is at capacity (${cfg.maxQueueLength})`)),
      };
    }

    adjustKeyCount(key, 1);
    const position = waiting.length;
    const result = new Promise((resolve) => {
      waiting.push({ args, key, enqueuedAt: Date.now(), resolve });
      pump();
    });
    return { accepted: true, verdict: null, position, result };
  }

  function stats() {
    return {
      running: runningCount,
      waiting: waiting.length,
      keys: perKeyCount.size,
      ...cfg,
    };
  }

  return { submit, stats };
}
