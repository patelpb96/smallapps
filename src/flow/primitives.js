/**
 * The primitive registry.
 *
 * A primitive is a *typed* box: it says what kind of thing happens, which
 * decides its shape, its colour, its default properties, and — importantly —
 * the effects it has on the world. Effects are what the hazard checks reason
 * about, so adding a primitive means declaring its blast radius, not just its
 * icon.
 *
 * effects vocabulary
 *   untrusted-input   content from outside the trust boundary enters context
 *   sensitive-read    reads private or regulated data
 *   mutates-state     changes a system of record
 *   irreversible      cannot be undone by a revert
 *   external-egress   data can leave to a third party
 *   exec-code         runs generated code or commands
 *   human             a person performs the step
 *   llm               model inference
 */

export const CATEGORY = {
  trigger: { title: 'Triggers', accent: 'violet' },
  human: { title: 'Human steps', accent: 'amber' },
  ai: { title: 'Model steps', accent: 'blue' },
  tool: { title: 'Tools', accent: 'teal' },
  data: { title: 'Data', accent: 'cyan' },
  flow: { title: 'Control flow', accent: 'slate' },
  io: { title: 'Outbound', accent: 'rose' },
  terminal: { title: 'Terminal', accent: 'gray' },
};

/**
 * shape drives the SVG glyph in render.js
 *   rect | round | pill | diamond | hex | slant | cylinder | circle
 */
export const PRIMITIVES = [
  // ── Triggers ────────────────────────────────────────────────────────────
  { id: 'trigger-manual', label: 'Manual start', category: 'trigger', shape: 'circle', glyph: 'play',
    hint: 'A person kicks it off', effects: ['human'],
    props: { actor: 'Operator' } },
  { id: 'trigger-schedule', label: 'Schedule', category: 'trigger', shape: 'pill', glyph: 'clock',
    hint: 'Cron or timer', effects: [],
    props: { actor: 'Scheduler' } },
  { id: 'trigger-event', label: 'Event / webhook', category: 'trigger', shape: 'pill', glyph: 'bolt',
    hint: 'Something outside fires it', effects: ['untrusted-input'],
    props: { actor: 'Event bus' } },
  { id: 'trigger-message', label: 'Inbound message', category: 'trigger', shape: 'pill', glyph: 'mail',
    hint: 'Email, chat, ticket arrives', effects: ['untrusted-input'],
    props: { actor: 'Inbox' } },

  // ── Human ───────────────────────────────────────────────────────────────
  { id: 'human-task', label: 'Human task', category: 'human', shape: 'rect', glyph: 'person',
    hint: 'A person does the work', effects: ['human'],
    props: { actor: 'Teammate' } },
  { id: 'approval', label: 'Approval gate', category: 'human', shape: 'hex', glyph: 'check',
    hint: 'A person authorises before execution', effects: ['human'],
    props: { actor: 'Reviewer', binds: 'action' } },
  { id: 'review', label: 'Review & sign-off', category: 'human', shape: 'rect', glyph: 'eye',
    hint: 'Judgement on a produced artifact', effects: ['human'],
    props: { actor: 'Reviewer' } },
  { id: 'handoff', label: 'Handoff', category: 'human', shape: 'slant', glyph: 'arrow',
    hint: 'Responsibility changes hands', effects: ['human'],
    props: { actor: 'Teammate' } },

  // ── Model ───────────────────────────────────────────────────────────────
  { id: 'llm', label: 'LLM step', category: 'ai', shape: 'round', glyph: 'spark',
    hint: 'One model call', effects: ['llm'],
    props: { actor: 'Agent' } },
  { id: 'agent', label: 'Agent loop', category: 'ai', shape: 'round', glyph: 'loop',
    hint: 'Model chooses tools until done', effects: ['llm', 'exec-code'],
    props: { actor: 'Agent', budget: '20 steps / $2' } },
  { id: 'classify', label: 'Classify', category: 'ai', shape: 'round', glyph: 'tag',
    hint: 'Route into a category', effects: ['llm'],
    props: { actor: 'Agent' } },
  { id: 'extract', label: 'Extract fields', category: 'ai', shape: 'round', glyph: 'scan',
    hint: 'Structured output from text', effects: ['llm'],
    props: { actor: 'Agent' } },
  { id: 'summarize', label: 'Summarise', category: 'ai', shape: 'round', glyph: 'lines',
    hint: 'Reduce text to a shorter form', effects: ['llm'],
    props: { actor: 'Agent' } },
  { id: 'decide', label: 'Model decision', category: 'ai', shape: 'diamond', glyph: 'branch',
    hint: 'The model picks a branch', effects: ['llm'],
    props: { actor: 'Agent' } },

  // ── Tools ───────────────────────────────────────────────────────────────
  { id: 'tool-read', label: 'Read / query', category: 'tool', shape: 'rect', glyph: 'database',
    hint: 'Fetch records or documents', effects: ['sensitive-read'],
    props: { actor: 'System', scope: 'read-only' } },
  { id: 'tool-search', label: 'Web search', category: 'tool', shape: 'rect', glyph: 'globe',
    hint: 'Open-web retrieval', effects: ['untrusted-input'],
    props: { actor: 'System' } },
  { id: 'tool-write', label: 'Write record', category: 'tool', shape: 'rect', glyph: 'pencil',
    hint: 'Create or update state', effects: ['mutates-state'],
    props: { actor: 'System', scope: 'read-write' } },
  { id: 'tool-exec', label: 'Run code', category: 'tool', shape: 'rect', glyph: 'terminal',
    hint: 'Execute generated code', effects: ['exec-code', 'mutates-state'],
    props: { actor: 'Sandbox', isolation: 'container' } },
  { id: 'tool-browser', label: 'Browser automation', category: 'tool', shape: 'rect', glyph: 'cursor',
    hint: 'Click and type in a real UI', effects: ['untrusted-input', 'external-egress'],
    props: { actor: 'Browser' } },

  // ── Data ────────────────────────────────────────────────────────────────
  { id: 'datastore', label: 'Data store', category: 'data', shape: 'cylinder', glyph: 'database',
    hint: 'Database or warehouse', effects: ['sensitive-read'],
    props: { actor: 'System' } },
  { id: 'document', label: 'Document / corpus', category: 'data', shape: 'cylinder', glyph: 'file',
    hint: 'Files, PDFs, knowledge base', effects: ['sensitive-read'],
    props: { actor: 'System' } },
  { id: 'memory', label: 'Agent memory', category: 'data', shape: 'cylinder', glyph: 'layers',
    hint: 'Persists between runs', effects: ['sensitive-read'],
    props: { actor: 'System', ttl: 'unset' } },
  { id: 'queue', label: 'Queue / topic', category: 'data', shape: 'rect', glyph: 'stack',
    hint: 'Async buffering', effects: [],
    props: { actor: 'System' } },

  // ── Control flow ────────────────────────────────────────────────────────
  { id: 'decision', label: 'Decision', category: 'flow', shape: 'diamond', glyph: 'branch',
    hint: 'Explicit branch on a condition', effects: [],
    props: { actor: '', condition: '' } },
  { id: 'fork', label: 'Parallel fork', category: 'flow', shape: 'rect', glyph: 'split',
    hint: 'Fan out, run at the same time', effects: [],
    props: { actor: '' } },
  { id: 'join', label: 'Join', category: 'flow', shape: 'rect', glyph: 'merge',
    hint: 'Wait for all branches', effects: [],
    props: { actor: '' } },
  { id: 'loop', label: 'Loop', category: 'flow', shape: 'hex', glyph: 'loop',
    hint: 'Repeat until a condition', effects: [],
    props: { actor: '', until: '', max: '5' } },
  { id: 'wait', label: 'Wait / delay', category: 'flow', shape: 'pill', glyph: 'clock',
    hint: 'Pause for time or signal', effects: [],
    props: { actor: '', duration: '' } },
  { id: 'subprocess', label: 'Sub-workflow', category: 'flow', shape: 'rect', glyph: 'box',
    hint: 'Delegates to another diagram', effects: [],
    props: { actor: '', ref: '' } },

  // ── Outbound ────────────────────────────────────────────────────────────
  { id: 'notify', label: 'Send message', category: 'io', shape: 'rect', glyph: 'send',
    hint: 'Email, chat, ticket comment', effects: ['external-egress'],
    props: { actor: 'System', channel: '' } },
  { id: 'api-call', label: 'External API', category: 'io', shape: 'rect', glyph: 'plug',
    hint: 'Third-party endpoint', effects: ['external-egress'],
    props: { actor: 'System', endpoint: '' } },
  { id: 'publish', label: 'Publish', category: 'io', shape: 'rect', glyph: 'broadcast',
    hint: 'Public or irreversible release', effects: ['external-egress', 'irreversible'],
    props: { actor: 'System', channel: '' } },

  // ── Terminal ────────────────────────────────────────────────────────────
  { id: 'end', label: 'Done', category: 'terminal', shape: 'circle', glyph: 'stop',
    hint: 'Successful completion', effects: [],
    props: { actor: '' } },
  { id: 'error', label: 'Error path', category: 'terminal', shape: 'rect', glyph: 'alert',
    hint: 'Failure handling', effects: [],
    props: { actor: '' } },
  { id: 'escalate', label: 'Escalate', category: 'terminal', shape: 'rect', glyph: 'up',
    hint: 'Punt to a person or rota', effects: ['human'],
    props: { actor: 'On-call' } },
];

const BY_ID = new Map(PRIMITIVES.map((p) => [p.id, p]));

export function getPrimitive(id) {
  return BY_ID.get(id) || BY_ID.get('llm');
}

export function hasPrimitive(id) {
  return BY_ID.has(id);
}

/** Primitives grouped by category, in registry order. */
export function primitivesByCategory() {
  const out = {};
  for (const key of Object.keys(CATEGORY)) out[key] = [];
  for (const p of PRIMITIVES) out[p.category].push(p);
  return out;
}

/** Union of effects across a list of primitives. */
export function effectsOf(primitiveIds) {
  const s = new Set();
  for (const id of primitiveIds) for (const e of getPrimitive(id).effects) s.add(e);
  return [...s].sort();
}

export const EFFECT_LABELS = {
  'untrusted-input': 'untrusted input',
  'sensitive-read': 'reads sensitive data',
  'mutates-state': 'changes state',
  'irreversible': 'irreversible',
  'external-egress': 'can send data out',
  'exec-code': 'executes code',
  'human': 'human',
  'llm': 'model',
};
