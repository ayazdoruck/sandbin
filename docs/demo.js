const tabsEl = document.getElementById('demo-tabs');
const codeEl = document.getElementById('demo-code');
const runBtn = document.getElementById('demo-run');
const outputEl = document.getElementById('demo-output');
const statsEl = document.getElementById('demo-stats');
const noteEl = document.getElementById('demo-note');
const graphEl = document.getElementById('demo-graph');

let activeKey = 'hello';
let playToken = 0;
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
  statsEl.textContent = '';
  statsEl.className = `stats ${result.verdict === 'ok' ? 'verdict-ok' : 'verdict-bad'}`;
  const rows = [
    ['verdict', result.verdict],
    ['duration', `${result.durationMs} ms`],
    ['cpu', `${result.cpuMs} ms`],
    ['peak memory', formatBytes(result.peakBytes)],
    ['exit code', result.exitCode ?? '-'],
  ];
  if (result.signal) rows.push(['signal', result.signal]);
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

function selectDemo(key) {
  activeKey = key;
  for (const btn of tabsEl.querySelectorAll('button')) {
    btn.setAttribute('aria-selected', String(btn.dataset.key === key));
  }
  codeEl.textContent = DEMOS[key].code;
  codeEl.classList.add('idle');
  noteEl.textContent = DEMOS[key].note ?? '';
  outputEl.textContent = '';
  statsEl.textContent = '';
  statsEl.className = 'stats';
  statSamples = [];
  graphEl.classList.remove('visible');
}

async function play() {
  const token = ++playToken;
  const demo = DEMOS[activeKey];
  runBtn.disabled = true;
  codeEl.classList.remove('idle');
  outputEl.textContent = '';
  statsEl.textContent = '';
  statsEl.className = 'stats';
  statSamples = [];
  graphEl.classList.toggle('visible', demo.events.some((e) => e.type === 'stats'));

  let clock = 0;
  for (const event of demo.events) {
    await new Promise((r) => setTimeout(r, Math.max(0, event.t - clock)));
    if (token !== playToken) return;
    clock = event.t;
    if (event.type === 'started') appendStatus('running');
    if (event.type === 'chunk') appendChunk(event.text, event.stream);
    if (event.type === 'stats') { statSamples.push(event); drawGraph(); }
  }

  await new Promise((r) => setTimeout(r, 200));
  if (token !== playToken) return;
  renderStats(demo.result);
  runBtn.disabled = false;
  codeEl.classList.add('idle');
}

for (const key of Object.keys(DEMOS)) {
  const btn = document.createElement('button');
  btn.textContent = DEMOS[key].label;
  btn.dataset.key = key;
  btn.addEventListener('click', () => selectDemo(key));
  tabsEl.appendChild(btn);
}

runBtn.addEventListener('click', play);
selectDemo(activeKey);
