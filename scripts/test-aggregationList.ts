// One aggregation list (semantic layer part 5, step 01). Every list of aggregations in `src/` comes from
// src/data/aggregations.ts, so a new one (count distinct) reaches every store at once; a file with a list of its
// own is the place a pod would read `countd` as `sum` and save it back. A ratchet: the allowlist names the few
// deliberate subsets, each with its reason, and may only shrink.
//
//   npm run build:ts && node scripts/test-aggregationList.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';

const fs: typeof import('fs') = require('fs');
const path: typeof import('path') = require('path');

const REPO = path.resolve(__dirname, '..');
const LIST = [/['"]sum['"]\s*,\s*['"](avg|count|min|max)['"]/, /['"]count['"]\s*,\s*['"]sum['"]/];

/** The files allowed a list of their own. THE LIST MAY ONLY SHRINK. */
const ALLOWED: Record<string, string> = {
  'src/data/aggregations.ts': 'the one list',
  'src/formula/formulaParse.ts': "LOD_AGGS: the formula grammar's own functions",
  'src/publish/sanitize.ts': "GEO_AGGS: a map's deliberate subset",
  'src/analysis/additivity.ts': 'ADDS: the aggregations that add up (part 1 D7), a classification, not a store',
};

function sources(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) sources(p, out);
    else if (e.name.endsWith('.ts') && !e.name.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

function offenders(): string[] {
  return sources(path.join(REPO, 'src'))
    .map((f) => path.relative(REPO, f).split(path.sep).join('/'))
    .filter((rel) => !(rel in ALLOWED) && LIST.some((re) => re.test(fs.readFileSync(path.join(REPO, rel), 'utf8'))));
}

const found = offenders();
ok('every file in src/: no aggregation list of its own', found.length === 0, found.join(', '));
for (const rel of Object.keys(ALLOWED)) ok(`allowlisted ${rel} still exists (${ALLOWED[rel]})`, fs.existsSync(path.join(REPO, rel)));

// NEGATIVE CONTROL: a planted list is found.
const probe = path.join(REPO, 'src', '__aggProbe.ts');
try {
  fs.writeFileSync(probe, "export const P = new Set(['sum', 'avg']);\n");
  ok('NEGATIVE CONTROL: a planted list fails the scan', offenders().includes('src/__aggProbe.ts'));
} finally {
  fs.rmSync(probe, { force: true });
}

finish();
