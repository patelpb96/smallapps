# smallapps

Small, dependency-free things that each do one job. No build step, no bundler, no framework — open the file and it runs.

**Live:** <https://patelpb96.github.io/smallapps/>

| App | What it does |
|---|---|
| [`apps/agent-plan`](apps/agent-plan/) | Plans agentic workflows against published standards: autonomy tier, sandbox floor, tool contracts, oversight design, evaluation gates. |

---

## agent-plan

Most agent planning happens in a doc that says "we'll use a sandbox and add evals." That sentence survives review because nobody can point at the specific thing it's missing. This tool exists to make the missing thing nameable.

You answer 23 questions about the system you actually have — what it can change, what it can read, what it can reach, who reviews it, what stops it. It returns:

- **An autonomy tier** (T0–T4) and, separately, **the ceiling** your blast radius and controls actually support. If you're above it, you're told by how much and which facts put you there.
- **A sandbox floor** (S0–S4), set by what the agent *acts on* rather than how capable the model is.
- **A ranked control list** — 70 heuristics, each with the requirement, the check a reviewer can run, and citations.
- **Risk flags** for the combinations that cause incidents: the lethal trifecta, nominal oversight, approval fatigue, irreversible actions with untested rollback.
- **A markdown plan and an implementation checklist** you can paste into a design doc or an issue.

Everything is derived from a rule catalog that cites a standard, spec, or paper. Nothing is vibes.

### Run it

Either use the hosted copy at <https://patelpb96.github.io/smallapps/apps/agent-plan/>, or run it locally:

```bash
# Web UI
node scripts/serve.js          # → http://localhost:4173/

# CLI
node bin/plan.js --preset ops-agent
node bin/plan.js --preset coding-agent --format md > PLAN.md
node bin/plan.js --answers my-answers.json --format json
node bin/plan.js --list-presets

# Checks
npm test                       # 25 behavioural + integrity tests
npm run check                  # tests + referential integrity + doc freshness
```

Requires Node 20+. There are no dependencies to install.

### What it looks like

```
$ node bin/plan.js --preset ops-agent
Autonomy: T4 Self-directing — OVER CEILING by 2 (max T2)
Sandbox floor: S4 Dedicated host
Controls: 38 must, 21 should, 3 consider
Risks: 4 critical, 7 high
```

For the same preset, the plan opens with:

> **Running 2 tiers above its ceiling.** It operates at T4 but its blast radius and control quality only support T2.
>
> What caps the ceiling:
> - Caps at **T2** — Self-modification invalidates the threat model that justified any higher tier.
> - Caps at **T2** — 400 review points/day will be rubber-stamped; the reviewer stops being a gate.
> - Caps at **T2** — Kill switch is "Ctrl-C in the same shell" — you cannot stop it, so it must not run unattended.

---

## Design notes

**Autonomy and sandboxing are separate ladders, deliberately.** A read-only research agent with open internet access and a production deploy bot both "score high" on a naive risk index while needing completely different controls. Collapsing them into one number would have made the tool confidently wrong.

**Autonomy tiers describe the human's role, not the model's power.** The framework taxonomies (AWS Scope 1–4, CSA L0–L5, Knight L1–L5) agree on substance and disagree on numbering, so the human role is the column that matters. See [`docs/HEURISTICS.md`](docs/HEURISTICS.md#tier-ladders).

**Ceiling is not current tier.** "Where it operates" is derived from who reviews what. "Where it may operate" is derived from blast radius, reversibility, and control quality. The gap between them is the finding. An unsupervised agent that can deploy is T4-by-neglect, and saying so is the point.

**Honest about uncertainty.** Four things the tool will not do: predict whether your agent works, replace a threat model written by someone who knows your system, certify compliance, or tell you the model is safe. It sizes the scaffolding; it does not stand in for judgement.

**Rules are data, not prose.** Adding a heuristic means adding one object with a `when()` predicate, a `requirement()`, a `verify()`, and source ids. `npm run check` fails if you cite a source that doesn't exist, point at a paper that isn't on disk, ship a `when()` that throws, or let `docs/` drift from the catalog.

**Every recommendation is testable.** `verify()` is written to be a check someone can actually run — "unplug the system prompt and re-run the unsafe-action suite; nothing that should be blocked becomes possible." Not "ensure least privilege."

---

## Repository layout

```
src/                  the engine — pure ESM, no DOM, runs in node and browser
  intake.js           23 questions; every option declares the facts it asserts
  facts.js            answers → facts (the only place interpretation happens)
  heuristics.js       the 70-rule catalog
  tiers.js            autonomy + sandbox ladders, ceiling logic, risk flags
  engine.js           buildPlan() → the single plan IR
  render.js           plan → markdown / checklist / json
  sources.js          30-entry citation registry
apps/agent-plan/      web UI (thin: builds inputs, calls buildPlan, paints)
bin/plan.js           CLI
test/                 node:test — no framework
scripts/              serve, generate docs, lint references
docs/
  HEURISTICS.md       generated reference
  SOURCES.md          generated annotated bibliography
  papers/             12 papers, checked in
```

`src/` has no knowledge of the UI. Adding an output format means touching `render.js`, never a heuristic.

---

## Sources

30 entries, 12 downloaded to [`docs/papers/`](docs/papers/). The four that most shaped the design:

- **AWS Agentic AI Security Scoping Matrix** — gave the autonomy ladder its vocabulary, and the core claim that deterministic controls outside the model are the starting point, not prompting.
- **OWASP Top 10 for Agentic Applications 2026** + **AISVS C09** — the most testable requirement set available; most of the `authority` and `budget` rules trace here.
- **SandboxEscapeBench** (UK AI Security Institute) — frontier models reliably escape *misconfigured* containers, which is why the tool treats plain container isolation as packaging rather than a boundary.
- **τ-bench** — `pass^k` versus `pass@1`. Capability is not reliability, and the gap is large.

Full annotated list with links: [`docs/SOURCES.md`](docs/SOURCES.md).

---

## License

MIT. The sources are other people's work; see each entry for its own terms.
