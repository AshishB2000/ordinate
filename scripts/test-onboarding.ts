// Self-check for src/app/onboarding.ts: the Get-started tour.
//
// The tour is each person's, so the properties that matter are the ones a
// shared checklist would get wrong:
//   1. One person's visit ticks their stop and nobody else's; so does a fold
//      or a hide.
//   2. The Assistant stop exists only while AI is set up, and finishing the
//      tour LATCHES: turning AI on later does not bring the card back.
//   3. An org that never started it (or hid or finished the old org-wide
//      checklist) never sees the card or the coach marks.
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
const execConfig: typeof import('../src/app/execConfig') = require('../src/app/execConfig');
const sample: typeof import('../src/app/sampleProject') = require('../src/app/sampleProject');
const onboarding: typeof import('../src/app/onboarding') = require('../src/app/onboarding');

const ANN = 'ann@example.com';
const BOB = 'bob@example.com';
const CARL = 'carl@example.com';
const realReady = execConfig.executionReady;
const aiReady = (on: boolean) => {
  (execConfig as { executionReady: () => Promise<boolean> }).executionReady = on ? async () => true : realReady;
};
const ids = (st: { steps: Array<{ id: string }> }) => st.steps.map((s) => s.id).join(',');
const done = (st: { steps: Array<{ id: string; done: boolean }> }, id: string) => !!st.steps.find((s) => s.id === id)?.done;

async function main(): Promise<void> {
  config.load();
  let st = await onboarding.status(ANN);
  ok('before the sample seeds, there is no tour', !st.started && !st.show && !st.coachPending);
  ok('…and a visit has nowhere to land', onboarding.visit(ANN, 'explore') === false);

  const seeded = await sample.seedSampleProject();
  if (!seeded.projectId) throw new Error('sample not seeded');

  st = await onboarding.status(ANN);
  ok('the seed starts it: shown, 0 of 4 without AI, coach marks pending', st.started && st.show && st.doneCount === 0 && st.total === 4 && st.coachPending,
    JSON.stringify(st));
  ok('…no Assistant stop while AI is not set up', ids(st) === 'explore,dashboards,reports,data', ids(st));

  ok('Ann opens Explore', onboarding.visit(ANN, 'explore'));
  st = await onboarding.status(ANN);
  ok('…it ticks for Ann: 1 of 4', st.doneCount === 1 && done(st, 'explore'));
  const bob = await onboarding.status(BOB);
  ok('…and not for Bob, who has not been there', bob.doneCount === 0 && !done(bob, 'explore') && bob.show);
  const first = config.get().onboarding!.by[ANN].seen.explore;
  onboarding.visit(ANN, 'explore');
  ok('a second visit changes nothing (the first time stays)', config.get().onboarding!.by[ANN].seen.explore === first);
  ok('a stop that is not on the tour is refused', onboarding.visit(ANN, 'import' as never) === false);

  ok('Ann folds hers', onboarding.set(ANN, { collapsed: true }) && (await onboarding.status(ANN)).collapsed === true);
  ok('…Bob\'s stays open', (await onboarding.status(BOB)).collapsed === false);

  aiReady(true);
  st = await onboarding.status(ANN);
  ok('with AI set up the Assistant leads the tour: 1 of 5', ids(st) === 'assistant,explore,dashboards,reports,data' && st.total === 5 && st.doneCount === 1, ids(st));
  onboarding.visit(ANN, 'assistant');
  ok('asking it ticks it', done(await onboarding.status(ANN), 'assistant'));

  aiReady(false);
  for (const step of ['dashboards', 'reports', 'data'] as const) onboarding.visit(BOB, step);
  onboarding.visit(BOB, 'explore');
  st = await onboarding.status(BOB);
  ok('Bob visits all four: his card is gone', !st.show && st.doneCount === 4 && st.total === 4, JSON.stringify(st));
  aiReady(true);
  st = await onboarding.status(BOB);
  ok('…and turning AI on later does not bring it back for one stop', !st.show && st.total === 5);
  aiReady(false);
  // Negative control: Ann, not finished, still has hers.
  ok('Ann (not finished) still has hers', (await onboarding.status(ANN)).show);

  onboarding.set(CARL, { dismissed: true });
  ok('Carl hides his: gone for him', !(await onboarding.status(CARL)).show);
  ok('…still there for Ann', (await onboarding.status(ANN)).show);

  ok('coach marks seen, once, for the org', onboarding.set(ANN, { coachSeen: true }) && (await onboarding.status(BOB)).coachPending === false);
  onboarding.set(ANN, { coachSeen: false } as never);
  ok('…they cannot be un-seen', (await onboarding.status(ANN)).coachPending === false);

  config.load();
  st = await onboarding.status(ANN);
  ok('every person\'s tour survives a reload from disk', st.show && st.collapsed && done(st, 'explore') && !(await onboarding.status(CARL)).show);

  // The old org-wide checklist, as an install that had it stored it.
  const legacy = { startedAt: '2026-01-01T00:00:00.000Z', collapsed: false, dismissed: false, coachSeen: false, done: { import: 'x', visual: 'x' } };
  config.save({ onboarding: legacy });
  st = await onboarding.status(ANN);
  ok('an old checklist still in progress becomes the tour, from the start', st.started && st.show && st.doneCount === 0);
  config.save({ onboarding: { ...legacy, dismissed: true } });
  ok('an old checklist someone hid: past first run, no tour', !(await onboarding.status(ANN)).started);
  config.save({ onboarding: { ...legacy, done: { import: 'x', visual: 'x', dashboard: 'x', assistant: 'x' } } });
  ok('an old checklist that was finished: no tour either', !(await onboarding.status(ANN)).started);

  config.save({ onboarding: null });
  st = await onboarding.status(ANN);
  ok('an install without the block never sees the card or the coach marks', !st.started && !st.show && !st.coachPending);
  ok('junk on disk is refused, not trusted', (config.save({ onboarding: { startedAt: 5, by: 'x' } }), config.get().onboarding === null));
  config.save({ onboarding: { startedAt: 'now', by: { [ANN]: { seen: { explore: 7, data: 'x', hack: 'x' }, collapsed: 'yes' } } } });
  const kept = config.get().onboarding!.by[ANN];
  ok('a person\'s stored tour keeps only real stops with real times', JSON.stringify(kept) === '{"seen":{"data":"x"},"collapsed":false,"dismissed":false}', JSON.stringify(kept));

  // startOnce: the tour for an org with none (projects:create calls it for the org's first project).
  config.save({ onboarding: null });
  onboarding.startOnce();
  st = await onboarding.status(ANN);
  ok('startOnce starts the tour for an org that has none', st.started && st.show && st.doneCount === 0, JSON.stringify(st));
  onboarding.visit(ANN, 'explore');
  onboarding.startOnce();
  ok('…a second call leaves a started one alone (the tick stays)', done(await onboarding.status(ANN), 'explore'));
  onboarding.set(ANN, { dismissed: true });
  onboarding.startOnce();
  ok('…and a hidden one stays hidden', !(await onboarding.status(ANN)).show);

  finish();
}

main().catch((err) => {
  console.error('FAIL (threw)', err);
  process.exit(1);
});
