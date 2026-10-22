/**
 * LLM interpreter adapter.
 *
 * The rules interpreter is the default because it is offline and predictable.
 * This is the upgrade path: hand the same job to a model, but make it emit the
 * *same spec shape* and validate it with the same normaliser. On any failure we
 * fall back to the rules instead of showing you a half-built diagram.
 *
 * The prompt is exported so the app can show it to you — you can paste it into
 * any chat window and paste the JSON back, no key required.
 */

import { PRIMITIVES, CATEGORY } from '../../src/flow/primitives.js';
import { normalizeSpec, EDGE_KINDS } from '../../src/flow/spec.js';
import { layout } from '../../src/flow/layout.js';

const primitiveLines = PRIMITIVES
  .map((p) => `  ${p.id} (${CATEGORY[p.category].title.toLowerCase()}) — ${p.hint}`)
  .join('\n');

export const SPEC_CONTRACT = `You convert a description of a business or engineering workflow into a JSON diagram spec.

Return ONLY a JSON object. No prose, no markdown fences.

Shape:
{
  "title": "short title",
  "lanes": [ { "id": "kebab-case", "name": "Display name", "kind": "human" | "agent" | "system" } ],
  "nodes": [ { "id": "n1", "primitive": "<id>", "label": "imperative phrase, max 60 chars", "lane": "<lane id>", "props": { } } ],
  "edges": [ { "id": "e1", "from": "n1", "to": "n2", "kind": "sequence" | "branch" | "error" | "async" | "loop", "fromPort": "out" | "true" | "false" | "error", "label": "" } ]
}

Rules:
- One lane per actor. kind is "human" for people, "agent" for model-driven actors, "system" for services.
- Node labels are imperative and concrete: "Fetch customer records", not "customer records".
- Every node's lane must be a declared lane id.
- Edges reference node ids. A decision node has exactly two outgoing edges with fromPort "true" and "false".
- Any step that changes state, sends data out, or runs code must have a failure path: an edge with kind "error" to an error or escalate node.
- If the workflow has a loop, include a loop node with props.until and props.max.
- Prefer fewer, clearer nodes over many vague ones. 6–14 nodes is usually right.
- Do not invent steps the description does not imply.

Available primitives:
${primitiveLines}`;

export function buildPrompt(text) {
  return `${SPEC_CONTRACT}\n\nWorkflow description:\n"""\n${text}\n"""`;
}

/** Extract the first JSON object from a model reply, tolerating fences and prose. */
export function extractJson(raw) {
  const s = String(raw || '').trim();
  if (!s) throw new Error('empty response');

  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : s;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) throw new Error('no JSON object found');
  return JSON.parse(body.slice(start, end + 1));
}

/**
 * Call an OpenAI-compatible chat completion endpoint.
 *
 * The key lives in this browser only — it is never sent anywhere but the
 * endpoint you configure. That is a real tradeoff, not a hidden one: anything
 * running in this page could read it, so prefer a scoped, short-lived key.
 */
export async function interpretWithLLM(text, settings) {
  const { endpoint, apiKey, model } = settings;
  if (!endpoint) throw new Error('No endpoint configured');

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify({
      model,
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SPEC_CONTRACT },
        { role: 'user', content: `Workflow description:\n"""\n${text}\n"""` },
      ],
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Model call failed (${res.status}) ${detail.slice(0, 200)}`);
  }

  const data = await res.json();
  const content = data.choices?.[0]?.message?.content ?? data.content ?? '';
  const raw = extractJson(content);
  raw.meta = { source: text, interpreter: `llm:${model || 'unknown'}` };

  const { spec, issues } = normalizeSpec(raw);
  const { spec: laid } = layout(spec);
  return { spec: laid, issues, interpreter: `llm:${model || 'unknown'}` };
}

export const DEFAULT_SETTINGS = {
  endpoint: 'https://api.openai.com/v1/chat/completions',
  model: 'gpt-4o-mini',
  apiKey: '',
};
