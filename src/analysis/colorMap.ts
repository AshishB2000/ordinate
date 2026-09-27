// PROJECT-WIDE CATEGORY COLOURS — the one rule that says which colour a
// dimension value gets, so "Technology" is the same blue in every chart,
// legend, map and export of a project.
//
// A colour is stored as a RAMP SLOT ('chart-3'), never a hex. The theme owns
// the hexes (--chart-1..8 in theme.css, the dashboard presets, a brand accent),
// so dark mode or a new accent repaints every chart consistently and the value
// keeps its slot.
//
// THE RULE (assignColors). Given a column's current map and the values a chart
// is about to draw, in draw order: a value already in the map keeps its slot; a
// new value takes the lowest-numbered slot no value in that column holds yet;
// once all eight are held, new values cycle by count (the 9th value stored gets
// slot 1, the 10th slot 2, …). Pure and deterministic — the same map and the
// same values always give the same answer — which is what lets the renderer
// colour a chart synchronously from its cached copy while main, running the SAME
// function on the stored map, persists the result.
//
// PURE, and loaded by BOTH processes, exactly like src/app/format.ts:
//   main      `import * as colorMap from '../analysis/colorMap'` — the project
//             record's sanitizer and the format IPC;
//   renderer  `<script src="../../src/analysis/colorMap.js">` between
//             cjsShim.js and fmtColors.js, which binds it as `OrdColorMap`.
// THIS FILE MUST NOT IMPORT ANYTHING AT RUNTIME. Nor may a function here read
// an EXPORTED const: tsc compiles that read as `exports.X`, and the renderer's
// binder clears the `exports` global once it has the module — so the limits
// live in module-local consts and are exported as aliases.
//
// Every map built here has a NULL prototype. Column names and category values
// are user data, and `map['__proto__'] = {…}` on a plain object would replace
// its prototype rather than store a column.

export type ColorToken = 'chart-1' | 'chart-2' | 'chart-3' | 'chart-4' | 'chart-5' | 'chart-6' | 'chart-7' | 'chart-8';
/** value → slot, for one column. */
export type ColumnColors = Record<string, ColorToken>;
/** column → its values' slots. */
export type ColorMap = Record<string, ColumnColors>;

const TOKENS: readonly ColorToken[] = [
  'chart-1', 'chart-2', 'chart-3', 'chart-4', 'chart-5', 'chart-6', 'chart-7', 'chart-8',
];
/** Columns a project remembers colours for. */
const MAX_COLUMNS = 64;
/** Values per column. Past this a value is coloured by position and not stored. */
const MAX_VALUES = 256;
/** Longest column name or value kept as a key. */
const MAX_KEY = 200;

export const COLOR_TOKENS = TOKENS;
export const MAX_COLOR_COLUMNS = MAX_COLUMNS;
export const MAX_COLOR_VALUES = MAX_VALUES;
export const MAX_COLOR_KEY = MAX_KEY;

function dict<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}

function has(o: object, k: string): boolean {
  return Object.prototype.hasOwnProperty.call(o, k);
}

export function isColorToken(v: unknown): v is ColorToken {
  return typeof v === 'string' && (TOKENS as readonly string[]).indexOf(v) >= 0;
}

/** 'chart-3' → 2. */
export function slotIndex(token: ColorToken): number {
  return Number(token.slice(6)) - 1;
}

/** The key a drawn value is stored under, or null for one that is never coloured. */
export function colorKey(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const k = typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : null;
  return k !== null && k.length <= MAX_KEY ? k : null;
}

/** A column with no colours yet. */
export function emptyColumn(): ColumnColors {
  return dict<ColorToken>();
}

/** A fresh null-prototype copy of one column's map, in its stored order. */
function copyColumn(cur: ColumnColors | null | undefined): ColumnColors {
  const out = dict<ColorToken>();
  if (!cur || typeof cur !== 'object') return out;
  for (const k of Object.keys(cur)) if (isColorToken(cur[k])) out[k] = cur[k];
  return out;
}

export interface Assignment {
  /** The column's map after this draw. */
  colors: ColumnColors;
  /** One slot per input value, in input order; null = not stored (past the cap, or not a key). */
  tokens: (ColorToken | null)[];
  /** True when `colors` differs from the map passed in — the only case worth persisting. */
  changed: boolean;
}

/** THE RULE — see the header. Never mutates `current`. */
export function assignColors(current: ColumnColors | null | undefined, values: readonly unknown[]): Assignment {
  const colors = copyColumn(current);
  const used = new Set<ColorToken>();
  for (const k of Object.keys(colors)) used.add(colors[k]);
  let changed = false;
  const tokens = (Array.isArray(values) ? values : []).map((v): ColorToken | null => {
    const key = colorKey(v);
    if (key === null) return null;
    if (has(colors, key)) return colors[key];
    const count = Object.keys(colors).length;
    if (count >= MAX_VALUES) return null;
    const free = TOKENS.find((t) => !used.has(t));
    const token = free || TOKENS[count % TOKENS.length];
    colors[key] = token;
    used.add(token);
    changed = true;
    return token;
  });
  return { colors, tokens, changed };
}

/** "Apply palette": forget the column's colours and deal them out again, in this order. */
export function applyPalette(values: readonly unknown[]): ColumnColors {
  return assignColors(null, values).colors;
}

/** One value → one slot, or `null` to forget it (it is re-dealt when next drawn). */
export function setColor(current: ColumnColors | null | undefined, value: unknown, token: unknown): ColumnColors {
  const out = copyColumn(current);
  const key = colorKey(value);
  if (key === null) return out;
  if (isColorToken(token)) {
    if (!has(out, key) && Object.keys(out).length >= MAX_VALUES) return out;
    out[key] = token;
  } else {
    delete out[key];
  }
  return out;
}

/**
 * Whitelist an untrusted map (a project.json off disk, an IPC payload):
 * string keys within MAX_COLOR_KEY, slot tokens only, both caps enforced,
 * empty columns dropped. Never throws; anything else is simply left out.
 */
export function sanitizeColorMap(raw: unknown): ColorMap {
  const out = dict<ColumnColors>();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  const src = raw as Record<string, unknown>;
  for (const col of Object.keys(src)) {
    if (Object.keys(out).length >= MAX_COLUMNS) break;
    if (!col || col.length > MAX_KEY) continue;
    const vals = src[col];
    if (!vals || typeof vals !== 'object' || Array.isArray(vals)) continue;
    const colors = dict<ColorToken>();
    let n = 0;
    for (const k of Object.keys(vals as object)) {
      if (n >= MAX_VALUES) break;
      const t = (vals as Record<string, unknown>)[k];
      if (k.length > MAX_KEY || !isColorToken(t)) continue;
      colors[k] = t;
      n += 1;
    }
    if (n) out[col] = colors;
  }
  return out;
}

/** Same map, same order? (What "changed" means for a whole column.) */
export function sameColumn(a: ColumnColors | null | undefined, b: ColumnColors | null | undefined): boolean {
  const ka = a ? Object.keys(a) : [];
  const kb = b ? Object.keys(b) : [];
  return ka.length === kb.length && ka.every((k, i) => k === kb[i] && (a as ColumnColors)[k] === (b as ColumnColors)[k]);
}
