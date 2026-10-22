#!/usr/bin/env node
/**
 * Referential integrity checks that the unit tests cannot do cheaply:
 * files that must exist on disk, presets that point at real questions,
 * assets the HTML actually references.
 *
 *   node scripts/lint-refs.js
 */

import { readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { HEURISTICS, SOURCES, QUESTIONS, PRESETS } from '../src/index.js';

const ROOT = resolve(import.meta.dirname, '..');
const problems = [];
const notes = [];

const exists = (rel) => existsSync(join(ROOT, rel));

// 1. Local paper copies referenced by sources must be on disk.
for (const [id, s] of Object.entries(SOURCES)) {
  if (s.local && !exists(s.local)) problems.push(`source "${id}" points at missing file: ${s.local}`);
}

// 2. Downloaded papers that nothing cites are dead weight.
const citedLocals = new Set(Object.values(SOURCES).map((s) => s.local).filter(Boolean));
const { readdir } = await import('node:fs/promises');
for (const f of await readdir(join(ROOT, 'docs/papers'))) {
  if (f.endsWith('.md')) continue;
  const rel = `docs/papers/${f}`;
  if (!citedLocals.has(rel)) notes.push(`uncited paper on disk: ${rel}`);
}

// 3. Presets must not reference unknown question ids or invalid option values.
for (const [key, p] of Object.entries(PRESETS)) {
  for (const [qid, val] of Object.entries(p.answers)) {
    const q = QUESTIONS.find((x) => x.id === qid);
    if (!q) { problems.push(`preset "${key}" sets unknown question "${qid}"`); continue; }
    if (q.type === 'number') {
      if (typeof val !== 'number') problems.push(`preset "${key}" sets non-numeric "${qid}"`);
      continue;
    }
    const values = Array.isArray(val) ? val : [val];
    for (const v of values) {
      if (!q.options.some((o) => o.value === v)) {
        problems.push(`preset "${key}" sets "${qid}" to invalid option "${v}"`);
      }
    }
  }
}

// 4. Every question must be reachable from at least one preset or be core intake.
for (const q of QUESTIONS) {
  if (!Object.values(PRESETS).some((p) => q.id in p.answers)) {
    notes.push(`question "${q.id}" is not covered by any preset (fine, just noting)`);
  }
}

// 5. HTML asset references resolve on disk.
const html = await readFile(join(ROOT, 'apps/agent-plan/index.html'), 'utf8');
for (const m of html.matchAll(/(?:src|href)="(\.\/[^"]+)"/g)) {
  const rel = join('apps/agent-plan', m[1]);
  if (!exists(rel)) problems.push(`index.html references missing asset: ${rel}`);
}

// 6. Every paper actually looks like a PDF (guards against saved error pages).
for (const f of await readdir(join(ROOT, 'docs/papers'))) {
  if (!f.endsWith('.pdf')) continue;
  const buf = await readFile(join(ROOT, 'docs/papers', f));
  if (buf.subarray(0, 5).toString() !== '%PDF-') {
    problems.push(`docs/papers/${f} is not a PDF (${buf.length} bytes) — probably a saved error page`);
  }
  const kb = Math.round((await stat(join(ROOT, 'docs/papers', f))).size / 1024);
  if (kb < 50) problems.push(`docs/papers/${f} is suspiciously small (${kb} KB)`);
}

// 7. Every source is cited by at least one heuristic or tier blocker.
const cited = new Set(HEURISTICS.flatMap((h) => h.sources));
for (const id of Object.keys(SOURCES)) {
  if (!cited.has(id)) {
    // tiers.js blockers cite a few directly; allow those explicitly.
    const allowed = new Set(['nist-ai-rmf', 'iso-42001', 'aws-scoping-matrix', 'csa-autonomy', 'knight-autonomy', 'ai-sdlc-autonomy', 'google-secure-agents']);
    if (!allowed.has(id)) notes.push(`source "${id}" is declared but never cited`);
  }
}

// 8. Numeric claims in the README must match reality. Stale marketing numbers
//    are the most common way a README starts lying.
const readme = await readFile(join(ROOT, 'README.md'), 'utf8');
const paperCount = (await readdir(join(ROOT, 'docs/papers'))).filter((f) => f.endsWith('.pdf')).length;
const claims = [
  [/(\d+) heuristics/, HEURISTICS.length, 'heuristics'],
  [/(\d+) entries/, Object.keys(SOURCES).length, 'source entries'],
  [/(\d+) downloaded/, paperCount, 'downloaded papers'],
  [/(\d+) papers, checked in/, paperCount, 'checked-in papers'],
  [/(\d+) questions/, QUESTIONS.length, 'questions'],
];
for (const [re, actual, label] of claims) {
  for (const m of readme.matchAll(new RegExp(re, 'g'))) {
    if (Number(m[1]) !== actual) {
      problems.push(`README claims ${m[1]} ${label}, actual is ${actual}`);
    }
  }
}

// ── Report ────────────────────────────────────────────────────────────────
for (const n of notes) process.stdout.write(`note: ${n}\n`);
if (problems.length) {
  for (const p of problems) process.stderr.write(`FAIL: ${p}\n`);
  process.stderr.write(`\n${problems.length} referential integrity problem(s).\n`);
  process.exit(1);
}
process.stdout.write(`\nok — ${Object.keys(SOURCES).length} sources, ${HEURISTICS.length} heuristics, ${QUESTIONS.length} questions, ${Object.keys(PRESETS).length} presets all consistent.\n`);
