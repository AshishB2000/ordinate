// What a warehouse SQL dialect must spell for the live compiler — PURE.
// docs/live-data/00-plan.md L2.2 (D3, D4). One interface, one file per dialect
// under ./dialects; ./compile.ts writes every statement through it and never
// spells a type, a cast, a date function or a placeholder of its own.
//
// Each method is a rule the resident layer (CLAUDE.md, "The resident-query
// layer") already lives by, restated for a warehouse that holds TYPED columns:
//
//   - cast on the DECLARED type: only a `number` column is read as a number,
//     through the dialect's SAFE cast, and only a finite value survives;
//   - every aggregate CAST to the dialect's DOUBLE;
//   - empty = NULL or '' or whitespace, the whitespace class spelled out (JS
//     `trim()`'s, below — not the engine's idea of a space);
//   - values only ever as bound parameters (`param`), never in the text.
//
// The DuckDB dialect is the test bench (scripts/test-liveParity.ts runs the
// whole matrix on it); the other five are pinned by golden shapes in
// scripts/test-liveCompile.ts and verified on their engines in L2.8.

import type { LiveDialectId, LiveParam } from '../../connectors/types';

export type CompileDialectId = LiveDialectId | 'duckdb';
export type TruncUnit = 'week' | 'month' | 'quarter' | 'year';

/**
 * Exactly the characters JS `String.prototype.trim()` removes — enumerated by
 * running `trim()` over the whole BMP (no astral code point is whitespace):
 * TAB LF VT FF CR, SPACE, NBSP, OGHAM SPACE MARK, EN QUAD … HAIR SPACE, LINE and
 * PARAGRAPH SEPARATOR, NARROW NBSP, MEDIUM MATHEMATICAL SPACE, IDEOGRAPHIC SPACE
 * and the BOM. `transforms.isEmptyCell` is `cell.trim() === ''`, so this is the
 * extract's definition of "empty", character for character.
 */
export const JS_WHITESPACE =
  '\t\n\u000b\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a' +
  '\u2028\u2029\u202f\u205f\u3000\ufeff';

/** The same class as an RE2 / Java regex bracket body (`\x{…}` escapes, ranges). */
export const WS_REGEX_CLASS =
  '\\x{0009}-\\x{000D}\\x{0020}\\x{00A0}\\x{1680}\\x{2000}-\\x{200A}\\x{2028}\\x{2029}\\x{202F}\\x{205F}\\x{3000}\\x{FEFF}';

/** Hands out a placeholder for one value; ./sqlParams.ts numbers them in text order. */
export interface Binder {
  bind(type: LiveParam['type'], value: string | number): string;
}

export interface SqlDialect {
  id: CompileDialectId;
  /** One identifier, quoted and escaped. The caller has refused '' and NUL. */
  ident(name: string): string;
  /** The (i+1)-th placeholder in text order — `params[i]`, named `p<i>` — typed. */
  placeholder(i: number, p: LiveParam): string;
  /** `CAST(x AS DOUBLE)` in this dialect: every aggregate goes through it. */
  toDouble(x: string): string;
  /** An integer-valued double/date difference as an integer column (bucket ids). */
  toInt(x: string): string;
  /** A column read as text. */
  text(col: string): string;
  /** A column declared `number`: its value as a finite double, else NULL. */
  number(col: string, storedAsText: boolean): string;
  /** A column declared `date`: a DATE, else NULL. */
  date(col: string, storedAsText: boolean, sourceType: string): string;
  /** A DATE as 'YYYY-MM-DD'. */
  isoDay(d: string): string;
  /** A DATE as days since 1970-01-01 — the bucket id `categoryKey.dateBucket` returns. */
  epochDay(d: string): string;
  /** A DATE truncated to the first day of its ISO week (Monday) / month / quarter / year. */
  trunc(d: string, unit: TruncUnit): string;
  /** TRUE when a text expression is NULL, '' or only JS whitespace. Never NULL. */
  blank(x: string, b: Binder): string;
  /** `x LIKE pattern` with this dialect's escape convention (see `likeEscape`). */
  like(x: string, pattern: string): string;
  /** The escape character `likePattern` uses for this dialect. */
  likeEscape: string;
  /** A text label as projected for the transport (the DuckDB BOM fix); identity elsewhere. */
  label(x: string): string;
}

/** A `contains` needle → the LIKE pattern, with `%`, `_` and the escape itself escaped. */
export function likePattern(needle: string, esc: string): string {
  let out = '';
  for (const ch of needle) out += ch === '%' || ch === '_' || ch === esc ? esc + ch : ch;
  return `%${out}%`;
}

/** `"…"` with `"` doubled — Snowflake, Redshift, DuckDB. */
export function doubleQuoted(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** True when a warehouse type name is a string type (the safe-cast input some dialects require). */
export function isTextSourceType(sourceType: string | undefined): boolean {
  return typeof sourceType === 'string' && /char|text|string|clob|variant|json|object/i.test(sourceType);
}

/**
 * The SQL predicate fragment `CASE WHEN v - v = 0 THEN v END` keeps a value only
 * when it is FINITE: Infinity − Infinity and NaN − NaN are NaN, and NaN equals
 * nothing but (in some engines) itself — never 0. Portable where a dialect has
 * no `isfinite`.
 */
export function finiteBySubtraction(v: string): string {
  return `CASE WHEN ${v} - ${v} = 0 THEN ${v} END`;
}
