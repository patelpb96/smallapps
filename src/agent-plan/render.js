/**
 * Renderers. Pure functions of the plan object — no I/O, no globals.
 */

import { CATEGORIES, SOURCES, AUTONOMY_TIERS, SANDBOX_TIERS } from './engine.js';

const SEV_BADGE = { must: '**MUST**', should: '**SHOULD**', consider: '*consider*' };
const RISK_ICON = { critical: '🔴', high: '🟠', medium: '🟡' };

function srcList(ids) {
  return ids.map((id) => {
    const s = SOURCES[id];
    return s ? `[${s.short || s.publisher}, ${s.year}](${s.url})` : id;
  }).join(' · ');
}

function code(v) {
  return `\`${v}\``;
}

/** The full planning document. Optimised for pasting into a design doc. */
export function renderMarkdown(plan) {
  const L = [];
  const { meta, autonomy, sandbox, facts } = plan;

  L.push(`# Agent workflow plan — ${meta.name}`);
  L.push('');
  L.push(`> Generated ${plan.generatedAt.slice(0, 10)} by smallapps/agent-plan v${plan.engineVersion}.`);
  L.push('> Every recommendation below is derived from the intake answers and cites a published standard, spec, or paper.');
  if (meta.team) L.push(`> Team: ${meta.team}`);
  L.push('');

  // ── Verdict ──
  L.push('## Verdict');
  L.push('');
  L.push('| | |');
  L.push('|---|---|');
  L.push(`| **Operating autonomy** | ${autonomy.current.id} ${autonomy.current.name} — ${autonomy.current.definition} |`);
  L.push(`| **Defensible ceiling** | ${autonomy.ceiling.id} ${autonomy.ceiling.name} |`);
  L.push(`| **Sandbox floor** | ${sandbox.required.id} ${sandbox.required.name} |`);
  L.push(`| **Controls required** | ${plan.counts.must} must · ${plan.counts.should} should · ${plan.counts.consider} consider |`);
  L.push(`| **Open risks** | ${plan.counts.critical} critical · ${plan.counts.high} high |`);
  L.push('');

  if (autonomy.exposure > 0) {
    L.push(`### ⚠️ You are running ${autonomy.exposure} tier${autonomy.exposure > 1 ? 's' : ''} above your ceiling`);
    L.push('');
    L.push(`The system operates at **${autonomy.current.id}** but its blast radius, reversibility, and control quality only support **${autonomy.ceiling.id}**. That gap is the finding; the rest of this document is remediation.`);
  } else if (autonomy.exposure === 0) {
    L.push('### At ceiling');
    L.push('');
    L.push('The operating tier matches what the evidence supports. Do not promote until the blockers below are cleared.');
    if (plan.counts.critical) {
      L.push('');
      L.push(`**Being at the right tier is not the same as being safe.** ${plan.counts.critical} critical risk flag${plan.counts.critical > 1 ? 's remain' : ' remains'} — tier and risk are separate questions, and this one is still open.`);
    }
  } else if (!facts.canWrite && !facts.externalComm) {
    L.push('### Read-only');
    L.push('');
    L.push(`No side effects reach a system of record, so the autonomy ladder is advisory here rather than a control: **${autonomy.current.id}** operating against a **${autonomy.ceiling.id}** ceiling. Supervision at this level is about output quality and injection resistance, not about preventing damage. The risk flags below still apply — an agent that can only mislead can still mislead at scale.`);
  } else {
    L.push(`### Headroom — ${Math.abs(autonomy.exposure)} tier${Math.abs(autonomy.exposure) > 1 ? 's' : ''} below ceiling`);
    L.push('');
    L.push(`The system operates at **${autonomy.current.id}** with a defensible ceiling of **${autonomy.ceiling.id}**. You are paying for supervision that the risk profile does not require. That is not automatically wrong — but check each review step is buying something, because unrewarded review is how approvers learn to click through.`);
  }
  L.push('');

  if (autonomy.blockers.length) {
    L.push('**What caps the ceiling**');
    L.push('');
    for (const b of autonomy.blockers) {
      L.push(`- Caps at **${b.to}** — ${b.reason} _(${srcList([b.source])})_`);
    }
    L.push('');
  }

  // ── Risks ──
  if (plan.flags.length) {
    L.push('## Risk flags');
    L.push('');
    for (const f of plan.flags) {
      L.push(`### ${RISK_ICON[f.severity]} ${f.title}`);
      L.push('');
      L.push(f.detail);
      L.push('');
      L.push(`_Sources: ${srcList(f.sources)}_`);
      L.push('');
    }
  }

  // ── Start here ──
  L.push('## Do these first');
  L.push('');
  L.push('Ranked by severity, category criticality, and how many of your answers triggered them.');
  L.push('');
  plan.topActions.forEach((a, i) => {
    L.push(`${i + 1}. **${a.title}** ${SEV_BADGE[a.severity]} — \`${a.id}\``);
    L.push(`   ${a.requirement}`);
  });
  L.push('');

  // ── Autonomy model ──
  L.push('## Autonomy model');
  L.push('');
  L.push('| Tier | Name | Human role | Framework mapping |');
  L.push('|---|---|---|---|');
  for (const t of AUTONOMY_TIERS) {
    const mark = t.id === autonomy.current.id ? ' ← **you**' : t.id === autonomy.ceiling.id ? ' ← ceiling' : '';
    L.push(`| ${t.id}${mark} | ${t.name} | ${t.humanRole} | AWS ${t.aws} · CSA ${t.csa} · Knight ${t.knight} |`);
  }
  L.push('');
  L.push('Tier definitions follow the AWS Agentic AI Security Scoping Matrix, with the Cloud Security Alliance and Knight Institute taxonomies as cross-checks. They agree on the substance and disagree on the numbering, which is why the *human role* is the column that matters.');
  L.push('');
  L.push(`_Sources: ${srcList(['aws-scoping-matrix', 'csa-autonomy', 'knight-autonomy', 'ai-sdlc-autonomy'])}_`);
  L.push('');

  // ── Sandbox ──
  L.push('## Sandbox and execution isolation');
  L.push('');
  L.push(`**Floor: ${sandbox.required.id} ${sandbox.required.name}** — ${sandbox.required.definition}`);
  L.push('');
  L.push('Why:');
  for (const r of sandbox.reasons) L.push(`- ${r}`);
  L.push('');
  L.push('| Tier | Name | Provides |');
  L.push('|---|---|---|');
  for (const t of SANDBOX_TIERS) {
    L.push(`| ${t.id}${t.id === sandbox.required.id ? ' ← floor' : ''} | ${t.name} | ${t.definition} |`);
  }
  L.push('');
  L.push('The floor is set by what the agent acts on, not by how capable the model is. Escaping a *misconfigured* container is a solved problem for frontier models, so once credentials or production systems are in reach the container is packaging and the hypervisor is the boundary.');
  L.push('');
  L.push(`_Sources: ${srcList(['sandbox-escape-bench', 'google-secure-agents', 'owasp-agentic-top10'])}_`);
  L.push('');

  // ── Trifecta ──
  if (facts.trifectaLegs.length) {
    L.push('### Data-flow exposure');
    L.push('');
    L.push('| Leg | Present |');
    L.push('|---|---|');
    L.push(`| Sensitive data reachable | ${facts.sensitiveData ? '✅ yes' : '— no'} |`);
    L.push(`| Untrusted content in context | ${facts.untrustedContent ? '✅ yes' : '— no'} |`);
    L.push(`| Outbound communication | ${facts.externalComm ? '✅ yes' : '— no'} |`);
    L.push('');
    L.push(facts.lethalTrifecta
      ? '**All three legs are present.** Remove one rather than adding a prompt instruction.'
      : 'Two or fewer legs — the design has a defensible gap. Protect it: the usual regression is adding an egress tool later.');
    L.push('');
    L.push(`_Sources: ${srcList(['lethal-trifecta', 'aws-four-principles'])}_`);
    L.push('');
  }

  // ── Controls ──
  L.push('## Required controls');
  L.push('');
  for (const [key, cat] of Object.entries(CATEGORIES)) {
    const items = plan.byCategory[key] || [];
    if (!items.length) continue;
    L.push(`### ${cat.title}`);
    L.push('');
    L.push(`_${cat.blurb}_`);
    L.push('');
    for (const r of items) {
      L.push(`#### ${r.id} — ${r.title} ${SEV_BADGE[r.severity]}`);
      L.push('');
      if (r.because.length) {
        L.push(`*Triggered by:* ${r.because.join('; ')}.`);
        L.push('');
      }
      L.push(r.requirement);
      L.push('');
      L.push(`**Verify:** ${r.verify}`);
      L.push('');
      if (r.antiPattern) {
        L.push(`**Anti-pattern:** ${r.antiPattern}`);
        L.push('');
      }
      L.push(`_${srcList(r.sources)}_`);
      L.push('');
    }
  }

  // ── Sources ──
  L.push('## Sources');
  L.push('');
  L.push('Every rule above traces to one of these. Grouped by kind, ordered by how much weight to give them.');
  L.push('');
  const kinds = { standard: 'Standards & regulatory', spec: 'Specifications', framework: 'Frameworks & vendor guidance', 'vendor-doc': 'Vendor engineering guidance', paper: 'Papers' };
  for (const [kind, title] of Object.entries(kinds)) {
    const ids = plan.sourcesUsed.filter((id) => SOURCES[id]?.kind === kind);
    if (!ids.length) continue;
    L.push(`**${title}**`);
    L.push('');
    for (const id of ids) {
      const s = SOURCES[id];
      L.push(`- **${s.title}** — ${s.publisher}, ${s.year}. <${s.url}>${s.local ? ` · [local copy](${s.local})` : ''}`);
      if (s.note) L.push(`  ${s.note}`);
    }
    L.push('');
  }

  if (meta.notes) {
    L.push('## Notes');
    L.push('');
    L.push(meta.notes);
    L.push('');
  }

  return L.join('\n');
}

/** An implementation checklist you can paste into an issue tracker. */
export function renderChecklist(plan) {
  const L = [];
  L.push(`# Implementation checklist — ${plan.meta.name}`);
  L.push('');
  L.push(`Autonomy ${plan.autonomy.current.id} (ceiling ${plan.autonomy.ceiling.id}) · sandbox floor ${plan.sandbox.required.id}. Generated ${plan.generatedAt.slice(0, 10)}.`);  L.push('');

  if (plan.flags.length) {
    L.push('## Resolve risk flags');
    L.push('');
    for (const f of plan.flags) L.push(`- [ ] ${RISK_ICON[f.severity]} ${f.title} — ${f.detail}`);
    L.push('');
  }

  for (const [key, cat] of Object.entries(CATEGORIES)) {
    const items = plan.byCategory[key] || [];
    if (!items.length) continue;
    L.push(`## ${cat.title}`);
    L.push('');
    for (const r of items) {
      L.push(`- [ ] ${SEV_BADGE[r.severity]} **${r.title}** \`${r.id}\``);
      L.push(`      Verify: ${r.verify}`);
    }
    L.push('');
  }

  L.push('## Sign-off');
  L.push('');
  L.push('- [ ] Named owner recorded in the service catalogue');
  L.push(`- [ ] Risk acceptance signed for operating at ${plan.autonomy.current.id}`);
  L.push('- [ ] Kill switch exercised in the last 30 days');
  L.push('- [ ] Eval suite green on the deployed prompt + tool schema + model version triple');
  L.push('');
  return L.join('\n');
}

/** Compact JSON for machine consumers and for saving/reloading a session. */
export function renderJson(plan) {
  return JSON.stringify({
    engineVersion: plan.engineVersion,
    generatedAt: plan.generatedAt,
    meta: plan.meta,
    autonomy: {
      current: plan.autonomy.current.id,
      ceiling: plan.autonomy.ceiling.id,
      exposure: plan.autonomy.exposure,
      blockers: plan.autonomy.blockers,
    },
    sandbox: { required: plan.sandbox.required.id, reasons: plan.sandbox.reasons },
    flags: plan.flags.map(({ id, severity, title }) => ({ id, severity, title })),
    controls: plan.results.map(({ id, title, category, severity, requirement, verify, sources }) => ({
      id, title, category, severity, requirement, verify, sources,
    })),
  }, null, 2);
}
