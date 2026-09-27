// TYPED FILTERS — "west technology last quarter" → filter chips. PURE: no
// Electron, fs, DOM or clock, and NO MODEL. The same text and catalog always
// give the same chips, in the same order.
//
// The catalog is the open dashboard's own data (src/ipc/filterParse.ts builds
// it): its text columns with their distinct values, its number columns with
// their observed max, and its date columns. Every chip is an ordinary
// FilterStep — `=`, `in`, `!=`, `not in`, `period`, `>`, `>=`, `<`, `<=`, and
// "between" as a `>=` plus a `<=` — so whatever applies it (a control, the
// selection strip) needs nothing new downstream.
//
// ── How a word is read, first rule that fits wins ───────────────────────────
//   1. a column VALUE, exactly (case- and accent-insensitive), longest phrase
//      first — "office supplies" and "new york" before "office" or "new"
//   2. a DATE phrase (filterDates.ts) — "last quarter", "since March", "Q3 2023"
//   3. a COMPARISON on a measure — "revenue > 10k", "discount under 20%"
//   4. a NEGATION of what follows — "not furniture", "excluding West and East"
//   5. a COLUMN name — "region west" looks for "west" in region first
//   6. a stop-word ("in", "the", "and", "show me" …) — consumed silently
//   7. a value by PREFIX (2+ characters), then by ONE edit (4+ characters)
//   8. anything else is UNKNOWN: returned as a span for the input to
//      highlight, never guessed at.
// A value present in several columns is offered for EVERY one of them; the
// chip takes the first by the dashboard's dimension order unless `opts.pick`
// names another (the popover's "use this column"). Two values of the same
// column typed together become ONE `in` chip. A negated date or comparison is
// left unknown rather than inverted — "not last quarter" has no honest single
// period, and inverting `>` silently changes how empty cells are treated.

import type { FilterStep } from '../data/transforms';
import { DEFAULT_CALENDAR } from './dateIntel';
import type { CalendarPrefs } from './dateIntel';
import { matchDate } from './filterDates';
import type { DateMatch } from './filterDates';

export interface CatalogDimension { column: string; datasetId?: string; type: string; values: string[] }
export interface CatalogMeasure { column: string; type: 'number'; max?: number | null }
export interface FilterCatalog { dimensions: CatalogDimension[]; measures: CatalogMeasure[]; dates: string[] }

export interface ParseOptions {
  /** ISO date every relative phrase resolves against. */
  today: string;
  calendar?: CalendarPrefs;
  /** phrase key → suggestion id: the alternative the user chose for that phrase. */
  pick?: Record<string, string>;
}

export type TokenKind = 'value' | 'column' | 'date' | 'number' | 'negation' | 'stop' | 'unknown';
export type MatchKind = 'exact' | 'prefix' | 'fuzzy' | 'date' | 'number';

export interface FilterToken { start: number; end: number; text: string; kind: TokenKind }
/** One filter, as the FilterStep(s) it applies — two for "between". */
export interface FilterChip { column: string; kind: 'value' | 'date' | 'number'; negated: boolean; match: MatchKind; label: string; steps: FilterStep[] }
/**
 * One reading of a typed phrase. `key` is the phrase, normalised — what `pick`
 * is keyed by; `id` is what `pick[key]` is set to, to choose this reading;
 * `chosen` marks the reading the chip uses now.
 */
export interface FilterSuggestion {
  key: string; id: string; column: string; label: string; phrase: string; match: MatchKind; chosen: boolean; negated: boolean;
}
export interface SuggestionGroup { column: string; items: FilterSuggestion[] }
export interface ParseResult { tokens: FilterToken[]; chips: FilterChip[]; groups: SuggestionGroup[]; unknown: string[] }

const STOP = new Set([
  'in', 'the', 'and', 'or', 'for', 'of', 'with', 'show', 'me', 'a', 'an', 'to', 'at', 'on', 'by', 'is', 'are', 'was',
  'only', 'where', 'please', 'just', 'filter', 'filtered', 'this', 'that', 'from', 'all', '',
]);
/** Stop-words that keep a negation going: "excluding West and East". */
const JOIN = new Set(['and', 'or', '']);
const NEG = new Set(['not', 'excluding', 'exclude', 'except', 'without', 'no', '!=']);
/** Grammar words never read as a prefix or a near miss of a value ("last" is not "East"). */
const GRAMMAR = new Set([
  'last', 'past', 'previous', 'prior', 'this', 'current', 'since', 'before', 'after', 'today', 'yesterday',
  'ytd', 'qtd', 'mtd', 'over', 'under', 'above', 'below', 'between', 'more', 'less', 'greater', 'fewer',
  'least', 'most', 'than', 'equals', 'exactly', ...NEG,
]);
const MAX_ALTERNATIVES = 8;
const MAX_TEXT = 500;

type Op = '>' | '>=' | '<' | '<=' | '=' | 'between';
/** Longest first, so "no more than" is not read as "no" + "more than". */
const COMPARATORS: Array<[string[], Op]> = [
  [['no', 'more', 'than'], '<='], [['no', 'less', 'than'], '>='],
  [['more', 'than'], '>'], [['greater', 'than'], '>'], [['higher', 'than'], '>'],
  [['less', 'than'], '<'], [['fewer', 'than'], '<'], [['lower', 'than'], '<'],
  [['at', 'least'], '>='], [['at', 'most'], '<='], [['equal', 'to'], '='],
  [['>='], '>='], [['<='], '<='], [['>'], '>'], [['<'], '<'], [['='], '='],
  [['over'], '>'], [['above'], '>'], [['exceeds'], '>'], [['exceeding'], '>'],
  [['under'], '<'], [['below'], '<'], [['equals'], '='], [['exactly'], '='], [['between'], 'between'],
];
const OP_SIGN: Record<string, string> = { '>': '>', '>=': '≥', '<': '<', '<=': '≤', '=': '=' };

// ── Words ───────────────────────────────────────────────────────────────────

const EDGE = /^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu;

/** Lower case, accents and edge punctuation stripped: "Québec," → "quebec". */
export function normText(s: string): string {
  return String(s).normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(EDGE, '');
}

function normPhrase(s: string): string {
  return String(s).split(/\s+/).map(normText).filter(Boolean).join(' ');
}

/** A column name as a phrase: "unit_price" and "unit price" read alike. */
function colKey(s: string): string {
  return normPhrase(String(s).replace(/[_\-.]+/g, ' '));
}

interface Word { raw: string; norm: string; start: number; end: number; op: boolean }

const TOKEN_RE = /!=|<=|>=|[<>=]|[^\s<>=!]+|!/g;
const OP_RE = /^(?:!=|<=|>=|[<>=!])$/;

function tokenize(text: string): Word[] {
  const out: Word[] = [];
  for (const m of text.matchAll(TOKEN_RE)) {
    const raw = m[0];
    const op = OP_RE.test(raw);
    const start = m.index ?? 0;
    out.push({ raw, norm: op ? raw : normText(raw), start, end: start + raw.length, op });
  }
  return out;
}

/** Levenshtein distance ≤ 1, without building the matrix. */
function withinOne(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  if (a.length === b.length) return a.slice(i + 1) === b.slice(i + 1);
  return a.length > b.length ? a.slice(i + 1) === b.slice(i) : a.slice(i) === b.slice(i + 1);
}

// ── The catalog, indexed ────────────────────────────────────────────────────

interface Cand { dim: number; column: string; value: string; key: string }

interface Index {
  all: Cand[];
  byKey: Map<string, Cand[]>;
  maxWords: number;
  columns: Map<string, { dim?: number; date?: string }>;
  columnWords: number;
  measures: Map<string, CatalogMeasure>;
  measureWords: number;
}

function buildIndex(cat: FilterCatalog): Index {
  const ix: Index = { all: [], byKey: new Map(), maxWords: 1, columns: new Map(), columnWords: 1, measures: new Map(), measureWords: 1 };
  const words = (k: string): number => k.split(' ').length;
  cat.dimensions.forEach((d, dim) => {
    const seen = new Set<string>();
    for (const value of d.values) {
      const key = normPhrase(value);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      const c: Cand = { dim, column: d.column, value, key };
      ix.all.push(c);
      const list = ix.byKey.get(key);
      if (list) list.push(c);
      else ix.byKey.set(key, [c]);
      ix.maxWords = Math.min(6, Math.max(ix.maxWords, words(key)));
    }
    const ck = colKey(d.column);
    if (ck && !ix.columns.has(ck)) { ix.columns.set(ck, { dim }); ix.columnWords = Math.max(ix.columnWords, words(ck)); }
  });
  for (const col of cat.dates) {
    const ck = colKey(col);
    if (ck && !ix.columns.has(ck)) { ix.columns.set(ck, { date: col }); ix.columnWords = Math.max(ix.columnWords, words(ck)); }
  }
  for (const m of cat.measures) {
    const ck = colKey(m.column);
    if (ck && !ix.measures.has(ck)) { ix.measures.set(ck, m); ix.measureWords = Math.max(ix.measureWords, words(ck)); }
  }
  return ix;
}

export function candId(column: string, value?: string): string {
  return value === undefined ? column : column + '\n' + value;
}

type Level = 'exact' | 'prefix' | 'fuzzy';
interface ValueMatch { used: number; cands: Cand[] }

function phraseAt(W: Word[], i: number, n: number): string {
  return W.slice(i, i + n).map((w) => w.norm).filter(Boolean).join(' ');
}

function matchValue(W: Word[], i: number, level: Level, ix: Index, hint: number | null): ValueMatch | null {
  for (let n = Math.min(ix.maxWords, W.length - i); n >= 1; n--) {
    if (W.slice(i, i + n).some((w) => w.op)) continue;
    const phrase = phraseAt(W, i, n);
    if (!phrase) continue;
    let cands: Cand[];
    if (level === 'exact') {
      cands = ix.byKey.get(phrase) || [];
      // A stop-word matches a value only when typed in the value's own case:
      // "in" is a word, "IN" is Indiana.
      if (n === 1 && (STOP.has(phrase) || NEG.has(phrase))) {
        const typed = W[i].raw.replace(EDGE, '');
        cands = cands.filter((c) => c.value.trim() === typed);
      }
    } else {
      if (!/\p{L}/u.test(phrase) || (n === 1 && GRAMMAR.has(phrase))) continue;
      if (level === 'prefix') {
        if (phrase.length < 2) continue;
        cands = ix.all.filter((c) => c.key.length > phrase.length && c.key.startsWith(phrase));
      } else {
        if (phrase.length < 4) continue;
        cands = ix.all.filter((c) => c.key !== phrase && withinOne(phrase, c.key));
      }
    }
    if (hint !== null) {
      const inHint = cands.filter((c) => c.dim === hint);
      if (inHint.length) cands = inHint;
    }
    if (cands.length) return { used: n, cands };
  }
  return null;
}

function matchColumn(W: Word[], i: number, ix: Index): { used: number; dim?: number; date?: string } | null {
  for (let n = Math.min(ix.columnWords, W.length - i); n >= 1; n--) {
    if (W.slice(i, i + n).some((w) => w.op)) continue;
    const hit = ix.columns.get(colKey(W.slice(i, i + n).map((w) => w.norm).join(' ')));
    if (hit) return { used: n, ...hit };
  }
  return null;
}

// ── Numbers ─────────────────────────────────────────────────────────────────

const NUM_RE = /^(-)?\$?((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?|\.\d+)([kmb])?(%)?$/i;
const SCALE: Record<string, number> = { k: 1e3, m: 1e6, b: 1e9 };

function parseNumber(raw: string | undefined, m: CatalogMeasure): number | null {
  if (!raw) return null;
  const x = NUM_RE.exec(raw.replace(/[,;]+$|\.$/, ''));
  if (!x) return null;
  let v = Number(x[2].replace(/,/g, ''));
  if (x[3]) v *= SCALE[x[3].toLowerCase()];
  if (x[1]) v = -v;
  // "20%" means 0.2 on a column that stores FRACTIONS and 20 on one that
  // stores percentage points. The observed max is the only evidence there is:
  // a discount column whose largest value is 0.3 is a fraction column. With no
  // max (no numeric cells) the number is taken as typed.
  if (x[4] && typeof m.max === 'number' && Number.isFinite(m.max) && m.max <= 1) v /= 100;
  return Number(v.toPrecision(12)); // 1.1k is 1100, not 1100.0000000000002
}

function fmtNum(v: number): string {
  return v.toLocaleString('en-US', { maximumFractionDigits: 6 });
}

function comparator(W: Word[], j: number): { used: number; op: Op } | null {
  for (const [ws, op] of COMPARATORS) {
    if (ws.every((w, k) => W[j + k] && W[j + k].norm === w)) return { used: ws.length, op };
  }
  return null;
}

function matchNumber(W: Word[], i: number, ix: Index): { used: number; chip: FilterChip } | null {
  let measure: CatalogMeasure | undefined;
  let j = i;
  for (let n = Math.min(ix.measureWords, W.length - i); n >= 1 && !measure; n--) {
    if (W.slice(i, i + n).some((w) => w.op)) continue;
    measure = ix.measures.get(colKey(W.slice(i, i + n).map((w) => w.norm).join(' ')));
    if (measure) j = i + n;
  }
  if (!measure) return null;
  while (j < W.length && (W[j].norm === 'is' || W[j].norm === 'are' || W[j].norm === 'was')) j++;
  const cmp = comparator(W, j);
  if (!cmp) return null;
  j += cmp.used;
  const a = parseNumber(W[j] && W[j].raw, measure);
  if (a === null) return null;
  j++;
  const column = measure.column;
  const base = { column, kind: 'number' as const, negated: false, match: 'number' as const };
  if (cmp.op === 'between') {
    const link = W[j] && (W[j].norm || W[j].raw);
    if (link !== 'and' && link !== 'to' && link !== '-') return null;
    const b = parseNumber(W[j + 1] && W[j + 1].raw, measure);
    if (b === null) return null;
    const [lo, hi] = a <= b ? [a, b] : [b, a];
    return {
      used: j + 2 - i,
      chip: { ...base, label: `${column} ${fmtNum(lo)}–${fmtNum(hi)}`, steps: [
        { type: 'filter', column, op: '>=', value: lo },
        { type: 'filter', column, op: '<=', value: hi },
      ] },
    };
  }
  return {
    used: j - i,
    chip: { ...base, label: `${column} ${OP_SIGN[cmp.op]} ${fmtNum(a)}`, steps: [{ type: 'filter', column, op: cmp.op, value: a }] },
  };
}

// ── The parse ───────────────────────────────────────────────────────────────

interface ValueSpan { start: number; key: string; phrase: string; cands: Cand[]; chosen: Cand; level: Level; negated: boolean }
interface OtherSpan { start: number; chip: FilterChip; items: FilterSuggestion[] }

const WORST: Record<Level, number> = { exact: 0, prefix: 1, fuzzy: 2 };

export function parseFilterText(text: string, catalog: FilterCatalog, opts: ParseOptions): ParseResult {
  const src = String(text || '').slice(0, MAX_TEXT);
  const cal = opts.calendar || DEFAULT_CALENDAR;
  const pick = opts.pick || {};
  const ix = buildIndex(catalog);
  const W = tokenize(src);
  const norms = W.map((w) => w.norm);
  const kinds: TokenKind[] = W.map(() => 'unknown');
  const spans: ValueSpan[] = [];
  const others: OtherSpan[] = [];
  let hint: number | null = null; // a column name just typed: look there first
  let dateHint: string | null = null;
  let negCol: string | null = null; // a negation still in force across "and"/"or"

  const mark = (from: number, n: number, k: TokenKind): void => { for (let j = from; j < from + n; j++) kinds[j] = k; };
  const phraseOf = (from: number, n: number): string => src.slice(W[from].start, W[from + n - 1].end);
  const hasDates = catalog.dates.length > 0;

  const takeValue = (at: number, m: ValueMatch, level: Level, negate: boolean): number => {
    const key = phraseAt(W, at, m.used);
    const chosen = m.cands.find((c) => candId(c.column, c.value) === pick[key]) || m.cands[0];
    const cands = m.cands.slice(0, MAX_ALTERNATIVES);
    if (!cands.includes(chosen)) cands[cands.length - 1] = chosen;
    const negated = negate || (negCol !== null && chosen.column === negCol);
    spans.push({ start: W[at].start, key, phrase: phraseOf(at, m.used), cands, chosen, level, negated });
    mark(at, m.used, 'value');
    negCol = negated ? chosen.column : null;
    hint = null;
    return m.used;
  };

  const takeDate = (at: number, d: DateMatch): void => {
    const key = phraseAt(W, at, d.used);
    const cols = catalog.dates;
    const column = cols.includes(pick[key]) ? pick[key] : dateHint && cols.includes(dateHint) ? dateHint : cols[0];
    const phrase = phraseOf(at, d.used);
    others.push({
      start: W[at].start,
      chip: { column, kind: 'date', negated: false, match: 'date', label: d.label, steps: [{ type: 'filter', column, op: 'period', period: d.spec }] },
      items: cols.map((c) => ({ key, id: candId(c), column: c, label: d.label, phrase, match: 'date' as const, chosen: c === column, negated: false })),
    });
    mark(at, d.used, 'date');
  };

  // A negation word and what it negates. 0 when it negates nothing.
  const negation = (i: number): number => {
    let j = i + 1;
    while (j < W.length && STOP.has(W[j].norm)) j++;
    if (j >= W.length) return 0;
    const d = hasDates ? matchDate(norms, j, opts.today, cal) : null;
    const num = d ? null : matchNumber(W, j, ix);
    if (d || num) {
      const used = j - i + (d ? d.used : (num as { used: number }).used);
      mark(i, used, 'unknown'); // "not last quarter": left for the user, not inverted
      return used;
    }
    let level: Level = 'exact';
    let m = matchValue(W, j, 'exact', ix, hint);
    if (!m) { level = 'prefix'; m = matchValue(W, j, 'prefix', ix, hint); }
    if (!m) { level = 'fuzzy'; m = matchValue(W, j, 'fuzzy', ix, hint); }
    if (!m) return 0;
    mark(i, j - i, 'stop');
    kinds[i] = 'negation';
    return j - i + takeValue(j, m, level, true);
  };

  let i = 0;
  while (i < W.length) {
    const w = W[i];
    const exact = matchValue(W, i, 'exact', ix, hint);
    if (exact) { i += takeValue(i, exact, 'exact', false); continue; }

    const d = hasDates ? matchDate(norms, i, opts.today, cal) : null;
    if (d) { takeDate(i, d); i += d.used; negCol = null; hint = null; dateHint = null; continue; }

    const num = matchNumber(W, i, ix);
    if (num) {
      others.push({
        start: w.start,
        chip: num.chip,
        items: [{ key: phraseAt(W, i, num.used), id: candId(num.chip.column), column: num.chip.column, label: num.chip.label, phrase: phraseOf(i, num.used), match: 'number', chosen: true, negated: false }],
      });
      mark(i, num.used, 'number');
      i += num.used;
      negCol = null;
      hint = null;
      continue;
    }

    if (NEG.has(w.norm)) {
      const used = negation(i);
      if (used) { i += used; continue; }
      kinds[i] = 'unknown'; // a negation of nothing is not silently dropped
      i++;
      continue;
    }

    const col = matchColumn(W, i, ix);
    if (col) {
      mark(i, col.used, 'column');
      i += col.used;
      hint = col.dim ?? null;
      dateHint = col.date ?? null;
      // "region = west", "region is west": the link word belongs to the name.
      while (i < W.length && (W[i].norm === '=' || W[i].norm === 'is' || W[i].norm === '')) { kinds[i] = 'stop'; i++; }
      continue;
    }

    if (STOP.has(w.norm)) {
      kinds[i] = 'stop';
      if (!JOIN.has(w.norm)) negCol = null;
      i++;
      continue;
    }

    const prefix = matchValue(W, i, 'prefix', ix, hint);
    if (prefix) { i += takeValue(i, prefix, 'prefix', false); continue; }
    const fuzzy = matchValue(W, i, 'fuzzy', ix, hint);
    if (fuzzy) { i += takeValue(i, fuzzy, 'fuzzy', false); continue; }

    kinds[i] = 'unknown';
    negCol = null;
    hint = null;
    i++;
  }

  return {
    tokens: W.map((t, k) => ({ start: t.start, end: t.end, text: t.raw, kind: kinds[k] })),
    chips: assembleChips(spans, others),
    groups: assembleGroups(catalog, spans, others),
    unknown: W.filter((_, k) => kinds[k] === 'unknown').map((t) => t.raw),
  };
}

/** Value spans → one chip per (column, negated), in order of first appearance; then dates and numbers, merged by position. */
function assembleChips(spans: ValueSpan[], others: OtherSpan[]): FilterChip[] {
  const byCol = new Map<string, { start: number; column: string; negated: boolean; values: string[]; level: Level }>();
  for (const s of spans) {
    const k = s.chosen.column + '\u0000' + (s.negated ? '1' : '0');
    const g = byCol.get(k);
    if (!g) { byCol.set(k, { start: s.start, column: s.chosen.column, negated: s.negated, values: [s.chosen.value], level: s.level }); continue; }
    if (!g.values.includes(s.chosen.value)) g.values.push(s.chosen.value);
    if (WORST[s.level] > WORST[g.level]) g.level = s.level;
  }
  const out: Array<{ start: number; chip: FilterChip }> = [];
  for (const g of byCol.values()) {
    const many = g.values.length > 1;
    const op = g.negated ? (many ? 'not in' : '!=') : many ? 'in' : '=';
    const step: FilterStep = many
      ? { type: 'filter', column: g.column, op, values: g.values.slice() }
      : { type: 'filter', column: g.column, op, value: g.values[0] };
    const label = many
      ? `${g.column} ${g.negated ? 'not in' : 'in'} ${g.values.join(', ')}`
      : `${g.column} ${g.negated ? '≠' : '='} ${g.values[0]}`;
    out.push({ start: g.start, chip: { column: g.column, kind: 'value', negated: g.negated, match: g.level, label, steps: [step] } });
  }
  for (const o of others) out.push({ start: o.start, chip: o.chip });
  // Stable: equal starts cannot happen (one span per word), so order is by position.
  return out.sort((a, b) => a.start - b.start).map((o) => o.chip);
}

/** Every reading, grouped by column in the dashboard's column order: dimensions, then dates, then measures. */
function assembleGroups(cat: FilterCatalog, spans: ValueSpan[], others: OtherSpan[]): SuggestionGroup[] {
  const order = new Map<string, number>();
  [...cat.dimensions.map((d) => d.column), ...cat.dates, ...cat.measures.map((m) => m.column)]
    .forEach((c) => { if (!order.has(c)) order.set(c, order.size); });
  const items: Array<{ start: number; s: FilterSuggestion }> = [];
  for (const sp of spans) {
    for (const c of sp.cands) {
      items.push({ start: sp.start, s: {
        key: sp.key, id: candId(c.column, c.value), column: c.column, label: c.value, phrase: sp.phrase,
        match: sp.level, chosen: c === sp.chosen, negated: sp.negated,
      } });
    }
  }
  for (const o of others) for (const s of o.items) items.push({ start: o.start, s });
  items.sort((a, b) => a.start - b.start);
  const groups = new Map<string, SuggestionGroup>();
  for (const { s } of items) {
    const g = groups.get(s.column) || { column: s.column, items: [] };
    groups.set(s.column, g);
    // The same phrase typed twice is one reading, not two rows.
    const same = g.items.find((x) => x.key === s.key && x.id === s.id && x.negated === s.negated);
    if (same) { same.chosen = same.chosen || s.chosen; continue; }
    g.items.push(s);
  }
  return [...groups.values()].sort((a, b) => (order.get(a.column) ?? 1e9) - (order.get(b.column) ?? 1e9));
}
