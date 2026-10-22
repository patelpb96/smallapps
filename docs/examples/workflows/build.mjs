#!/usr/bin/env node
/**
 * Rebuilds the "my workflows" diagrams.
 *
 * These are real workflows taken from this machine, not toy examples. Each spec
 * is authored from the source named in the README rather than run through the
 * rule interpreter, because the interpreter gets the *shape* right and the
 * guards wrong: a gate that downgrades an allow to an escalate is not something
 * a lexicon infers. The prose each diagram came from is in the README.
 *
 *   node docs/examples/workflows/build.mjs
 *
 * Writes <slug>.json (laid out, so positions are stable) plus light and dark
 * SVGs. PNGs are rasterised separately; see the README.
 */

import { writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { layout } from '../../../src/flow/index.js';
import { renderSVG } from '../../../src/flow/render.js';
import { analyze } from '../../../src/flow/hazards.js';

const OUT = resolve(import.meta.dirname);

// ── Tiny builders, so the specs read like the thing they describe ───────────
const lane = (id, name, kind = 'system') => ({ id, name, kind });
const node = (id, primitive, label, laneId, props = {}) => ({ id, primitive, label, lane: laneId, props });
const edge = (from, to, extra = {}) => ({ from, to, ...extra });

function spec(title, lanes, nodes, edges) {
  return {
    version: 1,
    title,
    lanes,
    nodes,
    edges: edges.map((e, i) => ({
      id: `e${i + 1}`,
      kind: 'sequence',
      label: '',
      fromPort: 'out',
      ...e,
    })),
    meta: { source: '', interpreter: 'authored' },
  };
}

// ── 1. The destructive-action gate ─────────────────────────────────────────
// Source: ~/.agents/skills/deepseek-operator/assets/guard.py + SKILL.md
// Every terminal says which exit code it is, because the codes are the contract.
const guardGate = spec(
  'Destructive-action gate (guard.py)',
  [
    lane('trigger', 'Trigger', 'system'),
    lane('gate', 'guard.py', 'system'),
    lane('cto', 'Argon (no tools)', 'agent'),
    lane('human', 'Human', 'human'),
  ],
  [
    node('g0', 'trigger-event', 'Destructive action proposed', 'trigger'),
    node('g1', 'decision', 'Routed via guard.py?', 'gate',
      { condition: 'the reviewed path is also the lazy path' }),
    node('g2', 'subprocess', 'Unreviewed bypass, logged', 'gate'),
    node('g3', 'subprocess', 'Build bounded prompt', 'gate'),
    node('g4', 'llm', 'Argon: allow / deny / escalate', 'cto',
      { budget: 'no tools, JSON only', limits: 'cannot see a file you did not paste' }),
    node('g5', 'decision', 'Valid JSON reply?', 'gate'),
    node('g6', 'error', 'Fail closed: deny (3)', 'gate'),
    node('g7', 'decision', 'Allow?', 'gate'),
    node('g8', 'escalate', 'Deny: stop (1)', 'gate'),
    node('g9', 'decision', 'In project, blast radius known?', 'gate'),
    node('g10', 'escalate', 'Escalate: human decides (2)', 'human'),
    node('g11', 'tool-write', 'Log to argon-guard.jsonl', 'gate'),
    node('g12', 'tool-exec', 'Execute the command (0)', 'gate',
      { isolation: 'none: runs with the user permissions' }),
    node('g13', 'end', 'Recorded', 'gate'),
  ],
  [
    edge('g0', 'g1'),
    edge('g1', 'g2', { fromPort: 'false', label: 'no' }),
    edge('g1', 'g3', { fromPort: 'true', label: 'yes' }),
    edge('g3', 'g4'),
    edge('g4', 'g5'),
    edge('g5', 'g6', { fromPort: 'false', label: 'no' }),
    edge('g5', 'g7', { fromPort: 'true', label: 'yes' }),
    edge('g7', 'g8', { fromPort: 'false', label: 'no' }),
    edge('g7', 'g9', { fromPort: 'true', label: 'yes' }),
    edge('g9', 'g10', { fromPort: 'false', label: 'no' }),
    edge('g9', 'g11', { fromPort: 'true', label: 'yes' }),
    edge('g11', 'g12'),
    edge('g12', 'g13'),
    edge('g2', 'g13', { kind: 'async' }),
    edge('g6', 'g13', { kind: 'error' }),
    edge('g8', 'g13', { kind: 'error' }),
    edge('g10', 'g13', { kind: 'error' }),
  ],
);

// ── 2. The supervised worker loop ──────────────────────────────────────────
// Source: ~/.agents/skills/deepseek-operator/SKILL.md, assets/consult.py
// The cycle is intentional, so the loop controller declares its bound — that is
// what stops the hazard check reading it as an unbounded retry.
const supervisorLoop = spec(
  'Supervised worker loop (worker / CTO / harness)',
  [
    lane('human', 'Human', 'human'),
    lane('cto', 'Argon (CTO)', 'agent'),
    lane('worker', 'DeepSeek (worker)', 'agent'),
    lane('harness', 'Harness scripts', 'system'),
  ],
  [
    node('s0', 'trigger-manual', 'Brief + constraints', 'human'),
    node('s1', 'llm', 'CTO plans the next step', 'cto',
      { budget: 'one step, names what would make it wrong' }),
    node('s2', 'llm', 'Worker executes the step', 'worker'),
    node('s3', 'subprocess', 'Guard destructive steps', 'harness'),
    node('s4', 'subprocess', 'Judge: exit code, schema, hash', 'harness'),
    node('s5', 'decision', 'Judge passes?', 'harness'),
    node('s6', 'llm', 'CTO reviews the digest', 'cto',
      { budget: 'ok / drift / violation, quotes evidence' }),
    node('s7', 'classify', 'Flag repeats vs restatements', 'worker',
      { rule: 'a repeat is a spec, not a prompt to try harder' }),
    node('s8', 'decision', 'Verdict ok?', 'harness'),
    node('s9', 'error', 'Retarget: fix the input', 'harness'),
    node('s10', 'decision', 'Budget or stop_case hit?', 'harness',
      { until: 'verdict ok, stop_case, or budget spent', max: 'step and spend cap' }),
    node('s11', 'escalate', 'Stop and report', 'cto'),
    node('s12', 'end', 'Findings + handoff note', 'human'),
  ],
  [
    edge('s0', 's1'),
    edge('s1', 's2'),
    edge('s2', 's3'),
    edge('s3', 's4'),
    edge('s4', 's5'),
    edge('s5', 's6', { fromPort: 'true', label: 'yes' }),
    edge('s5', 's9', { fromPort: 'false', label: 'no' }),
    edge('s6', 's7'),
    edge('s7', 's8'),
    edge('s8', 's10', { fromPort: 'true', label: 'yes' }),
    edge('s8', 's9', { fromPort: 'false', label: 'no' }),
    edge('s9', 's1', { kind: 'loop', label: 'retarget' }),
    edge('s10', 's11', { fromPort: 'true', label: 'yes' }),
    edge('s10', 's1', { fromPort: 'false', label: 'no', kind: 'loop' }),
    edge('s11', 's12'),
  ],
);

// ── 3. The CLI ↔ desktop handoff protocol ──────────────────────────────────
// Source: ~/handoff/README.md — two agents, one folder, four rules.
const handoff = spec(
  'CLI ↔ desktop agent handoff',
  [
    lane('agent', 'Either agent', 'agent'),
    lane('cli', 'CLI agent', 'agent'),
    lane('desk', 'Desktop agent', 'agent'),
  ],
  [
    node('h0', 'trigger-manual', 'Session ends or blocks', 'agent'),
    node('h1', 'tool-read', 'Read the other side', 'agent'),
    node('h2', 'decision', 'Anything to hand off?', 'agent'),
    node('h3', 'tool-write', 'Write a dated note', 'cli'),
    node('h4', 'tool-read', 'Re-read before editing', 'desk',
      { why: 'the other agent may have changed it' }),
    node('h5', 'decision', 'Contains a secret?', 'agent'),
    node('h6', 'escalate', 'Stop: never put keys here', 'agent'),
    node('h7', 'tool-write', 'Append, sign with date', 'agent'),
    node('h8', 'decision', "Finished someone's item?", 'agent'),
    node('h9', 'tool-write', 'Mark DONE, never delete', 'agent'),
    node('h10', 'tool-write', 'Update STATUS.md', 'agent'),
    node('h11', 'end', 'Folder stays consistent', 'agent'),
  ],
  [
    edge('h0', 'h1'),
    edge('h1', 'h2'),
    edge('h2', 'h3', { fromPort: 'true', label: 'yes' }),
    edge('h2', 'h11', { fromPort: 'false', label: 'no' }),
    edge('h3', 'h4'),
    edge('h4', 'h5'),
    edge('h5', 'h6', { fromPort: 'true', label: 'yes' }),
    edge('h5', 'h7', { fromPort: 'false', label: 'no' }),
    edge('h7', 'h8'),
    edge('h8', 'h9', { fromPort: 'true', label: 'yes' }),
    edge('h8', 'h10', { fromPort: 'false', label: 'no' }),
    edge('h9', 'h10'),
    edge('h10', 'h11'),
    edge('h6', 'h11', { kind: 'error' }),
  ],
);

// ── 4. Death, loss and recovery ────────────────────────────────────────────
// Source: Projects/R2S2/DEATH_LOSS_AND_TRAVEL_DESIGN.md
// A different shape: a fan of equally valid choices racing one timer.
const deathLoop = spec(
  'R2S2 — death, loss and the 15-minute race',
  [
    lane('player', 'Player', 'human'),
    lane('world', 'World', 'system'),
    lane('others', 'Players & NPCs', 'system'),
  ],
  [
    node('d0', 'trigger-event', 'Player dies', 'player'),
    node('d1', 'tool-write', 'Drop gear into a death pile', 'world'),
    node('d2', 'wait', '15-minute timer starts', 'world',
      { duration: '15 min', until: 'recovered, looted or expired' }),
    node('d3', 'fork', 'Pick transport', 'player'),
    node('d4', 'subprocess', 'Subway: cheap, fixed stops', 'world'),
    node('d5', 'subprocess', 'Train: long distance', 'world'),
    node('d6', 'subprocess', 'Bus: dense, slow', 'world'),
    node('d7', 'subprocess', 'Uber: anywhere, pricey', 'world'),
    node('d8', 'join', 'Arrive', 'player'),
    node('d9', 'decision', 'Beat the timer?', 'world'),
    node('d10', 'tool-write', 'Anyone nearby can loot it', 'others'),
    node('d11', 'tool-read', 'Recover the loadout', 'player'),
    node('d12', 'tool-write', 'Flat loss: buy cheap again', 'world'),
    node('d13', 'end', 'Back in the world', 'player'),
  ],
  [
    edge('d0', 'd1'),
    edge('d1', 'd2'),
    edge('d2', 'd3'),
    edge('d3', 'd4'),
    edge('d3', 'd5'),
    edge('d3', 'd6'),
    edge('d3', 'd7'),
    edge('d4', 'd8'),
    edge('d5', 'd8'),
    edge('d6', 'd8'),
    edge('d7', 'd8'),
    edge('d8', 'd9'),
    edge('d9', 'd11', { fromPort: 'true', label: 'yes' }),
    edge('d9', 'd10', { fromPort: 'false', label: 'no' }),
    edge('d10', 'd12'),
    edge('d11', 'd13'),
    edge('d12', 'd13'),
  ],
);

// ── Write ──────────────────────────────────────────────────────────────────
const WORKFLOWS = [
  { slug: 'guard-gate', spec: guardGate },
  { slug: 'supervisor-loop', spec: supervisorLoop },
  { slug: 'agent-handoff', spec: handoff },
  { slug: 'death-and-recovery', spec: deathLoop },
];

for (const { slug, spec: raw } of WORKFLOWS) {
  const { spec: laid, size } = layout(raw);
  await writeFile(join(OUT, `${slug}.json`), `${JSON.stringify(laid, null, 2)}\n`, 'utf8');
  await writeFile(join(OUT, `${slug}.svg`), renderSVG(laid, { width: size.w, height: size.h, theme: 'light' }), 'utf8');
  await writeFile(join(OUT, `${slug}-dark.svg`), renderSVG(laid, { width: size.w, height: size.h, theme: 'dark' }), 'utf8');

  const { flags } = analyze(laid);
  const risks = flags.map((f) => `${f.severity}:${f.id}`).join(', ') || 'none';
  process.stdout.write(`${slug.padEnd(20)} ${String(laid.nodes.length).padStart(2)} nodes  ${size.w}x${size.h}  flags: ${risks}\n`);
}
