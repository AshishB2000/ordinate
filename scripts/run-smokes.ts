// Run EVERY smoke file, even after one fails. The old `"smoke"` script chained
// the six files with `&&`, so a failure in smoke-app — first, longest, most
// fragile — hid the other files' ~210 assertions and cost one bug per CI
// round-trip. This runner executes each compiled smoke .js sequentially (they
// each launch a real Electron app; parallel launches fight over the display),
// lets ALL of them run, prints a per-file summary, and exits non-zero if ANY
// failed. Callers unchanged: `npm run smoke` still builds first, and each
// individual file can still be run directly with `node scripts/smoke-<x>.js`.

export {}; // module scope — sibling scripts share top-level names

const path: typeof import('path') = require('path');
const { spawnSync }: typeof import('child_process') = require('child_process');

// In chain order — smoke-app first, same as before, so its logs stay on top.
// The eight files after it are the surfaces SPLIT OUT of smoke-app.ts, listed in
// the order those sections ran inside it, so the logs still read top to bottom
// the way they always did.
const SMOKES = [
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
];

const results: { name: string; code: number }[] = [];
for (const name of SMOKES) {
  const file = path.join(__dirname, name + '.js');
  console.log(`\n=== ${name} ===`);
  // Shell-free (execFile/spawn with an args array — repo rule); output streams
  // straight through so CI logs read exactly as they did under the && chain.
  const r = spawnSync(process.execPath, [file], { stdio: 'inherit' });
  results.push({ name, code: r.status === null ? 1 : r.status });
}

console.log('\n=== smoke summary ===');
let failed = 0;
for (const r of results) {
  console.log(`${r.code === 0 ? 'ok  ' : 'FAIL'} ${r.name}${r.code === 0 ? '' : ` (exit ${r.code})`}`);
  if (r.code !== 0) failed += 1;
}
if (failed) {
  console.error(`\n${failed} of ${results.length} smoke file(s) FAILED.`);
  process.exit(1);
}
console.log(`\nAll ${results.length} smoke files passed.`);
