/**
 * The port: the only thing Flow needs from a host.
 *
 * Flow does not know what a backend is. It knows six operations, and a host
 * supplies them. That is the whole portability story — swap the port, keep the
 * diagram. The transports in this file are implementations of the same six:
 *
 *   StaticPort  no host at all (the standalone app)
 *   MemoryPort  a host in the same process (tests, embeds, demos)
 *   HttpPort    any HTTP server speaking the table below
 *
 * Any future transport — Tauri invoke/listen, WebSocket, postMessage — is a new
 * class with the same six methods. Nothing in src/flow/ changes when you add one,
 * and test/flow-port.test.js fails if a port drifts from the contract.
 */

import { normalizeBundle } from './bundle.js';
import { normalizePool, applyDeltas, emptyPool } from './status.js';

/**
 * The endpoint tally.
 *
 * This table is the contract, not documentation of it: HttpPort is generated
 * from these entries and the tests assert the set has not changed shape. Adding
 * an endpoint is a deliberate act with a version bump, not a side effect.
 *
 *   core     — without it there is no live view
 *   optional — Flow degrades gracefully when it is missing
 */
export const FLOW_ENDPOINTS = [
  {
    id: 'bundle.get',
    port: 'getBundle',
    method: 'GET',
    path: '/v1/flow/bundle',
    tauri: 'flow_get_bundle',
    required: 'core',
    purpose: 'The topology for a session/workspace/project: flows plus the root id.',
  },
  {
    id: 'status.get',
    port: 'getStatus',
    method: 'GET',
    path: '/v1/flow/status',
    tauri: 'flow_get_status',
    required: 'core',
    purpose: 'The status pool for those flows, plus a cursor to resume from.',
  },
  {
    id: 'flow.get',
    port: 'getFlow',
    method: 'GET',
    path: '/v1/flow/flow/:flowId',
    tauri: 'flow_get_flow',
    required: 'optional',
    purpose: 'One flow, when the bundle carries only the levels the host wants to send.',
  },
  {
    id: 'events.get',
    port: 'subscribe',
    method: 'GET',
    path: '/v1/flow/events',
    tauri: 'flow://status',
    required: 'optional',
    purpose: 'Server-sent status deltas. Without it Flow polls status.get and says so.',
  },
  {
    id: 'bundle.put',
    port: 'putBundle',
    method: 'PUT',
    path: '/v1/flow/bundle',
    tauri: 'flow_put_bundle',
    required: 'optional',
    purpose: 'Persist an edited topology. Absent means the host owns the diagram.',
  },
  {
    id: 'command.post',
    port: 'command',
    method: 'POST',
    path: '/v1/flow/command',
    tauri: 'flow_command',
    required: 'optional',
    purpose: 'Flow asking the host to do something: focus an agent, pause it, open a log.',
  },
];

/** Endpoint ids, for the contract test. Changing this list is a version bump. */
export const ENDPOINT_IDS = FLOW_ENDPOINTS.map((e) => e.id);

export function tallyEndpoints() {
  const by = (level) => FLOW_ENDPOINTS.filter((e) => e.required === level).length;
  return {
    total: FLOW_ENDPOINTS.length,
    core: by('core'),
    optional: by('optional'),
    http: FLOW_ENDPOINTS.filter((e) => e.method).length,
    tauri: FLOW_ENDPOINTS.length,
  };
}

/**
 * The six operations. Subclassing is optional — anything with these methods is a
 * valid port — but extending this makes the contract explicit and gives the
 * tests something to check against.
 */
export class FlowPort {
  // eslint-disable-next-line no-unused-vars
  async getBundle(context) { throw new Error('getBundle not implemented'); }

  // eslint-disable-next-line no-unused-vars
  async getFlow(flowId, context) { throw new Error('getFlow not implemented'); }

  // eslint-disable-next-line no-unused-vars
  async getStatus(context, cursor) { return emptyPool(); }

  // eslint-disable-next-line no-unused-vars
  subscribe(context, onEvent) { return () => {}; }

  // eslint-disable-next-line no-unused-vars
  async putBundle(bundle) { throw new Error('putBundle not implemented'); }

  // eslint-disable-next-line no-unused-vars
  async command(name, payload) { throw new Error('command not implemented'); }

  /** Which of the optional capabilities this port actually has. */
  capabilities() {
    return {
      live: true,
      streaming: this.subscribe !== FlowPort.prototype.subscribe,
      persist: this.putBundle !== FlowPort.prototype.putBundle,
      commands: this.command !== FlowPort.prototype.command,
      lazyFlows: this.getFlow !== FlowPort.prototype.getFlow,
    };
  }
}

/**
 * The standalone app: one diagram in localStorage, no host.
 * Everything optional is unsupported and Flow hides the affordances.
 */
export class StaticPort extends FlowPort {
  constructor(spec, { onSave } = {}) {
    super();
    this.spec = spec || null;
    this.onSave = onSave || (() => {});
    this._status = emptyPool();
  }

  async getBundle(context) {
    if (this.spec) return normalizeBundle(this.spec).bundle;
    return normalizeBundle({ nodes: [], lanes: [], edges: [] }).bundle;
  }

  async getStatus() { return this._status; }

  async putBundle(bundle) {
    const root = bundle?.flows?.[bundle.root];
    if (root) this.spec = root;
    this.onSave(bundle);
    return { ok: true };
  }

  capabilities() {
    return { live: false, streaming: false, persist: true, commands: false, lazyFlows: false };
  }
}

/**
 * A host in the same process. Used by the embed demo and by the tests, and the
 * shape a Tauri bridge would fill in from `invoke`.
 */
export class MemoryPort extends FlowPort {
  constructor({ bundle = null, status = null, handler = null } = {}) {
    super();
    this.bundle = bundle;
    this.status = status ? normalizePool(status).pool : emptyPool();
    this.handler = handler;
    this.listeners = new Set();
    this.calls = [];
  }

  async getBundle() { return this.bundle; }

  async getFlow(flowId) { return this.bundle?.flows?.[flowId] || null; }

  async getStatus(context, cursor) {
    // Only the part after the cursor, matching what an HTTP server would send.
    if (cursor !== undefined && this.status.cursor === cursor) {
      return { ...emptyPool(), cursor };
    }
    return this.status;
  }

  subscribe(context, onEvent) {
    this.listeners.add(onEvent);
    onEvent({ type: 'ready', cursor: this.status.cursor });
    return () => this.listeners.delete(onEvent);
  }

  async putBundle(bundle) {
    this.bundle = normalizeBundle(bundle).bundle;
    return { ok: true };
  }

  async command(name, payload) {
    this.calls.push({ name, payload });
    return this.handler ? this.handler(name, payload) : { ok: true };
  }

  // ── test / demo affordances ──
  push(delta) {
    const { pool } = applyDeltas(this.status, delta);
    this.status = pool;
    for (const fn of this.listeners) fn({ type: 'delta', delta });
    return pool;
  }

  capabilities() {
    return { live: true, streaming: true, persist: true, commands: true, lazyFlows: true };
  }
}

/**
 * Any HTTP server speaking FLOW_ENDPOINTS. Endpoint paths come from the table so
 * there is one place to change them.
 */
export class HttpPort extends FlowPort {
  /**
   * @param {{base?: string, fetchImpl?: Function, eventSource?: Function, headers?: object}} options
   */
  constructor({ base = '/v1/flow', fetchImpl = null, eventSource = null, headers = {} } = {}) {
    super();
    this.base = base.replace(/\/+$/, '');
    this.fetchImpl = fetchImpl || (typeof fetch === 'function' ? fetch.bind(globalThis) : null);
    this.eventSource = eventSource || (typeof EventSource === 'function' ? EventSource : null);
    this.headers = headers;
    this.streaming = false;
  }

  _path(id) {
    const entry = FLOW_ENDPOINTS.find((e) => e.id === id);
    if (!entry) throw new Error(`unknown endpoint ${id}`);
    return this.base + entry.path.replace(/^\/v1\/flow/, '');
  }

  async _json(url, init) {
    if (!this.fetchImpl) throw new Error('HttpPort needs fetch');
    const res = await this.fetchImpl(url, {
      ...init,
      headers: { accept: 'application/json', ...this.headers, ...(init?.headers || {}) },
    });
    if (!res.ok) throw new Error(`${init?.method || 'GET'} ${url} → ${res.status}`);
    return res.status === 204 ? null : res.json();
  }

  _query(context) {
    const q = new URLSearchParams();
    for (const key of ['session', 'workspace', 'project']) {
      if (context?.[key]) q.set(key, context[key]);
    }
    const s = q.toString();
    return s ? `?${s}` : '';
  }

  async getBundle(context) { return this._json(this._path('bundle.get') + this._query(context)); }

  async getFlow(flowId, context) {
    const url = this._path('flow.get').replace(':flowId', encodeURIComponent(flowId)) + this._query(context);
    return this._json(url);
  }

  async getStatus(context, cursor) {
    const extra = cursor !== undefined ? `&cursor=${encodeURIComponent(cursor)}` : '';
    return this._json(this._path('status.get') + this._query(context) + extra);
  }

  subscribe(context, onEvent) {
    if (!this.eventSource) return () => {};
    const url = this._path('events.get') + this._query(context);
    const es = new this.eventSource(url);
    this.streaming = true;

    const handle = (event) => {
      if (!event.data) return;
      try {
        onEvent({ type: event.type || 'delta', delta: JSON.parse(event.data) });
      } catch {
        onEvent({ type: 'error', error: 'unparsable event' });
      }
    };
    for (const name of ['delta', 'status', 'ready']) es.addEventListener?.(name, handle);
    es.onmessage = handle;
    es.onerror = () => onEvent({ type: 'reconnect' });

    return () => { this.streaming = false; es.close(); };
  }

  async putBundle(bundle) {
    return this._json(this._path('bundle.put'), {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(bundle),
    });
  }

  async command(name, payload) {
    return this._json(this._path('command.post'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, payload }),
    });
  }

  capabilities() {
    return { live: true, streaming: Boolean(this.eventSource), persist: true, commands: true, lazyFlows: true };
  }
}
