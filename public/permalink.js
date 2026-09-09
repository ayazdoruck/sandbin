const metaEl = document.getElementById('meta');
const contentEl = document.getElementById('content');
const notFoundEl = document.getElementById('not-found');
const codeEl = document.getElementById('code');
const outputEl = document.getElementById('output');
const statsEl = document.getElementById('stats');
const graphEl = document.getElementById('live-graph');

const MAX_STEP_DELAY_MS = 800;

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

function appendChunk(text, stream) {
  if (stream === 'stderr') {
    const span = document.createElement('span');
    span.className = 'stderr';
    span.textContent = text;
    outputEl.appendChild(span);
  } else {
    outputEl.appendChild(document.createTextNode(text));
  }
  outputEl.scrollTop = outputEl.scrollHeight;
}

function appendStatus(text) {
  const div = document.createElement('div');
  div.className = 'status';
  div.textContent = text;
  outputEl.appendChild(div);
}

function renderStats(result) {
  statsEl.className = `stats ${result.verdict === 'ok' ? 'verdict-ok' : 'verdict-bad'}`;
  const rows = [
    ['verdict', result.verdict],
    ['duration', `${result.durationMs} ms`],
    ['cpu', `${result.cpuMs} ms`],
    ['peak memory', formatBytes(result.peakBytes)],
    ['exit code', result.exitCode ?? '-'],
  ];
  if (result.signal) rows.push(['signal', result.signal]);
  if (result.truncated) rows.push(['output', 'truncated']);
  if (result.pidsMaxHits) rows.push(['pids.max hit', `${result.pidsMaxHits}x`]);
  const dl = document.createElement('dl');
  for (const [key, value] of rows) {
    const dt = document.createElement('dt');
    dt.textContent = key;
    const dd = document.createElement('dd');
    if (key === 'verdict') dd.className = 'verdict';
    dd.textContent = String(value);
    dl.append(dt, dd);
  }
  statsEl.appendChild(dl);
}

let statSamples = [];

function drawGraph() {
  if (statSamples.length < 2) return;
  const dpr = window.devicePixelRatio || 1;
  const cssWidth = graphEl.clientWidth || 640;
  const cssHeight = 72;
  if (graphEl.width !== cssWidth * dpr || graphEl.height !== cssHeight * dpr) {
    graphEl.width = cssWidth * dpr;
    graphEl.height = cssHeight * dpr;
  }
  const ctx = graphEl.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssWidth, cssHeight);

  const maxT = statSamples.at(-1).t || 1;
  const maxMem = Math.max(...statSamples.map((s) => s.memBytes), 1);
  const fg = getComputedStyle(document.body).getPropertyValue('--fg').trim() || '#111';

  ctx.beginPath();
  statSamples.forEach((s, i) => {
    const x = (s.t / maxT) * cssWidth;
    const y = cssHeight - (s.memBytes / maxMem) * (cssHeight - 8) - 4;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  ctx.strokeStyle = fg;
  ctx.lineWidth = 1.5;
  ctx.lineJoin = 'round';
  ctx.stroke();
}

async function replay(record) {
  const events = [
    ...record.chunks.map((c) => ({ ...c, type: 'chunk' })),
    ...record.stats.map((s) => ({ ...s, type: 'stats' })),
  ].sort((a, b) => a.t - b.t);

  if (events.some((e) => e.type === 'stats')) graphEl.classList.add('visible');
  appendStatus('running');

  let clock = 0;
  for (const event of events) {
    const wait = Math.min(Math.max(0, event.t - clock), MAX_STEP_DELAY_MS);
    await new Promise((r) => setTimeout(r, wait));
    clock = event.t;
    if (event.type === 'chunk') appendChunk(event.text, event.stream);
    if (event.type === 'stats') { statSamples.push(event); drawGraph(); }
  }

  await new Promise((r) => setTimeout(r, 150));
  renderStats(record.result);
}

function formatWhen(ms) {
  return new Date(ms).toLocaleString();
}

async function load() {
  const id = location.pathname.replace(/^\/r\//, '').replace(/\/$/, '');
  let record = null;
  try {
    const res = await fetch(`/r/${id}/data`);
    if (res.ok) record = await res.json();
  } catch {
    // network error: fall through to not-found
  }

  if (!record) {
    metaEl.textContent = 'not found';
    notFoundEl.style.display = '';
    return;
  }

  metaEl.textContent = `${record.language} · shared ${formatWhen(record.createdAt)}`;
  codeEl.textContent = record.code;
  contentEl.style.display = '';

  replay(record);
}

load();
