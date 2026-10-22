/**
 * Flow: natural language → editable workflow diagram.
 *
 *   import { fromText } from './src/flow/index.js';
 *   const { spec, issues } = fromText('when a ticket arrives, ...');
 */

export { interpret, INTERPRETER_VERSION } from './interpret.js';
export { layout, rankNodes, LAYOUT } from './layout.js';
export { analyze, findCycles } from './hazards.js';
export { renderSVG, renderNode, renderEdge, renderLane, renderDefs, PALETTE } from './render.js';
export { routeEdge, rectOf, measureNode, textLayout, portPoint, pointInRect, wrapLabel, snap, METRICS } from './geometry.js';
export {
  emptySpec, normalizeSpec, validateSpec, cloneSpec, specHash, nextId, slug,
  nodeById, SPEC_VERSION, EDGE_KINDS, LANE_KINDS,
} from './spec.js';
export {
  PRIMITIVES, CATEGORY, EFFECT_LABELS, getPrimitive, hasPrimitive,
  primitivesByCategory, effectsOf,
} from './primitives.js';

import { interpret } from './interpret.js';
import { layout } from './layout.js';
import { analyze } from './hazards.js';

/**
 * The one-call path used by the CLI, the tests and the app's "generate" button.
 * @param {string} text
 * @param {{title?: string, relayout?: boolean}} [opts]
 */
export function fromText(text, opts = {}) {
  const result = interpret(text, opts);
  const laid = layout(result.spec, {});
  const analysis = analyze(laid.spec);
  return {
    spec: laid.spec,
    size: laid.size,
    issues: result.issues,
    analysis,
    interpreter: result.interpreter,
  };
}
