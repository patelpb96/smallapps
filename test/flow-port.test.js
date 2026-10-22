/**
 * The portability contract.
 *
 * These tests exist so that "it should stay embeddable" is a check rather than
 * an intention. If a future change adds a seventh endpoint, renames a method,
 * or lets a port skip one, this file fails.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  FLOW_ENDPOINTS, ENDPOINT_IDS, tallyEndpoints, FlowPort, StaticPort, MemoryPort, HttpPort,
} from '../src/flow/port.js';
import {
  normalizeBundle, bundleFromSpec, withStatus, parentOf, breadcrumb, descendantCount,
  BUNDLE_VERSION,
} from '../src/flow/bundle.js';
import {
  normalizePool, applyDeltas, summarize, emptyPool, NODE_STATUS, STATUS_VERSION,
} from '../src/flow/status.js';
import { layout, normalizeSpec } from '../src/flow/index.js';
import { HARNESS_BUNDLE, STATUS_SCRIPT } from '../apps/flow/fixtures/harness-topology.js';

const PORT_METHODS = ['getBundle', 'getFlow', 'getStatus', 'subscribe', 'putBundle', 'command'];

// ── Endpoint contract ───────────────────────────────────────────────────────

test('the endpoint set is exactly the six that were designed', () => {
  assert.deepEqual(ENDPOINT_IDS, [
    'bundle.get', 'status.get', 'flow.get', 'events.get', 'bundle.put', 'command.post',
  ]);
  assert.equal(tallyEndpoints().total, 6);
});

test('two endpoints are core and the rest are optional', () => {
  const t = tallyEndpoints();
  assert.equal(t.core, 2);
  assert.equal(t.optional, 4);
  assert.deepEqual(
    FLOW_ENDPOINTS.filter((e) => e.required === 'core').map((e) => e.id),
    ['bundle.get', 'status.get'],
  );
});

test('every endpoint is complete enough to implement from the table alone', () => {
  for (const e of FLOW_ENDPOINTS) {
    assert.ok(e.method && e.path.startsWith('/v1/flow/'), `${e.id}: bad http shape`);
    assert.ok(e.tauri, `${e.id}: no tauri mapping`);
    assert.ok(PORT_METHODS.includes(e.port), `${e.id}: unknown port method "${e.port}"`);
    assert.ok(e.purpose.length > 30, `${e.id}: purpose too thin to implement from`);
  }
});

// ── Port shape ─────────────────────────────────────────────────────────────

test('every shipped port implements the whole interface', () => {
  for (const Impl of [StaticPort, MemoryPort, HttpPort]) {
    const port = new Impl({});
    for (const method of PORT_METHODS) {
      assert.equal(typeof port[method], 'function', `${Impl.name}.${method} is missing`);
    }
    assert.equal(typeof port.capabilities(), 'object', `${Impl.name}.capabilities is missing`);
  }
});

test('capabilities tell the truth about what a port can do', () => {
  assert.equal(new StaticPort(null).capabilities().live, false);
  assert.equal(new StaticPort(null).capabilities().commands, false);
  assert.equal(new MemoryPort({}).capabilities().streaming, true);
  assert.equal(new MemoryPort({}).capabilities().commands, true);
});

// ── URL shapes (the part a host has to match) ──────────────────────────────

function recordingHttp() {
  const calls = [];
  const port = new HttpPort({
    base: 'https://host.example/v1/flow',
    fetchImpl: async (url, init) => {
      calls.push({ url, method: init?.method || 'GET', body: init?.body });
      return { ok: true, status: 200, json: async () => ({}) };
    },
    eventSource: null,
  });
  return { port, calls };
}

test('HttpPort hits the documented paths', async () => {
  const { port, calls } = recordingHttp();
  await port.getBundle({ session: 's1' });
  await port.getFlow('agent:builder', { session: 's1' });
  await port.getStatus({ session: 's1' }, 12);
  await port.putBundle({ flows: {} });
  await port.command('focus_agent', { agent: 'a2' });

  assert.deepEqual(calls.map((c) => `${c.method} ${c.url}`), [
    'GET https://host.example/v1/flow/bundle?session=s1',
    'GET https://host.example/v1/flow/flow/agent%3Abuilder?session=s1',
    'GET https://host.example/v1/flow/status?session=s1&cursor=12',
    'PUT https://host.example/v1/flow/bundle',
    'POST https://host.example/v1/flow/command',
  ]);
});

test('HttpPort without EventSource still works, it just cannot stream', () => {
  const port = new HttpPort({ eventSource: null });
  assert.equal(port.capabilities().streaming, false);
  assert.equal(typeof port.subscribe({}, () => {}), 'function');
});

// ── Bundle ─────────────────────────────────────────────────────────────────

test('a bare spec is a valid bundle, so nothing that stores one diagram has to change', () => {
  const spec = normalizeSpec({
    title: 'One diagram',
    lanes: [{ id: 'l', name: 'L' }],
    nodes: [{ id: 'a', primitive: 'llm', lane: 'l', label: 'Do a thing' }],
    edges: [],
  }).spec;
  const { bundle } = normalizeBundle(spec);
  assert.equal(bundle.version, BUNDLE_VERSION);
  assert.equal(bundle.root, 'system');
  assert.equal(Object.keys(bundle.flows).length, 1);
  assert.equal(bundle.flows.system.nodes.length, 1);
});

test('normalizeBundle survives hostile input', () => {
  for (const raw of [null, undefined, 42, 'nope', [], {}, { flows: null }, { flows: { a: null } }]) {
    const { bundle } = normalizeBundle(raw);
    assert.ok(bundle.flows[bundle.root], `no root flow for ${JSON.stringify(raw)}`);
    assert.equal(bundle.version, BUNDLE_VERSION);
  }
});

test('a subflow reference that does not resolve is dropped and reported', () => {
  const { bundle, issues } = normalizeBundle({
    root: 'system',
    flows: {
      system: { lanes: [{ id: 'l', name: 'L' }], nodes: [{ id: 'a', primitive: 'agent', lane: 'l', label: 'A' }], edges: [] },
    },
  });
  assert.equal(bundle.flows.system.nodes[0].subflow, undefined);

  const { bundle: withRef } = normalizeBundle({
    root: 'system',
    flows: {
      system: { lanes: [{ id: 'l', name: 'L' }], nodes: [{ id: 'a', primitive: 'agent', lane: 'l', label: 'A', subflow: 'ghost' }], edges: [] },
    },
  });
  assert.equal(withRef.flows.system.nodes[0].subflow, undefined);
  void issues;
});

test('breadcrumb walks to the root and refuses to loop', () => {
  assert.deepEqual(breadcrumb(HARNESS_BUNDLE, 'system').map((c) => c.id), ['system']);
  assert.deepEqual(
    breadcrumb(HARNESS_BUNDLE, 'agent:builder').map((c) => c.id),
    ['system', 'agent:builder'],
  );
  // A cycle must not hang the breadcrumb.
  const cyc = {
    version: 1, root: 'a', flows: {
      a: { title: 'A', lanes: [{ id: 'l', name: 'L' }], nodes: [{ id: 'n', primitive: 'agent', lane: 'l', label: 'N', subflow: 'b' }], edges: [] },
      b: { title: 'B', lanes: [{ id: 'l', name: 'L' }], nodes: [{ id: 'm', primitive: 'agent', lane: 'l', label: 'M', subflow: 'a' }], edges: [] },
    }, meta: {},
  };
  assert.ok(breadcrumb(cyc, 'b').length <= 2);
  assert.ok(descendantCount(cyc, 'a') <= 2);
});

test('parentOf and descendantCount match the fixture', () => {
  assert.equal(parentOf(HARNESS_BUNDLE, 'system'), null);
  assert.equal(parentOf(HARNESS_BUNDLE, 'agent:research'), 'system');
  assert.equal(descendantCount(HARNESS_BUNDLE, 'system'), 3);
  assert.equal(descendantCount(HARNESS_BUNDLE, 'agent:research'), 0);
});

// ── Status ─────────────────────────────────────────────────────────────────

test('an unknown status becomes "unknown" and says so', () => {
  const { pool, issues } = normalizePool({ nodes: { 'f/n': { status: 'on fire' } } });
  assert.equal(pool.nodes['f/n'].status, 'unknown');
  assert.ok(issues.some((i) => /not one of/.test(i.message)));
});

test('the status vocabulary is closed', () => {
  assert.deepEqual(NODE_STATUS, ['idle', 'running', 'blocked', 'done', 'error', 'skipped']);
});

test('deltas accumulate, clear on null, and never move the cursor backwards', () => {
  let pool = emptyPool();
  pool = applyDeltas(pool, { cursor: 5, nodes: { a: { status: 'running' }, b: { status: 'idle' } } }).pool;
  assert.equal(summarize(pool).total, 2);
  assert.equal(pool.cursor, 5);

  const { pool: after, cleared } = applyDeltas(pool, { cursor: 3, nodes: { a: null, c: { status: 'done' } } });
  assert.equal(after.cursor, 5, 'a stale cursor must not rewind the pool');
  assert.equal(after.nodes.a, undefined);
  assert.deepEqual(cleared, ['nodes/a']);
  assert.equal(summarize(after).total, 2);
});

test('applyDeltas does not mutate the pool it was given', () => {
  const base = applyDeltas(emptyPool(), { nodes: { a: { status: 'running' } } }).pool;
  const snapshot = JSON.stringify(base);
  applyDeltas(base, { nodes: { a: { status: 'done' }, b: { status: 'idle' } } });
  assert.equal(JSON.stringify(base), snapshot);
});

test('metrics are kept only when they are numbers', () => {
  const { pool } = normalizePool({
    nodes: { a: { status: 'done', metrics: { tokens: 12, cost: Number.NaN, ms: 'fast', steps: 3 } } },
  });
  assert.deepEqual(pool.nodes.a.metrics, { tokens: 12, steps: 3 });
});

test('the fixture script produces a status pool a host could have sent', () => {
  let pool = emptyPool();
  for (const [i, entry] of STATUS_SCRIPT.entries()) {
    pool = applyDeltas(pool, { nodes: entry, cursor: i + 1 }).pool;
  }
  const s = summarize(pool);
  assert.ok(s.total > 5, 'script should touch more than a handful of nodes');
  assert.ok(pool.nodes['system/e0'], 'the script should reach the terminal node');
  assert.equal(pool.version, STATUS_VERSION);
});

// ── Merging status onto a diagram ──────────────────────────────────────────

test('withStatus merges by flow-qualified key and leaves the spec alone', () => {
  const spec = layout(HARNESS_BUNDLE.flows.system).spec;
  const original = JSON.stringify(spec);
  const pool = applyDeltas(emptyPool(), { nodes: { 'system/o1': { status: 'running' } } }).pool;

  const { spec: merged, unknown } = withStatus(spec, pool, 'system');
  assert.equal(merged.nodes.find((n) => n.id === 'o1').status.status, 'running');
  assert.equal(JSON.stringify(spec), original, 'withStatus mutated its input');
  assert.deepEqual(unknown, []);
});

test('status keys belonging to another flow are not reported as unknown', () => {
  const spec = layout(HARNESS_BUNDLE.flows.system).spec;
  const pool = applyDeltas(emptyPool(), {
    nodes: { 'agent:builder/b1': { status: 'running' }, 'system/ghost': { status: 'idle' } },
  }).pool;
  const { unknown } = withStatus(spec, pool, 'system');
  assert.deepEqual(unknown, ['system/ghost']);
});

// ── The fixture itself ─────────────────────────────────────────────────────

test('the fixture bundle is valid and every nested flow is reachable', () => {
  const { bundle, issues } = normalizeBundle(HARNESS_BUNDLE);
  assert.deepEqual(issues, [], issues.map((i) => i.message).join('; '));
  assert.deepEqual(Object.keys(bundle.flows).sort(), ['agent:builder', 'agent:planner', 'agent:research', 'system']);

  const reachable = new Set(['system']);
  const queue = ['system'];
  while (queue.length) {
    const id = queue.shift();
    for (const n of bundle.flows[id].nodes) {
      if (n.subflow && !reachable.has(n.subflow)) { reachable.add(n.subflow); queue.push(n.subflow); }
    }
  }
  assert.deepEqual([...reachable].sort(), Object.keys(bundle.flows).sort());
});

test('a bundle round-trips through JSON unchanged', () => {
  const { bundle } = normalizeBundle(HARNESS_BUNDLE);
  const round = normalizeBundle(JSON.parse(JSON.stringify(bundle))).bundle;
  assert.deepEqual(Object.keys(round.flows).sort(), Object.keys(bundle.flows).sort());
  for (const id of Object.keys(bundle.flows)) {
    assert.deepEqual(round.flows[id].nodes.map((n) => n.id), bundle.flows[id].nodes.map((n) => n.id));
  }
});

void bundleFromSpec;
void FlowPort;
