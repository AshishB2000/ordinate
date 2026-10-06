// Self-check for src/app/onboarding.ts — the Get-started checklist's ticks.
//
// The ticks are read off real records, so the properties that matter are the
// ones a click-counter would get wrong:
//   1. The SAMPLE's own records never tick anything.
//   2. A user's record does, and the tick LATCHES — deleting it later does not
//      un-tick the step.
//   3. An install seeded before this existed (no onboarding block) never sees
//      the card or the tour.
//
//   npm run build:ts && node scripts/test-onboarding.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');

const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-onboarding-'));
process.env.ORDINATE_LOCAL_DIR = tmpUserData;

// ponytail: compiled siblings of the real modules.
const config: typeof import('../src/app/config') = require('../src/app/config');
const sample: typeof import('../src/app/sampleProject') = require('../src/app/sampleProject');
const onboarding: typeof import('../src/app/onboarding') = require('../src/app/onboarding');
const visuals: typeof import('../src/analysis/visuals') = require('../src/analysis/visuals');
const analysis: typeof import('../src/analysis/analysis') = require('../src/analysis/analysis');

async function main(): Promise<void> {
  config.load();
  let st = await onboarding.status();
  ok('before the sample seeds, there is no checklist', !st.started && !st.show && !st.coachPending);

  const seeded = await sample.seedSampleProject();
  if (!seeded.projectId) throw new Error('sample not seeded');
  const ids = config.get().sample!;
  ok('the seed records what it made', ids.projectId === seeded.projectId && ids.visualIds.length === 3 && !!ids.datasetId);

  st = await onboarding.status();
  ok('a first launch starts it: shown, 0 of 4, tour pending', st.started && st.show && st.doneCount === 0 && st.total === 4 && st.coachPending,
    JSON.stringify(st));
  ok('…the sample\'s dataset, three visuals and dashboard tick nothing', st.steps.every((s) => !s.done));

  const v = await visuals.saveVisual(seeded.projectId, {
    name: 'Mine', datasetId: ids.datasetId, chartType: 'column',
    encoding: { category: 'region', values: [{ column: 'units', aggregation: 'sum' }] },
  });
  st = await onboarding.status();
  ok('a visual of the user\'s own ticks "Build a visual" — only that', st.doneCount === 1
    && st.steps.find((s) => s.id === 'visual')!.done, JSON.stringify(st.steps));
  await visuals.deleteVisual(seeded.projectId, v!.id);
  st = await onboarding.status();
  ok('…and the tick LATCHES: deleting the visual does not un-tick it', st.steps.find((s) => s.id === 'visual')!.done);

  await analysis.saveAnalysis(seeded.projectId, { name: 'Mine too', sheets: [] });
  st = await onboarding.status();
  ok('a dashboard that is not the sample ticks "Create a dashboard"', st.steps.find((s) => s.id === 'dashboard')!.done && st.doneCount === 2);

  ok('fold', onboarding.set({ collapsed: true }) && (await onboarding.status()).collapsed === true);
  ok('tour seen, once', onboarding.set({ coachSeen: true }) && (await onboarding.status()).coachPending === false);
  onboarding.set({ collapsed: false, coachSeen: false } as never);
  ok('…a tour marked seen cannot be un-seen', (await onboarding.status()).coachPending === false);
  onboarding.set({ dismissed: true });
  st = await onboarding.status();
  ok('dismissed: the card is gone for good', st.started && !st.show);

  // Config round-trips the block through its sanitizer.
  config.load();
  ok('the state survives a reload from disk', (await onboarding.status()).doneCount === 2 && !(await onboarding.status()).show);

  // An install that seeded before onboarding existed.
  config.save({ onboarding: null });
  st = await onboarding.status();
  ok('an install without the block never sees the card or the tour', !st.started && !st.show && !st.coachPending);
  ok('junk on disk is refused, not trusted', (config.save({ onboarding: { startedAt: 5, done: 'x' } }), config.get().onboarding === null));

  finish();
}

main().catch((err) => {
  console.error('FAIL (threw)', err);
  process.exit(1);
});
