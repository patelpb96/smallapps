/**
 * Public surface.
 *
 *   import { buildPlan, renderMarkdown } from './src/agent-plan/index.js';
 */

export { buildPlan, runHeuristics, topActions, summarize, ENGINE_VERSION } from './engine.js';
export { deriveFacts, validateAnswers } from './facts.js';
export { HEURISTICS, CATEGORIES, FACT_LABELS } from './heuristics.js';
export { QUESTIONS, GROUPS, PRESETS, defaultAnswers } from './intake.js';
export { SOURCES, cite } from './sources.js';
export {
  AUTONOMY_TIERS, SANDBOX_TIERS, TIER_INDEX,
  currentAutonomy, autonomyCeiling, assessSandbox, riskFlags,
} from './tiers.js';
export { renderMarkdown, renderChecklist, renderJson } from './render.js';
