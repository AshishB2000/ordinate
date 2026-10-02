// THE STRING CATALOG, BUILT BY SCRIPT — never by hand, never by an agent.
//
//   npm run build:ts && node scripts/i18n-extract.js           # rewrite + regenerate en.json
//   node scripts/i18n-extract.js --dry                          # report only
//
// Walks every renderer/hub/*.ts and renderer/hub/index.html, finds each
// user-visible string (scripts/i18nDetect.ts decides which), and:
//
//   - in TypeScript, replaces it with `t('file.slug', { …params })` — the same
//     English value, so behaviour is unchanged in `en`;
//   - in index.html, tags the element `data-i18n="key"` (text) or
//     `data-i18n-<attr>="key"` (title, placeholder, aria-label, alt), wrapping
//     a bare text node beside other markup in a <span data-i18n>;
//   - writes renderer/i18n/en.json: every key still referenced, plus the new ones;
//   - syncs the drafts (es.json, …): a new key arrives as `null` (shown in
//     English, on purpose, until someone translates it), a dead key goes.
//
// RE-RUNNABLE BY DESIGN. Already-translated calls are skipped, so after a
// rebase the answer to a conflicted renderer file is: take develop's version
// and run this again — it extracts exactly what is new, keeps every existing
// key, and drops keys nothing references any more.
//
// A local variable named `t` would shadow the global `t()`. Wherever a
// rewritten string lands inside such a binding's scope, the binding is renamed
// (first free of tv/tk/tt/t_), so `const t = TR_TYPE[x]` can sit beside a
// `t('…')` call. tsc and lint check the result.

import { lex, cook } from './i18nLex';
import type { Tok } from './i18nLex';
import { detect, collectDataValues } from './i18nDetect';
import type { Site, Piece } from './i18nDetect';

const fs: typeof import('fs') = require('fs');
const path: typeof import('path') = require('path');

const ROOT = path.resolve(__dirname, '..');
const HUB = path.join(ROOT, 'renderer', 'hub');
const OUT = path.join(ROOT, 'renderer', 'i18n', 'en.json');

/** Files that never call t(): the binder itself, and pure UMD modules node tests require. */
export function rendererFiles(): string[] {
  return fs.readdirSync(HUB)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.d.ts') && f !== 'i18n.ts')
    .filter((f) => !/typeof module !== 'undefined'|typeof exports !== 'undefined'/.test(fs.readFileSync(path.join(HUB, f), 'utf8')))
    .sort();
}

// ── ICU text ────────────────────────────────────────────────────────────

export function icuEscape(s: string, inPlural = false): string {
  return s.replace(inPlural ? /[{}#]/g : /[{}]/g, (c) => `'${c}'`);
}

function slugWords(text: string): string {
  const w = text.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/\{[^}]*\}/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean);
  let s = '';
  for (const x of w) { if ((s + '_' + x).length > 40 || s.split('_').length >= 6) break; s = s ? s + '_' + x : x; }
  return s || 'text';
}

function paramName(expr: string, used: Map<string, string>, k: number): string {
  const e = expr.replace(/\s+/g, '');
  if (used.has(e)) return used.get(e) as string;
  let name = '';
  const mem = /^[\w$]+(?:(?:\?\.|\.|!\.)[\w$]+)*!?$/.test(e) ? e.replace(/!/g, '').split(/\?\.|\./) : null;
  if (mem) {
    name = mem[mem.length - 1];
    if (name === 'length' && mem.length > 1) name = mem[mem.length - 2] + 'Count';
  } else {
    const call = /^[\w$.]+\(([\w$.]+)\)$/.exec(e);
    if (call) { const parts = call[1].split('.'); name = parts[parts.length - 1]; if (name === 'length' && parts.length > 1) name = parts[parts.length - 2] + 'Count'; }
  }
  name = name.replace(/[^A-Za-z0-9_]/g, '');
  if (!/^[A-Za-z_]/.test(name) || name === 'length') name = 'p' + k;
  const taken = new Set(used.values());
  let n = name;
  for (let i = 2; taken.has(n); i++) n = name + i;
  used.set(e, n);
  return n;
}

export interface Built {
  message: string;
  /** `bool`: a select's condition, passed as a real boolean so 'true' picks its arm. */
  params: { name: string; src: [number, number]; bool?: boolean }[];
}

/** A site's ICU message and the parameter expressions it needs. */
export function buildMessage(site: Site, src: string): Built {
  const used = new Map<string, string>();
  const params: { name: string; src: [number, number]; bool?: boolean }[] = [];
  const pieces: Piece[] = site.pieces.map((p) => ({ ...p }));
  let out = '';
  let k = 0;
  for (let i = 0; i < pieces.length; i++) {
    const p = pieces[i];
    if ('text' in p) { out += icuEscape(p.text); continue; }
    const isSel = 'select' in p;
    const name = paramName((isSel ? '!!' : '') + src.slice(p.src[0], p.src[1]), used, k++);
    if (!params.some((x) => x.name === name)) params.push({ name, src: p.src, bool: isSel });
    if ('param' in p) { out += `{${name}}`; continue; }
    if ('select' in p) {
      out += `{${name}, select, true {${icuEscape(p.yes, true)}} other {${icuEscape(p.no, true)}}}`;
      continue;
    }
    let one = p.one;
    let other = p.other;
    // `item${n === 1 ? '' : 's'}`: carry the word into both branches.
    const word = /(\p{L}+)$/u.exec(out);
    if (word && (one === '' || /^\p{Ll}/u.test(one)) && !/^\s/.test(other)) {
      out = out.slice(0, -word[1].length);
      one = word[1] + one;
      other = word[1] + other;
    }
    out += `{${name}, plural, one {${icuEscape(one, true)}} other {${icuEscape(other, true)}}}`;
  }
  return { message: out, params };
}

// ── rewriting TypeScript ────────────────────────────────────────────────

interface Edit { site: Site; key: string; built: Built; kids: Edit[] }

function nest(edits: Edit[]): Edit[] {
  const roots: Edit[] = [];
  const stack: Edit[] = [];
  for (const e of edits) {
    while (stack.length && stack[stack.length - 1].site.end <= e.site.start) stack.pop();
    if (stack.length) stack[stack.length - 1].kids.push(e); else roots.push(e);
    stack.push(e);
  }
  return roots;
}

function render(src: string, start: number, end: number, edits: Edit[]): string {
  let out = '';
  let at = start;
  for (const e of edits) {
    if (e.site.start < start || e.site.end > end) continue;
    out += src.slice(at, e.site.start) + call(src, e);
    at = e.site.end;
  }
  return out + src.slice(at, end);
}

function call(src: string, e: Edit): string {
  const q = `'${e.key}'`;
  if (!e.built.params.length) return `t(${q})`;
  const args = e.built.params.map((p) => {
    const raw = render(src, p.src[0], p.src[1], e.kids).trim();
    const v = p.bool ? `!!(${raw})` : raw;
    return v === p.name ? p.name : `${p.name}: ${v}`;
  });
  return `t(${q}, { ${args.join(', ')} })`;
}

// ── shadowed `t` ────────────────────────────────────────────────────────

function brackets(toks: Tok[]): Int32Array {
  const m = new Int32Array(toks.length).fill(-1);
  const st: number[] = [];
  toks.forEach((t, i) => {
    if (t.type !== 'punct') return;
    if ('([{'.includes(t.value) && t.value.length === 1) st.push(i);
    else if (')]}'.includes(t.value) && t.value.length === 1) { const o = st.pop(); if (o !== undefined) { m[o] = i; m[i] = o; } }
  });
  return m;
}

/** Scopes [start, end, bindingAt) of every local binding named `t` in this source. */
export function tBindingScopes(src: string): [number, number, number][] {
  const toks = lex(src).toks;
  const m = brackets(toks);
  const P = (i: number, ...v: string[]): boolean => !!toks[i] && toks[i].type === 'punct' && v.includes(toks[i].value);
  const I = (i: number, v?: string): boolean => !!toks[i] && toks[i].type === 'ident' && (!v || toks[i].value === v);
  const enclosingOpen = (i: number, ch: string): number => {
    let d = 0;
    for (let k = i - 1; k >= 0; k--) {
      if (P(k, ')', ']', '}')) d++;
      else if (P(k, '(', '[', '{')) { if (d === 0 && toks[k].value === ch) return k; if (d > 0) d--; }
    }
    return -1;
  };
  const enclosingAny = (i: number): number => {
    let d = 0;
    for (let k = i - 1; k >= 0; k--) {
      if (P(k, ')', ']', '}')) d++;
      else if (P(k, '(', '[', '{')) { if (d === 0) return k; d--; }
    }
    return -1;
  };
  const exprEnd = (k: number): number => { // end of an arrow's expression body starting at k
    for (let j = k; j < toks.length; j++) {
      if (P(j, '(', '[', '{')) { j = m[j]; continue; }
      if (P(j, ',', ')', ']', '}', ';')) return toks[j].start;
    }
    return src.length;
  };
  const bodyAfter = (close: number): [number, number] | null => { // after a param list's `)`
    let j = close + 1;
    if (P(j, ':')) { // return type: skip to `=>` or `{`
      let d = 0;
      for (; j < toks.length; j++) {
        if (P(j, '(', '[', '<')) d++; else if (P(j, ')', ']', '>')) d--;
        else if (d <= 0 && (P(j, '=>') || P(j, '{'))) break;
      }
    }
    if (P(j, '=>')) return P(j + 1, '{') ? [toks[j + 1].start, toks[m[j + 1]].end] : [toks[j + 1].start, exprEnd(j + 1)];
    if (P(j, '{') && m[j] > j) return [toks[j].start, toks[m[j]].end];
    return null;
  };
  const scopes: [number, number, number][] = [];
  const push = (a: number, b: number, at: number): void => { scopes.push([a, b, at]); };
  for (let i = 0; i < toks.length; i++) {
    if (!I(i, 't') || P(i - 1, '.', '?.')) continue;
    // `const t`, or `t` inside a destructuring pattern `const [a, t]` / `const { t }`
    let decl = -1;
    if (I(i - 1, 'const') || I(i - 1, 'let') || I(i - 1, 'var')) decl = i - 1;
    else if (P(i - 1, '[', ',', '{') && P(i + 1, ']', ',', '}')) {
      const g = enclosingAny(i);
      if (g > 0 && P(g, '[', '{') && (I(g - 1, 'const') || I(g - 1, 'let') || I(g - 1, 'var'))) decl = g - 1;
    }
    if (decl >= 0) {
      const paren = enclosingAny(decl + 1);
      if (paren >= 0 && P(paren, '(') && I(paren - 1, 'for')) {
        const close = m[paren];
        const body = P(close + 1, '{') ? toks[m[close + 1]].end : exprEnd(close + 1);
        push(toks[paren].start, body, toks[i].start);
      } else {
        const b = enclosingOpen(decl + 1, '{');
        if (b >= 0) push(toks[b].start, toks[m[b]].end, toks[i].start); else push(0, src.length, toks[i].start);
      }
      continue;
    }
    if (P(i + 1, '=>') && !P(i - 1, ')')) { // t => …
      push(toks[i].start, P(i + 2, '{') ? toks[m[i + 2]].end : exprEnd(i + 2), toks[i].start);
      continue;
    }
    if (P(i - 1, '(', ',') && P(i + 1, ',', ')', ':', '=', '?')) {
      const open = enclosingAny(i);
      if (open < 0 || !P(open, '(')) continue;
      if (I(open - 1, 'catch')) { const body = bodyAfter(m[open]); if (body) push(toks[open].start, body[1], toks[i].start); continue; }
      if (I(open - 1) && ['if', 'while', 'switch', 'for', 'return', 'typeof'].includes(toks[open - 1].value)) continue;
      // `f(t)` is a call, not a parameter list — unless it is `function f(t)`, or a
      // method `f(t) {` / `f(t): T {` (never after `?`, where it is a ternary arm).
      if ((I(open - 1) && toks[open - 1].value !== 'async') || P(open - 1, ')', ']')) {
        const declared = I(open - 2, 'function') || (P(m[open] + 1, '{') && !P(open - 2, '?', '.', '?.'))
          || (P(m[open] + 1, ':') && P(open - 2, '{', ',', ';', '}') );
        if (!declared) continue;
      }
      const body = bodyAfter(m[open]);
      if (body) push(toks[open].start, body[1], toks[i].start);
    }
  }
  return scopes;
}

/** Rename `t` inside each scope that also holds an inserted `t(` call. */
export function unshadow(src: string, callAt: number[]): string {
  const scopes = tBindingScopes(src).filter(([a, b]) => callAt.some((c) => c >= a && c < b));
  if (!scopes.length) return src;
  const all: Tok[] = [];
  const flat = (toks: Tok[]): void => { for (const t of toks) { all.push(t); if (t.type === 'tpl') for (const e of t.exprs || []) flat(e.toks); } };
  flat(lex(src).toks);
  all.sort((a, b) => a.start - b.start);
  const repl = new Map<number, string>();
  for (const [a, b, at] of scopes) {
    const names = new Set(all.filter((t) => t.type === 'ident' && t.start >= a && t.end <= b).map((t) => t.value));
    const nn = ['tv', 'tk', 'tt', 't_'].find((x) => !names.has(x)) || 't__';
    for (let i = 0; i < all.length; i++) {
      const t = all[i];
      if (t.start < a || t.end > b || t.type !== 'ident' || t.value !== 't') continue;
      const p = all[i - 1];
      const n = all[i + 1];
      if (p && p.type === 'punct' && (p.value === '.' || p.value === '?.')) continue;
      if (n && n.type === 'punct' && n.value === '(' && callAt.includes(t.start)) continue; // our own call
      if (t.start === at) { // the binding itself; in `{ t }` it keeps its property name
        const inObj = p && p.type === 'punct' && (p.value === '{' || p.value === ',') && insideBrace(all, i) && n && n.type === 'punct' && (n.value === '}' || n.value === ',');
        repl.set(t.start, inObj ? `t: ${nn}` : nn);
        continue;
      }
      const isKey = n && n.type === 'punct' && n.value === ':' && p && p.type === 'punct' && (p.value === '{' || p.value === ',');
      if (isKey) continue;
      const shorthand = p && p.type === 'punct' && (p.value === '{' || p.value === ',') && n && n.type === 'punct' && (n.value === '}' || (n.value === ',' && insideBrace(all, i)));
      repl.set(t.start, shorthand ? `t: ${nn}` : nn);
    }
  }
  let out = '';
  let at = 0;
  for (const s of [...repl.keys()].sort((x, y) => x - y)) { out += src.slice(at, s) + repl.get(s); at = s + 1; }
  return out + src.slice(at);
}

function insideBrace(all: Tok[], i: number): boolean {
  let d = 0;
  for (let k = i - 1; k >= 0; k--) {
    const v = all[k].type === 'punct' ? all[k].value : '';
    if (v === ')' || v === ']' || v === '}') d++;
    else if (v === '(' || v === '[' || v === '{') { if (d === 0) return v === '{'; d--; }
  }
  return false;
}

// ── index.html ──────────────────────────────────────────────────────────

const HTML_ATTRS = ['title', 'placeholder', 'aria-label', 'alt'];
const HTML_SKIP_TAGS = new Set(['script', 'style', 'svg', 'path', 'code', 'pre', 'kbd']);

function htmlDecode(s: string): string {
  return s.replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, '\'').replace(/&#(\d+);/g, (_m, d: string) => String.fromCodePoint(+d))
    .replace(/&#x([0-9a-f]+);/gi, (_m, h: string) => String.fromCodePoint(parseInt(h, 16))).replace(/&amp;/g, '&');
}

/**
 * Tag index.html. A text node is the element's whole content → `data-i18n` on
 * the element; text beside other children → wrapped in `<span data-i18n>`.
 */
export function tagHtml(html: string, keyFor: (text: string, attr: string) => string): string {
  // Tokenize into tags and text, keeping a stack of open elements.
  // LOSSLESS: every character lands in exactly one node (`<!DOCTYPE …>` and a
  // stray `<` included) — checked below, because a regex that skips a character
  // drops it from the output, and a lost `<` of the doctype is quirks mode.
  const re = /<!--[\s\S]*?-->|<![^>]*>|<\/?([a-zA-Z][\w-]*)((?:\s+[^\s=>/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>|[^<]+|</g;
  type Node = { kind: 'open' | 'close' | 'text' | 'other'; raw: string; tag?: string; attrs?: string; self?: boolean };
  const nodes: Node[] = [];
  let mt: RegExpExecArray | null;
  while ((mt = re.exec(html))) {
    const raw = mt[0];
    if (raw.startsWith('<!') || raw === '<') nodes.push({ kind: 'other', raw });
    else if (raw.startsWith('</')) nodes.push({ kind: 'close', raw, tag: (mt[1] || '').toLowerCase() });
    else if (raw.startsWith('<')) nodes.push({ kind: 'open', raw, tag: (mt[1] || '').toLowerCase(), attrs: mt[2] || '', self: !!mt[3] || /^(br|hr|img|input|meta|link|source|wbr|col|area|base)$/i.test(mt[1] || '') });
    else nodes.push({ kind: 'text', raw });
  }
  if (nodes.map((n) => n.raw).join('') !== html) throw new Error('tagHtml: the tokenizer lost characters');
  const body = nodes.findIndex((n) => n.kind === 'open' && n.tag === 'body');
  const out: string[] = [];
  const stack: { i: number; tag: string; skip: boolean }[] = [];
  const childCount = new Map<number, number>(); // open index → element children
  // First pass: count element children and non-empty text children per open tag.
  const texts = new Map<number, number>();
  {
    const st: number[] = [];
    nodes.forEach((n, i) => {
      if (n.kind === 'open') { if (st.length) childCount.set(st[st.length - 1], (childCount.get(st[st.length - 1]) || 0) + 1); if (!n.self) st.push(i); }
      else if (n.kind === 'close') st.pop();
      else if (n.kind === 'text' && n.raw.trim() && st.length) texts.set(st[st.length - 1], (texts.get(st[st.length - 1]) || 0) + 1);
    });
  }
  const attrRewrite = (n: Node, i: number): string => {
    if (i < body || !n.attrs) return n.raw;
    let raw = n.raw;
    for (const a of HTML_ATTRS) {
      if (new RegExp(`\\sdata-i18n-${a}=`).test(raw)) continue;
      const am = new RegExp(`\\s${a}="([^"]*)"`).exec(raw);
      if (!am) continue;
      const v = htmlDecode(am[1]).trim();
      if (!/\p{L}{2}/u.test(v)) continue;
      raw = raw.replace(/(\s*\/?>)$/, ` data-i18n-${a}="${keyFor(v, a)}"$1`);
    }
    return raw;
  };
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    const top = stack[stack.length - 1];
    if (n.kind === 'open') {
      let raw = attrRewrite(n, i);
      const skip = (top && top.skip) || HTML_SKIP_TAGS.has(n.tag || '') || /\sdata-i18n-skip\b/.test(raw) || /\stranslate="no"/.test(raw);
      // whole-content text → tag the element itself
      if (i > body && !skip && !n.self && !childCount.get(i) && (texts.get(i) || 0) === 1 && !/\sdata-i18n=/.test(raw)) {
        const txt = nodes[i + 1];
        const v = txt && txt.kind === 'text' ? htmlDecode(txt.raw).replace(/\s+/g, ' ').trim() : '';
        if (v && /\p{L}{2}/u.test(v)) raw = raw.replace(/(\s*\/?>)$/, ` data-i18n="${keyFor(v, '')}"$1`);
      }
      out.push(raw);
      if (!n.self) stack.push({ i, tag: n.tag || '', skip });
      continue;
    }
    if (n.kind === 'close') { stack.pop(); out.push(n.raw); continue; }
    if (n.kind === 'text' && top && !top.skip && i > body && childCount.get(top.i)) {
      const v = htmlDecode(n.raw).replace(/\s+/g, ' ').trim();
      if (v && /\p{L}{2}/u.test(v)) {
        const lead = /^\s*/.exec(n.raw)![0];
        const trail = /\s*$/.exec(n.raw)![0];
        out.push(`${lead}<span data-i18n="${keyFor(v, '')}">${n.raw.trim()}</span>${trail}`);
        continue;
      }
    }
    out.push(n.raw);
  }
  return out.join('');
}

// ── main ────────────────────────────────────────────────────────────────

/** Every `t('key'…)` / `data-i18n*="key"` reference already in the tree. */
export function referencedKeys(srcs: string[]): Set<string> {
  const keys = new Set<string>();
  for (const s of srcs) {
    for (const mm of s.matchAll(/\bt\(\s*'([\w.-]+)'/g)) keys.add(mm[1]);
    for (const mm of s.matchAll(/data-i18n(?:-[\w-]+)?="([\w.-]+)"/g)) keys.add(mm[1]);
  }
  return keys;
}

/** Main-process files whose sentences go through the same catalog (src/app/i18n.ts). */
export const MAIN_FILES = [
  'src/analysis/captions.ts',
  'src/analysis/insights.ts',
  'src/analysis/alerts.ts',
  'src/analysis/reportSpec.ts',
];

const MAIN_IMPORT = "import { t } from '../app/i18n';";

function main(): void {
  const dry = process.argv.includes('--dry');
  const old: Record<string, string> = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : {};
  const units = [
    ...rendererFiles().map((f) => ({ file: path.join(HUB, f), base: f.replace(/\.ts$/, ''), main: false })),
    ...MAIN_FILES.map((f) => ({ file: path.join(ROOT, f), base: path.basename(f, '.ts'), main: true })),
  ];
  const srcs = new Map(units.map((u) => [u.file, fs.readFileSync(u.file, 'utf8')]));
  const dataValues = new Set<string>();
  for (const s of srcs.values()) collectDataValues(s, dataValues);

  // Keep every key still referenced (a rerun after rebase).
  const htmlPath = path.join(HUB, 'index.html');
  const html0 = fs.readFileSync(htmlPath, 'utf8');
  const cat: Record<string, string> = {};
  for (const k of referencedKeys([...srcs.values(), html0])) if (k in old) cat[k] = old[k];

  // Pass 1: every message and the files it appears in.
  const found = units.map((u) => {
    const src = srcs.get(u.file) as string;
    const sites = detect(src, { dataValues });
    return { u, src, sites, built: sites.map((site) => buildMessage(site, src)) };
  });
  const htmlTexts: string[] = [];
  tagHtml(html0, (text) => { htmlTexts.push(icuEscape(text)); return 'x'; });
  const users = new Map<string, Set<string>>(); // message → bases using it
  const use = (msg: string, base: string): void => { const s = users.get(msg) || new Set<string>(); s.add(base); users.set(msg, s); };
  for (const f of found) for (const b of f.built) use(b.message, f.u.base);
  for (const m of htmlTexts) use(m, 'html');

  // ONE key per distinct English message, app-wide: the same words must read the
  // same everywhere, and some code compares a label made in one file with one
  // made in another (`GROUPS.indexOf(cmd.group)`), which only holds if both
  // translate identically. A message used by one file is keyed under it; one
  // shared by several lives under `common.`.
  const byMsg = new Map<string, string>(); // message → key
  for (const [k, v] of Object.entries(cat)) if (!byMsg.has(v)) byMsg.set(v, k);
  const keyFor = (base: string, message: string): string => {
    const hit = byMsg.get(message);
    if (hit) return hit;
    const ns = (users.get(message) || new Set([base])).size > 1 ? 'common' : base;
    const slug = slugWords(message.replace(/\{[^{}]*(\{[^{}]*\}[^{}]*)*\}/g, ' '));
    let key = `${ns}.${slug}`;
    for (let i = 2; key in cat && cat[key] !== message; i++) key = `${ns}.${slug}_${i}`;
    cat[key] = message;
    byMsg.set(message, key);
    return key;
  };

  // Pass 2: rewrite.
  let total = 0;
  let renamed = 0;
  for (const f of found) {
    if (!f.sites.length) continue;
    const edits: Edit[] = f.sites.map((site, k) => ({ site, key: keyFor(f.u.base, f.built[k].message), built: f.built[k], kids: [] }));
    let next = render(f.src, 0, f.src.length, nest(edits));
    total += edits.length;
    if (f.u.main && !next.includes(MAIN_IMPORT)) {
      const lines = next.split('\n');
      let last = -1;
      lines.forEach((l, i) => { if (/^import .* from '.*';$/.test(l)) last = i; });
      lines.splice(last + 1, 0, MAIN_IMPORT);
      next = lines.join('\n');
    }
    // Where did our calls land in the new text? Re-find them by key.
    const at: number[] = [];
    for (const e of edits) { let p = -1; while ((p = next.indexOf(`t('${e.key}'`, p + 1)) >= 0) at.push(p); }
    const un = unshadow(next, at);
    if (un !== next) renamed++;
    next = un;
    if (!dry && next !== f.src) fs.writeFileSync(f.u.file, next);
  }

  const html = tagHtml(html0, (text) => keyFor('html', icuEscape(text)));
  if (!dry && html !== html0) fs.writeFileSync(htmlPath, html);

  const sorted: Record<string, string> = {};
  for (const k of Object.keys(cat).sort()) sorted[k] = cat[k];
  if (!dry) {
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify(sorted, null, 2) + '\n');
  }
  // Keep the drafts in step: a new key arrives as `null` ("deliberately English
  // for now" — test-i18n accepts it), a key nothing uses any more is dropped.
  // Meta entries (`_status`, …) stay first.
  let synced = 0;
  for (const f of fs.readdirSync(path.dirname(OUT)).filter((n) => /^[\w-]+\.json$/.test(n) && n !== 'en.json').sort()) {
    const p = path.join(path.dirname(OUT), f);
    let loc: Record<string, unknown>;
    try { loc = JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { continue; }
    const next: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(loc)) if (k.startsWith('_')) next[k] = v;
    for (const k of Object.keys(sorted)) {
      next[k] = k in loc && (typeof loc[k] === 'string' || loc[k] === null) ? loc[k] : null;
      if (!(k in loc)) synced += 1;
    }
    if (!dry) fs.writeFileSync(p, JSON.stringify(next, null, 2) + '\n');
  }
  const common = Object.keys(sorted).filter((k) => k.startsWith('common.')).length;
  console.log(`i18n-extract: ${total} strings rewritten, ${Object.keys(sorted).length} keys in en.json (${common} shared), `
    + `${renamed} files had a local \`t\` renamed, ${synced} new keys marked null in the drafts${dry ? ' (dry run)' : ''}`);
}

if (require.main === module) main();

export { cook };
