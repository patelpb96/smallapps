/**
 * Intake model.
 *
 * Design note: answers do not get interpreted in prose by the engine. Each
 * option declares the *facts* it asserts. `deriveFacts()` unions those facts.
 * That means a heuristic can never silently disagree with a question label —
 * if the mapping is wrong, it's wrong in exactly one place, visible here.
 *
 * type:
 *   'single'   → one option
 *   'multi'    → set of options (facts OR'd together)
 *   'number'   → numeric fact
 */

/** @typedef {{value: string, label: string, help?: string, facts?: Record<string, any>}} Option */

export const GROUPS = [
  {
    id: 'purpose',
    title: 'What it does',
    blurb: 'Blast radius, reversibility, and how long it runs unsupervised.',
  },
  {
    id: 'surface',
    title: 'What it touches',
    blurb: 'Which inputs are untrusted, which data is sensitive, how data can leave.',
  },
  {
    id: 'execution',
    title: 'How it runs',
    blurb: 'Execution surface, tooling, network reach, secret handling.',
  },
  {
    id: 'oversight',
    title: 'Who is watching',
    blurb: 'Supervision model, human load, accountability.',
  },
  {
    id: 'proof',
    title: 'Proof and plumbing',
    blurb: 'Evaluation assets, observability, budgets, kill switch, regulation.',
  },
];

/** @type {Array<any>} */
export const QUESTIONS = [
  // ── Purpose ──────────────────────────────────────────────────────────────
  {
    id: 'task',
    failSafe: 'consequential',
    group: 'purpose',
    type: 'single',
    prompt: 'What does the agent actually produce?',
    help: 'Pick the highest rung it reaches, not the average.',
    options: [
      { value: 'advice', label: 'Advice or analysis only', help: 'Text in a chat window. Nothing is executed.',
        facts: { actionClass: 'none', reversibility: 'trivial', canWrite: false } },
      { value: 'drafts', label: 'Drafts for a human to send', help: 'Emits an artifact; a person performs the action.',
        facts: { actionClass: 'propose', reversibility: 'trivial', canWrite: false } },
      { value: 'writes', label: 'Writes to systems it can undo', help: 'Creates branches, draft tickets, staging deploys.',
        facts: { actionClass: 'write', reversibility: 'reversible', canWrite: true } },
      { value: 'irreversible', label: 'Irreversible or externally visible changes', help: 'Merges, deploys, deletes, sends, publishes.',
        facts: { actionClass: 'irreversible', reversibility: 'irreversible', canWrite: true, externalVisibility: true } },
      { value: 'consequential', label: 'Money, entitlements, or safety-relevant state', help: 'Payments, refunds, access grants, infra changes.',
        facts: { actionClass: 'consequential', reversibility: 'irreversible', canWrite: true, externalVisibility: true, highStakes: true } },
    ],
  },
  {
    id: 'impact',
    failSafe: 'safety',
    group: 'purpose',
    type: 'single',
    prompt: 'Worst credible outcome if it goes wrong quietly?',
    help: 'Quietly matters — loud failures get caught. This sizes the deterministic controls.',
    options: [
      { value: 'nuisance', label: 'Wasted time', facts: { blastRadius: 1 } },
      { value: 'embarrassment', label: 'Embarrassment or rework', facts: { blastRadius: 2 } },
      { value: 'data-loss', label: 'Data loss or a leak of internal data', facts: { blastRadius: 3, confidentialityRisk: true } },
      { value: 'financial', label: 'Direct financial or contractual loss', facts: { blastRadius: 4, highStakes: true } },
      { value: 'safety', label: 'Harm to people, or regulatory action', facts: { blastRadius: 4, highStakes: true, safetyRelevant: true } },
    ],
  },
  {
    id: 'undo',
    failSafe: 'none',
    group: 'purpose',
    type: 'single',
    prompt: 'How do you undo a bad action?',
    help: 'Untested backups are not a rollback story.',
    options: [
      { value: 'nothing-to-undo', label: 'Nothing to undo', facts: { rollback: 'na' } },
      { value: 'instant', label: 'Automated revert within minutes', facts: { rollback: 'automated' } },
      { value: 'manual', label: 'Restore by hand from a known state', facts: { rollback: 'manual' } },
      { value: 'untested', label: 'Backups exist but restore is untested', facts: { rollback: 'untested', rollbackGap: true } },
      { value: 'none', label: 'Genuinely cannot be undone', facts: { rollback: 'none', rollbackGap: true } },
    ],
  },
  {
    id: 'horizon',
    failSafe: 'continuous',
    group: 'purpose',
    type: 'single',
    prompt: 'How long does a run last?',
    options: [
      { value: 'turn', label: 'One turn, one tool call', facts: { horizon: 'turn' } },
      { value: 'session', label: 'A short conversation or task', facts: { horizon: 'session' } },
      { value: 'hours', label: 'Hours of unattended work', facts: { horizon: 'hours', unattended: true } },
      { value: 'continuous', label: 'Continuous / event-triggered forever', facts: { horizon: 'continuous', unattended: true, selfInitiating: true } },
    ],
  },
  {
    id: 'selfModify',
    failSafe: ['prompts', 'tools', 'memory', 'spawns'],
    group: 'purpose',
    type: 'multi',
    prompt: 'Can it change itself?',
    help: 'Self-modification is the capability that most often voids your threat model.',
    options: [
      { value: 'none', label: 'No', facts: {} },
      { value: 'prompts', label: 'Rewrites its own prompts', facts: { selfModifying: true } },
      { value: 'tools', label: 'Discovers or installs new tools', facts: { selfModifying: true, dynamicTools: true } },
      { value: 'memory', label: 'Persists memory between runs', facts: { persistentMemory: true } },
      { value: 'spawns', label: 'Spawns sub-agents', facts: { multiAgent: true } },
    ],
  },

  // ── Surface ──────────────────────────────────────────────────────────────
  {
    id: 'inputs',
    failSafe: ['web', 'email', 'files', 'agent-output'],
    group: 'surface',
    type: 'multi',
    prompt: 'What content enters its context?',
    help: 'Anything it did not get from you or a trusted system is an injection vector.',
    options: [
      { value: 'user', label: 'Direct messages from your users', facts: {} },
      { value: 'internal', label: 'Internal docs / your own repo', facts: {} },
      { value: 'web', label: 'Web pages or search results', facts: { untrustedContent: true } },
      { value: 'email', label: 'Email, chat, or issue comments from others', facts: { untrustedContent: true } },
      { value: 'files', label: 'Files uploaded by third parties', facts: { untrustedContent: true } },
      { value: 'agent-output', label: 'Output from another agent or tool', facts: { untrustedContent: true } },
      { value: 'none', label: 'Nothing external', facts: {} },
    ],
  },
  {
    id: 'sensitive',
    failSafe: ['credentials', 'customer', 'financial'],
    group: 'surface',
    type: 'multi',
    prompt: 'What sensitive data can it read?',
    options: [
      { value: 'none', label: 'None', facts: {} },
      { value: 'pii', label: 'Personal data (PII)', facts: { sensitiveData: true, privacyRelevant: true } },
      { value: 'credentials', label: 'Credentials, keys, tokens', facts: { sensitiveData: true, secretsInReach: true } },
      { value: 'customer', label: 'Customer records or contracts', facts: { sensitiveData: true, confidentialityRisk: true } },
      { value: 'ip', label: 'Source code or proprietary IP', facts: { sensitiveData: true, confidentialityRisk: true } },
      { value: 'financial', label: 'Financial or health records', facts: { sensitiveData: true, privacyRelevant: true, highStakes: true } },
    ],
  },
  {
    id: 'egress',
    failSafe: ['send', 'webhook', 'public', 'fetch'],
    group: 'surface',
    type: 'multi',
    prompt: 'How can data leave the system?',
    help: 'The third leg of the lethal trifecta. Fetching arbitrary URLs counts as egress.',
    options: [
      { value: 'none', label: 'It cannot', facts: { egress: 'none' } },
      { value: 'reply', label: 'Replies in the UI', facts: {} },
      { value: 'internal-write', label: 'Writes to internal systems', facts: {} },
      { value: 'send', label: 'Sends email / chat / comments', facts: { externalComm: true } },
      { value: 'webhook', label: 'Calls webhooks or third-party APIs', facts: { externalComm: true } },
      { value: 'public', label: 'Publishes publicly', facts: { externalComm: true, publicEgress: true } },
      { value: 'fetch', label: 'Fetches arbitrary URLs', facts: { externalComm: true, arbitraryEgress: true } },
    ],
  },

  // ── Execution ────────────────────────────────────────────────────────────
  {
    id: 'exec',
    failSafe: 'prod',
    group: 'execution',
    type: 'single',
    prompt: 'Where does its code or commands run?',
    options: [
      { value: 'none', label: 'It does not execute anything', facts: { exec: 'none' } },
      { value: 'interpreter', label: 'A hosted code interpreter / sandbox', facts: { exec: 'sandboxed' } },
      { value: 'container', label: 'A container you control', facts: { exec: 'container' } },
      { value: 'ci', label: 'A CI runner with repo write', facts: { exec: 'ci', canWrite: true } },
      { value: 'host', label: 'Shell on a developer or ops machine', facts: { exec: 'host', canWrite: true } },
      { value: 'prod', label: 'With production credentials', facts: { exec: 'prod', canWrite: true, highStakes: true } },
    ],
  },
  {
    id: 'tools',
    failSafe: ['http', 'mcp-third', 'browser', 'computer'],
    group: 'execution',
    type: 'multi',
    prompt: 'Which tool surfaces are exposed?',
    options: [
      { value: 'builtin', label: 'Only your own built-in functions', facts: {} },
      { value: 'http', label: 'First-party HTTP APIs', facts: {} },
      { value: 'mcp-first', label: 'MCP servers you wrote', facts: { usesMcp: true } },
      { value: 'mcp-third', label: 'Third-party MCP servers', facts: { usesMcp: true, thirdPartyTools: true } },
      { value: 'browser', label: 'A browser / DOM automation', facts: { untrustedContent: true, arbitraryEgress: true, externalComm: true } },
      { value: 'computer', label: 'Full desktop control (mouse + keyboard)', facts: { computerUse: true, untrustedContent: true, canWrite: true } },
    ],
  },
  {
    id: 'toolCount',
    group: 'execution',
    type: 'number',
    prompt: 'Roughly how many tools does it choose between?',
    help: 'Selection accuracy degrades with tool count. Under 10 is comfortable; past 30 you need routing.',
    default: 6,
    min: 0,
    max: 200,
    facts: { fact: 'toolCount' },
  },
  {
    id: 'network',
    failSafe: 'open',
    group: 'execution',
    type: 'single',
    prompt: 'Outbound network policy?',
    options: [
      { value: 'none', label: 'No network at all', facts: { network: 'none' } },
      { value: 'allowlist', label: 'Allowlisted destinations', facts: { network: 'allowlist' } },
      { value: 'open', label: 'Open internet', facts: { network: 'open', openNetwork: true } },
    ],
  },
  {
    id: 'secrets',
    failSafe: 'static',
    group: 'execution',
    type: 'single',
    prompt: 'How does it get credentials?',
    help: 'Ambient secrets sit in the execution environment and are stealable by anything that escapes. Brokered secrets are fetched per call, scoped, and expire.',
    options: [
      { value: 'none', label: 'It has no credentials', facts: { credentialTier: 'none' } },
      { value: 'env', label: 'Env vars in its own process', facts: { credentialTier: 'ambient' } },
      { value: 'broker', label: 'Short-lived tokens from a broker', facts: { credentialTier: 'brokered' } },
      { value: 'static', label: 'Long-lived tokens in config', facts: { credentialTier: 'static' } },
    ],
  },

  // ── Oversight ────────────────────────────────────────────────────────────
  {
    id: 'oversight',
    group: 'oversight',
    type: 'single',
    failSafe: 'none',
    prompt: 'What does a human actually see?',
    help: 'Be honest. Nominal oversight is worse than none — it manufactures false assurance.',
    options: [
      { value: 'none', label: 'Nothing until it is done', facts: { oversight: 'none' } },
      { value: 'logs', label: 'Logs, reviewed later', facts: { oversight: 'posthoc' } },
      { value: 'plan', label: 'Approves the plan, then walks away', facts: { oversight: 'plan' } },
      { value: 'per-action', label: 'Approves each side-effecting action', facts: { oversight: 'action' } },
      { value: 'live', label: 'Watches live and can interrupt', facts: { oversight: 'live' } },
    ],
  },
  {
    id: 'opsPerDay',
    group: 'oversight',
    type: 'number',
    prompt: 'Approvals or alerts per person per day?',
    help: 'Above ~20 review points a day, approval becomes a reflex. This is the strongest predictor of rubber-stamping.',
    default: 5,
    min: 0,
    max: 5000,
    facts: { fact: 'opsPerDay' },
  },
  {
    id: 'overseerSkill',
    failSafe: 'novice',
    group: 'oversight',
    type: 'single',
    prompt: 'Can the reviewer tell a good action from a bad one?',
    options: [
      { value: 'novice', label: 'No — they rely on the output looking right', facts: { overseerSkill: 'novice' } },
      { value: 'practitioner', label: 'Yes, with effort and context', facts: { overseerSkill: 'practitioner' } },
      { value: 'expert', label: 'Yes, quickly and reliably', facts: { overseerSkill: 'expert' } },
    ],
  },
  {
    id: 'owner',
    failSafe: 'nobody',
    group: 'oversight',
    type: 'single',
    prompt: 'Who is accountable when it breaks?',
    options: [
      { value: 'named', label: 'A named person', facts: { hasOwner: true } },
      { value: 'team', label: 'A team / distribution list', facts: { hasOwner: false } },
      { value: 'nobody', label: 'Nobody yet', facts: { hasOwner: false } },
    ],
  },

  // ── Proof ────────────────────────────────────────────────────────────────
  {
    id: 'evals',
    failSafe: 'none',
    group: 'proof',
    type: 'single',
    prompt: 'What evaluation assets exist?',
    options: [
      { value: 'none', label: 'None', facts: { evals: 'none' } },
      { value: 'ad-hoc', label: 'Manual spot checks', facts: { evals: 'adhoc' } },
      { value: 'golden', label: 'A labelled golden set', facts: { evals: 'golden' } },
      { value: 'regression', label: 'Golden set + a CI regression gate', facts: { evals: 'regression' } },
    ],
  },
  {
    id: 'observability',
    failSafe: 'none',
    group: 'proof',
    type: 'single',
    prompt: 'What do you record per run?',
    options: [
      { value: 'none', label: 'Nothing structured', facts: { observability: 'none' } },
      { value: 'logs', label: 'Application logs', facts: { observability: 'logs' } },
      { value: 'traces', label: 'Traces with tool calls and token counts', facts: { observability: 'traces' } },
      { value: 'audit', label: 'Traces + immutable audit trail', facts: { observability: 'audit' } },
    ],
  },
  {
    id: 'budget',
    failSafe: 'none',
    group: 'proof',
    type: 'single',
    prompt: 'What stops a runaway loop?',
    options: [
      { value: 'none', label: 'Nothing enforced', facts: { budget: 'none' } },
      { value: 'step', label: 'A max step count', facts: { budget: 'step' } },
      { value: 'per-run', label: 'Per-run token and cost caps', facts: { budget: 'perrun' } },
      { value: 'quotas', label: 'Per-run caps + daily quotas + rate limits', facts: { budget: 'quotas' } },
    ],
  },
  {
    id: 'killswitch',
    failSafe: 'none',
    group: 'proof',
    type: 'single',
    prompt: 'How do you stop it right now?',
    help: 'A kill switch the agent can reach is not a kill switch.',
    options: [
      { value: 'none', label: 'You cannot, cleanly', facts: { killswitch: 'none' } },
      { value: 'ctrlc', label: 'Ctrl-C in the same shell', facts: { killswitch: 'inband' } },
      { value: 'runbook', label: 'A documented runbook', facts: { killswitch: 'runbook' } },
      { value: 'oob', label: 'Out-of-band control, isolated from the agent', facts: { killswitch: 'oob' } },
    ],
  },
  {
    id: 'regulated',
    failSafe: ['gdpr', 'hipaa', 'sox', 'eu-ai-act', 'fedramp'],
    group: 'proof',
    type: 'multi',
    prompt: 'Which regimes apply?',
    options: [
      { value: 'none', label: 'None that I know of', facts: {} },
      { value: 'gdpr', label: 'GDPR / privacy law', facts: { regulated: true, privacyRelevant: true } },
      { value: 'hipaa', label: 'HIPAA / health data', facts: { regulated: true, privacyRelevant: true, highStakes: true } },
      { value: 'sox', label: 'SOX / financial controls', facts: { regulated: true, highStakes: true } },
      { value: 'eu-ai-act', label: 'EU AI Act high-risk', facts: { regulated: true, highStakes: true, euHighRisk: true } },
      { value: 'fedramp', label: 'FedRAMP / public sector', facts: { regulated: true, highStakes: true } },
    ],
  },
  {
    id: 'provider',
    failSafe: 'mixed',
    group: 'proof',
    type: 'single',
    prompt: 'Where does inference happen?',
    options: [
      { value: 'frontier', label: 'A hosted frontier model API', facts: { inference: 'hosted' } },
      { value: 'hosted-small', label: 'A hosted smaller model', facts: { inference: 'hosted' } },
      { value: 'self', label: 'Self-hosted weights', facts: { inference: 'self' } },
      { value: 'mixed', label: 'A mix', facts: { inference: 'mixed' } },
    ],
  },
];

/** Fast-fill presets so the form is usable in 5 seconds. */
export const PRESETS = {
  'research-assistant': {
    label: 'Read-only research assistant',
    answers: {
      task: 'advice', impact: 'embarrassment', undo: 'nothing-to-undo', horizon: 'session',
      selfModify: ['none'], inputs: ['user', 'web'], sensitive: ['none'], egress: ['reply'],
      exec: 'none', tools: ['builtin', 'http'], toolCount: 4, network: 'allowlist', secrets: 'none',
      oversight: 'logs', opsPerDay: 0, overseerSkill: 'practitioner', owner: 'named',
      evals: 'ad-hoc', observability: 'logs', budget: 'step', killswitch: 'ctrlc',
      regulated: ['none'], provider: 'frontier',
    },
  },
  'coding-agent': {
    label: 'Coding agent in a repo',
    answers: {
      task: 'writes', impact: 'data-loss', undo: 'instant', horizon: 'hours',
      selfModify: ['memory'], inputs: ['internal', 'agent-output'], sensitive: ['ip', 'credentials'],
      egress: ['internal-write'], exec: 'container', tools: ['builtin', 'http'], toolCount: 12,
      network: 'allowlist', secrets: 'broker', oversight: 'plan', opsPerDay: 10,
      overseerSkill: 'expert', owner: 'named', evals: 'golden', observability: 'traces',
      budget: 'per-run', killswitch: 'runbook', regulated: ['none'], provider: 'frontier',
    },
  },
  'support-agent': {
    label: 'Customer support with write access',
    answers: {
      task: 'irreversible', impact: 'financial', undo: 'manual', horizon: 'session',
      selfModify: ['memory'], inputs: ['user', 'email'], sensitive: ['pii', 'customer'],
      egress: ['send', 'internal-write'], exec: 'none', tools: ['builtin', 'http'], toolCount: 18,
      network: 'allowlist', secrets: 'broker', oversight: 'per-action', opsPerDay: 60,
      overseerSkill: 'practitioner', owner: 'named', evals: 'golden', observability: 'audit',
      budget: 'per-run', killswitch: 'runbook', regulated: ['gdpr'], provider: 'frontier',
    },
  },
  'ops-agent': {
    label: 'Continuous ops / triage agent',
    answers: {
      task: 'consequential', impact: 'safety', undo: 'untested', horizon: 'continuous',
      selfModify: ['tools', 'memory', 'spawns'], inputs: ['agent-output', 'email', 'web'],
      sensitive: ['credentials', 'customer'], egress: ['send', 'webhook', 'fetch'],
      exec: 'prod', tools: ['builtin', 'http', 'mcp-third'], toolCount: 35, network: 'open',
      secrets: 'static', oversight: 'none', opsPerDay: 400, overseerSkill: 'novice', owner: 'team',
      evals: 'none', observability: 'logs', budget: 'none', killswitch: 'ctrlc',
      regulated: ['sox', 'eu-ai-act'], provider: 'mixed',
    },
  },
};

/** Default answers: the smallest thing that could possibly work. */
export function defaultAnswers() {
  const a = {};
  for (const q of QUESTIONS) {
    if (q.type === 'number') a[q.id] = q.default ?? 0;
    else if (q.type === 'multi') a[q.id] = [];
    else a[q.id] = q.options[0].value;
  }
  return a;
}
