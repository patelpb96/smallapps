/**
 * Structural hazards.
 *
 * This is where the diagram meets the standards. The checks here are the subset
 * of the agent-plan heuristics that can be read off a graph — you cannot see a
 * budget from a flowchart, but you can see whether an irreversible action has
 * an approval upstream, and whether untrusted input has a path to an outbound
 * channel.
 *
 * Every flag names the nodes involved so the editor can highlight them, and
 * cites the same sources the planner uses.
 */

import { getPrimitive, EFFECT_LABELS } from './primitives.js';
import { nodeById } from './spec.js';

const SEV_ORDER = { critical: 0, high: 1, medium: 2, note: 3 };

function graph(spec) {
  const nodes = nodeById(spec);
  const out = new Map([...nodes.keys()].map((id) => [id, []]));
  const inc = new Map([...nodes.keys()].map((id) => [id, []]));
  for (const e of spec.edges) {
    if (!nodes.has(e.from) || !nodes.has(e.to)) continue;
    out.get(e.from).push(e);
    inc.get(e.to).push(e);
  }
  return { nodes, out, inc };
}

function reachable(startId, out, edgesOf) {
  const seen = new Set();
  const queue = [startId];
  const trail = new Map();
  while (queue.length) {
    const id = queue.shift();
    for (const e of edgesOf(id) || []) {
      const next = e.from === id ? e.to : e.from;
      if (seen.has(next) || next === startId) continue;
      seen.add(next);
      trail.set(next, id);
      queue.push(next);
    }
  }
  return { seen, trail };
}

function pathTo(startId, targetId, trail) {
  const path = [targetId];
  let cur = targetId;
  while (cur !== startId) {
    cur = trail.get(cur);
    if (cur === undefined) return [startId, targetId];
    path.unshift(cur);
  }
  return path;
}

const hasEffect = (node, effect) => getPrimitive(node.primitive).effects.includes(effect);

export function analyze(spec) {
  const { nodes, out, inc } = graph(spec);
  const flags = [];
  const push = (f) => flags.push(f);

  const untrusted = spec.nodes.filter((n) => hasEffect(n, 'untrusted-input'));
  const sensitive = spec.nodes.filter((n) => hasEffect(n, 'sensitive-read'));
  const egress = spec.nodes.filter((n) => hasEffect(n, 'external-egress'));
  const irreversible = spec.nodes.filter((n) => hasEffect(n, 'irreversible'));

  // ── 1. Lethal trifecta ──
  // Untrusted content has a path to an outbound channel, and the same agent can
  // also read private data. That is the combination, not any single node.
  for (const u of untrusted) {
    const { seen, trail } = reachable(u.id, out, (id) => out.get(id));
    const reachableEgress = egress.filter((e) => seen.has(e.id));
    if (!reachableEgress.length) continue;
    const reachableSensitive = sensitive.filter((s) => seen.has(s.id) || s.id === u.id);
    if (!reachableSensitive.length) continue;

    const target = reachableEgress[0];
    const path = pathTo(u.id, target.id, trail);
    push({
      id: 'trifecta',
      severity: 'critical',
      title: 'Lethal trifecta: untrusted input reaches an outbound channel',
      detail:
        `"${u.label}" can carry injected text to "${target.label}"` +
        (reachableSensitive.length ? `, and the same flow reads private data ("${reachableSensitive[0].label}")` : '') +
        '. Any two legs are defensible; three is a design bug. Break one: strip egress to an allowlist, split the untrusted step into a context with no private data, or insert a human release before the outbound node.',
      nodes: [...new Set([...path, ...reachableSensitive.map((s) => s.id)])],
      sources: ['lethal-trifecta', 'aws-four-principles'],
    });
    break;
  }

  // ── 2. Irreversible without an upstream gate ──
  for (const node of irreversible) {
    const { seen } = reachable(node.id, inc, (id) => inc.get(id));
    const gated = [...seen].some((id) => {
      const n = nodes.get(id);
      return n && (n.primitive === 'approval' || n.primitive === 'review');
    });
    if (gated) continue;
    push({
      id: 'irreversible-ungated',
      severity: 'critical',
      title: `Irreversible step with no approval upstream: "${node.label}"`,
      detail:
        'Nothing between the start and this node asks a human. The check a reviewer will ask for is not "did you test it" but "what stops this at 3am". Bind an approval to the exact action (actor + tool + target + parameters) and consume it atomically at execution.',
      nodes: [node.id],
      sources: ['owasp-aisvs-c09', 'owasp-agent-cheatsheet'],
    });
  }

  // ── 3. Cycle with no bound ──
  const cycles = findCycles(spec);
  for (const cycle of cycles) {
    const bounded = cycle.some((id) => {
      const n = nodes.get(id);
      if (!n) return false;
      const p = n.props || {};
      return n.primitive === 'loop' || n.primitive === 'wait'
        || Boolean(p.max) || Boolean(p.until) || Boolean(p.budget);
    });
    if (bounded) continue;
    push({
      id: 'unbounded-loop',
      severity: 'high',
      title: 'Loop with no exit condition or budget',
      detail:
        `Nodes ${cycle.map((id) => `"${nodes.get(id)?.label || id}"`).join(' → ')} form a cycle and no node in it declares a maximum or a terminal condition. Cap iterations, tokens and spend in the runtime, not in the prompt.`,
      nodes: cycle,
      sources: ['owasp-aisvs-c09', 'agent-eval-survey'],
    });
  }

  // ── 4. Side effects with no failure path ──
  const sideEffect = spec.nodes.filter((n) => hasEffect(n, 'mutates-state') || hasEffect(n, 'external-egress') || hasEffect(n, 'exec-code'));
  const noErrorPath = sideEffect.filter((n) => {
    const { seen } = reachable(n.id, out, (id) => out.get(id));
    const hasErrorEdge = out.get(n.id).some((e) => e.kind === 'error');
    const downError = [...seen].some((id) => nodes.get(id)?.primitive === 'error');
    return !hasErrorEdge && !downError;
  });
  if (noErrorPath.length) {
    // A diagram with no failure handling at all is a real finding. One that
    // handles failure somewhere but not everywhere is a note — flagging both at
    // the same severity trains people to ignore the panel.
    const handlesAnyFailure = spec.nodes.some((n) => n.primitive === 'error' || n.primitive === 'escalate');
    push({
      id: 'no-error-path',
      severity: handlesAnyFailure ? 'note' : 'medium',
      title: handlesAnyFailure
        ? `${noErrorPath.length} side-effecting step${noErrorPath.length > 1 ? 's' : ''} bypasses the error path`
        : `No failure path for ${noErrorPath.length} side-effecting step${noErrorPath.length > 1 ? 's' : ''}`,
      detail:
        `Nothing handles a failure from ${noErrorPath.map((n) => `"${n.label}"`).join(', ')}. A timeout plus a bounded retry and a terminal state the agent can reason about — otherwise one hung dependency silently eats the run budget.`
        + (handlesAnyFailure ? ' The flow has error handling elsewhere; route these into it.' : ''),
      nodes: noErrorPath.map((n) => n.id),
      sources: ['mcp-spec', 'owasp-aisvs-c09'],
    });
  }

  // ── 5. Approval fatigue ──
  const gates = spec.nodes.filter((n) => n.primitive === 'approval' || n.primitive === 'review' || n.primitive === 'human-task');
  if (gates.length > 3) {
    push({
      id: 'approval-fatigue',
      severity: 'medium',
      title: `${gates.length} human checkpoints in one flow`,
      detail:
        'Above roughly 20 review points per person per day, approval becomes a reflex and the control inverts. Tier it instead: read-only proceeds, reversible notifies, irreversible needs approval, money or entitlements needs step-up auth. In a diagram, that usually means three gates collapse into one risk-routed gate.',
      nodes: gates.map((n) => n.id),
      sources: ['humans-out-of-loop', 'owasp-agent-cheatsheet'],
    });
  }

  // ── 6. Code execution without a declared isolation boundary ──
  for (const node of spec.nodes.filter((n) => hasEffect(n, 'exec-code'))) {
    const isolation = String(node.props?.isolation || '').toLowerCase();
    const firstWord = isolation.split(/[^a-z]/)[0];
    const weak = !isolation || ['none', 'host', 'bare', 'process', 'unconfined', 'user'].includes(firstWord);
    if (!weak) continue;
    push({
      id: 'sandbox-floor',
      severity: 'high',
      title: `"${node.label}" executes code without an isolation boundary`,
      detail:
        'Frontier models get out of misconfigured containers reliably, so the boundary has to be named. Set the isolation property to container, microVM or dedicated host — and if credentials are reachable from inside, the container is packaging and the hypervisor is the boundary.',
      nodes: [node.id],
      sources: ['sandbox-escape-bench', 'google-secure-agents'],
    });
  }

  // ── 7. Orphans and dead ends ──
  const orphans = spec.nodes.filter((n) => !out.get(n.id).length && !inc.get(n.id).length && spec.nodes.length > 1);
  if (orphans.length) {
    push({
      id: 'orphans',
      severity: 'note',
      title: `${orphans.length} node${orphans.length > 1 ? 's' : ''} not connected to anything`,
      detail: `${orphans.map((n) => `"${n.label}"`).join(', ')} — either wire them up or delete them; an unreachable step is a plan nobody will implement.`,
      nodes: orphans.map((n) => n.id),
      sources: [],
    });
  }

  const dangling = spec.nodes.filter((n) => out.get(n.id).length && !inc.get(n.id).length && n.primitive !== 'trigger-manual' && n.primitive !== 'trigger-event' && n.primitive !== 'trigger-schedule' && n.primitive !== 'trigger-message');
  if (dangling.length && spec.nodes.length > 2) {
    push({
      id: 'no-entry',
      severity: 'note',
      title: 'Flow has no explicit trigger',
      detail: `${dangling.map((n) => `"${n.label}"`).join(', ')} start from nowhere. Add a trigger so the reader knows what fires this.`,
      nodes: dangling.map((n) => n.id),
      sources: ['anthropic-effective-agents'],
    });
  }

  flags.sort((a, b) => SEV_ORDER[a.severity] - SEV_ORDER[b.severity]);
  return {
    flags,
    counts: {
      critical: flags.filter((f) => f.severity === 'critical').length,
      high: flags.filter((f) => f.severity === 'high').length,
      medium: flags.filter((f) => f.severity === 'medium').length,
      note: flags.filter((f) => f.severity === 'note').length,
    },
    effects: {
      untrusted: untrusted.length,
      sensitive: sensitive.length,
      egress: egress.length,
      irreversible: irreversible.length,
    },
  };
}

/**
 * Enumerate simple cycles (bounded) so the UI can point at them.
 * Johnson-lite: DFS from each node, stop at a depth cap.
 */
export function findCycles(spec, maxCycles = 6, maxDepth = 12) {
  const nodes = nodeById(spec);
  const out = new Map([...nodes.keys()].map((id) => [id, []]));
  for (const e of spec.edges) if (out.has(e.from) && out.has(e.to)) out.get(e.from).push(e.to);

  const found = [];
  const seenKeys = new Set();
  const order = spec.nodes.map((n) => n.id);

  const dfs = (start, current, path, depth) => {
    if (found.length >= maxCycles || depth > maxDepth) return;
    for (const next of out.get(current) || []) {
      if (next === start && path.length > 1) {
        const key = [...path].sort().join('|');
        if (!seenKeys.has(key)) { seenKeys.add(key); found.push([...path]); }
        continue;
      }
      if (path.includes(next)) continue;
      if (order.indexOf(next) < order.indexOf(start)) continue; // canonical start
      dfs(start, next, [...path, next], depth + 1);
    }
  };

  for (const id of order) dfs(id, id, [id], 0);
  return found;
}

export function effectList(node) {
  return getPrimitive(node.primitive).effects.map((e) => EFFECT_LABELS[e] || e);
}
