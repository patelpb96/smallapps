/**
 * App wiring: prompt → spec → editor → inspector → export.
 *
 * All parsing, layout, hazard analysis and SVG generation live in ../../src/flow/.
 * This file only handles state and DOM, so the engine stays testable without a
 * browser.
 */

import { fromText, interpret, layout, analyze } from '../../src/flow/index.js';
import { normalizeSpec, cloneSpec, nextId } from '../../src/flow/spec.js';
import {
  PRIMITIVES, CATEGORY, EFFECT_LABELS, getPrimitive, primitivesByCategory, effectsOf,
} from '../../src/flow/primitives.js';
import { renderSVG, accentFor } from '../../src/flow/render.js';
import { SOURCES } from '../../src/agent-plan/sources.js';
import { DiagramEditor } from './editor.js';
import { buildPrompt, interpretWithLLM, DEFAULT_SETTINGS, SPEC_CONTRACT } from './llm.js';

const STORE = 'smallapps.flow.v1';

const $ = (s) => document.querySelector(s);
const el = (tag, props = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') n.className = v;
    else if (k === 'html') n.innerHTML = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v !== null && v !== undefined && v !== false) n.setAttribute(k, v);
  }
  for (const kid of kids.flat()) {
    if (kid === null || kid === undefined || kid === false) continue;
    n.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return n;
};
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const EXAMPLE_PROMPTS = [
  'When an invoice arrives by email, the finance agent extracts the vendor, amount and PO number. It matches the PO in the ERP. If the amount is over $5,000 a manager approves it; otherwise it auto-approves. Finally it posts the invoice to the ledger and emails the vendor.',
  'Every morning at 7am, the research agent searches for new filings from our watchlist, summarises each one, and drafts a briefing. A analyst reviews the briefing and either approves it or sends it back. Once approved it is published to the intranet.',
  'When a support ticket is created, the triage agent classifies it and reads the customer account. If it is a billing issue an on-call engineer reviews it, otherwise the agent drafts a reply. In parallel the agent updates the ticket and notifies the customer in Slack.',
  'trigger -> fetch rows from warehouse -> agent summarise -> if drift detected -> engineer approves -> write alert -> send email',
];

const state = {
  spec: null,
  analysis: null,
  prompt: '',
  interpreter: 'rules',
  llm: { ...DEFAULT_SETTINGS },
  dirty: false,
};

let editor;

// ── Utilities ───────────────────────────────────────────────────────────────

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), 1800);
}

function download(filename, data, type = 'application/octet-stream') {
  const blob = data instanceof Blob ? data : new Blob([data], { type });
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

const slug = () => (state.spec?.title || 'workflow')
  .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'workflow';

/** Accent for a primitive in whatever theme the canvas is currently in. */
function accentOf(primitiveId) {
  return accentFor(primitiveId, editor?.theme || pageTheme());
}

/**
 * Follow the OS/browser colour scheme, which is what the page CSS follows.
 * ?theme=dark|light overrides it, so a diagram can be exported for whichever
 * background it is going into.
 */
function pageTheme() {
  const forced = new URLSearchParams(location.search).get('theme');
  if (forced === 'dark' || forced === 'light') return forced;
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

// ── Persistence ─────────────────────────────────────────────────────────────

function save() {
  try {
    localStorage.setItem(STORE, JSON.stringify({
      spec: state.spec, prompt: state.prompt, interpreter: state.interpreter, llm: state.llm,
    }));
  } catch { /* quota or private mode — not worth interrupting the user */ }
}

function load() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE) || 'null');
    if (!raw) return false;
    if (raw.prompt) { state.prompt = raw.prompt; $('#prompt').value = raw.prompt; }
    if (raw.interpreter) state.interpreter = raw.interpreter;
    if (raw.llm) state.llm = { ...DEFAULT_SETTINGS, ...raw.llm };
    if (raw.spec?.nodes?.length) {
      const { spec } = normalizeSpec(raw.spec);
      state.spec = spec;
      return true;
    }
  } catch { /* corrupt state is not a crash */ }
  return false;
}

// ── Palette ─────────────────────────────────────────────────────────────────

function renderPalette() {
  const root = $('#palette');
  root.replaceChildren();
  const groups = primitivesByCategory();

  for (const [key, cat] of Object.entries(CATEGORY)) {
    const items = groups[key] || [];
    if (!items.length) continue;
    const group = el('div', { class: 'pal-group' });
    group.style.setProperty('--dot', accentOf(items[0].id));

    const wrap = el('div', { class: 'pal-items' });
    for (const p of items) {
      wrap.append(el('button', {
        type: 'button',
        title: `${p.label} — ${p.hint}`,
        onclick: () => {
          const node = editor.addNode(p.id);
          toast(`Added ${p.label}`);
          editor.select([node.id]);
        },
      }, p.label));
    }
    group.append(el('h3', {}, cat.title), wrap);
    root.append(group);
  }
}

// ── Examples ────────────────────────────────────────────────────────────────

function renderExamples() {
  const root = $('#examples');
  root.replaceChildren();
  for (const p of EXAMPLE_PROMPTS) {
    root.append(el('button', { type: 'button', onclick: () => { $('#prompt').value = p; state.prompt = p; generate(); } },
      p.length > 120 ? `${p.slice(0, 116)}…` : p));
  }
}

// ── Generate ────────────────────────────────────────────────────────────────

async function generate() {
  const text = $('#prompt').value.trim();
  if (!text) { toast('Describe the workflow first'); return; }
  state.prompt = text;

  const btn = $('#generate');
  btn.disabled = true;
  const original = btn.textContent;
  btn.textContent = 'Working…';

  try {
    let result;
    if (state.interpreter === 'llm') {
      result = await interpretWithLLM(text, state.llm);
      toast('Parsed by model — check the lanes');
    } else {
      result = fromText(text);
    }

    state.dirty = true;
    editor.setSpec(result.spec);
    $('#title').value = result.spec.title || '';
    updateEmptyState();

    const issues = result.issues || [];
    if (issues.length) toast(`${issues.length} thing${issues.length > 1 ? 's' : ''} needed fixing — see Risks`);

    save();
  } catch (err) {
    // A failed model call must not leave you with half a diagram.
    console.error(err);
    toast(`Interpreter failed: ${err.message}`);
    if (state.interpreter === 'llm') {
      toast('Falling back to the rule-based parser');
      const fallback = fromText(text);
      editor.setSpec(fallback.spec);
      $('#title').value = fallback.spec.title || '';
      updateEmptyState();
    }
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
}

// ── Analysis ────────────────────────────────────────────────────────────────

function refreshAnalysis() {
  state.analysis = analyze(state.spec);
  const nodeIds = new Set(state.analysis.flags.flatMap((f) => f.nodes || []));
  editor.setWarnings({ nodes: [...nodeIds] });
  renderRisks();

  const count = state.analysis.flags.filter((f) => f.severity === 'critical' || f.severity === 'high').length;
  const badge = $('#risk-count');
  badge.textContent = String(count);
  badge.hidden = count === 0;
}

function renderRisks() {
  const root = $('#risks');
  root.replaceChildren();
  const flags = state.analysis?.flags || [];

  if (!flags.length) {
    root.append(el('p', { class: 'empty-note' }, 'Nothing structural to flag. That is a statement about the drawing, not about the system.'));
    return;
  }

  for (const f of flags) {
    const item = el('div', { class: `risk-item ${f.severity}`, onclick: () => focusNodes(f.nodes) });
    item.append(el('h4', {}, el('span', { class: `sev ${f.severity}` }, f.severity), f.title));
    item.append(el('p', {}, f.detail));
    if (f.sources?.length) {
      const refs = f.sources.map((id) => {
        const s = SOURCES[id];
        return s ? `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.short || s.publisher)} ${s.year}</a>` : esc(id);
      }).join(' · ');
      item.append(el('div', { class: 'src', html: `Sources: ${refs}` }));
    }
    root.append(item);
  }
}

function focusNodes(ids) {
  if (!ids?.length) return;
  editor.select(ids);
  switchTab('inspector');
  editor.fit();
}

// ── Inspector ───────────────────────────────────────────────────────────────

function renderInspector(payload) {
  const root = $('#inspector');
  root.replaceChildren();

  if (!payload) {
    root.append(el('p', { class: 'empty-note' }, 'Select a node or an edge to edit it.'));
    renderLanesSection(root);
    return;
  }

  if (payload.kind === 'edge') return renderEdgeInspector(root, payload.edge);
  if (payload.kind === 'multi') return renderMultiInspector(root, payload.nodes);
  return renderNodeInspector(root, payload.nodes[0]);
}

function renderNodeInspector(root, node) {
  const prim = getPrimitive(node.primitive);
  const accent = accentOf(node.primitive);

  const head = el('div', { class: 'inspector-head' });
  const swatch = el('span', { class: 'swatch' });
  swatch.style.background = accent;
  head.append(swatch, el('span', { class: 'kind' }, CATEGORY[prim.category].title), el('span', { class: 'name' }, node.id));
  root.append(head);

  const labelField = el('div', { class: 'field' });
  const labelInput = el('input', { type: 'text', value: node.label, oninput: (e) => {
    node.label = e.target.value;
    editor.updateNode(node.id, { label: e.target.value });
  } });
  labelField.append(el('label', {}, 'Label'), labelInput);
  root.append(labelField);

  const typeField = el('div', { class: 'field' });
  const select = el('select', { onchange: (e) => {
    const p = getPrimitive(e.target.value);
    editor.updateNode(node.id, { primitive: p.id, props: { ...p.props, ...(node.props?.actor ? { actor: node.props.actor } : {}) } });
    renderInspector(editor.selectionPayload());
  } });
  for (const [key, cat] of Object.entries(CATEGORY)) {
    const group = el('optgroup', { label: cat.title });
    for (const p of PRIMITIVES.filter((x) => x.category === key)) {
      group.append(el('option', { value: p.id, ...(p.id === node.primitive ? { selected: '' } : {}) }, p.label));
    }
    select.append(group);
  }
  typeField.append(el('label', {}, 'Primitive'), select);
  root.append(typeField);

  const laneField = el('div', { class: 'field' });
  const laneSelect = el('select', { onchange: (e) => editor.updateNode(node.id, { lane: e.target.value }) });
  for (const l of state.spec.lanes) {
    laneSelect.append(el('option', { value: l.id, ...(l.id === node.lane ? { selected: '' } : {}) }, l.name));
  }
  laneField.append(el('label', {}, 'Lane'), laneSelect);
  root.append(laneField);

  // Primitive-specific props: whatever the registry declares, plus anything the
  // interpreter or an LLM already attached.
  const propKeys = [...new Set([...Object.keys(prim.props), ...Object.keys(node.props || {})])];
  if (propKeys.length) {
    const box = el('div', { class: 'field' });
    box.append(el('label', {}, 'Properties'));
    for (const key of propKeys) {
      const wrap = el('div', { style: 'display:flex;align-items:center;gap:6px;margin-bottom:4px' });
      wrap.append(el('span', { style: 'font-size:11px;color:var(--ink-faint);min-width:64px;font-family:var(--mono)' }, key));
      wrap.append(el('input', {
        type: 'text', value: node.props?.[key] ?? '', placeholder: prim.props[key] ?? '',
        style: 'flex:1',
        onchange: (e) => editor.updateNodeProps(node.id, { [key]: e.target.value }),
      }));
      box.append(wrap);
    }
    root.append(box);
  }

  const effects = effectsOf([node.primitive]);
  if (effects.length) {
    const box = el('div', { class: 'field' });
    box.append(el('label', {}, 'Effects'));
    const wrap = el('div', { class: 'effects' });
    for (const e of effects) {
      const risky = ['irreversible', 'external-egress', 'untrusted-input', 'sensitive-read', 'exec-code'].includes(e);
      wrap.append(el('span', { class: `eff${risky ? ' risk' : ''}` }, EFFECT_LABELS[e] || e));
    }
    box.append(wrap);
    root.append(box);
  }

  const buttons = el('div', { class: 'btn-row' });
  buttons.append(
    el('button', { type: 'button', onclick: () => { editor.duplicateSelection(); } }, 'Duplicate'),
    el('button', { type: 'button', class: 'danger', onclick: () => editor.deleteSelection() }, 'Delete'),
  );
  root.append(buttons);

  renderConnected(root, node);
  renderLanesSection(root);
}

function renderConnected(root, node) {
  const incoming = state.spec.edges.filter((e) => e.to === node.id);
  const outgoing = state.spec.edges.filter((e) => e.from === node.id);
  if (!incoming.length && !outgoing.length) return;

  const byId = new Map(state.spec.nodes.map((n) => [n.id, n]));
  const box = el('div', { class: 'field', style: 'margin-top:14px' });
  box.append(el('label', {}, `Connections (${incoming.length} in · ${outgoing.length} out)`));

  const list = el('div');
  for (const e of incoming) {
    list.append(el('div', { style: 'font-size:11.5px;color:var(--ink-soft);padding:2px 0' },
      '← ', byId.get(e.from)?.label || e.from));
  }
  for (const e of outgoing) {
    list.append(el('div', { style: 'font-size:11.5px;color:var(--ink-soft);padding:2px 0;cursor:pointer',
      onclick: () => editor.selectEdge(e.id) },
      '→ ', byId.get(e.to)?.label || e.to, e.fromPort !== 'out' ? el('span', { style: 'font-family:var(--mono);font-size:9.5px;color:var(--ink-faint)' }, ` (${e.fromPort})`) : ''));
  }
  box.append(list);
  root.append(box);
}

function renderEdgeInspector(root, edge) {
  const head = el('div', { class: 'inspector-head' });
  head.append(el('span', { class: 'kind' }, 'Edge'), el('span', { class: 'name' }, edge.id));
  root.append(head);

  const byId = new Map(state.spec.nodes.map((n) => [n.id, n]));
  root.append(el('p', { style: 'font-size:12px;color:var(--ink-soft);margin:0 0 12px' },
    `${byId.get(edge.from)?.label || edge.from} → ${byId.get(edge.to)?.label || edge.to}`));

  const kindField = el('div', { class: 'field' });
  const kindSelect = el('select', { onchange: (e) => editor.updateEdge(edge.id, { kind: e.target.value }) });
  for (const k of ['sequence', 'branch', 'error', 'async', 'loop']) {
    kindSelect.append(el('option', { value: k, ...(k === edge.kind ? { selected: '' } : {}) }, k));
  }
  kindField.append(el('label', {}, 'Kind'), kindSelect);
  root.append(kindField);

  const portField = el('div', { class: 'field' });
  const portSelect = el('select', { onchange: (e) => editor.updateEdge(edge.id, { fromPort: e.target.value }) });
  for (const p of ['out', 'true', 'false', 'error']) {
    portSelect.append(el('option', { value: p, ...(p === edge.fromPort ? { selected: '' } : {}) }, p));
  }
  portField.append(el('label', {}, 'Source port'), portSelect);
  root.append(portField);

  const labelField = el('div', { class: 'field' });
  labelField.append(el('label', {}, 'Label'),
    el('input', { type: 'text', value: edge.label || '', placeholder: 'optional', onchange: (e) => editor.updateEdge(edge.id, { label: e.target.value }) }));
  root.append(labelField);

  root.append(el('div', { class: 'btn-row' },
    el('button', { type: 'button', class: 'danger', onclick: () => editor.deleteSelection() }, 'Delete edge')));
}

function renderMultiInspector(root, nodes) {
  root.append(el('div', { class: 'inspector-head' },
    el('span', { class: 'kind' }, 'Selection'), el('span', { class: 'name' }, `${nodes.length} nodes`)));

  const laneField = el('div', { class: 'field' });
  const laneSelect = el('select', { onchange: (e) => {
    for (const n of nodes) editor.spec.nodes.find((x) => x.id === n.id).lane = e.target.value;
    editor.commit('reassign lanes');
  } });
  laneSelect.append(el('option', { value: '' }, 'Move to lane…'));
  for (const l of state.spec.lanes) laneSelect.append(el('option', { value: l.id }, l.name));
  laneField.append(el('label', {}, 'Lane'), laneSelect);
  root.append(laneField);

  root.append(el('div', { class: 'btn-row' },
    el('button', { type: 'button', onclick: () => editor.duplicateSelection() }, 'Duplicate'),
    el('button', { type: 'button', class: 'danger', onclick: () => editor.deleteSelection() }, 'Delete')));
}

function renderLanesSection(root) {
  const box = el('div', { class: 'field', style: 'margin-top:20px;border-top:1px solid var(--line-soft);padding-top:12px' });
  box.append(el('label', {}, 'Lanes'));

  for (const lane of state.spec?.lanes || []) {
    const row = el('div', { style: 'display:flex;align-items:center;gap:5px;margin-bottom:4px' });
    row.append(el('input', {
      type: 'text', value: lane.name, style: 'flex:1',
      onchange: (e) => editor.renameLane(lane.id, e.target.value),
    }));
    row.append(el('button', {
      type: 'button', title: 'Delete lane', style: 'padding:2px 7px',
      onclick: () => editor.deleteLane(lane.id),
    }, '×'));
    box.append(row);
  }

  box.append(el('button', { type: 'button', style: 'width:100%;margin-top:4px', onclick: () => {
    const name = window.prompt('Lane name', 'New lane');
    if (name) editor.addLane(name);
  } }, '+ Add lane'));

  root.append(box);
}

// ── Tabs ────────────────────────────────────────────────────────────────────

function switchTab(name) {
  for (const t of document.querySelectorAll('.tab')) t.classList.toggle('is-active', t.dataset.tab === name);
  for (const p of document.querySelectorAll('.tabpanel')) p.classList.toggle('is-active', p.dataset.panel === name);
}

// ── Inline label editing ────────────────────────────────────────────────────

function inlineEdit(node, commit, nodeEl) {
  const existing = document.getElementById('inline-edit');
  if (existing) existing.remove();

  const rect = editor.screenRectOf(node);
  const ta = el('textarea', { id: 'inline-edit' });
  ta.value = node.label;
  ta.style.left = `${rect.left}px`;
  ta.style.top = `${rect.top}px`;
  ta.style.width = `${Math.max(140, rect.width)}px`;
  ta.style.height = `${Math.max(34, rect.height)}px`;
  document.body.append(ta);
  ta.focus();
  ta.select();

  let done = false;
  const finish = (save) => {
    if (done) return;
    done = true;
    const value = ta.value.trim();
    ta.remove();
    if (save && value) commit(value);
    else editor.render();
  };

  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); finish(true); }
    else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
  });
  ta.addEventListener('blur', () => finish(true));
  void nodeEl;
}

// ── Export ──────────────────────────────────────────────────────────────────

function exportSVG() {
  const spec = editor.getSpec();
  const svg = renderSVG(spec, { width: spec.width, height: spec.height, theme: editor.theme });
  download(`${slug()}.svg`, svg, 'image/svg+xml');
}

async function exportPNG() {
  const spec = editor.getSpec();
  const width = spec.width || 1200;
  const height = spec.height || 600;
  const svg = renderSVG(spec, { width, height, theme: editor.theme });

  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }));
  try {
    const img = new Image();
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = () => reject(new Error('could not rasterise the SVG'));
      img.src = url;
    });

    const scale = 2;
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(width * scale);
    canvas.height = Math.round(height * scale);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = editor.theme === 'dark' ? '#141413' : '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('canvas produced no image');
    download(`${slug()}.png`, blob);
    toast('PNG exported');
  } finally {
    URL.revokeObjectURL(url);
  }
}

function exportJSON() {
  download(`${slug()}.json`, JSON.stringify(editor.getSpec(), null, 2), 'application/json');
}

function copyPrompt() {
  const text = buildPrompt(state.prompt || state.spec?.meta?.source || '(describe the workflow here)');
  download(`${slug()}-prompt.txt`, `${text}\n`);
  navigator.clipboard?.writeText(text).then(
    () => toast('Prompt copied — paste to any model, then Import the JSON'),
    () => toast('Prompt downloaded'),
  );
}

// ── Boot ────────────────────────────────────────────────────────────────────

function updateEmptyState() {
  const empty = !state.spec?.nodes?.length;
  $('#empty-state').hidden = !empty;
}

function setInterpreter(ui) {
  state.interpreter = ui;
  $('#llm-settings').hidden = ui !== 'llm';
  $('#prompt-note').textContent = ui === 'llm'
    ? 'One call to your endpoint, then the same normaliser and layout as the rules parser.'
    : 'Rule-based parsing: no network, no key. Everything it produces is editable.';
  save();
}

function init() {
  const hadState = load();

  editor = new DiagramEditor($('#canvas'), {
    onChange: (spec) => {
      state.spec = spec;
      state.dirty = true;
      refreshAnalysis();
      save();
    },
    onSelect: (payload) => renderInspector(payload),
    onEditLabel: (node, commit, nodeEl) => inlineEdit(node, commit, nodeEl),
  });
  editor.onViewChange = () => { $('#zoom-level').textContent = `${Math.round(editor.view.k * 100)}%`; };

  const applyTheme = () => {
    const theme = pageTheme();
    document.documentElement.dataset.theme = theme;
    editor.setTheme(theme);
    renderPalette();
    // init calls applyTheme before a spec exists; the inspector is rendered
    // again once one does.
    if (state.spec) renderInspector(editor.selectionPayload());
  };
  applyTheme();
  window.matchMedia?.('(prefers-color-scheme: dark)')
    .addEventListener('change', () => {
      // An explicit ?theme= wins over the OS, so do not clobber it.
      if (new URLSearchParams(location.search).has('theme')) return;
      applyTheme();
    });

  renderPalette();
  renderExamples();

  $('#interpreter').value = state.interpreter;
  setInterpreter(state.interpreter);
  $('#llm-endpoint').value = state.llm.endpoint;
  $('#llm-model').value = state.llm.model;
  $('#llm-key').value = state.llm.apiKey;

  if (hadState && state.spec) {
    editor.setSpec(state.spec);
    $('#title').value = state.spec.title || '';
    $('#prompt').value = state.prompt || '';
  } else {
    state.spec = editor.getSpec();
    editor.fit();
  }
  updateEmptyState();
  refreshAnalysis();
  renderInspector(null);

  // ── Buttons ──
  $('#generate').addEventListener('click', generate);
  $('#prompt').addEventListener('input', (e) => { state.prompt = e.target.value; save(); });
  $('#prompt').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); generate(); }
  });

  $('#interpreter').addEventListener('change', (e) => setInterpreter(e.target.value));
  for (const [id, key] of [['llm-endpoint', 'endpoint'], ['llm-model', 'model'], ['llm-key', 'apiKey']]) {
    $(`#${id}`).addEventListener('input', (e) => { state.llm[key] = e.target.value; save(); });
  }

  $('#title').addEventListener('input', (e) => {
    state.spec.title = e.target.value;
    save();
  });

  $('#btn-undo').addEventListener('click', () => editor.undo());
  $('#btn-redo').addEventListener('click', () => editor.redo());
  $('#btn-tidy').addEventListener('click', () => { editor.tidy(); toast('Re-laid out'); });

  $('#zoom-in').addEventListener('click', () => editor.zoomBy(1.15));
  $('#zoom-out').addEventListener('click', () => editor.zoomBy(1 / 1.15));
  $('#zoom-fit').addEventListener('click', () => editor.fit());

  const menu = $('#export-menu');
  $('#btn-export').addEventListener('click', (e) => {
    e.stopPropagation();
    menu.hidden = !menu.hidden;
    $('#btn-export').setAttribute('aria-expanded', String(!menu.hidden));
  });
  document.addEventListener('click', () => { menu.hidden = true; });
  menu.addEventListener('click', async (e) => {
    const kind = e.target.closest('[data-export]')?.dataset.export;
    if (!kind) return;
    menu.hidden = true;
    try {
      if (kind === 'png') await exportPNG();
      else if (kind === 'svg') exportSVG();
      else if (kind === 'json') exportJSON();
      else if (kind === 'prompt') copyPrompt();
    } catch (err) {
      console.error(err);
      toast(`Export failed: ${err.message}`);
    }
  });

  $('#btn-import').addEventListener('click', () => $('#file-import').click());
  $('#file-import').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const raw = JSON.parse(await file.text());
      const { spec, issues } = normalizeSpec(raw);
      const needsLayout = spec.nodes.some((n) => !Number.isFinite(n.x));
      const final = needsLayout ? layout(spec).spec : spec;
      editor.setSpec(final);
      $('#title').value = final.title || '';
      updateEmptyState();
      toast(issues.length ? `Imported with ${issues.length} fixups` : 'Imported');
    } catch (err) {
      console.error(err);
      toast('Could not read that file as a diagram spec');
    }
    e.target.value = '';
  });

  document.querySelector('.tabs').addEventListener('click', (e) => {
    const tab = e.target.closest('[data-tab]');
    if (tab) switchTab(tab.dataset.tab);
  });

  // ── Keyboard ──
  document.addEventListener('keydown', (e) => {
    const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName);
    if (e.code === 'Space' && !typing) { editor.spaceHeld = true; $('#canvas').style.cursor = 'grab'; }

    if (typing) return;
    const mod = e.metaKey || e.ctrlKey;

    if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? editor.redo() : editor.undo(); }
    else if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); editor.redo(); }
    else if (mod && e.key.toLowerCase() === 'd') { e.preventDefault(); editor.duplicateSelection(); }
    else if (mod && e.key === 'Enter') { e.preventDefault(); generate(); }
    else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); editor.deleteSelection(); }
    else if (e.key === 'Escape') editor.clearSelection();
    else if (e.key.startsWith('Arrow')) {
      if (!editor.selection.size) return;
      e.preventDefault();
      const step = e.shiftKey ? 1 : 8;
      const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
      const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
      for (const id of editor.selection) {
        const n = editor.spec.nodes.find((x) => x.id === id);
        if (n) { n.x = (n.x || 0) + dx; n.y = (n.y || 0) + dy; }
      }
      editor.commit('nudge');
    }
  });
  document.addEventListener('keyup', (e) => {
    if (e.code === 'Space') { editor.spaceHeld = false; $('#canvas').style.cursor = ''; }
  });

  // ?demo=0..3 loads one of the examples, so a diagram can be shared as a link.
  const params = new URLSearchParams(location.search);
  if (params.get('tab') === 'risks') switchTab('risks');

  const demo = params.get('demo');
  if (demo !== null && EXAMPLE_PROMPTS[Number(demo)]) {
    const text = EXAMPLE_PROMPTS[Number(demo)];
    $('#prompt').value = text;
    state.prompt = text;
    generate();
  }

  // ?select=<id or label fragment> focuses a node, so a step can be linked to.
  // Runs after generate() because it needs the spec that generate produced.
  const sel = params.get('select');
  if (sel) {
    const target = state.spec?.nodes?.find(
      (n) => n.id === sel || n.label.toLowerCase().includes(sel.toLowerCase()),
    );
    if (target) {
      editor.select([target.id]);
      switchTab('inspector');
    }
  }

  window.addEventListener('resize', () => editor.onViewChange?.());
}

document.addEventListener('DOMContentLoaded', init);

export { SPEC_CONTRACT, interpret, cloneSpec, nextId };
