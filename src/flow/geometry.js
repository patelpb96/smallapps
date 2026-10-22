/**
 * Geometry: node sizing, port anchors, edge routing.
 *
 * Pure functions over plain rects. The editor calls these; it does not do its
 * own maths. That keeps routing testable without a DOM.
 */

export const METRICS = {
  minW: 136,
  maxW: 296,
  baseH: 58,
  diamondH: 84,
  charW: 6.72,
  lineH: 15.5,
  padX: 26,
  iconW: 26,
  corner: 9,
};

/** Wrap a label into at most `maxLines` lines of roughly `maxChars`. */
export function wrapLabel(label, maxChars) {
  const words = String(label || '').split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const w of words) {
    if (!line) { line = w; continue; }
    if (`${line} ${w}`.length <= maxChars) line += ` ${w}`;
    else { lines.push(line); line = w; }
  }
  if (line) lines.push(line);
  return lines.length ? lines : [''];
}

/**
 * Text layout for a node: how the label wraps and how much room it needs.
 *
 * Diamonds get a much narrower text column, because the shape only offers full
 * width at its waist — the honest fix is to wrap harder, not to draw a diamond
 * so wide it stops reading as a decision.
 */
export function textLayout(label, shape = 'rect') {
  const text = label || '';

  if (shape === 'diamond') {
    const lines = wrapLabel(text, 15);
    const widest = Math.max(...lines.map((l) => l.length));
    return {
      lines,
      maxChars: 15,
      w: Math.round(Math.min(METRICS.maxW, Math.max(196, widest * 7.6 + 96))),
      h: Math.max(METRICS.diamondH, lines.length * 15 + 62),
    };
  }

  const maxChars = Math.max(10, Math.floor((METRICS.maxW - METRICS.padX * 2 - METRICS.iconW) / METRICS.charW));
  const lines = wrapLabel(text, maxChars);
  const widest = Math.max(...lines.map((l) => l.length));
  const textW = widest * METRICS.charW + METRICS.iconW;
  const w = Math.round(Math.min(METRICS.maxW, Math.max(METRICS.minW, textW + METRICS.padX * 2)));
  const h = Math.round(METRICS.baseH + Math.max(0, lines.length - 1) * METRICS.lineH);

  if (shape === 'circle') return { lines, maxChars, w: Math.max(w, 122), h: Math.max(h, 76) };
  return { lines, maxChars, w, h };
}

/** Size a node from its label and shape. Deliberately generous. */
export function measureNode(node) {
  const { w, h, lines } = textLayout(node.label, node.shape);
  return { w, h, lines };
}

/** Absolute rect for a node. */
export function rectOf(node) {
  return { x: node.x || 0, y: node.y || 0, w: node.w || 160, h: node.h || 58 };
}

/**
 * Anchor point for an edge end.
 *   in  → left middle
 *   out → right middle
 *   true/false → right side, upper/lower
 *   error → bottom middle
 */
export function portPoint(rect, port = 'out') {
  switch (port) {
    case 'in': return { x: rect.x, y: rect.y + rect.h / 2 };
    case 'true': return { x: rect.x + rect.w, y: rect.y + rect.h * 0.34 };
    case 'false': return { x: rect.x + rect.w, y: rect.y + rect.h * 0.72 };
    case 'error': return { x: rect.x + rect.w / 2, y: rect.y + rect.h };
    default: return { x: rect.x + rect.w, y: rect.y + rect.h / 2 };
  }
}

/** Rounded polyline path. */
export function roundedPath(points, radius = METRICS.corner) {
  if (points.length < 2) return '';
  const d = [`M ${round(points[0].x)} ${round(points[0].y)}`];
  for (let i = 1; i < points.length - 1; i++) {
    const prev = points[i - 1];
    const cur = points[i];
    const next = points[i + 1];
    const d1 = dist(prev, cur);
    const d2 = dist(cur, next);
    const r = Math.min(radius, d1 / 2, d2 / 2);
    if (r < 0.5) { d.push(`L ${round(cur.x)} ${round(cur.y)}`); continue; }
    const a = lerpTo(cur, prev, r / (d1 || 1));
    const b = lerpTo(cur, next, r / (d2 || 1));
    d.push(`L ${round(a.x)} ${round(a.y)}`);
    d.push(`Q ${round(cur.x)} ${round(cur.y)} ${round(b.x)} ${round(b.y)}`);
  }
  const last = points[points.length - 1];
  d.push(`L ${round(last.x)} ${round(last.y)}`);
  return d.join(' ');
}

/**
 * Route an edge between two rects.
 *
 * Forward edges take a simple Z. Back edges (target left of source) loop out on
 * both sides so they do not cut through the nodes they are skipping over.
 */
export function routeEdge(fromRect, toRect, fromPort = 'out', toPort = 'in') {
  const p1 = portPoint(fromRect, fromPort);
  const p2 = portPoint(toRect, toPort);
  const clear = 26;

  if (p2.x - p1.x >= clear * 2) {
    const midX = Math.round((p1.x + p2.x) / 2);
    return {
      d: roundedPath([p1, { x: midX, y: p1.y }, { x: midX, y: p2.y }, p2]),
      points: [p1, { x: midX, y: p1.y }, { x: midX, y: p2.y }, p2],
      back: false,
    };
  }

  // Back edge: exit right, run vertically in the gap, re-enter from the left.
  const midY = Math.round((p1.y + p2.y) / 2);
  const outX = Math.round(p1.x + clear);
  const inX = Math.round(p2.x - clear);
  const points = [
    p1,
    { x: outX, y: p1.y },
    { x: outX, y: midY },
    { x: inX, y: midY },
    { x: inX, y: p2.y },
    p2,
  ];
  return { d: roundedPath(points), points, back: true };
}

/** Point at the middle of the longest segment — where a label sits. */
export function labelPoint(points) {
  let best = { a: points[0], b: points[1], len: -1 };
  for (let i = 1; i < points.length; i++) {
    const len = dist(points[i - 1], points[i]);
    if (len > best.len) best = { a: points[i - 1], b: points[i], len };
  }
  return { x: (best.a.x + best.b.x) / 2, y: (best.a.y + best.b.y) / 2 };
}

export function pointInRect(pt, rect) {
  return pt.x >= rect.x && pt.x <= rect.x + rect.w && pt.y >= rect.y && pt.y <= rect.y + rect.h;
}

/** Nearest edge of a rect to a point — used when dropping a connection. */
export function nearestPort(rect, pt) {
  const dx = pt.x - (rect.x + rect.w / 2);
  const dy = pt.y - (rect.y + rect.h / 2);
  if (Math.abs(dx) > Math.abs(dy)) return dx < 0 ? 'in' : 'out';
  return dy < 0 ? 'in' : 'out';
}

export const snap = (v, grid = 8) => Math.round(v / grid) * grid;
export const round = (v) => Math.round(v * 10) / 10;
const dist = (a, b) => Math.hypot(b.x - a.x, b.y - a.y);
const lerpTo = (from, to, t) => ({ x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t });
