// REFERENCES inside a user template — how a captured dashboard says "the Date
// role" instead of "order_date". MAIN PROCESS, PURE: no fs.
//
// ONE representation per context, and only these three:
//
//   JSON slot      { $ref: 'r1' }   a column-holding key (`column`, `category`,
//                                   `series`, …) or an id-holding one
//                                   (`datasetId`, `metricId`, `visualId`).
//   formula        [$r1]            a COLUMN TOKEN whose name is the ref — so a
//                                   rewritten expression still tokenizes.
//   text           {{$m1}}          a `{{token}}` naming a saved metric.
//
// Ref ids: `r…` a role, `c…` a calculated field the template recreates, `m…` a
// metric it recreates, `v…` a visual, `ds` the dataset. A `$` cannot start a
// bare identifier, and capture rewrites EVERY token that names a source column,
// so no user column survives into the body as a `[$…]` token to collide with.
//
// Formulas are rewritten at the TOKEN level, never by regex over raw text: a
// string literal `'revenue'` and a function `sum(…)` are left exactly as typed,
// and everything between tokens is copied through verbatim.

import { tokenize, type Tok } from '../formula/formulaTokens';

export type RefResolver = (id: string) => string | null | undefined;

export interface RefNames {
  /** source column (or calculated field) name → its ref id. Exact match. */
  columns: Map<string, string>;
  /** LOWER-CASED metric name → its ref id (metric names resolve case-blind). */
  metrics: Map<string, string>;
  /** an exact id string (dataset / metric / visual UUID) → its ref id. */
  ids: Map<string, string>;
}

/** Keys whose string (or string-array) value names a column. A value is only a
 *  column reference when it ALSO names one of the source's columns, so a date
 *  under `from` or a literal under `to` is never touched.
 *  ponytail: keys of record-shaped maps (`seriesColors`, `measurePalettes`) are
 *  not rewritten — a colour keyed by an old column name falls back to the
 *  palette on the target. Rewrite keys too if anyone misses it. */
const COLUMN_KEYS: ReadonlySet<string> = new Set([
  'column', 'category', 'series', 'lat', 'lon', 'lat2', 'lon2', 'from', 'to', 'color',
  'lngColumn', 'groupBy', 'entity', 'date', 'event', 'time', 'breakdown', 'target',
  'predictors', 'group', 'outcome', 'restart', 'columns', 'rows',
]);
/** Keys whose exact string value is a record id the template re-binds. */
const ID_KEYS: ReadonlySet<string> = new Set([
  'datasetId', 'categoryDatasetId', 'seriesDatasetId', 'metricId', 'visualId',
]);
/** Free text that may carry `{{metric}}` tokens. */
const TEXT_KEYS: ReadonlySet<string> = new Set(['text', 'heading', 'title']);

const REF_TOKEN = /^\$([a-z]+\d*)$/;
const AGG_FNS: ReadonlySet<string> = new Set(['sum', 'avg', 'count', 'min', 'max']);
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** A column as a formula writes it: bare when it is an identifier. */
export function colRef(name: string): string {
  return IDENT.test(name) ? name : `[${name}]`;
}

export function isRef(v: unknown): v is { $ref: string } {
  return !!v && typeof v === 'object' && !Array.isArray(v)
    && typeof (v as { $ref?: unknown }).$ref === 'string' && Object.keys(v).length === 1;
}

// ── Formulas ────────────────────────────────────────────────────────────────

/**
 * Tokens with SOURCE offsets, or null when the text is not a formula at all.
 *
 * LOD: `{FIXED [a], [b] : SUM([x])}` tokenizes (formulaTokens knows the syntax),
 * and its dimensions and argument are ordinary `col` tokens — so they rewrite
 * like any other ref; `{`, `}` and `:` are punctuation and carry no name
 * (scripts/test-user-templates.ts compiles a rewritten LOD to prove it). The
 * piecewise fallback below stays for text that does not tokenize at all.
 */
function scan(src: string): Tok[] | null {
  try { return tokenize(src); } catch (_) { /* LOD or junk — try the pieces */ }
  const out: Tok[] = [];
  let start = 0;
  let quote = '';
  let bracket = false;
  for (let i = 0; i <= src.length; i += 1) {
    const c = src[i];
    if (i < src.length) {
      if (quote) { if (c === '\\') i += 1; else if (c === quote) quote = ''; continue; }
      if (bracket) { if (c === ']') bracket = false; continue; }
      if (c === '"' || c === "'") { quote = c; continue; }
      if (c === '[') { bracket = true; continue; }
      if (c !== '{' && c !== '}' && c !== ':') continue;
    }
    try {
      for (const t of tokenize(src.slice(start, i))) out.push({ ...t, start: t.start + start, end: t.end + start });
    } catch (_) {
      return null;
    }
    start = i + 1;
  }
  return out;
}

/** Splice replacements into `src` by token offsets; text between tokens is kept. */
function splice(src: string, edits: Array<{ t: Tok; text: string }>): string {
  let out = '';
  let at = 0;
  for (const e of edits) { out += src.slice(at, e.t.start) + e.text; at = e.t.end; }
  return out + src.slice(at);
}

/** Is token i a reference position — a name not called as a function? */
function isRefTok(toks: Tok[], i: number): boolean {
  const t = toks[i];
  if (t.kind === 'col') return true;
  if (t.kind !== 'name') return false;
  const next = toks[i + 1];
  return !(next && next.kind === 'punc' && next.value === '(');
}

/** Is token i the single argument of `sum(…)`/`avg(…)`/…? (metricFormula's rule.) */
function isAggArg(toks: Tok[], i: number): boolean {
  const fn = toks[i - 2];
  const open = toks[i - 1];
  const close = toks[i + 1];
  return !!fn && fn.kind === 'name' && AGG_FNS.has(fn.value.toLowerCase())
    && !!open && open.value === '(' && !!close && close.value === ')';
}

/**
 * Rewrite a formula's column (and, for a metric formula, metric) references to
 * `[$id]`. `onRef` sees every id written, for usage counts. Untokenizable text
 * comes back unchanged — it never compiled on the source either.
 *
 * A METRIC formula differs in one way, the way metricFormula reads it: only the
 * argument of an aggregation is a column; every other reference is a metric
 * NAME.
 */
export function formulaToRefs(
  src: string, names: RefNames, mode: 'calc' | 'metric', onRef?: (id: string) => void,
): string {
  const toks = typeof src === 'string' ? scan(src) : null;
  if (!toks) return src;
  const edits: Array<{ t: Tok; text: string }> = [];
  for (let i = 0; i < toks.length; i += 1) {
    if (!isRefTok(toks, i)) continue;
    const v = toks[i].value;
    let id: string | undefined;
    if (mode === 'metric' && !isAggArg(toks, i)) id = names.metrics.get(v.toLowerCase());
    else id = names.columns.get(v);
    if (!id) continue;
    if (onRef) onRef(id);
    edits.push({ t: toks[i], text: `[$${id}]` });
  }
  return splice(src, edits);
}

/** Every ref id a formula names. */
export function formulaRefs(src: string): string[] {
  const toks = typeof src === 'string' ? scan(src) : null;
  const out: string[] = [];
  for (const t of toks || []) {
    const m = t.kind === 'col' ? REF_TOKEN.exec(t.value) : null;
    if (m) out.push(m[1]);
  }
  return out;
}

/**
 * Write `[$id]` tokens back as real names. A metric ref is always bracketed
 * (metric names have spaces); a column is bare when it can be. Returns null when
 * a ref resolves to null — the formula needs something the target lacks.
 */
export function formulaFromRefs(src: string, resolve: RefResolver): string | null {
  const toks = scan(src);
  if (!toks) return src;
  const edits: Array<{ t: Tok; text: string }> = [];
  for (const t of toks) {
    const m = t.kind === 'col' ? REF_TOKEN.exec(t.value) : null;
    if (!m) continue;
    const name = resolve(m[1]);
    if (name === null) return null;
    if (name === undefined) continue;
    edits.push({ t, text: m[1].startsWith('m') ? `[${name}]` : colRef(name) });
  }
  return splice(src, edits);
}

// ── Text tokens ─────────────────────────────────────────────────────────────

const TOKEN_RE = /\{\{([^{}\n]{1,80})\}\}/g;

/** `{{Revenue}}` → `{{$m1}}` for a metric the template carries. Parameters and
 *  unknown names are left alone — a parameter travels by name with the sheet. */
export function textToRefs(text: string, names: RefNames, onRef?: (id: string) => void): string {
  return text.replace(TOKEN_RE, (all, raw: string) => {
    const id = names.metrics.get(raw.trim().toLowerCase());
    if (!id) return all;
    if (onRef) onRef(id);
    return `{{$${id}}}`;
  });
}

/** `{{$m1}}` → `{{Final name}}`. A ref that resolves to nothing keeps `fallback`'s
 *  name, so the card renders the honest "no metric is called…" state. */
export function textFromRefs(text: string, resolve: RefResolver, fallback: (id: string) => string): string {
  return text.replace(TOKEN_RE, (all, raw: string) => {
    const m = REF_TOKEN.exec(raw.trim());
    if (!m) return all;
    const name = resolve(m[1]);
    return name === undefined ? all : `{{${name === null ? fallback(m[1]) : name}}}`;
  });
}

// ── JSON slots ──────────────────────────────────────────────────────────────

function isColumnKey(key: string, parent: Record<string, unknown>): boolean {
  // A cohort's `value` is a column; every other `value` (a filter's, a
  // control default's) is data.
  return COLUMN_KEYS.has(key) || (key === 'value' && 'entity' in parent && 'date' in parent);
}

/**
 * Rewrite every column / id reference in a JSON value to `{ $ref }`, every
 * `expression` / `formula` string through `formulaToRefs`, and every text key's
 * `{{metric}}` tokens. Returns a fresh value; the input is not touched.
 */
export function jsonToRefs(v: unknown, names: RefNames, onRef?: (id: string) => void): unknown {
  if (Array.isArray(v)) return v.map((x) => jsonToRefs(x, names, onRef));
  if (!v || typeof v !== 'object') return v;
  const o = v as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(o)) {
    const x = o[k];
    const col = (s: unknown): unknown => {
      const id = typeof s === 'string' ? names.columns.get(s) : undefined;
      if (!id) return s;
      if (onRef) onRef(id);
      return { $ref: id };
    };
    if (typeof x === 'string' && ID_KEYS.has(k) && names.ids.has(x)) {
      out[k] = { $ref: names.ids.get(x)! };
    } else if (isColumnKey(k, o) && typeof x === 'string') {
      out[k] = col(x);
    } else if (isColumnKey(k, o) && Array.isArray(x) && x.every((e) => typeof e === 'string')) {
      out[k] = x.map(col);
    } else if (k === 'expression' && typeof x === 'string') {
      out[k] = formulaToRefs(x, names, 'calc', onRef);
    } else if (k === 'formula' && typeof x === 'string') {
      out[k] = formulaToRefs(x, names, 'metric', onRef);
    } else if (TEXT_KEYS.has(k) && typeof x === 'string') {
      out[k] = textToRefs(x, names, onRef);
    } else {
      out[k] = jsonToRefs(x, names, onRef);
    }
  }
  return out;
}

/**
 * Every ref id a JSON value NEEDS — slots and formulas. Text tokens are not
 * needs: a note naming a dropped metric keeps its card and says so.
 */
export function refsIn(v: unknown, into: Set<string> = new Set()): Set<string> {
  if (isRef(v)) { into.add(v.$ref); return into; }
  if (Array.isArray(v)) { for (const x of v) refsIn(x, into); return into; }
  if (!v || typeof v !== 'object') return into;
  const o = v as Record<string, unknown>;
  for (const k of Object.keys(o)) {
    const x = o[k];
    if ((k === 'expression' || k === 'formula') && typeof x === 'string') {
      for (const id of formulaRefs(x)) into.add(id);
    } else {
      refsIn(x, into);
    }
  }
  return into;
}

/**
 * Write refs back. `slot` answers `{ $ref }` objects and `name` answers formula
 * and text refs; either returns undefined to LEAVE the ref for a later pass
 * (ids that exist only once records are created), or null for "missing".
 * A missing slot becomes '' — callers drop any element whose needs are missing
 * BEFORE calling this, so that only happens inside text.
 */
export function jsonFromRefs(v: unknown, slot: RefResolver, name: RefResolver, fallback: (id: string) => string): unknown {
  if (isRef(v)) {
    const r = slot(v.$ref);
    return r === undefined ? v : r === null ? '' : r;
  }
  if (Array.isArray(v)) return v.map((x) => jsonFromRefs(x, slot, name, fallback));
  if (!v || typeof v !== 'object') return v;
  const o = v as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(o)) {
    const x = o[k];
    if ((k === 'expression' || k === 'formula') && typeof x === 'string') {
      out[k] = formulaFromRefs(x, name) ?? x;
    } else if (TEXT_KEYS.has(k) && typeof x === 'string') {
      out[k] = textFromRefs(x, name, fallback);
    } else {
      out[k] = jsonFromRefs(x, slot, name, fallback);
    }
  }
  return out;
}

/** Replace exact string values (any key, any depth) — the card/page id remap. */
export function swapStrings(v: unknown, map: Map<string, string>): unknown {
  if (typeof v === 'string') return map.get(v) ?? v;
  if (Array.isArray(v)) return v.map((x) => swapStrings(x, map));
  if (!v || typeof v !== 'object') return v;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(v as Record<string, unknown>)) out[k] = swapStrings((v as Record<string, unknown>)[k], map);
  return out;
}
