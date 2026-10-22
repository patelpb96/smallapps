/**
 * Fact derivation.
 *
 * Answers → facts → heuristics. Nothing downstream reads the raw answers, so
 * the entire interpretation of the form lives in this one function and is
 * covered by tests.
 */

import { QUESTIONS } from './intake.js';

const BY_ID = new Map(QUESTIONS.map((q) => [q.id, q]));

/**
 * @param {Record<string, any>} answers
 * @returns {Readonly<Record<string, any>>} facts
 */
export function deriveFacts(answers) {
  const facts = {
    // baseline — every fact must exist so heuristics never see undefined
    actionClass: 'none',
    reversibility: 'trivial',
    canWrite: false,
    externalVisibility: false,
    blastRadius: 1,
    highStakes: false,
    safetyRelevant: false,
    confidentialityRisk: false,
    privacyRelevant: false,
    rollback: 'na',
    rollbackGap: false,
    horizon: 'turn',
    unattended: false,
    selfInitiating: false,
    selfModifying: false,
    dynamicTools: false,
    persistentMemory: false,
    multiAgent: false,
    untrustedContent: false,
    sensitiveData: false,
    credentialTier: 'none',
    secretsInReach: false,
    ambientCreds: false,
    longLivedCreds: false,
    egress: 'none',
    externalComm: false,
    publicEgress: false,
    arbitraryEgress: false,
    exec: 'none',
    usesMcp: false,
    thirdPartyTools: false,
    computerUse: false,
    toolCount: 0,
    network: 'none',
    openNetwork: false,
    oversight: 'none',
    opsPerDay: 0,
    overseerSkill: 'novice',
    hasOwner: false,
    evals: 'none',
    observability: 'none',
    budget: 'none',
    killswitch: 'none',
    regulated: false,
    euHighRisk: false,
    inference: 'hosted',
  };

  // Numbers
  for (const q of QUESTIONS) {
    if (q.type !== 'number') continue;
    const raw = answers[q.id];
    const n = Number(raw);
    facts[q.id] = Number.isFinite(n) ? clamp(n, q.min ?? 0, q.max ?? 1e9) : (q.default ?? 0);
  }

  // Single-select.
  //
  // Two different kinds of "not a real answer", handled differently:
  //   absent   → the caller did not answer; take the question's default (the
  //              first option), which is also what the form shows.
  //   invalid  → the caller answered something unrecognised; take the
  //              fail-safe option, which is always the more dangerous reading.
  //              A stale or hand-edited answer file must never make the
  //              assessment look safer than the system actually is.
  for (const q of QUESTIONS) {
    if (q.type !== 'single') continue;
    const raw = answers[q.id];
    const absent = raw === undefined || raw === null || raw === '';
    let value = absent ? q.options[0].value : raw;
    let chosen = q.options.find((o) => o.value === value);
    if (!chosen) {
      value = q.failSafe ?? q.options[0].value;
      chosen = q.options.find((o) => o.value === value);
    }
    if (chosen) Object.assign(facts, chosen.facts || {});
  }

  // Multi-select: 'none' is absorbing; absent means nothing selected.
  for (const q of QUESTIONS) {
    if (q.type !== 'multi') continue;
    const raw = answers[q.id];
    const absent = raw === undefined || raw === null;
    const supplied = Array.isArray(raw) ? raw : [];
    const known = supplied.filter((v) => q.options.some((o) => o.value === v));
    const selected = absent ? [] : (known.length ? known : (q.failSafe ?? []));
    if (selected.includes('none')) continue;
    for (const value of selected) {
      const opt = q.options.find((o) => o.value === value);
      if (!opt) continue;
      // Booleans OR, enum-ish facts take the "worst" (last selected wins by design order)
      for (const [k, v] of Object.entries(opt.facts || {})) {
        if (typeof v === 'boolean') facts[k] = facts[k] || v;
        else if (v !== undefined) facts[k] = v;
      }
    }
  }

  // ── Derived ─────────────────────────────────────────────────────────────

  // Credential exposure. Three distinct things get conflated in a lot of
  // guidance, so keep them apart:
  //   secretsInReach – a credential is involved in the tool path at all
  //   ambientCreds   – a usable secret sits in the execution environment,
  //                    so a sandbox escape yields a credential
  //   longLivedCreds – the credential outlives the run and the incident
  facts.secretsInReach = facts.credentialTier !== 'none';
  facts.ambientCreds = facts.credentialTier === 'ambient' || facts.credentialTier === 'static';
  facts.longLivedCreds = facts.credentialTier === 'static';

  // The lethal trifecta: private data + untrusted content + external comms.
  facts.trifectaLegs = [
    facts.sensitiveData && 'sensitive-data',
    facts.untrustedContent && 'untrusted-content',
    facts.externalComm && 'external-comms',
  ].filter(Boolean);
  facts.lethalTrifecta = facts.trifectaLegs.length === 3;

  // Codes executes; shell-in-a-container is still executes-with-network.
  facts.arbitraryCodeExec = facts.exec !== 'none' || facts.computerUse;

  // Autonomy pressure: what pushes you up the tier ladder.
  facts.autonomyPressure = 0
    + (facts.selfInitiating ? 2 : 0)
    + (facts.unattended ? 1 : 0)
    + (facts.horizon === 'continuous' ? 2 : facts.horizon === 'hours' ? 1 : 0)
    + (facts.multiAgent ? 1 : 0)
    + (facts.selfModifying ? 2 : 0);

  // Review load that a human is being asked to sustain.
  facts.reviewLoad = facts.opsPerDay;
  facts.approvalFatigueRisk = facts.opsPerDay > 20 && facts.oversight !== 'live';

  // Can the human actually catch a bad action?
  facts.oversightIsNominal =
    facts.oversight === 'none' ||
    (facts.oversight === 'posthoc' && facts.blastRadius >= 3) ||
    (facts.oversight === 'action' && facts.approvalFatigueRisk) ||
    (facts.oversight === 'plan' && facts.blastRadius >= 3);

  // Evidence gap: you cannot claim a control you cannot observe.
  facts.evidenceGap = facts.evals === 'none' || facts.observability === 'none';

  // Blast radius escalators
  if (facts.credentialTier !== 'none' && facts.blastRadius < 3) facts.blastRadius = 3;
  if (facts.lethalTrifecta && facts.blastRadius < 3) facts.blastRadius = 3;
  if (facts.actionClass === 'consequential' && facts.blastRadius < 4) facts.blastRadius = 4;

  return Object.freeze(facts);
}

/**
 * Report answers that do not correspond to any declared option.
 *
 * These are not cosmetic: they mean the plan was computed against assumptions
 * the caller did not intend, so the caller has to be told.
 */
export function validateAnswers(answers) {
  const warnings = [];
  for (const q of QUESTIONS) {
    if (q.type === 'number') {
      const n = Number(answers[q.id]);
      if (answers[q.id] !== undefined && !Number.isFinite(n)) {
        warnings.push({ question: q.id, value: answers[q.id], fallback: q.default ?? 0,
          message: `"${q.id}" is not a number; assumed ${q.default ?? 0}` });
      }
      continue;
    }
    const values = q.type === 'multi'
      ? (Array.isArray(answers[q.id]) ? answers[q.id] : (answers[q.id] === undefined ? [] : [answers[q.id]]))
      : [answers[q.id]];
    if (q.type === 'multi' && !Array.isArray(answers[q.id]) && answers[q.id] !== undefined) {
      warnings.push({ question: q.id, value: answers[q.id], fallback: q.failSafe,
        message: `"${q.id}" expects a list; assumed the fail-safe set` });
      continue;
    }
    for (const v of values) {
      if (v === undefined) continue;
      if (!q.options.some((o) => o.value === v)) {
        warnings.push({ question: q.id, value: v, fallback: q.failSafe,
          message: `"${v}" is not a valid option for "${q.id}"; assumed the fail-safe value` });
      }
    }
  }
  return warnings;
}

function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

export const FACTS_BY_ID = BY_ID;
