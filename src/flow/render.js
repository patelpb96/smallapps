/**
 * SVG rendering.
 *
 * One renderer for both the editor and the standalone export, so the PNG you
 * send someone is the picture you were looking at.
 *
 * Colours come from a theme object rather than CSS variables, because exports
 * have to stand alone in a file with no stylesheet — and the canvas has to match
 * whatever background it is dropped onto.
 *
 * Shapes are square-cornered on purpose: no rounded rectangles anywhere. The
 * shapes that read as different are polygons (diamond, hexagon, parallelogram,
 * cylinder) or an ellipse, not rounded boxes.
 */

import { getPrimitive, CATEGORY } from './primitives.js';
import { textLayout, rectOf, routeEdge, labelPoint, METRICS } from './geometry.js';

/** Category accents, tuned per theme so they stay legible on each background. */
const ACCENT = {
  light: {
    violet: '#7c3aed',
    amber: '#b45309',
    blue: '#1d4ed8',
    teal: '#0f766e',
    cyan: '#0e7490',
    slate: '#475569',
    rose: '#be123c',
    gray: '#57606a',
  },
  dark: {
    violet: '#a78bfa',
    amber: '#f0b35e',
    blue: '#8dabff',
    teal: '#4fd1c5',
    cyan: '#5ec8dd',
    slate: '#94a3b8',
    rose: '#fb7185',
    gray: '#9ba3ae',
  },
};

export const THEMES = {
  light: {
    accent: ACCENT.light,
    ink: '#1b1b19',
    inkSoft: '#55554f',
    inkFaint: '#8a8a82',
    line: '#d8d8d1',
    nodeFill: '#ffffff',
    laneFill: ['#fcfcfa', '#f6f6f2'],
    band: '#ffffff',
    edge: '#9b9b93',
    edgeBranch: '#7c7c74',
    labelFill: '#ffffff',
    danger: '#b42318',
    select: '#3b5bdb',
  },
  dark: {
    accent: ACCENT.dark,
    ink: '#ececea',
    inkSoft: '#a8a8a2',
    inkFaint: '#7a7a72',
    line: '#30302c',
    nodeFill: '#1b1b1a',
    laneFill: ['#171716', '#1c1c1b'],
    band: '#101010',
    edge: '#6f6f67',
    edgeBranch: '#8a8a80',
    labelFill: '#1b1b1a',
    danger: '#ff8a7a',
    select: '#8dabff',
  },
};

export const PALETTE = ACCENT.light;

export function themeOf(name) {
  return THEMES[name] || THEMES.light;
}

/** Accent for a primitive in a given theme. */
export function accentFor(primitiveId, theme = 'light') {
  const t = themeOf(theme);
  const cat = getPrimitive(primitiveId).category;
  return t.accent[CATEGORY[cat]?.accent] || t.accent.slate;
}

const GLYPHS = {
  play: 'M5.5 3.2 12.5 8 5.5 12.8Z',
  stop: 'M5 5h6v6H5Z',
  clock: 'M8 2.4a5.6 5.6 0 1 0 0 11.2A5.6 5.6 0 1 0 8 2.4M8 5v3.3l2.3 1.4',
  bolt: 'M9.2 2 4.3 9.1H7.8L6.8 14l5-7.2H8.2Z',
  mail: 'M2.8 4.6h10.4v6.8H2.8Z M2.8 4.6 8 8.6l5.2-4',
  person: 'M8 3.1a2.1 2.1 0 1 0 0 4.2 2.1 2.1 0 1 0 0-4.2 M3.7 13c0-2.4 2-3.7 4.3-3.7S12.3 10.6 12.3 13',
  check: 'M3.4 8.3 6.5 11.3 12.6 4.5',
  eye: 'M1.7 8s2.7-4.1 6.3-4.1S14.3 8 14.3 8s-2.7 4.1-6.3 4.1S1.7 8 1.7 8 M8 6.2a1.8 1.8 0 1 0 0 3.6 1.8 1.8 0 1 0 0-3.6',
  arrow: 'M2.8 8h9.4 M9 4.4 12.6 8 9 11.6',
  spark: 'M8 2.2 9.6 6.4 13.8 8 9.6 9.6 8 13.8 6.4 9.6 2.2 8 6.4 6.4Z',
  loop: 'M3.4 8a4.6 4.6 0 0 1 9.2 0 M12.6 8a4.6 4.6 0 0 1-9.2 0 M10.9 4.9 12.8 6.6 11 8.2',
  tag: 'M2.4 7.9V2.8h5.1l6 6-5.1 5.1Z M5.2 5.2h.1',
  lines: 'M3 4.8h9.4 M3 8h9.4 M3 11.2h6',
  branch: 'M3 8h3.6 M6.8 8 10.4 4.2h3 M6.8 8l3.6 3.8h3',
  db: 'M3.4 4.4c0-1 2.1-1.7 4.6-1.7s4.6.7 4.6 1.7v7.2c0 1-2.1 1.7-4.6 1.7s-4.6-.7-4.6-1.7Z M3.4 4.4c0 1 2.1 1.7 4.6 1.7s4.6-.7 4.6-1.7',
  globe: 'M8 2.2a5.8 5.8 0 1 0 0 11.6A5.8 5.8 0 1 0 8 2.2 M2.2 8h11.6 M8 2.2c2.3 2.1 2.3 9.5 0 11.6 M8 2.2C5.7 4.3 5.7 11.7 8 13.8',
  pencil: 'M2.9 13.1 3.7 10 11 2.7l2.3 2.3L6 12.3Z',
  terminal: 'M3 4.4 7 8l-4 3.6 M9.2 11.9h3.8',
  cursor: 'M4.2 2.8 12 8.2l-3.7.6-1.5 3.3Z',
  file: 'M4 2.6h5l2.8 2.8v8H4Z M9 2.6v2.8h2.8',
  layers: 'M8 2.4 13 5 8 7.6 3 5Z M3 8.4 8 11l5-2.6',
  stack: 'M3.4 4.6h9.2 M3.4 8h9.2 M3.4 11.4h9.2',
  split: 'M2.8 8h3.4 M6.2 8 9.4 4.4h3.4 M6.2 8l3.2 3.6h3.4',
  merge: 'M2.8 4.6h3.4L9.4 8h3.4 M2.8 11.4h3.4L9.4 8',
  box: 'M3 3.8h10v8.4H3Z',
  send: 'M2.2 8 13.2 2.8 10 13.2 7.5 8.6Z',
  plug: 'M5.4 2.4v3 M10.6 2.4v3 M3.6 5.4h8.8v3.2a4.4 4.4 0 0 1-8.8 0Z',
  broadcast: 'M8 7.1a.9.9 0 1 0 0 1.8.9.9 0 1 0 0-1.8 M5.3 5.3a3.9 3.9 0 0 0 0 5.4 M10.7 5.3a3.9 3.9 0 0 1 0 5.4 M3 3a7 7 0 0 0 0 10 M13 3a7 7 0 0 1 0 10',
  alert: 'M8 2.6 14.1 13H1.9Z M8 6.3v3.5 M8 11.3v.1',
  up: 'M8 13.2V3.4 M4.6 6.8 8 3.4l3.4 3.4',
};

const GLYPH_ALIAS = { database: 'db', scan: 'lines' };

export function glyphPath(name) {
  return GLYPHS[GLYPH_ALIAS[name] || name] || GLYPHS.box;
}

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

/**
 * Shape outline.
 *
 * Square corners everywhere a rectangle is drawn. `round` keeps its identity as
 * the "predefined process" double-border rather than by being softer than its
 * neighbours, and `pill` collapses to a rectangle — the caption and colour carry
 * the meaning.
 */
function shapeMarkup(shape, w, h, accent, { selected, dimmed, t }) {
  const stroke = selected ? t.select : accent;
  const sw = selected ? 2 : 1.4;
  const common = `fill="${t.nodeFill}" stroke="${stroke}" stroke-width="${sw}"`;
  const opacity = dimmed ? ' opacity="0.35"' : '';
  const inset = 1;

  switch (shape) {
    case 'round':
      // Double border: reads as a distinct shape without a rounded corner.
      return `<rect x="${inset}" y="${inset}" width="${w - 2}" height="${h - 2}" ${common}${opacity}/>`
        + `<rect x="${inset + 4}" y="${inset + 4}" width="${w - 10}" height="${h - 10}" fill="none" stroke="${stroke}" stroke-width="1" opacity="${dimmed ? 0.2 : 0.45}"/>`;
    case 'diamond':
      return `<path d="M ${w / 2} 1 L ${w - 1} ${h / 2} L ${w / 2} ${h - 1} L 1 ${h / 2} Z" ${common}${opacity}/>`;
    case 'hex': {
      const c = Math.min(18, h / 3);
      return `<path d="M ${c} 1 H ${w - c} L ${w - 1} ${h / 2} L ${w - c} ${h - 1} H ${c} L 1 ${h / 2} Z" ${common}${opacity}/>`;
    }
    case 'slant': {
      const c = Math.min(16, w / 6);
      return `<path d="M ${c} 1 H ${w - 1} L ${w - c} ${h - 1} H 1 Z" ${common}${opacity}/>`;
    }
    case 'cylinder': {
      const ry = Math.min(9, h / 6);
      return `<path d="M 1 ${ry + 1} A ${(w - 2) / 2} ${ry} 0 0 1 ${w - 1} ${ry + 1} V ${h - ry - 1} A ${(w - 2) / 2} ${ry} 0 0 1 1 ${h - ry - 1} Z" ${common}${opacity}/>`
        + `<path d="M 1 ${ry + 1} A ${(w - 2) / 2} ${ry} 0 0 0 ${w - 1} ${ry + 1}" fill="none" stroke="${stroke}" stroke-width="${sw}"${opacity}/>`;
    }
    case 'circle':
      return `<ellipse cx="${w / 2}" cy="${h / 2}" rx="${w / 2 - 1}" ry="${h / 2 - 1}" ${common}${opacity}/>`;
    case 'pill':
    default:
      return `<rect x="${inset}" y="${inset}" width="${w - 2}" height="${h - 2}" ${common}${opacity}/>`;
  }
}

/** Render one node as a `<g>` string. */
export function renderNode(node, opts = {}) {
  const { selected = false, dimmed = false, connectable = false, theme = 'light' } = opts;
  const t = themeOf(theme);
  const rect = rectOf(node);
  const prim = getPrimitive(node.primitive);
  const accent = accentFor(node.primitive, theme);
  const isDiamond = prim.shape === 'diamond';

  const padX = 14;
  const iconBox = 20;
  const textX = isDiamond ? 0 : padX + iconBox + 7;
  const { lines } = textLayout(node.label, prim.shape);
  // Repeated text ("Done" / "DONE") is noise, not information.
  const caption = prim.label.toLowerCase() === String(node.label).trim().toLowerCase() ? '' : prim.label;

  const blockH = lines.length * 15 + (caption ? 14 : 0);
  const top = isDiamond
    ? rect.h / 2 - blockH / 2 + (caption ? 0 : 2)
    : (rect.h - blockH) / 2 + 1;

  const tspans = lines.map((l, i) => (
    isDiamond
      ? `<tspan x="${rect.w / 2}" y="${(top + 12 + i * 15).toFixed(1)}" text-anchor="middle">${esc(l)}</tspan>`
      : `<tspan x="${textX}" y="${(top + 12 + i * 15).toFixed(1)}">${esc(l)}</tspan>`
  )).join('');

  // The diamond already reads as a decision; a caption would sit outside it.
  const captionEl = (caption && !isDiamond) ? (
    `<text x="${textX}" y="${(top + 12 + lines.length * 15 + 2).toFixed(1)}" font-size="8.5" font-weight="600" letter-spacing="0.6" fill="${accent}" opacity="0.9">${esc(caption.toUpperCase())}</text>`
  ) : '';

  const iconY = isDiamond ? rect.h / 2 - 8 : top + 4;
  const icon = `<g transform="translate(${padX},${iconY.toFixed(1)}) scale(0.86)" fill="none" stroke="${accent}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" opacity="${dimmed ? 0.3 : 0.9}"><path d="${glyphPath(prim.glyph)}"/></g>`;

  const effectDots = primaryEffectDots(node, rect, t);

  const handles = connectable ? `
    <circle class="port" data-node="${node.id}" data-port="in" cx="0" cy="${rect.h / 2}" r="5" fill="${t.nodeFill}" stroke="${accent}" stroke-width="1.5"/>
    <circle class="port" data-node="${node.id}" data-port="out" cx="${rect.w}" cy="${rect.h / 2}" r="5" fill="${t.nodeFill}" stroke="${accent}" stroke-width="1.5"/>
  ` : '';

  return `<g class="node" data-node="${node.id}" data-shape="${prim.shape}" transform="translate(${rect.x},${rect.y})"${dimmed ? ' opacity="0.45"' : ''}>
    ${shapeMarkup(prim.shape, rect.w, rect.h, accent, { selected, dimmed, t })}
    ${isDiamond ? '' : icon}
    <text font-size="12.5" font-weight="520" fill="${t.ink}">${tspans}</text>
    ${captionEl}
    ${effectDots}
    ${handles}
  </g>`;
}

/** Small corner marks for the effects that drive the hazard checks. */
function primaryEffectDots(node, rect, t) {
  const effects = getPrimitive(node.primitive).effects;
  const marks = [];
  if (effects.includes('untrusted-input')) marks.push({ c: t.accent.rose, label: 'untrusted input' });
  if (effects.includes('sensitive-read')) marks.push({ c: t.accent.cyan, label: 'reads sensitive data' });
  if (effects.includes('external-egress')) marks.push({ c: t.accent.violet, label: 'can send data out' });
  if (effects.includes('irreversible')) marks.push({ c: t.danger, label: 'irreversible' });
  if (!marks.length) return '';

  return marks.map((m, i) => {
    const cx = rect.w - 7 - i * 8;
    return `<circle cx="${cx}" cy="7" r="2.6" fill="${m.c}"><title>${esc(m.label)}</title></circle>`;
  }).join('');
}

/** Render one edge. */
export function renderEdge(edge, fromNode, toNode, opts = {}) {
  const { selected = false, dimmed = false, highlighted = false, theme = 'light' } = opts;
  const t = themeOf(theme);
  if (!fromNode || !toNode) return '';
  const route = routeEdge(rectOf(fromNode), rectOf(toNode), edge.fromPort || 'out', 'in');

  let stroke = t.edge;
  let dash = '';
  if (edge.kind === 'error') { stroke = t.danger; dash = ' stroke-dasharray="5 4"'; }
  else if (edge.kind === 'branch') stroke = t.edgeBranch;
  else if (edge.kind === 'async') { dash = ' stroke-dasharray="2 4"'; }
  else if (edge.kind === 'loop') { stroke = t.accent.amber; dash = ' stroke-dasharray="6 4"'; }
  if (selected) stroke = t.select;
  if (highlighted) stroke = t.danger;

  const width = selected || highlighted ? 2.2 : 1.5;
  const marker = edge.kind === 'error' ? 'arrow-danger' : selected || highlighted ? 'arrow-select' : 'arrow';

  let label = '';
  if (edge.label || edge.fromPort === 'true' || edge.fromPort === 'false') {
    const text = edge.label || (edge.fromPort === 'true' ? 'yes' : 'no');
    const p = labelPoint(route.points);
    const w = text.length * 5.2 + 10;
    label = `<g class="edge-label"><rect x="${(p.x - w / 2).toFixed(1)}" y="${(p.y - 8).toFixed(1)}" width="${w.toFixed(1)}" height="15" fill="${t.labelFill}" stroke="${stroke}" stroke-width="0.8"/>`
      + `<text x="${p.x.toFixed(1)}" y="${(p.y + 3).toFixed(1)}" text-anchor="middle" font-size="9.5" font-weight="600" fill="${stroke}">${esc(text)}</text></g>`;
  }

  return `<g class="edge" data-edge="${edge.id}"${dimmed ? ' opacity="0.3"' : ''}>
    <path d="${route.d}" fill="none" stroke="${stroke}" stroke-width="${width}" stroke-linecap="round"${dash} marker-end="url(#${marker})"/>
    ${label}
  </g>`;
}

/** Render one swimlane band. */
export function renderLane(lane, index, width, theme = 'light') {
  const t = themeOf(theme);
  const y = lane.y || 0;
  const h = lane.height || 96;
  const fill = t.laneFill[index % t.laneFill.length];
  const kindLabel = { human: 'HUMAN', agent: 'MODEL', system: 'SYSTEM' }[lane.kind] || 'SYSTEM';
  const kindColor = lane.kind === 'human' ? t.accent.amber : lane.kind === 'agent' ? t.accent.blue : t.accent.gray;

  return `<g class="lane" data-lane="${lane.id}">
    <rect x="0" y="${y}" width="${width}" height="${h}" fill="${fill}" stroke="${t.line}" stroke-width="1"/>
    <rect x="0" y="${y}" width="${METRICS.minW + 60}" height="${h}" fill="${fill}"/>
    <line x1="${METRICS.minW + 60}" y1="${y}" x2="${METRICS.minW + 60}" y2="${y + h}" stroke="${t.line}" stroke-width="1" opacity="0.7"/>
    <text x="18" y="${y + h / 2 - 3}" font-size="9" font-weight="700" letter-spacing="0.8" fill="${kindColor}" opacity="0.9">${kindLabel}</text>
    <text x="18" y="${y + h / 2 + 13}" font-size="13" font-weight="600" fill="${t.ink}">${esc(truncate(lane.name, 18))}</text>
  </g>`;
}

const truncate = (s, n) => (String(s).length > n ? `${String(s).slice(0, n - 1)}…` : String(s));

export function renderDefs(theme = 'light') {
  const t = themeOf(theme);
  return `<defs>
    <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M 0 0 L 10 5 L 0 10 z" fill="${t.edge}"/>
    </marker>
    <marker id="arrow-select" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M 0 0 L 10 5 L 0 10 z" fill="${t.select}"/>
    </marker>
    <marker id="arrow-danger" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M 0 0 L 10 5 L 0 10 z" fill="${t.danger}"/>
    </marker>
  </defs>`;
}

/**
 * Complete standalone SVG document.
 * @param {object} spec
 * @param {{width?: number, height?: number, theme?: 'light'|'dark'}} [opts]
 */
export function renderSVG(spec, opts = {}) {
  const theme = opts.theme === 'dark' ? 'dark' : 'light';
  const t = themeOf(theme);
  const width = opts.width || spec.width || 900;
  const height = opts.height || spec.height || 500;
  const byId = new Map(spec.nodes.map((n) => [n.id, n]));

  const lanes = spec.lanes.map((l, i) => renderLane(l, i, width, theme)).join('\n');
  const edges = spec.edges
    .map((e) => renderEdge(e, byId.get(e.from), byId.get(e.to), { theme }))
    .join('\n');
  const nodes = spec.nodes.map((n) => renderNode(n, { theme })).join('\n');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="ui-sans-serif, -apple-system, 'Segoe UI', Inter, Roboto, sans-serif">
${renderDefs(theme)}
<rect width="${width}" height="${height}" fill="${t.band}"/>
${lanes}
${edges}
${nodes}
</svg>`;
}
