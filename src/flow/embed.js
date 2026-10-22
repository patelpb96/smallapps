/**
 * FlowEmbed — mount the diagram inside someone else's application.
 *
 * The whole portability surface is this file plus `port.js`. A host does:
 *
 *   const flow = FlowEmbed.mount(el, { port, context, mode: 'live' });
 *   await flow.load();
 *   // …later, and on unmount:
 *   flow.destroy();
 *
 * Everything the host can influence arrives through the port. Flow brings its
 * own styles (scoped, injected once), its own rendering, and its own state; it
 * does not read the host's globals, router, or CSS.
 *
 * Kept out of apps/flow/ on purpose: apps/flow is one host, not the product.
 */

import { DiagramEditor } from '../../apps/flow/editor.js';
import { normalizeBundle, withStatus, breadcrumb, parentOf, descendantCount } from './bundle.js';
import { normalizePool, applyDeltas, summarize } from './status.js';
import { StaticPort } from './port.js';
import { layout } from './layout.js';

const STYLE_ID = 'flow-embed-styles';
const EMBED_CSS = `
.flow-embed { position: relative; width: 100%; height: 100%; min-height: 240px; overflow: hidden;
  background: var(--flow-embed-bg, #fbfbfa); }
.flow-embed[data-theme="dark"] { --flow-embed-bg: #101010; }
.flow-embed svg { display: block; width: 100%; height: 100%; touch-action: none; }
.flow-embed .node { cursor: grab; }
.flow-embed .node:active { cursor: grabbing; }
.flow-embed .port { cursor: crosshair; opacity: 0; transition: opacity .12s; }
.flow-embed .node:hover .port { opacity: 1; }
.flow-embed-edit { position: fixed; z-index: 2147483000; border: 2px solid #3b5bdb;
  background: #fff; color: #1b1b19; padding: 6px 8px; font: 12.5px/1.4 ui-sans-serif, system-ui, sans-serif;
  resize: none; box-shadow: 0 6px 24px rgba(0,0,0,.18); }
.flow-embed-badge { position: absolute; top: 8px; left: 8px; display: flex; gap: 6px; align-items: center;
  font: 600 11px/1 ui-sans-serif, system-ui, sans-serif; color: #55554f; background: var(--flow-embed-bg);
  border: 1px solid #d8d8d1; padding: 5px 8px; pointer-events: none; }
.flow-embed[data-theme="dark"] .flow-embed-badge { color: #a8a8a2; border-color: #30302c; }
`;

let styleInjected = false;
function injectStyles(doc) {
  if (styleInjected || doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = EMBED_CSS;
  doc.head.append(style);
  styleInjected = true;
}

/** Minimal emitter — the host subscribes; Flow does not reach back. */
class Emitter {
  constructor() { this.map = new Map(); }
  on(name, fn) {
    if (!this.map.has(name)) this.map.set(name, new Set());
    this.map.get(name).add(fn);
    return () => this.map.get(name)?.delete(fn);
  }
  emit(name, payload) {
    for (const fn of this.map.get(name) || []) {
      try { fn(payload); } catch (err) { console.error(`[flow-embed] ${name} handler threw`, err); }
    }
  }
}

export const FlowEmbed = {
  /**
   * @param {Element|string} target
   * @param {{
   *   port?: object,
   *   context?: {session?: string, workspace?: string, project?: string},
   *   mode?: 'live'|'edit'|'readonly',
   *   theme?: 'light'|'dark'|'auto',
   *   spec?: object,
   *   pollMs?: number,
   * }} options
   */
  mount(target, options = {}) {
    return new FlowEmbedController(target, options);
  },
};

class FlowEmbedController {
  constructor(target, options) {
    this.options = {
      mode: 'live',
      theme: 'auto',
      context: {},
      pollMs: 4000,
      ...options,
    };
    this.port = this.options.port || new StaticPort(this.options.spec || null);
    this.emitter = new Emitter();
    this.bundle = normalizeBundle(this.options.spec || null).bundle;
    this.pool = normalizePool(null).pool;
    this.flowId = this.bundle.root;
    this.destroyed = false;
    this.pollTimer = null;
    this.unsubscribe = null;
    this.saveTimer = null;
    this.pendingSave = false;

    const el = typeof target === 'string' ? document.querySelector(target) : target;
    if (!el) throw new Error('FlowEmbed.mount: target not found');
    this.root = el;
    this.root.classList.add('flow-embed');
    this.root.replaceChildren();
    injectStyles(document);

    const badge = document.createElement('div');
    badge.className = 'flow-embed-badge';
    badge.hidden = !this.options.mode.startsWith('live');
    this.badge = badge;

    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    this.root.append(badge, svg);

    this.theme = this.options.theme === 'auto' ? this._systemTheme() : this.options.theme;
    this._applyTheme();

    this.editor = new DiagramEditor(svg, {
      onChange: () => this._onEdit(),
      onSelect: (payload) => this.emitter.emit('selection', payload),
      onEditLabel: (node, commit, nodeEl) => this._inlineEdit(node, commit, nodeEl),
      onDrill: (node) => this.enter(node.subflow),
    });

    this.api = {
      enter: (id) => this.enter(id),
      back: () => this.back(),
      root: () => this.enter(this.bundle.root),
      refresh: () => this.refresh(),
      current: () => this.flowId,
      breadcrumb: () => breadcrumb(this.bundle, this.flowId),
      command: (name, payload) => this.command(name, payload),
      getSpec: () => this.editor.getSpec(),
      status: () => summarize(this.pool),
      capabilities: () => this.port.capabilities?.() || {},
    };
  }

  // ── lifecycle ────────────────────────────────────────────────────────────

  /** Fetch the topology and its status, then subscribe to changes. */
  async load() {
    try {
      const raw = await this.port.getBundle(this.options.context);
      const { bundle, issues } = normalizeBundle(raw);
      this.bundle = bundle;
      this.flowId = bundle.root;
      if (issues.length) this.emitter.emit('issues', issues);
      this.emitter.emit('bundle', bundle);
    } catch (err) {
      this.emitter.emit('error', { phase: 'bundle', error: err });
      if (!this.bundle?.flows) return this;
    }

    await this._loadStatus({ reset: true });
    this._subscribe();
    this._render({ fit: true });
    return this;
  }

  destroy() {
    this.destroyed = true;
    clearInterval(this.pollTimer);
    clearTimeout(this.saveTimer);
    this.unsubscribe?.();
    this.editor = null;
    this.root.replaceChildren();
    this.root.classList.remove('flow-embed');
  }

  // ── navigation ───────────────────────────────────────────────────────────

  /** Move into a nested flow. The system level stays the root of the breadcrumb. */
  async enter(flowId) {
    const target = String(flowId || '');
    if (!target) return this;
    if (!this.bundle.flows[target]) {
      // A host may withhold nested flows to keep the first payload small.
      try {
        const spec = await this.port.getFlow(target, this.options.context);
        if (spec) {
          const { bundle } = normalizeBundle(spec);
          this.bundle.flows[target] = bundle.flows[bundle.root];
        }
      } catch (err) {
        this.emitter.emit('error', { phase: 'flow', error: err, flowId: target });
      }
    }
    this.flowId = target;
    this.emitter.emit('navigate', { flowId: target, trail: breadcrumb(this.bundle, target) });
    this._render({ fit: true });
    return this;
  }

  back() {
    const parent = parentOf(this.bundle, this.flowId);
    if (parent) return this.enter(parent);
    if (this.flowId !== this.bundle.root) return this.enter(this.bundle.root);
    return this;
  }

  // ── status ───────────────────────────────────────────────────────────────

  async _loadStatus({ reset = false } = {}) {
    try {
      const raw = await this.port.getStatus(this.options.context, reset ? undefined : this.pool.cursor);
      const { pool, issues } = normalizePool(raw);
      if (issues.length) this.emitter.emit('issues', issues);
      if (reset) this.pool = pool;
      else this.pool = applyDeltas(this.pool, pool).pool;
      this.emitter.emit('status', { pool: this.pool, summary: summarize(this.pool) });
    } catch (err) {
      this.emitter.emit('error', { phase: 'status', error: err });
    }
  }

  _subscribe() {
    if (!this.port.subscribe) return;
    try {
      this.unsubscribe = this.port.subscribe(this.options.context, (event) => {
        if (this.destroyed) return;
        if (event?.type === 'delta' || event?.type === 'status' || event?.type === 'message') {
          const delta = event.delta ?? event;
          const { pool, cleared } = applyDeltas(this.pool, delta);
          this.pool = pool;
          if (cleared.length) this.emitter.emit('cleared', cleared);
          this.emitter.emit('status', { pool: this.pool, summary: summarize(this.pool) });
          // A delta is not a topology change: re-merge without refitting.
          this._render({ fit: false });
          return;
        }
        if (event?.type === 'error' || event?.type === 'reconnect') {
          this.emitter.emit('reconnect', event);
        }
      });
    } catch (err) {
      this.emitter.emit('error', { phase: 'subscribe', error: err });
    }

    // Poll as a belt-and-braces fallback; a host with SSE sets pollMs to 0.
    if (this.options.pollMs > 0) {
      this.pollTimer = setInterval(() => {
        if (this.destroyed || document.hidden) return;
        this._loadStatus().then(() => this._render({ fit: false }));
      }, this.options.pollMs);
    }
  }

  async refresh() {
    await this._loadStatus({ reset: true });
    this._render({ fit: false });
    return this;
  }

  // ── editing ──────────────────────────────────────────────────────────────

  _onEdit() {
    if (this.options.mode !== 'edit') return;
    if (!(this.port.capabilities?.().persist)) return;
    // Coalesce drags and typing into one write.
    this.pendingSave = true;
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(async () => {
      if (!this.pendingSave || this.destroyed) return;
      this.pendingSave = false;
      this.bundle.flows[this.flowId] = this.editor.getSpec();
      try {
        await this.port.putBundle(this.bundle);
        this.emitter.emit('saved', { flowId: this.flowId });
      } catch (err) {
        this.emitter.emit('error', { phase: 'save', error: err });
      }
    }, 600);
  }

  async command(name, payload) {
    try {
      const result = await this.port.command(name, payload);
      this.emitter.emit('command', { name, payload, result });
      return result;
    } catch (err) {
      this.emitter.emit('error', { phase: 'command', error: err, name });
      return null;
    }
  }

  _inlineEdit(node, commit) {
    const rect = this.editor.screenRectOf(node);
    const ta = document.createElement('textarea');
    ta.className = 'flow-embed-edit';
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
    };
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); finish(true); }
      if (e.key === 'Escape') { e.preventDefault(); finish(false); }
    });
    ta.addEventListener('blur', () => finish(true));
  }

  // ── view ─────────────────────────────────────────────────────────────────

  /**
   * Hosts send topology, not geometry: node ids, labels and edges. Lay out
   * anything that arrives without positions, exactly once, and keep the result
   * so a status refresh does not move a box the user dragged.
   */
  _ensureLayout(flowId) {
    const spec = this.bundle.flows[flowId];
    if (!spec) return null;
    if (this._laidOut?.has(flowId)) return spec;
    const needsLayout = !spec.nodes.length || spec.nodes.some((n) => !Number.isFinite(n.x));
    if (needsLayout) {
      const { spec: laid } = layout(spec);
      this.bundle.flows[flowId] = laid;
    }
    if (!this._laidOut) this._laidOut = new Set();
    this._laidOut.add(flowId);
    return this.bundle.flows[flowId];
  }

  _render({ fit = false } = {}) {
    if (!this.editor) return;
    const base = this._ensureLayout(this.flowId);
    if (!base) return;

    const { spec, unknown } = withStatus(base, this.pool, this.flowId);
    if (unknown.length) this.emitter.emit('unknown-status', unknown);

    if (fit) this.editor.setSpec(spec, { keepView: false });
    else this.editor.applyExternalSpec(spec);

    this._renderBadge();
  }

  _renderBadge() {
    if (this.badge.hidden) return;
    const s = summarize(this.pool);
    const nested = descendantCount(this.bundle, this.flowId);
    const spec = this.bundle.flows[this.flowId];
    const bits = [`${spec?.nodes.length ?? 0} nodes`];
    if (s.running) bits.push(`${s.running} running`);
    if (s.blocked) bits.push(`${s.blocked} blocked`);
    if (s.error) bits.push(`${s.error} error`);
    if (s.done) bits.push(`${s.done} done`);
    if (nested) bits.push(`${nested} nested`);
    this.badge.textContent = `${this.bundle.flows[this.flowId]?.title || this.flowId} · ${bits.join(' · ')}`;
  }

  _systemTheme() {
    return globalThis.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  _applyTheme() {
    this.root.dataset.theme = this.theme;
    this.editor?.setTheme(this.theme);
  }

  setTheme(theme) {
    this.theme = theme === 'dark' ? 'dark' : 'light';
    this._applyTheme();
    return this;
  }

  on(name, fn) { return this.emitter.on(name, fn); }
}

export { FlowEmbedController };
