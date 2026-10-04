// The power steps' one entry point for transforms.ts — MAIN PROCESS, PURE.
// transforms.dispatch() names each type in a `case` (scripts/test-prompts.ts
// reads that switch as the whitelist) and hands the step here; conditional_column
// is the exception, run by transforms' own calculated-field step.

import type { TableData } from './transforms';
import type { PipelineContext, PowerStep } from './stepTypes';
import type { PowerResult } from './stepsReshape';
import type { RegexMemo } from './regexMemo';
import { applyPivot, applySplit, applyUnpivot, skipped } from './stepsReshape';
import { applyDedupeKey, applyParseDate, applyReplace } from './stepsClean';
import { applyLookup, applyUnion } from './stepsCombine';
import { applyWindow } from './stepsWindow';
import { applySpatialJoin } from '../analysis/geo/spatialJoin';

export { POWER_STEP_TYPES } from './stepTypes';
export type { PipelineContext, PowerStep, StepCount } from './stepTypes';
export { sanitizePowerStep } from './stepsSanitize';
export { conditionalAsCalc } from './stepsClean';

/** `memo`: the regex worker's answers for a regex split / replace (./regexMemo.ts). */
export function applyPowerStep(t: TableData, step: PowerStep, ctx?: PipelineContext, memo?: RegexMemo): PowerResult {
  switch (step.type) {
    case 'split_column':
      return applySplit(t, step, memo);
    case 'unpivot':
      return applyUnpivot(t, step);
    case 'pivot':
      return applyPivot(t, step);
    case 'parse_date':
      return applyParseDate(t, step);
    case 'dedupe_key':
      return applyDedupeKey(t, step);
    case 'replace_values':
      return applyReplace(t, step, memo);
    case 'union':
      return applyUnion(t, step, ctx);
    case 'lookup_join':
      return applyLookup(t, step, ctx);
    case 'window':
      return applyWindow(t, step);
    case 'spatial_join':
      return applySpatialJoin(t, step, ctx); // r6:geo
    default:
      return skipped(t, `Unknown step type "${step.type}" skipped`);
  }
}
