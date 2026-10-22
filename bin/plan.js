#!/usr/bin/env node
/**
 * CLI wrapper.
 *
 *   node bin/plan.js --preset ops-agent
 *   node bin/plan.js --preset coding-agent --format json > plan.json
 *   node bin/plan.js --answers ./my-answers.json --format md > PLAN.md
 *   node bin/plan.js --list-presets
 */

import { readFile } from 'node:fs/promises';
import { buildPlan, summarize } from '../src/engine.js';
import { renderMarkdown, renderChecklist, renderJson } from '../src/render.js';
import { PRESETS, defaultAnswers, QUESTIONS } from '../src/intake.js';

function parseArgs(argv) {
  const out = { format: 'summary', name: undefined, preset: undefined, answers: undefined, notes: undefined };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--format' || a === '-f') out.format = argv[++i];
    else if (a === '--preset' || a === '-p') out.preset = argv[++i];
    else if (a === '--answers') out.answers = argv[++i];
    else if (a === '--name') out.name = argv[++i];
    else if (a === '--notes') out.notes = argv[++i];
    else if (a === '--list-presets') out.listPresets = true;
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

const HELP = `agent-plan — plan heuristics for agentic workflows

Usage
  node bin/plan.js --preset <name> [--format md|checklist|json|summary]
  node bin/plan.js --answers <file.json> [--format ...]
  node bin/plan.js --list-presets

Options
  -p, --preset <name>    Start from a preset: ${Object.keys(PRESETS).join(', ')}
      --answers <file>   JSON file of answers (see src/intake.js for question ids)
      --name <string>    Name for the workflow
      --notes <string>   Free text appended to the plan
  -f, --format <fmt>     summary (default) | md | checklist | json
`;

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) { process.stdout.write(HELP); return; }
  if (args.listPresets) {
    for (const [key, p] of Object.entries(PRESETS)) process.stdout.write(`${key.padEnd(20)} ${p.label}\n`);
    return;
  }

  let answers = defaultAnswers();
  let name;

  if (args.answers) {
    const raw = JSON.parse(await readFile(args.answers, 'utf8'));
    answers = { ...answers, ...(raw.answers || raw) };
    name = raw.name;
  }
  if (args.preset) {
    const preset = PRESETS[args.preset];
    if (!preset) {
      process.stderr.write(`Unknown preset "${args.preset}". Try --list-presets\n`);
      process.exit(2);
    }
    answers = { ...answers, ...preset.answers };
    name = name || preset.label;
  }

  const unknown = Object.keys(answers).filter((k) => !QUESTIONS.some((q) => q.id === k));
  if (unknown.length) process.stderr.write(`warning: unknown answer keys ignored: ${unknown.join(', ')}\n`);

  const plan = buildPlan(answers, { name: name || args.name, notes: args.notes });

  // Never silently plan against assumptions the caller did not intend.
  for (const w of plan.warnings) process.stderr.write(`warning: ${w.message}\n`);

  switch (args.format) {
    case 'md': process.stdout.write(renderMarkdown(plan)); break;
    case 'checklist': process.stdout.write(renderChecklist(plan)); break;
    case 'json': process.stdout.write(renderJson(plan)); break;
    default: process.stdout.write(summarize(plan) + '\n');
  }
}

main().catch((err) => {
  process.stderr.write(`error: ${err.message}\n`);
  process.exit(1);
});
