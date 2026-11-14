// An answer's period on both doors — the extract's `computeCard` and the Live `liveCardFor` — in server mode against
// the fake warehouse (./liveQueryHarness: the parity fixture as a copy AND as a Live dataset). "Last quarter" is what a
// dashboard date filter means by it: the previous COMPLETE quarter before today, under the workspace calendar
// (ai/answerSpec `answerPeriod`), never the quarter the data's latest row falls in.
//
//   1. THE TRACE. Today 2025-03-15, with rows in 2025-Q1: "last quarter" is 2024-Q4 on both — the same label, steps
//      and figures — and the Live answer asks the warehouse no MAX(). NEGATIVE CONTROL: this quarter has rows of its
//      own, another chart, which the old rule (the data's latest quarter) would have drawn.
//   2. "Same for last year" (yearsBack 1): 2023-Q4 on both.
//   2b. LAST 90 DAYS and YEAR TO DATE: any dashboard preset, the same range on both.
//   3. A FISCAL YEAR from February: the quarter before today's is Nov 2024 – Jan 2025 on both, named by its days.
//   4. A STALE dataset (today 2027-05-01): no rows, and both cards say why in the same sentence — the day the data ends
//      is the copy's latest cell and the warehouse's MAX(), the same day. NEGATIVE CONTROL: an empty answer whose data
//      reaches into its period says no such thing.
//
//   npm run build:ts && node scripts/test-answerPeriodsLive.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import * as H from './liveQueryHarness';
import type { AnswerFilter, AnswerSpec } from '../src/ai/answerSpec';

const answers: typeof import('../src/ipc/answers') = require('../src/ipc/answers');
const A: typeof import('../src/ai/answerSpec') = require('../src/ai/answerSpec');
const dateIntel: typeof import('../src/analysis/dateIntel') = require('../src/analysis/dateIntel');
const format: typeof import('../src/app/format') = require('../src/app/format');
const cmp: typeof import('./liveParityCompare') = require('./liveParityCompare');

const { fake, ORG_A } = H;
const show = (v: unknown): string => JSON.stringify(v);
const TODAY = process.env.ORDINATE_TODAY; // the harness's pin, inside the fixture's dates
type Card = Extract<Awaited<ReturnType<typeof answers.computeCard>>, { card: unknown }>['card'];
type Pair = { live: Card | null; ext: Card | null; maxes: number };

const spec = (datasetId: string, filters: AnswerFilter[]): AnswerSpec => ({
  datasetId, category: 'region', measures: [{ column: 'amt', aggregation: 'sum' }], filters, chartType: 'bar', title: 'Sales by region',
});

/** Both cards of one question, and how many latest-day MAX() statements the Live one sent. Call inside the org. */
async function both(s: H.OrgSetup, filters: AnswerFilter[]): Promise<Pair> {
  H.queryCache.clear();
  const from = fake.calls.length;
  const live = await answers.computeCard(s.projectId, spec(s.liveId, filters));
  const maxes = fake.calls.slice(from).filter((c) => /AS o_l0/.test(c.sql)).length;
  const ext = await answers.computeCard(s.projectId, spec(s.extractId, filters));
  return { live: 'card' in live ? live.card : null, ext: 'card' in ext ? ext.card : null, maxes };
}

/** A card's notes with its dataset's name taken out: the two datasets are named apart. */
const notesOf = (c: Card): string[] => c.notes.map((n) => n.split(c.datasetName).join('<dataset>'));

function agree(label: string, r: Pair): void {
  if (!r.live || !r.ext) {
    ok(`${label}: both cards build`, false, show(r).slice(0, 300));
    return;
  }
  const problems = cmp.compareCharts(r.ext.data, r.live.data, () => true, false);
  ok(`${label}: Live and the copy draw the same chart`, problems.length === 0, problems.join(' | '));
  ok(`${label}: …with the same filter labels, steps and notes`, show(r.live.filterLabels) === show(r.ext.filterLabels)
    && show(r.live.steps) === show(r.ext.steps) && show(notesOf(r.live)) === show(notesOf(r.ext)), show([r.live.filterLabels, r.ext.filterLabels, r.live.steps, r.ext.steps, notesOf(r.live), notesOf(r.ext)]));
}

const bounds = (from: string, to: string) => show([{ type: 'filter', column: 'd', op: '>=', value: from }, { type: 'filter', column: 'd', op: '<=', value: to }]);

async function main(): Promise<void> {
  const s = await H.setupOrg(ORG_A);
  await H.as(ORG_A, async () => {
    // ── 1. The trace ──────────────────────────────────────────────────────────
    const q = await both(s, [{ column: 'd', period: 'last_quarter' }]);
    agree('last quarter on 2025-03-15', q);
    ok('…it is 2024-Q4, the previous complete quarter, on both (never this quarter so far)', q.ext?.filterLabels[0] === 'd: 2024-Q4'
      && show(q.ext?.steps) === bounds('2024-10-01', '2024-12-31') && (q.ext?.data.labels.length ?? 0) > 0, show(q.ext && [q.ext.filterLabels, q.ext.steps]));
    ok('…and the Live answer asked the warehouse no MAX() for it', q.maxes === 0, String(q.maxes));
    const thisQuarter = await both(s, [{ column: 'd', op: '>=', value: '2025-01-01' }]);
    ok('NEGATIVE CONTROL: this quarter has rows of its own — another chart, which the data\'s latest quarter would have drawn',
      (thisQuarter.ext?.data.labels.length ?? 0) > 0 && show(thisQuarter.ext?.data) !== show(q.ext?.data), show(thisQuarter.ext?.data));

    // ── 2. Same for last year ─────────────────────────────────────────────────
    const back = await both(s, [{ column: 'd', period: 'last_quarter', yearsBack: 1 }]);
    agree('last quarter a year back', back);
    ok('…it is 2023-Q4 on both', back.ext?.filterLabels[0] === 'd: 2023-Q4' && show(back.ext?.steps) === bounds('2023-10-01', '2023-12-31') && (back.ext?.data.labels.length ?? 0) > 0);

    // ── 2b. A last-N period and a to-date one: any dashboard preset ──────────
    const days = await both(s, [{ column: 'd', period: 'last_n_days', n: 90 }]);
    agree('the last 90 days', days);
    ok('…it is 2024-12-15 to 2025-03-14 on both, named by its days', days.ext?.filterLabels[0] === 'd: 2024-12-15 to 2025-03-14'
      && show(days.ext?.steps) === bounds('2024-12-15', '2025-03-14'), show(days.ext && [days.ext.filterLabels, days.ext.steps]));
    const ytd = await both(s, [{ column: 'd', period: 'ytd' }]);
    agree('year to date', ytd);
    ok('…it runs 2025-01-01 to today on both', show(ytd.ext?.steps) === bounds('2025-01-01', '2025-03-15'), show(ytd.ext?.steps));

    // ── 3. A fiscal year from February ────────────────────────────────────────
    const was = dateIntel.getCalendar();
    dateIntel.setCalendar({ ...was, fiscalYearStart: 2 });
    try {
      const fiscal = await both(s, [{ column: 'd', period: 'last_quarter' }]);
      agree('a fiscal year from February', fiscal);
      ok('…the quarter before today\'s is Nov 2024 – Jan 2025, named by its days, as a dashboard filter resolves it', fiscal.ext?.filterLabels[0] === 'd: 2024-11-01 to 2025-01-31'
        && show(fiscal.ext?.steps) === bounds('2024-11-01', '2025-01-31') && show(dateIntel.resolvePeriodNow({ preset: 'last_quarter' })) === show({ from: '2024-11-01', to: '2025-01-31' }),
      show(fiscal.ext && [fiscal.ext.filterLabels, fiscal.ext.steps]));
    } finally {
      dateIntel.setCalendar(was);
    }

    // ── 4. A stale dataset ────────────────────────────────────────────────────
    const ends = A.latestDate(H.fx.fixtureRows().map((r) => r[6]))!; // the reference: the copy's own latest cell
    const endsIso = dateIntel.isoFromDays(Date.UTC(ends.y, ends.m - 1, ends.d) / 86400000);
    process.env.ORDINATE_TODAY = '2027-05-01';
    try {
      const stale = await both(s, [{ column: 'd', period: 'last_quarter' }]);
      agree('a dataset that ends before the period', stale);
      const said = `No rows in 2027-Q1: <dataset> ends on ${format.formatDate(endsIso)}.`;
      ok('…no rows on either, never another period', stale.live?.data.labels.length === 0 && stale.ext?.data.labels.length === 0 && stale.ext?.filterLabels[0] === 'd: 2027-Q1');
      ok(`…and both say why: "${said}"`, !!stale.live && !!stale.ext && notesOf(stale.ext).includes(said) && notesOf(stale.live).includes(said), show(stale.ext && [notesOf(stale.ext), stale.live && notesOf(stale.live)]));
      ok('…the warehouse was asked its latest day once, for the note', stale.maxes === 1, String(stale.maxes));
    } finally {
      process.env.ORDINATE_TODAY = TODAY;
    }
    const empty = await both(s, [{ column: 'amt', op: '>', value: 1e12 }, { column: 'd', period: 'last_quarter' }]);
    agree('an empty answer over data that reaches its period', empty);
    ok('NEGATIVE CONTROL: …says nothing of the data ending', empty.ext?.data.labels.length === 0 && !!empty.live && !!empty.ext
      && ![...empty.live.notes, ...empty.ext.notes].some((n) => n.startsWith('No rows in')), show(empty.ext?.notes));
  });
}

main()
  .catch((e) => ok('answer periods suite threw', false, e && (e as Error).stack))
  .finally(() => {
    H.cleanup();
    finish();
  });
