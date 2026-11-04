// The step sanitizer: drops unknown types and fields from untrusted renderer / AI / stored input.
// Moved out of transforms.ts (the 800-line cap) unchanged; transforms.ts re-exports `sanitizeSteps`.
// `STEP_TYPES` and `AGG_FNS` come from transforms.ts at CALL time, so the import cycle is safe.

import type { Aggregation, AggFn, DedupeStep, TransformStep, TrimStep } from './transforms';
import { AGG_FNS, STEP_TYPES } from './transforms';
import { sanitizeMaskStep } from './maskSteps';
import { POWER_STEP_TYPES, sanitizePowerStep } from './stepsPower';
import { sanitizeSegmentStep } from './stepsSegment';
import { TEXT_STEP_TYPES, sanitizeTextStep } from './textStepTypes';
import { sanitizeFilterStep } from './filterStepSanitize';

export function sanitizeSteps(raw: unknown): TransformStep[] {
  if (!Array.isArray(raw)) return [];
  const out: TransformStep[] = [];
  for (const item of raw) {
    const step = sanitizeStep(item);
    if (step) out.push(step);
  }
  return out;
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function sanitizeStep(item: unknown): TransformStep | null {
  if (!item || typeof item !== 'object') return null;
  const o = item as Record<string, unknown>;
  const type = o.type;
  if (typeof type !== 'string' || !STEP_TYPES.has(type)) return null;
  if (POWER_STEP_TYPES.has(type)) return sanitizePowerStep(o);
  if (type === 'segment') return sanitizeSegmentStep(o);
  if (TEXT_STEP_TYPES.has(type)) return sanitizeTextStep(o);

  switch (type) {
    case 'calculated_field': {
      const name = asString(o.name);
      const expression = asString(o.expression);
      if (name === undefined || expression === undefined) return null;
      return { type, name, expression };
    }
    case 'filter':
      return sanitizeFilterStep(o);
    case 'group_aggregate': {
      const groupByRaw = Array.isArray(o.groupBy) ? o.groupBy : [];
      const groupBy = groupByRaw.filter((v): v is string => typeof v === 'string');
      const aggsRaw = Array.isArray(o.aggregations) ? o.aggregations : [];
      const aggregations: Aggregation[] = [];
      for (const a of aggsRaw) {
        if (!a || typeof a !== 'object') continue;
        const ao = a as Record<string, unknown>;
        const column = asString(ao.column);
        const fn = asString(ao.fn);
        const as = asString(ao.as);
        if (column === undefined || fn === undefined || as === undefined || !AGG_FNS.has(fn)) continue;
        aggregations.push({ column, fn: fn as AggFn, as });
      }
      return { type, groupBy, aggregations };
    }
    case 'dedupe': {
      const step: DedupeStep = { type };
      if (Array.isArray(o.columns)) {
        step.columns = o.columns.filter((v): v is string => typeof v === 'string');
      }
      return step;
    }
    case 'fill_empty': {
      const column = asString(o.column);
      if (column === undefined) return null;
      const value = typeof o.value === 'number' ? o.value : asString(o.value);
      if (value === undefined) return null;
      return { type, column, value };
    }
    case 'trim': {
      const step: TrimStep = { type };
      const column = asString(o.column);
      if (column !== undefined) step.column = column;
      return step;
    }
    case 'drop_column': {
      const column = asString(o.column);
      if (column === undefined) return null;
      return { type, column };
    }
    case 'rename_column': {
      const from = asString(o.from);
      const to = asString(o.to);
      if (from === undefined || to === undefined) return null;
      return { type, from, to };
    }
    case 'mask_hash':
    case 'mask_redact':
    case 'mask_generalize':
      return sanitizeMaskStep(o);
    default:
      return null;
  }
}
