// THE MESSAGE FORMATTER — every interface string a reader sees, in their
// language. PURE, and loaded by BOTH processes exactly like format.ts:
//
//   main      `import { createTranslator } from './i18nCore'` (src/app/i18n.ts);
//   renderer  `<script src="../../src/app/i18nCore.js">` between cjsShim.js and
//             i18n.js, which binds the global `t()` and removes the shim.
//
// THIS FILE MUST NOT IMPORT ANYTHING AT RUNTIME (the renderer loads its
// CommonJS output through a two-line shim with no `require`), and its top-level
// names are I18N_-prefixed: in the renderer they are page globals.
//
// The message syntax is the ICU subset the catalog uses, nothing more:
//
//   {name}                                   a parameter, as String(value)
//   {n, plural, =0 {…} one {# item} other {# items}}   CLDR categories via
//                                            Intl.PluralRules; `#` is the number
//   {kind, select, sum {…} other {…}}
//   '{'  '}'  '#'  ''                        quoting, ICU's apostrophe rule: an
//                                            apostrophe only quotes when it is
//                                            followed by { } # or another '
//
// A parameter is never re-interpreted: a value containing `{x}` prints as is.
// Numbers in a message are the caller's business — the app formats every
// figure with format.ts BEFORE it reaches t(), so a translation can move a
// figure but never re-compute one.

export type Params = Record<string, unknown>;

type Node =
  | string
  | { arg: string }
  | { arg: string; type: 'plural' | 'select'; offset: number; branches: Record<string, Node[]> }
  | { pound: true };

const I18N_PARSED = new Map<string, Node[]>();

/** Parse a message into nodes. Malformed syntax degrades to literal text, never throws. */
export function parseMessage(msg: string): Node[] {
  const hit = I18N_PARSED.get(msg);
  if (hit) return hit;
  let i = 0;
  const parseSeq = (inPlural: boolean, untilBrace: boolean): Node[] => {
    const out: Node[] = [];
    let text = '';
    const flush = (): void => { if (text) { out.push(text); text = ''; } };
    while (i < msg.length) {
      const c = msg[i];
      if (c === '\'') {
        const n = msg[i + 1];
        if (n === '\'') { text += '\''; i += 2; continue; }
        if (n === '{' || n === '}' || (inPlural && n === '#')) {
          const close = msg.indexOf('\'', i + 1);
          text += close < 0 ? msg.slice(i + 1) : msg.slice(i + 1, close);
          i = close < 0 ? msg.length : close + 1;
          continue;
        }
        text += c; i++; continue;
      }
      if (c === '}' && untilBrace) { flush(); return out; }
      if (c === '#' && inPlural) { flush(); out.push({ pound: true }); i++; continue; }
      if (c === '{') {
        const start = i;
        const node = parseArg();
        if (node) { flush(); out.push(node); continue; }
        text += msg.slice(start); // malformed: the rest is literal text
        i = msg.length;
        continue;
      }
      text += c; i++;
    }
    flush();
    return out;
  };
  const ws = (): void => { while (i < msg.length && /\s/.test(msg[i])) i++; };
  const ident = (): string => { const m = /^[^\s,{}]+/.exec(msg.slice(i)); if (!m) return ''; i += m[0].length; return m[0]; };
  const parseArg = (): Node | null => {
    const start = i;
    i++; ws();
    const name = ident(); ws();
    if (!name) { i = start + 1; return null; }
    if (msg[i] === '}') { i++; return { arg: name }; }
    if (msg[i] !== ',') { i = start + 1; return null; }
    i++; ws();
    const type = ident(); ws();
    if (type !== 'plural' && type !== 'select' && type !== 'selectordinal') { i = start + 1; return null; }
    if (msg[i] !== ',') { i = start + 1; return null; }
    i++; ws();
    let offset = 0;
    const branches: Record<string, Node[]> = {};
    for (;;) {
      ws();
      if (msg[i] === '}') { i++; break; }
      const key = ident(); ws();
      if (!key) { i = start + 1; return null; }
      if (key.startsWith('offset:')) { offset = Number(key.slice(7)) || 0; continue; }
      if (msg[i] !== '{') { i = start + 1; return null; }
      i++;
      branches[key] = parseSeq(type !== 'select', true);
      if (msg[i] !== '}') { i = start + 1; return null; }
      i++;
    }
    if (!branches.other) { i = start + 1; return null; }
    return { arg: name, type: type === 'select' ? 'select' : 'plural', offset, branches };
  };
  const nodes = parseSeq(false, false);
  I18N_PARSED.set(msg, nodes);
  return nodes;
}

const I18N_RULES = new Map<string, Intl.PluralRules>();

/** The CLDR plural category of `n` in `locale`; 'other' when the platform cannot say. */
export function pluralCategory(locale: string, n: number): string {
  let r = I18N_RULES.get(locale);
  if (!r) {
    try { r = new Intl.PluralRules(locale); } catch (_) { r = new Intl.PluralRules('en'); }
    I18N_RULES.set(locale, r);
  }
  return Number.isFinite(n) ? r.select(n) : 'other';
}

/** Format parsed nodes. `text` transforms literal text only (the pseudo-locale). */
function render(nodes: Node[], params: Params, locale: string, text: ((s: string) => string) | null, num: number | null): string {
  let out = '';
  for (const n of nodes) {
    if (typeof n === 'string') { out += text ? text(n) : n; continue; }
    if ('pound' in n) { out += num === null ? '#' : String(num); continue; }
    const v = params[n.arg];
    if (!('type' in n)) { out += v === undefined || v === null ? '' : String(v); continue; }
    if (n.type === 'select') {
      const b = n.branches[String(v)] || n.branches.other;
      out += render(b, params, locale, text, num);
      continue;
    }
    const x = typeof v === 'number' ? v : Number(v);
    const exact = n.branches['=' + x];
    const b = exact || n.branches[pluralCategory(locale, x - n.offset)] || n.branches.other;
    out += render(b, params, locale, text, x - n.offset);
  }
  return out;
}

export function formatMessage(msg: string, params: Params | undefined, locale: string, text?: (s: string) => string): string {
  return render(parseMessage(msg), params || {}, locale, text || null, null);
}

// ── the pseudo-locale ───────────────────────────────────────────────────

const I18N_ACCENT: Record<string, string> = {
  a: 'à', b: 'ƀ', c: 'ç', d: 'ð', e: 'é', f: 'ƒ', g: 'ĝ', h: 'ĥ', i: 'î', j: 'ĵ', k: 'ķ', l: 'ļ', m: 'ɱ', n: 'ñ',
  o: 'ö', p: 'þ', q: 'ǫ', r: 'ŕ', s: 'š', t: 'ţ', u: 'û', v: 'ṽ', w: 'ŵ', x: 'ẋ', y: 'ý', z: 'ž',
  A: 'Å', B: 'Ɓ', C: 'Ç', D: 'Ð', E: 'É', F: 'Ƒ', G: 'Ĝ', H: 'Ĥ', I: 'Î', J: 'Ĵ', K: 'Ķ', L: 'Ļ', M: 'Ṁ', N: 'Ñ',
  O: 'Ö', P: 'Þ', Q: 'Ǫ', R: 'Ŕ', S: 'Š', T: 'Ţ', U: 'Û', V: 'Ṽ', W: 'Ŵ', X: 'Ẋ', Y: 'Ý', Z: 'Ž',
};

/** Every ASCII letter accented — the pseudo-locale's look, applied to literal text only. */
export function accentText(s: string): string {
  return s.replace(/[A-Za-z]/g, (c) => I18N_ACCENT[c] || c);
}

/**
 * en-XA: every letter accented and the text 30% longer, so a string that skipped
 * the catalog (plain ASCII) or a box that clips (the padding is cut) shows at a
 * glance. The padding goes once, at the end of the whole message — parameters
 * and plural syntax are formatted first and never touched.
 */
export function pseudoText(s: string): string {
  if (!/\S/.test(s)) return s;
  const pad = Math.ceil(s.trim().length * 0.3);
  return accentText(s).replace(/(\s*)$/, (ws) => (pad ? ' ' + '·'.repeat(Math.max(1, pad - 1)) : '') + ws);
}

// ── the translator ──────────────────────────────────────────────────────

/** A locale's catalog: key → message. `null` marks a key as deliberately English. */
export type Catalog = Record<string, string | null>;

export interface TranslatorOpts {
  locale: string;
  messages: Catalog;
  /** English: the fallback for every key a locale lacks, and the source of truth. */
  fallback: Catalog;
  /** Called once per missing key (not for explicit `null`), for the dev warning. */
  onMissing?: (key: string) => void;
}

export interface Translator {
  (key: string, params?: Params): string;
  locale: string;
  /** Keys looked up that the locale did not have, so far. */
  missing: Set<string>;
}

// Read through a local, never `exports.PSEUDO_LOCALE`: the renderer's binder
// (i18n.ts) removes the CommonJS shim right after this file loads.
const I18N_PSEUDO = 'en-XA';
export const PSEUDO_LOCALE = I18N_PSEUDO;

export function createTranslator(o: TranslatorOpts): Translator {
  const missing = new Set<string>();
  const pseudo = o.locale === I18N_PSEUDO;
  const pluralLocale = pseudo ? 'en' : o.locale;
  const tr = ((key: string, params?: Params): string => {
    let msg: string | null | undefined = pseudo ? undefined : o.messages[key];
    if (typeof msg !== 'string') {
      if (msg === undefined && !pseudo && o.locale !== 'en' && !missing.has(key)) {
        missing.add(key);
        if (o.onMissing) o.onMissing(key);
      }
      msg = o.fallback[key];
    }
    if (typeof msg !== 'string') return key;
    if (!pseudo) return formatMessage(msg, params, pluralLocale);
    const plain = formatMessage(msg, params, pluralLocale);
    const pad = Math.ceil(plain.trim().length * 0.3);
    const accented = formatMessage(msg, params, pluralLocale, accentText);
    return /\S/.test(plain) ? accented.replace(/(\s*)$/, (ws) => ' ' + '·'.repeat(Math.max(1, pad - 1)) + ws) : accented;
  }) as Translator;
  tr.locale = o.locale;
  tr.missing = missing;
  return tr;
}

/** Meta entries (`_status`, `_locale`, `_name`) are not messages. */
export function messagesOf(file: Record<string, unknown>): Catalog {
  const out: Catalog = {};
  for (const [k, v] of Object.entries(file || {})) {
    if (k.startsWith('_')) continue;
    if (typeof v === 'string' || v === null) out[k] = v;
  }
  return out;
}
