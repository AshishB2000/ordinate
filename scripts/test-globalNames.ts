// No two hub scripts may claim the same `window` global.
//
// The hub is classic <script>s sharing one global scope. TypeScript catches two
// FUNCTION DECLARATIONS with one name (a duplicate implementation), but not two
// UMD-style scripts each doing `global.mdParse = …` inside their own IIFE — the
// later <script> silently wins at runtime. That is exactly what broke stories
// after two branches merged: storyText.js and markdown.js both set
// `window.mdParse`, with different token shapes, and every story block rendered
// nothing. `declare function` lines merge as overloads, so the type check was
// green too; only a smoke saw it.
//
// This scans every hub script for `global.X =` / `window.X =` statements and
// fails when one name is assigned by two different files.
//
//   npm run build:ts && node scripts/test-globalNames.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import * as fs from 'fs';
import * as path from 'path';

const dir = path.join(__dirname, '..', 'renderer', 'hub');
const owners = new Map<string, Set<string>>();
for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.ts') && !n.endsWith('.d.ts'))) {
  const src = fs.readFileSync(path.join(dir, f), 'utf8');
  for (const m of src.matchAll(/^\s*(?:global|window)\.([A-Za-z_$][\w$]*)\s*=(?!=)/gm)) {
    const set = owners.get(m[1]) || new Set<string>();
    set.add(f);
    owners.set(m[1], set);
  }
}
const clashes = [...owners].filter(([, files]) => files.size > 1).map(([name, files]) => `${name}: ${[...files].join(', ')}`);
ok('the scan found the UMD globals it exists to watch (mdParse, stMdParse, normalizeName)',
  owners.has('mdParse') && owners.has('stMdParse') && owners.has('normalizeName'));
ok('no window global is assigned by two hub scripts', clashes.length === 0, clashes.join(' | '));
finish();
