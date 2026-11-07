// A ratchet over every place that branches on a metric definition's kind, so a new "not a formula, so a column"
// site cannot read a metric defined in another tool's semantic layer (`{ external }`, part 7 b0) as `sum of ''`.
//
// The mechanism is DEFINITION_SITES (scripts/definitionSites.ts), the shape of 05a's scripts/termSites.ts: every
// file under src/ and web/src whose text matches PATTERNS, with its match count and what its sites do with an
// external definition. A file with a match and no entry fails, and so does a count that differs from its entry in
// either direction. When this fails you added, moved or removed a site: CLASSIFY it, then change the entry.
//
//   npm run build:ts && node scripts/test-definitionSites.js

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { ok, finish } from './selfcheck';
import { DEFINITION_SITES } from './definitionSites';

const REPO = path.resolve(__dirname, '..');
const ROOTS = ['src', 'web/src'];

const PATTERNS: readonly RegExp[] = [
  /\bisFormulaDefinition\(/g,
  /['"]formula['"]\s+in\b/g,
  /\.definition\.(column|aggregation|formula|snapshot)\b/g,
  /\bisExternalDefinition\(/g,
  /\b(isSimpleDefinition|isFunnelDefinition|isPeriodDefinition|isNewerKind)\(/g, // part 5's kinds (./pendingKinds)
];

// Sources only: no emitted .js, declaration files, tests, goldens or prototypes.
const SKIP_DIRS = new Set(['node_modules', 'dist', '__golden__', 'prototype']);
const isSource = (name: string): boolean => /\.tsx?$/.test(name) && !/\.d\.ts$/.test(name) && !/\.test\.tsx?$/.test(name);

/** Repo-relative path → match count, for every source file under `root`'s src/ and web/src that has one. */
function scan(root: string): Map<string, number> {
  const found = new Map<string, number>();
  const walk = (abs: string): void => {
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
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

/** The rows that fail: a file with matches and no entry, a count that differs, an entry nothing matches any more. */
function mismatches(found: Map<string, number>): { file: string; n: number; classified: number | undefined }[] {
  const files = new Set([...found.keys(), ...Object.keys(DEFINITION_SITES)]);
  return [...files].sort().map((file) => ({ file, n: found.get(file) ?? 0, classified: DEFINITION_SITES[file]?.count })).filter((r) => r.n !== r.classified);
}

// § the repo: every site is classified, and nothing classified has gone
const found = scan(REPO);
ok(`scanned ${found.size} files with a site`, found.size > 20);
const failing = mismatches(found);
for (const r of failing) ok(`${r.file}: ${r.n} site(s), classified ${r.classified}`, false);
ok(`every site is classified (${Object.keys(DEFINITION_SITES).length} files)`, failing.length === 0);
ok('the doors are the KPI resolver and the chart planner', Object.entries(DEFINITION_SITES).filter(([, e]) => e.how === 'door').map(([f]) => f).sort().join() === 'src/analysis/metricMeasures.ts,src/ipc/metrics.ts');

// § negative control: the same scan over a temp tree that mirrors the table, then one planted site
const tree = fs.mkdtempSync(path.join(os.tmpdir(), 'definition-sites-'));
const put = (file: string, text: string): void => {
  fs.mkdirSync(path.dirname(path.join(tree, file)), { recursive: true });
  fs.writeFileSync(path.join(tree, file), text);
};
const site = 'isFormulaDefinition(d);\n';
try {
  for (const [file, e] of Object.entries(DEFINITION_SITES)) put(file, site.repeat(e.count));
  ok('control: a tree that matches the table has no mismatch', mismatches(scan(tree)).length === 0);
  for (const f of ['src/probe.test.ts', 'src/prototype/probe.ts', 'src/probe.js', 'src/probe.d.ts', 'web/src/__golden__/probe.ts']) put(f, site);
  ok('control: tests, .js, .d.ts, goldens and prototypes are not scanned', mismatches(scan(tree)).length === 0);
  put('src/__defProbe.ts', site);
  const fresh = mismatches(scan(tree));
  ok('NEGATIVE CONTROL: a new unclassified `isFormulaDefinition(` site fails the scan', fresh.length === 1 && fresh[0].file === 'src/__defProbe.ts' && fresh[0].classified === undefined);
  put('src/__defProbe.ts', "const c = m.definition.column;\nif ('formula' in m.definition) {}\n");
  const reads = mismatches(scan(tree));
  ok('NEGATIVE CONTROL: a `.definition.column` read and a `\'formula\' in` test count too', reads.length === 1 && reads[0].n === 2);
  put('src/__defProbe.ts', 'if (isSimpleDefinition(d) || isNewerKind(d)) {}\n');
  const pending = mismatches(scan(tree));
  ok('NEGATIVE CONTROL: part 5\'s `isSimpleDefinition(` and `isNewerKind(` sites count too', pending.length === 1 && pending[0].n === 2);
  fs.rmSync(path.join(tree, 'src/__defProbe.ts'));
  const [grown, shrunk] = Object.keys(DEFINITION_SITES);
  fs.appendFileSync(path.join(tree, grown), site);
  fs.rmSync(path.join(tree, shrunk));
  const moved = mismatches(scan(tree)).map((m) => m.file).sort();
  ok('NEGATIVE CONTROL: a grown count and a vanished file both fail', moved.length === 2 && moved.includes(grown) && moved.includes(shrunk));
} finally {
  fs.rmSync(tree, { recursive: true, force: true });
}

finish();
