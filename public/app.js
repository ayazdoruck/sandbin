const languageSelect = document.getElementById('language');
const codeInput = document.getElementById('code');
const runButton = document.getElementById('run');
const outputEl = document.getElementById('output');
const statsEl = document.getElementById('stats');
const graphEl = document.getElementById('live-graph');
const permalinkEl = document.getElementById('permalink');
const stdinInput = document.getElementById('stdin');
const sendStdinButton = document.getElementById('send-stdin');
const closeStdinButton = document.getElementById('close-stdin');

const SAMPLES = {
  python: 'print("hello from sandbin")',
  bash: 'echo "hello from sandbin"',
  node: 'console.log("hello from sandbin")',
  c: '#include <stdio.h>\nint main(){ printf("hello from sandbin\\n"); return 0; }',
};

let socket = null;
let statSamples = [];

languageSelect.addEventListener('change', () => {
  if (Object.values(SAMPLES).includes(codeInput.value)) {
    codeInput.value = SAMPLES[languageSelect.value];
  }
});

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
  outputEl.scrollTop = outputEl.scrollHeight;
}

function clearOutput() {
  outputEl.textContent = '';
  statsEl.textContent = '';
  statsEl.className = 'stats';
  statSamples = [];
  graphEl.classList.remove('visible');
  permalinkEl.style.display = 'none';
}

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

function setStdinEnabled(enabled) {
  stdinInput.disabled = !enabled;
  sendStdinButton.disabled = !enabled;
  closeStdinButton.disabled = !enabled;
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
  if (result.truncated) rows.push(['output', 'truncated']);

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

let sawChunk = false;

async function run() {
  clearOutput();
  sawChunk = false;
  runButton.disabled = true;
  setStdinEnabled(false);

  let response;
  try {
    response = await fetch('/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        language: languageSelect.value,
        code: codeInput.value,
        limits: { wallClockMs: 30_000 },
      }),
    });
  } catch {
    appendStatus('could not reach the server');
    runButton.disabled = false;
    return;
  }

  const body = await response.json();
  if (!body.accepted) {
    appendStatus(`rejected: ${body.verdict}${body.message ? ` (${body.message})` : ''}`);
    runButton.disabled = false;
    return;
  }

  const runId = body.runId;
  const wsUrl = `${location.origin.replace(/^http/, 'ws')}/runs/${runId}/stream`;
  socket = new WebSocket(wsUrl);

  socket.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    if (msg.type === 'queued') {
      appendStatus(`queued (position ${msg.position})`);
    } else if (msg.type === 'started') {
      appendStatus('running');
      setStdinEnabled(true);
      graphEl.classList.add('visible');
    } else if (msg.type === 'chunk') {
      sawChunk = true;
      appendChunk(msg.text, msg.stream);
    } else if (msg.type === 'stats') {
      statSamples.push(msg);
      drawGraph();
    } else if (msg.type === 'finished') {
      if (!sawChunk) {
        if (msg.result.stdout) appendChunk(msg.result.stdout, 'stdout');
        if (msg.result.stderr) appendChunk(msg.result.stderr, 'stderr');
      }
      renderStats(msg.result);
      setStdinEnabled(false);
      runButton.disabled = false;
      permalinkEl.textContent = 'share this run: ';
      const link = document.createElement('a');
      link.href = `/r/${runId}`;
      link.textContent = `${location.origin}/r/${runId}`;
      permalinkEl.appendChild(link);
      permalinkEl.style.display = '';
    } else if (msg.type === 'error') {
      appendStatus(`error: ${msg.message}`);
      runButton.disabled = false;
    }
  });

  socket.addEventListener('close', () => {
    runButton.disabled = false;
    setStdinEnabled(false);
  });
}

function sendStdin() {
  if (!socket || socket.readyState !== WebSocket.OPEN || !stdinInput.value) return;
  socket.send(JSON.stringify({ type: 'stdin', text: `${stdinInput.value}\n` }));
  stdinInput.value = '';
}

function closeStdin() {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify({ type: 'stdin_close' }));
  setStdinEnabled(false);
}

runButton.addEventListener('click', run);
sendStdinButton.addEventListener('click', sendStdin);
closeStdinButton.addEventListener('click', closeStdin);
stdinInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') sendStdin();
});
codeInput.addEventListener('keydown', (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && !runButton.disabled) run();
});
