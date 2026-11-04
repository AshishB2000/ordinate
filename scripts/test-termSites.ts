// A ratchet over every place that cleans a filter list, so a new "keep only type === 'filter'" site
// cannot silently drop a glossary term (semantic layer, PR 05a). A term step (`type: 'term'`) rides
// in the same lists as filters; the code that merges, sanitizes, folds or compiles those lists must
// KEEP it until a door expands it, and a pod that cannot expand it must REFUSE the figure.
//
// The mechanism is TERM_SITES (scripts/termSites.ts): every file under src/ and web/src whose text
// matches PATTERNS, with its match count and what its sites do to a term. Same rule as
// scripts/test-file-size.ts: a file with a match and no entry fails, and so does a count that
// differs from its entry in either direction. When this fails you added, moved or removed a site:
// CLASSIFY it (keep the term, or refuse it), then change the entry. Never just bump a number.
//
//   npm run build:ts && node scripts/test-termSites.js

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { ok, finish } from './selfcheck';
import { TERM_SITES } from './termSites';

const REPO = path.resolve(__dirname, '..');
const ROOTS = ['src', 'web/src'];

const PATTERNS: readonly RegExp[] = [
  /type\s*[!=]==\s*['"]filter['"]/g,
  /\bsanitize(Steps|Filters|DashboardFilters|MetricFilters|FilterList|FilterStep)\(/g,
  /\bfiltersOf\(/g,
  /\b(liveFilters|mergeFilters|mergeDashboardFilters|carrySteps|withLockSteps|filterPredicates?|adaptFilters?|specFilterSteps|resolveFilterParams)\(/g,
];

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

/** One row per file that either has a match or has an entry. */
function rows(found: Map<string, number>): { file: string; n: number; classified: number | undefined }[] {
  const files = new Set([...found.keys(), ...Object.keys(TERM_SITES)]);
  return [...files].sort().map((file) => ({ file, n: found.get(file) ?? 0, classified: TERM_SITES[file]?.count }));
}

/** The rows that fail: a file with matches and no entry, a count that differs, an entry nothing matches any more. */
const mismatches = (found: Map<string, number>) => rows(found).filter((r) => r.n !== r.classified);

// § the repo: every site is classified, and nothing classified has gone
const found = scan(REPO);
ok(`scanned ${found.size} files with a site`, found.size > 50);
for (const r of rows(found)) ok(`${r.file}: ${r.n} site(s), classified ${r.classified}`, r.n === r.classified);

// § negative control: the same scan over a temp tree that mirrors the table, then one planted site
const tree = fs.mkdtempSync(path.join(os.tmpdir(), 'term-sites-'));
const put = (file: string, text: string): void => {
  fs.mkdirSync(path.dirname(path.join(tree, file)), { recursive: true });
  fs.writeFileSync(path.join(tree, file), text);
};
const site = "x.type === 'filter';\n";
try {
  for (const [file, e] of Object.entries(TERM_SITES)) put(file, site.repeat(e.count));
  ok('control: a tree that matches the table has no mismatch', mismatches(scan(tree)).length === 0);

  // not sources: none of these may count
  put('src/probe.test.ts', site);
  put('src/prototype/probe.ts', site);
  put('src/probe.js', site);
  put('src/probe.d.ts', site);
  put('web/src/__golden__/probe.ts', site);
  ok('control: tests, .js, .d.ts, goldens and prototypes are not scanned', mismatches(scan(tree)).length === 0);

  // a new file that filters to type === 'filter' without going through sanitizeFilterList
  put('src/__termSiteProbe.ts', site);
  const fresh = mismatches(scan(tree));
  ok('NEGATIVE CONTROL: a new unclassified site fails the scan', fresh.length === 1 && fresh[0].file === 'src/__termSiteProbe.ts' && fresh[0].classified === undefined);
  fs.rmSync(path.join(tree, 'src/__termSiteProbe.ts'));

  // a classified file that grows a site, and one that loses its sites
  const [grown, shrunk] = Object.keys(TERM_SITES);
  fs.appendFileSync(path.join(tree, grown), site);
  fs.rmSync(path.join(tree, shrunk));
  const moved = mismatches(scan(tree)).map((m) => m.file).sort();
  ok('NEGATIVE CONTROL: a grown count and a vanished file both fail', moved.length === 2 && moved.includes(grown) && moved.includes(shrunk));
} finally {
  fs.rmSync(tree, { recursive: true, force: true });
}

finish();
