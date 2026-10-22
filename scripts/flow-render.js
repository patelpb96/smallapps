#!/usr/bin/env node
/**
 * Render a workflow diagram from prose, without a browser.
 *
 *   node scripts/flow-render.js --text "when X, the agent does Y" -o out.svg
 *   node scripts/flow-render.js --file workflow.txt -o out.svg
 *   node scripts/flow-render.js --demo 0 -o examples/invoice.svg
 *   node scripts/flow-render.js --examples docs/examples
 *
 * Pair with any SVG→PNG tool, or open the SVG and screenshot it.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { fromText } from '../src/flow/index.js';
import { renderSVG } from '../src/flow/render.js';
import { analyze } from '../src/flow/hazards.js';

const ROOT = resolve(import.meta.dirname, '..');

const DEMOS = [
  {
    slug: 'invoice-approval',
    text: `When an invoice arrives by email, the finance agent extracts the vendor, amount and PO number.
It matches the PO in the ERP.
If the amount is over $5,000 a manager approves it; otherwise it auto-approves.
Finally it posts the invoice to the ledger and emails the vendor.`,
  },
  {
    slug: 'daily-briefing',
    text: `Every morning at 7am, the research agent searches for new filings from our watchlist and summarises each one.
It drafts a briefing.
An analyst reviews the briefing and either approves it or sends it back.
Once approved it is published to the intranet.`,
  },
  {
    slug: 'support-triage',
    text: `When a support ticket is created, the triage agent classifies it and reads the customer account.
If it is a billing issue an on-call engineer reviews it, otherwise the agent drafts a reply.
In parallel the agent updates the ticket and notifies the customer in Slack.`,
  },
  {
    slug: 'data-drift',
    text: `Every hour the pipeline reads rows from the warehouse.
The agent summarises the metrics and compares them to yesterday.
If drift is detected the agent drafts an incident note and an engineer approves it.
Once approved the agent writes an alert and emails the on-call rota.`,
  },
];

function parseArgs(argv) {
  const out = { demos: false, out: null, text: null, file: null, json: false, theme: 'light' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--text' || a === '-t') out.text = argv[++i];
    else if (a === '--file' || a === '-f') out.file = argv[++i];
    else if (a === '--demo' || a === '-d') out.demo = Number(argv[++i]);
    else if (a === '--out' || a === '-o') out.out = argv[++i];
    else if (a === '--examples') out.examples = argv[++i];
    else if (a === '--json') out.json = true;
    else if (a === '--theme') out.theme = argv[++i] === 'dark' ? 'dark' : 'light';
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

function build(text, name, theme = 'light') {
  const { spec, size, issues } = fromText(text);
  if (name) spec.title = name;
  const svg = renderSVG(spec, { width: size.w, height: size.h, theme });
  return { spec, size, svg, issues, analysis: analyze(spec) };
}

function report({ spec, size, analysis, issues }) {
  const n = spec.nodes.length;
  const e = spec.edges.length;
  const lines = [
    `${spec.title} — ${n} nodes, ${e} edges, ${size.w}×${size.h}`,
    `lanes: ${spec.lanes.map((l) => l.name).join(' · ')}`,
  ];
  if (issues.length) lines.push(`fixups: ${issues.map((i) => i.message).join('; ')}`);
  const flags = analysis.flags;
  lines.push(flags.length ? `flags: ${flags.map((f) => `${f.severity}:${f.id}`).join(', ')}` : 'flags: none');
  return `${lines.join('\n')}\n`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write('node scripts/flow-render.js [--text "…" | --file x.txt | --demo 0 | --examples dir] [-o out.svg]\n');
    return;
  }

  if (args.examples) {
    const dir = join(ROOT, args.examples);
    await mkdir(dir, { recursive: true });
    for (const demo of DEMOS) {
      const built = build(demo.text, demo.slug.replace(/-/g, ' '), args.theme);
      await writeFile(join(dir, `${demo.slug}.svg`), built.svg, 'utf8');
      if (args.json) await writeFile(join(dir, `${demo.slug}.json`), `${JSON.stringify(built.spec, null, 2)}\n`, 'utf8');
      process.stdout.write(`${demo.slug}.svg\n`);
      process.stdout.write(report(built));
    }
    return;
  }

  let text = args.text;
  let name;
  if (args.file) text = await readFile(join(ROOT, args.file), 'utf8');
  if (Number.isInteger(args.demo) && DEMOS[args.demo]) {
    text = DEMOS[args.demo].text;
    name = DEMOS[args.demo].slug.replace(/-/g, ' ');
  }
  if (!text) {
    process.stderr.write('Nothing to render. Pass --text, --file, --demo or --examples.\n');
    process.exitCode = 2;
    return;
  }

  const built = build(text, name, args.theme);
  if (args.out) {
    await writeFile(join(ROOT, args.out), built.svg, 'utf8');
    process.stderr.write(report(built));
  } else {
    process.stdout.write(built.svg);
  }
}

main().catch((err) => {
  process.stderr.write(`error: ${err.message}\n`);
  process.exit(1);
});
