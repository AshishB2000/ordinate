// Whitelisting for one `filter` step — PURE. `transforms.sanitizeStep` calls it, so renderer input,
// stored records and model suggestions all pass the same gate. Later fields of a filter step go here,
// not into transforms.ts (a file at its size cap).

import { isValidId } from '../app/ids';
import type { Cell, FilterStep } from './transforms';
import type { FilterOp } from './filterOps';
import { FILTER_OPS, PERIOD_OP } from './filterOps';
import { sanitizePeriod } from '../analysis/dateIntel';
import { RADIUS_OP, sanitizeRadius } from '../analysis/geo/radius';

function asString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function isCell(v: unknown): v is Cell {
  return typeof v === 'string' || typeof v === 'number' || v === null;
}

export function sanitizeFilterStep(o: Record<string, unknown>): FilterStep | null {
  const column = asString(o.column);
  const op = asString(o.op);
  if (column === undefined || op === undefined || !FILTER_OPS.has(op)) return null;
  const step: FilterStep = { type: 'filter', column, op: op as FilterOp };
  if (isCell(o.value)) step.value = o.value;
  // `values` is whitelisted the same way `value` is, element by element: a
  // non-array is dropped entirely and a non-Cell entry (object, array,
  // boolean, undefined) is dropped from the list rather than making the
  // whole step invalid. Nothing here can produce a nested structure, so a
  // hostile renderer/AI payload cannot smuggle one past this point into the
  // SQL builders — which is where an array would otherwise become an
  // uncontrolled number of bound parameters.
  if (Array.isArray(o.values)) step.values = o.values.filter(isCell);
  if (o.context === true) step.context = true;
  if (op === PERIOD_OP) {
    const period = sanitizePeriod(o.period);
    if (!period) return null;
    step.period = period;
  }
  if (op === RADIUS_OP) {
    const radius = sanitizeRadius(o.radius);
    if (!radius) return null;
    step.radius = radius;
  }
  // UUID-shaped only, as a measure's `datasetId` is: a relationship id, never a path or a name.
  if (isValidId(o.via)) step.via = o.via;
  if (isValidId(o.datasetId)) step.datasetId = o.datasetId; // a term's step from another dataset: kept, so no save turns it into this table's
  if (o.fromControl === true) step.fromControl = true;
  return step;
}
