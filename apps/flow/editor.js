/**
 * The diagram editor.
 *
 * Imperative SVG with delegated events and a re-render-per-change model. At the
 * sizes this tool deals with (tens of nodes, not thousands) that is faster to
 * write and far harder to get wrong than fine-grained diffing — and the one hot
 * path, dragging, bypasses it by mutating a transform directly.
 *
 * The editor owns positions and selection. Everything about *meaning* — what a
 * primitive is, what a hazard means — lives in ../../src/flow/.
 */

import {
  renderNode, renderEdge, renderLane, renderDefs,
} from '../../src/flow/render.js';
import {
  rectOf, pointInRect, snap, nearestPort,
} from '../../src/flow/geometry.js';
import { cloneSpec, specHash, nextId, nodeById } from '../../src/flow/spec.js';
import { getPrimitive } from '../../src/flow/primitives.js';
import { layout } from '../../src/flow/layout.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

export class DiagramEditor {
  /**
   * @param {SVGSVGElement} svg
   * @param {{onChange?: Function, onSelect?: Function, onEditLabel?: Function}} handlers
   */
  constructor(svg, handlers = {}) {
    this.svg = svg;
    this.onChange = handlers.onChange || (() => {});
    this.onSelect = handlers.onSelect || (() => {});
    this.onEditLabel = handlers.onEditLabel || (() => {});

    this.spec = { version: 1, title: '', lanes: [], nodes: [], edges: [], meta: {} };
    this.selection = new Set();
    this.selectedEdge = null;
    this.warnNodes = new Set();
    this.warnEdges = new Set();

    this.view = { x: 60, y: 40, k: 1 };
    this.undoStack = [];
    this.redoStack = [];
    this._drag = null;
    this.spaceHeld = false;

    this._build();
    this._bind();
  }

  // ── DOM skeleton ────────────────────────────────────────────────────────

  _build() {
    this.svg.innerHTML = '';
    this.svg.setAttribute('xmlns', SVG_NS);

    const defs = document.createElementNS(SVG_NS, 'g');
    defs.innerHTML = renderDefs();

    this.viewport = document.createElementNS(SVG_NS, 'g');
    this.viewport.setAttribute('class', 'viewport');

    this.gLanes = document.createElementNS(SVG_NS, 'g');
    this.gEdges = document.createElementNS(SVG_NS, 'g');
    this.gNodes = document.createElementNS(SVG_NS, 'g');
    this.gOverlay = document.createElementNS(SVG_NS, 'g');
    this.gOverlay.setAttribute('class', 'overlay');

    this.viewport.append(this.gLanes, this.gEdges, this.gNodes, this.gOverlay);
    this.svg.append(defs, this.viewport);
    this._applyView();
  }

  _applyView() {
    this.viewport.setAttribute('transform', `translate(${this.view.x},${this.view.y}) scale(${this.view.k})`);
  }

  // ── Spec I/O ────────────────────────────────────────────────────────────

  setSpec(spec, { resetHistory = true, keepView = false } = {}) {
    this.spec = cloneSpec(spec);
    this.selection.clear();
    this.selectedEdge = null;
    if (resetHistory) { this.undoStack = []; this.redoStack = []; }
    this._lastHash = specHash(this.spec);
    this.render();
    if (!keepView) this.fit();
    this.onSelect(null);
    // Listeners own analysis and persistence; a replaced spec is still a change.
    this.onChange(this.getSpec());
  }

  getSpec() { return cloneSpec(this.spec); }

  /** Snapshot before a mutation so it can be undone. */
  commit(label = 'edit') {
    const hash = specHash(this.spec);
    if (this._lastHash !== hash) {
      this.undoStack.push({ spec: cloneSpec(this.spec), label });
      if (this.undoStack.length > 80) this.undoStack.shift();
      this.redoStack = [];
      this._lastHash = hash;
    }
    this.render();
    this.onChange(this.getSpec());
  }

  undo() {
    if (!this.undoStack.length) return;
    const entry = this.undoStack.pop();
    this.redoStack.push({ spec: cloneSpec(this.spec) });
    this.spec = entry.spec;
    this._lastHash = specHash(this.spec);
    this.selection.clear();
    this.selectedEdge = null;
    this.render();
    this.onChange(this.getSpec());
    this.onSelect(this._selectionPayload());
  }

  redo() {
    if (!this.redoStack.length) return;
    const entry = this.redoStack.pop();
    this.undoStack.push({ spec: cloneSpec(this.spec) });
    this.spec = entry.spec;
    this._lastHash = specHash(this.spec);
    this.selection.clear();
    this.selectedEdge = null;
    this.render();
    this.onChange(this.getSpec());
    this.onSelect(this._selectionPayload());
  }

  // ── Hints from the analyser ─────────────────────────────────────────────

  setWarnings({ nodes = [], edges = [] } = {}) {
    this.warnNodes = new Set(nodes);
    this.warnEdges = new Set(edges);
    this.render();
  }

  // ── Render ──────────────────────────────────────────────────────────────

  render() {
    const byId = nodeById(this.spec);
    const width = this.spec.width || 1200;

    this.gLanes.innerHTML = this.spec.lanes
      .map((l, i) => renderLane(l, i, width))
      .join('');

    this.gEdges.innerHTML = this.spec.edges.map((e) => {
      const from = byId.get(e.from);
      const to = byId.get(e.to);
      if (!from || !to) return '';
      return renderEdge(e, from, to, {
        selected: this.selectedEdge === e.id,
        highlighted: this.warnEdges.has(e.id),
      });
    }).join('');

    this.gNodes.innerHTML = this.spec.nodes.map((n) => renderNode(n, {
      selected: this.selection.has(n.id),
      connectable: this.selection.size <= 1,
      warn: this.warnNodes.has(n.id),
      shape: getPrimitive(n.primitive).shape,
    })).join('');

    // Warning halos drawn under the node bodies.
    if (this.warnNodes.size) {
      const halos = this.spec.nodes
        .filter((n) => this.warnNodes.has(n.id))
        .map((n) => {
          const r = rectOf(n);
          return `<rect x="${r.x - 5}" y="${r.y - 5}" width="${r.w + 10}" height="${r.h + 10}" rx="14" fill="none" stroke="#b42318" stroke-width="1.5" stroke-dasharray="4 4" opacity="0.75"/>`;
        }).join('');
      this.gNodes.insertAdjacentHTML('beforeend', halos);
    }

    this.svg.style.background = 'var(--canvas-bg)';
    this._applyView();
  }

  // ── Selection ───────────────────────────────────────────────────────────

  select(ids, { additive = false } = {}) {
    const list = Array.isArray(ids) ? ids : [ids];
    if (!additive) this.selection.clear();
    for (const id of list) {
      if (!id) continue;
      if (this.selection.has(id)) this.selection.delete(id);
      else this.selection.add(id);
    }
    this.selectedEdge = null;
    this.render();
    this.onSelect(this._selectionPayload());
  }

  selectEdge(id) {
    this.selection.clear();
    this.selectedEdge = id;
    this.render();
    this.onSelect(this._selectionPayload());
  }

  clearSelection() {
    this.selection.clear();
    this.selectedEdge = null;
    this.render();
    this.onSelect(null);
  }

  /** Public: what the inspector should render right now. */
  selectionPayload() { return this._selectionPayload(); }

  _selectionPayload() {
    if (this.selectedEdge) {
      const edge = this.spec.edges.find((e) => e.id === this.selectedEdge);
      return edge ? { kind: 'edge', edge, nodes: [] } : null;
    }
    const nodes = this.spec.nodes.filter((n) => this.selection.has(n.id));
    if (!nodes.length) return null;
    return { kind: nodes.length === 1 ? 'node' : 'multi', nodes };
  }

  // ── Mutations ───────────────────────────────────────────────────────────

  addNode(primitiveId, at = null) {
    const prim = getPrimitive(primitiveId);
    const node = {
      id: nextId('n', this.spec.nodes.map((n) => n.id)),
      primitive: prim.id,
      label: prim.label,
      lane: this.spec.lanes[0]?.id || 'main',
      props: { ...prim.props },
    };

    // Placing onto a lane keeps the diagram readable.
    if (at) {
      const lane = this.spec.lanes.find((l) => at.y >= l.y && at.y <= l.y + (l.height || 96));
      if (lane) node.lane = lane.id;
      node.x = snap(at.x);
      node.y = snap(at.y);
    } else {
      const anchor = this.spec.nodes.find((n) => this.selection.has(n.id));
      node.x = anchor ? anchor.x + 220 : 200;
      node.y = anchor ? anchor.y : (this.spec.lanes[0]?.y || 0) + 24;
      if (anchor) node.lane = anchor.lane;
    }

    if (!this.spec.lanes.length) {
      this.spec.lanes.push({ id: 'main', name: 'Workflow', kind: 'system', y: 34, height: 96 });
      node.lane = 'main';
    }

    this.spec.nodes.push(node);

    // If exactly one node was selected, wire the new one to it: the common case
    // is extending a flow, not starting a second one.
    if (this.selection.size === 1) {
      const from = [...this.selection][0];
      this.spec.edges.push({
        id: nextId('e', this.spec.edges.map((e) => e.id)),
        from, to: node.id, kind: 'sequence', label: '', fromPort: 'out',
      });
    }

    this.selection = new Set([node.id]);
    this._growToFit();
    this.commit('add node');
    this.onSelect(this._selectionPayload());
    return node;
  }

  addEdge(from, to, { kind = 'sequence', fromPort = 'out', label = '' } = {}) {
    if (!from || !to || from === to) return null;
    const exists = this.spec.edges.some((e) => e.from === from && e.to === to && e.fromPort === fromPort);
    if (exists) return null;
    const edge = { id: nextId('e', this.spec.edges.map((e) => e.id)), from, to, kind, label, fromPort };
    this.spec.edges.push(edge);
    this.commit('add edge');
    return edge;
  }

  updateNode(id, patch) {
    const node = this.spec.nodes.find((n) => n.id === id);
    if (!node) return;
    Object.assign(node, patch);
    this.commit('update node');
  }

  updateNodeProps(id, propsPatch) {
    const node = this.spec.nodes.find((n) => n.id === id);
    if (!node) return;
    node.props = { ...(node.props || {}), ...propsPatch };
    this.commit('update props');
  }

  updateEdge(id, patch) {
    const edge = this.spec.edges.find((e) => e.id === id);
    if (!edge) return;
    Object.assign(edge, patch);
    this.commit('update edge');
  }

  deleteSelection() {
    if (this.selectedEdge) {
      this.spec.edges = this.spec.edges.filter((e) => e.id !== this.selectedEdge);
      this.selectedEdge = null;
      this.commit('delete edge');
      this.onSelect(null);
      return;
    }
    if (!this.selection.size) return;
    const ids = new Set(this.selection);
    this.spec.nodes = this.spec.nodes.filter((n) => !ids.has(n.id));
    this.spec.edges = this.spec.edges.filter((e) => !ids.has(e.from) && !ids.has(e.to));
    this.selection.clear();
    this.commit('delete node');
    this.onSelect(null);
  }

  duplicateSelection() {
    if (!this.selection.size) return;
    const map = new Map();
    const copies = [];
    for (const id of this.selection) {
      const src = this.spec.nodes.find((n) => n.id === id);
      if (!src) continue;
      const copy = cloneSpec(src);
      copy.id = nextId('n', this.spec.nodes.map((n) => n.id).concat(copies.map((c) => c.id)));
      copy.x = (copy.x || 0) + 32;
      copy.y = (copy.y || 0) + 32;
      map.set(id, copy.id);
      copies.push(copy);
    }
    this.spec.nodes.push(...copies);

    // Duplicate edges that live entirely inside the selection.
    for (const e of [...this.spec.edges]) {
      if (map.has(e.from) && map.has(e.to)) {
        this.spec.edges.push({
          ...e,
          id: nextId('e', this.spec.edges.map((x) => x.id)),
          from: map.get(e.from),
          to: map.get(e.to),
        });
      }
    }
    this.selection = new Set(copies.map((c) => c.id));
    this.commit('duplicate');
    this.onSelect(this._selectionPayload());
  }

  /** Re-run the layered swimlane layout over the current graph. */
  tidy() {
    const { spec } = layout(this.spec);
    this.spec = spec;
    this.commit('tidy');
    this.fit();
  }

  addLane(name = 'New lane') {
    const id = nextId('lane', this.spec.lanes.map((l) => l.id));
    const baseY = this.spec.lanes.reduce((max, l) => Math.max(max, l.y + (l.height || 96)), 0) + 8;
    this.spec.lanes.push({ id, name, kind: 'human', y: baseY || 34, height: 96 });
    this._growToFit();
    this.commit('add lane');
  }

  renameLane(id, name) {
    const lane = this.spec.lanes.find((l) => l.id === id);
    if (!lane) return;
    lane.name = name;
    this.commit('rename lane');
  }

  deleteLane(id) {
    if (this.spec.lanes.length <= 1) return;
    const fallback = this.spec.lanes.find((l) => l.id !== id);
    for (const n of this.spec.nodes) if (n.lane === id) n.lane = fallback.id;
    this.spec.lanes = this.spec.lanes.filter((l) => l.id !== id);
    this.commit('delete lane');
  }

  // ── View ────────────────────────────────────────────────────────────────

  _contentBox() {
    if (!this.spec.nodes.length) return { x: 0, y: 0, w: 800, h: 400 };
    // Lanes are drawn from x=0, so that edge is part of the content: fitting to
    // the nodes alone crops the lane headers off the left of the screen.
    let minX = 0; let minY = Infinity; let maxX = 0; let maxY = 0;
    for (const n of this.spec.nodes) {
      const r = rectOf(n);
      minX = Math.min(minX, r.x); minY = Math.min(minY, r.y);
      maxX = Math.max(maxX, r.x + r.w); maxY = Math.max(maxY, r.y + r.h);
    }
    for (const l of this.spec.lanes) {
      minY = Math.min(minY, l.y || 0);
      maxY = Math.max(maxY, (l.y || 0) + (l.height || 96));
    }
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
  }

  /** Keep the lane bands wide enough for the nodes sitting on them. */
  _growToFit() {
    const box = this._contentBox();
    const need = box.x + box.w + 80;
    if (!this.spec.width || need > this.spec.width) this.spec.width = Math.round(need);
    this.spec.height = Math.max(this.spec.height || 0, Math.round(box.y + box.h + 60));
  }

  /**
   * Fit to view, but never below the point where labels stop being readable.
   * A very wide flow at 30% is technically "fitted" and practically useless, so
   * below the floor we anchor the start of the flow and let the user pan.
   */
  fit() {
    const rect = this.svg.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const box = this._contentBox();
    const pad = 40;
    const MIN_READABLE = 0.3;
    const wanted = Math.min(
      (rect.width - pad * 2) / Math.max(box.w, 1),
      (rect.height - pad * 2) / Math.max(box.h, 1),
      1.2,
    );
    this.view.k = Math.max(wanted, MIN_READABLE);
    this.view.x = pad - box.x * this.view.k + Math.max(0, (rect.width - pad * 2 - box.w * this.view.k) / 2);
    this.view.y = pad - box.y * this.view.k + Math.max(0, (rect.height - pad * 2 - box.h * this.view.k) / 2);
    this._applyView();
    this.onViewChange?.();
  }

  zoomBy(factor, anchorClient = null) {
    const rect = this.svg.getBoundingClientRect();
    const ax = anchorClient ? anchorClient.x - rect.left : rect.width / 2;
    const ay = anchorClient ? anchorClient.y - rect.top : rect.height / 2;
    const wx = (ax - this.view.x) / this.view.k;
    const wy = (ay - this.view.y) / this.view.k;
    this.view.k = Math.max(0.15, Math.min(2.5, this.view.k * factor));
    this.view.x = ax - wx * this.view.k;
    this.view.y = ay - wy * this.view.k;
    this._applyView();
    this.onViewChange?.();
  }

  // ── Coordinate helpers ──────────────────────────────────────────────────

  toWorld(evt) {
    const rect = this.svg.getBoundingClientRect();
    return {
      x: (evt.clientX - rect.left - this.view.x) / this.view.k,
      y: (evt.clientY - rect.top - this.view.y) / this.view.k,
    };
  }

  nodeAt(pt) {
    for (let i = this.spec.nodes.length - 1; i >= 0; i--) {
      const n = this.spec.nodes[i];
      if (pointInRect(pt, rectOf(n))) return n;
    }
    return null;
  }

  // ── Events ──────────────────────────────────────────────────────────────

  _bind() {
    this.svg.addEventListener('pointerdown', (e) => this._onDown(e));
    this.svg.addEventListener('pointermove', (e) => this._onMove(e));
    this.svg.addEventListener('pointerup', (e) => this._onUp(e));
    this.svg.addEventListener('wheel', (e) => this._onWheel(e), { passive: false });
    this.svg.addEventListener('dblclick', (e) => this._onDouble(e));
    this.svg.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  _onWheel(e) {
    e.preventDefault();
    // ⌘/ctrl-wheel zooms at the cursor; plain wheel pans. Space-drag also pans.
    if (e.ctrlKey || e.metaKey) {
      this.zoomBy(e.deltaY < 0 ? 1.1 : 1 / 1.1, { x: e.clientX, y: e.clientY });
      return;
    }
    if (e.shiftKey) { this.view.x -= e.deltaY; this._applyView(); return; }
    this.view.y -= e.deltaY;
    this.view.x -= e.deltaX;
    this._applyView();
  }

  _onDown(e) {
    if (e.button === 1 || this.spaceHeld) {
      this._drag = { type: 'pan', start: { x: e.clientX, y: e.clientY }, origin: { ...this.view } };
      this.svg.setPointerCapture(e.pointerId);
      return;
    }
    if (e.button !== 0) return;

    const port = e.target.closest?.('.port');
    const nodeEl = e.target.closest?.('.node');
    const edgeEl = e.target.closest?.('.edge');

    if (port) {
      const from = port.getAttribute('data-node');
      this._drag = { type: 'connect', from, to: this.toWorld(e) };
      this.svg.setPointerCapture(e.pointerId);
      return;
    }

    if (nodeEl) {
      const id = nodeEl.getAttribute('data-node');
      if (e.shiftKey) { this.select([id], { additive: true }); return; }
      if (!this.selection.has(id)) this.select([id]);
      const start = this.toWorld(e);
      this._drag = {
        type: 'move',
        start,
        ids: [...this.selection],
        origin: new Map(this.spec.nodes.filter((n) => this.selection.has(n.id)).map((n) => [n.id, { x: n.x || 0, y: n.y || 0 }])),
        moved: false,
      };
      this.svg.setPointerCapture(e.pointerId);
      return;
    }

    if (edgeEl) {
      this.selectEdge(edgeEl.getAttribute('data-edge'));
      return;
    }

    // Empty canvas: marquee
    this._drag = { type: 'marquee', start: this.toWorld(e), additive: e.shiftKey };
    if (!e.shiftKey) this.clearSelection();
    this.svg.setPointerCapture(e.pointerId);
  }

  _onMove(e) {
    if (!this._drag) return;
    const d = this._drag;

    if (d.type === 'pan') {
      this.view.x = d.origin.x + (e.clientX - d.start.x);
      this.view.y = d.origin.y + (e.clientY - d.start.y);
      this._applyView();
      return;
    }

    if (d.type === 'connect') {
      const to = this.toWorld(e);
      const fromNode = this.spec.nodes.find((n) => n.id === d.from);
      if (!fromNode) return;
      const r = rectOf(fromNode);
      const sx = r.x + r.w;
      const sy = r.y + r.h / 2;
      const mid = (sx + to.x) / 2;
      this.gOverlay.innerHTML = `<path d="M ${sx} ${sy} C ${mid} ${sy}, ${mid} ${to.y}, ${to.x} ${to.y}" fill="none" stroke="#3b5bdb" stroke-width="2" stroke-dasharray="5 4"/>`;
      return;
    }

    if (d.type === 'move') {
      const pt = this.toWorld(e);
      const dx = pt.x - d.start.x;
      const dy = pt.y - d.start.y;
      if (!d.moved && Math.hypot(dx, dy) * this.view.k < 3) return;
      d.moved = true;
      for (const [id, origin] of d.origin) {
        const node = this.spec.nodes.find((n) => n.id === id);
        if (!node) continue;
        node.x = snap(origin.x + dx);
        node.y = snap(origin.y + dy);
        // Dropping onto another lane reassigns the actor.
        const lane = this.spec.lanes.find((l) => node.y + (node.h || 58) / 2 >= l.y && node.y + (node.h || 58) / 2 <= l.y + (l.height || 96));
        if (lane && lane.id !== node.lane) node.lane = lane.id;
        const el = this.gNodes.querySelector(`.node[data-node="${id}"]`);
        if (el) el.setAttribute('transform', `translate(${node.x},${node.y})`);
      }
      this.gEdges.innerHTML = '';
      return;
    }

    if (d.type === 'marquee') {
      const pt = this.toWorld(e);
      const box = {
        x: Math.min(d.start.x, pt.x), y: Math.min(d.start.y, pt.y),
        w: Math.abs(pt.x - d.start.x), h: Math.abs(pt.y - d.start.y),
      };
      this.gOverlay.innerHTML = `<rect x="${box.x}" y="${box.y}" width="${box.w}" height="${box.h}" fill="#3b5bdb" fill-opacity="0.06" stroke="#3b5bdb" stroke-width="1" stroke-dasharray="4 3"/>`;
      return;
    }
  }

  _onUp(e) {
    const d = this._drag;
    this._drag = null;
    if (!d) return;
    this.gOverlay.innerHTML = '';

    if (d.type === 'connect') {
      const pt = this.toWorld(e);
      const target = this.nodeAt(pt);
      if (target && target.id !== d.from) {
        this.addEdge(d.from, target.id, { fromPort: 'out' });
      }
      this.render();
      return;
    }

    if (d.type === 'move' && d.moved) {
      this._growToFit();
      this.commit('move');
      return;
    }

    if (d.type === 'marquee') {
      const pt = this.toWorld(e);
      const box = {
        x: Math.min(d.start.x, pt.x), y: Math.min(d.start.y, pt.y),
        w: Math.abs(pt.x - d.start.x), h: Math.abs(pt.y - d.start.y),
      };
      if (box.w > 6 && box.h > 6) {
        const hits = this.spec.nodes
          .filter((n) => {
            const r = rectOf(n);
            return r.x < box.x + box.w && r.x + r.w > box.x && r.y < box.y + box.h && r.y + r.h > box.y;
          })
          .map((n) => n.id);
        this.select(hits, { additive: d.additive });
      }
      this.render();
    }
  }

  _onDouble(e) {
    const nodeEl = e.target.closest?.('.node');
    if (!nodeEl) return;
    const id = nodeEl.getAttribute('data-node');
    const node = this.spec.nodes.find((n) => n.id === id);
    if (!node) return;
    this.onEditLabel(node, (next) => {
      if (next && next !== node.label) this.updateNode(id, { label: next });
    }, nodeEl);
  }

  /** Screen position of a node, for positioning the inline editor. */
  screenRectOf(n) {
    const r = rectOf(n);
    const box = this.svg.getBoundingClientRect();
    return {
      left: box.left + this.view.x + r.x * this.view.k,
      top: box.top + this.view.y + r.y * this.view.k,
      width: r.w * this.view.k,
      height: r.h * this.view.k,
    };
  }
}

export { nearestPort };
