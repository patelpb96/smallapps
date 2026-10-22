/**
 * Bundles: a tree of flows.
 *
 * A single spec describes one diagram. A *bundle* is the thing a harness
 * actually has: a system-level flow whose nodes are agents, some of which are
 * themselves harnesses with a flow inside them.
 *
 *   {
 *     version: 1,
 *     root: "system",
 *     flows: { system: <spec>, "agent:triage": <spec>, … },
 *     meta: { session, workspace, project }
 *   }
 *
 * Containment is expressed on the node, not in the envelope: `node.subflow`
 * names another flow in the same bundle. That keeps a lone spec a valid bundle
 * (with one flow), so nothing that already stores a single diagram has to
 * change, and drill-down is a lookup rather than a new document type.
 *
 *   spec ── node.subflow ──▶ flow ── node.subflow ──▶ flow …
 *
 * The system level is the default view. Intra-agent flows exist to be collapsed;
 * see `breadcrumb()` and `path()`.
 */

import { normalizeSpec, emptySpec, cloneSpec } from './spec.js';

export const BUNDLE_VERSION = 1;
export const ROOT_FLOW = 'system';

/** Wrap a single spec so it can be treated as a one-flow bundle. */
export function bundleFromSpec(spec, meta = {}) {
  return {
    version: BUNDLE_VERSION,
    id: meta.id || 'default',
    root: ROOT_FLOW,
    flows: { [ROOT_FLOW]: cloneSpec(spec) },
    meta: { session: '', workspace: '', project: '', updatedAt: '', ...meta },
  };
}

/**
 * Coerce anything into a valid bundle. Total: no input throws.
 * @returns {{ bundle: object, issues: Array<{level:string,message:string}> }}
 */
export function normalizeBundle(raw) {
  const issues = [];
  const warn = (message) => issues.push({ level: 'warn', message });

  if (!raw || typeof raw !== 'object') {
    warn('bundle is not an object');
    return { bundle: bundleFromSpec(emptySpec()), issues };
  }

  // A bare spec is a valid input: someone saved a single diagram, or a host has
  // not learned about nesting yet.
  if (Array.isArray(raw.nodes) && !raw.flows) {
    const { spec, issues: specIssues } = normalizeSpec(raw);
    return { bundle: bundleFromSpec(spec, raw.meta || {}), issues: specIssues };
  }

  const meta = {
    session: str(raw.meta?.session),
    workspace: str(raw.meta?.workspace),
    project: str(raw.meta?.project),
    updatedAt: str(raw.meta?.updatedAt),
  };

  const flows = {};
  const source = raw.flows && typeof raw.flows === 'object' ? raw.flows : {};
  for (const [id, value] of Object.entries(source)) {
    const key = safeId(id);
    if (!key) { warn(`flow id "${id}" is not usable, skipped`); continue; }
    const { spec, issues: specIssues } = normalizeSpec(value);
    flows[key] = spec;
    for (const i of specIssues) issues.push({ level: i.level, message: `[${key}] ${i.message}` });
  }

  if (!Object.keys(flows).length) {
    warn('bundle contained no usable flows');
    flows[ROOT_FLOW] = emptySpec();
  }

  const root = typeof raw.root === 'string' && flows[safeId(raw.root)] ? safeId(raw.root) : Object.keys(flows)[0];

  const bundle = { version: BUNDLE_VERSION, id: str(raw.id) || 'default', root, flows, meta };

  // Every subflow reference must resolve, or drill-down dies at runtime.
  for (const [flowId, spec] of Object.entries(flows)) {
    for (const node of spec.nodes) {
      if (!node.subflow) continue;
      const target = safeId(node.subflow);
      if (!flows[target]) {
        warn(`flow "${flowId}" node "${node.id}" points at missing flow "${node.subflow}"`);
        delete node.subflow;
      } else {
        node.subflow = target;
      }
    }
  }

  return { bundle, issues };
}

/**
 * Merge live status onto a flow for rendering. Never mutates the input, because
 * the spec is the user's document and status is someone else's opinion.
 *
 * @param {object} spec
 * @param {object} pool  see status.js
 * @returns {{ spec: object, unknown: string[] }}
 */
export function withStatus(spec, pool, flowId) {
  const out = cloneSpec(spec);
  const unknown = [];
  const seen = new Set();
  const nodes = pool?.nodes || {};

  for (const node of out.nodes) {
    const entry = nodes[`${flowId}/${node.id}`] || nodes[node.id];
    if (!entry) continue;
    seen.add(`${flowId}/${node.id}`);
    seen.add(node.id);
    node.status = entry;
  }

  for (const key of Object.keys(nodes)) {
    if (seen.has(key)) continue;
    // Keys scoped to another flow are not unknown, they are simply not ours.
    if (key.includes('/') && !key.startsWith(`${flowId}/`)) continue;
    unknown.push(key);
  }

  return { spec: out, unknown };
}

/** The parent of a flow, or null for the root. Derived, so it cannot drift. */
export function parentOf(bundle, flowId) {
  for (const [id, spec] of Object.entries(bundle.flows)) {
    if (spec.nodes.some((n) => n.subflow === flowId)) return id;
  }
  return null;
}

/** Root → flow breadcrumb, for the "you are here" affordance. */
export function breadcrumb(bundle, flowId) {
  const trail = [flowId];
  let current = flowId;
  const guard = new Set([current]);
  while (true) {
    const parent = parentOf(bundle, current);
    if (!parent || guard.has(parent)) break;
    trail.unshift(parent);
    guard.add(parent);
    current = parent;
  }
  return trail.map((id) => ({ id, title: bundle.flows[id]?.title || id }));
}

/** How many flows sit under a flow, recursively. Used for the badge count. */
export function descendantCount(bundle, flowId, guard = new Set()) {
  if (guard.has(flowId)) return 0;
  guard.add(flowId);
  const spec = bundle.flows[flowId];
  if (!spec) return 0;
  let total = 0;
  for (const node of spec.nodes) {
    if (!node.subflow) continue;
    total += 1 + descendantCount(bundle, node.subflow, guard);
  }
  return total;
}

// ── helpers ────────────────────────────────────────────────────────────────

const str = (v) => (typeof v === 'string' ? v : '');

/** Flow ids travel in URLs and in status keys, so they stay boring. */
function safeId(v) {
  const raw = String(v ?? '').trim();
  if (!raw) return '';
  return raw.replace(/[^A-Za-z0-9._:-]+/g, '-').slice(0, 64);
}
