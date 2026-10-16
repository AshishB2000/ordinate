// The metric tree (docs/metric-tree/00-design.md) — its arithmetic, its shape,
// and the whole path end to end against a real (temporary) project store.
//
//   1. math         Shapley contributions add up to the change: sum, product of
//                   2/3/4, ratio; a zero and a sign change need no special case;
//                   the fallbacks (no figure, a zero denominator) are refusals,
//                   never a 0. Negative control: a non-Shapley weight breaks the
//                   identity the suite relies on.
//   2. shape        sanitizeTree's limits, cycles and root; suggestions read
//                   from formulas
//   3. end to end   computeTree on a saved dataset (> 1,000 rows: the resident
//                   path) ≡ the pure-JS reference (analysis/metricTreeJs) over the
//                   hydrated rows, every figure with Object.is; the table is never
//                   hydrated; resident ≡ the doors' own JS fallback; every node's
//                   parts + residual close on its change; the lead branch; the
//                   headline; a wrong relation shows a residual (negative
//                   control); the default period; refusals in sentences
//
//   npm run build:ts && node scripts/test-metricTree.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-metrictree-'));
process.env.ORDINATE_LOCAL_DIR = tmp;

const math: typeof import('../src/analysis/metricTreeMath') = require('../src/analysis/metricTreeMath');
const shape: typeof import('../src/analysis/metricTree') = require('../src/analysis/metricTree');
const ref: typeof import('../src/analysis/metricTreeJs') = require('../src/analysis/metricTreeJs');
const ipc: typeof import('../src/ipc/metricTree') = require('../src/ipc/metricTree');
const projects: typeof import('../src/app/projects') = require('../src/app/projects');
const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
const metrics: typeof import('../src/analysis/metrics') = require('../src/analysis/metrics');
const residentQuery: typeof import('../src/engine/residentQuery') = require('../src/engine/residentQuery');

type Metric = import('../src/analysis/metrics').Metric;
type Out = import('../src/ipc/metricTree').TreeNodeOut;
type RefNode = import('../src/analysis/metricTreeJs').RefNode;

const close = (a: number, b: number, eps = 1e-9): boolean => Math.abs(a - b) <= eps * Math.max(1, Math.abs(b));
const sum = (xs: number[]): number => xs.reduce((s, x) => s + x, 0);
const U = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

// ── 1. math ──────────────────────────────────────────────────────────────────

function mathChecks(): void {
  const s = math.contributions('sum', [{ previous: 10, current: 15 }, { previous: 4, current: 1, negative: true }]);
  ok('sum: each part is its own change, a subtracted part with its sign flipped', s.ok && Object.is(s.contributions[0], 5) && Object.is(s.contributions[1], 3));
  ok('sum: the parts add to the change exactly', s.ok && Object.is(sum(s.contributions), s.implied) && s.implied === (15 - 1) - (10 - 4));

  const p2 = math.contributions('product', [{ previous: 100, current: 120 }, { previous: 50, current: 45 }]);
  ok('product of two: the midpoint shift-share, ΔA·(B⁰+B¹)/2 and ΔB·(A⁰+A¹)/2',
    p2.ok && Object.is(p2.contributions[0], 20 * 47.5) && Object.is(p2.contributions[1], -5 * 110), JSON.stringify(p2));
  ok('product of two: they add to A¹B¹ − A⁰B⁰', p2.ok && Object.is(sum(p2.contributions), 120 * 45 - 100 * 50));

  const p3 = math.contributions('product', [{ previous: 3.2, current: 4.1 }, { previous: 7, current: 6.5 }, { previous: 0.9, current: 1.3 }]);
  ok('product of three: Σ c = the change', p3.ok && close(sum(p3.contributions), 4.1 * 6.5 * 1.3 - 3.2 * 7 * 0.9, 1e-12));
  const p4 = math.contributions('product', [{ previous: 2, current: 3 }, { previous: 5, current: 4 }, { previous: 1.5, current: 1.25 }, { previous: 10, current: 12 }]);
  ok('product of four: Σ c = the change', p4.ok && close(sum(p4.contributions), 3 * 4 * 1.25 * 12 - 2 * 5 * 1.5 * 10, 1e-12));
  ok('product: symmetric — two parts that moved alike get equal credit', (() => {
    const r = math.contributions('product', [{ previous: 2, current: 4 }, { previous: 2, current: 4 }]);
    return r.ok && Object.is(r.contributions[0], r.contributions[1]);
  })());

  const z = math.contributions('product', [{ previous: 0, current: 10 }, { previous: 5, current: 7 }]);
  ok('a zero needs no special case: A 0 → 10, B 5 → 7 gives 60 and 10', z.ok && Object.is(z.contributions[0], 60) && Object.is(z.contributions[1], 10) && Object.is(z.implied, 70));
  const sc = math.contributions('product', [{ previous: -2, current: 3 }, { previous: 4, current: -1 }]);
  ok('a sign change needs no special case: Σ c = (3·−1) − (−2·4) = 5', sc.ok && Object.is(sc.contributions[0], 7.5) && Object.is(sc.contributions[1], -2.5) && Object.is(sc.implied, 5));

  const r = math.contributions('ratio', [{ previous: 30, current: 36 }, { previous: 100, current: 120 }]);
  const cN = 0.5 * ((36 - 30) / 100 + (36 - 30) / 120);
  const cD = 0.5 * ((30 / 120 - 30 / 100) + (36 / 120 - 36 / 100));
  ok('ratio: the closed forms of design §math', r.ok && close(r.contributions[0], cN, 1e-15) && close(r.contributions[1], cD, 1e-15));
  ok('ratio: they add to N¹/D¹ − N⁰/D⁰', r.ok && close(sum(r.contributions), 36 / 120 - 30 / 100, 1e-15));

  const zd = math.contributions('ratio', [{ previous: 5, current: 6 }, { previous: 0, current: 4 }]);
  ok('fallback: a zero denominator in a period is a refusal, never a 0 or an Infinity', !zd.ok && zd.why === 'zero_denominator');
  const miss = math.contributions('product', [{ previous: null, current: 6 }, { previous: 2, current: 4 }]);
  ok('fallback: a part with no figure is a refusal', !miss.ok && miss.why === 'missing');
  const nan = math.contributions('sum', [{ previous: NaN, current: 6 }, { previous: 2, current: 4 }]);
  ok('fallback: NaN is no figure', !nan.ok && nan.why === 'missing');

  for (const n of [2, 3, 4]) {
    let total = 0;
    const choose = (a: number, b: number): number => { let c = 1; for (let i = 0; i < b; i += 1) c = (c * (a - i)) / (i + 1); return c; };
    for (let k = 0; k < n; k += 1) total += choose(n - 1, k) * math.shapleyWeight(k, n);
    ok(`Shapley weights for ${n} parts sum to 1`, close(total, 1, 1e-15));
  }
  // Negative control: the identity the suite leans on is SENSITIVE — Banzhaf weights (1/2^(n−1)) do not add up for three parts.
  const xs0 = [3.2, 7, 0.9];
  const xs1 = [4.1, 6.5, 1.3];
  const f = (mask: number): number => xs0.reduce((p, v, i) => p * (mask & (1 << i) ? xs1[i] : v), 1);
  let banzhaf = 0;
  for (let i = 0; i < 3; i += 1) for (let m = 0; m < 8; m += 1) if (!(m & (1 << i))) banzhaf += (f(m | (1 << i)) - f(m)) / 4;
  ok('negative control: a non-Shapley weight breaks Σ c = Δ (so the check above can fail)', !close(banzhaf, f(7) - f(0), 1e-9), `${banzhaf} vs ${f(7) - f(0)}`);

  ok('residual: float noise is none', math.residualOf(100, [60, 40 + 1e-12]) === null);
  ok('residual: a real gap is shown, signed', Object.is(math.residualOf(100, [60, 30]), 10));
  ok('share: c / Δ × 100, none when the parent did not move', math.shareOf(25, 50) === 50 && math.shareOf(25, 0) === null && math.shareOf(null, 5) === null);
  ok('lead: the largest push in the direction the parent went', math.leadIndex([5, -20, 12], 1) === 2 && math.leadIndex([5, -20, 12], -3) === 1);
  ok('lead: a tie goes to the earlier part; a parent that did not move has none', math.leadIndex([7, 7], 1) === 0 && math.leadIndex([7, 1], 0) === -1);
  ok('lead: no part pushed the parent\'s way → none', math.leadIndex([-1, -2], 5) === -1);
  const seven = math.topSegments(Array.from({ length: 7 }, (_, i) => ({ key: `k${i}`, contribution: i })));
  ok('segments: seven are all shown (one left over reads better than "Other (1)")', seven.shown.length === 7 && seven.rest.length === 0);
  const nine = math.topSegments([1, -9, 3, 0, 7, -2, 5, 4, 8].map((c, i) => ({ key: `k${i}`, contribution: c })));
  ok('segments: nine → the six largest |c| first, then the rest', nine.shown.join() === '1,8,4,6,7,2' && nine.rest.join() === '5,0,3', `${nine.shown} | ${nine.rest}`);
}

// ── 2. shape ─────────────────────────────────────────────────────────────────

function shapeChecks(): void {
  const root = U(1);
  ok('sanitize: no breakdown is no tree', shape.sanitizeTree({ metricId: root }, root) === null && shape.sanitizeTree(null, root) === null);
  const t = shape.sanitizeTree({ metricId: U(99), relation: 'product', children: [{ metricId: U(2) }, { metricId: U(3), negative: true }] }, root);
  ok('sanitize: the root is the metric itself, whatever the payload says', t?.metricId === root);
  ok('sanitize: `negative` is a sum\'s only', !!t && !t.children?.some((c) => c.negative));
  ok('sanitize: every node gets a UUID key', !!t && [t, ...(t.children ?? [])].every((n) => /^[0-9a-f-]{36}$/.test(n.id)));
  const cyc = shape.sanitizeTree({ relation: 'sum', children: [{ metricId: U(2), relation: 'sum', children: [{ metricId: root }, { metricId: U(3) }] }, { metricId: U(4) }] }, root);
  ok('sanitize: a metric repeated on its own path (a cycle) is dropped, and its relation with it', !!cyc && cyc.children?.[0].relation === undefined && cyc.children?.length === 2);
  const one = shape.sanitizeTree({ relation: 'product', children: [{ metricId: U(2) }] }, root);
  ok('sanitize: a product of one is no breakdown', one === null);
  const ratio = shape.sanitizeTree({ relation: 'ratio', children: [{ metricId: U(2) }, { metricId: U(3) }, { metricId: U(4) }] }, root);
  ok('sanitize: a ratio keeps exactly two parts', ratio?.children?.length === 2);
  let deep: Record<string, unknown> = { metricId: U(50), split: 'region' };
  for (let i = 49; i > 40; i -= 1) deep = { metricId: U(i), relation: 'sum', children: [deep, { metricId: U(i + 100) }] };
  const d = shape.sanitizeTree({ ...deep, metricId: root }, root);
  let depth = 0;
  for (let n = d; n && n.children; n = n.children[0]) depth += 1;
  ok(`sanitize: depth is capped at ${shape.TREE_MAX_DEPTH}`, depth === shape.TREE_MAX_DEPTH, String(depth));
  const wide = shape.sanitizeTree({ relation: 'sum', children: Array.from({ length: 8 }, (_, i) => ({ metricId: U(200 + i), relation: 'sum', children: Array.from({ length: 8 }, (__, j) => ({ metricId: U(300 + i * 10 + j) })) })) }, root);
  let count = 0;
  const walk = (n: { children?: unknown[] }): void => { count += 1; (n.children as { children?: unknown[] }[] | undefined)?.forEach(walk); };
  if (wide) walk(wide);
  ok(`sanitize: at most ${shape.TREE_MAX_NODES} nodes`, count <= shape.TREE_MAX_NODES && count > 30, String(count));
  ok('sanitize: a split keeps its column', shape.sanitizeTree({ split: 'region' }, root)?.split === 'region');
  ok('sanitize: a root id that is not a UUID is no tree', shape.sanitizeTree({ split: 'region' }, '../x') === null);

  const ms = [
    { id: U(1), name: 'Revenue', datasetId: 'D' },
    { id: U(2), name: 'Orders', datasetId: 'D' },
    { id: U(3), name: 'Avg order value', datasetId: 'D', formula: '[Revenue] / [Orders]' },
    { id: U(4), name: 'Cost', datasetId: 'D' },
    { id: U(5), name: 'Profit', datasetId: 'D', formula: '[Revenue] - [Cost]' },
    { id: U(6), name: 'Elsewhere', datasetId: 'E', formula: '[Revenue] / [Orders]' },
    { id: U(7), name: 'Weird', datasetId: 'D', formula: '[Revenue] / [Orders] * 2' },
  ];
  const rev = shape.suggestBreakdowns(ms[0], ms);
  ok('suggest: AOV = [Revenue] / [Orders] gives Revenue = Orders × AOV',
    rev.length === 1 && rev[0].relation === 'product' && rev[0].children.map((c) => c.metricId).join() === `${U(2)},${U(3)}` && rev[0].from === 'Avg order value', JSON.stringify(rev));
  const prof = shape.suggestBreakdowns(ms[4], ms);
  ok('suggest: its own formula [Revenue] − [Cost] is a sum with Cost subtracted',
    prof.length === 1 && prof[0].relation === 'sum' && !prof[0].children[0].negative && prof[0].children[1].negative === true);
  const aov = shape.suggestBreakdowns(ms[2], ms);
  ok('suggest: a ratio formula is a ratio', aov.length === 1 && aov[0].relation === 'ratio');
  ok('suggest: a mixed or scaled formula suggests nothing', shape.suggestBreakdowns(ms[6], ms).length === 0);
}

// ── 3. end to end ────────────────────────────────────────────────────────────

const COLS = [
  { name: 'day', type: 'date' }, { name: 'region', type: 'text' }, { name: 'channel', type: 'text' },
  { name: 'revenue', type: 'number' }, { name: 'cost', type: 'number' }, { name: 'units', type: 'number' },
] as import('../src/data/parse').ParsedColumn[];
const REGIONS = ['North', 'South', 'East', 'West', 'Central', 'Coast', 'Hills', 'Plains', ''];
const CHANNELS = ['Online', 'Retail', 'Partner'];

/** Integer figures only: a DuckDB parallel sum and a JS left fold agree on them exactly. */
function fixtureRows(): (string | number | null)[][] {
  let seed = 7;
  const rnd = (): number => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const rows: (string | number | null)[][] = [];
  const start = Date.UTC(2023, 11, 1);
  for (let d = 0; d < 91; d += 1) {
    const day = new Date(start + d * 86_400_000).toISOString().slice(0, 10);
    const n = 24 + Math.floor(rnd() * 12) + (day >= '2024-02-01' ? 6 : 0);
    for (let k = 0; k < n; k += 1) {
      const revenue = rnd() < 0.03 ? null : 10 + Math.floor(rnd() * 490);
      // A blank region is sometimes '' and sometimes no cell at all: one member either way.
      const region = REGIONS[Math.floor(rnd() * REGIONS.length)];
      rows.push([day, region === '' && rnd() < 0.5 ? null : region, CHANNELS[Math.floor(rnd() * 3)], revenue, revenue === null ? 5 : Math.floor((revenue as number) * (0.4 + rnd() * 0.4)), 1 + Math.floor(rnd() * 5)]);
    }
  }
  return rows;
}

/** Every figure of the server's tree against the reference's, residual rows aside. */
function same(out: Out, want: RefNode, at: string, problems: string[]): void {
  if (out.name !== want.name) problems.push(`${at}: name ${out.name} ≠ ${want.name}`);
  for (const k of ['current', 'previous'] as const) if (!Object.is(out[k], want[k])) problems.push(`${at}/${out.name}: ${k} ${out[k]} ≠ ${want[k]}`);
  if (want.contribution !== undefined && !Object.is(out.contribution, want.contribution)) problems.push(`${at}/${out.name}: contribution ${out.contribution} ≠ ${want.contribution}`);
  const kids = out.children.filter((c) => c.kind !== 'residual');
  if (kids.length !== want.children.length) problems.push(`${at}/${out.name}: ${kids.length} children ≠ ${want.children.length}`);
  kids.forEach((c, i) => want.children[i] && same(c, want.children[i], `${at}/${out.name}`, problems));
}

function closes(n: Out, problems: string[]): void {
  if (n.children.length && typeof n.change === 'number' && n.children.every((c) => typeof c.contribution === 'number')) {
    const total = sum(n.children.map((c) => c.contribution as number));
    if (!close(total, n.change, 1e-9)) problems.push(`${n.name}: parts ${total} ≠ change ${n.change}`);
  }
  n.children.forEach((c) => closes(c, problems));
}

async function endToEnd(): Promise<void> {
  const project = await projects.createProject('Metric tree test');
  const pid = project.id;
  const rows = fixtureRows();
  const ds = await datasets.saveDataset(pid, { name: 'Sales', sourceKind: 'csv', columns: COLS as any, rows });
  const other = await datasets.saveDataset(pid, { name: 'Other', sourceKind: 'csv', columns: COLS as any, rows: rows.slice(0, 10) });
  ok('fixture datasets saved', !!ds && !!other && rows.length > 1_000, String(rows.length));
  if (!ds || !other) return;
  const money = { kind: 'currency', decimals: 0, compact: false };
  const save = async (name: string, definition: unknown, format: unknown = { kind: 'number', decimals: 0, compact: false }, datasetId = ds.id): Promise<Metric> =>
    (await metrics.saveMetric(pid, { name, datasetId, definition, format, direction: 'up_good' } as any)) as Metric;
  const revenue = await save('Revenue', { column: 'revenue', aggregation: 'sum' }, money);
  const cost = await save('Cost', { column: 'cost', aggregation: 'sum' }, money);
  const orders = await save('Orders', { column: 'day', aggregation: 'count' });
  const aov = await save('Avg order value', { formula: '[Revenue] / [Orders]' }, money);
  const profit = await save('Profit', { formula: '[Revenue] - [Cost]' }, money);
  const margin = await save('Margin %', { formula: '[Profit] / [Revenue]' }, { kind: 'percent', decimals: 1, compact: false });
  const avgPrice = await save('Avg price', { column: 'revenue', aggregation: 'avg' }, money);
  const top = await save('Top sale', { column: 'revenue', aggregation: 'max' }, money);
  const elsewhere = await save('Elsewhere', { column: 'revenue', aggregation: 'sum' }, money, other.id);
  const all = [revenue, cost, orders, aov, profit, margin, avgPrice, top];
  ok('fixture metrics saved', all.every(Boolean) && !!elsewhere);

  const feb = [{ type: 'filter', column: 'day', op: 'period', period: { preset: 'custom', from: '2024-02-01', to: '2024-02-29' } }] as any[];
  const jan = [{ type: 'filter', column: 'day', op: 'period', period: { preset: 'custom', from: '2024-01-01', to: '2024-01-31' } }] as any[];
  const compare = { mode: 'previous_period' };
  const hydrated = (await datasets.getDataset(pid, ds.id))!;
  const reference = (metricId: string): RefNode => {
    const m = all.find((x) => x.id === metricId) as Metric;
    return ref.treeJs({ columns: hydrated.columns, rows: hydrated.rows, metrics: all, tree: m.tree as any, current: feb, previous: jan });
  };

  // Saving: parts on another dataset, or deleted, are refused with a sentence.
  const refusedOther = await ipc.saveTree(pid, revenue.id, { relation: 'sum', children: [{ metricId: cost.id }, { metricId: elsewhere.id }] });
  ok('save: a part on another dataset is refused, in words', !refusedOther.ok && /another dataset/.test(refusedOther.error), JSON.stringify(refusedOther));
  const refusedGone = await ipc.saveTree(pid, revenue.id, { relation: 'sum', children: [{ metricId: cost.id }, { metricId: U(404) }] });
  ok('save: a part that is not a metric is refused', !refusedGone.ok);

  const trees: Array<[Metric, unknown]> = [
    [revenue, { relation: 'product', children: [{ metricId: orders.id, split: 'region' }, { metricId: aov.id, split: 'channel' }] }],
    [profit, { relation: 'sum', children: [{ metricId: revenue.id, split: 'region' }, { metricId: cost.id, negative: true }] }],
    [margin, { relation: 'ratio', children: [{ metricId: profit.id }, { metricId: revenue.id }] }],
    [avgPrice, { split: 'region' }],
  ];
  for (const [m, tree] of trees) {
    const saved = await ipc.saveTree(pid, m.id, tree);
    ok(`save: ${m.name}'s tree is on its record`, saved.ok && !!saved.metric.tree);
    if (saved.ok) m.tree = saved.metric.tree;
  }
  ok('the summary says it has a tree', (await metrics.listMetrics(pid)).find((x) => x.id === revenue.id)?.hasTree === true);

  const meta = await datasets.getDatasetMeta(pid, ds.id);
  const resident = !!meta && meta.resident && residentQuery.isResident();
  const realGet = datasets.getDataset;
  for (const [m] of trees) {
    let hydrations = 0;
    (datasets as any).getDataset = async (...args: any[]) => { hydrations += 1; return (realGet as any)(...args); };
    const fast = await ipc.computeTree(pid, m.id, { filters: feb, compare });
    (datasets as any).getDataset = realGet;
    ok(`${m.name}: an answer`, fast.ok === true, JSON.stringify(fast).slice(0, 300));
    if (!fast.ok) continue;
    if (resident) ok(`${m.name}: resident — the table was never hydrated`, hydrations === 0, `${hydrations} hydrations`);
    const problems: string[] = [];
    same(fast.root, reference(m.id), '', problems);
    ok(`${m.name}: every figure and contribution ≡ the pure-JS reference (Object.is)`, problems.length === 0, problems.slice(0, 6).join('\n'));
    const gaps: string[] = [];
    closes(fast.root, gaps);
    ok(`${m.name}: every node's parts (+ residual) close on its change`, gaps.length === 0, gaps.join('\n'));
    // Resident ≡ the doors' own JS fallback, end to end.
    const realIs = residentQuery.isResident;
    (residentQuery as any).isResident = () => false;
    const slow = await ipc.computeTree(pid, m.id, { filters: feb, compare });
    (residentQuery as any).isResident = realIs;
    ok(`${m.name}: resident ≡ JS fallback, every byte of the reply`, JSON.stringify(slow) === JSON.stringify(fast));
  }

  const r = await ipc.computeTree(pid, revenue.id, { filters: feb, compare });
  if (r.ok) {
    ok('period: the scope\'s own range, named', r.period.key === 'scope' && r.period.label === 'Feb 2024' && r.prior.label === 'Jan 2024', JSON.stringify([r.period, r.prior]));
    ok('relation: the breakdown in words', r.root.breakdown?.text === 'Orders × Avg order value' && r.root.children[0].breakdown?.text === 'by region');
    // The lead branch: one per level, the largest push the parent's way.
    let n: Out | undefined = r.root;
    let levels = 0;
    while (n && n.lead) {
      const leads: Out[] = n.children.filter((c) => c.lead);
      const want = math.leadIndex(n.children.map((c) => (c.kind === 'residual' ? null : c.contribution ?? null)), n.change);
      ok(`lead: level ${levels} marks the child leadIndex picks`, leads.length === (want >= 0 ? 1 : 0) && (want < 0 || n.children[want].lead === true));
      n = leads[0];
      levels += 1;
    }
    ok('lead: the branch runs root → part → segment', levels === 3, String(levels));
    ok('headline: the change, then what explains it', /^Revenue (rose|fell) \$[\d,.K]+ \([\d.]+%\) vs previous period\. .+ explains −?\d+% of it, led by .+\.$/.test(r.headline), r.headline);
    const seg = r.root.children[0].children;
    ok('split: nine regions → six, then "Other (3)" whose figure is recomputed', seg.length === 7 && seg[6].name === 'Other (3)' && typeof seg[6].current === 'number', seg.map((x) => x.name).join());
    ok('displays: signed, in the parent\'s units', /^[+−]\$/.test(r.root.children[0].contributionDisplay ?? '') && /^[+−][\d,]+$/.test(seg[0].contributionDisplay ?? ''), `${r.root.children[0].contributionDisplay} ${seg[0].contributionDisplay}`);
    ok('sparklines: 12 closed months at most, gaps stay gaps', !!r.root.spark && r.root.spark.length <= 12 && r.root.spark.length >= 2);
  }

  const mg = await ipc.computeTree(pid, margin.id, { filters: feb, compare });
  ok('percent metric: its change in points, no % change', mg.ok && / pts$/.test(mg.root.changeDisplay) && mg.root.pct === null && mg.root.pctDisplay === '', mg.ok ? mg.root.changeDisplay : '');
  const ap = await ipc.computeTree(pid, avgPrice.id, { filters: feb, compare });
  ok('avg split: each segment has mix and rate, its numeric count asked of the door', ap.ok && ap.root.children.filter((c) => c.kind === 'segment').every((c) => !!c.mixDisplay && !!c.rateDisplay));

  // Negative control: Revenue is NOT Orders × Cost — the gap is shown, not hidden in a child.
  const wrong = await ipc.computeTree(pid, revenue.id, { filters: feb, compare, tree: { relation: 'product', children: [{ metricId: orders.id }, { metricId: cost.id }] } });
  ok('negative control: a relation that does not hold shows "Not explained by its parts"',
    wrong.ok && wrong.root.children.some((c) => c.kind === 'residual' && c.name === 'Not explained by its parts' && typeof c.contribution === 'number'));
  ok('a preview is never saved', (await metrics.getMetric(pid, revenue.id))?.tree?.children?.[1].metricId === aov.id);

  const mx = await ipc.computeTree(pid, top.id, { filters: feb, compare, tree: { split: 'region' } });
  ok('a max does not split: a sentence on the node, no segments', mx.ok && mx.root.children.length === 0 && /cannot be split by member/.test(mx.root.note ?? ''), mx.ok ? mx.root.note : '');
  const notText = await ipc.computeTree(pid, revenue.id, { filters: feb, compare, tree: { split: 'units' } });
  ok('a split by a number column is refused in words', notText.ok && /not a text column/.test(notText.root.note ?? ''));

  // No date filter in scope: the newest CLOSED month in the data (D9). The data ends Feb 29.
  const latest = await ipc.computeTree(pid, revenue.id, {});
  ok('default period: the newest closed month in the data, vs the one before', latest.ok && latest.period.key === 'latest_month' && latest.period.label === 'Feb 2024' && latest.prior.label === 'Jan 2024', latest.ok ? JSON.stringify(latest.period) : JSON.stringify(latest));
  const quarter = await ipc.computeTree(pid, revenue.id, { period: { key: 'latest_quarter' } });
  ok('latest quarter: the newest whole quarter that has closed (Q4 2023)', quarter.ok && quarter.period.from === '2023-10-01' && quarter.period.to === '2023-12-31', quarter.ok ? JSON.stringify(quarter.period) : '');
  ok('latestRange: a month and its closed quarter', JSON.stringify(ipc.latestRange(['2024-01', '2024-02', '2024-03'], true)) === '{"from":"2024-01-01","to":"2024-03-31"}'
    && JSON.stringify(ipc.latestRange(['2024-04'], true)) === '{"from":"2024-01-01","to":"2024-03-31"}' && ipc.latestRange([], false) === null);
  const lastYear = await ipc.computeTree(pid, revenue.id, { filters: feb, compare: { mode: 'previous_year' } });
  ok('nothing a year earlier: the headline says so, no invented change', lastYear.ok && /has no figure to compare/.test(lastYear.headline) && lastYear.root.change === null);

  const gone = await ipc.computeTree(pid, U(404), {});
  ok('an unknown metric is refused in words', !gone.ok && /no longer exists/.test(gone.error));
  const cleared = await ipc.saveTree(pid, avgPrice.id, null);
  ok('save null clears the tree', cleared.ok && cleared.metric.tree === undefined);
}

async function main(): Promise<void> {
  mathChecks();
  shapeChecks();
  await endToEnd();
}

main()
  .catch((e) => { ok('no exception', false, e && e.stack); })
  .finally(() => {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
    finish();
  });
