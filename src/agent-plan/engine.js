/**
 * Engine: answers → facts → tiers → heuristic results → plan.
 *
 * The plan object is the single intermediate representation. The markdown
 * renderer, the checklist renderer, the JSON export, and the web UI all read
 * from it. Adding an output format should never require touching a heuristic.
 */

import { deriveFacts, validateAnswers } from './facts.js';
import { HEURISTICS, CATEGORIES, FACT_LABELS } from './heuristics.js';
import {
  currentAutonomy, autonomyCeiling, assessSandbox,
  riskFlags, AUTONOMY_TIERS, SANDBOX_TIERS,
} from './tiers.js';
import { SOURCES } from './sources.js';
import { QUESTIONS } from './intake.js';

export const ENGINE_VERSION = '1.0.0';

const SEVERITY_WEIGHT = { must: 3, should: 2, consider: 1 };

function label(fact, value) {
  const name = FACT_LABELS[fact] || fact;
  if (value === true) return name;
  if (Array.isArray(value)) return `${name}: ${value.join(', ')}`;
  return `${name}: ${value}`;
}

/**
 * Run the catalog. Returns only *relevant* results — a heuristic whose `when()`
 * is false is omitted rather than marked "n/a", because a 50-row n/a table
 * trains people to stop reading.
 */
export function runHeuristics(facts) {
  const results = [];
  for (const h of HEURISTICS) {
    let relevant = false;
    try {
      relevant = Boolean(h.when(facts));
    } catch (err) {
      throw new Error(`Heuristic ${h.id} threw in when(): ${err.message}`);
    }
    if (!relevant) continue;

    let because = [];
    try {
      because = (h.because(facts) || []).filter(Boolean);
    } catch { /* because() is cosmetic; never fail the plan over it */ }

    results.push({
      id: h.id,
      title: h.title,
      category: h.category,
      severity: h.severity,
      requirement: h.requirement(facts),
      verify: h.verify,
      antiPattern: h.antiPattern,
      because,
      sources: h.sources,
      weight: SEVERITY_WEIGHT[h.severity],
    });
  }
  const order = { must: 0, should: 1, consider: 2 };
  results.sort((a, b) => order[a.severity] - order[b.severity] || a.id.localeCompare(b.id));
  return results;
}

/**
 * Rank the first things to do. Deterministic and explainable: severity first,
 * then a small boost for categories that fail closed (authority, sandbox) and
 * for heuristics whose triggering facts are the scary ones.
 */
export function topActions(results, limit = 7) {
  const categoryBoost = { authority: 3, sandbox: 3, oversight: 2, evaluation: 2, data: 2 };
  return [...results]
    .filter((r) => r.severity !== 'consider')
    .map((r) => ({
      ...r,
      rank: r.weight * 10 + (categoryBoost[r.category] || 0) + Math.min(r.because.length, 3),
    }))
    .sort((a, b) => b.rank - a.rank || a.id.localeCompare(b.id))
    .slice(0, limit);
}

/**
 * Build the plan.
 * @param {Record<string, any>} answers
 * @param {{name?: string, team?: string, notes?: string}} [meta]
 */
export function buildPlan(answers, meta = {}) {
  const baseFacts = deriveFacts(answers);
  const autonomyNow = currentAutonomy(baseFacts);
  const { tier: ceiling, blockers } = autonomyCeiling(baseFacts);
  const sandbox = assessSandbox(baseFacts);

  const facts = Object.freeze({
    ...baseFacts,
    sandboxTier: sandbox.required.id,
    autonomyTier: autonomyNow.id,
    autonomyCeiling: ceiling.id,
  });

  const results = runHeuristics(facts);
  const flags = riskFlags(facts, autonomyNow, sandbox);

  const byCategory = {};
  for (const key of Object.keys(CATEGORIES)) byCategory[key] = [];
  for (const r of results) byCategory[r.category].push(r);

  const musts = results.filter((r) => r.severity === 'must');
  const currentIdx = AUTONOMY_TIERS.findIndex((t) => t.id === autonomyNow.id);
  const ceilingIdx = AUTONOMY_TIERS.findIndex((t) => t.id === ceiling.id);
  // Signed on purpose: negative means the system is more supervised than the
  // risk profile requires, which is a finding too (you are paying for steps
  // that are not buying safety).
  const exposure = currentIdx - ceilingIdx;

  const sourcesUsed = [...new Set(results.flatMap((r) => r.sources))].sort();

  return {
    engineVersion: ENGINE_VERSION,
    generatedAt: new Date().toISOString(),
    warnings: validateAnswers(answers),
    meta: {
      name: meta.name || 'Untitled agent workflow',
      team: meta.team || '',
      notes: meta.notes || '',
    },
    facts,
    autonomy: {
      current: autonomyNow,
      ceiling,
      blockers,
      exposure,
      overBy: Math.max(0, exposure),
      verdict: exposure > 0 ? 'over-ceiling' : exposure === 0 ? 'at-ceiling' : 'headroom',
    },
    sandbox,
    flags,
    results,
    byCategory,
    topActions: topActions(results),
    counts: {
      must: musts.length,
      should: results.filter((r) => r.severity === 'should').length,
      consider: results.filter((r) => r.severity === 'consider').length,
      critical: flags.filter((f) => f.severity === 'critical').length,
      high: flags.filter((f) => f.severity === 'high').length,
    },
    sourcesUsed,
    questionCount: QUESTIONS.length,
  };
}

/** Sidebar headline used by the UI and the CLI summary. */
export function summarize(plan) {
  const c = plan.counts;
  return [
    `Autonomy: ${plan.autonomy.current.id} ${plan.autonomy.current.name}` +
      (plan.autonomy.exposure > 0 ? ` — OVER CEILING by ${plan.autonomy.exposure} (max ${plan.autonomy.ceiling.id})` : ''),
    `Sandbox floor: ${plan.sandbox.required.id} ${plan.sandbox.required.name}`,
    `Controls: ${c.must} must, ${c.should} should, ${c.consider} consider`,
    `Risks: ${c.critical} critical, ${c.high} high`,
  ].join('\n');
}

export { CATEGORIES, SOURCES, AUTONOMY_TIERS, SANDBOX_TIERS };
