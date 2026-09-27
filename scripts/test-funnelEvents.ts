'use strict';

// Self-check for src/analysis/funnelEvents.ts and src/engine/funnelResident.ts.
//
// First the semantics a second implementation cannot vouch for: STRICT order
// (a step must come strictly after the one before it — a tie does not
// convert), entry at the FIRST step-1 event, window expiry measured from that
// entry, other events in between allowed, exact duplicates counting once, the
// median of an even count being the mean of its two middle gaps, and the
// breakdown value coming from the entry event. Then the house style: a
// DIFFERENTIAL against the resident path, `Object.is` leaf by leaf, over the
// same Parquet bytes — including the bundled sample.
//
//   npm run build:ts && node scripts/test-funnelEvents.js

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as fe from '../src/analysis/funnelEvents';
import * as funnelResident from '../src/engine/funnelResident';
import * as pq from '../src/engine/parquetStore';
import * as duck from '../src/engine/duckdb';
import { parseCsv } from '../src/data/parse';
import type { ParsedColumn } from '../src/data/parse';
import type { Cell, FilterStep } from '../src/data/transforms';
import type { EventFunnel, FunnelEncoding } from '../src/analysis/funnelEvents';
import { ok, finish } from './selfcheck';

const COLS: ParsedColumn[] = [
  { name: 'user', type: 'text' }, { name: 'event', type: 'text' },
  { name: 'ts', type: 'date' }, { name: 'plan', type: 'text' }, { name: 'tier', type: 'number' },
];

function enc(over: Partial<FunnelEncoding> = {}): FunnelEncoding {
  return { entity: 'user', event: 'event', time: 'ts', steps: ['signup', 'trial', 'purchase'], window: { n: 7, unit: 'days' }, ...over };
}
const run = (rows: Cell[][], e: FunnelEncoding, filters?: FilterStep[], cols = COLS): EventFunnel =>
  fe.buildEventFunnel(cols, rows, e, filters).funnel;

/** `2024-03-01` + h hours, as a stored timestamp cell. */
function at(h: number): string {
  const ms = Date.UTC(2024, 2, 1) + h * 3_600_000;
  return new Date(ms).toISOString().replace('.000Z', '').replace('T', ' ');
}

// ── 1. The timestamp grammar ─────────────────────────────────────────────────

function testTimestamps(): void {
  const base = Date.UTC(2024, 2, 5);
  ok('YYYY-MM-DD reads as midnight', fe.eventMs('2024-03-05') === base);
  ok('a space and HH:MM', fe.eventMs('2024-03-05 10:15') === base + 36_900_000);
  ok('ISO with T, seconds, fraction and Z', fe.eventMs('2024-03-05T10:15:07.1234Z') === base + 36_907_123);
  for (const bad of ['2024/03/05', '03/05/2024', '2024-03-05T25:00', '2024-02-30', '2024-03-05T10:15:07+02:00',
    ' 2024-03-05', '2024-3-5', 'Mar 5 2024', '']) {
    ok(`rejected: ${JSON.stringify(bad)}`, fe.eventMs(bad) === null);
  }
}

// ── 2. Strict order, entry, window, duplicates ───────────────────────────────

function testStrictOrder(): void {
  const rows: Cell[][] = [
    ['a', 'signup', at(0), 'x', 1], ['a', 'purchase', at(1), 'x', 1], ['a', 'trial', at(2), 'x', 1], ['a', 'purchase', at(3), 'x', 1],
    ['b', 'signup', at(0), 'x', 1], ['b', 'purchase', at(1), 'x', 1], ['b', 'trial', at(2), 'x', 1],
    ['c', 'trial', at(0), 'y', 2], ['c', 'signup', at(1), 'y', 2], ['c', 'view', at(2), 'y', 2], ['c', 'trial', at(3), 'y', 2],
    ['d', 'signup', at(5), 'y', 2], ['d', 'trial', at(5), 'y', 2],
  ];
  const f = run(rows, enc());
  ok('everyone with a signup enters', f.counts[0] === 4, JSON.stringify(f.counts));
  ok('a purchase BEFORE the trial does not count — only the later one does', f.counts[2] === 1);
  ok('a trial before the signup is ignored; one after it (with a view between) converts', f.counts[1] === 3);
  ok('a trial at the SAME instant as the signup is not strictly after it', f.counts.join() === '4,3,1');
  ok('rates: vs step 1 and vs the step before', f.pctOfFirst[1] === 75 && f.pctOfPrev[2] === (1 / 3) * 100);

  const again = run(rows.concat(rows.slice(0, 4), [['b', 'signup', at(0), 'x', 1]]), enc());
  ok('exact duplicate events count once', JSON.stringify(again.counts) === JSON.stringify(f.counts));

  const win: Cell[][] = [
    ['p', 'signup', at(0), 'x', 1], ['p', 'trial', at(168), 'x', 1],
    ['q', 'signup', at(0), 'x', 1], ['q', 'trial', '2024-03-08 00:00:00.001', 'x', 1],
    ['r', 'signup', at(0), 'x', 1], ['r', 'signup', at(240), 'x', 1], ['r', 'trial', at(241), 'x', 1],
  ];
  const w = run(win, enc({ steps: ['signup', 'trial'] }));
  ok('exactly the window converts; one millisecond past it does not', w.counts.join() === '3,1', JSON.stringify(w.counts));
  ok('the window runs from the FIRST signup, not a later one', w.counts[1] === 1);
  const h = run(win, enc({ steps: ['signup', 'trial'], window: { n: 1, unit: 'hours' } }));
  ok('an hours window: nobody made it inside one hour', h.counts.join() === '3,0');
  const later = run([['a', 'signup', at(0), 'x', 1], ['a', 'trial', at(1), 'x', 1], ['a', 'purchase', at(200), 'x', 1]], enc());
  ok('a later step is measured from ENTRY, not from the step before', later.counts.join() === '1,1,0');
}

// ── 3. Medians, breakdown, needs, caption ────────────────────────────────────

function testFigures(): void {
  const rows: Cell[][] = [];
  const gaps = [1, 2, 4, 10];
  gaps.forEach((g, i) => { rows.push(['u' + i, 'signup', at(0), i < 3 ? 'pro' : 'free', 1]); rows.push(['u' + i, 'trial', at(g), 'z', 1]); });
  rows.push(['u9', 'signup', at(0), '', 1]);
  const f = run(rows, enc({ steps: ['signup', 'trial'], breakdown: 'plan' }));
  ok('median of an even count is the mean of the two middle gaps (2 h, 4 h → 3 h)', f.medianMs[1] === 3 * 3_600_000, String(f.medianMs[1]));
  ok('step 1 has no median', f.medianMs[0] === null);
  const odd = run(rows.slice(0, 6), enc({ steps: ['signup', 'trial'] }));
  ok('median of an odd count is the middle gap', odd.medianMs[1] === 2 * 3_600_000);
  const labels = f.breakdown ? f.breakdown.groups.map((g) => `${g.label}:${g.counts.join('/')}`).join(' ') : '';
  ok('breakdown: from the ENTRY event, biggest group first, blanks kept', labels === 'pro:3/3 free:1/1 :1/0', labels);
  ok('breakdown rates are per group', !!f.breakdown && f.breakdown.groups[2].pctOfFirst[1] === 0);

  const many: Cell[][] = [];
  for (let i = 0; i < 15; i += 1) many.push(['m' + i, 'signup', at(0), 'p' + i, 1], ['m' + i, 'trial', at(1), 'p' + i, 1]);
  const capped = run(many, enc({ steps: ['signup', 'trial'], breakdown: 'plan' }));
  ok('breakdown is capped and says so; ties keep first-seen order',
     !!capped.breakdown && capped.breakdown.groups.length === fe.FUNNEL_BREAKDOWN_CAP && capped.breakdown.truncated
     && capped.breakdown.groups[0].label === 'p0');

  const excl = run([['a', 'signup', at(0), 'x', 1], ['', 'signup', at(0), 'x', 1], ['b', 'signup', 'soon', 'x', 1], ['c', 'other', 'bad', 'x', 1]], enc());
  ok('rows with an empty entity or unreadable timestamp are excluded and counted', excl.excluded === 3 && excl.counts[0] === 1);

  ok('needs: fewer than two steps', /two steps/.test(run([], enc({ steps: ['signup'] })).needs));
  ok('needs: a missing timestamp column', /timestamp/.test(run([], enc({ time: '' })).needs));
  const s = fe.sanitizeEventFunnel({ entity: 'u', event: 'e', time: 't', steps: ['a', '', 3, 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'],
    window: { n: -1, unit: 'weeks' }, breakdown: '', extra: true });
  ok('sanitize: steps are non-empty strings, at most eight; a bad window becomes 7 days; stray keys dropped',
     !!s && s.steps.join('') === 'abcdefgh' && s.window.n === 7 && s.window.unit === 'days' && !('breakdown' in s) && !('extra' in s),
     JSON.stringify(s));

  ok('caption', fe.funnelCaption(run(rows, enc({ steps: ['signup', 'trial', 'purchase'] })))
     === '5 entered signup; 0% reached purchase within 7 days; the biggest drop is trial → purchase (100% lost)');
  ok('duration words', fe.durationText(90_000) === '1.5 min' && fe.durationText(3 * 86_400_000) === '3 d');
}

// ── 4. The differential ──────────────────────────────────────────────────────

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-funnel-'));
let seq = 0;

function fixture(columns: ParsedColumn[], rows: Cell[][]): { src: { parquetPath: string; columns: ParsedColumn[] }; rows: Cell[][]; columns: ParsedColumn[] } {
  const file = path.join(dir, `t${seq++}.parquet`);
  pq.writeTable(file, columns, rows);
  const back = pq.readTable(file, columns);
  if (!back) throw new Error('fixture read-back failed');
  return { src: { parquetPath: file, columns }, rows: back.rows, columns: back.columns };
}

function firstDiff(a: unknown, b: unknown, where = '$'): string {
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return `${where}.length ${a.length} vs ${b.length}`;
    for (let i = 0; i < a.length; i += 1) { const d = firstDiff(a[i], b[i], `${where}[${i}]`); if (d) return d; }
    return '';
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    for (const k of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
      const d = firstDiff((a as any)[k], (b as any)[k], `${where}.${k}`); // any: generic walk
      if (d) return d;
    }
    return '';
  }
  return Object.is(a, b) ? '' : `${where}: ${String(a)} vs ${String(b)}`;
}

function diff(label: string, f: ReturnType<typeof fixture>, e: FunnelEncoding, filters?: FilterStep[]): void {
  const js = fe.buildEventFunnel(f.columns, f.rows, e, filters).funnel;
  const res = funnelResident.eventFunnelResident(f.src, e, filters);
  ok(`${label}: resident answered`, !!res);
  if (!res) return;
  const d = firstDiff(js, res);
  ok(`${label}: resident ≡ JS, Object.is leaf by leaf`, d === '', d);
}

function testDifferential(): void {
  const rows: Cell[][] = [
    ['a', 'signup', '2024-03-01T09:00:00Z', 'pro', 1], ['a', 'trial', '2024-03-01 09:30', 'x', 1], ['a', 'purchase', '2024-03-02', 'x', 1],
    ['a', 'signup', '2024-03-01T09:00:00Z', 'free', 1], ['a', 'trial', '2024-03-01 09:30', 'x', 1],
    ['b', 'signup', '2024-03-03 12:00:00.5', '', 2], ['b', 'trial', '2024-03-03 12:00:00.5', '', 2], ['b', 'trial', '2024-03-04 12:00:00.25', '', 2],
    ['b', 'purchase', '2024-03-20', '', 2], ['c', 'signup', '2024-03-05', null, null], ['c', 'view', '2024-03-05 01:00', null, null],
    ['c', 'trial', '2024-03-06', null, null], ['c', 'purchase', '2024-03-07T00:00:00.999', null, null],
    ['d', 'trial', '2024-03-01', 'pro', 3], ['d', 'signup', '2024-03-02', 'pro', 3], ['d', 'purchase', '2024-03-03', 'pro', 3],
    ['e', 'signup', '2024-03-01', '  ', 1], ['e', 'trial', '2024-03-01 00:00:01', '  ', 1], ['e', 'purchase', '2024-03-01 00:00:02', '  ', 1],
    ['', 'signup', '2024-03-01', 'x', 1], ['  ', 'signup', '2024-03-01', 'x', 1], ['f', 'signup', 'bad', 'x', 1], ['g', 'signup', '2024-02-30', 'x', 1],
    ['007', 'signup', '2024-03-01', 'x', 1], ['7', 'signup', '2024-03-01', 'y', 1], ['7', 'trial', '2024-03-02', 'y', 1],
  ];
  const f = fixture(COLS, rows);
  diff('diff/three steps', f, enc());
  diff('diff/text breakdown (null, blank, whitespace)', f, enc({ breakdown: 'plan' }));
  diff('diff/number breakdown', f, enc({ breakdown: 'tier' }));
  diff('diff/hours window', f, enc({ window: { n: 1.5, unit: 'hours' } }));
  diff('diff/repeated step name', f, enc({ steps: ['signup', 'trial', 'trial', 'purchase'] }));
  diff('diff/filtered', f, enc({ breakdown: 'plan' }), [{ type: 'filter', column: 'tier', op: '>', value: 1 }]);
  diff('diff/filtered-to-nothing', f, enc(), [{ type: 'filter', column: 'plan', op: '=', value: 'none' }]);
  diff('diff/nobody enters', f, enc({ steps: ['nope', 'trial'] }));
  diff('diff/empty-table', fixture(COLS, []), enc({ breakdown: 'plan' }));
  const numCols: ParsedColumn[] = [{ name: 'user', type: 'number' }, { name: 'event', type: 'text' }, { name: 'ts', type: 'date' }];
  diff('diff/number entity', fixture(numCols, [[1, 'signup', '2024-03-01'], [1.0, 'trial', '2024-03-02'], [null, 'signup', '2024-03-01'], [2, 'signup', '2024-03-01']]),
       enc({ steps: ['signup', 'trial'] }));
  ok('a number-typed event column declines the resident path',
     funnelResident.eventFunnelResident({ parquetPath: f.src.parquetPath, columns: COLS.map((c) => (c.name === 'event' ? { ...c, type: 'number' as const } : c)) },
       enc()) === null);
}

function testSample(): void {
  const csv = path.join(__dirname, '..', 'assets', 'samples', 'retail-orders.csv');
  if (!fs.existsSync(csv)) { ok('sample: assets/samples/retail-orders.csv exists', false, csv); return; }
  const parsed = parseCsv(fs.readFileSync(csv, 'utf8'), ',');
  const f = fixture(parsed.columns, parsed.rows);
  const e: FunnelEncoding = {
    entity: 'state', event: 'category', time: 'order_date', steps: ['Office Supplies', 'Furniture', 'Technology'],
    window: { n: 30, unit: 'days' }, breakdown: 'region',
  };
  diff('sample/state funnel, 30 days, by region', f, e);
  diff('sample/two steps, 3 days, by segment', f, { ...e, steps: ['Technology', 'Furniture'], window: { n: 3, unit: 'days' }, breakdown: 'customer_segment' });
  diff('sample/filtered to West', f, e, [{ type: 'filter', column: 'region', op: '=', value: 'West' }]);
  const js = fe.buildEventFunnel(f.columns, f.rows, e).funnel;
  ok('sample: a real funnel — counts never increase down the steps', js.counts[0] > 0 && js.counts.every((c, k) => k === 0 || c <= js.counts[k - 1]),
     JSON.stringify(js.counts));
}

function main(): void {
  testTimestamps();
  testStrictOrder();
  testFigures();
  let bridge = false;
  try { bridge = duck.isAvailable(); } catch { bridge = false; }
  if (!bridge) console.log('ok   (skipped) the DuckDB bridge is unavailable — differential not run');
  else { testDifferential(); testSample(); }
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  finish();
}

main();
