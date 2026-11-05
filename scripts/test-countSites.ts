// A ratchet over every place that compares an aggregation with `count` (semantic layer part 5, step 02). `countd` is a
// count too in some of them (FX never converts it, it needs no number column, a value driver does not move it): those
// are `isCountLike(agg)`. The rest mean `count` alone and are classified in COUNT_SITES (scripts/countSites.ts), so a
// new `=== 'count'` cannot silently leave a distinct count converted as money or refused as "not a number column".
//
// Same rule as scripts/test-termSites.ts: a file with a match and no entry fails, and so does a count that differs
// from its entry in either direction. CLASSIFY the site (isCountLike, or count alone), then change the entry.
//
//   npm run build:ts && node scripts/test-countSites.js

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { ok, finish } from './selfcheck';
import { COUNT_SITES } from './countSites';

const REPO = path.resolve(__dirname, '..');
const ROOTS = ['src', 'web/src'];
const PATTERNS: readonly RegExp[] = [/[!=]==\s*['"]count['"]/g, /case\s+['"]count['"]\s*:/g];

// Sources only: no emitted .js, declaration files, tests, goldens or prototypes.
const SKIP_DIRS = new Set(['node_modules', 'dist', '__golden__', 'prototype']);
const isSource = (name: string): boolean => /\.tsx?$/.test(name) && !/\.d\.ts$/.test(name) && !/\.test\.tsx?$/.test(name);

/** Repo-relative path → match count, for every source file under `root`'s src/ and web/src that has one. */
function scan(root: string): Map<string, number> {
  const found = new Map<string, number>();
  const walk = (abs: string): void => {
    for (const e of fs.readdirSync(abs, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const p = path.join(abs, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(p);
      } else if (isSource(e.name)) {
        const text = fs.readFileSync(p, 'utf8');
        const n = PATTERNS.reduce((sum, re) => sum + (text.match(re)?.length ?? 0), 0);
        if (n) found.set(path.relative(root, p).split(path.sep).join('/'), n);
      }
    }
  };
  for (const r of ROOTS) if (fs.existsSync(path.join(root, r))) walk(path.join(root, r));
  return found;
}

/** One row per file that either has a match or has an entry; the failing ones differ. */
function rows(found: Map<string, number>): { file: string; n: number; classified: number | undefined }[] {
  const files = new Set([...found.keys(), ...Object.keys(COUNT_SITES)]);
  return [...files].sort().map((file) => ({ file, n: found.get(file) ?? 0, classified: COUNT_SITES[file]?.count }));
}
const mismatches = (found: Map<string, number>) => rows(found).filter((r) => r.n !== r.classified);

// § the repo: every site is classified, and nothing classified has gone
const found = scan(REPO);
ok(`scanned ${found.size} files with a site`, found.size > 20);
const failing = new Set(mismatches(found).map((r) => r.file));
for (const r of rows(found)) ok(`${r.file}: ${r.n} site(s), classified ${r.classified}`, !failing.has(r.file));

// § negative control: the same scan over a temp tree that mirrors the table, then one planted site
const tree = fs.mkdtempSync(path.join(os.tmpdir(), 'count-sites-'));
const put = (file: string, text: string): void => {
  fs.mkdirSync(path.dirname(path.join(tree, file)), { recursive: true });
  fs.writeFileSync(path.join(tree, file), text);
};
const site = "if (a === 'count') x();\n";
try {
  for (const [file, e] of Object.entries(COUNT_SITES)) put(file, site.repeat(e.count));
  ok('control: a tree that matches the table has no mismatch', mismatches(scan(tree)).length === 0);
  for (const f of ['src/probe.test.ts', 'src/prototype/probe.ts', 'src/probe.js', 'src/probe.d.ts', 'web/src/__golden__/probe.ts']) put(f, site);
  ok('control: tests, .js, .d.ts, goldens and prototypes are not scanned', mismatches(scan(tree)).length === 0);
  put('src/__countProbe.ts', site);
  const fresh = mismatches(scan(tree));
  ok('NEGATIVE CONTROL: a new unclassified `=== \'count\'` fails the scan', fresh.length === 1 && fresh[0].file === 'src/__countProbe.ts' && fresh[0].classified === undefined);
  put('src/__countProbe.ts', "switch (agg) {\n  case 'count':\n    break;\n}\n");
  const dispatch = mismatches(scan(tree));
  ok('NEGATIVE CONTROL: a new `case \'count\':` fails the scan', dispatch.length === 1 && dispatch[0].n === 1);
  put('src/__countProbe.ts', "const ok = isCountLike(a) || a === 'countd';\n");
  ok('control: isCountLike and a countd comparison are not sites', mismatches(scan(tree)).length === 0 || mismatches(scan(tree)).every((m) => m.file !== 'src/__countProbe.ts'));
  fs.rmSync(path.join(tree, 'src/__countProbe.ts'));
  const [grown, shrunk] = Object.keys(COUNT_SITES);
  if (grown && shrunk) {
    fs.appendFileSync(path.join(tree, grown), site);
    fs.rmSync(path.join(tree, shrunk));
    const moved = mismatches(scan(tree)).map((m) => m.file).sort();
    ok('NEGATIVE CONTROL: a grown count and a vanished file both fail', moved.length === 2 && moved.includes(grown) && moved.includes(shrunk));
  } else ok('NEGATIVE CONTROL: the table has entries to grow and remove', false);
} finally {
  fs.rmSync(tree, { recursive: true, force: true });
}

finish();
