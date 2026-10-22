# Diagrams of real workflows

Four workflows taken from this machine, not invented examples. Each one is
authored as a spec rather than run through the rule interpreter — the
interpreter gets the *shape* right and the guards wrong, and a gate that
downgrades an `allow` to an `escalate` is not something a lexicon infers.

| Diagram | Shape | Source |
|---|---|---|
| [`guard-gate`](guard-gate.json) | decision spine with three exits | `~/.agents/skills/deepseek-operator/assets/guard.py` + `SKILL.md` |
| [`supervisor-loop`](supervisor-loop.json) | bounded cycle across four lanes | `SKILL.md` + `assets/consult.py` |
| [`agent-handoff`](agent-handoff.json) | linear protocol with two refusals | `~/handoff/README.md` |
| [`death-and-recovery`](death-and-recovery.json) | fan of choices racing a timer | `Projects/R2S2/DEATH_LOSS_AND_TRAVEL_DESIGN.md` |

Regenerate:

```bash
node docs/examples/workflows/build.mjs      # writes .json + light/dark .svg
```

PNGs are rasterised from the SVGs at 2×:

```bash
chrome --headless --force-device-scale-factor=2 \
  --window-size=<w>,<h> --screenshot=out.png file://…/guard-gate.svg
```

---

## 1. Destructive-action gate

> A destructive action is proposed — a kill, a delete, a `git reset --hard`, a
> write outside the project. The routine way to do it is `guard.py run`, so the
> reviewed path is also the lazy path; skipping it is allowed but must be
> recorded. The gate builds a bounded prompt from the action, target and stated
> reason, and asks Argon, which has no tools and sees only what is pasted. A
> reply that will not parse as JSON fails closed. An `allow` is still downgraded
> to `escalate` when the target sits outside the project root or the blast radius
> is unstated. Every decision appends to `argon-guard.jsonl` before anything runs.

The diagram carries the exit codes, because in practice the code is the contract:
`0` ran, `1` denied, `2` the human owns it, `3` the reviewer was unreachable.

**The tool flags this diagram** — `sandbox-floor`: `guard.py` executes the command
with the user's permissions and declares no isolation boundary. That is not a
misreading; the skill says so itself ("This is not a sandbox and not a security
boundary. The goal is narrower: make unvetted destruction unlikely, and leave
evidence when it happens anyway"). The diagram states the isolation property
explicitly so the flag is a property of the drawing, not a gap in it.

## 2. Supervised worker loop

> DeepSeek does the volume; Argon plans and reviews; a script decides what is
> true; nothing destructive happens without the gate. The CTO plans one step and
> names what would make it wrong. The worker runs it. The harness judges exit
> code, schema, hashes and byte caps — anything a script can decide belongs in
> the script. The CTO reviews a bounded digest and answers `ok` / `drift` /
> `violation` with a quote as evidence. A failure retargets the *input*, not the
> wording. The loop ends on a verdict, a stop_case, or the budget.

The cycle is deliberate, so the loop controller declares its bound
(`until` / `max`). That is what stops the hazard check reading it as an unbounded
retry — and it is also the real design rule: "a repeated instruction is a
specification, not a prompt to try harder."

## 3. CLI ↔ desktop handoff

> Two agents share one folder. Whoever finishes or blocks writes a dated note;
> the other reads it. Re-read immediately before editing, because the other agent
> may have changed it. Say who edited and when. Never put a secret in the folder.
> Never delete someone else's file — mark it DONE instead.

The least glamorous of the four and the one that runs every day. Two refusal
paths, both of which leave the folder consistent.

## 4. Death, loss and recovery

> Dying drops everything carried into a death pile that lasts 15 minutes. Players
> and NPCs can both loot it. Loss is flat — no quality-scaled penalty. Transport
> is the counterweight: the 15-minute clock only creates tension because getting
> back takes time, so subway/train/bus/Uber are four different answers to the same
> clock rather than a speed ranking.

The fan is the point: four equally valid routes, none of them "correct". The
choice is how much of the timer each one costs.
