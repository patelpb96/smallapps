/**
 * Layout: swimlanes + layered left-to-right placement.
 *
 * Lanes come from actors, ranks come from the graph. Cycles are handled by
 * finding back edges with a DFS and ignoring them when ranking, which keeps a
 * retry loop from pushing everything into an ever-growing line.
 *
 * Layout writes x/y/w/h onto nodes and y/height onto lanes, so the result is a
 * fully self-describing spec that exports and re-imports identically.
 */

import { measureNode, textLayout, METRICS } from './geometry.js';
import { getPrimitive } from './primitives.js';
import { cloneSpec } from './spec.js';

export const LAYOUT = {
  marginX: 28,
  marginY: 34,
  laneGap: 8,
  colGap: 58,
  rowGap: 18,
  lanePadY: 22,
  laneHeadW: 118,
  minLaneH: 96,
};

/**
 * Longest-path ranking over forward edges only.
 * @returns {Map<string, number>}
 */
export function rankNodes(nodes, edges) {
  const out = new Map(nodes.map((n) => [n.id, []]));
  for (const e of edges) {
    if (e.from === e.to) continue;
    if (!out.has(e.from) || !out.has(e.to)) continue;
    out.get(e.from).push(e.to);
  }

  // Iterative DFS: colour 1 = on stack (back edge), 2 = done.
  const colour = new Map();
  const back = new Set();
  for (const start of nodes) {
    if (colour.get(start.id)) continue;
    const stack = [{ id: start.id, i: 0 }];
    colour.set(start.id, 1);
    while (stack.length) {
      const top = stack[stack.length - 1];
      const targets = out.get(top.id) || [];
      if (top.i >= targets.length) { colour.set(top.id, 2); stack.pop(); continue; }
      const t = targets[top.i++];
      const c = colour.get(t) || 0;
      if (c === 1) back.add(`${top.id}->${t}`);
      else if (c === 0) { colour.set(t, 1); stack.push({ id: t, i: 0 }); }
    }
  }

  const fwd = edges.filter((e) => !back.has(`${e.from}->${e.to}`));
  const rank = new Map(nodes.map((n) => [n.id, 0]));
  for (let pass = 0; pass < nodes.length + 1; pass++) {
    let changed = false;
    for (const e of fwd) {
      if (!rank.has(e.from) || !rank.has(e.to)) continue;
      const candidate = rank.get(e.from) + 1;
      if (candidate > rank.get(e.to)) { rank.set(e.to, candidate); changed = true; }
    }
    if (!changed) break;
  }
  return { rank, backEdges: back };
}

/**
 * @param {object} spec
 * @param {{preserve?: boolean}} [opts] preserve = keep existing x/y where present
 * @returns {{ spec: object, size: {w:number,h:number} }}
 */
export function layout(spec, opts = {}) {
  const out = cloneSpec(spec);
  if (!out.nodes.length) {
    out.lanes = out.lanes.map((l, i) => ({ ...l, y: LAYOUT.marginY + i * LAYOUT.minLaneH, height: LAYOUT.minLaneH }));
    return { spec: out, size: { w: 520, h: 260 } };
  }

  // ── 1. Sizes ──
  for (const n of out.nodes) {
    const shape = getPrimitive(n.primitive).shape;
    const m = measureNode({ ...n, shape });
    n.w = m.w;
    n.h = m.h;
    n._lines = m.lines;
  }

  // ── 2. Ranks ──
  const { rank } = rankNodes(out.nodes, out.edges);

  // ── 3. Lanes in declared order, plus any lane a node references ──
  const laneIds = out.lanes.map((l) => l.id);
  for (const n of out.nodes) if (!laneIds.includes(n.lane)) laneIds.push(n.lane);
  const laneList = laneIds.map((id) => out.lanes.find((l) => l.id === id) || { id, name: id, kind: 'system' });

  const byLane = new Map(laneList.map((l) => [l.id, []]));
  for (const n of out.nodes) {
    if (!byLane.has(n.lane)) byLane.set(n.lane, []);
    byLane.get(n.lane).push(n);
  }

  // ── 4. Column geometry from the widest node at each rank ──
  let maxRank = 0;
  for (const n of out.nodes) maxRank = Math.max(maxRank, rank.get(n.id) || 0);
  const colW = new Array(maxRank + 1).fill(METRICS.minW);
  for (const n of out.nodes) {
    const r = rank.get(n.id) || 0;
    colW[r] = Math.max(colW[r], n.w);
  }
  const colX = [];
  let x = LAYOUT.marginX + LAYOUT.laneHeadW;
  for (let r = 0; r <= maxRank; r++) { colX.push(x); x += colW[r] + LAYOUT.colGap; }
  const rightEdge = x - LAYOUT.colGap + LAYOUT.marginX;

  // ── 5. Stack per (lane, rank) and derive lane heights ──
  let y = LAYOUT.marginY;
  for (const lane of laneList) {
    const items = byLane.get(lane.id) || [];
    const stacks = new Map();
    for (const n of items) {
      const r = rank.get(n.id) || 0;
      if (!stacks.has(r)) stacks.set(r, []);
      stacks.get(r).push(n);
    }
    let tallest = 0;
    for (const stack of stacks.values()) {
      const h = stack.reduce((sum, n) => sum + n.h, 0) + (stack.length - 1) * LAYOUT.rowGap;
      tallest = Math.max(tallest, h);
    }
    const height = Math.max(LAYOUT.minLaneH, tallest + LAYOUT.lanePadY * 2);
    lane.y = y;
    lane.height = height;
    y += height + LAYOUT.laneGap;
  }

  // ── 6. Place ──
  for (const lane of laneList) {
    const items = byLane.get(lane.id) || [];
    const stacks = new Map();
    for (const n of items) {
      const r = rank.get(n.id) || 0;
      if (!stacks.has(r)) stacks.set(r, []);
      stacks.get(r).push(n);
    }
    for (const [r, stack] of stacks) {
      const stackH = stack.reduce((sum, n) => sum + n.h, 0) + (stack.length - 1) * LAYOUT.rowGap;
      let cy = lane.y + (lane.height - stackH) / 2;
      for (const n of stack) {
        n.x = Math.round(colX[r] + (colW[r] - n.w) / 2);
        n.y = Math.round(cy);
        cy += n.h + LAYOUT.rowGap;
      }
    }
  }

  out.lanes = laneList.map((l) => ({ ...l, y: Math.round(l.y), height: Math.round(l.height) }));
  for (const n of out.nodes) delete n._lines;
  out.width = Math.round(rightEdge);
  out.height = Math.round(y - LAYOUT.laneGap + LAYOUT.marginY);

  return { spec: out, size: { w: out.width, h: out.height } };
}

/** Guess how many text lines the editor will need, for the SVG exporter. */
export function linesFor(node, shape = 'rect') {
  return textLayout(node.label, shape).lines;
}
