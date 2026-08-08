'use strict';

// No source file grows past 800 lines. A ratchet, not a wish.
//
// WHY THIS EXISTS. `.claude/rules/file-size.md` says a file over 500 lines is a
// smell and one over 800 must be split. A rule nobody can run is a wish: this
// repo reached ten files over a thousand lines with that rule in a doc, and the
// two worst (`hub.ts`, `dashboards.ts`) had drifted past two thousand. Nothing
// stopped them, because nothing was measuring.
//
// The mechanism is the ALLOWED map below, and it has exactly one rule:
//
//   EDIT IT ONLY TO REMOVE AN ENTRY OR LOWER A COUNT. NEVER TO ADMIT A NEW FILE.
//
// That is what makes it a ratchet. A cap alone would be either unlandable (16
// files over it today) or permanently disabled; a cap plus a shrinking
// allowlist lets the debt be paid down one file at a time while making it
// impossible to add more. Two assertions carry it:
//
//   1. over the cap and NOT allowlisted  → fail. New debt is refused outright.
//   2. allowlisted but GROWN past its recorded count → fail. Existing debt is
//      frozen where it stands; you may shrink an allowlisted file freely, but
//      the moment it grows the check names it. Lower the number in the same
//      commit that shrinks the file and the ratchet tightens by that much.
//
// WHAT COUNTS AS A SOURCE. Every runtime `.js` in this repo is tsc output of a
// sibling `.ts` (in-place emit, see tsconfig.base.json), so a `.js` next to a
// `.ts` of the same name is skipped — otherwise every file would be counted
// twice and `npm test` would fail differently before and after a build. A `.js`
// with NO `.ts` sibling is a hand-written source (scripts/build-vendor.js and
// friends) and does count. Committed vendor bundles and generated Svelte output
// are not sources at all.
//
//   npm run build:ts && node scripts/test-file-size.js

import * as fs from 'fs';
import * as path from 'path';

let failures = 0;
function ok(label: string, cond: boolean): void {
  if (cond) console.log('ok   ' + label);
  else {
    console.error('FAIL ' + label);
    failures++;
  }
}

const REPO = path.resolve(__dirname, '..');

/** Over this many lines, a file must be split (or be in ALLOWED, below). */
const CAP = 800;

/**
 * Files already over the cap when this check landed, with the line count they
 * had at the time. THE LIST MAY ONLY SHRINK. Removing an entry (or lowering its
 * number) is the point; adding one is the failure this file exists to prevent.
 */
const ALLOWED: Record<string, number> = {
  'renderer/hub/analyses.ts': 1227,
  'renderer/hub/authoring.ts': 1341,
  'renderer/hub/chartRender.ts': 1097,
  'renderer/hub/connections.ts': 1076,
  'renderer/hub/datasets.ts': 1271,
  'renderer/hub/mapRender.ts': 834,
  'renderer/hub/prepare.ts': 944,
  'renderer/hub/visuals.ts': 1284,
  'scripts/smoke-app.ts': 3544,
  'scripts/test-analysis.ts': 813,
  'scripts/test-anomaliesResident.ts': 837,
  'scripts/test-connectorsHttp.ts': 889,
  'src/analysisPlan.ts': 884,
  'src/analyze.ts': 1021,
  'src/anomaliesResident.ts': 870,
  'src/config.ts': 801,
  'src/connectors/http.ts': 1036,
  'src/connectors/local.ts': 804,
  'src/formula.ts': 1043,
  'src/localCliRun.ts': 822,
};

// Roots to walk. `scripts` is included for the hand-written build tools that
// have no `.ts` sibling as much as for the test sources themselves.
const ROOTS = ['main.ts', 'src', 'renderer', 'preload', 'scripts'];

// Not sources: dependencies, the committed vgplot bundle (build output of
// scripts/build-vendor.js), and the esbuild-generated Svelte island bundle.
const SKIP_DIRS = new Set(['node_modules']);
const SKIP_PATHS = new Set([
  'renderer/hub/vendor',
  'renderer/hub/svelte/bundle.js',
]);

function rel(abs: string): string {
  return path.relative(REPO, abs).split(path.sep).join('/');
}

function collect(abs: string, out: string[]): void {
  const r = rel(abs);
  if (SKIP_PATHS.has(r)) return;
  let st: fs.Stats;
  try {
    st = fs.statSync(abs);
  } catch {
    return; // a root that does not exist yet is not an error
  }
  if (st.isDirectory()) {
    if (SKIP_DIRS.has(path.basename(abs))) return;
    for (const name of fs.readdirSync(abs).sort()) collect(path.join(abs, name), out);
    return;
  }
  if (!/\.(ts|js)$/.test(abs)) return;
  // An emitted sibling of a .ts is build output, not a source.
  if (abs.endsWith('.js') && fs.existsSync(abs.slice(0, -3) + '.ts')) return;
  out.push(r);
}

const files: string[] = [];
for (const root of ROOTS) collect(path.join(REPO, root), files);

// `wc -l` semantics, so a count here is the count a human gets at the shell:
// the trailing newline every file in this repo ends with is not a line of its own.
const lines = new Map<string, number>();
for (const f of files) {
  const parts = fs.readFileSync(path.join(REPO, f), 'utf8').split('\n');
  if (parts[parts.length - 1] === '') parts.pop();
  lines.set(f, parts.length);
}

ok(`walked ${files.length} source files`, files.length > 100);

// 1. Nothing over the cap that is not already on the list.
const unlisted = files.filter((f) => (lines.get(f) as number) > CAP && !(f in ALLOWED));
ok(
  `no unlisted file over ${CAP} lines`,
  unlisted.length === 0,
);
if (unlisted.length) {
  for (const f of unlisted) {
    console.error(`     ${f} is ${lines.get(f)} lines (cap ${CAP}) — split it.`);
  }
  console.error('     Do NOT add it to ALLOWED; that list only shrinks.');
}

// 2. Nothing on the list has grown. The ratchet only tightens.
const grown = Object.keys(ALLOWED)
  .filter((f) => lines.has(f) && (lines.get(f) as number) > ALLOWED[f]);
ok('no allowlisted file has grown past its recorded count', grown.length === 0);
for (const f of grown) {
  console.error(`     ${f} is ${lines.get(f)} lines, recorded at ${ALLOWED[f]} — the ratchet only tightens.`);
}

// A stale entry is not a failure (the file may have been split or renamed) but
// it is dead weight in the list, so it is reported.
const stale = Object.keys(ALLOWED).filter((f) => !lines.has(f));
for (const f of stale) console.log(`     (${f} is no longer a source file — drop its ALLOWED entry)`);

// Slack that has already been earned: an allowlisted file now under its recorded
// count. Not a failure — lowering the number is a judgement call about whether
// the shrink is the final one — but it is printed so the ratchet gets tightened
// rather than quietly forgotten.
const slack = Object.keys(ALLOWED)
  .filter((f) => lines.has(f) && (lines.get(f) as number) < ALLOWED[f])
  .map((f) => `${f} ${lines.get(f)}/${ALLOWED[f]}`);
if (slack.length) console.log(`     (lower these: ${slack.join(', ')})`);

const over = files.filter((f) => (lines.get(f) as number) > CAP).length;
const soft = files.filter((f) => (lines.get(f) as number) > 500).length;
console.log('');
console.log(`     ${over} file(s) over the ${CAP}-line cap, ${soft} over the 500-line smell line.`);
console.log(`     ALLOWED holds ${Object.keys(ALLOWED).length} entr(ies); the branch is done when it is empty.`);

console.log('');
if (failures) {
  console.error(`${failures} file-size check(s) FAILED.`);
  process.exit(1);
}
console.log('All file-size checks passed.');
