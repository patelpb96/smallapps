# Embedding Flow in a host application

Flow is a diagram renderer and editor with one dependency: a **port**. A host
supplies six operations; Flow supplies the diagram. Nothing else crosses the
boundary — no globals, no router, no CSS, no storage assumptions.

```
   host application                 Flow
   ────────────────                 ────
   session / workspace / project ─▶ context
   topology + status               ─▶ port ──▶ bundle, pool ──▶ render + edit
   agent actions                   ◀─ port ◀── command       ◀─ clicks
```

This document is the contract. It is enforced by
[`test/flow-port.test.js`](../test/flow-port.test.js), which fails if the
endpoint set, the port interface, or the document shapes drift.

---

## 1. The port

Six operations. A host implements them however it likes.

| Port method | Purpose | Core? |
|---|---|---|
| `getBundle(context)` | the topology for a session/workspace/project | ✅ |
| `getStatus(context, cursor)` | the status pool, or the part after `cursor` | ✅ |
| `getFlow(flowId, context)` | one nested flow, when the host withholds them | — |
| `subscribe(context, onEvent)` | push status deltas | — |
| `putBundle(bundle)` | persist an edit | — |
| `command(name, payload)` | Flow asks the host to do something | — |

A port may also expose `capabilities()` returning
`{ live, streaming, persist, commands, lazyFlows }`. Flow uses it to hide
affordances rather than fail at them.

Shipped implementations, in [`src/flow/port.js`](../src/flow/port.js):

| Port | For |
|---|---|
| `StaticPort` | the standalone app — one diagram in localStorage, no host |
| `MemoryPort` | tests, embeds and demos where the host is in the same process |
| `HttpPort` | any HTTP server speaking §2 |

A fourth transport (Tauri `invoke`/`listen`, WebSocket, `postMessage`) is a new
class with the same six methods. **Nothing in `src/flow/` changes when you add
one.**

---

## 2. The endpoint tally

Six endpoints. **Two are core** — without them there is no live view. Four are
optional, and Flow degrades visibly rather than quietly when they are missing.

| # | Method | Path | Port method | Req. | Purpose |
|---|---|---|---|---|---|
| 1 | `GET` | `/v1/flow/bundle` | `getBundle` | **core** | topology for a session/workspace/project |
| 2 | `GET` | `/v1/flow/status` | `getStatus` | **core** | status pool plus a resume cursor |
| 3 | `GET` | `/v1/flow/flow/:flowId` | `getFlow` | optional | one nested flow, for lazy drill-down |
| 4 | `GET` | `/v1/flow/events` | `subscribe` | optional | SSE status deltas; without it Flow polls #2 |
| 5 | `PUT` | `/v1/flow/bundle` | `putBundle` | optional | persist edits; absent ⇒ host owns the diagram |
| 6 | `POST` | `/v1/flow/command` | `command` | optional | focus/pause/open-log — host-defined names |

```
total 6  ·  core 2  ·  optional 4
```

Query parameters on the GETs: `session`, `workspace`, `project`. `#2` also takes
`cursor` (omitted ⇒ full snapshot).

A reference implementation of all six is
[`scripts/flow-api-server.js`](../scripts/flow-api-server.js) — one file, no
dependencies. Run it and point the demo at it:

```bash
node scripts/flow-api-server.js 4300
# → http://localhost:4173/apps/flow/embed.html?api=http://localhost:4300
```

### Tauri mapping

The same six, for a Tauri host:

| # | Command or event |
|---|---|
| 1 | `invoke('flow_get_bundle', { session, workspace, project })` |
| 2 | `invoke('flow_get_status', { …, cursor })` |
| 3 | `invoke('flow_get_flow', { flowId })` |
| 4 | `listen('flow://status', …)` — emit `{ nodes, cursor }` payloads |
| 5 | `invoke('flow_put_bundle', { bundle })` |
| 6 | `invoke('flow_command', { name, payload })` |

That is **5 commands and 1 event channel**. No HTTP needed.

---

## 3. The bundle — topology with containment

A single spec is one diagram. A **bundle** is what a harness actually has: a
system-level flow whose nodes are agents, some of which are themselves harnesses.

```jsonc
{
  "version": 1,
  "id": "demo-session",
  "root": "system",
  "flows": {
    "system":         { /* spec */ },
    "agent:planner":  { /* spec */ },
    "agent:builder":  { /* spec */ }
  },
  "meta": { "session": "…", "workspace": "…", "project": "…" }
}
```

Containment is **on the node**, not in the envelope:

```jsonc
{ "id": "a2", "primitive": "agent", "label": "Builder worker", "lane": "agents",
  "subflow": "agent:builder" }
```

Three consequences worth knowing:

- **A lone spec is a valid bundle.** `normalizeBundle` wraps it as one flow, so
  anything already storing a single diagram keeps working.
- **The system level is the default.** `root` is what renders first;
  intra-agent flows exist to be drilled into. That is the right default for a
  meta harness — the agents' internals are not the system's shape.
- **Unresolvable references are dropped and reported**, never left to fail at
  click time.

Navigation helpers live in [`src/flow/bundle.js`](../src/flow/bundle.js):
`parentOf`, `breadcrumb` (cycle-safe), `descendantCount`, `withStatus`.

Use `subflow` for an agent that runs its own harness. Use a plain node for an
agent that does not — there is nothing to drill into, and the absence of the
chevron says so.

---

## 4. The status pool

Status is **not** part of the spec. The spec is the user's document; status is
the harness's current opinion. They merge at render time only, so a harness can
never corrupt a drawing and a missing harness leaves it exactly as drawn.

```jsonc
{
  "version": 1,
  "cursor": 42,
  "updatedAt": "2026-10-22T17:10:45Z",
  "nodes": {
    "agent:builder/b3": {
      "status": "blocked",
      "label": "tests timed out",           // optional, replaces the status word
      "error": "suite exceeded 900s",       // optional, shown as a tooltip
      "metrics": { "tokens": 1200, "cost": 0.012, "ms": 2400 }
    }
  },
  "flows": { "system": { "status": "running" } }
}
```

- **Keys are `flowId/nodeId`.** Node ids alone are ambiguous the moment two
  flows both have an `n1`.
- **The vocabulary is closed**: `idle · running · blocked · done · error ·
  skipped`. Anything else becomes `unknown` and produces a warning — a harness
  with a typo should be told, not silently grey.
- **Deltas are the same shape**, plus `null` to clear an entry:

  ```jsonc
  { "cursor": 43, "nodes": { "system/a2": { "status": "running" }, "system/a1": null } }
  ```

- **Cursors never go backwards.** A stale delta cannot rewind the pool.

This is the "pool of information that corresponds to an agent's place in a
flow": the harness decides what an agent's place *is*, publishes its state
against a stable id, and Flow shows it where that id sits.

---

## 5. Mounting

```js
import { FlowEmbed } from './src/flow/embed.js';
import { HttpPort } from './src/flow/port.js';

const flow = FlowEmbed.mount(document.getElementById('diagram'), {
  port: new HttpPort({ base: '/v1/flow' }),
  context: { session: id, workspace: ws, project: p },
  mode: 'live',        // 'live' | 'edit' | 'readonly'
  theme: 'auto',       // 'light' | 'dark' | 'auto' — follows the host
  pollMs: 0,           // 0 when the host streams; otherwise a safety net
});

flow.on('status',    ({ summary }) => renderCounts(summary));
flow.on('navigate',  ({ trail })   => renderBreadcrumb(trail));
flow.on('selection', (payload)     => showInspector(payload));
flow.on('command',   ({ name })    => console.log('flow asked for', name));
flow.on('saved',     ({ flowId })  => markDirty(flowId));
flow.on('error',     ({ phase, error }) => report(phase, error));

await flow.load();

// Anything the host wants to drive:
flow.api.enter('agent:builder');   // drill in
flow.api.back();
flow.api.root();
flow.api.command('focus_agent', { agent: 'a2' });
flow.setTheme('dark');

// On unmount:
flow.destroy();
```

`mode: 'edit'` also writes: edits are coalesced and sent to `putBundle` when the
port can persist. In `'live'` and `'readonly'`, editing is off and no write ever
happens.

The controller also accepts `spec` instead of `port`, which is how the
standalone app uses it and how a host can render a diagram it has not saved yet.

A worked host page is [`apps/flow/embed.html`](../apps/flow/embed.html) — it
uses none of the app's stylesheet, on purpose.

---

## 6. What each side guarantees

**Flow guarantees**

- No network calls except through the port.
- No reads of host globals, storage, cookies, or CSS. Styles are injected once,
  scoped to `.flow-embed`.
- Rendering is deterministic: the same bundle and pool produce the same SVG.
- Every string from the host is escaped before it reaches the DOM.
- A malformed bundle or pool degrades to an empty diagram plus an `issues` or
  `error` event — never a thrown exception in the host's page.

**The host guarantees**

- Node ids are **stable for the life of a session.** They are the join key
  between the drawing and the status pool; renaming one orphans its status.
- Status payloads use the closed vocabulary.
- Nothing under `/v1/flow` mutates state on a `GET`.
- `putBundle` accepts the bundle it was given back, unmodified.

**Both**

- Geometry is optional. If a flow arrives without coordinates, Flow lays it out
  once and then leaves it alone, so a status refresh never moves a box the user
  dragged. Send `x`/`y` only if the host has a layout opinion.

---

## 7. Keeping this true

`test/flow-port.test.js` asserts:

- the endpoint set is exactly the six above, with 2 core and 4 optional;
- every shipped port implements all six methods and reports honest capabilities;
- `HttpPort` calls each documented path, with the documented query parameters;
- bundles normalise from hostile input, containment resolves, and breadcrumbs
  cannot loop;
- the status vocabulary is closed, deltas cannot rewind the cursor, and merging
  status never mutates the spec.

If a future feature needs a seventh endpoint or a different wire shape, that test
fails first. Change it deliberately, bump the version below, and note the change
here.

### Versioning

| Thing | Version | Compatibility rule |
|---|---|---|
| bundle | `1` | additive only: new optional fields, no renames |
| status pool | `1` | as above; new statuses are a vocabulary change |
| endpoints | `/v1/flow` | path prefix is the version |

---

## 8. Host checklist

- [ ] `GET /v1/flow/bundle` returns a bundle for the context, with at least a
      `system` flow.
- [ ] Node ids are stable across restarts of the session.
- [ ] `GET /v1/flow/status` returns `{ cursor, nodes }`, keys as `flowId/nodeId`.
- [ ] Statuses come from the closed vocabulary.
- [ ] Nested agent flows are reachable, via `subflow` or via `getFlow`.
- [ ] Either `GET /v1/flow/events` streams deltas, or polling is acceptable.
- [ ] If the diagram is editable, `PUT /v1/flow/bundle` round-trips.
- [ ] Errors return a JSON body with `error`; Flow surfaces it as an event.
