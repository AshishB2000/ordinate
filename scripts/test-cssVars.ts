// Every `var(--x)` in the stylesheets must resolve to something.
//
// WHY THIS EXISTS. `--surface-1` was used for the Quick-start tiles and the
// whole Discover panel on the start page. It is not a variable — theme.css
// defines --surface, --surface-2 and --surface-3, with no `-1`. CSS does not
// warn about an undefined custom property; it silently yields the initial
// value, so both panels rendered with NO background at all. That shipped, and
// it survived a diff review, CI, and two rounds of screenshots, because a
// transparent panel on a light page looks almost exactly like a white one.
//
// Nothing else in this repo can catch it. There is no stylesheet linter, and
// `npm run smoke` fails on console errors — of which an undefined custom
// property produces none.
//
// Two things make this a real check rather than a grep that cries wolf:
//
//   1. `var(--x, fallback)` is LEGITIMATE even when --x is undefined; that is
//      what the fallback is for. Those are counted, not failed.
//   2. Some custom properties are set from JS at runtime (element.style
//      .setProperty('--splash-fill', …)) and correctly appear in no
//      stylesheet. Those are DISCOVERED by scanning the renderer sources, not
//      hardcoded — so adding one does not mean editing this file.

export {}; // module scope — sibling test scripts share top-level names
import { ok, failureCount } from './selfcheck';

const fs: typeof import('fs') = require('fs');
const path: typeof import('path') = require('path');

const REPO = path.resolve(__dirname, '..');
const CSS_FILES = [
  'renderer/theme.css',
  'renderer/hub/hub.css',
  'renderer/overlay/overlay.css',
];


// Strip comments so a commented-out rule cannot register a definition or a use.
function decomment(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

// Every `--name:` declaration, wherever it sits — :root, [data-theme], a media
// query, or a plain selector. A definition anywhere counts, because this checks
// resolvability, not scope. (A var defined only under [data-theme="dark"] and
// used in light is a different bug, and not one this can see.)
function definitionsIn(css: string): Set<string> {
  const out = new Set<string>();
  const re = /(^|[;{\s])(--[A-Za-z0-9_-]+)\s*:/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(css))) out.add(m[2]);
  return out;
}

// Every `var(--name` use, with a flag for whether a fallback follows.
function usesIn(css: string): { name: string; hasFallback: boolean }[] {
  const out: { name: string; hasFallback: boolean }[] = [];
  const re = /var\(\s*(--[A-Za-z0-9_-]+)\s*([,)])/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(css))) out.push({ name: m[1], hasFallback: m[2] === ',' });
  return out;
}

// Custom properties assigned from JS. Discovered, not listed: a hardcoded
// allowlist rots the moment someone adds another one.
function jsSetProperties(dir: string, found: Set<string>): Set<string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) { jsSetProperties(p, found); continue; }
    if (!/\.ts$/.test(entry.name)) continue; // .js siblings are emitted copies
    const src = fs.readFileSync(p, 'utf8');
    const re = /setProperty\(\s*['"](--[A-Za-z0-9_-]+)['"]/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) found.add(m[1]);
  }
  return found;
}

// ── collect ──────────────────────────────────────────────────────────────────
const defined = new Set<string>();
const uses: { name: string; hasFallback: boolean; file: string }[] = [];

for (const rel of CSS_FILES) {
  const full = path.join(REPO, rel);
  ok(`${rel} exists`, fs.existsSync(full));
  if (!fs.existsSync(full)) continue;
  const css = decomment(fs.readFileSync(full, 'utf8'));
  definitionsIn(css).forEach((d) => defined.add(d));
  usesIn(css).forEach((u) => uses.push({ ...u, file: rel }));
}

const fromJs = jsSetProperties(path.join(REPO, 'renderer'), new Set<string>());

ok('found variable definitions', defined.size > 0, `${defined.size} defined`);
ok('found variable uses', uses.length > 0, `${uses.length} uses`);
ok('found the JS-assigned custom properties', fromJs.size > 0,
   Array.from(fromJs).sort().join(', '));

// ── the check ────────────────────────────────────────────────────────────────
const missing = uses.filter(
  (u) => !defined.has(u.name) && !u.hasFallback && !fromJs.has(u.name),
);

// De-duplicate for the report: one line per variable, with where it is used.
const byName = new Map<string, Set<string>>();
missing.forEach((u) => {
  if (!byName.has(u.name)) byName.set(u.name, new Set());
  byName.get(u.name)!.add(u.file);
});

ok('every var() resolves to a definition, a fallback, or a JS assignment',
   byName.size === 0,
   byName.size
     ? Array.from(byName.entries())
         .map(([n, files]) => `${n} (${Array.from(files).join(', ')})`)
         .join('; ')
     : `${uses.length} uses checked`);

// The specific name that caused this: theme.css has --surface, not --surface-1.
// Pinned by name so the regression is impossible to reintroduce quietly.
ok('--surface-1 is still not a thing (use --surface)', !defined.has('--surface-1'));
ok('--surface IS defined', defined.has('--surface'));

// A fallback-bearing use is fine, but knowing the count keeps it honest: if this
// climbs, the palette is being worked around rather than extended.
const withFallback = uses.filter((u) => u.hasFallback && !defined.has(u.name));
console.log(`     (${withFallback.length} use(s) rely on a var() fallback for an undefined name`
  + (withFallback.length ? ': ' + Array.from(new Set(withFallback.map((u) => u.name))).join(', ') : '')
  + ')');

console.log('');
if (failureCount()) {
  console.error(`${failureCount()} CSS variable check(s) FAILED.`);
  process.exit(1);
}
console.log('All CSS variable checks passed.');
