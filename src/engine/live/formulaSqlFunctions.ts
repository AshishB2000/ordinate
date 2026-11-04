// Which formula functions a Live calculated field may call, and how each one is
// spelled in SQL (semantic layer part 8, step 03; docs/semantic-layer/08-engine.md
// D4–D6) — PURE.
//
// The table is keyed by EVERY name in formulaEval's FUNCTIONS (scripts/test-formulaSql
// holds the two key sets equal), so a function added to the formula language is
// refused on Live until someone spells it here and the differential holds it to
// evaluate(). One list for every dialect: a dataset that moves connection keeps working.

/** Why a function is refused on Live — each reason is one sentence in ./formulaSqlMessages.ts. */
export type LiveFnReason = 'math' | 'characters' | 'casing' | 'notMeasured' | 'regex' | 'dates' | 'clock' | 'conversion';
export type LiveFn = { v1: true; arity: readonly [number, number] } | { v1: false; reason: LiveFnReason };

const ANY = Infinity;

/** The v1 functions and how many arguments each takes on Live. */
const V1: Record<string, readonly [number, number]> = {
  abs: [1, 1], sign: [1, 1], floor: [1, 1], ceil: [1, 1], ceiling: [1, 1], sqrt: [1, 1], square: [1, 1],
  round: [1, 2], min: [1, ANY], max: [1, ANY],
  trim: [1, 1], contains: [2, 2], startswith: [2, 2], endswith: [2, 2], concat: [1, ANY],
  isnull: [1, 1], ifnull: [2, 2], coalesce: [1, ANY], zn: [1, 1], if: [3, 3], iif: [3, 4],
  year: [1, 1], month: [1, 1], day: [1, 1], quarter: [1, 1], datediff: [3, 3],
};

const REFUSED: Record<LiveFnReason, readonly string[]> = {
  math: ['power', 'exp', 'ln', 'log', 'sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'atan2', 'cot', 'pi', 'degrees', 'radians', 'distance_km'],
  characters: ['len', 'left', 'right', 'mid', 'find', 'findnth', 'split', 'ascii', 'char', 'space', 'proper'],
  // DuckDB and JS disagree on ß, İ and a final Σ (the pin in test-formulaSqlDiff); extracts keep both.
  casing: ['lower', 'upper'],
  notMeasured: ['replace', 'ltrim', 'rtrim', 'div'],
  regex: ['regexp_match', 'regexp_extract', 'regexp_extract_nth', 'regexp_replace'],
  dates: ['date', 'datetime', 'dateadd', 'datetrunc', 'makedate', 'maketime', 'makedatetime', 'datepart', 'datename',
    'week', 'isoweek', 'isoyear', 'isoquarter', 'isoweekday', 'isdate'],
  clock: ['today', 'now'],
  conversion: ['int', 'float', 'str'],
};

function table(): Record<string, LiveFn> {
  const out: Record<string, LiveFn> = {};
  for (const [name, arity] of Object.entries(V1)) out[name] = { v1: true, arity };
  for (const [reason, names] of Object.entries(REFUSED) as [LiveFnReason, readonly string[]][]) {
    for (const name of names) out[name] = { v1: false, reason };
  }
  return out;
}

export const LIVE_FUNCTIONS: Readonly<Record<string, LiveFn>> = Object.freeze(table());
export const V1_FUNCTIONS: readonly string[] = Object.freeze(Object.keys(V1));

/** A function's Live entry by its OWN name only (never one Object.prototype lends, as formulaParse checks). */
export function liveFn(name: string): LiveFn | undefined {
  return Object.hasOwn(LIVE_FUNCTIONS, name) ? LIVE_FUNCTIONS[name] : undefined;
}
