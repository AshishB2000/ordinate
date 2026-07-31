// Self-check for the Values-menu label selection + period-dropdown gating in
// renderer/hub/hub.js. hub.js can't run under node (browser globals), so these
// mirror the pure helpers there — keep them in sync if the originals change.

export {}; // module scope — sibling test scripts share top-level names

// ── mirror of valueLabelKeys(mode, values) ────────────────────────────────
function valueLabelKeys(mode: string | null | undefined, values: (number | null)[][]): Set<string> {
  const keys = new Set<string>();
  if (!mode || mode === 'off' || !Array.isArray(values) || !values.length) return keys;
  const S = values.length;
  const C = Math.max(0, ...values.map(r => (Array.isArray(r) ? r.length : 0)));
  const num = (s: number, c: number) => { const v = values[s] && values[s][c]; return typeof v === 'number' ? v : null; };
  const add = (s: number, c: number) => keys.add(s + ':' + c);
  if (mode === 'all') {
    for (let s = 0; s < S; s++) for (let c = 0; c < C; c++) if (num(s, c) != null) add(s, c);
    return keys;
  }
  const wantMax = mode === 'max' || mode === 'maxmin';
  const wantMin = mode === 'min' || mode === 'maxmin';
  const liveSeries = values.filter(r => Array.isArray(r) && r.some(v => typeof v === 'number')).length;
  if (liveSeries <= 1) {
    let maxS = -1, maxC = -1, minS = -1, minC = -1, maxV = -Infinity, minV = Infinity;
    for (let s = 0; s < S; s++) for (let c = 0; c < C; c++) {
      const v = num(s, c); if (v == null) continue;
      if (v > maxV) { maxV = v; maxS = s; maxC = c; }
      if (v < minV) { minV = v; minS = s; minC = c; }
    }
    if (wantMax && maxC >= 0) add(maxS, maxC);
    if (wantMin && minC >= 0) add(minS, minC);
  } else {
    for (let c = 0; c < C; c++) {
      let maxS = -1, minS = -1, maxV = -Infinity, minV = Infinity;
      for (let s = 0; s < S; s++) {
        const v = num(s, c); if (v == null) continue;
        if (v > maxV) { maxV = v; maxS = s; }
        if (v < minV) { minV = v; minS = s; }
      }
      if (wantMax && maxS >= 0) add(maxS, c);
      if (wantMin && minS >= 0) add(minS, c);
    }
  }
  return keys;
}

// ── mirror of chartHasPeriodDropdown(type, seriesCount) ────────────────────
const PERIOD_DROPDOWN_TYPES = new Set([
  'line', 'area', 'stacked_area', 'line_markers',
  'column', 'bar', 'clustered_column', 'clustered_bar',
  'stacked_column', 'stacked_bar', 'pct_stacked_column', 'pct_stacked_bar', 'combo',
  'heatmap',
]);
function chartHasPeriodDropdown(type: string, seriesCount: number): boolean {
  return seriesCount >= 2 && PERIOD_DROPDOWN_TYPES.has(type);
}

// ── asserts ────────────────────────────────────────────────────────────────
let failures = 0;
function eq(label: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g !== w) { console.error(`FAIL ${label}\n  got:  ${g}\n  want: ${w}`); failures++; }
  else { console.log(`ok   ${label}`); }
}
const sorted = (set: Set<string>) => Array.from(set).sort();

// off / empty
eq('off → none', sorted(valueLabelKeys('off', [[1, 2, 3]])), []);
eq('empty → none', sorted(valueLabelKeys('all', [])), []);

// single series: global max/min over categories
eq('single max', sorted(valueLabelKeys('max', [[10, 40, 25]])), ['0:1']);
eq('single min', sorted(valueLabelKeys('min', [[10, 40, 25]])), ['0:0']);
eq('single maxmin', sorted(valueLabelKeys('maxmin', [[10, 40, 25]])), ['0:0', '0:1']);
eq('single all', sorted(valueLabelKeys('all', [[10, 40, 25]])), ['0:0', '0:1', '0:2']);

// multi series (grouped): per category column, pick the max/min series
//   col0: s1(5) > s0(1) → 1:0 ; col1: s0(9) > s1(2) → 0:1 ; col2: s0(3)>s1(3)? tie→first s0 → 0:2
const grid = [[1, 9, 3], [5, 2, 3]];
eq('grouped max (per group)', sorted(valueLabelKeys('max', grid)), ['0:1', '0:2', '1:0']);
//   col0 min: s0(1) → 0:0 ; col1 min: s1(2) → 1:1 ; col2 min: tie→first s0 → 0:2
eq('grouped min (per group)', sorted(valueLabelKeys('min', grid)), ['0:0', '0:2', '1:1']);
eq('grouped maxmin union', sorted(valueLabelKeys('maxmin', grid)),
  ['0:0', '0:1', '0:2', '1:0', '1:1']);

// hidden series passed as all-null → excluded from the contest, falls back to single
eq('hidden row excluded → single-series behavior',
  sorted(valueLabelKeys('max', [[1, 9, 3], [null, null, null]])), ['0:1']);

// all skips null cells
eq('all skips nulls', sorted(valueLabelKeys('all', [[1, null, 3]])), ['0:0', '0:2']);

// period dropdown gating
eq('combo 3 series → dropdown', chartHasPeriodDropdown('combo', 3), true);
eq('column 2 series → dropdown', chartHasPeriodDropdown('column', 2), true);
eq('column 1 series → no dropdown', chartHasPeriodDropdown('column', 1), false);
eq('heatmap 3 series → dropdown', chartHasPeriodDropdown('heatmap', 3), true);
eq('pie 3 series → no dropdown', chartHasPeriodDropdown('pie', 3), false);
eq('scatter 2 series → no dropdown', chartHasPeriodDropdown('scatter', 2), false);

if (failures) { console.error(`\n${failures} assertion(s) failed`); process.exit(1); }
console.log('\nAll value-label / dropdown checks passed.');
