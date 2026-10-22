#!/usr/bin/env node
/**
 * Print the endpoint tally, straight from the contract table.
 *
 *   node scripts/flow-endpoints.js
 *   node scripts/flow-endpoints.js --json
 *
 * Kept as a script so the number in the docs can be regenerated rather than
 * trusted.
 */

import { FLOW_ENDPOINTS, tallyEndpoints } from '../src/flow/port.js';

const asJson = process.argv.includes('--json');
const t = tallyEndpoints();

if (asJson) {
  process.stdout.write(`${JSON.stringify({ tally: t, endpoints: FLOW_ENDPOINTS }, null, 2)}\n`);
  process.exit(0);
}

const w = (s, n) => String(s).padEnd(n);
const lines = [
  `${w('req', 9)}${w('method', 8)}${w('path', 30)}${w('port method', 13)}tauri`,
  '-'.repeat(96),
];
for (const e of FLOW_ENDPOINTS) {
  lines.push(`${w(e.required, 9)}${w(e.method, 8)}${w(e.path, 30)}${w(e.port, 13)}${e.tauri}`);
}
lines.push(
  '-'.repeat(96),
  '',
  `total ${t.total}  ·  core ${t.core}  ·  optional ${t.optional}`,
  `http ${t.http}  ·  tauri ${t.tauri - 1} commands + 1 event channel`,
);

process.stdout.write(`${lines.join('\n')}\n`);
