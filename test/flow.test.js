/**
 * Flow engine checks.
 *
 * Same philosophy as the planner's suite: the point is not coverage, it is that
 * the *rules* cannot silently rot. Layout invariants and hazard detection are
 * the parts most likely to break quietly, so they get the strongest assertions.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  interpret, fromText, layout, analyze, renderSVG, normalizeSpec, validateSpec,
  PRIMITIVES, getPrimitive, primitivesByCategory, effectsOf, routeEdge, rectOf,
  measureNode, textLayout, emptySpec, findCycles, SPEC_VERSION,
} from '../src/flow/index.js';
import { findActor, findActors, classifyVerb, splitClauses, splitConditionBody } from '../src/flow/interpret.js';
import { glyphPath, esc } from '../src/flow/render.js';

const PROSE = `When an issue is labelled urgent, the triage agent reads the issue and fetches customer records.
It then classifies the severity.
If the customer is on an enterprise plan, an engineer approves an escalation.
Otherwise the agent drafts a standard reply.
Finally the agent posts to #incidents in Slack.`;

// ── Registry ────────────────────────────────────────────────────────────────

test('every primitive is well formed and has a glyph', () => {
  for (const p of PRIMITIVES) {
    assert.match(p.id, /^[a-z0-9-]+$/, `${p.id}: bad id`);
    assert.ok(p.label?.length > 2, `${p.id}: missing label`);
    assert.ok(p.hint?.length > 8, `${p.id}: needs a hint`);
    assert.ok(Array.isArray(p.effects), `${p.id}: effects must be an array`);
    assert.ok(['rect', 'round', 'pill', 'diamond', 'hex', 'slant', 'cylinder', 'circle'].includes(p.shape), `${p.id}: bad shape`);
    assert.ok(glyphPath(p.glyph), `${p.id}: glyph "${p.glyph}" does not resolve`);
    assert.ok(p.props && typeof p.props === 'object', `${p.id}: props must be an object`);
  }
});

test('primitive ids are unique and every category is populated', () => {
  const ids = PRIMITIVES.map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length);
  const groups = primitivesByCategory();
  for (const [key, list] of Object.entries(groups)) {
    assert.ok(list.length > 0, `category "${key}" has no primitives`);
  }
});

test('effectsOf unions without duplicates', () => {
  const e = effectsOf(['tool-browser', 'tool-exec', 'end']);
  assert.equal(e.filter((x) => x === 'exec-code').length, 1);
  assert.ok(e.includes('untrusted-input') && e.includes('mutates-state'));
});

// ── Language parsing ────────────────────────────────────────────────────────

test('findActor prefers the subject and ignores objects', () => {
  assert.equal(findActor('the triage agent reads the issue')?.phrase, 'triage agent');
  // "customer" is the object of "fetches", not the actor
  assert.equal(findActor('fetches customer records'), null);
  assert.equal(findActor('the engineer approves an escalation')?.phrase, 'engineer');
  assert.equal(findActor('posts to #incidents in Slack'), null);
});

test('findActors returns candidates in reading order', () => {
  const names = findActors('the amount is over $5,000 a manager approves it').map((a) => a.phrase);
  assert.deepEqual(names, ['manager']);
});

test('classifyVerb picks the most specific verb', () => {
  assert.equal(classifyVerb('approves an escalation'), 'approval');
  assert.equal(classifyVerb('escalates to the on-call'), 'escalate');
  assert.equal(classifyVerb('reads the files'), 'tool-read');
  assert.equal(classifyVerb('writes the record'), 'tool-write');
  assert.equal(classifyVerb('posts to Slack'), 'notify');
  assert.equal(classifyVerb('classifies the ticket'), 'classify');
  assert.equal(classifyVerb('drafts a reply'), 'llm');
  assert.equal(classifyVerb('no verb here at all'), null);
});

test('splitClauses separates commas, conjunctions and sequence markers', () => {
  const clauses = splitClauses('When an issue is urgent, the agent reads it and then drafts a reply.').map((c) => c.text);
  assert.ok(clauses.length >= 3, `expected 3+ clauses, got ${JSON.stringify(clauses)}`);
  assert.ok(clauses.some((c) => /^when an issue is urgent$/i.test(c)));
  assert.ok(clauses.some((c) => /^the agent reads it$/i.test(c)));
  assert.ok(clauses.some((c) => /^drafts a reply$/i.test(c)));
});

test('splitConditionBody separates a condition from its consequence', () => {
  const out = splitConditionBody('the amount is over $5,000 a manager approves it');
  assert.equal(out.condition, 'the amount is over $5,000');
  assert.equal(out.rest, 'a manager approves it');
  // A short condition with no second actor stays whole.
  assert.equal(splitConditionBody('the customer is on an enterprise plan').rest, '');
});

// ── Interpretation ──────────────────────────────────────────────────────────

test('prose produces a correct branch structure', () => {
  const { spec } = interpret(PROSE);
  assert.equal(validateSpec(spec).length, 0, validateSpec(spec).join('; '));

  const decision = spec.nodes.find((n) => n.primitive === 'decision');
  assert.ok(decision, 'no decision node');

  const branches = spec.edges.filter((e) => e.from === decision.id);
  assert.equal(branches.length, 2, 'a decision needs exactly two outgoing edges');
  assert.deepEqual(branches.map((b) => b.fromPort).sort(), ['false', 'true']);

  // The approval must sit on the "yes" branch, in the human lane.
  const yes = branches.find((b) => b.fromPort === 'true');
  const approval = spec.nodes.find((n) => n.id === yes.to);
  assert.equal(approval.primitive, 'approval');
  const lane = spec.lanes.find((l) => l.id === approval.lane);
  assert.equal(lane.kind, 'human', 'an approval must live in a human lane');
});

test('the leading "when" clause becomes a trigger, not a step', () => {
  const { spec } = interpret(PROSE);
  const first = spec.nodes[0];
  assert.ok(first.primitive.startsWith('trigger-'), `first node was ${first.primitive}`);
  assert.equal(spec.lanes.find((l) => l.id === first.lane).name, 'Trigger');
});

test('"auto-approves" is a programmatic rule, not a human gate', () => {
  const { spec } = interpret('When an invoice arrives, the agent extracts the total. If it is under $100 the agent auto-approves it; otherwise a manager approves it.');
  const approvals = spec.nodes.filter((n) => n.primitive === 'approval');
  assert.equal(approvals.length, 1, 'only the human branch should be an approval gate');
});

test('bare actor nouns reuse the lane already in play', () => {
  const { spec } = interpret('the triage agent reads the ticket. It then drafts a reply. The agent posts the reply.');
  const agentLanes = spec.lanes.filter((l) => l.kind === 'agent');
  assert.equal(agentLanes.length, 1, `expected one agent lane, got ${agentLanes.map((l) => l.name).join(', ')}`);
});

test('arrow syntax builds a linear chain', () => {
  const { spec } = interpret('trigger -> fetch rows -> agent summarise -> engineer approves -> send email');
  assert.equal(spec.nodes.length, 5);
  assert.equal(spec.edges.length, 4);
  for (let i = 0; i < 4; i++) assert.equal(spec.edges[i].from, spec.nodes[i].id);
});

test('a bulleted list is read as a sequence', () => {
  const { spec } = interpret('- Trigger on new ticket\n- Agent classifies the ticket\n- Assign to the team queue\n- Notify the customer');
  assert.ok(spec.nodes.length >= 4);
  assert.ok(spec.nodes.some((n) => n.primitive === 'classify'));
  assert.ok(spec.nodes.some((n) => n.primitive === 'notify'));
});

test('empty and junk input never throws and yields a valid spec', () => {
  for (const input of ['', '   ', '\n\n', '!!!', '12345', 'the', 'a a a a a']) {
    const { spec } = interpret(input);
    assert.equal(spec.version, SPEC_VERSION);
    assert.equal(validateSpec(spec).length, 0, `"${input}" produced ${validateSpec(spec).join('; ')}`);
  }
});

test('interpretation is deterministic', () => {
  const a = interpret(PROSE).spec;
  const b = interpret(PROSE).spec;
  assert.deepEqual(a.nodes.map((n) => `${n.id}:${n.primitive}:${n.label}`), b.nodes.map((n) => `${n.id}:${n.primitive}:${n.label}`));
  assert.deepEqual(a.edges.map((e) => `${e.from}>${e.to}`), b.edges.map((e) => `${e.from}>${e.to}`));
});

// ── Spec normalisation ──────────────────────────────────────────────────────

test('normalizeSpec survives hostile input', () => {
  const cases = [
    null, undefined, 42, 'string', [], {},
    { nodes: 'nope' },
    { nodes: [null, 1, 'x'] },
    { nodes: [{ id: 'a' }], edges: [{ from: 'a', to: 'ghost' }] },
    { nodes: [{ id: 'a', primitive: 'not-a-primitive' }], lanes: [{ id: 'L', name: 'L' }] },
    { nodes: [{ id: 'a', lane: 'missing' }], lanes: [] },
    { nodes: [{ id: 'a' }, { id: 'a' }], edges: [{ from: 'a', to: 'a' }] },
  ];
  for (const raw of cases) {
    const out = normalizeSpec(raw);
    assert.ok(out.spec && Array.isArray(out.spec.nodes), `failed on ${JSON.stringify(raw)}`);
    assert.equal(validateSpec(out.spec).length, 0, `invalid output for ${JSON.stringify(raw)}`);
  }
});

test('normalizeSpec drops dangling edges and reports them', () => {
  const { spec, issues } = normalizeSpec({
    lanes: [{ id: 'l', name: 'L' }],
    nodes: [{ id: 'a', primitive: 'llm', lane: 'l' }],
    edges: [{ from: 'a', to: 'nope' }],
  });
  assert.equal(spec.edges.length, 0);
  assert.ok(issues.some((i) => /does not exist/.test(i.message)));
});

test('an unknown primitive is coerced, not dropped', () => {
  const { spec, issues } = normalizeSpec({ lanes: [{ id: 'l', name: 'L' }], nodes: [{ id: 'a', primitive: 'teleport', lane: 'l' }] });
  assert.equal(spec.nodes.length, 1);
  assert.equal(spec.nodes[0].primitive, 'llm');
  assert.ok(issues.some((i) => /unknown primitive/.test(i.message)));
});

test('normalizeSpec is idempotent', () => {
  const once = normalizeSpec(interpret(PROSE).spec).spec;
  const twice = normalizeSpec(once).spec;
  assert.deepEqual(once.nodes, twice.nodes);
  assert.deepEqual(once.edges, twice.edges);
  assert.deepEqual(once.lanes.map((l) => l.id), twice.lanes.map((l) => l.id));
});

// ── Layout ──────────────────────────────────────────────────────────────────

test('layout puts every node inside its own lane band', () => {
  const { spec } = fromText(PROSE);
  const lanes = new Map(spec.lanes.map((l) => [l.id, l]));
  for (const n of spec.nodes) {
    const lane = lanes.get(n.lane);
    assert.ok(lane, `node ${n.id} references a lane that vanished`);
    assert.ok(n.y >= lane.y - 0.5, `${n.id} starts above its lane`);
    assert.ok(n.y + n.h <= lane.y + lane.height + 0.5, `${n.id} overflows its lane`);
  }
});

test('layout never overlaps two nodes', () => {
  for (const text of [PROSE, 'trigger -> fetch -> summarise -> approve -> send', '- a\n- b\n- c\n- d']) {
    const { spec } = fromText(text);
    for (let i = 0; i < spec.nodes.length; i++) {
      for (let j = i + 1; j < spec.nodes.length; j++) {
        const a = rectOf(spec.nodes[i]);
        const b = rectOf(spec.nodes[j]);
        const overlap = a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
        assert.ok(!overlap, `${spec.nodes[i].id} overlaps ${spec.nodes[j].id} in "${text.slice(0, 30)}"`);
      }
    }
  }
});

test('layout is stable: running it twice changes nothing', () => {
  const first = fromText(PROSE).spec;
  const second = layout(first).spec;
  assert.deepEqual(first.nodes.map((n) => [n.id, n.x, n.y]), second.nodes.map((n) => [n.id, n.x, n.y]));
});

test('layout handles a cycle without hanging or stacking everything in one column', () => {
  const { spec } = normalizeSpec({
    lanes: [{ id: 'l', name: 'L', kind: 'system' }],
    nodes: [
      { id: 'a', primitive: 'trigger-event', lane: 'l' },
      { id: 'b', primitive: 'llm', lane: 'l' },
      { id: 'c', primitive: 'decision', lane: 'l' },
    ],
    edges: [
      { from: 'a', to: 'b' }, { from: 'b', to: 'c' }, { from: 'c', to: 'b', label: 'retry' },
    ],
  });
  const laid = layout(spec).spec;
  const xs = new Set(laid.nodes.map((n) => n.x));
  assert.ok(xs.size >= 3, 'a cycle must not collapse every node onto one column');
});

test('diamond labels are laid out to fit inside the shape', () => {
  const t = textLayout('The customer is on an enterprise plan', 'diamond');
  assert.ok(t.w >= 196 && t.h >= 84);
  for (const line of t.lines) assert.ok(line.length <= 15, `line too long: "${line}"`);
});

test('measureNode grows with the label', () => {
  const small = measureNode({ label: 'Done', shape: 'rect' });
  const big = measureNode({ label: 'Fetch the customer records and reconcile them against the ERP', shape: 'rect' });
  assert.ok(big.h >= small.h);
  assert.ok(big.w >= small.w);
});

// ── Geometry ────────────────────────────────────────────────────────────────

test('routeEdge produces a parseable path for forward and backward edges', () => {
  const forward = routeEdge({ x: 0, y: 0, w: 100, h: 50 }, { x: 300, y: 0, w: 100, h: 50 });
  const back = routeEdge({ x: 300, y: 0, w: 100, h: 50 }, { x: 0, y: 100, w: 100, h: 50 });
  for (const r of [forward, back]) {
    assert.match(r.d, /^M [\d.]+ [\d.]+/);
    assert.ok(!r.d.includes('NaN'), 'path contains NaN');
    assert.ok(!r.d.includes('undefined'), 'path contains undefined');
  }
  assert.equal(forward.back, false);
  assert.equal(back.back, true);
});

// ── Hazards ─────────────────────────────────────────────────────────────────

test('lethal trifecta is detected when untrusted input reaches egress with private data', () => {
  const { spec } = fromText(
    'When a web page is fetched, the agent reads the customer database and then posts a summary to Slack.',
  );
  const { flags } = analyze(spec);
  const tri = flags.find((f) => f.id === 'trifecta');
  assert.ok(tri, `expected a trifecta flag, got ${flags.map((f) => f.id).join(', ')}`);
  assert.equal(tri.severity, 'critical');
  assert.ok(tri.nodes.length >= 2, 'the flag should name the nodes involved');
});

test('no trifecta when there is no outbound channel', () => {
  const { spec } = fromText('When a web page is fetched, the agent reads the customer database and drafts a note.');
  const { flags } = analyze(spec);
  assert.ok(!flags.some((f) => f.id === 'trifecta'));
});

test('an irreversible step with no upstream approval is critical', () => {
  const { spec } = normalizeSpec({
    lanes: [{ id: 'l', name: 'L' }],
    nodes: [
      { id: 'a', primitive: 'trigger-event', lane: 'l' },
      { id: 'b', primitive: 'publish', lane: 'l' },
    ],
    edges: [{ from: 'a', to: 'b' }],
  });
  const { flags } = analyze(spec);
  assert.ok(flags.some((f) => f.id === 'irreversible-ungated' && f.severity === 'critical'));
});

test('an approval upstream clears the irreversible flag', () => {
  const { spec } = normalizeSpec({
    lanes: [{ id: 'l', name: 'L' }, { id: 'h', name: 'H', kind: 'human' }],
    nodes: [
      { id: 'a', primitive: 'trigger-event', lane: 'l' },
      { id: 'g', primitive: 'approval', lane: 'h' },
      { id: 'b', primitive: 'publish', lane: 'l' },
    ],
    edges: [{ from: 'a', to: 'g' }, { from: 'g', to: 'b' }],
  });
  const { flags } = analyze(spec);
  assert.ok(!flags.some((f) => f.id === 'irreversible-ungated'));
});

test('a cycle with no bound is flagged, a bounded loop is not', () => {
  const base = {
    lanes: [{ id: 'l', name: 'L' }],
    nodes: [
      { id: 'a', primitive: 'trigger-event', lane: 'l' },
      { id: 'b', primitive: 'llm', lane: 'l' },
      { id: 'c', primitive: 'decision', lane: 'l' },
    ],
    edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }, { from: 'c', to: 'b' }],
  };
  assert.equal(findCycles(normalizeSpec(base).spec).length, 1);
  assert.ok(analyze(normalizeSpec(base).spec).flags.some((f) => f.id === 'unbounded-loop'));

  const bounded = JSON.parse(JSON.stringify(base));
  bounded.nodes[1].props = { max: '5', until: 'no drift' };
  assert.ok(!analyze(normalizeSpec(bounded).spec).flags.some((f) => f.id === 'unbounded-loop'));
});

test('code execution without a declared isolation boundary is flagged', () => {
  const { spec: flagged } = normalizeSpec({
    lanes: [{ id: 'l', name: 'L' }],
    nodes: [{ id: 'a', primitive: 'tool-exec', lane: 'l', props: {} }],
    edges: [],
  });
  assert.ok(analyze(flagged).flags.some((f) => f.id === 'sandbox-floor'));

  // A value that merely starts with a weak word must not read as a boundary.
  const smuggled = normalizeSpec({
    lanes: [{ id: 'l', name: 'L' }],
    nodes: [{ id: 'a', primitive: 'tool-exec', lane: 'l', props: { isolation: 'none: runs as the user' } }],
    edges: [],
  }).spec;
  assert.ok(analyze(smuggled).flags.some((f) => f.id === 'sandbox-floor'), '"none: ..." was accepted as an isolation boundary');

  const { spec: fine } = normalizeSpec({
    lanes: [{ id: 'l', name: 'L' }],
    nodes: [{ id: 'a', primitive: 'tool-exec', lane: 'l', props: { isolation: 'microVM' } }],
    edges: [],
  });
  assert.ok(!analyze(fine).flags.some((f) => f.id === 'sandbox-floor'));
});

test('hazards are ordered by severity and never crash on an empty diagram', () => {
  const empty = analyze(emptySpec()).flags;
  assert.equal(empty.length, 0);

  const order = { critical: 0, high: 1, medium: 2, note: 3 };
  const flags = analyze(fromText('trigger -> publish -> send email').spec).flags;
  for (let i = 1; i < flags.length; i++) {
    assert.ok(order[flags[i - 1].severity] <= order[flags[i].severity], 'flags are not sorted');
  }
});

// ── Rendering ───────────────────────────────────────────────────────────────

test('renderSVG emits a well-formed document with every node and edge', () => {
  const { spec, size } = fromText(PROSE);
  const svg = renderSVG(spec, { width: size.w, height: size.h });
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  assert.match(svg, /<\/svg>$/);
  assert.equal((svg.match(/class="node"/g) || []).length, spec.nodes.length);
  assert.equal((svg.match(/class="edge"/g) || []).length, spec.edges.length);
  assert.equal((svg.match(/class="lane"/g) || []).length, spec.lanes.length);
  assert.ok(!svg.includes('undefined'), 'svg contains "undefined"');
  assert.ok(!svg.includes('NaN'), 'svg contains "NaN"');
  assert.ok(!svg.includes('[object Object]'), 'svg contains an object');
});

test('renderSVG escapes text rather than injecting it', () => {
  const { spec } = normalizeSpec({
    title: 'x',
    lanes: [{ id: 'l', name: '<img src=x onerror=alert(1)>' }],
    nodes: [{ id: 'a', primitive: 'llm', lane: 'l', label: 'A & B <script>alert(1)</script>' }],
    edges: [],
  });
  const laid = layout(spec).spec;
  const svg = renderSVG(laid);
  assert.ok(!svg.includes('<script>'), 'script tag leaked into the SVG');
  assert.ok(!svg.includes('<img'), 'img tag leaked into the SVG');
  assert.ok(svg.includes('&amp;'));
});

test('no rounded corners survive in any shape', () => {
  const { spec } = fromText(PROSE);
  const svg = renderSVG(spec);
  const rounded = [...svg.matchAll(/<rect[^>]*rx="([1-9][0-9.]*)"/g)].map((m) => m[0]);
  assert.deepEqual(rounded, [], `rounded rects remain: ${rounded.slice(0, 3).join(' | ')}`);
});

test('light and dark themes produce different, valid documents', () => {
  const { spec, size } = fromText(PROSE);
  const light = renderSVG(spec, { width: size.w, height: size.h, theme: 'light' });
  const dark = renderSVG(spec, { width: size.w, height: size.h, theme: 'dark' });
  assert.notEqual(light, dark);
  for (const svg of [light, dark]) {
    assert.ok(!svg.includes('NaN') && !svg.includes('undefined'));
    assert.equal((svg.match(/class="node"/g) || []).length, spec.nodes.length);
  }
  // The dark canvas must not be painted white.
  assert.match(dark, /<rect width="\d+" height="\d+" fill="#101010"\/>/);
  assert.match(light, /<rect width="\d+" height="\d+" fill="#ffffff"\/>/);
});

test('the dark theme keeps node fills dark and text light', () => {
  const { spec } = normalizeSpec({
    lanes: [{ id: 'l', name: 'L' }],
    nodes: [{ id: 'a', primitive: 'llm', lane: 'l', label: 'Step' }],
    edges: [],
  });
  const svg = renderSVG(layout(spec).spec, { theme: 'dark' });
  assert.match(svg, /fill="#1b1b1a"/, 'expected the dark node fill');
  assert.match(svg, /fill="#ececea"/, 'expected the dark ink colour');
});

test('esc handles the usual suspects', () => {
  assert.equal(esc('<&>"\''), '&lt;&amp;&gt;&quot;&#39;');
});

test('every primitive renders without throwing', () => {
  const nodes = PRIMITIVES.map((p, i) => ({ id: `n${i}`, primitive: p.id, label: p.label, lane: 'l' }));
  const spec = layout(normalizeSpec({ lanes: [{ id: 'l', name: 'L' }], nodes, edges: [] }).spec).spec;
  assert.doesNotThrow(() => renderSVG(spec));
});

// ── End to end ──────────────────────────────────────────────────────────────

test('fromText returns spec, size, issues and analysis together', () => {
  const out = fromText(PROSE);
  assert.ok(out.spec.nodes.length > 3);
  assert.ok(out.size.w > 0 && out.size.h > 0);
  assert.ok(Array.isArray(out.issues));
  assert.ok(out.analysis.counts);
  assert.equal(out.interpreter, 'rules@1');
});

test('a generated diagram round-trips through JSON unchanged', () => {
  const { spec } = fromText(PROSE);
  const round = normalizeSpec(JSON.parse(JSON.stringify(spec))).spec;
  assert.deepEqual(round.nodes.map((n) => [n.id, n.label, n.primitive, n.lane]), spec.nodes.map((n) => [n.id, n.label, n.primitive, n.lane]));
  assert.deepEqual(round.edges.map((e) => [e.from, e.to, e.fromPort]), spec.edges.map((e) => [e.from, e.to, e.fromPort]));
});
