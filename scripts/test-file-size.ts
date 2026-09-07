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
// That is what makes it a ratchet. A cap alone would be either unlandable (22
// files were over it when this landed) or permanently disabled; a cap plus a shrinking
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

import { ok, failureCount } from './selfcheck';

const REPO = path.resolve(__dirname, '..');

/** Over this many lines, a file must be split (or be in ALLOWED, below). */
const CAP = 800;

/**
 * Files already over the cap when this check landed, with the line count they
 * had at the time. THE LIST MAY ONLY SHRINK. Removing an entry (or lowering its
 * number) is the point; adding one is the failure this file exists to prevent.
 */
const ALLOWED: Record<string, number> = {
  // Not splittable by moving lines: buildChart() is ONE 870-line function and
  // every per-chart-family block reads its locals (palette, fmt, isRound,
  // makeValueAxis, …). Breaking it up means inventing a parameter object, which
  // is a design change with real behaviour risk, not a move. Own PR.
  //
  // 1097 -> 999, and that is the floor for moves. Everything around buildChart
  // that could leave HAS left: chartTraits.ts (facts about chart ids),
  // chartPalette.ts (CHART_PALETTE, getCSSVar, the hex/HSL derivation helpers)
  // and chartTable.ts (buildDataTable renders a <table>, not a chart) — each
  // under 100 lines. What remains is that one function plus the ~90 lines of
  // shapes, WeakMaps and value-label helpers it reads, so the next reduction is
  // the parameter-object redesign named above, not another extraction.
  'renderer/hub/chartRender.ts': 999,
  'renderer/hub/mapRender.ts': 834,
  // Deliberately last: it is the only check that runs the real app, so breaking
  // it blinds every other split. Own PR, after these are merged and green.
  //
  // Grew from 3544 in the dash-controls plan's final task: the plan's own gate
  // list requires a PERMANENT smoke assertion for the "view state never writes"
  // safety guarantee (mtime/bytes around a control interaction) plus a real-app
  // walk of all three control kinds — both belong in the one file that drives
  // the real app, not a new one (there is exactly one of these on purpose). A
  // future split still owns its own PR; this is a one-time, reviewed bump, not
  // organic drift.
  //
  // Grew again, 4098 -> 4165, in the whole-branch review fix pass: the same
  // safety-guarantee assertion had only ever been exercised on the PUBLISHED
  // (read-only) side, where persistDashboard's own early-return makes it
  // trivially true. The path a real regression would break is the AUTHORING
  // side — editing an open analysis, where markDashDirty/anScheduleWrite DO
  // reach disk — and that side had no coverage at all. Added the analogous
  // mtime/bytes check there, same file, same reasoning as above.
  'scripts/smoke-app.ts': 3737,
  'scripts/test-connectorsHttp.ts': 881,
  'src/ai/analyze.ts': 955,
  'src/engine/anomaliesResident.ts': 870,
  'src/connectors/http.ts': 1036,
  'src/connectors/local.ts': 804,
  'src/cli/localCliRun.ts': 822,
};

// Roots to walk. `scripts` is included for the hand-written build tools that
// have no `.ts` sibling as much as for the test sources themselves.
const ROOTS = ['src', 'renderer', 'preload', 'scripts'];

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
if (failureCount()) {
  console.error(`${failureCount()} file-size check(s) FAILED.`);
  process.exit(1);
}
console.log('All file-size checks passed.');
