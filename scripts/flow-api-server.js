#!/usr/bin/env node
/**
 * Reference implementation of the six Flow endpoints.
 *
 * This exists so the tally is not a claim. Everything here is one file and no
 * dependencies; a real host replaces it with its own storage and its own status
 * source, keeping the shapes identical.
 *
 *   node scripts/flow-api-server.js [port]        # default 4300
 *
 * Then point the app at it:
 *   http://localhost:4173/apps/flow/embed.html?api=http://localhost:4300
 *
 * Endpoints (see src/flow/port.js for the contract and the full table):
 *   GET  /v1/flow/bundle?session=…       core
 *   GET  /v1/flow/status?session=&cursor=… core
 *   GET  /v1/flow/flow/:flowId           optional  (lazy drill-down)
 *   GET  /v1/flow/events?session=…       optional  (SSE deltas)
 *   PUT  /v1/flow/bundle                 optional  (persist edits)
 *   POST /v1/flow/command                optional  (Flow → host)
 */

import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { HARNESS_BUNDLE, STATUS_SCRIPT, poolAtCursor } from '../apps/flow/fixtures/harness-topology.js';

const ROOT = resolve(import.meta.dirname, '..');
const PORT = Number(process.argv[2] || process.env.PORT || 4300);
const TICK_MS = Number(process.env.FLOW_TICK_MS || 2500);
const STORE = join(ROOT, '.scratch', 'flow-bundle.json');

let bundle = HARNESS_BUNDLE;
let cursor = 0;
const clients = new Set();

// ── The "harness": advance the scripted status one step at a time ──────────
const ticker = setInterval(() => {
  if (cursor >= STATUS_SCRIPT.length) return;
  cursor += 1;
  const delta = { nodes: STATUS_SCRIPT[cursor - 1], cursor, updatedAt: new Date().toISOString() };
  const payload = `event: delta\ndata: ${JSON.stringify(delta)}\n\n`;
  for (const res of clients) res.write(payload);
}, TICK_MS);
ticker.unref?.();

// ── Helpers ────────────────────────────────────────────────────────────────
const json = (res, code, body) => {
  const text = JSON.stringify(body ?? null);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,PUT,POST,OPTIONS',
    'access-control-allow-headers': 'content-type,accept',
    'cache-control': 'no-store',
  });
  res.end(text);
};

const readBody = (req) => new Promise((resolve, reject) => {
  let data = '';
  req.on('data', (c) => { data += c; if (data.length > 4e6) reject(new Error('body too large')); });
  req.on('end', () => resolve(data));
  req.on('error', reject);
});

// ── Server ─────────────────────────────────────────────────────────────────
const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname.replace(/\/+$/, '') || '/';

  if (req.method === 'OPTIONS') return json(res, 204, null);

  try {
    // 1. GET /v1/flow/bundle — core
    if (req.method === 'GET' && path === '/v1/flow/bundle') {
      return json(res, 200, bundle);
    }

    // 2. GET /v1/flow/status — core
    if (req.method === 'GET' && path === '/v1/flow/status') {
      const since = Number(url.searchParams.get('cursor'));
      const pool = poolAtCursor(cursor);
      if (Number.isFinite(since) && since === cursor) return json(res, 200, { ...pool, nodes: {} });
      return json(res, 200, pool);
    }

    // 3. GET /v1/flow/flow/:flowId — optional
    if (req.method === 'GET' && path.startsWith('/v1/flow/flow/')) {
      const id = decodeURIComponent(path.slice('/v1/flow/flow/'.length));
      const spec = bundle.flows[id];
      if (!spec) return json(res, 404, { error: `no flow "${id}"` });
      return json(res, 200, spec);
    }

    // 4. GET /v1/flow/events — optional (SSE)
    if (req.method === 'GET' && path === '/v1/flow/events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        'access-control-allow-origin': '*',
      });
      res.write(`event: ready\ndata: ${JSON.stringify({ cursor })}\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return undefined;
    }

    // 5. PUT /v1/flow/bundle — optional (persist edits)
    if (req.method === 'PUT' && path === '/v1/flow/bundle') {
      const body = JSON.parse(await readBody(req) || '{}');
      if (!body || typeof body !== 'object' || !body.flows) return json(res, 400, { error: 'expected a bundle' });
      bundle = body;
      await writeFile(STORE, `${JSON.stringify(bundle, null, 2)}\n`, 'utf8').catch(() => {});
      return json(res, 200, { ok: true, flows: Object.keys(bundle.flows).length });
    }

    // 6. POST /v1/flow/command — optional (Flow → host)
    if (req.method === 'POST' && path === '/v1/flow/command') {
      const body = JSON.parse(await readBody(req) || '{}');
      process.stdout.write(`command: ${body.name} ${JSON.stringify(body.payload ?? {})}\n`);
      // A real host would act here. The reference one just acknowledges, so the
      // round trip is visible without pretending to control anything.
      return json(res, 200, { ok: true, handled: body.name ?? null, at: new Date().toISOString() });
    }

    return json(res, 404, { error: `no route for ${req.method} ${path}` });
  } catch (err) {
    return json(res, 500, { error: String(err?.message || err) });
  }
});

server.listen(PORT, () => {
  process.stdout.write([
    `flow api → http://localhost:${PORT}`,
    '  GET  /v1/flow/bundle    (core)',
    '  GET  /v1/flow/status    (core)',
    '  GET  /v1/flow/flow/:id  (optional)',
    '  GET  /v1/flow/events    (optional, SSE)',
    '  PUT  /v1/flow/bundle    (optional)',
    '  POST /v1/flow/command   (optional)',
    '',
    `status tick every ${TICK_MS}ms over ${STATUS_SCRIPT.length} steps`,
  ].join('\n') + '\n');
});
