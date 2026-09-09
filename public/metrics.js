const REFRESH_MS = 2000;
const container = document.getElementById('metrics');

function formatBytes(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function formatUptime(ms) {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return `${hours}h ${minutes}m ${seconds}s`;
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function statList(pairs) {
  const rows = pairs.map(([key, value]) => `<dt>${escapeHtml(key)}</dt><dd>${escapeHtml(value)}</dd>`).join('');
  return `<dl>${rows}</dl>`;
}

function barRows(counts) {
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) return '<p class="metric-empty">none yet</p>';
  const max = Math.max(...entries.map(([, count]) => count));
  return entries
    .map(([label, count]) => {
      const pct = max > 0 ? Math.round((count / max) * 100) : 0;
      return `<div class="metric-row">
        <span class="metric-label">${escapeHtml(label)}</span>
        <div class="metric-bar"><div class="metric-fill" style="width: ${pct}%"></div></div>
        <span class="metric-value">${count}</span>
      </div>`;
    })
    .join('');
}

function section(title, body) {
  return `<section class="metric-section"><h2>${title}</h2>${body}</section>`;
}

async function render() {
  let data;
  try {
    data = await fetch('/metrics/data').then((res) => res.json());
  } catch (err) {
    container.innerHTML = `<p class="metric-empty">could not load metrics: ${escapeHtml(err.message)}</p>`;
    return;
  }

  const rejectedTotal = Object.values(data.rejected).reduce((a, b) => a + b, 0);

  container.innerHTML = [
    section('overview', statList([
      ['uptime', formatUptime(data.uptimeMs)],
      ['submitted', data.submitted],
      ['accepted', data.accepted],
      ['rejected', rejectedTotal],
      ['finished', data.finished.total],
      ['api keys issued', data.keysIssued],
    ])),
    section('queue', statList([
      ['running', `${data.queue.running} / ${data.queue.maxConcurrency}`],
      ['waiting', `${data.queue.waiting} / ${data.queue.maxQueueLength}`],
      ['keys in flight', data.queue.keys],
    ])),
    section('averages (finished runs)', statList([
      ['duration', `${data.averages.durationMs}ms`],
      ['cpu', `${data.averages.cpuMs}ms`],
      ['peak memory', formatBytes(data.averages.peakBytes)],
    ])),
    section('verdicts', barRows(data.finished.byVerdict)),
    section('rejections', barRows(data.rejected)),
    section('languages', barRows(data.finished.byLanguage)),
  ].join('');
}

render();
setInterval(render, REFRESH_MS);
