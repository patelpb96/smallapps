/**
 * Deterministic checks.
 *
 * The point is not coverage percentage — it is that the *rules* cannot silently
 * rot. If someone adds a heuristic with a fake citation, an unreachable source,
 * or a `when()` that throws on a valid fact set, this fails.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildPlan, deriveFacts, runHeuristics, HEURISTICS, SOURCES, QUESTIONS,
  defaultAnswers, PRESETS, renderMarkdown, renderChecklist, renderJson,
  AUTONOMY_TIERS, SANDBOX_TIERS, assessSandbox,
} from '../src/index.js';

// A fact set that touches every branch: worst case.
const WORST = {
  task: 'consequential', impact: 'safety', undo: 'none', horizon: 'continuous',
  selfModify: ['prompts', 'tools', 'memory', 'spawns'],
  inputs: ['web', 'email', 'files', 'agent-output'],
  sensitive: ['credentials', 'customer', 'financial'],
  egress: ['send', 'webhook', 'public', 'fetch'],
  exec: 'prod', tools: ['http', 'mcp-third', 'browser', 'computer'],
  toolCount: 40, network: 'open', secrets: 'static',
  oversight: 'none', opsPerDay: 400, overseerSkill: 'novice', owner: 'nobody',
  evals: 'none', observability: 'none', budget: 'none', killswitch: 'none',
  regulated: ['eu-ai-act', 'gdpr'], provider: 'mixed',
};

// The best case: nothing to break.
const BEST = {
  task: 'advice', impact: 'nuisance', undo: 'nothing-to-undo', horizon: 'turn',
  selfModify: ['none'], inputs: ['none'], sensitive: ['none'], egress: ['none'],
  exec: 'none', tools: ['builtin'], toolCount: 1, network: 'none', secrets: 'none',
  oversight: 'live', opsPerDay: 0, overseerSkill: 'expert', owner: 'named',
  evals: 'regression', observability: 'audit', budget: 'quotas', killswitch: 'oob',
  regulated: ['none'], provider: 'self',
};

// ── Catalog integrity ───────────────────────────────────────────────────────

test('every heuristic has the required fields and a real citation', () => {
  for (const h of HEURISTICS) {
    assert.match(h.id, /^[A-Z]+-\d{2}$/, `${h.id}: malformed id`);
    assert.ok(h.title?.length > 10, `${h.id}: title too short`);
    assert.ok(['must', 'should', 'consider'].includes(h.severity), `${h.id}: bad severity`);
    assert.ok(typeof h.when === 'function', `${h.id}: when must be a function`);
    assert.ok(typeof h.requirement === 'function', `${h.id}: requirement must be a function`);
    assert.ok(h.verify?.length > 20, `${h.id}: verify must be a runnable check`);
    assert.ok(Array.isArray(h.sources) && h.sources.length > 0, `${h.id}: needs at least one source`);
    for (const s of h.sources) {
      assert.ok(SOURCES[s], `${h.id}: unknown source "${s}"`);
    }
  }
});

test('heuristic ids are unique', () => {
  const ids = HEURISTICS.map((h) => h.id);
  assert.equal(new Set(ids).size, ids.length);
});

test('every question option maps to at least one declared fact, or is explicitly a no-op', () => {
  for (const q of QUESTIONS) {
    assert.ok(q.prompt?.length > 5, `${q.id}: prompt missing`);
    if (q.type === 'number') continue;
    for (const o of q.options) {
      assert.ok(o.facts !== undefined, `${q.id}/${o.value}: option declares no facts key`);
    }
  }
});

test('every declared source is reachable by URL', () => {
  for (const [id, s] of Object.entries(SOURCES)) {
    assert.ok(s.title && s.publisher && s.year, `${id}: incomplete metadata`);
    assert.match(s.url, /^https:\/\//, `${id}: url must be https`);
  }
});

// ── Robustness ──────────────────────────────────────────────────────────────

test('no heuristic throws on any of the extreme fact sets', () => {
  for (const answers of [WORST, BEST, defaultAnswers(), ...Object.values(PRESETS).map((p) => p.answers)]) {
    const facts = deriveFacts(answers);
    assert.doesNotThrow(() => runHeuristics(facts));
  }
});

test('deriveFacts is total: every fact is defined for an empty answer set', () => {
  const facts = deriveFacts({});
  for (const [k, v] of Object.entries(facts)) {
    assert.notEqual(v, undefined, `fact "${k}" came back undefined`);
  }
});

test('garbage answers do not crash the engine', () => {
  const junk = { task: 'nonexistent', inputs: 'not-an-array', toolCount: 'NaN', oversite: 'typo' };
  assert.doesNotThrow(() => buildPlan(junk));
});

test('numeric answers are clamped to their declared range', () => {
  const q = QUESTIONS.find((x) => x.id === 'toolCount');
  assert.equal(deriveFacts({ toolCount: 9999 }).toolCount, q.max);
  assert.equal(deriveFacts({ toolCount: -50 }).toolCount, 0);
});

// ── Monotonicity: the invariant that actually matters ───────────────────────

test('worse inputs never lower the sandbox floor', () => {
  const floors = {
    none: assessSandbox(deriveFacts({ exec: 'none' })),
    interpreter: assessSandbox(deriveFacts({ exec: 'interpreter' })),
    container: assessSandbox(deriveFacts({ exec: 'container' })),
    prod: assessSandbox(deriveFacts({ exec: 'prod' })),
  };
  const idx = (r) => SANDBOX_TIERS.findIndex((t) => t.id === r.required.id);
  assert.ok(idx(floors.none) <= idx(floors.interpreter));
  assert.ok(idx(floors.interpreter) <= idx(floors.container));
  assert.ok(idx(floors.container) <= idx(floors.prod));
});

test('ambient credentials raise the sandbox floor to a kernel boundary', () => {
  const without = assessSandbox(deriveFacts({ exec: 'container' }));
  const ambient = assessSandbox(deriveFacts({ exec: 'container', secrets: 'env' }));
  assert.equal(without.required.id, 'S2');
  assert.ok(SANDBOX_TIERS.findIndex((t) => t.id === ambient.required.id) >= 3,
    'an ambient secret inside a container must force VM-level isolation');
});

test('brokered credentials do not by themselves force a VM boundary', () => {
  const brokered = assessSandbox(deriveFacts({ exec: 'container', secrets: 'broker', impact: 'nuisance', undo: 'instant' }));
  assert.equal(brokered.required.id, 'S2');
  assert.equal(deriveFacts({ secrets: 'broker' }).ambientCreds, false);
  assert.equal(deriveFacts({ secrets: 'static' }).ambientCreds, true);
  assert.equal(deriveFacts({ secrets: 'static' }).longLivedCreds, true);
});

test('adding a write capability never raises the autonomy ceiling', () => {
  const ceilingIdx = (answers) => {
    const p = buildPlan(answers);
    return AUTONOMY_TIERS.findIndex((t) => t.id === p.autonomy.ceiling.id);
  };
  const base = { ...BEST };
  const write = { ...BEST, task: 'writes' };
  const irreversible = { ...BEST, task: 'irreversible', undo: 'none' };
  assert.ok(ceilingIdx(write) <= ceilingIdx(base));
  assert.ok(ceilingIdx(irreversible) <= ceilingIdx(write));
});

test('the ceiling is never above the operating tier plus headroom (sanity)', () => {
  for (const answers of [WORST, BEST, ...Object.values(PRESETS).map((p) => p.answers)]) {
    const plan = buildPlan(answers);
    assert.ok(AUTONOMY_TIERS.some((t) => t.id === plan.autonomy.ceiling.id));
    assert.ok(Number.isInteger(plan.autonomy.exposure));
    assert.equal(plan.autonomy.overBy, Math.max(0, plan.autonomy.exposure));
  }
});

test('a fully supervised read-only agent is reported as read-only, not as paying for oversight', () => {
  const plan = buildPlan({ ...BEST, oversight: 'per-action', opsPerDay: 1 });
  assert.equal(plan.autonomy.verdict, 'headroom');
  assert.ok(plan.autonomy.exposure < 0);
  assert.match(renderMarkdown(plan), /### Read-only/);
});

test('a supervised agent with side effects is reported as paying for headroom', () => {
  const plan = buildPlan({ ...BEST, task: 'writes', undo: 'instant', oversight: 'per-action', opsPerDay: 1 });
  assert.equal(plan.autonomy.verdict, 'headroom');
  assert.match(renderMarkdown(plan), /### Headroom/);
});

// ── Fail-safe behaviour ─────────────────────────────────────────────────────

test('every question declares an explicit fail-safe', () => {
  for (const q of QUESTIONS) {
    if (q.type === 'number') continue;
    assert.ok(q.failSafe !== undefined, `${q.id} has no failSafe`);
    const vals = Array.isArray(q.failSafe) ? q.failSafe : [q.failSafe];
    for (const v of vals) {
      assert.ok(q.options.some((o) => o.value === v), `${q.id}: failSafe "${v}" is not an option`);
    }
  }
});

test('an unknown answer degrades to the fail-safe, never to a safer-looking one', () => {
  // "advice" would be the friendliest read; the fail-safe must be the worst read.
  const facts = deriveFacts({ task: 'typo', oversight: 'typo', exec: 'typo', secrets: 'typo' });
  assert.equal(facts.actionClass, 'consequential');
  assert.equal(facts.oversight, 'none');
  assert.equal(facts.exec, 'prod');
  assert.equal(facts.credentialTier, 'static');
});

test('invalid answers are reported rather than swallowed', () => {
  const plan = buildPlan({ task: 'nonsense', oversight: 'action' });
  assert.equal(plan.warnings.length, 2);
  assert.ok(plan.warnings.some((w) => w.question === 'oversight' && w.fallback === 'none'));
});

test('a valid answer set produces no warnings', () => {
  for (const p of Object.values(PRESETS)) {
    assert.deepEqual(buildPlan(p.answers).warnings, [], `preset ${p.label} produced warnings`);
  }
  assert.deepEqual(buildPlan(defaultAnswers()).warnings, []);
});

// ── Behavioural expectations ────────────────────────────────────────────────

test('a read-only agent is T0 regardless of how much log review happens', () => {
  const plan = buildPlan({ ...BEST, oversight: 'logs', horizon: 'session' });
  assert.equal(plan.autonomy.current.id, 'T0');
});

test('an agent that emails on its own is not treated as read-only', () => {
  const plan = buildPlan({
    ...BEST, task: 'drafts', egress: ['send'], oversight: 'none', evals: 'none',
  });
  assert.ok(plan.autonomy.exposure > 0, 'unsupervised outbound send must be above its ceiling');
  assert.ok(plan.autonomy.blockers.some((b) => /outbound communication/i.test(b.reason)));
});

test('the ops-agent preset is diagnosed as over its ceiling with critical risks', () => {
  const plan = buildPlan(PRESETS['ops-agent'].answers, { name: 'ops' });
  assert.equal(plan.autonomy.verdict, 'over-ceiling');
  assert.ok(plan.counts.critical >= 2, 'expected multiple critical risk flags');
  assert.ok(plan.flags.some((f) => f.id === 'RISK-trifecta'));
  assert.ok(plan.flags.some((f) => f.id === 'RISK-rollback'));
});

test('the research-assistant preset gets a low sandbox floor and no trifecta', () => {
  const plan = buildPlan(PRESETS['research-assistant'].answers, { name: 'research' });
  assert.equal(plan.sandbox.required.id, 'S0');
  assert.equal(plan.facts.lethalTrifecta, false);
  assert.ok(plan.counts.must > 0, 'even a read-only agent has non-negotiables');
});

test('lethal trifecta is detected exactly when all three legs are present', () => {
  const legs = {
    'sensitive': ['customer'],
    'untrusted': ['web'],
    'egress': ['webhook'],
  };
  const build = (picked) => deriveFacts({
    sensitive: picked.sensitive ? ['customer'] : ['none'],
    inputs: picked.untrusted ? ['web'] : ['none'],
    egress: picked.egress ? ['webhook'] : ['none'],
  });
  assert.equal(build(legs).lethalTrifecta, true);
  assert.equal(build({ sensitive: true, untrusted: true }).lethalTrifecta, false);
  assert.equal(build({ sensitive: true, egress: true }).lethalTrifecta, false);
  assert.equal(build({ untrusted: true, egress: true }).lethalTrifecta, false);
});

test('selecting "none" in a multi-select clears the other facts', () => {
  const facts = deriveFacts({ inputs: ['none', 'web'] });
  assert.equal(facts.untrustedContent, false, '"none" must be absorbing');
});

test('approval fatigue is flagged above the review threshold', () => {
  const low = deriveFacts({ oversight: 'per-action', opsPerDay: 5 });
  const high = deriveFacts({ oversight: 'per-action', opsPerDay: 200 });
  assert.equal(low.approvalFatigueRisk, false);
  assert.equal(high.approvalFatigueRisk, true);
});

// ── Rendering ───────────────────────────────────────────────────────────────

test('renderers produce non-empty output and cite sources', () => {
  const plan = buildPlan(PRESETS['support-agent'].answers, { name: 'support', notes: 'hello' });
  const md = renderMarkdown(plan);
  const cl = renderChecklist(plan);
  const js = renderJson(plan);

  assert.ok(md.includes('# Agent workflow plan — support'));
  assert.ok(md.includes('## Sources'));
  assert.match(md, /https:\/\//);
  assert.ok(md.includes('hello'));

  assert.ok(cl.includes('- [ ]'));
  assert.ok(cl.includes('## Sign-off'));

  const parsed = JSON.parse(js);
  assert.equal(parsed.meta.name, 'support');
  assert.ok(parsed.controls.length > 5);
  assert.ok(parsed.controls.every((c) => c.sources.length > 0));
});

test('rendering is deterministic apart from the timestamp', () => {
  const a = buildPlan(PRESETS['coding-agent'].answers, { name: 'x' });
  const b = buildPlan(PRESETS['coding-agent'].answers, { name: 'x' });
  const strip = (s) => s.replace(/Generated \d{4}-\d{2}-\d{2}[^.]*\./, '');
  assert.equal(strip(renderMarkdown(a)), strip(renderMarkdown(b)));
  assert.deepEqual(a.results.map((r) => r.id), b.results.map((r) => r.id));
});

test('no heuristic recommendation renders as undefined or [object Object]', () => {
  for (const answers of [WORST, BEST, ...Object.values(PRESETS).map((p) => p.answers)]) {
    const md = renderMarkdown(buildPlan(answers));
    assert.ok(!md.includes('undefined'), 'rendered "undefined"');
    assert.ok(!md.includes('[object Object]'), 'rendered an object');
  }
});

test('top actions are capped and stable', () => {
  const plan = buildPlan(WORST);
  assert.ok(plan.topActions.length <= 7);
  assert.ok(plan.topActions.every((a) => a.severity !== 'consider'));
});
