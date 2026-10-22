/**
 * Host-side glue for the embed demo.
 *
 * Everything here stands in for code you would already have: a session panel, a
 * breadcrumb, an event log. The only Flow-specific lines are the `FlowEmbed`
 * import, the `.mount()` call, and the event subscriptions — which is the point.
 */

import { FlowEmbed } from '../../src/flow/embed.js';
import { MemoryPort, HttpPort } from '../../src/flow/port.js';
import { summarize } from '../../src/flow/status.js';
import { HARNESS_BUNDLE, STATUS_SCRIPT } from './fixtures/harness-topology.js';

const $ = (s) => document.querySelector(s);
const params = new URLSearchParams(location.search);

// Resolved once, so the dropdown label can never point somewhere other than the
// port the demo is actually using.
const API_BASE = (params.get('api') || 'http://localhost:4300').replace(/\/+$/, '');

const host = {
  theme: document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light',
  mode: 'live',
  portKind: params.get('api') ? 'http' : 'memory',
  flow: null,
  ticker: null,
  memoryPort: null,
  cursor: 0,
};

// ── Ports ──────────────────────────────────────────────────────────────────

function makePort() {
  if (host.portKind === 'http') {
    return new HttpPort({ base: `${API_BASE}/v1/flow` });
  }
  host.memoryPort = new MemoryPort({ bundle: HARNESS_BUNDLE });
  return host.memoryPort;
}

function startTicker() {
  stopTicker();
  if (host.portKind !== 'memory' || host.mode !== 'live') return;
  host.ticker = setInterval(() => {
    if (host.cursor >= STATUS_SCRIPT.length) { stopTicker(); return; }
    host.cursor += 1;
    // The wire shape is { cursor, nodes }, not a bare key map — the same shape
    // an SSE frame carries.
    host.memoryPort.push({
      nodes: STATUS_SCRIPT[host.cursor - 1],
      cursor: host.cursor,
      updatedAt: new Date().toISOString(),
    });
  }, 2200);
}

function stopTicker() {
  clearInterval(host.ticker);
  host.ticker = null;
}

// ── Host chrome ────────────────────────────────────────────────────────────

function log(kind, detail) {
  const line = document.createElement('div');
  line.innerHTML = `<span class="k">${kind}</span> ${detail}`;
  const box = $('#log');
  box.prepend(line);
  while (box.children.length > 60) box.lastChild.remove();
}

function renderSummary(s) {
  const rows = [
    ['running', s.running], ['blocked', s.blocked], ['error', s.error],
    ['done', s.done], ['idle', s.idle], ['total', s.total],
  ];
  $('#summary').replaceChildren(...rows.map(([k, v]) => {
    const row = document.createElement('div');
    row.className = 'row';
    row.innerHTML = `<span>${k}</span><b>${v}</b>`;
    return row;
  }));
}

function renderCrumbs() {
  const trail = host.flow?.api.breadcrumb() || [];
  const box = $('#crumbs');
  box.replaceChildren();

  const home = document.createElement('button');
  home.type = 'button';
  home.textContent = 'System';
  home.disabled = trail.length <= 1;
  home.addEventListener('click', () => host.flow?.api.root());
  box.append(home);

  for (const [i, crumb] of trail.entries()) {
    const sep = document.createElement('span');
    sep.className = 'sep';
    sep.textContent = '/';
    box.append(sep);
    if (i === trail.length - 1) {
      const here = document.createElement('span');
      here.className = 'here';
      here.textContent = crumb.title;
      box.append(here);
    } else {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = crumb.title;
      b.addEventListener('click', () => host.flow?.api.enter(crumb.id));
      box.append(b);
    }
  }

  if (trail.length > 1) {
    const back = document.createElement('button');
    back.type = 'button';
    back.textContent = '← back';
    back.style.marginLeft = 'auto';
    back.addEventListener('click', () => host.flow?.api.back());
    box.append(back);
  }
}

function applyTheme() {
  document.body.dataset.theme = host.theme;
  host.flow?.setTheme(host.theme);
  $('#btn-theme').textContent = `Theme: ${host.theme}`;
}

// ── Mount ──────────────────────────────────────────────────────────────────

async function mountFlow() {
  host.flow?.destroy();
  stopTicker();
  host.cursor = 0;

  const port = makePort();
  const flow = FlowEmbed.mount('#diagram', {
    port,
    context: { session: 'demo-session', workspace: 'agent-workbench', project: 'demo' },
    mode: host.mode,
    theme: host.theme,
    pollMs: host.portKind === 'http' ? 0 : 0,
  });
  host.flow = flow;

  flow.on('status', ({ summary }) => {
    renderSummary(summary);
    log('status', `${summary.total} tracked`);
  });
  flow.on('navigate', ({ trail }) => { renderCrumbs(); log('navigate', trail.map((t) => t.title).join(' › ')); });
  flow.on('selection', (payload) => {
    if (!payload) return log('selection', 'cleared');
    const label = payload.kind === 'edge' ? payload.edge.id : payload.nodes.map((n) => n.label).join(', ');
    log('selection', label);
  });
  flow.on('command', ({ name, result }) => log('command', `${name} → ${result?.ok ? 'ok' : 'no'}`));
  flow.on('error', ({ phase, error }) => log('error', `${phase}: ${error?.message || error}`));
  flow.on('issues', (issues) => log('issues', `${issues.length} fixup(s)`));
  flow.on('saved', ({ flowId }) => log('saved', flowId));

  await flow.load();

  // The host owns the theme; Flow follows it.
  flow.setTheme(host.theme);
  renderCrumbs();
  renderSummary(host.flow.api.status());
  startTicker();

  // ?flow=<id> opens straight into a nested flow, which is also how the demo
  // gets screenshotted without a mouse.
  const startFlow = params.get('flow');
  if (startFlow) await flow.api.enter(startFlow);

  if (host.portKind === 'http' && !flow.api.capabilities().live) {
    log('error', 'HTTP port unreachable — is scripts/flow-api-server.js running?');
  }
}

// ── Controls ───────────────────────────────────────────────────────────────

$('#port-select').value = host.portKind;
$('#port-select').querySelector('option[value="http"]').textContent = `HttpPort (→ ${API_BASE})`;
$('#port-select').addEventListener('change', (e) => {
  host.portKind = e.target.value;
  mountFlow();
});

$('#btn-mode').addEventListener('click', () => {
  host.mode = host.mode === 'live' ? 'edit' : 'live';
  $('#btn-mode').textContent = `Mode: ${host.mode}`;
  mountFlow();
});

$('#btn-theme').addEventListener('click', () => {
  host.theme = host.theme === 'light' ? 'dark' : 'light';
  applyTheme();
});

$('#btn-focus').addEventListener('click', () => {
  // A host command is just a method call; Flow does not know what it means.
  host.flow?.api.command('focus_agent', { agent: 'a2', reason: 'demo' });
});

window.addEventListener('beforeunload', () => host.flow?.destroy());

applyTheme();
mountFlow();
