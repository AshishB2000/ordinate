// The question's words among one dataset's stored text values (docs/assistant/00-design.md, step 3 "Values") — the
// RESIDENT half and its JS reference. MAIN PROCESS ONLY.
//
// ONE statement a dataset, off its Parquet in place: the given text columns unpivoted (UNNEST), the rows `filters` (the
// caller's row lock) keep first, then each distinct value where a question word starts a word of it (a word under
// PREFIX_MIN letters: is a whole word of it), ignoring case, at most PER_COLUMN a column, first seen first, PER_DATASET
// in all. A word is a run of letters, digits and marks, as ⌘K's (../app/searchMatch `wordsOf`). A value over VALUE_BYTES
// of UTF-8 is never listed: a prompt cuts a long value (../ai/promptText), and a cut value is no stored spelling. Null
// on any failure; the caller lists nothing rather than hydrate (there is no fallback on the ask path).
//
// The rule is ONE pattern, run by RE2 here and by JS's own engine in the reference (`searchValuesJs`; flags `iu`, the
// Unicode simple case folding RE2's `(?i)` also uses). Case-insensitive in the pattern, not `lower()` on the value:
// measured on 1,000,000 rows of five text columns (a loaded laptop), lower() and a regex 1,666 ms, `(?i)` 758 ms, the
// scan alone 214 ms. scripts/test-askValueSearch.ts holds the two Object.is-equal.
//
// The value index (src/ipc/valueIndex.ts, a sidecar per dataset) stores each value under its words' KEYS (`valueKeys`) and looks a
// question word up as a key range (`keyRange`): a superset of what the rule matches, as a key folds every letter of a
// case class to one string (upper, lower, upper again, a code point at a time: ß and ẞ both "SS", ſ, s and S all "S").
// What it finds is then tested by `valueMatches`, the rule itself. scripts/test-askValueIndex.ts checks the fold over
// every code point. `known` (below) is how a row lock confirms the values found: the same statement, `v IN (…)` in
// place of the pattern.

import type { ParsedColumn } from '../data/parse';
import type { Cell, FilterStep } from '../data/transforms';
import { applyPipeline } from '../data/transforms';
import { filterPredicates, runOrderedAsync } from './residentQuery';
import { bomSafe, phys } from './residentCategory';
import type { DuckValue } from './duckdb';

export const PER_COLUMN = 3;
export const PER_DATASET = 5;
export const VALUE_BYTES = 60;
/** A question word this long or longer matches the start of a value's word; a shorter one ("eu", "us") only the whole word. */
export const PREFIX_MIN = 4;

export interface ValueHit { column: string; value: string }

const NOT_WORD = '[^\\p{L}\\p{N}\\p{M}]';
/** A word as `wordsOf` makes one, so it can never carry a pattern's metacharacter. */
const isWord = (w: string): boolean => /^[\p{L}\p{N}\p{M}]+$/u.test(w);

/** The rule as one pattern, for RE2 (`(?i)` before it) and JS (flags `iu`): a word start, then a word (a short one, then a word end). */
function wordsPattern(words: readonly string[]): string {
  const long = words.filter((w) => w.length >= PREFIX_MIN);
  const short = words.filter((w) => w.length < PREFIX_MIN);
  const alts = [...(long.length ? [long.join('|')] : []), ...(short.length ? [`(?:${short.join('|')})(?:${NOT_WORD}|$)`] : [])];
  return `(?:^|${NOT_WORD})(?:${alts.join('|')})`;
}

/** Does `value` hold one of `words` by the rule? The reference's test, one value at a time. */
export function valueMatches(value: string, words: readonly string[]): boolean {
  const ws = words.filter(isWord);
  return ws.length > 0 && new RegExp(wordsPattern(ws), 'iu').test(value);
}

const each = (s: string, f: (c: string) => string): string => Array.from(s, f).join('');
const ASCII = /^[\x00-\x7f]*$/;
/** A word's index key: every letter of one case class the same string (above). ASCII: its upper case. */
export const wordKey = (w: string): string => (ASCII.test(w) ? w.toUpperCase() : each(w, (c) => each(each(c.toUpperCase(), (x) => x.toLowerCase()), (x) => x.toUpperCase())));

/** The keys of a value's words (a word: a run of letters, digits and marks, as the rule's), each once. */
export function valueKeys(value: string): string[] {
  return [...new Set((value.match(/[\p{L}\p{N}\p{M}]+/gu) ?? []).map(wordKey))];
}

/**
 * The keys a question word finds, as `[lo, hi)` in code point ("C") order: a long word every key it starts (up to its
 * last code point's successor), a short one its own key alone (nothing sorts between it and itself + U+0001).
 */
export function keyRange(word: string): [string, string] {
  const k = wordKey(word);
  if (word.length < PREFIX_MIN) return [k, k + '\u0001'];
  const cps = Array.from(k);
  const last = cps.pop()!.codePointAt(0)! + 1;
  return [k, cps.join('') + String.fromCodePoint(last === 0xd800 ? 0xe000 : Math.min(last, 0x10ffff))];
}

const columnsIn = (columns: ParsedColumn[], cols: readonly number[]): number[] =>
  [...new Set(cols)].filter((i) => Number.isInteger(i) && i >= 0 && i < columns.length).sort((a, b) => a - b);

/**
 * The hits, by the rule, of `words` in columns `cols` and, in each column of `known`, of exactly its listed values (a
 * row lock confirming what the value index found, src/ipc/askValues.ts): one statement either way. With `known` alone
 * the rows are narrowed to those holding a listed value before the unpivot, which is the cost.
 */
export async function searchValuesResident(
  src: { parquetPath: string; columns: ParsedColumn[] },
  cols: readonly number[],
  words: readonly string[],
  filters: FilterStep[],
  known: ReadonlyMap<number, readonly string[]> = new Map(),
): Promise<ValueHit[] | null> {
  const ws = words.filter(isWord);
  const ki = columnsIn(src.columns, [...known.keys()]).filter((i) => known.get(i)!.length);
  const ri = ws.length ? columnsIn(src.columns, cols).filter((i) => !ki.includes(i)) : [];
  const ci = [...ri, ...ki].sort((a, b) => a - b);
  if (!ci.length) return [];
  try {
    const params: DuckValue[] = [];
    const preds = filterPredicates(src.columns, filters, params);
    const listed = (i: number, v: string): string => {
      params.push(...known.get(i)!);
      return `${v} IN (${known.get(i)!.map(() => '?').join(', ')})`;
    };
    if (!ri.length) preds.push(`(${ki.map((i) => listed(i, `CAST(${phys(i)} AS VARCHAR)`)).join(' OR ')})`);
    const tests: string[] = [];
    if (ri.length) {
      params.push(`(?i)${wordsPattern(ws)}`);
      tests.push(ki.length ? `(c IN (${ri.join(', ')}) AND regexp_matches(v, ?))` : 'regexp_matches(v, ?)');
    }
    for (const i of ki) tests.push(`(c = ${i} AND ${listed(i, 'v')})`);
    params.push(PER_DATASET);
    const rows = await runOrderedAsync(src.parquetPath, (from, ord) => {
      const kept = `SELECT ${ord} AS o, UNNEST([${ci.join(', ')}]) AS c, UNNEST([${ci.map((i) => `CAST(${phys(i)} AS VARCHAR)`).join(', ')}]) AS v FROM ${from}`
        + (preds.length ? ` WHERE ${preds.join(' AND ')}` : '');
      // strlen is bytes, never fewer than a JS string's length: a listed value is never cut by the prompt.
      const found = `SELECT c, v, MIN(o) AS o FROM (${kept}) WHERE strlen(v) <= ${VALUE_BYTES} AND ${tests.length > 1 ? `(${tests.join(' OR ')})` : tests[0]} GROUP BY c, v`;
      return `SELECT c, ${bomSafe('v')} AS v FROM (${found}) QUALIFY row_number() OVER (PARTITION BY c ORDER BY o) <= ${PER_COLUMN} ORDER BY c, o LIMIT ?;`;
    }, params);
    return rows.map((r) => ({ column: src.columns[Number(r.c)].name, value: String(r.v) }));
  } catch {
    return null;
  }
}

/** THE REFERENCE: the same hits over hydrated rows. */
export function searchValuesJs(columns: ParsedColumn[], rows: Cell[][], cols: readonly number[], words: readonly string[], filters: FilterStep[]): ValueHit[] {
  const ci = columnsIn(columns, cols);
  const ws = words.filter(isWord);
  if (!ci.length || !ws.length) return [];
  const kept = filters.length ? applyPipeline({ columns, rows }, filters).rows : rows;
  const re = new RegExp(wordsPattern(ws), 'iu');
  const out: ValueHit[] = [];
  for (const i of ci) {
    const seen = new Set<string>();
    for (const r of kept) {
      if (seen.size >= PER_COLUMN) break;
      const cell = r ? r[i] : null;
      if (cell === null || cell === undefined) continue;
      const v = String(cell);
      if (seen.has(v) || Buffer.byteLength(v, 'utf8') > VALUE_BYTES || !re.test(v)) continue;
      seen.add(v);
      out.push({ column: columns[i].name, value: v });
    }
  }
  return out.slice(0, PER_DATASET);
}
