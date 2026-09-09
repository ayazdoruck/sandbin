export function createMetricsStore() {
  const startedAt = Date.now();
  let submitted = 0;
  let accepted = 0;
  const rejected = Object.create(null);
  const finishedByVerdict = Object.create(null);
  const finishedByLanguage = Object.create(null);
  let finishedCount = 0;
  let totalDurationMs = 0;
  let totalCpuMs = 0;
  let totalPeakBytes = 0;
  let keysIssued = 0;

  function bump(counts, key) {
    counts[key] = (counts[key] ?? 0) + 1;
  }

  return {
    recordSubmitted() {
      submitted++;
    },
    recordAccepted() {
      accepted++;
    },
    recordRejected(verdict) {
      bump(rejected, verdict);
    },
    recordFinished(language, result) {
      finishedCount++;
      bump(finishedByVerdict, result.verdict);
      bump(finishedByLanguage, language);
      totalDurationMs += result.durationMs;
      totalCpuMs += result.cpuMs;
      totalPeakBytes += result.peakBytes;
    },
    recordKeyIssued() {
      keysIssued++;
    },
    snapshot() {
      return {
        uptimeMs: Date.now() - startedAt,
        submitted,
        accepted,
        rejected: { ...rejected },
        finished: {
          total: finishedCount,
          byVerdict: { ...finishedByVerdict },
          byLanguage: { ...finishedByLanguage },
        },
        averages: {
          durationMs: finishedCount ? Math.round(totalDurationMs / finishedCount) : 0,
          cpuMs: finishedCount ? Math.round(totalCpuMs / finishedCount) : 0,
          peakBytes: finishedCount ? Math.round(totalPeakBytes / finishedCount) : 0,
        },
        keysIssued,
      };
    },
  };
}
