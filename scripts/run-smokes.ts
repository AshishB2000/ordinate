// Run EVERY smoke file, even after one fails. The old `"smoke"` script chained
// the six files with `&&`, so a failure in smoke-app — first, longest, most
// fragile — hid the other files' ~210 assertions and cost one bug per CI
// round-trip. This runner executes each compiled smoke .js sequentially (they
// each launch a real Electron app; parallel launches fight over the display),
// lets ALL of them run, prints a per-file summary, and exits non-zero if ANY
// failed. Callers unchanged: `npm run smoke` still builds first, and each
// individual file can still be run directly with `node scripts/smoke-<x>.js`.
//
// NO SMOKE CAN HANG THE CHAIN. Each one runs as a child in its own process
// group with a 10-minute deadline; past it the whole group (Electron and
// anything it spawned) is killed and the smoke FAILS by name. smoke-reports once
// hung CI for six hours after its last passing assertion, and every smoke after
// it — eleven of them — had never run in CI as a result.
//
// SHARDS. `--shard i/n` runs the i-th of n slices, balanced by the durations in
// scripts/smoke-durations.json (measured on CI; longest first onto the lightest
// shard). CI runs four shards as parallel jobs. A smoke missing from the file
// counts as two minutes — re-measure from the summary this prints.
//
//   node scripts/run-smokes.js                 every smoke
//   node scripts/run-smokes.js --shard 2/4     the second quarter
//   node scripts/run-smokes.js smoke-reports   just the named ones


const path: typeof import('path') = require('path');
const fs: typeof import('fs') = require('fs');
const { spawn }: typeof import('child_process') = require('child_process');

const TIMEOUT_MS = 10 * 60 * 1000;
const UNKNOWN_S = 120;

// In chain order — smoke-app first, same as before, so its logs stay on top.
// The eight files after it are the surfaces SPLIT OUT of smoke-app.ts, listed in
// the order those sections ran inside it, so the logs still read top to bottom
// the way they always did.
export const SMOKES = [
  'smoke-app',
  'smoke-shell',
  'smoke-analysis-create',
  'smoke-analysis-workbench',
  'smoke-analysis-props',
  'smoke-dashboard-controls',
  'smoke-draft-review',
  'smoke-dataset',
  'smoke-import',
  'smoke-viz-builder',
  // After smoke-viz-builder, which proves the builder itself works: this one
  // adds the type whose whole output is DOM rather than a canvas.
  'smoke-pivot',
  'smoke-saved-chart-type',
  'smoke-render-stacks',
  'smoke-topbar',
  'smoke-palette',
  'smoke-sample',
  'smoke-composer',
  'smoke-formula',
  'smoke-dock',
  'smoke-dockHero',
  'smoke-assistant',
  'smoke-ask-actions',
  'smoke-viz-thumbs',
  'smoke-section-hero',
  'smoke-capture',
  'smoke-connect',
  'smoke-connections',
  'smoke-dashboard-proposal',
  'smoke-templates',
  'smoke-dashboards',
  'smoke-dashboard-edit',
  // Accessibility, enforced across every surface — names, tab order, modal
  // focus, WCAG AA contrast in both themes and every style preset, and `?`.
  'test-a11y',
  'smoke-insights',
  'smoke-metrics',
  // After smoke-insights: both write to the sample project, and this one's
  // rules are created from the sample dashboard's own KPI card.
  'smoke-alerts',
  'smoke-dashboard-styles',
  'smoke-theme',
  // Last, and after smoke-theme deliberately: both drive the real Appearance
  // control, and this one is about what survives it into a FILE.
  'smoke-export',
  // After smoke-export, for the same reason it is after smoke-theme: this one
  // is also about what survives into a FILE, and it unzips the ones it makes.
  'smoke-reports',
  // Workflow depth — answers with charts, stories, the catalog, the five new
  // chart types and record tabs, in ONE launch (sections in scripts/wf*.ts).
  'smoke-workflow',
  // Date intelligence, parameters, SQL, quality rules, formats and branding —
  // its own fresh userData, so it can change the workspace currency and accent.
  'smoke-depth',
  // History, Trash, Lineage, Projects and first-run guidance. Its own fresh
  // profile: the Get-started card and the coach marks only exist on first launch.
  'smoke-workspace',
  // Relationships and joins, tile actions and navigation, the new card kinds,
  // point / custom-boundary maps — end to end on the sample project.
  'smoke-authoring',
  // Platform depth: jobs + speed on the 1M-row fixture (it prints the measured
  // table), then publish, privacy, automation and backups on a small one.
  'smoke-platform',
  // Analysis power — the Analytics pane, table calculations, the prepare steps,
  // comments and scorecards, in ONE launch (sections in scripts/pw*.ts).
  'smoke-power',
  // Build depth: assistant plans, formatting and colours, themes, SaaS sources
  // (against a local HTTP fixture server) and snapshots, in one launch.
  'smoke-build',
  // Analysis engines — key drivers, scenarios, segments, cohorts and funnels,
  // typed filters, in ONE launch (sections in scripts/ae*.ts).
  'smoke-engines',
  // Depth round 6: layouts for every size, statistics, text analytics,
  // geospatial analysis and input tables, in one launch (sections in scripts/r6*.ts).
  'smoke-round6',
  // Round 8: small multiples, pipelines, event annotations, the summary card
  // and search inside the data, in one launch (sections in scripts/r8*.ts).
  'smoke-round8',
  // Round 10: saved views, retail calendars, multi-currency, incremental
  // refresh and drag and drop, in one launch (sections in scripts/r10*.ts).
  'smoke-round10',
  // Round 7: notebooks, level-of-detail expressions, save as template, linked
  // hover and motion, and interface languages, in one launch (sections in scripts/r7*.ts).
  'smoke-round7',
];

/** Longest-processing-time-first: each smoke, longest first, onto whichever
 *  shard is lightest so far. Ties go to the lower shard, so it is deterministic.
 *  Returns the smokes of shard `i` (1-based) in their original chain order. */
export function shardOf(names: string[], durations: Record<string, number>, i: number, n: number): string[] {
  const load = new Array(n).fill(0);
  const owner = new Map<string, number>();
  const byCost = names.slice().sort((a, b) => (durations[b] ?? UNKNOWN_S) - (durations[a] ?? UNKNOWN_S) || names.indexOf(a) - names.indexOf(b));
  for (const name of byCost) {
    let k = 0;
    for (let j = 1; j < n; j++) if (load[j] < load[k]) k = j;
    load[k] += durations[name] ?? UNKNOWN_S;
    owner.set(name, k);
  }
  return names.filter((name) => owner.get(name) === i - 1);
}

/** One smoke as a child in its own process group; resolves with its exit code,
 *  or 124 (timeout's convention) after killing the group at the deadline. */
function runOne(file: string): Promise<{ code: number; timedOut: boolean }> {
  return new Promise((resolve) => {
    // Shell-free (spawn with an args array — repo rule); output streams
    // straight through so CI logs read exactly as they did under the && chain.
    const child = spawn(process.execPath, [file], { stdio: 'inherit', detached: process.platform !== 'win32' });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (process.platform === 'win32') child.kill('SIGKILL');
        else process.kill(-(child.pid as number), 'SIGKILL');
      } catch (_) { /* already gone */ }
    }, TIMEOUT_MS);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ code: timedOut ? 124 : code === null ? 1 : code, timedOut });
    });
  });
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  let list = SMOKES;
  const si = argv.indexOf('--shard');
  if (si >= 0) {
    const m = /^(\d+)\/(\d+)$/.exec(argv[si + 1] || '');
    if (!m || +m[1] < 1 || +m[1] > +m[2]) {
      console.error('usage: run-smokes --shard i/n  (1 <= i <= n)');
      process.exit(2);
    }
    const durations = JSON.parse(fs.readFileSync(path.join(__dirname, 'smoke-durations.json'), 'utf8'));
    list = shardOf(SMOKES, durations, +m[1], +m[2]);
    console.log(`shard ${m[1]}/${m[2]}: ${list.join(', ')}`);
  } else if (argv.length) {
    const unknown = argv.filter((a) => !SMOKES.includes(a));
    if (unknown.length) { console.error('unknown smoke(s): ' + unknown.join(', ')); process.exit(2); }
    list = argv;
  }

  const results: { name: string; code: number; timedOut: boolean; seconds: number }[] = [];
  for (const name of list) {
    console.log(`\n=== ${name} ===`);
    const t0 = Date.now();
    const r = await runOne(path.join(__dirname, name + '.js'));
    const seconds = Math.round((Date.now() - t0) / 1000);
    if (r.timedOut) console.error(`FAIL ${name} timed out after ${TIMEOUT_MS / 60000} minutes and was killed`);
    results.push({ name, code: r.code, timedOut: r.timedOut, seconds });
  }

  console.log('\n=== smoke summary ===');
  let failed = 0;
  for (const r of results) {
    const why = r.code === 0 ? '' : r.timedOut ? ' (TIMED OUT)' : ` (exit ${r.code})`;
    console.log(`${r.code === 0 ? 'ok  ' : 'FAIL'} ${r.name}${why}  ${r.seconds}s`);
    if (r.code !== 0) failed += 1;
  }
  // Paste into scripts/smoke-durations.json after a CI run to rebalance.
  console.log('durations: ' + JSON.stringify(Object.fromEntries(results.map((r) => [r.name, r.seconds]))));
  if (failed) {
    console.error(`\n${failed} of ${results.length} smoke file(s) FAILED: ${results.filter((r) => r.code).map((r) => r.name).join(', ')}`);
    process.exit(1);
  }
  console.log(`\nAll ${results.length} smoke files passed.`);
}

if (require.main === module) void main();
