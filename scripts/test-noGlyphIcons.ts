'use strict';

// No Unicode glyph is ever used as an icon. A ratchet, like test-file-size.
//
// WHY THIS EXISTS. The hub shipped ~120 icons that were not icons: 🗑 ✕ ⋯ ✨ ✎
// ★ ▾ › set as a control's textContent. A glyph is the cheapest possible way to
// put a mark in a button and it is wrong in five separate ways at once:
//
//   1. It renders in whatever the font decides. The same ✕ is a different
//      weight, width and vertical position on macOS and Windows, and a
//      different one again in the emoji font that claims 🗑.
//   2. It ignores stroke weight, so it never matches a real icon beside it.
//   3. It sits on the TEXT baseline, not the optical centre of the button,
//      which is why glyph buttons always look a pixel or two low.
//   4. Colour-emoji glyphs (🗑) ignore `color` entirely — the icon stays
//      brown when the button text goes white.
//   5. A screen reader reads it by its Unicode name. 🗑 announces as
//      "wastebasket"; ⋯ announces as "midline horizontal ellipsis".
//
// Every one of those is invisible in a diff and obvious on screen, which is
// exactly the class of defect a check should carry rather than a reviewer.
//
// THE RULE IS SIMPLE ON PURPOSE. The banned characters are flagged anywhere in
// non-comment renderer source, not just inside a <button>. Deciding "is this
// one inside a control?" needs a parser and gets it wrong at the edges; none of
// these characters has any legitimate non-icon use in this codebase, so their
// mere presence in live source is the defect. Prose ABOUT an icon is fine — the
// comment stripper below exists for the many `// the ⋯ menu` remarks.
//
//   npm run build:ts && node scripts/test-noGlyphIcons.js

import * as fs from 'fs';
import * as path from 'path';

import { ok, failureCount } from './selfcheck';

const REPO = path.resolve(__dirname, '..');

/**
 * The banned set.
 *
 * NOT banned, deliberately:
 *   ⌘ ⇧ ⌥ ⌃  — modifier-key symbols. `hubHotkey.ts` maps an accelerator to
 *              these for a shortcut hint; that IS how macOS renders the key,
 *              and no icon replaces it.
 *   × → ✓ ✗  — each has a real prose or data use (a "1920 × 1080" dimension,
 *              an arrow inside body copy), so banning them outright would fail
 *              on text that is perfectly correct.
 */
const BANNED = [
  '🗑', '✕', '✨', '⋯', '✎', '★', '☆',
  '◀', '▶', '▲', '▼', '▾', '▸', '⚙',
  '›', '‹', '↻', '＋',
];

/** What each one used to mean, so a failure tells you what to reach for. */
const SUGGEST: Record<string, string> = {
  '🗑': "icon('trash')",
  '✕': "icon('x')",
  '✨': "icon('sparkles')",
  '⋯': "icon('more-horizontal')",
  '✎': "icon('pencil')",
  '★': "icon('star-filled')",
  '☆': "icon('star')",
  '◀': "icon('chevron-left')",
  '▶': "icon('chevron-right')",
  '▲': "icon('chevron-up')",
  '▼': "icon('chevron-down')",
  '▾': "icon('chevron-down')",
  '▸': "icon('chevron-right')",
  '⚙': "icon('settings')",
  '›': "icon('chevron-right')",
  '‹': "icon('chevron-left')",
  '↻': "icon('refresh')",
  '＋': "icon('plus')",
};

interface Hit {
  file: string;
  line: number;
  glyph: string;
  text: string;
}

/**
 * Strip comments. Block comments — the C form in TypeScript, the SGML form in
 * HTML — are removed across lines; `//` line comments are removed wherever
 * they appear, including after code.
 *
 * The one thing a naive stripper gets wrong is `//` inside a string literal:
 * cut at the first `//` and `'https://x'` becomes `'https:`, which silently
 * hides any glyph later on the line. So the TypeScript path tracks quote
 * state (single, double, backtick, with escapes) and only cuts at a `//` that
 * is genuinely outside a string.
 *
 * Known limit: a `//` inside a REGEX literal would also cut. There is no such
 * line in this repo — `//` in a regex is almost always written `\/\/` — and
 * the alternative is a full lexer to protect a case that does not occur.
 * A false positive here is loud and trivially fixable, never silent.
 */
/** Everything from an out-of-string `//` to end of line, removed. */
function cutLineComment(line: string): string {
  let quote = '';
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === '\\') { i++; continue; }
      if (c === quote) quote = '';
      continue;
    }
    if (c === "'" || c === '"' || c === '`') { quote = c; continue; }
    if (c === '/' && line[i + 1] === '/') return line.slice(0, i);
  }
  return line;
}

function stripComments(src: string, html: boolean): string[] {
  const OPEN = html ? '<!--' : '/*';
  const CLOSE = html ? '-->' : '*/';
  const out: string[] = [];
  let inBlock = false;
  for (const raw of src.split('\n')) {
    let line = raw;
    if (inBlock) {
      const close = line.indexOf(CLOSE);
      if (close === -1) { out.push(''); continue; }
      const end = close + CLOSE.length;
      line = ' '.repeat(end) + line.slice(end);
      inBlock = false;
    }
    // Opening a block comment; keep anything before it on this line.
    for (;;) {
      const open = line.indexOf(OPEN);
      if (open === -1) break;
      const close = line.indexOf(CLOSE, open + OPEN.length);
      if (close === -1) { line = line.slice(0, open); inBlock = true; break; }
      const end = close + CLOSE.length;
      line = line.slice(0, open) + ' '.repeat(end - open) + line.slice(end);
    }
    if (!html) {
      // A continuation line of a JSDoc block (the opener was consumed above
      // only when the block closes on the same line).
      if (line.trimStart().startsWith('*')) line = '';
      else line = cutLineComment(line);
    }
    out.push(line);
  }
  return out;
}

function scan(rel: string, html: boolean, hits: Hit[]): void {
  const abs = path.join(REPO, rel);
  if (!fs.existsSync(abs)) return;
  const lines = stripComments(fs.readFileSync(abs, 'utf8'), html);
  lines.forEach((line, i) => {
    for (const g of BANNED) {
      if (line.includes(g)) hits.push({ file: rel, line: i + 1, glyph: g, text: line.trim() });
    }
  });
}

// Sources only. The sibling .js is tsc output of the .ts beside it and would
// double-report every hit at a shifted line number.
const targets: string[] = ['renderer/hub/index.html', 'renderer/overlay/index.html'];
for (const dir of ['renderer/hub', 'renderer/overlay']) {
  const abs = path.join(REPO, dir);
  if (!fs.existsSync(abs)) continue;
  for (const name of fs.readdirSync(abs).sort()) {
    if (name.endsWith('.ts') && !name.endsWith('.d.ts')) targets.push(dir + '/' + name);
  }
}

ok(`scanned ${targets.length} renderer sources`, targets.length > 20);

const hits: Hit[] = [];
for (const t of targets) scan(t, t.endsWith('.html'), hits);

ok('no Unicode glyph is used as an icon', hits.length === 0);
for (const h of hits) {
  const fix = SUGGEST[h.glyph] || 'the icon sprite';
  console.error(`     ${h.file}:${h.line}  "${h.glyph}"  → use ${fix}`);
  console.error(`       ${h.text.slice(0, 110)}`);
}
if (hits.length) {
  console.error('     Icons live in renderer/hub/icons.ts. In TypeScript use');
  console.error("     icon()/iconLabel()/iconOnly()/setIcon(); in static HTML use");
  console.error('     <svg class="ic" …><use href="#i-NAME"/></svg>.');
}

// ── Every icon NAME referenced actually exists ──────────────────────────────
// A typo'd name renders nothing, which on screen is indistinguishable from
// "we forgot an icon here" — the exact failure the sprite was meant to end.
// icons.ts warns at runtime; this catches it before the app ever runs.
const iconsSrc = fs.readFileSync(path.join(REPO, 'renderer/hub/icons.ts'), 'utf8');
const body = iconsSrc.slice(
  iconsSrc.indexOf('const ICONS'),
  iconsSrc.indexOf('let icSpriteEl'),
);
const known = new Set<string>();
for (const m of body.matchAll(/^\s{2}'?([a-z0-9-]+)'?:/gm)) known.add(m[1]);

ok(`icons.ts defines a sprite of ${known.size} icons`, known.size >= 40, known.size);

const used = new Map<string, string>(); // name -> first file it appears in
for (const t of targets) {
  if (t === 'renderer/hub/icons.ts') continue;
  const src = fs.readFileSync(path.join(REPO, t), 'utf8');
  // icon('x') / iconHTML('x') / setIcon(el, 'x') / iconLabel(el, 'x', …)
  for (const m of src.matchAll(/\b(?:icon|iconHTML)\(\s*'([a-z0-9-]+)'/g)) {
    if (!used.has(m[1])) used.set(m[1], t);
  }
  for (const m of src.matchAll(/\b(?:setIcon|iconLabel|iconOnly)\([^,]+,\s*'([a-z0-9-]+)'/g)) {
    if (!used.has(m[1])) used.set(m[1], t);
  }
  // The static-HTML form.
  for (const m of src.matchAll(/href="#i-([a-z0-9-]+)"/g)) {
    if (!used.has(m[1])) used.set(m[1], t);
  }
}

const unknown = [...used.entries()].filter(([name]) => !known.has(name));
ok('every referenced icon name exists in the sprite', unknown.length === 0);
for (const [name, file] of unknown) {
  console.error(`     ${file}: icon "${name}" is not defined in renderer/hub/icons.ts`);
}

// Not a failure — an icon nobody uses is dead weight, but a sprite is allowed
// a little headroom for the surfaces still being built.
const unused = [...known].filter((n) => !used.has(n));
if (unused.length) console.log(`     (${unused.length} sprite icon(s) unused: ${unused.join(', ')})`);

console.log('');
console.log(`     ${used.size} distinct icon(s) referenced across ${targets.length} sources.`);
console.log('');
if (failureCount()) {
  console.error(`${failureCount()} glyph-icon check(s) FAILED.`);
  process.exit(1);
}
console.log('All glyph-icon checks passed.');
