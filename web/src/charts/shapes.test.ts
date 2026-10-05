// The pure shapes behind the waterfall, Pareto, calendar heatmap, radar and
// bullet charts — ./shapes.ts, what the chart engine's plugins draw from.
//
// Hand-computed expectations on purpose: these ARE the reference arithmetic.
// Ported from scripts/test-chartShapes.ts at the T8.1 cutover, where the same
// checks pinned the desktop's chartShapes.js; ./legacy.test.ts holds this port
// to that file's recorded configs, and scripts/test-captions.ts holds the
// captions' server-side twin to its recorded figures.

import { describe, expect, it } from 'vitest';
import * as portShapes from './shapes';

describe("chart shapes: waterfall, Pareto, calendar, radar, bullet", () => {
  it('every check holds', () => {
    const fails: string[] = [];
    const ok = (label: string, cond: boolean, extra?: unknown): void => {
      if (!cond) fails.push(label + (extra === undefined ? '' : '  ' + String(extra)));
    };
    const failureCount = (): number => fails.length;
    // any: the checks index loosely into the shapes, as they did against the desktop file
    const shapes = portShapes as unknown as {
      waterfallSteps: (labels: any[], series: any[], totals?: string[] | null) => any;
      paretoShape: (labels: any[], values: any[]) => any;
      calendarCells: (labels: any[], values: any[]) => any;
      calendarBands: (weeks: number, w: number, h: number, gapRows: number) => { bands: number; perRow: number; rows: number };
      radarShape: (labels: any[], series: any[]) => any;
      bulletShape: (labels: any[], series: any[], target?: number | null) => any;
    };
    const { waterfallSteps, paretoShape, calendarCells, calendarBands, radarShape, bulletShape } = shapes;

    const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
    const s1 = (values: any[], name = 'sum of revenue') => [{ name, values }];

    // ── Waterfall ────────────────────────────────────────────────────────────────

    {
      const w = waterfallSteps(['A', 'B', 'C'], s1([100, -30, 50]));
      ok('waterfall: steps run from 0, and a Total bar closes them',
         same(w.labels, ['A', 'B', 'C', 'Total']) && same(w.kind, ['up', 'down', 'up', 'end']), JSON.stringify(w));
      ok('…each bar floats from the running level before it',
         same(w.base, [0, 100, 70, 0]) && same(w.delta, [100, -30, 50, 120]), JSON.stringify({ base: w.base, delta: w.delta }));
      ok('…the running level after each bar is what the connector draws at',
         same(w.running, [100, 70, 120, 120]), JSON.stringify(w.running));
      ok('…start 0, end 120, and src points back at the input rows',
         w.from === 0 && w.to === 120 && same(w.src, [0, 1, 2, -1]));
    }

    {
      // The totals rule: a LABELLED subtotal/total, and the override naming one.
      const w = waterfallSteps(['Opening', 'Sales', 'Returns', 'Subtotal', 'Fees', 'Grand total'],
        s1([500, 200, -50, null, -20, 630]), ['Opening']);
      ok('waterfall: a named total (override) opens the chart at its own value',
         w.kind[0] === 'total' && w.base[0] === 0 && w.delta[0] === 500 && w.from === 500, JSON.stringify(w.kind));
      ok('…an empty "Subtotal" is drawn at the running level',
         w.kind[3] === 'total' && w.delta[3] === 650 && w.running[3] === 650, JSON.stringify(w.delta));
      ok('…steps after it continue from there',
         w.base[4] === 650 && w.running[4] === 630);
      ok('…a total-labelled LAST category closes the chart itself — no extra Total bar',
         w.labels.length === 6 && w.kind[5] === 'total' && w.to === 630, JSON.stringify(w.labels));
      ok('…"Sub-total" and "total 2024" also read as totals, "Totally" does not',
         same(waterfallSteps(['Sub-total', 'total 2024', 'Totally'], s1([1, 2, 3])).kind, ['total', 'total', 'up', 'end']));
    }

    {
      const w = waterfallSteps(['A', 'B'], s1([null, 'n/a']));
      ok('waterfall: a non-numeric cell is a zero step, not NaN', same(w.running, [0, 0, 0]) && w.to === 0);
    }

    {
      // Two series = a BRIDGE (period over period): start = sum of the first,
      // one step per category = second − first, end = sum of the second.
      const w = waterfallSteps(['Tech', 'Furniture', 'Office', 'Total'], [
        { name: '2023', values: [1000, 800, 300, 2100] },
        { name: '2024', values: [1300, 700, 300, 2300] },
      ]);
      ok('bridge: start bar, one step per category, end bar — the Total row left out',
         same(w.labels, ['2023', 'Tech', 'Furniture', 'Office', '2024'])
         && same(w.kind, ['start', 'up', 'down', 'up', 'end']), JSON.stringify(w));
      ok('…start and end are the two sums',
         w.from === 2100 && w.to === 2300 && w.delta[0] === 2100 && w.delta[4] === 2300);
      ok('…and the steps walk from one to the other',
         same(w.delta.slice(1, 4), [300, -100, 0]) && same(w.running, [2100, 2400, 2300, 2300, 2300]),
         JSON.stringify(w.running));
    }

    // ── Pareto ───────────────────────────────────────────────────────────────────

    {
      const p = paretoShape(['C', 'A', 'D', 'B'], [10, 50, 5, 35]);
      ok('pareto: sorted descending', same(p.labels, ['A', 'B', 'C', 'D']) && same(p.values, [50, 35, 10, 5]));
      ok('…cumulative percent of the total', same(p.cumPct, [50, 85, 95, 100]), JSON.stringify(p.cumPct));
      ok('…two categories reach 80%', p.count80 === 2 && p.total === 100);
      ok('…and src maps each bar back to its input row', same(p.src, [1, 3, 0, 2]));
    }

    {
      const p = paretoShape(['A', 'B', 'C', 'D', 'E'], [40, 40, 20, 0, 0]);
      ok('pareto: ties keep category order', same(p.labels, ['A', 'B', 'C', 'D', 'E']));
      ok('…and exactly 80% counts as reaching it', p.count80 === 2 && p.cumPct[1] === 80, JSON.stringify(p.cumPct));
    }

    {
      const p = paretoShape(['A', 'B', 'C', 'D'], [60, -30, 40, null]);
      ok('pareto: negatives are ignored in the total and the line',
         p.total === 100 && same(p.values, [60, 40, -30, null]) && same(p.cumPct, [60, 100, 100, 100]),
         JSON.stringify(p));
      ok('…so the 80% count is over the positive share', p.count80 === 2);
    }

    {
      const p = paretoShape(['A', 'B'], [0, 0]);
      ok('pareto: all-zero has no 80% and a flat line', p.count80 === 0 && same(p.cumPct, [0, 0]));
      ok('pareto: one dominant category is the 80% alone', paretoShape(['A', 'B', 'C'], [90, 5, 5]).count80 === 1);
    }

    // ── Calendar ─────────────────────────────────────────────────────────────────

    {
      // 2023-12-28 is a Thursday; 2024-01-01 a Monday. The week index must run ON
      // across the year boundary, not restart at week 0 in January.
      const labels = ['2023-12-28', '2023-12-29', '2024-01-01', '2024-01-07', '2024-01-08'];
      const cal = calendarCells(labels, [5, 7, 3, 1, 9]);
      const at = (d: string) => cal.cells.find((c: any) => c.date === d);
      ok('calendar: every day in range is a cell, gaps included (Dec 28 … Jan 8 = 12)',
         cal.cells.length === 12, String(cal.cells.length));
      ok('…Thursday Dec 28 opens week 0 on row Thu (3)', at('2023-12-28').week === 0 && at('2023-12-28').weekday === 3);
      ok('…Sunday Dec 31 is still week 0, row Sun (6)', at('2023-12-31').week === 0 && at('2023-12-31').weekday === 6);
      ok('…Monday Jan 1 starts week 1 — continuous across the year, not week 0 again',
         at('2024-01-01').week === 1 && at('2024-01-01').weekday === 0);
      ok('…Monday Jan 8 is week 2', at('2024-01-08').week === 2 && at('2024-01-08').weekday === 0);
      ok('…three weeks in all', cal.weeks === 3);
      ok('…a day with no row is a null cell, not zero', at('2023-12-30').v === null && at('2024-01-07').v === 1);
      ok('…min and max over the days that have figures', cal.min === 1 && cal.max === 9);
      ok('…month marks for Dec (the first day) and Jan (week 1)',
         same(cal.monthMarks.map((m: any) => [m.label, m.week, m.year]), [['Dec', 0, 2023], ['Jan', 1, 2024]]),
         JSON.stringify(cal.monthMarks));
    }

    {
      const cal = calendarCells(['2024-02-28', '2024-02-29', '2024-03-01'], [1, 2, 3]);
      ok('calendar: a leap day is a real day, Thursday, between Wed and Fri of one week',
         same(cal.cells.map((c: any) => [c.date, c.weekday, c.week]),
              [['2024-02-28', 2, 0], ['2024-02-29', 3, 0], ['2024-03-01', 4, 0]]), JSON.stringify(cal.cells));
      ok('…and March gets its own month mark', cal.monthMarks.some((m: any) => m.label === 'Mar'));
    }

    {
      const cal = calendarCells(['2024-01-02T23:30:00-05:00', '2024-01-02 08:00', '2024-01-03T00:00:00Z'], [1, 2, 4]);
      ok('calendar: ISO datetimes count on the date AS WRITTEN, never shifted by a zone',
         cal.cells.length === 2 && cal.cells[0].date === '2024-01-02' && cal.cells[0].v === 3 && cal.cells[1].v === 4,
         JSON.stringify(cal.cells));
    }

    {
      // Banding: two years (105 weeks) in a wide, tall box wrap to more than one
      // band for bigger cells; one year in a letterbox stays one strip; an unknown
      // box (0 × 0, not laid out yet) is one strip.
      const two = calendarBands(105, 800, 560, 2);
      ok('calendar bands: two years in a tall box wrap into bands of equal weeks',
         two.bands > 1 && two.perRow === Math.ceil(105 / two.bands) && two.rows === two.bands * 7 + (two.bands - 1) * 2,
         JSON.stringify(two));
      ok('…with cells bigger than one strip would give',
         Math.min(800 / two.perRow, 560 / two.rows) > Math.min(800 / 105, 560 / 7));
      ok('calendar bands: one year in a letterbox stays one strip', calendarBands(53, 900, 140, 2).bands === 1);
      ok('calendar bands: an unmeasured box is one strip', calendarBands(105, 0, 0, 2).bands === 1);
    }

    ok('calendar: labels that are not dates give nothing to draw', calendarCells(['North', 'South'], [1, 2]) === null);
    ok('calendar: an impossible date is not a date', calendarCells(['2023-02-30'], [1]) === null);
    ok('calendar: a span past twenty years is refused, not truncated',
       calendarCells(['1990-01-01', '2024-01-01'], [1, 2]) === null);

    // ── Radar ────────────────────────────────────────────────────────────────────

    {
      const r = radarShape(['West', 'East'], [
        { name: 'sum of revenue', values: [200, 100] },
        { name: 'sum of profit', values: [-10, 40] },
        { name: 'count of orders', values: [0, 0] },
      ]);
      ok('radar: one axis per measure', same(r.axes, ['sum of revenue', 'sum of profit', 'count of orders']));
      ok('radar: each axis is scaled by its OWN largest magnitude',
         same(r.datasets[0].norm, [1, -0.25, 0]) && same(r.datasets[1].norm, [0.5, 1, 0]), JSON.stringify(r.datasets));
      ok('…an all-zero axis is 0, not NaN', r.datasets.every((d: any) => d.norm[2] === 0));
      ok('…a negative figure is flagged so the scale can go below zero', r.anyNegative === true);
      ok('…and the raw figures ride along for the tooltip', same(r.datasets[0].raw, [200, -10, 0]));
    }

    {
      const series = Array.from({ length: 8 }, (_, j) => ({ name: 'm' + j, values: Array.from({ length: 10 }, (_, i) => i + j) }));
      const r = radarShape(Array.from({ length: 10 }, (_, i) => 'c' + i), series);
      ok('radar: capped at six axes and eight polygons', r.axes.length === 6 && r.datasets.length === 8);
      ok('…normalised over the polygons it DRAWS', r.datasets[7].norm[0] === 1, String(r.datasets[7].norm[0]));
      ok('radar: a missing figure stays a gap', radarShape(['a', 'b'], [{ name: 'x', values: [null, 4] }]).datasets[0].norm[0] === null);
    }

    // ── Bullet ───────────────────────────────────────────────────────────────────

    {
      const b = bulletShape(['A', 'B'], [{ name: 'actual', values: [90, 130] }, { name: 'target', values: [100, 100] }]);
      ok('bullet: the second measure is the target', b.hasTarget && b.rows[0].target === 100 && b.rows[1].value === 130);
      ok('…bands at 60 / 90 / 120% of it', same(b.rows[0].bands, [60, 90, 120]));
      ok('…and the axis reaches the furthest of bands, values and targets', b.max === 130);
    }

    {
      const b = bulletShape(['A', 'B'], s1([40, 80]), 100);
      ok('bullet: a fixed target applies to every row', b.rows.every((r: any) => r.target === 100) && b.max === 120);
      const none = bulletShape(['A', 'B'], s1([40, -80]));
      ok('bullet: no target → bands against the largest |value|, no target tick',
         !none.hasTarget && same(none.rows[0].bands, [48, 72, 96]) && none.rows[1].target === null,
         JSON.stringify(none.rows));
    }

    expect(fails).toEqual([]);
    void failureCount;
  });
});
