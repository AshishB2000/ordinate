// Self-check for src/anomalies.ts — the PURE anomaly detector. No Electron, no fs:
// detectAnomalies / buildAnomaliesFacts operate on plain columns/rows, so this runs
// under plain `node`. No framework — the shared ok(label, cond) harness the sibling
// test scripts use. (It DOES import datasetStats, which is Electron-free too.)

export {}; // module scope — sibling test scripts share top-level names
import { ok, failureCount } from './selfcheck';

const { detectAnomalies, buildAnomaliesFacts } = require('../src/analysis/anomalies') as typeof import('../src/analysis/anomalies');
import type { Anomaly, AnomalyKind } from '../src/analysis/anomalies';


type Col = { name: string; type: 'text' | 'number' | 'date' };
type Cell = string | number | null;

function byKind(list: Anomaly[], kind: AnomalyKind): Anomaly[] {
  return list.filter((a) => a.kind === kind);
}
function col(list: Anomaly[], kind: AnomalyKind, name: string): Anomaly | undefined {
  return list.find((a) => a.kind === kind && a.column === name);
}

// ── numeric_outlier: IQR flags a lone spike, leaves a clean column alone ──────
{
  const cols: Col[] = [
    { name: 'clean', type: 'number' },
    { name: 'spike', type: 'number' },
  ];
  const rows: Cell[][] = [
    [10, 10], [11, 11], [12, 12], [10, 10],
    [11, 11], [12, 12], [10, 10], [11, 1000],
  ];
  const out = detectAnomalies(cols, rows);
  const spike = col(out, 'numeric_outlier', 'spike');
  ok('IQR flags the spike column', !!spike);
  ok('spike facts report the offending value (maxOutlier=1000)', !!spike && spike.facts.maxOutlier === 1000);
  ok('spike count is 1', !!spike && spike.facts.count === 1);
  ok('clean column is NOT flagged as an outlier', !col(out, 'numeric_outlier', 'clean'));
  ok('numeric_outlier severity is warn', !!spike && spike.severity === 'warn');
}

// ── numeric_outlier: z-score union catches a value INSIDE the IQR fences ──────
// 20 sits below the upper IQR fence (~20.5) but its z-score is ~2.06 — caught only
// when zThreshold is lowered to 2, proving the fence ∪ z-score union (not fence alone).
{
  const cols: Col[] = [{ name: 'v', type: 'number' }];
  const rows: Cell[][] = [[10], [11], [12], [13], [14], [15], [16], [20]];
  const dflt = detectAnomalies(cols, rows); // zThreshold 3, fence ~20.5 → miss
  ok('default (z=3, within fence) does NOT flag 20', !col(dflt, 'numeric_outlier', 'v'));
  const z2 = detectAnomalies(cols, rows, { zThreshold: 2 });
  const hit = col(z2, 'numeric_outlier', 'v');
  ok('z-score union (z=2) flags 20', !!hit && hit.facts.maxOutlier === 20);
}

// ── <8 finite values → no numeric_outlier (too small to be meaningful) ────────
{
  const cols: Col[] = [{ name: 'v', type: 'number' }];
  const rows: Cell[][] = [[1], [2], [1000]]; // an obvious spike, but only 3 values
  ok('a column with <8 values yields no numeric_outlier', byKind(detectAnomalies(cols, rows), 'numeric_outlier').length === 0);
}

// ── dominant_category: 70% dominant, 40% not ─────────────────────────────────
{
  const cols: Col[] = [
    { name: 'region', type: 'text' }, // A×7, B×3 → 70%
    { name: 'tier', type: 'text' },   // A×4, B×3, C×3 → top 40%
  ];
  const rows: Cell[][] = [
    ['A', 'A'], ['A', 'A'], ['A', 'A'], ['A', 'A'],
    ['A', 'B'], ['A', 'B'], ['A', 'B'], ['B', 'C'],
    ['B', 'C'], ['B', 'C'],
  ];
  const out = detectAnomalies(cols, rows);
  const region = col(out, 'dominant_category', 'region');
  ok('70% column flagged dominant', !!region && region.facts.value === 'A' && region.facts.count === 7);
  ok('dominant share is 0.7', !!region && region.facts.share === 0.7);
  ok('dominant_category severity is info', !!region && region.severity === 'info');
  ok('40% column NOT flagged dominant', !col(out, 'dominant_category', 'tier'));
}

// ── empty_heavy + constant_column mapped straight through findQualityIssues ──
{
  const cols: Col[] = [
    { name: 'note', type: 'text' },  // >50% empty
    { name: 'flag', type: 'text' },  // same value every row → constant
    { name: 'name', type: 'text' },  // varied → neither
  ];
  const rows: Cell[][] = [
    ['x', 'Y', 'a'],
    ['', 'Y', 'b'],
    ['', 'Y', 'c'],
    ['', 'Y', 'd'],
  ];
  const out = detectAnomalies(cols, rows);
  const empty = col(out, 'empty_heavy', 'note');
  const constant = col(out, 'constant_column', 'flag');
  ok('empty_heavy mapped through (warn)', !!empty && empty.severity === 'warn');
  ok('constant_column mapped through (info)', !!constant && constant.severity === 'info');
  ok('duplicate_rows is dropped (never surfaced)', byKind(out, 'duplicate_rows' as AnomalyKind).length === 0);
}

// ── period_change: a 100% jump flags; a 10% step does not ────────────────────
{
  const cols: Col[] = [
    { name: 'year', type: 'date' },
    { name: 'rev', type: 'number' },
  ];
  const jump: Cell[][] = [['2023', 100], ['2024', 200]];
  const outJump = detectAnomalies(cols, jump);
  const pc = byKind(outJump, 'period_change')[0];
  ok('100% period jump is flagged', !!pc && pc.facts.pctChange === 1);
  ok('period_change carries the from/to periods + values', !!pc &&
    pc.facts.fromPeriod === '2023' && pc.facts.toPeriod === '2024' &&
    pc.facts.fromValue === 100 && pc.facts.toValue === 200);
  ok('period_change names the measure column', !!pc && pc.column === 'rev');

  const gentle: Cell[][] = [['2023', 100], ['2024', 110]];
  ok('10% period step is NOT flagged', byKind(detectAnomalies(cols, gentle), 'period_change').length === 0);
}

// ── leading-zero id column is NOT mis-flagged as numeric ─────────────────────
// parse.ts classifies "007"/zip/SKU as TEXT — a stored id column holds STRINGS.
// It must never be treated as a numeric column (no numeric_outlier), and 8 distinct
// values are neither dominant nor constant nor empty → no anomalies at all.
{
  const cols: Col[] = [{ name: 'zip', type: 'text' }];
  const rows: Cell[][] = [['001'], ['002'], ['003'], ['004'], ['005'], ['006'], ['007'], ['90210']];
  const out = detectAnomalies(cols, rows);
  ok('leading-zero text column yields NO numeric_outlier', byKind(out, 'numeric_outlier').length === 0);
  ok('a varied id column yields no anomalies at all', out.length === 0);
}

// ── empty / degenerate input never throws → [] ───────────────────────────────
ok('empty table → []', detectAnomalies([], []).length === 0);
ok('columns but no rows → []', detectAnomalies([{ name: 'a', type: 'number' }], []).length === 0);
ok('null-ish input → [] (no throw)', detectAnomalies(null as any, null as any).length === 0);

// ── caps: never exceed maxTotal; warn ordered before info ────────────────────
{
  // Two dominant (info) + two empty_heavy (warn). Order must put warn first.
  const cols: Col[] = [
    { name: 'd1', type: 'text' }, { name: 'd2', type: 'text' },
    { name: 'e1', type: 'text' }, { name: 'e2', type: 'text' },
  ];
  const rows: Cell[][] = [
    ['A', 'A', 'x', 'y'],
    ['A', 'A', '', ''],
    ['A', 'A', '', ''],
    ['B', 'B', '', ''],
  ];
  const out = detectAnomalies(cols, rows);
  const firstInfoIdx = out.findIndex((a) => a.severity === 'info');
  const lastWarnIdx = out.map((a) => a.severity).lastIndexOf('warn');
  ok('warn anomalies are ordered before info', firstInfoIdx === -1 || lastWarnIdx < firstInfoIdx);
  ok('respects maxTotal cap', detectAnomalies(cols, rows, { maxTotal: 1 }).length === 1);
}

// ── buildAnomaliesFacts: guard line + one line per anomaly; empty is safe ─────
{
  const cols: Col[] = [{ name: 'year', type: 'date' }, { name: 'rev', type: 'number' }];
  const list = detectAnomalies(cols, [['2023', 100], ['2024', 300]]);
  const facts = buildAnomaliesFacts('Sales', list);
  ok('facts open with the guard line', facts.startsWith('The anomalies below were DETECTED'));
  ok('facts name the dataset', facts.includes('"Sales"'));
  ok('facts include a bullet per anomaly', facts.split('\n').filter((l) => l.startsWith('- [')).length === list.length);
  const emptyFacts = buildAnomaliesFacts('Empty', []);
  ok('empty facts still safe (no crash, says none detected)', emptyFacts.includes('No anomalies were detected'));
}

if (failureCount()) { console.error('\n' + failureCount() + ' anomalies check(s) FAILED'); process.exit(1); }
console.log('\nAll anomalies checks passed.');
