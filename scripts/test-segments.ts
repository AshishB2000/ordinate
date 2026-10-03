// Find segments — the pure math, the fit, the names and the Prepare step.
//
//   1. math        mulberry32, the stride rule, nearest's tie rule
//   2. PCA         Jacobi on known matrices (values, vectors, the sign rule),
//                  PCA of points on a line
//   3. the fit     determinism across runs; k chosen by silhouette on
//                  separable fixtures; a silhouette tie goes to the smaller k
//   4. names       top two |mean z|, collisions extended then numbered
//   5. defaults    id-like, near-constant, mostly empty, row numbers
//   6. the step    strict sanitize, skip warnings, and the stored step
//                  reproducing the fit's own labels through applyPipeline
//
//   npm run build:ts && node scripts/test-segments.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import type { Cell, TableData, TransformStep } from '../src/data/transforms';
import type { ParsedColumn } from '../src/data/parse';

const math: typeof import('../src/analysis/segmentMath') = require('../src/analysis/segmentMath');
const model: typeof import('../src/analysis/segmentModel') = require('../src/analysis/segmentModel');
const stepMod: typeof import('../src/data/stepsSegment') = require('../src/data/stepsSegment');
const { applyPipeline, sanitizeSteps }: typeof import('../src/data/transforms') = require('../src/data/transforms');

const near = (a: number, b: number, eps = 1e-9): boolean => Math.abs(a - b) <= eps;
const N = (name: string): ParsedColumn => ({ name, type: 'number' });

/** Separable 2-D blobs: `per` points around each centre, ±0.5 noise, interleaved. */
function blobs(centres: Array<[number, number]>, per: number, seed = 7): number[][] {
  const rng = math.mulberry32(seed);
  const out: number[][] = [];
  for (let i = 0; i < per; i++) for (const [x, y] of centres) out.push([x + rng() - 0.5, y + rng() - 0.5]);
  return out;
}

function table(rows: Cell[][], names = ['revenue', 'discount']): TableData {
  return { columns: names.map(N), rows };
}

async function fit(t: TableData, features = t.columns.filter((c) => c.type === 'number').map((c) => c.name)) {
  const out = await model.runFit(t.columns, features, model.jsSegmentIo(t.columns, t.rows));
  if (!out || 'error' in out) throw new Error('fit failed: ' + JSON.stringify(out));
  return out;
}

async function main(): Promise<void> {
  // ── 1. math ───────────────────────────────────────────────────────────────────
  {
    const a = math.mulberry32(42);
    const b = math.mulberry32(42);
    const xs = Array.from({ length: 5 }, () => a());
    ok('mulberry32: the same seed gives the same stream', xs.every((x) => Object.is(x, b())));
    ok('mulberry32: values in [0, 1)', xs.every((x) => x >= 0 && x < 1));
    ok('mulberry32: a different seed differs', math.mulberry32(43)() !== xs[0]);

    const s = math.strideIndexes(10, 4);
    ok('stride: exactly T of N, ascending and in range', s.length === 4 && s.every((v, i) => v >= 0 && v < 10 && (i === 0 || v > s[i - 1])), JSON.stringify(s));
    ok('stride: covers the last region', s[s.length - 1] === 9, JSON.stringify(s));
    ok('stride: all rows when N ≤ T', JSON.stringify(math.strideIndexes(3, 5)) === '[0,1,2]');
    ok('stride: 200k of 1M is exact', math.strideIndexes(1_000_000, 200_000).length === 200_000);

    const cents = [[0, 0], [2, 0], [0, 0]];
    ok('nearest: an exact tie goes to the lowest index', math.nearest([1, 0], [[0, 0], [2, 0]]) === 0);
    ok('nearest: duplicate centroids pick the first', math.nearest([0.1, 0], cents) === 0);
    ok('nearest: the strictly closest wins', math.nearest([1.9, 0], cents) === 1);
    ok('dist2: a left fold of squares', math.dist2([1, 2, 3], [0, 0, 0]) === 14);
  }

  // ── 2. PCA ────────────────────────────────────────────────────────────────────
  {
    const e = math.jacobiEigen([[2, 1], [1, 2]]);
    const r = Math.SQRT1_2;
    ok('jacobi 2×2: eigenvalues 3 then 1', near(e.values[0], 3) && near(e.values[1], 1), JSON.stringify(e.values));
    ok('jacobi 2×2: first vector (1,1)/√2', near(e.vectors[0][0], r) && near(e.vectors[0][1], r), JSON.stringify(e.vectors));
    ok('jacobi 2×2: second vector (1,−1)/√2 — the larger |component| (first on a tie) is positive',
      near(e.vectors[1][0], r) && near(e.vectors[1][1], -r), JSON.stringify(e.vectors));

    // A block matrix with eigenvalues 11, 2, 1 and known vectors.
    const m = math.jacobiEigen([[2, 0, 0], [0, 3, 4], [0, 4, 9]]);
    const s5 = Math.sqrt(5);
    ok('jacobi 3×3: sorted 11, 2, 1', near(m.values[0], 11) && near(m.values[1], 2) && near(m.values[2], 1), JSON.stringify(m.values));
    ok('jacobi 3×3: λ=11 → (0, 1, 2)/√5', near(m.vectors[0][0], 0) && near(m.vectors[0][1], 1 / s5) && near(m.vectors[0][2], 2 / s5), JSON.stringify(m.vectors[0]));
    ok('jacobi 3×3: λ=2 → (1, 0, 0)', near(m.vectors[1][0], 1) && near(m.vectors[1][1], 0) && near(m.vectors[1][2], 0), JSON.stringify(m.vectors[1]));
    ok('jacobi 3×3: λ=1 → (0, 2, −1)/√5 (sign fixed)', near(m.vectors[2][1], 2 / s5) && near(m.vectors[2][2], -1 / s5), JSON.stringify(m.vectors[2]));
    const flipped = math.jacobiEigen([[2, 0, 0], [0, 3, 4], [0, 4, 9]].map((row) => row.map((x) => x)));
    ok('jacobi: identical input, identical output (bit for bit)', JSON.stringify(flipped) === JSON.stringify(m));
    const d = math.jacobiEigen([[1, 0, 0], [0, 5, 0], [0, 0, 3]]);
    ok('jacobi diagonal: 5, 3, 1 on e2, e3, e1',
      JSON.stringify(d.values) === '[5,3,1]' && d.vectors[0][1] === 1 && d.vectors[1][2] === 1 && d.vectors[2][0] === 1, JSON.stringify(d));

    const line = Array.from({ length: 50 }, (_, i) => Float64Array.from([i, 2 * i]));
    const p = math.pca(line);
    ok('pca: points on y = 2x put all the variance on PC1', near(p.variance[0], 1, 1e-12) && near(p.variance[1], 0, 1e-12), JSON.stringify(p.variance));
    ok('pca: PC1 is (1, 2)/√5', near(p.axes[0][0], 1 / s5, 1e-12) && near(p.axes[0][1], 2 / s5, 1e-12), JSON.stringify(p.axes[0]));
    const [x0] = math.project(line[0], p);
    const [x49] = math.project(line[49], p);
    ok('pca: projection is centred and spans the line', near(x49 - x0, Math.hypot(49, 98), 1e-9), `${x0} ${x49}`);
  }

  // ── 3. the fit ────────────────────────────────────────────────────────────────
  {
    const three = table(blobs([[0, 0], [10, 0], [0, 10]], 40));
    const a = await fit(three);
    const b = await fit(three);
    ok('determinism: two runs give the identical result', JSON.stringify(a) === JSON.stringify(b));
    ok('silhouette: three separable blobs → k = 3', a.k === 3, JSON.stringify(a.silhouettes));
    ok('silhouette: every k from 2 to 8 was scored', a.silhouettes.map((s) => s.k).join(',') === '2,3,4,5,6,7,8');
    ok('three blobs: 40 rows each, every row assigned', a.sizes.join(',') === '40,40,40' && a.empty === 0, a.sizes.join(','));
    const two = await fit(table(blobs([[0, 0], [20, 20]], 30)));
    ok('silhouette: two separable blobs → k = 2', two.k === 2, JSON.stringify(two.silhouettes));
    const five = await fit(table(blobs([[0, 0], [12, 0], [0, 12], [12, 12], [6, 30]], 25, 3)));
    ok('silhouette: five separable blobs → k = 5', five.k === 5, JSON.stringify(five.silhouettes));
    ok('segments are ordered largest first', five.sizes.every((s, i) => i === 0 || s <= five.sizes[i - 1]), five.sizes.join(','));

    ok('chooseK: the best score wins', model.chooseK([{ k: 2, score: 0.4 }, { k: 3, score: 0.6 }, { k: 4, score: 0.5 }]) === 3);
    ok('chooseK: a tie goes to the smaller k', model.chooseK([{ k: 2, score: 0.5 }, { k: 3, score: 0.5 }]) === 2);
    ok('chooseK: nothing scored → null', model.chooseK([]) === null);

    ok('pca: one point per plotted row, each with its segment',
      a.pca.points.length === 120 && a.pca.points.every((p) => p[2] >= 0 && p[2] < a.k), String(a.pca.points.length));
    ok('pca: two variance shares in [0, 1] summing to ≤ 1',
      a.pca.variance[0] >= a.pca.variance[1] && a.pca.variance[0] + a.pca.variance[1] <= 1 + 1e-12, JSON.stringify(a.pca.variance));

    const tiny = await model.runFit(three.columns, ['revenue', 'discount'], model.jsSegmentIo(three.columns, three.rows.slice(0, 5)));
    ok('fewer than 10 complete rows is an error, not a guess', !!tiny && 'error' in tiny && /at least 10/.test(tiny.error), JSON.stringify(tiny));
    const flat = table(Array.from({ length: 20 }, () => [1, 1]));
    const same = await model.runFit(flat.columns, ['revenue', 'discount'], model.jsSegmentIo(flat.columns, flat.rows));
    ok('all rows identical → an error, not a model', !!same && 'error' in same, JSON.stringify(same));
    ok('one feature is refused', model.featureProblem(three.columns, ['revenue']) !== null);
    ok('a text column is refused', model.featureProblem([N('a'), { name: 't', type: 'text' }], ['a', 't']) !== null);
  }

  // ── 4. names ──────────────────────────────────────────────────────────────────
  {
    const f = ['revenue', 'discount', 'unit_price'];
    const n = model.segmentNames([[1.2, -0.8, 0.1], [-0.1, 0.05, 0.9], [0.1, 0.1, 0.1]], f);
    ok('names: top two |mean z|', n[0] === 'High revenue · Low discount', n[0]);
    ok('names: underscores read as spaces', n[1] === 'High unit price · Average revenue', n[1]);
    ok('names: a centred segment reads as Average', n[2] === 'Average revenue · Average discount', n[2]);
    const clash = model.segmentNames([[1, -1, 0.5], [1, -1, -0.5]], f);
    ok('names: a collision takes the next feature', clash[0] === 'High revenue · Low discount · High unit price' && clash[1] === 'High revenue · Low discount · Low unit price', JSON.stringify(clash));
    const twin = model.segmentNames([[1, -1, 0.5], [1, -1, 0.5]], f);
    ok('names: still identical → numbered', twin[0] !== twin[1] && twin[1].endsWith(' (2)'), JSON.stringify(twin));
    const long = model.segmentNames([[1, 1], [-1, -1]], ['x'.repeat(70), 'y'.repeat(70)]);
    ok('names: capped at 80 characters', long.every((s) => s.length <= 80), JSON.stringify(long));
  }

  // ── 5. defaults ───────────────────────────────────────────────────────────────
  {
    const cols: ParsedColumn[] = ['customer_id', 'Order ID', 'orderNo', 'revenue', 'flat', 'sparse', 'row', 'zip'].map(N);
    const sum = (name: string, count: number, min: number, max: number) => ({ name, type: 'number' as const, nonEmpty: count, count, min, max, mean: (min + max) / 2 });
    const summaries = [
      sum('customer_id', 100, 1, 900), sum('Order ID', 100, 1, 5000), sum('orderNo', 100, 3, 77), sum('revenue', 100, 2.5, 900),
      sum('flat', 100, 4, 4), sum('sparse', 30, 1, 9), sum('row', 100, 1, 100), sum('zip', 100, 1000, 99999),
    ];
    const got = model.featureChoices([...cols, { name: 'label', type: 'text' }], summaries, 100);
    const by = (n: string) => got.find((g) => g.name === n);
    ok('defaults: only number columns are offered', got.length === 8 && !by('label'));
    ok('defaults: a measure is ticked', by('revenue')?.checked === true && !by('revenue')?.reason);
    ok('defaults: id-like names are skipped', ['customer_id', 'Order ID', 'orderNo', 'zip'].every((n) => by(n)?.reason === 'id-like' && !by(n)?.checked));
    ok('defaults: a constant is near-constant', by('flat')?.reason === 'near-constant');
    ok('defaults: a mostly-empty column is skipped', by('sparse')?.reason === 'mostly empty');
    ok('defaults: a 1…n run over every row is a row number', by('row')?.reason === 'id-like');
    ok('freeColumn: segment, then segment_2', model.freeColumn([{ name: 'x' }]) === 'segment' && model.freeColumn([{ name: 'segment' }]) === 'segment_2');
  }

  // ── 6. the step ───────────────────────────────────────────────────────────────
  {
    const rows: Cell[][] = blobs([[0, 0], [10, 0], [0, 10]], 12).map((r, i) => [...r, i % 4 === 0 ? 'x' : 'y']);
    rows[3][0] = null; // an empty feature → an empty segment
    rows[7][1] = 'n/a' as unknown as Cell; // a non-number in a number column → empty too
    const t: TableData = { columns: [N('revenue'), N('discount'), { name: 'tag', type: 'text' }], rows };
    const r = await fit(t, ['revenue', 'discount']);
    const step: TransformStep = r.step;
    ok('the fit hands back a ready step', r.step.type === 'segment' && r.step.column === 'segment' && r.step.centroids.length === r.k);

    // Round-trip through JSON and the sanitizer, as a stored record would.
    const stored = sanitizeSteps(JSON.parse(JSON.stringify([step])));
    ok('sanitize keeps a valid model unchanged', stored.length === 1 && JSON.stringify(stored[0]) === JSON.stringify(step));
    const out = applyPipeline(t, stored);
    const col = out.columns.findIndex((c) => c.name === 'segment');
    ok('the step adds one TEXT column', col === 3 && out.columns[3].type === 'text' && out.warnings.length === 0, JSON.stringify(out.warnings));
    ok('rows with an empty or non-numeric feature get an empty segment', out.rows[3][col] === null && out.rows[7][col] === null);
    // The stored step reproduces the fit's own labels: the sample is every
    // complete row here, in stored order.
    const io = model.jsSegmentIo(t.columns, t.rows);
    const stats = io.stats([0, 1]);
    const sample = io.sample([0, 1], stats!.count, model.SAMPLE_CAP)!;
    const core = model.fitCore(sample, stats!);
    const complete = out.rows.filter((row) => row[col] !== null).map((row) => row[col]);
    ok('the stored step reproduces the fit’s labels exactly',
      !('error' in core) && complete.length === core.labels.length && complete.every((v, i) => v === r.names[core.labels[i]]),
      JSON.stringify(complete.slice(0, 6)));
    const sizes = r.names.map((n) => out.rows.filter((row) => row[col] === n).length);
    ok('the step’s column counts are the reported sizes', sizes.join(',') === r.sizes.join(',') && r.empty === 2, `${sizes} vs ${r.sizes}`);

    const skipped = applyPipeline(t, [{ ...r.step, features: ['revenue', 'gone'] }]);
    ok('an unknown feature skips with a warning', skipped.columns.length === 3 && /unknown column\(s\): gone/.test(skipped.warnings[0] || ''), JSON.stringify(skipped.warnings));
    const text = applyPipeline(t, [{ type: 'rename_column', from: 'tag', to: 'segment' }, r.step]);
    ok('an existing column name skips with a warning', /already exists/.test(text.warnings[0] || ''), JSON.stringify(text.warnings));
    const notNum = applyPipeline({ ...t, columns: [N('revenue'), { name: 'discount', type: 'text' }, t.columns[2]] }, [r.step]);
    ok('a feature that is no longer a number column skips', /not a number column: discount/.test(notNum.warnings[0] || ''), JSON.stringify(notNum.warnings));

    const bad = (patch: Record<string, unknown>) => stepMod.sanitizeSegmentStep({ ...JSON.parse(JSON.stringify(r.step)), ...patch });
    ok('sanitize: a non-finite mean is refused', bad({ means: [Infinity, 0] }) === null);
    ok('sanitize: a zero std is refused', bad({ stds: [0, 1] }) === null);
    ok('sanitize: a centroid of the wrong width is refused', bad({ centroids: [[1], [2, 3]] }) === null);
    ok('sanitize: more than 8 centroids are refused', bad({ centroids: Array.from({ length: 9 }, () => [0, 0]), names: Array.from({ length: 9 }, (_, i) => 'S' + i) }) === null);
    const wide = (n: number) => ({
      features: Array.from({ length: n }, (_, i) => 'f' + i),
      means: new Array(n).fill(0),
      stds: new Array(n).fill(1),
      centroids: r.step.centroids.map(() => new Array(n).fill(0)),
    });
    ok('sanitize: 32 features are fine', bad(wide(32)) !== null);
    ok('sanitize: more than 32 features are refused', bad(wide(33)) === null);
    ok('sanitize: duplicate names are refused', bad({ names: r.names.map(() => 'Same') }) === null);
    ok('sanitize: a blank column is refused', bad({ column: '  ' }) === null);
    ok('sanitize: a string number is refused, not coerced', bad({ means: ['1', 2] }) === null);
    ok('sanitize: strips unknown fields', !('evil' in (bad({ evil: 1 }) || {})));
    ok('a malformed step is dropped by sanitizeSteps, never thrown on', sanitizeSteps([{ type: 'segment', column: 's', centroids: 'x' }]).length === 0);
    const raw = applyPipeline(t, [{ ...r.step, centroids: [[1, 2]] } as TransformStep]);
    ok('an unsanitized bad model skips with a warning rather than throwing', /not valid/.test(raw.warnings[0] || ''), JSON.stringify(raw.warnings));
  }

  finish();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
