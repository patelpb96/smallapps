/**
 * Tier models.
 *
 * Two independent ladders, because they answer different questions:
 *   - Autonomy:  how much may it decide without a human?
 *   - Sandbox:   how strong is the boundary around what it executes?
 *
 * They are deliberately NOT combined into one score. A read-only agent on open
 * internet and a production deploy bot both "score high" on a naive index while
 * needing completely different controls.
 */

/** Autonomy tiers. Names deliberately describe the human's role, not the model's power. */
export const AUTONOMY_TIERS = [
  {
    id: 'T0',
    name: 'Observe',
    humanRole: 'Operator — human performs every action',
    definition: 'Read-only. Produces analysis, recommendations, or drafts. No side effects reach a system of record.',
    aws: 'Scope 1 — No agency',
    csa: 'L0/L1',
    knight: 'L1–L2',
  },
  {
    id: 'T1',
    name: 'Approve',
    humanRole: 'Approver — human approves each side-effecting action',
    definition: 'Proposes actions; each one is presented and approved before execution. Approval is bound to the parameters.',
    aws: 'Scope 2 — Prescribed agency',
    csa: 'L1',
    knight: 'L2–L3',
  },
  {
    id: 'T2',
    name: 'Supervise',
    humanRole: 'Consultant — human approves a plan, then watches and can interrupt',
    definition: 'Executes an approved plan inside a bounded envelope, notifying on each consequential step. Exceptions escalate.',
    aws: 'Scope 3 — Supervised agency',
    csa: 'L2',
    knight: 'L3',
  },
  {
    id: 'T3',
    name: 'Bounded',
    humanRole: 'Collaborator — human sets the envelope and handles exceptions',
    definition: 'Autonomous within a machine-enforced envelope (tools, destinations, data classes, budgets). Anything outside it halts and asks.',
    aws: 'Scope 3 — Supervised agency (upper bound)',
    csa: 'L3',
    knight: 'L4',
  },
  {
    id: 'T4',
    name: 'Self-directing',
    humanRole: 'Observer — human monitors and holds the off-switch',
    definition: 'Self-initiating, continuous, sets its own sub-goals. Humans review after the fact and can halt.',
    aws: 'Scope 4 — Full agency',
    csa: 'L4–L5',
    knight: 'L5',
  },
];

export const TIER_INDEX = Object.fromEntries(AUTONOMY_TIERS.map((t, i) => [t.id, i]));

/**
 * Where the system actually operates today, derived from who reviews what.
 * Note this is descriptive, not aspirational — an unsupervised agent that can
 * deploy is T4-by-neglect, and saying so is the point.
 */
export function currentAutonomy(f) {
  // With no side effects and no outbound channel, the tier ladder is describing
  // initiative rather than authority — there is nothing to authorise. A
  // read-only agent is T0 unless it starts its own work.
  if (!f.canWrite && !f.externalComm) {
    return (f.selfInitiating || f.horizon === 'continuous')
      ? AUTONOMY_TIERS[4]
      : AUTONOMY_TIERS[0];
  }

  let i;
  switch (f.oversight) {
    case 'action': i = 1; break;
    case 'live':
    case 'plan': i = 2; break;
    case 'posthoc': i = 3; break;
    case 'none':
    default: i = f.canWrite || f.externalComm ? 4 : 3; break;
  }
  // Anything that starts itself or runs for hours drifts up one rung in practice.
  if ((f.selfInitiating || f.horizon === 'continuous') && i < 4) i += 1;
  if (f.oversight === 'action') i = Math.min(i, 1); // per-action approval pins it
  return AUTONOMY_TIERS[i];
}

/**
 * The highest tier at which this design is defensible given its blast radius,
 * reversibility, and the quality of its controls.
 *
 * Every reduction carries a reason, because "your ceiling is T2" is useless
 * without "…because you have no tested rollback on an irreversible action".
 */
export function autonomyCeiling(f) {
  let i = 4;
  const blockers = [];
  const cap = (n, reason, source) => {
    if (i > n) {
      i = n;
      blockers.push({ to: AUTONOMY_TIERS[n].id, reason, source });
    }
  };

  // Sending data out is a side effect even when the action class says
  // "propose" — the human was supposed to be the one pressing send.
  const acts = (f.actionClass === 'propose' && f.externalComm) ? 'write' : f.actionClass;

  // − Intent
  if (acts === 'consequential') {
    cap(2, 'Money, entitlements, or safety-relevant state change needs a human inside the loop.', 'aws-scoping-matrix');
  } else if (acts === 'irreversible') {
    if (f.rollback === 'automated') {
      cap(3, 'Irreversible actions are only defensible at T3 with a tested automated revert.', 'owasp-aisvs-c09');
    } else {
      cap(2, 'Irreversible actions with no tested automated revert need approval before execution.', 'owasp-aisvs-c09');
    }
  } else if (acts === 'write') {
    if (f.actionClass === 'propose') {
      cap(2, 'The action leaves the system (outbound communication) even though a human was meant to send it — that is a write, and it needs a gate.', 'owasp-agentic-top10');
    } else if (f.rollbackGap) {
      cap(2, `Writes are in scope but rollback is "${f.rollback}" — approval must precede the write.`, 'owasp-aisvs-c09');
    } else {
      cap(3, 'Reversible writes can run autonomously inside an envelope, not beyond it.', 'csa-autonomy');
    }
  }

  // − Control quality
  if (f.oversightIsNominal) {
    cap(1, `Oversight is "${f.oversight}" at blast radius ${f.blastRadius} — it cannot function as the control, so the ceiling is T1 until a deterministic gate replaces it.`, 'humans-out-of-loop');
  }
  if (f.approvalFatigueRisk) {
    cap(2, `${f.opsPerDay} review points/day will be rubber-stamped; the reviewer stops being a gate.`, 'humans-out-of-loop');
  }
  if (!f.hasOwner && f.blastRadius >= 3) {
    cap(2, 'No named accountable owner for a blast-radius-3 system.', 'nist-ai-rmf');
  }
  if (f.killswitch !== 'runbook' && f.killswitch !== 'oob' && f.blastRadius >= 3) {
    cap(2, `Kill switch is "${f.killswitch}" — you cannot stop it, so it must not run unattended.`, 'owasp-aisvs-c09');
  }
  if (f.evals === 'none' && f.canWrite) {
    cap(2, 'Write access with no evaluation set: behaviour is unmeasured, so autonomy is unevidenced.', 'agent-eval-survey');
  }
  if (f.selfModifying) {
    cap(2, 'Self-modification invalidates the threat model that justified any higher tier.', 'owasp-aisvs-c09');
  }
  if (f.lethalTrifecta) {
    cap(3, 'All three lethal-trifecta legs are present; exfiltration is one injection away.', 'lethal-trifecta');
  }
  if (f.euHighRisk) {
    cap(3, 'EU AI Act high-risk: human oversight must remain effective, not nominal.', 'eu-ai-act-art14');
  }
  if (f.regulated && f.blastRadius >= 4) {
    cap(3, 'Regulated domain at blast radius 4 requires a documented human decision point.', 'nist-ai-rmf');
  }

  return { tier: AUTONOMY_TIERS[i], blockers };
}

/**
 * Sandbox tiers. S0–S4.
 *
 * The floor is set by what the agent *acts on*, not by how clever it is.
 * Per the SandboxEscapeBench results, treat a plain container as packaging:
 * capable models get out of misconfigured ones reliably, so the hypervisor (or
 * a dedicated host) has to be the actual boundary once secrets are in reach.
 */
export const SANDBOX_TIERS = [
  { id: 'S0', name: 'None', definition: 'No execution. The agent only calls typed APIs through the policy gateway.' },
  { id: 'S1', name: 'Process', definition: 'Dedicated unprivileged user, seccomp/landlock, no network, cgroup limits. Suitable for trusted, reviewed code only.' },
  { id: 'S2', name: 'Hardened container', definition: 'Non-root, read-only rootfs, all caps dropped, no privileged mode, no host mounts, no daemon socket, default-deny egress via proxy.' },
  { id: 'S3', name: 'VM / microVM', definition: 'Container inside a microVM (Firecracker, gVisor, Kata) or a full VM, with a logging egress proxy and ephemeral disk. Kernel boundary is the security boundary.' },
  { id: 'S4', name: 'Dedicated host', definition: 'Single-tenant hardware, no shared kernel, hardware-isolated. For production credentials, safety-relevant actions, or adversarial red-team work.' },
];

export function assessSandbox(f) {
  const reasons = [];
  let i = 0;

  if (!f.arbitraryCodeExec) {
    return { required: SANDBOX_TIERS[0], reasons: ['The agent does not execute code — the network and identity boundary is what matters here.'] };
  }

  switch (f.exec) {
    case 'interpreter':
      i = 2;
      reasons.push('Hosted code interpreter: you inherit the vendor\'s boundary, so verify it rather than assume it.');
      break;
    case 'container':
      i = 2;
      reasons.push('Container you control: S2 baseline is achievable and is the minimum.');
      break;
    case 'ci':
      i = 3;
      reasons.push('CI runner with repo write reaches secrets and protected branches — the runner must be disposable and isolated.');
      break;
    case 'host':
      i = 3;
      reasons.push('Shell on a dev/ops machine: the host is not a boundary, so it must be a disposable one.');
      break;
    case 'prod':
      i = 4;
      reasons.push('Production credentials: no shared kernel, no co-tenancy.');
      break;
    default:
      i = 2;
  }

  if (f.ambientCreds && i < 3) {
    i = 3;
    reasons.push('An ambient credential sits inside the execution environment — a container escape becomes a credential theft, so the boundary has to be a kernel one.');
  }
  if (f.blastRadius >= 4 && i < 3) {
    i = 3;
    reasons.push('Blast radius 4: plain container isolation is not a defensible boundary.');
  }
  if (f.lethalTrifecta && i < 3) {
    i = 3;
    reasons.push('Lethal trifecta: exfiltration needs network egress, so the boundary must include the proxy, not just the container.');
  }
  if (f.openNetwork && f.untrustedContent && i < 3) {
    i = 3;
    reasons.push('Open network plus untrusted content: assume the boundary will be probed.');
  }

  return { required: SANDBOX_TIERS[i], reasons };
}

/** RISK-01..: the things you would want shouted at you before you ship. */
export function riskFlags(f, autonomy, sandbox) {
  const flags = [];
  const add = (id, severity, title, detail, sources) => flags.push({ id, severity, title, detail, sources });

  if (f.lethalTrifecta) {
    add('RISK-trifecta', 'critical', 'Lethal trifecta complete',
      `Sensitive data + untrusted content + outbound communication, all present. Legs: ${f.trifectaLegs.join(', ')}.`,
      ['lethal-trifecta', 'aws-four-principles']);
  }
  if (!f.hasOwner && f.blastRadius >= 3) {
    add('RISK-owner', 'high', 'No named accountable owner',
      'Nobody is answerable for this agent\'s behaviour, and a distribution list will not answer a page.',
      ['nist-ai-rmf', 'iso-42001']);
  }
  if (f.oversightIsNominal) {
    add('RISK-oversight', 'high', 'Oversight is nominal',
      `Human oversight is "${f.oversight}" at blast radius ${f.blastRadius}. It exists on the diagram and not in the control path.`,
      ['humans-out-of-loop', 'eu-ai-act-art14']);
  }
  if (f.approvalFatigueRisk) {
    add('RISK-fatigue', 'high', 'Approval fatigue',
      `${f.opsPerDay} review points per person per day pushes rejection rate toward zero and makes approval a formality.`,
      ['humans-out-of-loop']);
  }
  if (f.rollbackGap && (f.actionClass === 'irreversible' || f.actionClass === 'consequential')) {
    add('RISK-rollback', 'critical', 'Irreversible actions with no tested rollback',
      `Rollback is "${f.rollback}". There is no version of "it went wrong" you can recover from.`,
      ['owasp-aisvs-c09', 'saber']);
  }
  if (f.openNetwork && f.ambientCreds) {
    add('RISK-egress', 'critical', 'Open network with ambient credentials',
      'Unrestricted egress plus a secret sitting in the execution environment is the shortest path from prompt injection to incident.',
      ['owasp-agentic-top10', 'sandbox-escape-bench']);
  }
  if (f.thirdPartyTools && f.usesMcp) {
    add('RISK-supply', 'high', 'Unvetted third-party tool definitions',
      'Third-party tool servers are arbitrary code with your credentials, and their descriptions are an injection surface.',
      ['owasp-mcp-cheatsheet', 'mcp-spec']);
  }
  if (f.selfModifying && f.exec === 'prod') {
    add('RISK-selfmod', 'critical', 'Self-modifying agent with production access',
      'A system that can change its own tools and holds production credentials has no stable threat model.',
      ['owasp-aisvs-c09']);
  }
  if (f.longLivedCreds) {
    add('RISK-creds', 'high', 'Long-lived credentials',
      'Static tokens are the difference between a contained incident and a durable compromise.',
      ['owasp-aisvs-c09', 'mcp-security']);
  }
  if (f.evidenceGap) {
    add('RISK-evidence', 'medium', 'Cannot prove it works',
      `Evaluation assets: ${f.evals}. Observability: ${f.observability}. Every claim about behaviour is currently anecdote.`,
      ['agent-eval-survey', 'nist-ai-600-1']);
  }
  if (f.killswitch === 'none' || f.killswitch === 'inband') {
    add('RISK-kill', 'high', 'No reliable stop',
      `Kill switch is "${f.killswitch}". If stopping it depends on the thing misbehaving, it is not a switch.`,
      ['owasp-aisvs-c09']);
  }
  if (f.publicEgress && f.untrustedContent) {
    add('RISK-public', 'high', 'Untrusted content can reach a public channel',
      'Injected text has a direct route to publication under your brand.',
      ['lethal-trifecta']);
  }
  if (f.budget === 'none' && (f.unattended || f.horizon === 'continuous')) {
    add('RISK-loop', 'high', 'Unbounded unattended loop',
      'No step, token, or spend ceiling on a run that nobody is watching.',
      ['owasp-aisvs-c09']);
  }
  if (f.toolCount >= 30) {
    add('RISK-tools', 'medium', `${f.toolCount} tools in one menu`,
      'Selection accuracy and reviewability both degrade; routing is overdue.',
      ['anthropic-effective-agents', 'agent-eval-survey']);
  }

  const order = { critical: 0, high: 1, medium: 2 };
  return flags.sort((a, b) => order[a.severity] - order[b.severity]);
}
