# AGENTS.md

Operational rules for this repository. Read this before changing anything.

`smallapps` is a public repo of small, dependency-free apps. The active project
is **Flow** (`apps/flow`, `src/flow`) — a workflow diagram engine and editor that
is being made portable into a separate host application. Work on other projects
is out of scope; reading them requires explicit, temporary authority from the
owner.

---

## 1. Nothing device-identifying goes in this repo

It is public. Absolute paths, hostnames, and personal email addresses are not
content — they are leakage, and they leak silently because an absolute path in a
document looks exactly like an ordinary path.

**Rule:** no absolute home paths, no machine hostnames, no personal email
addresses in tracked files.

**Enforcement:** `scripts/checks/personal-data.js`, run by `npm run check`. It
scans every tracked text file and fails the build on a hit. Do not add exceptions
to it without a reason in the commit message.

Two consequences that are easy to get wrong:

- Write paths relative or with `~`. `scripts/serve.js` and friends root
  themselves on `import.meta.dirname`, so there is never a reason to hard-code a
  home directory.
- PDFs under `docs/papers/` are excluded from the scan on purpose. They are
  third-party papers and contain other people's example paths.

### Commit identity

Commits must be authored with a GitHub noreply address, not a personal one:

```
git config --local user.email "<numeric-id>+<username>@users.noreply.github.com"
```

`npm run check` warns when the local `user.email` is anything else. This is a
warning rather than a failure because it is per-machine configuration, not
repository content — but a warning here means the next commit will publish an
address, so treat it as blocking.

This applies from 2026-10-22 forward. Earlier commits on `main` carry the
previous identity; that history is not being rewritten.

---

## 2. The Flow portability contract is frozen

`src/flow/port.js` defines the only interface between Flow and its host: six
operations, exposed over six documented endpoints. A host supplies them; Flow
supplies the diagram.

**Rule:** do not change the port method names, the endpoint paths, the bundle
shape, or the status vocabulary without:

1. bumping the version in `docs/INTEGRATION.md`;
2. updating `test/flow-port.test.js` deliberately; and
3. saying why in the commit message.

`test/flow-port.test.js` fails first if any of that drifts. That is the point of
it — treat a failure there as "you are changing an integration contract", not as
"a test needs updating".

Adding a new transport (Tauri, WebSocket, `postMessage`) is always allowed: it is
a new class with the same six methods, and nothing in `src/flow/` changes.

---

## 3. A rule that arrives twice becomes a check

If the same instruction, correction, or bug shows up a second time, do not try
harder — promote it into something that cannot be skipped: a test, a lint rule,
a schema, or an entry in this file.

This repo has already paid for that lesson twice:

- `\b` in a template literal becomes a backspace and silently disables a regex.
  Now `scripts/lint-refs.js` fails on stray control characters.
- Absolute paths and personal addresses in a public repo. Now
  `scripts/checks/personal-data.js` fails on them.

If you find yourself repeating a note in a commit message, put it here instead.

---

## 4. House style that is not optional

- **Zero dependencies.** No build step, no bundler, no framework. `node --test`
  and the browser are the only runtimes. This is what makes the engine usable in
  a Tauri host without a toolchain.
- **Square corners.** No rounded rectangles anywhere, in the diagram or the
  chrome. Shapes that need to read differently use geometry or a double border.
- **One theme source.** Colours come from the theme object in
  `src/flow/render.js`, and the page keys off `<html data-theme>`. Never
  hard-code a colour that should follow light/dark.
- **Engines do not know about UIs.** `src/flow/` and `src/agent-plan/` have no
  DOM access beyond what the editor passes in. Adding an output format means
  touching a renderer, never a rule.
- **Generated docs stay generated.** `docs/HEURISTICS.md` and `docs/SOURCES.md`
  come from `scripts/gen-docs.js`; `npm run check` fails if they are stale.
- **Numbers in the README are checked.** If you state a count, the lint verifies
  it. Do not write a number you did not generate.

---

## 5. Before you push

```bash
npm run check     # tests + referential integrity + doc freshness + privacy scan
```

`npm run check` is the whole gate. There is no CI on this repo — the Pages
workflow only publishes — so this command is the only thing standing between a
change and the public site.

---

## 6. Where things are

| Path | What |
|---|---|
| `src/flow/` | the diagram engine — spec, primitives, interpreter, layout, hazards, render, bundle, status, port, embed |
| `src/agent-plan/` | the workflow planner engine |
| `apps/flow/` | the standalone app, the embed demo, and the example topology fixture |
| `apps/agent-plan/` | the planner UI |
| `scripts/` | serve, render, reference API server, doc generation, lint |
| `test/` | `node --test`; no framework |
| `docs/INTEGRATION.md` | the host contract — read before touching `port.js` |
| `docs/examples/workflows/` | diagrams of real workflows, with the prose they came from |
