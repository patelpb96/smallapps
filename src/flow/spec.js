/**
 * The diagram spec — the single intermediate representation.
 *
 * Everything (rule interpreter, LLM adapter, editor, layout, exporters) reads
 * and writes this shape. It is plain JSON on purpose: an LLM can emit it, a
 * human can hand-edit it, and the editor can round-trip it without loss.
 *
 *   {
 *     version: 1,
 *     title: "…",
 *     lanes:   [{ id, name, kind }],               kind: human | agent | system
 *     nodes:   [{ id, primitive, label, lane, x, y, w, h, props }],
 *     edges:   [{ id, from, to, kind, label, fromPort }],
 *     meta:    { source, interpreter }
 *   }
 *
 * Edges are node-to-node by id. `fromPort` is 'out' | 'true' | 'false' | 'error'
 * and only matters for branching primitives.
 */

import { getPrimitive, hasPrimitive } from './primitives.js';

export const SPEC_VERSION = 1;
export const EDGE_KINDS = ['sequence', 'branch', 'error', 'async', 'loop'];
export const LANE_KINDS = ['human', 'agent', 'system'];

const ID_SAFE = /^[a-z0-9][a-z0-9-]{0,62}$/;

export function emptySpec(title = 'Untitled workflow') {
  return {
    version: SPEC_VERSION,
    title,
    lanes: [],
    nodes: [],
    edges: [],
    meta: { source: '', interpreter: 'manual' },
  };
}

/** Deterministic id generator: prefix + next free integer. */
export function nextId(prefix, existing) {
  const used = new Set(existing);
  let i = 1;
  while (used.has(`${prefix}-${i}`)) i += 1;
  return `${prefix}-${i}`;
}

/** Slug used for lane ids derived from a name. */
export function slug(s) {
  const out = String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return out || 'lane';
}

/**
 * Coerce arbitrary input into a valid spec and report what had to change.
 *
 * This runs on everything that comes from outside — pasted JSON, an LLM
 * response, a file — so it has to be total: no input should throw.
 *
 * @returns {{ spec: object, issues: Array<{level: string, message: string}> }}
 */
export function normalizeSpec(raw) {
  const issues = [];
  const warn = (message) => issues.push({ level: 'warn', message });
  const bad = (message) => issues.push({ level: 'error', message });

  if (!raw || typeof raw !== 'object') {
    bad('spec is not an object');
    return { spec: emptySpec(), issues };
  }

  const spec = emptySpec(typeof raw.title === 'string' && raw.title.trim() ? raw.title.trim() : 'Untitled workflow');
  spec.meta.source = typeof raw.meta?.source === 'string' ? raw.meta.source : '';
  spec.meta.interpreter = typeof raw.meta?.interpreter === 'string' ? raw.meta.interpreter : 'imported';

  // ── Lanes ──
  const laneIds = new Set();
  const rawLanes = Array.isArray(raw.lanes) ? raw.lanes : [];
  for (const [i, l] of rawLanes.entries()) {
    if (!l || typeof l !== 'object') { warn(`lane ${i} is not an object, skipped`); continue; }
    let id = typeof l.id === 'string' && ID_SAFE.test(l.id) ? l.id : slug(l.name || l.id || `lane-${i + 1}`);
    if (laneIds.has(id)) id = `${id}-${i + 1}`;
    laneIds.add(id);
    const name = typeof l.name === 'string' && l.name.trim() ? l.name.trim() : id;
    const kind = LANE_KINDS.includes(l.kind) ? l.kind : 'system';
    spec.lanes.push({ id, name, kind });
  }
  if (!rawLanes.length) warn('no lanes declared');

  // ── Nodes ──
  const nodeIds = new Set();
  const rawNodes = Array.isArray(raw.nodes) ? raw.nodes : [];
  for (const [i, n] of rawNodes.entries()) {
    if (!n || typeof n !== 'object') { warn(`node ${i} is not an object, skipped`); continue; }
    let primitive = typeof n.primitive === 'string' ? n.primitive : 'llm';
    if (!hasPrimitive(primitive)) {
      warn(`node "${n.label || i}" used unknown primitive "${primitive}", coerced to llm`);
      primitive = 'llm';
    }
    let id = typeof n.id === 'string' && ID_SAFE.test(n.id) ? n.id : `n-${i + 1}`;
    if (nodeIds.has(id)) id = `n-${i + 1}-${nodeIds.size}`;
    nodeIds.add(id);

    let lane = typeof n.lane === 'string' ? n.lane : '';
    if (!laneIds.has(lane)) {
      if (laneIds.size) {
        warn(`node "${n.label || id}" referenced unknown lane "${lane}", moved to "${spec.lanes[0].id}"`);
        lane = spec.lanes[0].id;
      } else {
        // A spec with nodes but no lanes still has to render.
        const implied = { id: 'main', name: 'Workflow', kind: 'system' };
        spec.lanes.push(implied);
        laneIds.add(implied.id);
        lane = 'main';
      }
    }

    const node = {
      id,
      primitive,
      label: typeof n.label === 'string' && n.label.trim() ? n.label.trim().slice(0, 120) : getPrimitive(primitive).label,
      lane,
      props: sanitizeProps(n.props),
    };
    for (const k of ['x', 'y', 'w', 'h']) {
      if (Number.isFinite(n[k])) node[k] = Math.round(n[k]);
    }
    spec.nodes.push(node);
  }

  // ── Edges ──
  const edgeIds = new Set();
  const seen = new Set();
  const rawEdges = Array.isArray(raw.edges) ? raw.edges : [];
  for (const [i, e] of rawEdges.entries()) {
    if (!e || typeof e !== 'object') { warn(`edge ${i} is not an object, skipped`); continue; }
    const from = typeof e.from === 'string' ? e.from : e.from?.node;
    const to = typeof e.to === 'string' ? e.to : e.to?.node;
    if (!nodeIds.has(from) || !nodeIds.has(to)) {
      warn(`edge ${from} → ${to} points at a node that does not exist, dropped`);
      continue;
    }
    if (from === to) { warn(`edge ${from} → ${to} is a self-loop, dropped`); continue; }
    const key = `${from}→${to}→${e.fromPort || 'out'}`;
    if (seen.has(key)) { warn(`duplicate edge ${key} dropped`); continue; }
    seen.add(key);

    let id = typeof e.id === 'string' && ID_SAFE.test(e.id) ? e.id : `e-${i + 1}`;
    if (edgeIds.has(id)) id = `e-${i + 1}-${edgeIds.size}`;
    edgeIds.add(id);

    spec.edges.push({
      id,
      from,
      to,
      kind: EDGE_KINDS.includes(e.kind) ? e.kind : 'sequence',
      label: typeof e.label === 'string' ? e.label.slice(0, 60) : '',
      fromPort: ['out', 'true', 'false', 'error'].includes(e.fromPort) ? e.fromPort : 'out',
    });
  }

  // An implicit single unreachable node is fine; an empty spec is fine.
  if (!spec.nodes.length) warn('spec contains no nodes');

  return { spec, issues };
}

function sanitizeProps(props) {
  const out = {};
  if (!props || typeof props !== 'object' || Array.isArray(props)) return out;
  for (const [k, v] of Object.entries(props)) {
    if (typeof k !== 'string' || k.length > 40) continue;
    if (typeof v === 'string') out[k] = v.slice(0, 400);
    else if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
    else if (typeof v === 'boolean') out[k] = v;
  }
  return out;
}

/** Structural checks used by the editor's health indicator. */
export function validateSpec(spec) {
  const problems = [];
  if (!spec || typeof spec !== 'object') return ['spec is not an object'];
  if (!Array.isArray(spec.nodes)) problems.push('nodes must be an array');
  if (!Array.isArray(spec.edges)) problems.push('edges must be an array');
  if (!Array.isArray(spec.lanes)) problems.push('lanes must be an array');
  if (problems.length) return problems;

  const ids = new Set();
  for (const n of spec.nodes) {
    if (ids.has(n.id)) problems.push(`duplicate node id "${n.id}"`);
    ids.add(n.id);
    if (!hasPrimitive(n.primitive)) problems.push(`node "${n.id}" has unknown primitive`);
  }
  for (const e of spec.edges) {
    if (!ids.has(e.from)) problems.push(`edge "${e.id}" has a missing source`);
    if (!ids.has(e.to)) problems.push(`edge "${e.id}" has a missing target`);
    if (e.from === e.to) problems.push(`edge "${e.id}" is a self-loop`);
  }
  return problems;
}

export function nodeById(spec) {
  return new Map(spec.nodes.map((n) => [n.id, n]));
}

export function cloneSpec(spec) {
  return JSON.parse(JSON.stringify(spec));
}

/** Cheap structural fingerprint, used for undo de-duplication. */
export function specHash(spec) {
  return JSON.stringify({ t: spec.title, l: spec.lanes, n: spec.nodes, e: spec.edges });
}
