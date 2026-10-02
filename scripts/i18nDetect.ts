// WHICH STRINGS A READER SEES — the detector behind the string catalog.
//
// scripts/i18n-extract.ts rewrites what this finds into `t('key', {…})` calls;
// scripts/test-i18n.ts runs the SAME detector over the rewritten renderer and
// fails on anything it still finds. One classifier for both, so "the guard
// passes" means exactly "the extractor has nothing left to do".
//
// A string is a MESSAGE when its text reads as prose and nothing about where it
// sits says it is data: a class list, a selector, an event or key name, an id,
// an icon, SVG markup, a value some code compares against. Neighbouring pieces
// joined with `+` become ONE message with parameters, and the house idiom
// `n === 1 ? 'item' : 'items'` becomes an ICU plural — so a translator sees
// "{count} {count, plural, one {item} other {items}}", not three fragments.
//
// Heuristic by nature. Its misses are what the guard's allowlist names; its
// false positives cost a translator a line, never a behaviour change: every
// rewrite is an expression with the identical English value.

import { lex, cook } from './i18nLex';
import type { Tok } from './i18nLex';

/** One part of a message: literal text, a parameter, or a plural on a parameter. */
export type Piece =
  | { text: string }
  | { param: string; src: [number, number] }
  | { plural: string; src: [number, number]; one: string; other: string }
  /** `cond ? 'a' : 'b'` inside a message: an ICU select on the condition. */
  | { select: string; src: [number, number]; yes: string; no: string };

export interface Site {
  start: number;
  end: number;
  pieces: Piece[];
  /** Token spans of nested strings this site consumed (plural branches). */
  consumed: Set<number>;
}

// ── value tests ─────────────────────────────────────────────────────────

const RE_MARKUP = /<\/?[a-z][^>]*>|\/>/i;
const RE_CSSISH = /\d(px|em|rem|vh|vw|ms|s)\b|^(rgba?|hsla?|var|calc|url|linear-gradient|radial-gradient|translate|rotate|scale)\(|#[0-9a-f]{3,8}\b/i;
const RE_URLISH = /^(https?:|file:|data:|mailto:|blob:|\.{0,2}\/)/i;
const RE_SQL = /\b(SELECT|FROM|WHERE|GROUP BY|ORDER BY|CAST|COALESCE|TRY_CAST|LIMIT|read_parquet|DESCRIBE|PRAGMA)\b/g;

const STOP = new Set(['the', 'a', 'an', 'of', 'to', 'in', 'on', 'is', 'no', 'and', 'or', 'for', 'by', 'with', 'this',
  'that', 'per', 'not', 'as', 'at', 'from', 'all', 'each', 'your', 'you', 'it', 'its', 'be', 'are', 'was']);

/** Does this text read as words for a person? `strong` relaxes it for one-word labels in a visible slot. */
export function isProse(raw: string, strong: boolean): boolean {
  const s = raw.replace(/\{\}/g, ' ').trim();
  if (!/\p{L}{2}/u.test(s)) return false;
  if (s === 'use strict') return false;
  if (RE_MARKUP.test(s) || RE_CSSISH.test(s) || RE_URLISH.test(s)) return false;
  if (/^[MmLlHhVvCcSsQqTtAaZz0-9.,\s-]+$/.test(s) && /\d/.test(s)) return false; // SVG path data
  if ((s.match(RE_SQL) || []).length >= 2) return false;
  const words = s.split(/\s+/);
  // A class list or selector: every token kebab/snake-ish, at least one with a separator.
  if (words.every((w) => /^[.#]?[a-z][a-z0-9_-]*$/.test(w)) && words.some((w) => /[-_]/.test(w) || /^[.#]/.test(w))
    && !words.some((w) => STOP.has(w))) return false;
  if (/^[.#[][\w-]/.test(s) && /[\w\]]$/.test(s) && !/\s[a-z]{2,}\s/.test(s)) return false; // '.ws-row [data-x]'
  if (/^[\w$]+(\.[\w$]+)+$/.test(s)) return false; // 'a.b.c' — a key path or file name
  if (/^[\w-]+\/[\w.+-]+$/.test(s)) return false; // 'image/png'
  if (/^[\w-]+:[\w-]+$/.test(s)) return false; // 'ipc:channel'
  if (words.length === 1) {
    if (strong) return /^\p{L}[\p{L}'’.-]*[.…:!?]?$/u.test(s) || /^\p{Lu}/u.test(s);
    // One bare word outside a visible slot: only a Capitalised word ('Dataset'),
    // never camelCase, ALLCAPS or snake (identifiers, enum values, keys).
    return /^\p{Lu}\p{Ll}+[’'s]*[.…:!?]?$/u.test(s);
  }
  // Several words, but each an identifier-shaped token with no sentence shape:
  // 'sum avg count' is a list of keys. Prose has a capital, punctuation, or a
  // common word in it.
  // Several snake_case keys: 'sum_x avg_y'. Plain lower-case words are prose.
  if (words.every((w) => /^[a-z][a-z0-9]*(_[a-z0-9]+)+$/.test(w))) return false;
  return true;
}

// ── context ─────────────────────────────────────────────────────────────

/** Calls whose string arguments are never shown to a reader. */
const QUIET_CALLEES = new Set([
  'log', 'warn', 'error', 'info', 'debug', 'trace', 'assert', 'time', 'timeEnd',
  'Error', 'TypeError', 'RangeError', 'SyntaxError',
  'querySelector', 'querySelectorAll', 'getElementById', 'getElementsByClassName', 'closest', 'matches',
  'add', 'remove', 'toggle', 'contains', 'replace', // classList.* (filtered by receiver below)
  'addEventListener', 'removeEventListener', 'dispatchEvent', 'Event', 'CustomEvent', 'KeyboardEvent', 'MouseEvent',
  'setProperty', 'getPropertyValue', 'removeProperty', 'require', 'matchMedia', 'createElement', 'createElementNS',
  'getItem', 'setItem', 'removeItem', 'getAttribute', 'removeAttribute', 'hasAttribute', 'toggleAttribute',
  '_vi', 'svg', 'svgIcon', 'icon', 'iconSvg', 'makeIcon', 'lazyScript', 'loadScript', 'invoke', 'send', 'postMessage',
  'RegExp', 'fetch', 'toLocaleString', 'toLocaleDateString', 'toLocaleTimeString', 'NumberFormat', 'DateTimeFormat',
  'PluralRules', 'Collator', 'localeCompare', 'startsWith', 'endsWith', 'includes', 'indexOf', 'lastIndexOf', 'split',
  'join', 'padStart', 'padEnd', 'normalize', 'test', 'exec', 'match', 'search',
  'getContext', 'toDataURL', 'measureText', 'font', 'execCommand', 'setData', 'getData',
  'emulateMedia', 'scrollIntoView', 'animate', 'insertAdjacentHTML', 't', 'tp',
]);
/** Receivers whose methods named in QUIET_CALLEES are only quiet on them (classList.add vs set.add). */
const CLASSLIST_ONLY = new Set(['add', 'remove', 'toggle', 'contains', 'replace']);

/** `x.prop = 'Text'` shows text for these props; any other member assignment is data. */
const VISIBLE_PROPS = new Set(['textContent', 'innerText', 'title', 'placeholder', 'label', 'ariaLabel', 'alt',
  'ariaDescription', 'ariaValueText', 'ariaRoleDescription', 'ariaPlaceholder', 'nodeValue', 'data']);
/** Object keys whose string values are data. */
const DATA_KEYS = new Set(['className', 'class', 'cls', 'klass', 'id', 'key', 'kind', 'type', 'icon', 'iconName',
  'value', 'op', 'agg', 'aggregation', 'mode', 'format', 'fmt', 'role', 'cmd', 'command', 'channel', 'event', 'variant',
  'tone', 'size', 'align', 'position', 'color', 'colour', 'font', 'fontFamily', 'family', 'tag', 'tagName', 'ref', 'href',
  'src', 'url', 'path', 'file', 'ext', 'mime', 'accept', 'shortcut', 'keys', 'hotkey', 'chart', 'viz', 'vizType', 'field',
  'column', 'col', 'dim', 'measure', 'sql', 'query', 'expr', 'formula', 'pattern', 'regex', 'unit', 'locale', 'lang',
  'scope', 'status', 'state', 'sel', 'selector', 'target', 'cursor', 'display', 'weight', 'style', 'fill',
  'stroke', 'd', 'viewBox', 'dataset', 'ds', 'grain', 'interval', 'theme', 'palette', 'scheme', 'easing', 'level',
  'axis', 'stack', 'stackId', 'yAxisID', 'xAxisID', 'pointStyle', 'borderDash', 'mark', 'shape', 'slot', 'tab', 'page',
  'section', 'panel', 'view', 'route', 'dir', 'sort', 'order', 'by', 'prefix', 'suffix', 'sep', 'delimiter', 'quote',
  'encoding', 'storageKey', 'lsKey', 'testId']);
/** Keys whose values are never text, whatever they look like. */
const QUIET_KEYS = new Set(['className', 'class', 'cls', 'klass', 'id', 'key', 'icon', 'iconName', 'href', 'src',
  'url', 'path', 'sql', 'query', 'expr', 'formula', 'pattern', 'selector', 'sel', 'stack', 'd', 'viewBox', 'style',
  'fill', 'stroke', 'font', 'fontFamily', 'family', 'locale', 'lang', 'mime', 'accept', 'cssText', 'storageKey',
  'lsKey', 'testId', 'channel', 'event', 'cmd', 'command', 'shortcut', 'keys', 'hotkey', 'tag', 'tagName', 'ext']);

/** Object keys whose string values are always shown (strong slots for one-word labels). */
const VISIBLE_KEYS = new Set(['label', 'title', 'line', 'hint', 'text', 'textContent', 'word', 'placeholder', 'sub',
  'body', 'meta', 'desc', 'description', 'caption', 'message', 'msg', 'ariaLabel', 'actionLabel', 'tooltip', 'blurb',
  'heading', 'subtitle', 'confirmLabel', 'okLabel', 'cancelLabel', 'plural', 'singular', 'reason', 'badge', 'error',
  'warn', 'warning', 'help', 'summary', 'note', 'cta', 'empty', 'emptyTitle', 'emptyLine', 'lede', 'detail', 'short',
  'long', 'verb', 'noun', 'header', 'footer', 'legend', 'group', 'yLabel', 'xLabel', 'unitLabel', 'okText', 'question',
  'answer', 'question', 'prompt', 'emptyText', 'loading', 'done', 'what', 'why', 'how', 'example', 'examples', 'tip']);
/** Calls that show their string arguments. */
const VISIBLE_CALLEES = new Set(['showToast', 'alert', 'confirm', 'prompt', 'createTextNode', 'append', 'prepend',
  'promptModal', 'confirmModal', 'askConfirm', 'setStatus', 'toast', 'notify', 'announce', 'a11yAnnounce']);
const VISIBLE_ATTRS = new Set(['title', 'aria-label', 'aria-description', 'placeholder', 'alt', 'aria-valuetext',
  'aria-roledescription', 'aria-placeholder', 'data-tip', 'data-tooltip', 'data-empty', 'data-label']);

// ── bracket structure of one token sequence ─────────────────────────────

function matchBrackets(toks: Tok[]): Int32Array {
  const m = new Int32Array(toks.length).fill(-1);
  const st: number[] = [];
  for (let i = 0; i < toks.length; i++) {
    const v = toks[i].type === 'punct' ? toks[i].value : '';
    if (v === '(' || v === '[' || v === '{') st.push(i);
    else if (v === ')' || v === ']' || v === '}') { const o = st.pop(); if (o !== undefined) { m[o] = i; m[i] = o; } }
  }
  return m;
}

const isStrLike = (t: Tok | undefined): boolean => !!t && (t.type === 'str' || t.type === 'tpl');
const isP = (t: Tok | undefined, ...v: string[]): boolean => !!t && t.type === 'punct' && v.includes(t.value);
const isI = (t: Tok | undefined, ...v: string[]): boolean => !!t && t.type === 'ident' && (v.length === 0 || v.includes(t.value));

const KEYWORDS = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case',
  'do', 'else', 'yield', 'await', 'if', 'for', 'while', 'switch', 'const', 'let', 'var', 'function', 'class', 'as',
  'export', 'import', 'default', 'extends', 'satisfies', 'keyof']);

/** End index (exclusive) of the operand starting at i, or -1 when it is not a plain one. */
function operandEnd(toks: Tok[], m: Int32Array, i: number): number {
  let t = toks[i];
  if (!t) return -1;
  let j: number;
  if (t.type === 'str' || t.type === 'tpl' || t.type === 'num') j = i + 1;
  else if (t.type === 'ident' && !KEYWORDS.has(t.value)) j = i + 1;
  else if (isP(t, '(', '[') && m[i] > i) j = m[i] + 1;
  else return -1;
  for (;;) {
    t = toks[j];
    if (isP(t, '.', '?.') && isI(toks[j + 1])) { j += 2; continue; }
    if (isP(t, '(', '[') && m[j] > j) { j = m[j] + 1; continue; }
    if (isP(t, '!') && !isP(toks[j + 1], '(') && !isI(toks[j + 1]) && !isStrLike(toks[j + 1])) { j++; continue; }
    if (t && t.type === 'tpl') return -1; // tagged template
    break;
  }
  return j;
}

/** Start index of the operand ending at `e` (exclusive), or -1. */
function operandStart(toks: Tok[], m: Int32Array, e: number): number {
  let k = e - 1;
  const atom = (): boolean => {
    const t = toks[k];
    if (!t) return false;
    if (isP(t, ')', ']') && m[k] >= 0 && m[k] < k) { k = m[k] - 1; return true; }
    if (t.type === 'str' || t.type === 'tpl' || t.type === 'num' || (t.type === 'ident' && !KEYWORDS.has(t.value))) { k--; return true; }
    return false;
  };
  if (isP(toks[k], '!')) k--;
  if (!atom()) return -1;
  for (;;) {
    // a call or index directly after another operand: `f(x)`, `a[0]`
    const consumedGroup = isP(toks[k + 1], '(', '[');
    if (consumedGroup && (isI(toks[k]) || isP(toks[k], ')', ']'))) { if (!atom()) return -1; continue; }
    if (isP(toks[k], '.', '?.')) { k--; if (!atom()) return -1; continue; }
    if (isP(toks[k], '!') && (isI(toks[k - 1]) || isP(toks[k - 1], ')', ']'))) { k--; if (!atom()) return -1; continue; }
    break;
  }
  if (isI(toks[k], 'new')) return -1;
  return k + 1;
}

/** Tokens before a `+` chain that bind tighter than `+` (or make it not a concatenation). */
const TIGHT_BEFORE = new Set(['*', '/', '%', '**', '-', '!', '~', '.', '?.', '++', '--', '<<', '>>', '>>>']);

// ── the detector ────────────────────────────────────────────────────────

export interface DetectOpts {
  /** Values compared against anywhere in the renderer: these are data, not text. */
  dataValues: Set<string>;
}

/** Strings some code compares against, switches on, or uses as a lookup key. */
export function collectDataValues(src: string, into: Set<string>): void {
  // Month and weekday abbreviations are parsed and matched as data (chartShapes,
  // calendar heatmaps); dates are the formatter's job, not the catalog's.
  for (const w of 'Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec Mon Tue Wed Thu Fri Sat Sun'.split(' ')) into.add(w);
  const walk = (toks: Tok[]): void => {
    const m = matchBrackets(toks);
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i];
      if (t.type === 'tpl') for (const e of t.exprs || []) walk(e.toks);
      if (t.type !== 'str') continue;
      const p = toks[i - 1];
      const n = toks[i + 1];
      if (isP(p, '===', '!==', '==', '!=') || isP(n, '===', '!==', '==', '!=') || isI(p, 'case', 'in') || isI(n, 'in')) into.add(t.value);
      // `{ 'Key': v }` — a string used as a key
      else if (isP(n, ':') && isP(p, '{', ',') && !isP(toks[i - 2], '?')) into.add(t.value);
      // `.has('x')`, `.get('x')`, `.delete('x')`: a lookup key
      else if (isP(p, '(') && isI(toks[i - 2], 'has', 'get', 'delete') && isP(toks[i - 3], '.')) into.add(t.value);
    }
    // ['a', 'b'].includes(x) / indexOf(x): every member is a value compared against
    for (let i = 0; i < toks.length; i++) {
      if (isP(toks[i], '[') && m[i] > i && isP(toks[m[i] + 1], '.') && isI(toks[m[i] + 2], 'includes', 'indexOf')) {
        for (let k = i + 1; k < m[i]; k++) if (toks[k].type === 'str') into.add(toks[k].value);
      }
    }
  };
  walk(lex(src).toks);
}

/** `X === 1 ? 'a' : 'b'` (and its mirrors) over tokens [s, e): the plural it spells, or null. */
function pluralOf(toks: Tok[], s: number, e: number): { cond: [number, number]; one: Tok; other: Tok } | null {
  if (isP(toks[s], '(') && e - 1 > s && isP(toks[e - 1], ')')) { s++; e--; }
  const q = toks.findIndex((t, k) => k >= s && k < e && isP(t, '?'));
  if (q < 0 || q + 4 !== e || !isP(toks[q + 2], ':') || toks[q + 1].type !== 'str' || toks[q + 3].type !== 'str') return null;
  const op = toks[q - 2];
  const lit = toks[q - 1];
  if (!op || !lit || lit.type !== 'num' || q - 2 <= s) return null;
  const a = toks[q + 1];
  const b = toks[q + 3];
  for (let k = s, d = 0; k < q - 2; k++) { // the condition is one operand: no top-level comma
    if (isP(toks[k], '(', '[', '{')) d++; else if (isP(toks[k], ')', ']', '}')) d--;
    else if (d === 0 && (isP(toks[k], ',', '=>', '&&', '||', '??', '=') || isI(toks[k], 'return'))) return null;
  }
  const cond: [number, number] = [toks[s].start, toks[q - 3].end];
  if ((op.value === '===' || op.value === '==') && lit.value === '1') return { cond, one: a, other: b };
  if ((op.value === '!==' || op.value === '!=') && lit.value === '1') return { cond, one: b, other: a };
  if (op.value === '>' && lit.value === '1') return { cond, one: b, other: a };
  return null;
}

/** `cond ? 'a' : 'b'` over tokens [s, e) — both arms plain strings — or null. */
function choiceOf(toks: Tok[], s: number, e: number): { cond: [number, number]; yes: Tok; no: Tok } | null {
  if (isP(toks[s], '(') && e - 1 > s && isP(toks[e - 1], ')')) { s++; e--; }
  if (e - s < 5) return null;
  const q = e - 4;
  if (!isP(toks[q], '?') || !isP(toks[q + 2], ':') || toks[q + 1].type !== 'str' || toks[q + 3].type !== 'str') return null;
  for (let k = s, d = 0; k < q; k++) {
    if (isP(toks[k], '(', '[', '{')) d++; else if (isP(toks[k], ')', ']', '}')) d--;
    else if (d === 0 && (isP(toks[k], ',', '?', ':', '=>', '=') || isI(toks[k], 'return'))) return null;
  }
  return { cond: [toks[s].start, toks[q - 1].end], yes: toks[q + 1], no: toks[q + 3] };
}

/**
 * Every message in one TypeScript source, outermost first. Sites never
 * partially overlap: an inner site sits wholly inside a parameter of an outer.
 */
export function detect(src: string, opts: DetectOpts): Site[] {
  const sites: Site[] = [];
  const consumed = new Set<number>(); // token start offsets already part of a site

  const srcLines = src.split('\n');
  const lineStarts: number[] = [0];
  for (let i = 0; i < src.length; i++) if (src[i] === '\n') lineStarts.push(i + 1);
  const textLine = (pos: number): boolean => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (lineStarts[mid] <= pos) lo = mid; else hi = mid - 1; }
    return /\/\/.*i18n-text/.test(srcLines[lo]);
  };
  const visit = (toks: Tok[], inheritQuiet: boolean): void => {
    const m = matchBrackets(toks);
    // Skip TS type positions: `type X = …;`, `: 'a' | 'b'`, `as 'x'`.
    const quiet = new Uint8Array(toks.length);
    for (let i = 0; i < toks.length; i++) {
      if (isI(toks[i], 'type') && isI(toks[i + 1]) && (isP(toks[i + 2], '=') || isP(toks[i + 2], '<'))) {
        let k = i;
        let depth = 0;
        for (; k < toks.length; k++) {
          if (isP(toks[k], '(', '[', '{')) depth++;
          else if (isP(toks[k], ')', ']', '}')) depth--;
          else if (depth === 0 && isP(toks[k], ';')) break;
          quiet[k] = 1;
        }
      }
      if (isI(toks[i], 'interface') || isI(toks[i], 'declare')) {
        let k = i;
        while (k < toks.length && !isP(toks[k], '{')) quiet[k++] = 1;
        if (k < toks.length) for (let q = k; q <= m[k] && q < toks.length; q++) quiet[q] = 1;
      }
    }
    // the innermost enclosing call per token: callee name and its receiver
    const callee: (string | null)[] = new Array(toks.length).fill(null);
    const recv: (string | null)[] = new Array(toks.length).fill(null);
    const argIx: number[] = new Array(toks.length).fill(0);
    const firstArg: (string | null)[] = new Array(toks.length).fill(null);
    const stack: { name: string | null; recv: string | null; open: number; arg: number }[] = [];
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i];
      if (isP(t, '(', '[', '{')) {
        let name: string | null = null;
        let rv: string | null = null;
        if (t.value === '(') {
          let k = i - 1;
          if (isP(toks[k], '>') ) { // generic call f<T>(…)
            let d = 0;
            for (; k >= 0; k--) { if (isP(toks[k], '>')) d++; else if (isP(toks[k], '<')) { d--; if (d === 0) { k--; break; } } }
          }
          if (isI(toks[k])) { name = toks[k].value; if (isP(toks[k - 1], '.', '?.')) rv = isI(toks[k - 2]) ? toks[k - 2].value : ')'; }
        }
        stack.push({ name: t.value === '(' ? name : (t.value === '[' ? '[' : '{'), recv: rv, open: i, arg: 0 });
        continue;
      }
      if (isP(t, ')', ']', '}')) { stack.pop(); continue; }
      const top = stack[stack.length - 1];
      if (top && isP(t, ',')) { top.arg++; continue; }
      if (top) {
        callee[i] = top.name;
        recv[i] = top.recv;
        argIx[i] = top.arg;
        const f = toks[top.open + 1];
        firstArg[i] = f && f.type === 'str' ? f.value : null;
      }
      // The INNERMOST call decides: `console.log('x')` is quiet, but a handler
      // passed to addEventListener is a function body, not an argument.
      if (top && top.recv === 'console') quiet[i] = 1;
      if (top && top.name && QUIET_CALLEES.has(top.name) && !(CLASSLIST_ONLY.has(top.name) && top.recv !== 'classList')) quiet[i] = 1;
      if (stack.some((s) => s.name === 't' || s.name === 'tp')) quiet[i] = 1;
    }

    /** Context of the value starting at token index i (the chain's first token). */
    const context = (i: number): { quiet: boolean; strong: boolean; wordsOnly?: boolean; capital?: boolean } => {
      // `// i18n-text` on the line: these are words for a reader, even one lower-case word.
      if (textLine(toks[i].start)) return { quiet: false, strong: true };
      const p1 = toks[i - 1];
      const p2 = toks[i - 2];
      const p3 = toks[i - 3];
      if (inheritQuiet || quiet[i]) return { quiet: true, strong: false };
      if (isP(p1, '|') || isP(toks[i + 1], '|') || isI(p1, 'as', 'satisfies', 'import', 'from', 'require')) return { quiet: true, strong: false };
      if (isP(p1, '===', '!==', '==', '!=') || isI(p1, 'case', 'in')) return { quiet: true, strong: false };
      // `.prop = value` / `.prop += value`
      if (isP(p1, '=', '+=') && isI(p2) && isP(p3, '.', '?.')) {
        if (p2.value === 'style' || isI(toks[i - 4], 'style') || isI(toks[i - 4], 'dataset')) return { quiet: true, strong: false };
        if (VISIBLE_PROPS.has(p2.value)) return { quiet: false, strong: true };
        if (QUIET_KEYS.has(p2.value)) return { quiet: true, strong: false };
        if (DATA_KEYS.has(p2.value)) return { quiet: false, strong: false, wordsOnly: true };
        return { quiet: false, strong: false }; // `st.note = …`, an input's default `.value`
      }
      // `key: value` in an object literal (not the else-arm of a ternary)
      if (isP(p1, ':') && (isI(p2) || (p2 && p2.type === 'str')) && isP(p3, '{', ',')) {
        const key = p2.type === 'str' ? p2.value : p2.value;
        if (QUIET_KEYS.has(key)) return { quiet: true, strong: false };
        if (DATA_KEYS.has(key)) return { quiet: false, strong: false, wordsOnly: true };
        // A one-word value under a visible key must still look like a label
        // ('Cancel'), never a lower-case id (`line: 'line'` is a mapping).
        if (VISIBLE_KEYS.has(key)) return { quiet: false, strong: true, capital: true };
      }
      // a key itself, not a value
      if (isP(toks[i + 1], ':') && isP(p1, '{', ',') && !isP(p2, '?')) return { quiet: true, strong: false };
      // call arguments
      const c = callee[i];
      if (c === 'setAttribute') {
        if (argIx[i] === 0) return { quiet: true, strong: false };
        return VISIBLE_ATTRS.has(firstArg[i] || '') ? { quiet: false, strong: true } : { quiet: true, strong: false };
      }
      if (c && VISIBLE_CALLEES.has(c)) return { quiet: false, strong: true };
      return { quiet: false, strong: false };
    };

    for (let i = 0; i < toks.length; i++) {
      const t = toks[i];
      if (!isStrLike(t) || consumed.has(t.start)) {
        if (t.type === 'tpl' && consumed.has(t.start)) for (const e of t.exprs || []) visit(e.toks, inheritQuiet || !!quiet[i]);
        continue;
      }
      // Grow a `+` chain around this literal — or around the `(n === 1 ? 'a' : 'b')`
      // group it is a branch of, so the plural joins its neighbours.
      let s = i;
      let e = operandEnd(toks, m, i);
      if (e < 0) e = i + 1;
      const open = enclosingParen(toks, m, i);
      const isCall = open > 0 && (isI(toks[open - 1]) || isP(toks[open - 1], ')', ']'));
      if (open >= 0 && !isCall && pluralOf(toks, open, m[open] + 1)) { s = open; e = operandEnd(toks, m, open); if (e < 0) e = m[open] + 1; }
      const ops: [number, number][] = [[s, e]];
      for (;;) { // leftwards
        if (!isP(toks[s - 1], '+')) break;
        const ps = operandStart(toks, m, s - 1);
        if (ps < 0) break;
        ops.unshift([ps, s - 1]);
        s = ps;
      }
      for (;;) { // rightwards
        if (!isP(toks[e], '+')) break;
        const ne = operandEnd(toks, m, e + 1);
        if (ne < 0) break;
        ops.push([e + 1, ne]);
        e = ne;
      }
      let chain = ops;
      const isLit = (o: [number, number]): boolean => (o[1] - o[0] === 1 && isStrLike(toks[o[0]])) || !!pluralOf(toks, o[0], o[1]);
      const firstLit = chain.findIndex(isLit);
      const okBefore = !TIGHT_BEFORE.has(toks[chain[0][0] - 1]?.value || '') && !(toks[chain[0][0] - 1]?.type === 'ident' && KEYWORDS.has(toks[chain[0][0] - 1].value) && !isI(toks[chain[0][0] - 1], 'return', 'case', 'throw', 'yield', 'await', 'else', 'do'));
      const okAfter = !isP(toks[chain[chain.length - 1][1]], '*', '/', '%', '**', '-', '.', '?.');
      if (chain.length > 1 && (firstLit > 1 || !okBefore || !okAfter)) {
        // not safely one concatenation: fall back to this literal alone
        chain = [[i, i + 1]];
      }
      const litText = (o: [number, number]): string => { const pl = pluralOf(toks, o[0], o[1]); return pl ? pl.other.value : literalText(toks[o[0]]); };
      if (chain.length > 1 && chain.every((o) => !isLit(o) || !isProse(litText(o), false))) chain = [[i, i + 1]];

      // Build pieces.
      const pieces: Piece[] = [];
      const myConsumed = new Set<number>();
      for (const o of chain) {
        if (isLit(o) && !pluralOf(toks, o[0], o[1])) {
          const tk = toks[o[0]];
          myConsumed.add(tk.start);
          if (tk.type === 'str') pieces.push({ text: tk.value });
          else {
            const q = tk.quasis || [];
            q.forEach((part, k) => {
              pieces.push({ text: cook(part.raw.replace(/\\`/g, '`').replace(/\\\$/g, '$')) });
              const ex = tk.exprs && tk.exprs[k];
              if (!ex) return;
              const pl = pluralOf(ex.toks, 0, ex.toks.length);
              const ch = pl ? null : choiceOf(ex.toks, 0, ex.toks.length);
              if (pl) {
                myConsumed.add(pl.one.start); myConsumed.add(pl.other.start);
                pieces.push({ plural: '', src: pl.cond, one: pl.one.value, other: pl.other.value });
              } else if (ch) {
                myConsumed.add(ch.yes.start); myConsumed.add(ch.no.start);
                pieces.push({ select: '', src: ch.cond, yes: ch.yes.value, no: ch.no.value });
              } else pieces.push({ param: '', src: [ex.start, ex.end] });
            });
          }
        } else {
          const pl = pluralOf(toks, o[0], o[1]);
          const ch = pl ? null : (isP(toks[o[0]], '(') ? choiceOf(toks, o[0], o[1]) : null);
          if (pl) {
            myConsumed.add(pl.one.start); myConsumed.add(pl.other.start);
            pieces.push({ plural: '', src: pl.cond, one: pl.one.value, other: pl.other.value });
          } else if (ch) {
            myConsumed.add(ch.yes.start); myConsumed.add(ch.no.start);
            pieces.push({ select: '', src: ch.cond, yes: ch.yes.value, no: ch.no.value });
          } else pieces.push({ param: '', src: [toks[o[0]].start, toks[o[1] - 1].end] });
        }
      }
      const staticText = pieces.map((p) => ('text' in p ? p.text : ('plural' in p ? p.other : ('select' in p ? p.yes || p.no || '{}' : '{}')))).join('');
      const ctx = context(chain[0][0]);
      // Under a data key (`type:`, `.value =`) only real sentences count, never one word.
      const prose = isProse(staticText, ctx.strong && !ctx.capital && chain.length === 1 && pieces.length === 1)
        && !(ctx.wordsOnly && staticText.trim().split(/\s+/).length < 2);
      const data = chain.length === 1 && t.type === 'str' && opts.dataValues.has(t.value) && !textLine(t.start);
      if (ctx.quiet || !prose || data) {
        // Not a message. Its template expressions may still hold some.
        if (t.type === 'tpl') for (const ex of t.exprs || []) visit(ex.toks, inheritQuiet || ctx.quiet);
        continue;
      }
      for (const x of myConsumed) consumed.add(x);
      sites.push({ start: toks[chain[0][0]].start, end: toks[chain[chain.length - 1][1] - 1].end, pieces, consumed: myConsumed });
      // Nested messages inside parameters (and inside template expressions).
      for (const o of chain) {
        if (isLit(o)) { const tk = toks[o[0]]; if (tk.type === 'tpl') for (const ex of tk.exprs || []) visit(ex.toks, false); }
      }
    }
  };
  visit(lex(src).toks, false);
  // `// i18n-skip` on a line (or the line above) keeps its strings out: a mirror of
  // a main-process constant that a test pins byte-for-byte, say.
  const lines = src.split('\n');
  const lineOf = (pos: number): number => src.slice(0, pos).split('\n').length - 1;
  const regions: [number, number][] = [];
  lines.forEach((l, i) => { if (/i18n-skip-begin/.test(l)) regions.push([i, lines.length]); else if (/i18n-skip-end/.test(l) && regions.length) regions[regions.length - 1][1] = i; });
  const skipped = (pos: number): boolean => {
    const l = lineOf(pos);
    if (regions.some(([a, b]) => l >= a && l <= b)) return true;
    return /i18n-skip(?!-)/.test(lines[l]) || (l > 0 && /\/\/\s*i18n-skip(?!-)/.test(lines[l - 1]));
  };
  // Dedupe (a chain may be reached from each of its literals) and order outermost first.
  const seen = new Set<string>();
  return sites.filter((s) => { const k = s.start + ':' + s.end; if (seen.has(k) || skipped(s.start)) return false; seen.add(k); return true; })
    .sort((a, b) => a.start - b.start || b.end - a.end);
}

/** The `(` directly enclosing token i, or -1. */
function enclosingParen(toks: Tok[], m: Int32Array, i: number): number {
  for (let k = i - 1; k >= 0; k--) {
    if (isP(toks[k], ')', ']', '}') && m[k] >= 0) { k = m[k]; continue; }
    if (isP(toks[k], '(', '[', '{')) return toks[k].value === '(' ? k : -1;
  }
  return -1;
}

function literalText(t: Tok): string {
  return t.type === 'str' ? t.value : (t.quasis || []).map((q) => cook(q.raw)).join('{}');
}
