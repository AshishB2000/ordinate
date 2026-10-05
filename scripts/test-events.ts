// Self-check for EVENT ANNOTATIONS (src/analysis/events.ts): placing events on
// a chart's date axis at every grain, scope filtering, the attribution
// sentence insights carry (exact strings), sanitizing and CSV import — plus
// the two places an event leaves the app: the published page's whitelist
// (src/publish/sanitize.ts) and the page's chart config (publishCore.js).
//
//   npm run build:ts && node scripts/test-events.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';

const fs: typeof import('fs') = require('fs');
const path: typeof import('path') = require('path');
const vm: typeof import('vm') = require('vm');
const E: typeof import('../src/analysis/events') = require('../src/analysis/events');
const parse: typeof import('../src/data/parse') = require('../src/data/parse');
const san: typeof import('../src/publish/sanitize') = require('../src/publish/sanitize');

type Ev = import('../src/analysis/events').ProjectEvent;
type Insight = import('../src/analysis/insightsAgg').Insight;
const J = (v: unknown): string => JSON.stringify(v);
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
let n = 0;
const id = (): string => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
const ev = (date: string, title: string, extra: Partial<Ev> = {}): Ev => ({ id: id(), date, title, kind: 'campaign', ...extra });
const at = (marks: ReturnType<typeof E.eventsOnAxis>): string => J(marks.map((m) => [m.from, m.to, m.range]));

// ── 1. On a chart's axis, at every grain ─────────────────────────────────────
{
  const thanks = ev('2024-11-28', 'Thanksgiving', { kind: 'holiday' });
  const campaign = ev('2024-11-24', 'Holiday campaign', { end: '2024-12-31' });

  const day = E.eventsOnAxis([thanks], ['2024-11-27', '2024-11-28', '2024-11-29'], 'day');
  ok('day: a single date is a marker on its own day', at(day) === '[[1,1,false]]');
  ok('day: the marker carries kind, title and its when', day[0].kind === 'holiday' && day[0].title === 'Thanksgiving' && day[0].when === 'Nov 28, 2024');
  ok('day: a date with no bucket on the axis is left off', E.eventsOnAxis([ev('2024-11-30', 'x')], ['2024-11-27', '2024-11-28'], 'day').length === 0);

  const weeks = ['2024-11-18', '2024-11-25', '2024-12-02'];
  ok('week: a Thursday lands in its Monday-start week', at(E.eventsOnAxis([thanks], weeks, 'week')) === '[[1,1,false]]');
  ok('week: a Sunday-to-Tuesday range spans three weeks', at(E.eventsOnAxis([ev('2024-11-24', 'r', { end: '2024-12-03' })], weeks, 'week')) === '[[0,2,true]]');

  const months = ['2024-10', '2024-11', '2024-12', '2025-01'];
  ok('month: a late-November-to-year-end range covers Nov and Dec', at(E.eventsOnAxis([campaign], months, 'month')) === '[[1,2,true]]');
  ok('month: the band\'s when reads as a range', E.eventsOnAxis([campaign], months, 'month')[0].when === 'Nov 24 – Dec 31, 2024');
  ok('month: a range starting before the axis is clipped to it', at(E.eventsOnAxis([ev('2024-08-01', 'r', { end: '2024-10-15' })], months, 'month')) === '[[0,0,true]]');
  ok('month: a range entirely before the axis is left off', E.eventsOnAxis([ev('2023-01-01', 'r', { end: '2023-02-01' })], months, 'month').length === 0);

  ok('quarter: a New Year range spans Q4 and Q1', at(E.eventsOnAxis([ev('2023-12-31', 'r', { end: '2024-01-02' })], ['2023-Q3', '2023-Q4', '2024-Q1'], 'quarter')) === '[[1,2,true]]');
  ok('year: a date lands in its year', at(E.eventsOnAxis([ev('2023-06-01', 'x')], ['2022', '2023', '2024'], 'year')) === '[[1,1,false]]');
  ok('not a date axis: nothing is placed', E.eventsOnAxis([thanks], ['West', 'East'], 'month').length === 0);
  ok('a label of the wrong grain: nothing is placed', E.eventsOnAxis([thanks], ['2024-11', '2024-Q4'], 'month').length === 0);
  ok('two events keep their own order and spans', at(E.eventsOnAxis([campaign, thanks], months, 'month')) === '[[1,2,true],[1,1,false]]');
}

// ── 2. Scope ─────────────────────────────────────────────────────────────────
{
  const any = ev('2024-01-01', 'Everywhere');
  const onA = ev('2024-01-01', 'Only A', { scope: { datasetIds: [A] } });
  const west = ev('2024-01-01', 'West outage', { scope: { filters: [{ type: 'filter', column: 'region', op: 'in', values: ['West'] }] } });
  const f = (column: string, op: string, value?: unknown, values?: unknown[]): any => ({ type: 'filter', column, op, value, values }); // any: a FilterStep literal
  ok('scope: an unscoped event is on every chart', E.inScope(any, B, [f('region', '=', 'East')]));
  ok('scope: a dataset scope keeps its dataset', E.inScope(onA, A) && !E.inScope(onA, B) && !E.inScope(onA, null));
  ok('scope: an unfiltered chart still includes the scoped slice', E.inScope(west, A, []));
  ok('scope: a chart filtered to that value keeps it', E.inScope(west, A, [f('region', '=', 'West')]));
  ok('scope: a chart filtered to another value drops it', !E.inScope(west, A, [f('region', '=', 'East')]));
  ok('scope: an in-list that includes the value keeps it', E.inScope(west, A, [f('region', 'in', undefined, ['East', 'West'])]));
  ok('scope: an in-list without it drops it', !E.inScope(west, A, [f('region', 'in', undefined, ['East', 'North'])]));
  ok('scope: a filter on another column, or not an equality, says nothing', E.inScope(west, A, [f('channel', '=', 'Web'), f('region', 'contains', 'Ea')]));
}

// ── 3. Attribution: the sentence insights carry ──────────────────────────────
{
  const campaign = ev('2023-11-24', 'Holiday campaign', { end: '2023-12-31' });
  const mover: Insight = {
    id: `${A}:mover:region:revenue:West:2023-11`, kind: 'mover',
    title: 'West revenue rose 18% in 2023-11',
    detail: 'revenue for "West" rose from 100 in 2023-10 to 118 in 2023-11 — a change of 18 (18%).',
    severity: 'info', datasetId: A, column: 'region', periodKey: '2023-11',
    facts: { category: 'West', measure: 'revenue', pctChange: 0.18 },
    chart: { type: 'line', encoding: {} as any, filters: [{ type: 'filter', column: 'region', op: '=', value: 'West' }] }, // any: the encoding is not read here
  };
  const trend: Insight = { ...mover, id: 't', kind: 'trend', title: 'revenue trended up 30% over 12 periods', periodKey: '2023-11' };
  const [named, untouched] = E.attributeInsights([mover, trend], [campaign]);
  ok('attribution: the title names the event', named.title === "West revenue rose 18% in 2023-11, during 'Holiday campaign'", named.title);
  ok('attribution: the detail says when it ran',
    named.detail === 'revenue for "West" rose from 100 in 2023-10 to 118 in 2023-11 — a change of 18 (18%). It falls during \'Holiday campaign\' (Nov 24 – Dec 31, 2023).', named.detail);
  ok('attribution: the facts carry it for the dock', named.facts.event === 'Holiday campaign' && named.facts.eventKind === 'campaign' && named.facts.eventWhen === 'Nov 24 – Dec 31, 2023');
  ok('attribution: the cached original is not mutated', mover.title === 'West revenue rose 18% in 2023-11' && !('event' in mover.facts));
  ok('attribution: a trend is not a change point', untouched === trend);
  ok('attribution: no events → the very same list', E.attributeInsights([mover], []).length === 1 && E.attributeInsights([mover], [])[0] === mover);

  const launch = ev('2023-11-07', 'v2 launch', { kind: 'launch' });
  const two = E.attributeInsights([mover], [campaign, launch])[0];
  ok('attribution: two events, earliest first', two.title === "West revenue rose 18% in 2023-11, during 'v2 launch' and 'Holiday campaign'", two.title);
  const three = E.attributeInsights([mover], [campaign, launch, ev('2023-11-30', 'Outage', { kind: 'incident' })])[0];
  ok('attribution: past two, the rest are counted', three.title === "West revenue rose 18% in 2023-11, during 'v2 launch', 'Holiday campaign' and 1 more", three.title);
  ok('attribution: an event outside the period is not named', E.attributeInsights([mover], [ev('2023-12-02', 'Later')])[0] === mover);
  const east = ev('2023-11-10', 'East promo', { scope: { filters: [{ type: 'filter', column: 'region', op: 'in', values: ['East'] }] } });
  ok('attribution: a mover in another slice than the event\'s scope is not named', E.attributeInsights([mover], [east])[0] === mover);
  ok('attribution: a dataset-scoped event elsewhere is not named', E.attributeInsights([mover], [ev('2023-11-10', 'B only', { scope: { datasetIds: [B] } })])[0] === mover);

  const anomaly: Insight = { ...mover, id: 'p', kind: 'period_change', title: 'revenue rose 40% in 2023-11-28', detail: 'Up 40%.', periodKey: '2023-11-28', chart: undefined };
  ok('attribution: a day-level change point inside a range', E.attributeInsights([anomaly], [campaign])[0].title === "revenue rose 40% in 2023-11-28, during 'Holiday campaign'");
  ok('attribution: a US-shaped day key parses too', E.periodSpan('11/28/2023') !== null && J(E.periodSpan('11/28/2023')) === J(E.periodSpan('2023-11-28')));
  ok('attribution: quarter and year keys cover their days', E.periodSpan('2023-Q4')!.to - E.periodSpan('2023-Q4')!.from === 91 && E.periodSpan('2024')!.to - E.periodSpan('2024')!.from === 365);
  ok('drivers clause: appended before the caption\'s full stop',
    'Revenue fell $412K; West explains 61%.'.replace(/\.$/, '') + E.duringClause([campaign]) + '.' === "Revenue fell $412K; West explains 61%, during 'Holiday campaign'.");
  ok('drivers: a range with an open end is not matched', E.dateRangeSpan({ from: '2023-11-01' }) === null && E.dateRangeSpan({ from: '2023-11-01', to: '2023-11-30' }) !== null);
}

// ── 4. Sanitizing and CSV import ─────────────────────────────────────────────
{
  const s = E.sanitizeEvent({ id: A, date: '2024-12-31', end: '2024-11-24', title: '  Holiday \n campaign ', kind: 'nonsense', scope: { datasetIds: [A, 'nope'], filters: [{ column: 'region', op: '=', value: 'West' }] } });
  ok('sanitize: reversed dates are swapped, the title tidied, an unknown kind is other',
    !!s && s.date === '2024-11-24' && s.end === '2024-12-31' && s.title === 'Holiday campaign' && s.kind === 'other');
  ok('sanitize: scope keeps UUIDs only and turns = into a one-value in',
    !!s && J(s.scope) === J({ datasetIds: [A], filters: [{ type: 'filter', column: 'region', op: 'in', values: ['West'] }] }));
  ok('sanitize: an end on the start day is a single date', !('end' in (E.sanitizeEvent({ id: A, date: '2024-01-01', end: '2024-01-01', title: 't' }) || {})));
  ok('sanitize: no id, no date or no title is not an event',
    E.sanitizeEvent({ id: '../x', date: '2024-01-01', title: 't' }) === null && E.sanitizeEvent({ id: A, date: 'soon', title: 't' }) === null && E.sanitizeEvent({ id: A, date: '2024-01-01', title: ' ' }) === null);

  const csv = 'Date,End,Title,Kind\n2024-11-25,2024-12-31,Holiday campaign,Campaign\n11/28/2024,,Thanksgiving,holiday\nnot a date,,Bad,launch\n2024-01-01,,,launch\n';
  const p = parse.parseCsv(csv);
  const got = E.eventsFromTable(p.columns, p.rows, id);
  ok('csv: two readable rows become events, two are skipped', got.events.length === 2 && got.skipped === 2, J(got));
  ok('csv: a US date is stored as ISO, a kind in any case is read', got.events[1].date === '2024-11-28' && got.events[0].kind === 'campaign' && got.events[1].kind === 'holiday');
  ok('csv: a range keeps its end', got.events[0].end === '2024-12-31');
  const bad = parse.parseCsv('when,what\n2024-01-01,x\n');
  ok('csv: without a title column it says what it needs', !!E.eventsFromTable(bad.columns, bad.rows, id).error);
}

// ── 5. Leaving the app: the published page ───────────────────────────────────
{
  const out: any = san.sanitizePayload({ // any: the sanitizer returns an untyped payload object
    labels: ['2024-01', '2024-02'], series: [{ label: 's', values: [1, 2] }],
    events: [
      { id: A, kind: 'launch', title: 'v2 launch', when: 'Jan 2, 2024', from: 0, to: 0, range: false, scope: { datasetIds: [A] }, secret: 'x' },
      { kind: 'evil', title: 'Band', when: 'w', from: 1, to: 9, range: true },
      { kind: 'launch', title: '', from: 0, to: 0 },
      { kind: 'launch', title: 'Off the axis', from: 5, to: 6 },
    ],
  });
  ok('publish: only kind, title, when and two indices reach a page',
    J(out.events) === J([
      { kind: 'launch', title: 'v2 launch', when: 'Jan 2, 2024', from: 0, to: 0, range: false },
      { kind: 'other', title: 'Band', when: 'w', from: 1, to: 1, range: true },
    ]), J(out.events));

  const ctx: any = {}; // any: a bare vm global the page core's functions land on
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src', 'publish', 'site', 'publishCore.js'), 'utf8'), ctx);
  const cfg = ctx.pkChartConfig('line', { labels: ['a', 'b'], series: [{ label: 's', values: [1, 2] }], events: out.events }, [], String);
  ok('publish: a line chart with events gets the marker plugin', Array.isArray(cfg.plugins) && cfg.plugins.length === 1 && cfg.plugins[0].id === 'pkEvents');
  ok('publish: without events, no plugin', ctx.pkChartConfig('line', { labels: ['a'], series: [] }, [], String).plugins.length === 0);
}

finish();
