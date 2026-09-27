// The power steps' one entry point for transforms.ts — MAIN PROCESS, PURE.
// transforms.dispatch() names each type in a `case` (scripts/test-prompts.ts
// reads that switch as the whitelist) and hands the step here; conditional_column
// is the exception, run by transforms' own calculated-field step.

import type { TableData } from './transforms';
import type { PipelineContext, PowerStep } from './stepTypes';
import type { PowerResult } from './stepsReshape';
import { applyPivot, applySplit, applyUnpivot, skipped } from './stepsReshape';
import { applyDedupeKey, applyParseDate, applyReplace } from './stepsClean';
import { applyLookup, applyUnion } from './stepsCombine';
import { applyWindow } from './stepsWindow';

export { POWER_STEP_TYPES } from './stepTypes';
export type { PipelineContext, PowerStep, StepCount } from './stepTypes';
export { sanitizePowerStep } from './stepsSanitize';
export { conditionalAsCalc } from './stepsClean';

export function applyPowerStep(t: TableData, step: PowerStep, ctx?: PipelineContext): PowerResult {
  switch (step.type) {
    case 'split_column':
      return applySplit(t, step);
    case 'unpivot':
      return applyUnpivot(t, step);
    case 'pivot':
      return applyPivot(t, step);
    case 'parse_date':
      return applyParseDate(t, step);
    case 'dedupe_key':
      return applyDedupeKey(t, step);
    case 'replace_values':
      return applyReplace(t, step);
    case 'union':
      return applyUnion(t, step, ctx);
    case 'lookup_join':
      return applyLookup(t, step, ctx);
    case 'window':
      return applyWindow(t, step);
    default:
      return skipped(t, `Unknown step type "${step.type}" skipped`);
  }
}
