/**
 * Natural language → spec.
 *
 * This is the *default* interpreter and it is deliberately boring: a lexicon,
 * a clause splitter, and a state machine. No network, no key, no surprises, and
 * every decision is inspectable and unit-testable.
 *
 * It is not trying to understand English. It is trying to land most real
 * workflow descriptions — "when X, the agent does Y, then an engineer approves,
 * and if approved we post to Slack" — into a graph you then fix by hand. The
 * editor is the escape hatch for everything the rules get wrong, which is why
 * interpretation is a separate layer rather than baked into the framework.
 *
 * An LLM adapter produces the same spec shape; see apps/flow/llm.js.
 */

import { emptySpec, normalizeSpec, slug } from './spec.js';
import { getPrimitive } from './primitives.js';

// ── Lexicons ────────────────────────────────────────────────────────────────

/** Longer phrases first so "triage agent" wins over "agent". */
const W = String.fromCharCode(92);

/** "once approved, it is published" → the prefix qualifies the flow, not the step. */
const TRAILING_CONDITION = new RegExp(
  "^(?:once|if|when|after)" + W + "s+(?:approved|authorised|authorized|signed off|reviewed)"
    + W + "b[,:]?" + W + "s*(?:it" + W + "s+is" + W + "s+)?",
  "i",
);

const ACTOR_NOUNS = [
  'on-call engineer', 'on-call', 'triage agent', 'support agent', 'coding agent',
  'research agent', 'review agent', 'safety agent', 'orchestrator', 'supervisor',
  'engineer', 'reviewer', 'approver', 'manager', 'analyst', 'operator', 'teammate',
  'user', 'customer', 'human', 'person', 'team', 'agent', 'assistant', 'bot',
  'copilot', 'model', 'system', 'service', 'worker pool', 'worker', 'pipeline',
  'scheduler', 'webhook', 'cron', 'inbox', 'queue',
];

const HUMAN_NOUNS = new Set([
  'on-call engineer', 'on-call', 'engineer', 'reviewer', 'approver', 'manager',
  'analyst', 'operator', 'teammate', 'user', 'customer', 'human', 'person', 'team',
]);

const AGENT_NOUNS = new Set([
  'triage agent', 'support agent', 'coding agent', 'research agent', 'review agent',
  'safety agent', 'agent', 'assistant', 'bot', 'copilot', 'orchestrator', 'supervisor',
]);

/** Words that can never be part of an actor name. */
const STOP_QUAL = /^(?:the|a|an|and|then|also|its|their|our|your|this|that|these|those|all|both|each|every|just|only|still|already|always|never|finally|next|first|last|in|to|from|on|at|by|for|with|of|into|over|under|after|before|when|if|while|is|are|was|were|will|can|should|must|may|parallel|simultaneously|concurrently|same|time)$/;

/**
 * Verb → primitive, most specific first.
 * Order matters: "approves an escalation" is an approval, not an escalation;
 * "reads the files" is a read, not a write.
 */
const VERB_RULES = [
  { re: /\b(approves?|approved|approving|approval|signs? off|signed off|authori[sz]es?|greenlights?)\b/, p: 'approval' },
  { re: /\b(escalates?|escalated|escalating|escalate)\b/, p: 'escalate' },
  { re: /\b(reviews?|reviewed|reviewing|inspects?|audits?|verif(?:y|ies)|sanity[- ]checks?)\b/, p: 'review' },
  { re: /\b(decides?|decided|determin(?:e|es)|assess(?:es)?|evaluat(?:e|es)|checks? (?:if|whether))\b/, p: 'decide' },
  { re: /\b(publish(?:es)?|published|deploys?|deployed|releases?|ships?)\b/, p: 'publish' },
  { re: /\b(notif(?:y|ies)|sends?|sent|posts?|posting|emails?|messages?|dms?|pings?|alerts?|slacks?|tells?)\b/, p: 'notify' },
  { re: /\b(calls?|invokes?|requests?)\b(?=.*\b(?:api|endpoint|service|webhook)\b)/, p: 'api-call' },
  { re: /\b(browses?|clicks?|scrapes?)\b/, p: 'tool-browser' },
  { re: /\b(searches?|googles?|web[- ]searches?)\b/, p: 'tool-search' },
  { re: /\b(runs?|running|executes?|executed)\b/, p: 'tool-exec' },
  { re: /\b(reads?|reading|fetches?|retrieves?|quer(?:y|ies)|loads?|pulls?|gets?|looks? up|looks? at|matches?|reconcil(?:e|es)|checks? against)\b/, p: 'tool-read' },
  { re: /\b(writes?|writing|updates?|saves?|stores?|persists?|creates?|submits?|appends?|patches?|inserts?)\b/, p: 'tool-write' },
  { re: /\b(classif(?:y|ies)|categori[sz]es?|triages?|tags?|labels?)\b/, p: 'classify' },
  { re: /\b(extracts?|parses?|pulls? out|normalis(?:es)?|normaliz(?:es)?)\b/, p: 'extract' },
  { re: /\b(summar(?:y|ies|ises|izes|ized|ised)|condenses?|digests?|briefs?)\b/, p: 'summarize' },
  { re: /\b(repeats?|loops?|iterates?)\b/, p: 'loop' },
  { re: /\b(waits?|pauses?|sleeps?|delays?|holds?)\b/, p: 'wait' },
  { re: /\b(retr(?:y|ies)|fails?|errors?|exceptions?)\b/, p: 'error' },
  { re: /\b(hands? off|handoff|assigns?|delegates?)\b/, p: 'handoff' },
  { re: /\b(ends?|finishes?|done|completes?|closes?|stops?)\b/, p: 'end' },
  { re: /\b(generates?|drafts?|composes?|produces?|translates?|plans?|reasons?|thinks?|analys(?:e|es)|analy[sz]es?|rewrites?|suggests?|evaluates? the)\b/, p: 'llm' },
];

const TRIGGER_CUES = /^\s*(?:when|whenever|once|upon|on|after|every|each time|as soon as)\b/i;
const CONDITION_CUES = /^\s*(?:if|unless|whether|in case)\b/i;
const ELSE_CUES = /^\s*(?:else|otherwise|if not|if it is not|if it isn't|if the answer is no)\b[,:]?\s*/i;

const SEQUENCE_MARKERS = /(?:^|[.;]|\s)(?:and then|and after that|after that|afterwards?|next|finally|followed by|then|subsequently)\s+/gi;
const PARALLEL_CUE = /\b(in parallel|simultaneously|at the same time|concurrently|both)\b/i;
const ARROW = /\s*(?:-->|->|=>|→|➜|⇒)\s*/;

// ── Text helpers ────────────────────────────────────────────────────────────

const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
const unescapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function tidy(s) {
  return String(s || '')
    .replace(/\s+/g, ' ')
    .replace(/^[\s,;:–—-]+|[\s,;:.]+$/g, '')
    .trim();
}

function truncate(s, n = 72) {
  if (s.length <= n) return s;
  const cut = s.slice(0, n);
  const at = cut.lastIndexOf(' ');
  return `${(at > n * 0.55 ? cut.slice(0, at) : cut).trim()}…`;
}

/** Which primitive does this clause describe? */
export function classifyVerb(clause) {
  const low = String(clause).toLowerCase();
  for (const rule of VERB_RULES) if (rule.re.test(low)) return rule.p;
  return null;
}

/**
 * Find the acting noun phrase.
 *
 * A candidate is only the subject if it is at the start of the clause or is
 * immediately followed by a verb — otherwise it is the object, and "fetches
 * customer records" must not produce a "customer" actor.
 */
export function findActors(clause) {
  const low = String(clause).toLowerCase();
  const found = [];
  for (const noun of ACTOR_NOUNS) {
    // Built from a plain string, not a template literal: `\b` inside a template
    // is a backspace character, not a word boundary.
    const re = new RegExp('(^|[^a-z-])(' + unescapeRe(noun) + ')(?![a-z-])', 'g');
    let m;
    while ((m = re.exec(low))) {
      const index = m.index + m[1].length;
      re.lastIndex = index + m[2].length;

      const before = low.slice(0, index).trim();
      const words = before ? before.split(/\s+/) : [];

      // Walk backwards at most two words for a qualifier ("triage", "on-call"),
      // and only across a determiner. Without that gate, "a billing issue an
      // on-call engineer" mints a lane called "Issue On-call engineer".
      const qualifiers = [];
      for (let i = words.length - 1, taken = 0; i >= 0 && taken < 2; i--, taken++) {
        const w = words[i];
        if (STOP_QUAL.test(w) || classifyVerb(w)) break;
        if (i === 0 || /^(?:the|a|an)$/.test(words[i - 1] || '')) { qualifiers.unshift(w); break; }
        break;
      }

      // Subject or object? Start of clause, or immediately followed by a verb.
      const atStart = before === '' || /^(?:the|a|an)$/.test(before);
      const rest = low.slice(index + m[2].length).trim();
      const nextWord = (rest.split(/\s+/)[0] || '').replace(/[^a-z-]/g, '');
      if (!atStart && !(nextWord && classifyVerb(nextWord))) continue;

      found.push({ noun, phrase: [...qualifiers, noun].join(' '), start: index, length: noun.length });
    }
  }
  return found.sort((a, b) => a.start - b.start);
}

/** The acting subject, or null. */
export function findActor(clause) {
  return findActors(clause)[0] || null;
}

/**
 * Split a condition from its consequence when they share a clause:
 * "the amount is over $5,000 a manager approves it" →
 *   condition "the amount is over $5,000" + rest "a manager approves it"
 *
 * Only splits on an actor that is (a) not at the start and (b) followed by a
 * verb, so "the customer is on an enterprise plan" stays whole.
 */
export function splitConditionBody(body) {
  const text = String(body || '');
  for (const actor of findActors(text)) {
    if (actor.start < 10) continue;
    const after = text.slice(actor.start + actor.length);
    const nextWord = (after.trim().split(/\s+/)[0] || '').replace(/[^a-z-]/g, '');
    if (!nextWord || !classifyVerb(nextWord)) continue;
    let condition = tidy(text.slice(0, actor.start));
    let rest = tidy(text.slice(actor.start));
    // "…issue | an on-call engineer…" — the determiner belongs with the actor.
    const det = condition.match(/(?:^|[ ])(the|a|an)$/);
    if (det) {
      condition = tidy(condition.slice(0, condition.length - det[0].length));
      rest = tidy(`${det[1]} ${rest}`);
    }
    if (condition.split(/\s+/).length < 2 || !rest) continue;
    return { condition, rest };
  }
  return { condition: tidy(text), rest: '' };
}

/** Remove the actor phrase and a leading article/pronoun from a clause. */
function stripActor(clause, actor) {
  let s = clause;
  if (actor) s = s.replace(new RegExp(`\\b(?:the|a|an)?\\s*${unescapeRe(actor.phrase)}\\b`, 'i'), ' ');
  return tidy(s.replace(/^(?:the|a|an|it|they|we|he|she)\s+/i, ''));
}

function actorKind(actor) {
  if (!actor) return 'system';
  if (HUMAN_NOUNS.has(actor.noun)) return 'human';
  if (AGENT_NOUNS.has(actor.noun)) return 'agent';
  return 'system';
}

// ── Clause splitting ────────────────────────────────────────────────────────

/**
 * Split prose into clause-sized units: sentences, then sequence markers, then
 * commas that introduce a new subject, then conjunctions that introduce a new
 * verb phrase. Each stage can decline to split, which keeps lists and compound
 * objects intact.
 */
export function splitClauses(text) {
  const out = [];
  const sentences = String(text).split(/(?<=[.!?])\s+(?=[A-Z0-9*\-])|\n+/);
  for (const raw of sentences) {
    let s = raw.trim();
    if (!s) continue;
    const bullet = /^([-*•]|\d+[.)])\s+/.test(s);
    s = s.replace(/^([-*•]|\d+[.)])\s+/, '');

    // A sentence that says "in parallel" keeps its "and" so the fork handler
    // downstream can see both branches.
    const parallel = PARALLEL_CUE.test(s);

    // "Every hour the pipeline reads rows" → the schedule is the trigger and
    // the reading is the first step. Keeping them fused loses the step.
    const schedule = s.match(
      /^((?:every|each)\s+(?:[a-z]+\s+)?(?:hour|day|week|month|morning|evening|night|minute)s?(?:\s+at\s+[0-9]{1,2}(?::[0-9]{2})?\s*(?:am|pm)?)?)(?=\s|,|$)/i,
    );
    if (schedule && s.length > schedule[1].length + 4) {
      const rest = s.slice(schedule[1].length).replace(/^[\s,]+/, '');
      if (rest && /[a-z]/i.test(rest)) {
        out.push({ text: tidy(schedule[1]), bullet: false });
        for (const piece of splitConjunction(rest)) {
          out.push({ text: tidy(piece.replace(/\.$/, '')), bullet: false });
        }
        continue;
      }
    }
    for (const unit of splitSequence(s)) {
      for (const part of splitComma(unit)) {
        const pieces = parallel ? [part] : splitConjunction(part);
        for (const piece of pieces) {
          const t = tidy(piece).replace(/\.$/, '');
          if (t) out.push({ text: t, bullet });
        }
      }
    }
  }
  return out;
}

function splitSequence(s) {
  // "It then classifies…" → "classifies…" (the pronoun is carried by context)
  const work = s.replace(/^(?:it|they|this|that|he|she|we)\s+(?:then|next|after that|afterwards)\s+/i, '');
  const parts = work
    .split(SEQUENCE_MARKERS)
    .flatMap((p) => p.split(/;\s*/))
    .map((p) => tidy(p))
    .filter(Boolean);
  return parts.length ? parts : [work];
}

/** Split on a comma only when the right-hand side starts a new clause. */
function splitComma(chunk) {
  const parts = chunk.split(/,\s+(?=(?:the|a|an|we|it|they|he|she|if|unless|otherwise|else|then|and)\b)/i);
  if (parts.length === 1) return [chunk];
  const out = [parts[0]];
  for (const p of parts.slice(1)) {
    if (classifyVerb(p) || CONDITION_CUES.test(p) || ELSE_CUES.test(p)) out.push(p);
    else out[out.length - 1] = `${out[out.length - 1]}, ${p}`;
  }
  return out;
}

/**
 * Split "reads the issue and drafts a reply" but keep "reads and writes logs"
 * together only when the right-hand side is not a new verb phrase.
 */
function splitConjunction(s) {
  const parts = s.split(/\s+and\s+/i);
  if (parts.length < 2) return [s];
  const out = [parts[0]];
  for (const raw of parts.slice(1)) {
    const next = tidy(raw);
    const head = (next.split(/\s+/)[0] || '').toLowerCase();
    const nouny = /^(?:the|a|an|it|they|we|he|she|this|that|each|every)$/.test(head);
    if (nouny || classifyVerb(next)) out.push(next);
    else out[out.length - 1] = `${out[out.length - 1]} and ${next}`;
  }
  return out;
}

// ── Builder ─────────────────────────────────────────────────────────────────

/**
 * Bare nouns ("the agent") usually mean the actor already in play, not a new
 * one. Only qualified phrases ("triage agent", "on-call engineer") mint lanes.
 */
const GENERIC_ACTORS = {
  agent: new Set(['agent', 'assistant', 'bot', 'copilot', 'model', 'orchestrator', 'supervisor']),
  human: new Set(['human', 'person', 'team', 'user']),
  system: new Set(['system', 'service', 'worker', 'pipeline', 'scheduler', 'queue', 'inbox', 'webhook', 'cron', 'api']),
};

class Builder {
  constructor(title) {
    this.spec = emptySpec(title);
    this.lanes = new Map();
    this.seq = 0;
  }

  laneFor(actor, primitive) {
    if (primitive.startsWith('trigger-')) {
      if (!this.lanes.has('trigger')) {
        const lane = { id: 'trigger', name: 'Trigger', kind: 'system' };
        this.lanes.set('trigger', lane);
        this.spec.lanes.push(lane);
      }
      return 'trigger';
    }

    // A node with no actor gets the shared System lane; only a *named* system
    // actor (pipeline, scheduler, CRM) earns its own row.
    if (!actor) {
      if (!this.lanes.has('system')) {
        const lane = { id: 'system', name: 'System', kind: 'system' };
        this.lanes.set('system', lane);
        this.spec.lanes.push(lane);
      }
      return 'system';
    }

    const phrase = actor.phrase;
    const kind = actorKind(actor);

    if (GENERIC_ACTORS[kind]?.has(phrase.toLowerCase())) {
      const existing = [...this.lanes.values()]
        .reverse()
        .find((l) => l.kind === kind && l.id !== 'trigger');
      if (existing) return existing.id;
    }

    const id = slug(phrase);
    if (!this.lanes.has(id)) {
      const lane = { id, name: cap(phrase), kind };
      this.lanes.set(id, lane);
      this.spec.lanes.push(lane);
    }
    return id;
  }

  node({ primitive, label, actor, props = {} }) {
    const id = `n${++this.seq}`;
    const node = {
      id,
      primitive,
      label: truncate(cap(tidy(label)) || getPrimitive(primitive).label),
      lane: this.laneFor(actor, primitive),
      props: { ...getPrimitive(primitive).props, ...props },
    };
    if (actor?.phrase && !primitive.startsWith('trigger-')) node.props.actor = cap(actor.phrase);
    this.spec.nodes.push(node);
    return node;
  }

  edge(from, to, kind = 'sequence', label = '', fromPort = 'out') {
    if (!from || !to || from === to) return;
    this.spec.edges.push({ id: `e${this.spec.edges.length + 1}`, from, to, kind, label, fromPort });
  }

  join(frontier, to) {
    for (const f of frontier) this.edge(f.node, to, f.kind || 'sequence', f.label || '', f.port || 'out');
  }
}

// ── Shared clause → step ────────────────────────────────────────────────────

const MACHINE_CATEGORIES = new Set(['io', 'tool', 'data']);

function makeStepFactory(builder) {
  let lastActor = null;
  let lastMachine = null;
  return {
    get lastActor() { return lastActor; },
    setActor(next) { lastActor = next; },
    step(clause, { keepHuman = false } = {}) {
      clause = clause.replace(TRAILING_CONDITION, '').trim() || clause;
      const own = findActor(clause);
      let actor = own || lastActor;
      if (own) {
        lastActor = own;
        if (actorKind(own) !== 'human') lastMachine = own;
      }
      let primitive = classifyVerb(clause);

      if (!builder.spec.nodes.length && TRIGGER_CUES.test(clause)) {
        primitive = /\b(every|each|daily|hourly|nightly|morning|week|day|cron)\b/i.test(clause)
          ? 'trigger-schedule'
          : /\b(email|message|dm|slack|ticket|comment|reply|inbox)\b/i.test(clause)
            ? 'trigger-message'
            : 'trigger-event';
      }
      // "either X or Y" is a choice, even when one arm sounds like an approval.
      if (/(^|[^a-z])either[^]*or([^a-z]|$)/i.test(clause)) primitive = 'decision';

      const ownActor = findActor(clause);
      if (primitive === 'approval' && (/\bauto-?approv/i.test(clause) || (ownActor && actorKind(ownActor) !== 'human'))) {
        primitive = 'llm';
      }

      if (!primitive) primitive = actorKind(actor) === 'human' ? 'human-task' : 'llm';

      if (!keepHuman && !own && actor && actorKind(actor) === 'human' && lastMachine
          && MACHINE_CATEGORIES.has(getPrimitive(primitive).category)) {
        actor = lastMachine;
      }

      let label = stripActor(clause, actor);
      if (!label) label = stripActor(clause, actor);
      if (primitive === 'trigger-schedule') label = clause;
      else if (primitive.startsWith('trigger-')) label = tidy(clause.replace(TRIGGER_CUES, '')) || clause;
      return { primitive, label, actor };
    },
  };
}

// ── Prose ───────────────────────────────────────────────────────────────────

function parseProse(text, builder) {
  const clauses = splitClauses(text);
  const factory = makeStepFactory(builder);
  let frontier = [];
  let open = null;

  const closeOpen = () => {
    if (!open) return;
    // Both branch tips rejoin the main flow from their own output ports.
    frontier = [open.lastTrue && { node: open.lastTrue }, open.lastFalse && { node: open.lastFalse }].filter(Boolean);
    open = null;
  };

  for (const clause of clauses) {
    let text = clause.text;
    const low = () => text.toLowerCase();

    // A finished if/else closes before the next statement is read.
    if (open && open.branch === 'false' && open.lastFalse) closeOpen();

    let branch = null;
    if (open && ELSE_CUES.test(low())) {
      text = tidy(text.replace(ELSE_CUES, ''));
      open.branch = 'false';
      branch = 'false';
      factory.setActor(open.baseActor || null);
      if (!text) { frontier = [{ node: open.id, port: 'false' }]; continue; }
    }

    if (CONDITION_CUES.test(low())) {
      // The subject of a condition ("if the customer is…") is not the actor
      // performing the branch — the node belongs to whoever is running the flow.
      const split = splitConditionBody(tidy(text.replace(CONDITION_CUES, '')));
      const decision = builder.node({
        primitive: 'decision',
        label: split.condition,
        actor: factory.lastActor,
        props: { condition: tidy(text) },
      });
      builder.join(frontier, decision.id);
      open = { id: decision.id, branch: 'true', lastTrue: null, lastFalse: null, baseActor: factory.lastActor };
      frontier = [{ node: decision.id, port: 'true' }];
      // "if X a manager approves it" — the consequence stays in this clause.
      if (split.rest) text = split.rest; else continue;
    }

    // "either approve it or send it back" is a real fork: two arms that
    // rejoin afterwards. Only handled at top level; nested inside a branch it
    // falls through to the plain decision node in step().
    if (!open && /\beither\b/i.test(text)) {
      const pair = text.match(/\beither\b\s*(.+?)\s+\bor\b\s+(.+)$/i);
      if (pair) {
        const armA = factory.step(tidy(pair[1]), { keepHuman: true });
        const armB = factory.step(tidy(pair[2]), { keepHuman: true });
        if (armA.label && armB.label) {
          const decision = builder.node({
            primitive: 'decision',
            label: tidy(text.replace(/^.*?\beither\b/i, '')),
            actor: factory.lastActor,
            props: { condition: `${armA.label} or ${armB.label}` },
          });
          builder.join(frontier, decision.id);
          const na = builder.node(armA);
          const nb = builder.node(armB);
          builder.edge(decision.id, na.id, 'branch', '', 'true');
          builder.edge(decision.id, nb.id, 'branch', '', 'false');
          frontier = [{ node: na.id }, { node: nb.id }];
          continue;
        }
      }
    }
    if (PARALLEL_CUE.test(low()) && /\band\b/i.test(low())) {
      const parts = text
        .replace(PARALLEL_CUE, ' ')
        .split(/\s+and\s+/i)
        .map(tidy)
        .filter(Boolean);
      const steps = parts.map((p) => factory.step(p)).filter((s) => s.label);
      if (steps.length >= 2) {
        const fork = builder.node({ primitive: 'fork', label: 'In parallel', actor: steps[0].actor });
        builder.join(frontier, fork.id);
        const ends = steps.map((s) => builder.node(s).id);
        for (const id of ends) builder.edge(fork.id, id, 'branch');
        const join = builder.node({ primitive: 'join', label: 'Both complete', actor: steps[0].actor });
        for (const id of ends) builder.edge(id, join.id);
        if (open) { if (open.branch === 'true') open.lastTrue = join.id; else open.lastFalse = join.id; }
        frontier = [{ node: join.id }];
        continue;
      }
    }

    const step = factory.step(text);
    if (!step.label) continue;
    const n = builder.node(step);

    if (open) {
      const port = open.branch === 'true' ? 'true' : 'false';
      const last = port === 'true' ? open.lastTrue : open.lastFalse;
      if (last) builder.edge(last, n.id);
      else builder.edge(open.id, n.id, 'branch', '', port);
      if (port === 'true') open.lastTrue = n.id; else open.lastFalse = n.id;
      frontier = [{ node: n.id }];
    } else {
      builder.join(frontier, n.id);
      frontier = [{ node: n.id }];
    }
    void branch;
  }

  if (frontier.length) builder.join(frontier, builder.node({ primitive: 'end', label: 'Done' }).id);
}

// ── Explicit arrows ─────────────────────────────────────────────────────────

function parseArrows(text, builder) {
  const factory = makeStepFactory(builder);
  for (const raw of text.split(/\n+/)) {
    if (!ARROW.test(raw)) continue;
    const parts = raw.replace(/^[-*•\d.)\s]+/, '').split(ARROW).map(tidy).filter(Boolean);
    let prev = null;
    for (const part of parts) {
      const step = factory.step(part);
      const node = builder.node(step);
      if (prev) builder.edge(prev, node.id);
      prev = node.id;
    }
  }
}

// ── Lists ───────────────────────────────────────────────────────────────────

function parseList(text, builder) {
  const factory = makeStepFactory(builder);
  let frontier = [];
  let open = null;
  let decisionIndent = -1;

  for (const raw of text.split(/\n/)) {
    if (!raw.trim()) continue;
    const indent = (raw.match(/^(\s*)/) || ['', ''])[1].length;
    let body = tidy(raw.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, '').replace(/\.$/, ''));
    if (!body) continue;

    let branch = null;
    if (open && ELSE_CUES.test(body)) {
      body = tidy(body.replace(ELSE_CUES, ''));
      open.branch = 'false';
      branch = 'false';
      if (!body) { frontier = [{ node: open.id, port: 'false' }]; continue; }
    }

    if (CONDITION_CUES.test(body)) {
      const d = builder.node({
        primitive: 'decision',
        label: tidy(body.replace(CONDITION_CUES, '')),
        actor: factory.lastActor,
        props: { condition: body },
      });
      builder.join(frontier, d.id);
      open = { id: d.id, branch: 'true', lastTrue: null, lastFalse: null, baseActor: factory.lastActor };
      frontier = [{ node: d.id, port: 'true' }];
      decisionIndent = indent;
      continue;
    }

    const isSubItem = Boolean(open) && indent > decisionIndent;
    if (open && !isSubItem && open.branch === 'false' && open.lastFalse) {
      frontier = [open.lastTrue && { node: open.lastTrue }, { node: open.lastFalse }].filter(Boolean);
      open = null;
    }

    const node = builder.node(factory.step(body));

    if (open && isSubItem) {
      const port = open.branch === 'true' ? 'true' : 'false';
      const last = port === 'true' ? open.lastTrue : open.lastFalse;
      if (last) builder.edge(last, node.id);
      else builder.edge(open.id, node.id, 'branch', '', port);
      if (port === 'true') open.lastTrue = node.id; else open.lastFalse = node.id;
    } else {
      builder.join(frontier, node.id);
    }
    frontier = [{ node: node.id }];
    void branch;
  }

  if (frontier.length) builder.join(frontier, builder.node({ primitive: 'end', label: 'Done' }).id);
}

// ── Entry point ─────────────────────────────────────────────────────────────

/**
 * @param {string} text
 * @param {{title?: string}} [opts]
 * @returns {{ spec: object, issues: object[], interpreter: string }}
 */
export function interpret(text, opts = {}) {
  const source = String(text || '').trim();
  if (!source) return { spec: emptySpec(opts.title || 'Untitled workflow'), issues: [], interpreter: 'rules@1' };

  const lines = source.split(/\n+/).filter((l) => l.trim());
  const bulleted = lines.filter((l) => /^\s*(?:[-*•]|\d+[.)])\s+/.test(l)).length;
  const looksLikeList = bulleted >= 2 && bulleted >= Math.ceil(lines.length * 0.5);
  const looksLikeArrows = lines.some((l) => ARROW.test(l));

  const firstLine = tidy(lines[0]);
  const title = opts.title
    || (firstLine.length <= 64 && !/^[-*•\d]/.test(lines[0]) ? firstLine : 'Workflow');

  const builder = new Builder(title);

  if (looksLikeArrows) parseArrows(source, builder);
  else if (looksLikeList) parseList(source, builder);
  else parseProse(source, builder);

  builder.spec.meta = { source, interpreter: 'rules@1' };
  const { spec, issues } = normalizeSpec(builder.spec);
  return { spec, issues, interpreter: 'rules@1' };
}

export const INTERPRETER_VERSION = 'rules@1';
