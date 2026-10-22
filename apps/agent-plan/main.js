/**
 * UI shell.
 *
 * Deliberately thin: every judgement lives in ../../src/agent-plan/. This file builds
 * inputs, calls buildPlan(), and paints the result. If a rule needs changing,
 * it changes in src/agent-plan/heuristics.js — never here.
 */

import {
  QUESTIONS, GROUPS, PRESETS, defaultAnswers,
} from '../../src/agent-plan/intake.js';
import { buildPlan, ENGINE_VERSION, CATEGORIES, SOURCES } from '../../src/agent-plan/engine.js';
import { renderMarkdown, renderChecklist, renderJson } from '../../src/agent-plan/render.js';

const STORE_KEY = 'smallapps.agent-plan.v1';

const state = {
  answers: defaultAnswers(),
  name: '',
  preset: null,
  filters: new Set(['must', 'should']),
  plan: null,
};

const $ = (sel) => document.querySelector(sel);
const el = (tag, props = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') n.className = v;
    else if (k === 'html') n.innerHTML = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v !== undefined && v !== null) n.setAttribute(k, v);
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    n.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return n;
};

/** Escape user-supplied text before it goes anywhere near HTML. */
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

// ── Persistence ───────────────────────────────────────────────────────────

function save() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({
      answers: state.answers, name: state.name, preset: state.preset,
    }));
  } catch { /* private mode, quota — not worth bothering the user */ }
}

function load() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (parsed.answers) state.answers = { ...defaultAnswers(), ...parsed.answers };
    if (parsed.name) state.name = parsed.name;
    if (parsed.preset) state.preset = parsed.preset;
  } catch { /* corrupt state is not a crash */ }
}

// ── Form ──────────────────────────────────────────────────────────────────

function renderForm() {
  const root = $('#form');
  root.replaceChildren();

  for (const group of GROUPS) {
    const qs = QUESTIONS.filter((q) => q.group === group.id);
    const section = el('section', { class: 'group' },
      el('div', { class: 'group-head' }, el('h2', {}, group.title)),
      el('p', { class: 'blurb' }, group.blurb),
    );
    for (const q of qs) section.append(renderQuestion(q));
    root.append(section);
  }
}

function renderQuestion(q) {
  const fieldset = el('fieldset', { class: 'q' }, el('legend', {}, q.prompt));
  if (q.help) fieldset.append(el('p', { class: 'help' }, q.help));

  if (q.type === 'number') {
    const input = el('input', {
      type: 'number', name: q.id, min: q.min, max: q.max, step: 1,
      value: state.answers[q.id] ?? q.default ?? 0,
      oninput: (e) => {
        state.answers[q.id] = e.target.value === '' ? 0 : Number(e.target.value);
        recompute();
      },
    });
    fieldset.append(el('div', { class: 'num-row' }, input,
      el('span', { class: 'num-hint' }, q.min !== undefined ? `${q.min}–${q.max}` : '')));
    return fieldset;
  }

  const isMulti = q.type === 'multi';
  const current = state.answers[q.id];

  const wrap = el('div', { class: 'options' });
  for (const opt of q.options) {
    const checked = isMulti
      ? Array.isArray(current) && current.includes(opt.value)
      : current === opt.value;

    const input = el('input', {
      type: isMulti ? 'checkbox' : 'radio',
      name: q.id,
      value: opt.value,
      ...(checked ? { checked: '' } : {}),
      onchange: (e) => {
        if (isMulti) {
          const set = new Set(Array.isArray(state.answers[q.id]) ? state.answers[q.id] : []);
          if (e.target.checked) set.add(opt.value); else set.delete(opt.value);
          state.answers[q.id] = [...set];
        } else {
          state.answers[q.id] = opt.value;
        }
        state.preset = null;
        syncPresetButtons();
        recompute();
      },
    });

    wrap.append(el('label', { class: 'opt' }, input,
      el('span', { class: 'label' }, opt.label),
      opt.help ? el('span', { class: 'sub' }, opt.help) : null));
  }
  fieldset.append(wrap);
  return fieldset;
}

function syncFormFromState() {
  for (const q of QUESTIONS) {
    const v = state.answers[q.id];
    if (q.type === 'number') {
      const input = document.querySelector(`input[type="number"][name="${q.id}"]`);
      if (input) input.value = v;
    } else if (q.type === 'multi') {
      for (const opt of q.options) {
        const input = document.querySelector(`input[name="${q.id}"][value="${opt.value}"]`);
        if (input) input.checked = Array.isArray(v) && v.includes(opt.value);
      }
    } else {
      const input = document.querySelector(`input[name="${q.id}"][value="${v}"]`);
      if (input) input.checked = true;
    }
  }
}

// ── Presets ───────────────────────────────────────────────────────────────

function renderPresets() {
  const bar = $('#preset-buttons');
  bar.replaceChildren();
  for (const [key, p] of Object.entries(PRESETS)) {
    bar.append(el('button', {
      type: 'button',
      'data-preset': key,
      class: state.preset === key ? 'is-active' : '',
      onclick: () => applyPreset(key),
    }, p.label));
  }
}

function syncPresetButtons() {
  for (const b of document.querySelectorAll('[data-preset]')) {
    b.classList.toggle('is-active', b.dataset.preset === state.preset);
  }
}

function applyPreset(key) {
  const p = PRESETS[key];
  if (!p) return;
  state.answers = { ...defaultAnswers(), ...structuredClone(p.answers) };
  state.name = p.label;
  state.preset = key;
  $('#wf-name').value = state.name;
  syncFormFromState();
  renderPresets();
  recompute();
}

// ── Verdict ───────────────────────────────────────────────────────────────

function srcLinks(ids) {
  return ids.map((id) => {
    const s = SOURCES[id];
    return s ? `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.short || s.publisher)}, ${s.year}</a>` : esc(id);
  }).join(' · ');
}

function renderVerdict(plan) {
  const { autonomy, sandbox, counts } = plan;
  const v = $('#verdict');
  v.replaceChildren();

  const verdictClass = autonomy.exposure > 0 ? 'over' : autonomy.exposure === 0 ? 'at' : 'head';
  const bannerText = autonomy.exposure > 0
    ? `<strong>Running ${autonomy.exposure} tier${autonomy.exposure > 1 ? 's' : ''} above its ceiling.</strong> It operates at ${autonomy.current.id} but its blast radius and control quality only support ${autonomy.ceiling.id}.`
    : autonomy.exposure === 0
      ? `<strong>At ceiling.</strong> Operating tier matches the evidence. Do not promote until the blockers clear.` +
        (plan.counts.critical
          ? ` ${plan.counts.critical} critical risk flag${plan.counts.critical > 1 ? 's remain' : ' remains'} — being at the right tier is not the same as being safe.`
          : '')
      : plan.facts.canWrite || plan.facts.externalComm
        ? `<strong>Headroom — ${Math.abs(autonomy.exposure)} tier${Math.abs(autonomy.exposure) > 1 ? 's' : ''} below ceiling.</strong> More supervised than the risk profile requires. Check that each review step is buying something.`
        : `<strong>Read-only.</strong> No side effects reach a system of record, so the tier ladder is advisory here rather than a control. Supervision is about output quality, not damage prevention.`;

  v.append(
    el('div', { class: 'verdict-top' },
      el('span', { class: 'tier-badge' }, autonomy.current.id),
      el('span', { class: 'tier-name' }, autonomy.current.name),
      el('span', { class: 'tier-role' }, autonomy.current.humanRole),
    ),
    el('div', { class: `banner ${verdictClass}`, html: bannerText }),
    el('div', { class: 'stats' },
      stat('ceiling', autonomy.ceiling.id, autonomy.exposure > 0 ? 'bad' : ''),
      stat('sandbox', sandbox.required.id, ''),
      stat('must', counts.must, counts.must > 0 ? 'warn' : 'good'),
      stat('critical', counts.critical, counts.critical > 0 ? 'bad' : 'good'),
      stat('high', counts.high, counts.high > 0 ? 'warn' : 'good'),
    ),
  );
}

function stat(k, val, cls) {
  return el('div', { class: 'stat' },
    el('span', { class: 'k' }, k),
    el('span', { class: `v ${cls}` }, String(val)));
}

// ── Controls ──────────────────────────────────────────────────────────────

function renderControls(plan) {
  const root = $('#controls');
  root.replaceChildren();

  // Start here — the ranked list, mirrored from the markdown plan.
  if (plan.topActions.length) {
    const ol = el('ol');
    for (const a of plan.topActions) {
      ol.append(el('li', {}, el('b', {}, a.title), ` — ${a.id}`));
    }
    root.append(el('div', { class: 'start' }, el('h4', {}, 'Do these first'), ol));
  }

  const shown = plan.results.filter((r) => state.filters.has(r.severity));
  if (!shown.length) {
    root.append(el('p', { class: 'empty' }, 'Nothing matches the current severity filter.'));
    return;
  }

  for (const [key, cat] of Object.entries(CATEGORIES)) {
    const items = (plan.byCategory[key] || []).filter((r) => state.filters.has(r.severity));
    if (!items.length) continue;

    const section = el('section', { class: 'cat' },
      el('h3', {}, cat.title, el('span', { class: 'count' }, String(items.length))));

    for (const r of items) section.append(controlItem(r));
    root.append(section);
  }
}

function controlItem(r) {
  const body = el('div', { class: 'ctl-body' });
  if (r.because.length) {
    body.append(el('span', { class: 'meta-label' }, 'Triggered by'),
      el('p', {}, r.because.join('; ')));
  }
  body.append(el('span', { class: 'meta-label' }, 'Requirement'), el('p', {}, r.requirement));
  body.append(el('span', { class: 'meta-label' }, 'Verify'), el('p', {}, r.verify));
  if (r.antiPattern) {
    body.append(el('span', { class: 'meta-label' }, 'Anti-pattern'), el('p', {}, r.antiPattern));
  }
  body.append(el('div', { class: 'src', html: `Sources: ${srcLinks(r.sources)}` }));

  return el('details', { class: 'ctl' },
    el('summary', {},
      el('span', { class: `sev ${r.severity}` }, r.severity),
      el('span', { class: 'title' }, r.title),
      el('span', { class: 'ctl-id' }, r.id)),
    body);
}

// ── Risks ─────────────────────────────────────────────────────────────────

function renderRisks(plan) {
  const root = $('#risks');
  root.replaceChildren();
  if (!plan.flags.length) {
    root.append(el('p', { class: 'empty' }, 'No material risk flags for this configuration.'));
    return;
  }
  for (const f of plan.flags) {
    root.append(el('div', { class: `risk ${f.severity}` },
      el('h4', {}, el('span', { class: `sev ${f.severity === 'critical' ? 'must' : f.severity === 'high' ? 'should' : 'consider'}` }, f.severity), f.title),
      el('p', {}, f.detail),
      el('div', { class: 'src', html: `Sources: ${srcLinks(f.sources)}` })));
  }
}

// ── Tree ──────────────────────────────────────────────────────────────────

function renderWarnings(plan) {
  const box = $('#warnings');
  if (!plan.warnings.length) { box.hidden = true; box.replaceChildren(); return; }
  box.hidden = false;
  box.replaceChildren(
    el('strong', {}, plan.warnings.length === 1 ? 'One answer is not valid' : `${plan.warnings.length} answers are not valid`),
    el('ul', {}, ...plan.warnings.map((w) => el('li', {}, w.message))),
  );
}

function recompute() {
  const plan = buildPlan(state.answers, { name: state.name });
  state.plan = plan;
  renderWarnings(plan);

  renderVerdict(plan);
  renderControls(plan);
  renderRisks(plan);
  $('#doc').textContent = renderMarkdown(plan);
  $('#checklist').textContent = renderChecklist(plan);
  save();
}

// ── Clipboard / download ──────────────────────────────────────────────────

function toast(msg) {
  let t = $('.toast');
  if (!t) { t = el('div', { class: 'toast' }); document.body.append(t); }
  t.textContent = msg;
  requestAnimationFrame(() => t.classList.add('show'));
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), 1600);
}

async function copy(text, label) {
  try {
    await navigator.clipboard.writeText(text);
    toast(`${label} copied`);
  } catch {
    toast('Clipboard blocked by the browser — use Download instead');
  }
}

function download(filename, text, type = 'text/plain') {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const slug = () => (state.name || 'agent-workflow')
  .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'agent-workflow';

// ── Wire up ───────────────────────────────────────────────────────────────

function init() {
  load();
  $('#engine-version').textContent = `engine v${ENGINE_VERSION}`;

  // Shareable links: ?preset=ops-agent, ?name=My+workflow
  const params = new URLSearchParams(location.search);
  const urlPreset = params.get('preset');
  const urlName = params.get('name');
  if (urlPreset && PRESETS[urlPreset]) {
    state.answers = { ...defaultAnswers(), ...structuredClone(PRESETS[urlPreset].answers) };
    state.name = PRESETS[urlPreset].label;
    state.preset = urlPreset;
  }
  if (urlName) state.name = urlName;
  if (state.name) $('#wf-name').value = state.name;

  $('#wf-name').addEventListener('input', (e) => {
    state.name = e.target.value;
    recompute();
  });

  renderPresets();
  renderForm();
  syncFormFromState();

  $('#filters').addEventListener('click', (e) => {
    const chip = e.target.closest('[data-sev]');
    if (!chip) return;
    const sev = chip.dataset.sev;
    if (state.filters.has(sev)) state.filters.delete(sev); else state.filters.add(sev);
    chip.classList.toggle('is-on', state.filters.has(sev));
    if (state.plan) renderControls(state.plan);
  });

  document.querySelector('.tabs').addEventListener('click', (e) => {
    const tab = e.target.closest('[data-tab]');
    if (!tab) return;
    for (const t of document.querySelectorAll('.tab')) t.classList.toggle('is-active', t === tab);
    for (const p of document.querySelectorAll('.tabpanel')) {
      p.classList.toggle('is-active', p.dataset.panel === tab.dataset.tab);
    }
  });

  $('#btn-copy-md').addEventListener('click', () => copy(renderMarkdown(state.plan), 'Plan'));
  $('#btn-copy-cl').addEventListener('click', () => copy(renderChecklist(state.plan), 'Checklist'));
  $('#btn-dl-md').addEventListener('click', () => download(`${slug()}-plan.md`, renderMarkdown(state.plan), 'text/markdown'));
  $('#btn-dl-cl').addEventListener('click', () => download(`${slug()}-checklist.md`, renderChecklist(state.plan), 'text/markdown'));
  $('#btn-dl-json').addEventListener('click', () => download(`${slug()}-plan.json`, renderJson(state.plan), 'application/json'));

  $('#btn-export').addEventListener('click', () => download(
    `${slug()}-answers.json`,
    JSON.stringify({ name: state.name, answers: state.answers }, null, 2),
    'application/json'));

  $('#btn-import').addEventListener('click', () => $('#file-import').click());
  $('#file-import').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text());
      state.answers = { ...defaultAnswers(), ...(parsed.answers || parsed) };
      state.name = parsed.name || state.name;
      state.preset = null;
      $('#wf-name').value = state.name;
      syncFormFromState();
      syncPresetButtons();
      recompute();
      toast('Answers imported');
    } catch {
      toast('Could not parse that file');
    }
    e.target.value = '';
  });

  $('#btn-reset').addEventListener('click', () => {
    state.answers = defaultAnswers();
    state.name = '';
    state.preset = null;
    $('#wf-name').value = '';
    syncFormFromState();
    syncPresetButtons();
    recompute();
    toast('Reset');
  });

  recompute();
}

document.addEventListener('DOMContentLoaded', init);
