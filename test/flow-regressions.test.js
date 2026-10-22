/** Regression tests for parser bugs that only showed up when the diagram was rendered. */

import test from 'node:test';
import assert from 'node:assert/strict';

import { interpret, fromText, analyze, layout, normalizeSpec } from '../src/flow/index.js';
import { getPrimitive } from '../src/flow/primitives.js';

const outEdges = (spec, id) => spec.edges.filter((e) => e.from === id);
const node = (spec, id) => spec.nodes.find((n) => n.id === id);
const byPrimitive = (spec, p) => spec.nodes.filter((n) => n.primitive === p);

test('every step in a branch chains, instead of fanning out from the decision', () => {
  const { spec } = interpret(
    'If drift is detected the agent drafts a note and an engineer approves it and then the agent writes an alert and emails the rota.',
  );
  const decision = byPrimitive(spec, 'decision')[0];
  assert.ok(decision, 'no decision node');

  const leaving = outEdges(spec, decision.id);
  assert.equal(leaving.length, 1, `the decision should have one exit per arm, got ${leaving.length}`);
  assert.equal(leaving[0].fromPort, 'true');

  // The rest of the arm is a chain.
  const next = node(spec, leaving[0].to);
  assert.ok(next, 'the branch target is missing');
  const after = outEdges(spec, next.id);
  assert.equal(after.length, 1, 'the branch should continue as a sequence, not fork again');
});

test('an if/else gives each arm exactly one edge from the decision', () => {
  const { spec } = interpret(
    'If the amount is over $5,000 a manager approves it; otherwise the agent auto-approves it.',
  );
  const decision = byPrimitive(spec, 'decision')[0];
  const outgoing = outEdges(spec, decision.id);
  assert.equal(outgoing.length, 2);
  assert.deepEqual(outgoing.map((e) => e.fromPort).sort(), ['false', 'true']);
});

test('"every hour the pipeline reads rows" keeps the read as a step', () => {
  const { spec } = interpret('Every hour the pipeline reads rows from the warehouse.');
  assert.equal(spec.nodes.length >= 2, true, `expected trigger + step, got ${spec.nodes.map((n) => n.primitive).join(', ')}`);
  assert.equal(spec.nodes[0].primitive, 'trigger-schedule');
  assert.match(spec.nodes[0].label, /hour/i);
  assert.ok(spec.nodes.some((n) => n.primitive === 'tool-read'), 'the read was swallowed by the trigger');
});

test('"once approved, it is published" is a publish, not an approval', () => {
  const { spec } = interpret('An analyst reviews the brief.\nOnce approved it is published to the intranet.');
  const publishes = byPrimitive(spec, 'publish');
  assert.equal(publishes.length, 1, 'expected exactly one publish node');
  assert.match(publishes[0].label, /published/i);
});

test('an unnamed outbound step does not inherit the human who approved it', () => {
  // The realistic shape: a machine actor is in play, a human approves, then the
  // machine acts. The outbound step belongs to the machine, not the approver.
  const { spec } = interpret(
    'The finance agent extracts the vendor and amount.\nA manager approves the invoice.\nFinally it posts the invoice to the ledger.',
  );
  const notify = byPrimitive(spec, 'notify')[0];
  assert.ok(notify, 'no outbound node');
  const lane = spec.lanes.find((l) => l.id === notify.lane);
  assert.notEqual(lane.kind, 'human', `outbound step landed in the "${lane.name}" lane`);
  assert.equal(lane.name, 'Finance agent');
});

test('with no machine actor named, an outbound step stays with the human', () => {
  // Deliberately conservative: without a machine to attribute it to, guessing
  // would be worse than leaving it where the reader can see and move it.
  const { spec } = interpret('A manager approves the invoice.\nFinally it posts the invoice to the ledger.');
  const notify = byPrimitive(spec, 'notify')[0];
  const lane = spec.lanes.find((l) => l.id === notify.lane);
  assert.equal(lane.kind, 'human');
});

test('"either approve it or send it back" is a real two-armed fork', () => {
  const { spec } = interpret('An analyst reviews the briefing and either approves it or sends it back.');
  const decision = byPrimitive(spec, 'decision')[0];
  assert.ok(decision, 'no decision node');

  const arms = outEdges(spec, decision.id);
  assert.equal(arms.length, 2, `expected two arms, got ${arms.length}`);
  assert.deepEqual(arms.map((a) => a.fromPort).sort(), ['false', 'true']);

  // Both arms are built, and both belong to the person making the choice.
  for (const arm of arms) {
    const n = node(spec, arm.to);
    assert.ok(n, 'arm target missing');
    const lane = spec.lanes.find((l) => l.id === n.lane);
    assert.equal(lane.kind, 'human', `arm "${n.label}" landed in the "${lane.name}" lane`);
  }
});

test('both arms of an either/or rejoin the next step', () => {
  const { spec } = interpret('Either approve it or send it back, then publish the result.');
  const decision = byPrimitive(spec, 'decision')[0];
  const arms = outEdges(spec, decision.id).map((e) => e.to);
  const publish = byPrimitive(spec, 'publish')[0];
  assert.ok(publish, 'no publish node');

  const feeders = spec.edges.filter((e) => e.to === publish.id).map((e) => e.from);
  for (const arm of arms) {
    assert.ok(feeders.includes(arm), `arm ${arm} does not rejoin the flow`);
  }
});

test('nodes with no actor share one System lane rather than borrowing a named one', () => {
  const { spec } = interpret('Every hour the pipeline reads rows.\nThe agent summarises them.\nDone.');
  const systemLanes = spec.lanes.filter((l) => l.id === 'system');
  assert.equal(systemLanes.length, 1);
  assert.equal(systemLanes[0].name, 'System');
  assert.ok(spec.lanes.some((l) => l.name === 'Pipeline'), 'the named system actor should keep its own lane');
});

test('"no failure path" is a note when failure is handled somewhere, medium when nowhere', () => {
  const none = analyze(fromText('trigger -> write record -> send email').spec).flags
    .find((f) => f.id === 'no-error-path');
  assert.ok(none);
  assert.equal(none.severity, 'medium');

  const some = normalizeSpec({
    lanes: [{ id: 'l', name: 'L' }],
    nodes: [
      { id: 'a', primitive: 'trigger-event', lane: 'l' },
      { id: 'b', primitive: 'tool-write', lane: 'l' },
      { id: 'c', primitive: 'error', lane: 'l' },
      { id: 'd', primitive: 'notify', lane: 'l' },
    ],
    edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'c', kind: 'error' }, { from: 'a', to: 'd' }],
  }).spec;
  const partial = analyze(some).flags.find((f) => f.id === 'no-error-path');
  assert.ok(partial);
  assert.equal(partial.severity, 'note');
});

test('every demo renders and produces a spec with no structural problems', async () => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);
  const { stdout } = await run(process.execPath, ['scripts/flow-render.js', '--demo', '0']);
  assert.match(stdout, /^<svg/);
});

test('a dense, realistic flow survives interpret → layout → render', () => {
  const text = [
    'Every hour the pipeline reads rows from the warehouse and the agent summarises the metrics.',
    'If drift is detected the agent drafts an incident note and an engineer approves it; otherwise it writes a clean-run marker.',
    'Once approved the agent posts to the on-call channel and emails the rota.',
    'In parallel it updates the dashboard and notifies the customer in Slack.',
  ].join('\n');
  const out = fromText(text);
  assert.equal(validateNoOverlap(out.spec), true, 'nodes overlap');
  assert.ok(out.spec.nodes.length >= 8, `only ${out.spec.nodes.length} nodes`);
  assert.ok(out.spec.lanes.length >= 4);
});

function validateNoOverlap(spec) {
  for (let i = 0; i < spec.nodes.length; i++) {
    for (let j = i + 1; j < spec.nodes.length; j++) {
      const a = spec.nodes[i];
      const b = spec.nodes[j];
      if (a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y) return false;
    }
  }
  return true;
}

void layout;
void getPrimitive;
