// A fired alert says WHERE its change came from (src/ipc/alertDiagnosis.ts).
//
//   fire       a period-over-period rule that fires carries `diagnosis`: the
//              key-drivers caption over the rule's own two periods — it names
//              the member that moved, and it is word for word what the Why
//              drawer's engine (ipc/drivers.driversFor) says for the same rule
//   agree      the breakdown is of the SAME change the alert reports: its two
//              totals are the event's `value` and `previous` (Object.is)
//   stored     the line survives the write and the read (sanitizeEvent)
//   quiet      NEGATIVE CONTROLS: a threshold rule and a "since the last
//              refresh" rule fire WITHOUT a diagnosis — there are no two
//              periods of rows to compare; a dataset with nothing to break the
//              change down by fires without one too
//   post       the Slack / Teams note is the sentence followed by the line
//
//   npm run build:ts && node scripts/test-alertDiagnosis.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-alertdx-'));
process.env.ORDINATE_LOCAL_DIR = tmp;

const projects: typeof import('../src/app/projects') = require('../src/app/projects');
const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
const alertStore: typeof import('../src/analysis/alertStore') = require('../src/analysis/alertStore');
const drivers: typeof import('../src/ipc/drivers') = require('../src/ipc/drivers');
const posts: typeof import('../src/server/subscriptions/alertPosts') = require('../src/server/subscriptions/alertPosts');

const show = (v: unknown): string => JSON.stringify(v).slice(0, 400);

// January → February: Safari loses 300 of its 400 signups, Chrome gains 10.
const ROWS: Array<[string, string, number]> = [
  ['2024-01-15', 'Safari', 400], ['2024-01-15', 'Chrome', 500], ['2024-01-15', 'Firefox', 100],
  ['2024-02-15', 'Safari', 100], ['2024-02-15', 'Chrome', 510], ['2024-02-15', 'Firefox', 100],
];

async function main(): Promise<void> {
  const pid = (await projects.createProject('Alert diagnosis')).id;
  const ds = await datasets.saveDataset(pid, {
    name: 'Signups', sourceKind: 'csv',
    columns: [{ name: 'day', type: 'date' }, { name: 'browser', type: 'text' }, { name: 'signups', type: 'number' }] as any,
    rows: ROWS,
  });
  const flat = await datasets.saveDataset(pid, {
    name: 'Totals', sourceKind: 'csv',
    columns: [{ name: 'day', type: 'date' }, { name: 'signups', type: 'number' }] as any,
    rows: [['2024-01-15', 1000], ['2024-02-15', 700]],
  });
  ok('fixture datasets saved', !!ds && !!flat);
  if (!ds || !flat) return;

  const metric = { column: 'signups', aggregation: 'sum', label: 'Signups' };
  const change = (vs: string) => ({ direction: 'down', pct: 10, vs, periodColumn: 'day' });
  const period = await alertStore.saveRule(pid, { name: 'Signups drop', datasetId: ds.id, metric, compare: 'change', change: change('previous_period'), enabled: true });
  const level = await alertStore.saveRule(pid, { name: 'Signups low', datasetId: ds.id, metric, compare: 'threshold', threshold: { op: '<', value: 5000 }, enabled: true });
  const refresh = await alertStore.saveRule(pid, { name: 'Since refresh', datasetId: ds.id, metric, compare: 'change', change: change('previous_refresh'), lastValue: 5000, enabled: true });
  const bare = await alertStore.saveRule(pid, { name: 'Totals drop', datasetId: flat.id, metric, compare: 'change', change: change('previous_period'), enabled: true });
  ok('fixture rules saved', !!period && !!level && !!refresh && !!bare, show([period, level, refresh, bare]));
  if (!period || !level || !refresh || !bare) return;

  const fired = await alertStore.evaluateProject(pid);
  const of = (id: string) => fired.find((e) => e.ruleId === id);
  const ev = of(period.id);
  ok('the period-over-period rule fires', !!ev && ev.value === 710 && ev.previous === 1000, show(fired));
  if (!ev) return;

  // ── fire ───────────────────────────────────────────────────────────────
  ok('its event says where the change came from, naming the member that moved', typeof ev.diagnosis === 'string' && ev.diagnosis.includes('Safari'), show(ev));
  const spec = await drivers.specForRule(pid, period);
  const why = spec ? await drivers.driversFor(pid, spec) : null;
  ok('word for word what the Why drawer\'s engine says for the same rule', !!why && why.ok && ev.diagnosis === why.caption, show([ev.diagnosis, why]));

  // ── agree ──────────────────────────────────────────────────────────────
  ok('the breakdown is of the same change the alert reports', !!why && why.ok && Object.is(why.totals.a, ev.value) && Object.is(why.totals.b, ev.previous), show(why && why.ok && why.totals));

  // ── stored ─────────────────────────────────────────────────────────────
  const read = (await alertStore.load(pid)).events.find((e) => e.id === ev.id);
  ok('the line is stored with the event', !!read && read.diagnosis === ev.diagnosis, show(read));

  // ── quiet ──────────────────────────────────────────────────────────────
  const lv = of(level.id);
  const rf = of(refresh.id);
  const br = of(bare.id);
  ok('NEGATIVE CONTROL: a threshold rule fires without a diagnosis', !!lv && !('diagnosis' in lv), show(lv));
  ok('NEGATIVE CONTROL: a "since the last refresh" rule fires without one', !!rf && !('diagnosis' in rf), show(rf));
  ok('NEGATIVE CONTROL: nothing to break the change down by → no line', !!br && !('diagnosis' in br), show(br));

  // ── post ───────────────────────────────────────────────────────────────
  const noteOf = (e: typeof ev) => JSON.stringify(posts.alertMessageModel(pid, period, e));
  ok('post: the sentence, then the line', noteOf(ev).includes(JSON.stringify(`${ev.message} ${ev.diagnosis}`).slice(1, -1)), noteOf(ev));
  ok('post: an event without one posts its sentence alone', !!lv && noteOf(lv).includes(JSON.stringify(lv.message).slice(1, -1)) && !noteOf(lv).includes('Safari'));
}

main()
  .catch((e) => { ok('no exception', false, e && e.stack); })
  .finally(() => {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
    finish();
  });
