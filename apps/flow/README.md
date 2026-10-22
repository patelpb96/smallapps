# Flow — workflow diagrams

Turns prose into an editable swimlane diagram, and doubles as an embeddable
component a harness can mount.

Two ways in:

| Page | What it is |
|---|---|
| [`index.html`](index.html) | the standalone app — describe, edit, export |
| [`embed.html`](embed.html) | a host page that mounts `FlowEmbed`, with a live session topology |

Live: <https://patelpb96.github.io/smallapps/apps/flow/>

---

## Files

| File | Role |
|---|---|
| `index.html` | standalone app shell |
| `main.js` | app wiring: prompt panel, inspector, risks, export, persistence |
| `editor.js` | the SVG editor — pan/zoom, drag, connect, inline rename, undo |
| `llm.js` | optional LLM interpreter; produces the same spec as the rules one |
| `embed.html`, `embed-demo.js` | a host application embedding Flow |
| `fixtures/harness-topology.js` | the example bundle + a scripted status stream |

The engine has no knowledge of any of this. It lives in
[`../../src/flow/`](../../src/flow) and runs in node as well as the browser —
that is what makes the same code usable in a Tauri host.

---

## The two modes

**Standalone.** Describe a workflow, get a diagram, fix what the parser got
wrong, export PNG/SVG/JSON. Everything is local; state is in `localStorage`.

**Embedded.** The host supplies a *port* (six operations) and Flow renders and
edits whatever that port returns. No assumption about the host's router, CSS or
storage. See [`../../docs/INTEGRATION.md`](../../docs/INTEGRATION.md).

The embed adds two things the standalone app does not have:

- **Live status.** The host publishes `{ status }` per agent against stable node
  ids; Flow draws it as a badge without touching the geometry, so a refresh
  never moves a box you dragged.
- **Containment.** A node with `subflow` gets a chevron badge. Clicking it opens
  that agent's own flow — the system view stays the default, and intra-agent
  detail is opt-in. That is the whole reason a meta harness wants this: the
  agents' internals are not the system's shape.

---

## Run it

```bash
node scripts/serve.js                 # → http://localhost:4173/apps/flow/
node scripts/flow-api-server.js 4300  # optional: the six reference endpoints
```

Then:

- `?demo=0..3` — load a built-in example
- `?theme=dark|light` — override the OS colour scheme
- `?select=<node>` — focus a node
- `embed.html?api=http://localhost:4300` — use the HTTP port instead of the
  in-process one
- `embed.html?flow=agent:builder` — open straight into a nested flow

Everything is square-cornered and follows the page's light/dark scheme; both the
canvas and every export are rendered from the same theme object.

---

## Editing

| | |
|---|---|
| Move / select | drag · shift-click · marquee on empty canvas |
| Connect | drag from the port on a node's right edge |
| Rename | double-click the node |
| Drill in | click the chevron badge on a container node |
| Pan / zoom | space-drag or wheel · ⌘/ctrl-wheel zooms at the cursor |
| Keys | `⌘Z`/`⇧⌘Z` · `⌘D` duplicate · `⌘↵` generate · arrows nudge · `Del` |

---

## Exports

PNG (2×), SVG, the JSON spec, and the LLM prompt. Exports use the current theme,
so a diagram drawn on a dark background is dark rather than a white sheet
dropped onto it.

A spec saved from here is a valid bundle input, and vice versa: `normalizeBundle`
wraps a lone spec as a one-flow bundle, so nothing written before nesting existed
has to change.
