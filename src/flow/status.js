/**
 * The status pool.
 *
 * This is the "pool of information that corresponds to an agent's place in a
 * flow". The harness owns it; Flow reads it. Keeping it separate from the spec
 * is deliberate:
 *
 *   spec   = the document the user edits        (ours, persisted, versioned)
 *   status = what the harness currently believes (theirs, transient, lossy)
 *
 * They are merged only at render time. A harness that says nothing leaves the
 * diagram exactly as drawn; a harness that says something surprising can never
 * corrupt the drawing.
 *
 *   { version: 1, cursor: 42, nodes: { "flow/node": { status, … } }, flows: { … } }
 */

export const STATUS_VERSION = 1;

/** The only statuses Flow will colour. Anything else renders as "unknown". */
export const NODE_STATUS = ['idle', 'running', 'blocked', 'done', 'error', 'skipped'];

export const STATUS_LABEL = {
  idle: 'idle',
  running: 'running',
  blocked: 'blocked',
  done: 'done',
  error: 'error',
  skipped: 'skipped',
  unknown: 'unknown',
};

export function emptyPool() {
  return { version: STATUS_VERSION, cursor: 0, updatedAt: '', nodes: {}, flows: {} };
}

/**
 * Coerce a status payload. Total — a harness that sends nonsense gets an empty
 * pool and a warning, not a broken canvas.
 * @returns {{ pool: object, issues: Array<{level:string,message:string}> }}
 */
export function normalizePool(raw) {
  const issues = [];
  const pool = emptyPool();
  if (!raw || typeof raw !== 'object') {
    if (raw !== undefined) issues.push({ level: 'warn', message: 'status is not an object' });
    return { pool, issues };
  }

  pool.cursor = Number.isFinite(raw.cursor) ? raw.cursor : 0;
  pool.updatedAt = typeof raw.updatedAt === 'string' ? raw.updatedAt : '';

  const nodes = raw.nodes && typeof raw.nodes === 'object' ? raw.nodes : {};
  for (const [key, value] of Object.entries(nodes)) {
    const entry = normalizeEntry(value, issues, key);
    if (entry) pool.nodes[key] = entry;
  }

  const flows = raw.flows && typeof raw.flows === 'object' ? raw.flows : {};
  for (const [key, value] of Object.entries(flows)) {
    const entry = normalizeEntry(value, issues, `flow ${key}`);
    if (entry) pool.flows[key] = entry;
  }

  return { pool, issues };
}

function normalizeEntry(value, issues, key) {
  if (!value || typeof value !== 'object') {
    issues.push({ level: 'warn', message: `status for "${key}" is not an object, dropped` });
    return null;
  }
  const raw = String(value.status ?? '').toLowerCase();
  const status = NODE_STATUS.includes(raw) ? raw : 'unknown';
  if (raw && status === 'unknown') {
    issues.push({ level: 'warn', message: `status "${value.status}" for "${key}" is not one of ${NODE_STATUS.join('/')}` });
  }
  const entry = { status };
  if (typeof value.label === 'string' && value.label.trim()) entry.label = value.label.trim().slice(0, 80);
  if (typeof value.lane === 'string' && value.lane) entry.lane = value.lane;
  if (typeof value.since === 'string') entry.since = value.since;
  if (typeof value.error === 'string') entry.error = value.error.slice(0, 200);

  const m = value.metrics;
  if (m && typeof m === 'object') {
    const metrics = {};
    for (const k of ['tokens', 'cost', 'ms', 'steps']) {
      if (Number.isFinite(m[k])) metrics[k] = m[k];
    }
    if (Object.keys(metrics).length) entry.metrics = metrics;
  }
  return entry;
}

/**
 * Apply deltas in order. Deltas are how a live harness talks without resending
 * the world: `{ cursor, nodes: { key: { status } | null } }`, where `null`
 * clears an entry.
 */
export function applyDeltas(pool, deltas) {
  const next = {
    version: STATUS_VERSION,
    cursor: pool?.cursor ?? 0,
    updatedAt: pool?.updatedAt ?? '',
    nodes: { ...(pool?.nodes || {}) },
    flows: { ...(pool?.flows || {}) },
  };
  const list = Array.isArray(deltas) ? deltas : [deltas];
  const cleared = [];

  for (const delta of list) {
    if (!delta || typeof delta !== 'object') continue;
    if (Number.isFinite(delta.cursor)) next.cursor = Math.max(next.cursor, delta.cursor);
    if (typeof delta.updatedAt === 'string') next.updatedAt = delta.updatedAt;

    for (const bucket of ['nodes', 'flows']) {
      const incoming = delta[bucket];
      if (!incoming || typeof incoming !== 'object') continue;
      for (const [key, value] of Object.entries(incoming)) {
        if (value === null) {
          delete next[bucket][key];
          cleared.push(`${bucket}/${key}`);
          continue;
        }
        const entry = normalizeEntry(value, [], key);
        if (entry) next[bucket][key] = entry;
      }
    }
  }

  return { pool: next, cleared };
}

/** Counts by status, for a header strip. */
export function summarize(pool) {
  const counts = { idle: 0, running: 0, blocked: 0, done: 0, error: 0, skipped: 0, unknown: 0 };
  for (const entry of Object.values(pool?.nodes || {})) {
    counts[entry.status] = (counts[entry.status] || 0) + 1;
  }
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  return { ...counts, total };
}
