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
const SMOKES = [
  'smoke-app',
  'smoke-composer',
  'smoke-dock',
  'smoke-ask-actions',
  'smoke-viz-thumbs',
  'smoke-connect',
  'smoke-dashboards',
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
