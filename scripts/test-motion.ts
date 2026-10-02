// Self-check for dashboard motion's two pure halves: the label-matched
// transition plan (renderer/hub/motionPlan.ts) and the KPI ticker's frames
// (renderer/hub/kpiTicker.ts). The Chart.js driving and the DOM ticking are
// smoked in the real app (scripts/r7Motion.ts).
//
//   npm run build:ts && node scripts/test-motion.js

import { ok, finish } from './selfcheck';

// ponytail: both are renderer UMD scripts, not TS modules (see test-markdown.ts)
const mp = require('../renderer/hub/motionPlan') as any;
const kt = require('../renderer/hub/kpiTicker') as any;

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

// ── The plan: enter / update / exit, matched by LABEL ─────────────────────────
{
  const p = mp.planTransition(['A', 'B', 'C'], [1, 2, 3], ['B', 'C', 'D'], [20, 30, 40]);
  ok('plan: a label in both is an update, carrying old → new value',
    same(p.update.map((u: any) => [u.label, u.from, u.index, u.fromValue, u.toValue]), [['B', 1, 0, 2, 20], ['C', 2, 1, 3, 30]]), JSON.stringify(p.update));
  ok('plan: a new label enters at its new index with its value', same(p.enter, [{ index: 2, label: 'D', to: 40 }]), JSON.stringify(p.enter));
  ok('plan: a gone label exits from its old index with its value', same(p.exit, [{ from: 0, label: 'A', fromValue: 1 }]), JSON.stringify(p.exit));
  ok('plan: order maps each new slot to the old one (-1 = entering)', same(p.order, [1, 2, -1]), JSON.stringify(p.order));
  ok('plan: dropping one and adding one is not a reorder', p.moved === false);
}
{
  // A sort: the same marks in a new order — every one an update, none enter or leave.
  const p = mp.planTransition(['A', 'B', 'C'], [3, 1, 2], ['B', 'C', 'A'], [1, 2, 3]);
  ok('reorder: nothing enters, nothing leaves', p.enter.length === 0 && p.exit.length === 0);
  ok('reorder: order carries each bar to its new slot', same(p.order, [1, 2, 0]), JSON.stringify(p.order));
  ok('reorder: flagged as moved (the slide)', p.moved === true);
  ok('reorder: values follow the label, not the slot',
    same(p.update.map((u: any) => [u.label, u.fromValue, u.toValue]), [['B', 1, 1], ['C', 2, 2], ['A', 3, 3]]));
}
{
  // Duplicates: the k-th occurrence before is the k-th after.
  const p = mp.planTransition(['N/A', 'X', 'N/A'], null, ['N/A', 'N/A', 'N/A'], null);
  ok('duplicates: matched in order of appearance', same(p.order, [0, 2, -1]), JSON.stringify(p.order));
  ok('duplicates: the extra copy enters, X exits',
    same(p.enter.map((e: any) => e.index), [2]) && same(p.exit.map((e: any) => e.label), ['X']));
}
{
  const p = mp.planTransition([], [], ['A', 'B'], [1, 2]);
  ok('empty old: everything enters', p.enter.length === 2 && p.update.length === 0 && p.exit.length === 0 && same(p.order, [-1, -1]));
  const q = mp.planTransition(['A', 'B'], [1, 2], [], []);
  ok('empty new: everything exits', q.exit.length === 2 && q.enter.length === 0 && q.order.length === 0);
  const r = mp.planTransition([1, 2], null, ['1', '2'], null);
  ok('labels match as text: 1 is "1"', r.update.length === 2 && r.enter.length === 0);
  ok('values are optional', r.update[0].fromValue === undefined);
}
{
  // The first step when bars leave: still the OLD axis, staying bars at their new value.
  const p = mp.planTransition(['A', 'B', 'C'], null, ['C', 'A'], null);
  const step = mp.exitStep(p, [5, null, 7], [70, 50]);
  ok('exitStep: old axis, stayers at their new values, a leaving gap stays a gap', same(step, [50, null, 70]), JSON.stringify(step));
  const q = mp.planTransition(['A', 'B'], null, ['A'], null);
  ok('exitStep: a numeric leaver shrinks to 0', same(mp.exitStep(q, [1, 2], [9]), [9, 0]));
}

// ── The ticker's frames ───────────────────────────────────────────────────────
{
  const f = kt.tickFrames(100, 250, 400, 60);
  ok('ticker: 400 ms at 60 fps is 24 steps (25 frames)', f.length === 25, String(f.length));
  ok('ticker: the first frame is the old figure', Object.is(f[0], 100));
  ok('ticker: the last frame is EXACTLY the new figure', Object.is(f[f.length - 1], 250));
  ok('ticker: monotone up', f.every((v: number, i: number) => i === 0 || v >= f[i - 1]));
  ok('ticker: eased — the first half covers more than half the distance', f[12] - 100 > 75, String(f[12]));
  const d = kt.tickFrames(0.3, 0.1, 400, 60);
  ok('ticker: monotone down, and lands on 0.1 not 0.1000000001', d.every((v: number, i: number) => i === 0 || v <= d[i - 1]) && Object.is(d[d.length - 1], 0.1));
  ok('ticker: reduced motion is one frame — the new figure', same(kt.tickFrames(100, 250, 400, 60, true), [250]));
  ok('ticker: no duration is one frame', same(kt.tickFrames(1, 2, 0, 60), [2]));
  ok('ticker: valueAt clamps both ends', Object.is(kt.tickValueAt(1, 9, -1), 1) && Object.is(kt.tickValueAt(1, 9, 2), 9));
  ok('ticker: the ease starts at 0 and ends at 1', kt.tickEase(0) === 0 && kt.tickEase(1) === 1);
  ok('ticker: the duration is the spec\'s 400 ms', kt.KPI_TICK_MS === 400);
}

finish();
