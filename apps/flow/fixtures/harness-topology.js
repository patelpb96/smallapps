/**
 * A worked example of what a harness hands Flow.
 *
 * Nothing here is Flow-specific: it is the shape a meta harness already has —
 * a session with an orchestrator, worker agents, and infrastructure. Node ids
 * are stable strings because the harness has to be able to say "this agent is
 * now running" without knowing anything about layout.
 *
 * `system` is the view a meta harness should show: agents and what they hand to
 * each other. The three `agent:*` flows are what those agents do internally, and
 * are only there to be drilled into.
 *
 * Used by:
 *   apps/flow/embed.html          (in-process MemoryPort)
 *   scripts/flow-api-server.js    (the six HTTP endpoints)
 */

const lane = (id, name, kind) => ({ id, name, kind });
const node = (id, primitive, label, laneId, props = {}) => ({ id, primitive, label, lane: laneId, props });
const edge = (from, to, extra = {}) => ({ from, to, kind: 'sequence', label: '', fromPort: 'out', ...extra });

const flow = (title, lanes, nodes, edges) => ({
  version: 1,
  title,
  lanes,
  nodes,
  edges: edges.map((e, i) => ({ id: `e${i + 1}`, ...e })),
});

// ── System level: the view a meta harness should default to ────────────────
const system = flow(
  'Session topology — meta harness',
  [
    lane('human', 'Operator', 'human'),
    lane('orch', 'Orchestrator', 'agent'),
    lane('agents', 'Worker agents', 'agent'),
    lane('infra', 'Tools and services', 'system'),
  ],
  [
    node('h0', 'trigger-manual', 'Operator starts a session', 'human'),
    node('o1', 'agent', 'Planner (CTO)', 'orch', { budget: 'no tools', subflowNote: 'plans, never executes' }),
    node('o2', 'decision', 'Plan accepted?', 'orch'),
    node('a1', 'agent', 'Research worker', 'agents'),
    node('a2', 'agent', 'Builder worker', 'agents'),
    node('a3', 'decision', 'Verification passes?', 'agents'),
    node('t1', 'tool-exec', 'Sandboxed test run', 'infra', { isolation: 'container' }),
    node('t2', 'tool-write', 'Record artifacts', 'infra'),
    node('t3', 'notify', 'Hand off to next session', 'infra'),
    node('e0', 'end', 'Session closed', 'infra'),
  ],
  [
    edge('h0', 'o1'),
    edge('o1', 'o2'),
    edge('o2', 'a1', { fromPort: 'true', label: 'yes' }),
    edge('o2', 'o1', { fromPort: 'false', label: 'no', kind: 'loop' }),
    edge('a1', 'a2'),
    edge('a2', 'a3'),
    edge('a3', 't1', { fromPort: 'true', label: 'yes' }),
    edge('a3', 'a2', { fromPort: 'false', label: 'no', kind: 'loop' }),
    edge('t1', 't2'),
    edge('t2', 't3'),
    edge('t3', 'e0'),
  ],
);
// Containment lives on the node, so a level only has to know its own children.
system.nodes.find((n) => n.id === 'o1').subflow = 'agent:planner';
system.nodes.find((n) => n.id === 'a1').subflow = 'agent:research';
system.nodes.find((n) => n.id === 'a2').subflow = 'agent:builder';

// ── Intra-agent: only visible when you drill in ────────────────────────────
const planner = flow(
  'Planner (CTO) — internal loop',
  [lane('p', 'Planning', 'agent'), lane('r', 'Review', 'agent'), lane('g', 'Gate', 'system')],
  [
    node('p0', 'trigger-event', 'Brief received', 'p'),
    node('p1', 'tool-read', 'Load state and constraints', 'p'),
    node('p2', 'llm', 'Propose the next step', 'p'),
    node('p3', 'decision', 'Confident enough?', 'r'),
    node('p4', 'llm', 'Name what would make it wrong', 'r'),
    node('p5', 'subprocess', 'Emit strict JSON', 'g'),
    node('p6', 'escalate', 'Ask the human', 'g'),
    node('p7', 'end', 'Plan returned', 'g'),
  ],
  [
    edge('p0', 'p1'),
    edge('p1', 'p2'),
    edge('p2', 'p3'),
    edge('p3', 'p4', { fromPort: 'false', label: 'no' }),
    edge('p3', 'p5', { fromPort: 'true', label: 'yes' }),
    edge('p4', 'p2', { kind: 'loop', label: 'refine' }),
    edge('p5', 'p7'),
    edge('p3', 'p6', { fromPort: 'false', label: 'blocked' }),
    edge('p6', 'p7'),
  ],
);

const research = flow(
  'Research worker — internal loop',
  [lane('c', 'Context', 'agent'), lane('t', 'Tools', 'system')],
  [
    node('r0', 'trigger-event', 'Task received', 'c'),
    node('r1', 'tool-search', 'Search sources', 't'),
    node('r2', 'tool-read', 'Fetch and read pages', 't'),
    node('r3', 'extract', 'Extract claims + citations', 'c'),
    node('r4', 'summarize', 'Summarise with sources', 'c'),
    node('r5', 'end', 'Report returned', 'c'),
  ],
  [
    edge('r0', 'r1'),
    edge('r1', 'r2'),
    edge('r2', 'r3'),
    edge('r3', 'r4'),
    edge('r4', 'r5'),
  ],
);

const builder = flow(
  'Builder worker — internal loop',
  [lane('c', 'Context', 'agent'), lane('t', 'Sandbox', 'system')],
  [
    node('b0', 'trigger-event', 'Patch request', 'c'),
    node('b1', 'tool-read', 'Read the files in scope', 'c'),
    node('b2', 'tool-write', 'Apply the patch', 'c'),
    node('b3', 'tool-exec', 'Run the tests', 't', { isolation: 'microVM' }),
    node('b4', 'decision', 'Green?', 't'),
    node('b5', 'error', 'Report failure with output', 'c'),
    node('b6', 'end', 'Report success', 'c'),
  ],
  [
    edge('b0', 'b1'),
    edge('b1', 'b2'),
    edge('b2', 'b3'),
    edge('b3', 'b4'),
    edge('b4', 'b6', { fromPort: 'true', label: 'yes' }),
    edge('b4', 'b5', { fromPort: 'false', label: 'no' }),
    edge('b5', 'b2', { kind: 'loop', label: 'retry' }),
  ],
);

/** The bundle a host would return from GET /v1/flow/bundle. */
export const HARNESS_BUNDLE = {
  version: 1,
  id: 'demo-session',
  root: 'system',
  flows: {
    system,
    'agent:planner': planner,
    'agent:research': research,
    'agent:builder': builder,
  },
  meta: {
    session: 'demo-session',
    workspace: 'agent-workbench',
    project: 'demo',
    updatedAt: '2026-10-22T00:00:00Z',
  },
};

/**
 * A scripted harness. Each tick is a status delta keyed `flow/node`, exactly as
 * a real one would publish them — the demo is only interesting if it exercises
 * the same path production would.
 */
export const STATUS_SCRIPT = [
  { 'system/h0': { status: 'done' }, 'system/o1': { status: 'running' } },
  { 'system/o1': { status: 'done', metrics: { tokens: 1200, cost: 0.012, ms: 2400 } }, 'system/o2': { status: 'running' } },
  { 'system/o2': { status: 'done' }, 'system/a1': { status: 'running' }, 'agent:research/r1': { status: 'running' } },
  { 'agent:research/r1': { status: 'done' }, 'agent:research/r2': { status: 'running' } },
  { 'agent:research/r2': { status: 'done' }, 'agent:research/r3': { status: 'running' } },
  { 'agent:research/r3': { status: 'done' }, 'agent:research/r4': { status: 'running' } },
  { 'agent:research/r4': { status: 'done' }, 'agent:research/r5': { status: 'done' }, 'system/a1': { status: 'done' } },
  { 'system/a2': { status: 'running' }, 'agent:builder/b1': { status: 'running' } },
  { 'agent:builder/b1': { status: 'done' }, 'agent:builder/b2': { status: 'running' } },
  { 'agent:builder/b2': { status: 'done' }, 'agent:builder/b3': { status: 'running' } },
  { 'agent:builder/b3': { status: 'blocked', error: 'test suite timed out after 900s' } },
  { 'agent:builder/b3': { status: 'done' }, 'agent:builder/b4': { status: 'running' } },
  { 'agent:builder/b4': { status: 'done' }, 'agent:builder/b6': { status: 'done' }, 'system/a2': { status: 'done' } },
  { 'system/a3': { status: 'running' } },
  { 'system/a3': { status: 'done' }, 'system/t1': { status: 'running' } },
  { 'system/t1': { status: 'done' }, 'system/t2': { status: 'running' } },
  { 'system/t2': { status: 'done' }, 'system/t3': { status: 'running' } },
  { 'system/t3': { status: 'done' }, 'system/e0': { status: 'done' } },
];

/** Fold the script into the status pool a server would hold at `cursor`. */
export function poolAtCursor(cursor) {
  const nodes = {};
  for (let i = 0; i < Math.min(cursor, STATUS_SCRIPT.length); i++) {
    for (const [key, value] of Object.entries(STATUS_SCRIPT[i])) nodes[key] = { ...nodes[key], ...value };
  }
  return { version: 1, cursor, updatedAt: new Date().toISOString(), nodes, flows: {} };
}
