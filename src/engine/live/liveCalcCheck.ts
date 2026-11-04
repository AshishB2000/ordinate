// The save-time check of a Live dataset's calculated fields (semantic layer part 8, step 04; D6) — PURE.
//
// The editor sends the whole list; it is checked the way every statement will read it (./calcLayers): each
// name unique ignoring case against the warehouse's columns and the other calcs (BigQuery and Databricks
// resolve names without case), never a name the compiler aliases with (`lv_`, `o_`), and each formula a v1
// one over the columns and EARLIER calcs only (./formulaSql `checkCalc`). The stored type is the verdict's.
// Databricks is refused outright (owner's answer 1: no real-engine parity run there yet).

import type { SourceSpan } from '../../formula/formula';
import type { LiveCalc } from '../../data/liveCalcs';
import { MAX_CALC_NAME } from '../../data/liveCalcs';
import * as msg from '../../data/liveMessages';
import type { CompileDialectId } from './dialect';
import type { LiveColumn } from './liveSpec';
import { checkCalc } from './formulaSql';
import { hasNul } from './sqlParams';

export type CalcVerdict =
  | { ok: true; calculated: LiveCalc[] }
  | { ok: false; code: 'calc_invalid' | 'calc_dialect'; index?: number; error: string; at?: SourceSpan };

/** The compiler's own alias prefixes (./compile): a calc named like one could be mistaken for it. */
const RESERVED = /^(lv_|o_)/i;

/** Calcs are refused on these dialects, at save and at compile. */
export function calcsRefusedOn(dialect: CompileDialectId): boolean {
  return dialect === 'databricks';
}

/** Why a calc may not have this (trimmed) name, or null. `columns` and `calcs` (the ones before it) are lower-cased. */
function nameProblem(name: string, columns: ReadonlySet<string>, calcs: ReadonlySet<string>): string | null {
  if (!name || name.length > MAX_CALC_NAME || hasNul(name)) return msg.liveCalcNameInvalidMessage();
  if (RESERVED.test(name)) return msg.liveCalcNameReservedMessage(name);
  if (columns.has(name.toLowerCase())) return msg.liveCalcNameIsColumnMessage(name);
  if (calcs.has(name.toLowerCase())) return msg.liveCalcNameTakenMessage(name);
  return null;
}

/** The whole list, checked in order against the declared columns; the first problem refuses it, with its index. */
export function validateLiveCalcs(declared: LiveColumn[], input: { name: string; expression: string }[], dialect: CompileDialectId): CalcVerdict {
  if (calcsRefusedOn(dialect)) return { ok: false, code: 'calc_dialect', error: msg.liveCalcDatabricksMessage() };
  const columns = new Set(declared.map((c) => c.name.toLowerCase()));
  const asked = input.map((c) => ({ name: c.name.trim(), expression: c.expression }));
  const names = new Set<string>();
  const out: LiveCalc[] = [];
  for (let i = 0; i < asked.length; i += 1) {
    const { name, expression } = asked[i];
    const bad = nameProblem(name, columns, names);
    if (bad) return { ok: false, code: 'calc_invalid', index: i, error: bad };
    if (hasNul(expression)) return { ok: false, code: 'calc_invalid', index: i, error: msg.liveCalcExpressionInvalidMessage() };
    // The later calcs' types are not known yet; `checkCalc` only reads their names (a reference to one says so).
    const later = asked.slice(i + 1).map((c) => ({ ...c, type: 'text' as const }));
    const v = checkCalc(expression, declared, out, later);
    if (!v.ok) return { ok: false, code: 'calc_invalid', index: i, error: v.error, ...(v.at ? { at: v.at } : {}) };
    names.add(name.toLowerCase());
    out.push({ name, expression, type: v.type });
  }
  return { ok: true, calculated: out };
}
