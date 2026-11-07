// A Live dataset's calculated fields (semantic layer part 8, step 04), end to end on the fake warehouse.
//
// § record   `setLiveCalcs` stores them at the record's top level; `applyLive` shows them as typed
//            columns at the end of `meta.columns`, never in `raw.columns`; a schema sync neither
//            removes, misses nor profiles them; the Schema reply lists warehouse columns only.
// § save     `live:setCalculated` checks the whole list (names unique ignoring case, no compiler prefix,
//            v1 formulas over earlier calcs only, never Databricks) and stores each with its static
//            type; `live:checkCalc` answers the editor's check with no rows and no warehouse call;
//            `formula:functions` marks what Live cannot run, and why.
// § doors    every door answers a calc from the warehouse through one derived table per calc it needs:
//            a measure, a category, bins, a split, a filter, a KPI, an answer card and its case fix;
//            literals bound; an edit moves the cache key with no epoch bump and no stale old answer; a
//            dropped input refuses only what reads the calc; a warehouse column spelled like a calc
//            refuses both; a calc is never a row access column; no value list (`notSampled`).
//            NEGATIVE CONTROL: a statement naming no calc is byte-identical to before.
// § copies   "Make a copy" is born with the calcs as its Prepare steps, in its first write, and its figures
//            are Live's (Object.is); "Copy the data instead" keeps the id, takes the steps and drops the
//            top-level `calculated` key in the same write. An unreadable list still refuses both.
// § schema   `dataset:liveSchema.calculated`: each calc with its formula and type, a broken one with its
//            problem; Databricks not allowed, with why; a restricted caller (redactCalcs) gets names and
//            types only (the canary over the real route is in test-rowPolicySafetyNet).
//
//   npm run build:ts && node scripts/test-liveCalcs.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import type { Reply } from './liveRouteHarness';
import { H, close, hydrated, post } from './liveRouteHarness';

const fs: typeof import('fs') = require('fs');
const rec: typeof import('../src/data/datasetRecord') = require('../src/data/datasetRecord');
const sync: typeof import('../src/engine/live/schemaSync') = require('../src/engine/live/schemaSync');
const liveCalcs: typeof import('../src/data/liveCalcs') = require('../src/data/liveCalcs');
const rowPolicy: typeof import('../src/data/rowPolicy') = require('../src/data/rowPolicy');
const calcIpc: typeof import('../src/ipc/liveCalcs') = require('../src/ipc/liveCalcs');
const calcCheck: typeof import('../src/engine/live/liveCalcCheck') = require('../src/engine/live/liveCalcCheck');
const api: typeof import('../src/api/index') = require('../src/api/index');
const authz: typeof import('../src/server/authz/index') = require('../src/server/authz/index');

const { ORG_A } = H;
const VIEWER: import('../src/server/context').Identity = { user: { email: 'vic@acme.test', role: 'viewer' }, org: { id: 'acme' } };
const EDITOR: import('../src/server/context').Identity = { user: { email: 'eve@acme.test', role: 'editor' }, org: { id: 'acme' } };
const INPUT = [{ name: 'Margin', expression: '[amt] - [qty]' }, { name: 'Band', expression: "IF [amt] > 10 THEN 'big' ELSE 'small' END" }];
const show = (v: unknown): string => JSON.stringify(v);
/** A record or meta as the suites read it, with the columns the typed helpers need. */
type Rec = Reply & { columns: import('../src/data/parse').ParsedColumn[] };
const CALCS = [
  { name: 'Margin', expression: '[amt] - [qty]', type: 'number' as const },
  { name: 'Band', expression: "IF [amt] > 10 THEN 'big' ELSE 'small' END", type: 'text' as const },
];

(async () => {
  const s = await H.setupOrg(ORG_A);
  const P = s.projectId;
  const L = s.liveId;
  const meta = (d = L) => H.as(ORG_A, () => H.datasets.getDatasetMeta(P, d)) as Promise<Rec>;
  const raw = (d = L): Promise<Rec> => H.as(ORG_A, async () => JSON.parse(await fs.promises.readFile(rec.datasetFilePath(P, d), 'utf8')));
  const liveSchema = async (d = L): Promise<Reply> => (await post('dataset:liveSchema', { projectId: P, datasetId: d })).value;

  // ── § record ─────────────────────────────────────────────────────────────
  const e0 = (await meta()).live.epoch;
  const columns0 = (await meta()).columns;
  const written = await H.as(ORG_A, () => H.liveDataset.setLiveCalcs(P, L, CALCS));
  ok('setLiveCalcs answers the Live block', !!written && written.epoch === e0);
  ok('meta.columns ends with the calcs, typed; raw.columns has none',
    show((await meta()).columns.slice(-2)) === show([{ name: 'Margin', type: 'number' }, { name: 'Band', type: 'text' }])
    && !(await raw()).columns.some((c: Reply) => c.name === 'Margin'), show((await meta()).columns));
  ok('…and the declared columns come first, unchanged', show((await meta()).columns.slice(0, -2)) === show(columns0));
  ok('the calcs are stored at the top level, verbatim', show((await raw()).calculated) === show(CALCS) && !('calculated' in (await raw()).live));
  ok('the write leaves the epoch alone', (await meta()).live.epoch === e0);
  ok('declaredColumns: meta.columns minus the calcs', show(liveCalcs.declaredColumns(await meta())) === show(columns0));
  ok('calcColumns: name and type', show(liveCalcs.calcColumns(CALCS)) === show([{ name: 'Margin', type: 'number' }, { name: 'Band', type: 'text' }]));
  const twice = { columns: [...columns0], mode: 'live' } as Rec;
  H.liveDataset.applyLive(twice, { mode: 'live', live: (await raw()).live, calculated: CALCS, columns: columns0 } as Reply);
  H.liveDataset.applyLive(twice, { mode: 'live', live: (await raw()).live, calculated: CALCS, columns: twice.columns } as Reply);
  ok('applyLive twice == once (a column named like a calc is replaced, never doubled)', show(twice.columns) === show((await meta()).columns), show(twice.columns));
  const shared = (await raw()).columns;
  const target = { columns: shared } as Rec;
  H.liveDataset.applyLive(target, { mode: 'live', live: (await raw()).live, calculated: CALCS } as Reply);
  ok('applyLive never appends into the stored array it was handed', shared.length === columns0.length && target.columns !== shared);

  const calls0 = H.fake.calls.length;
  const synced = (await H.as(ORG_A, () => sync.syncLiveSchema(P, L))) as Reply;
  const sqls = H.fake.calls.slice(calls0).map((c) => c.sql);
  ok('a schema sync keeps the calcs: none removed, none missing, none profiled',
    synced.ok === true && !synced.removed.includes('Margin') && !synced.missing.includes('Margin') && sqls.length > 0
    && !sqls.some((q) => q.includes('Margin') || q.includes('Band')) && show((await meta()).live.calculated) === show(CALCS), show(synced));
  ok('…and the sync reports no column change at all', synced.added.length === 0 && synced.removed.length === 0 && synced.retyped.length === 0);
  ok('…and the record still holds them at the top level only', show((await raw()).calculated) === show(CALCS) && !(await raw()).columns.some((c: Reply) => c.name === 'Band'));
  const schema = await liveSchema();
  ok('dataset:liveSchema lists warehouse columns only', schema.ok === true && !schema.columns.some((c: Reply) => c.name === 'Margin') && schema.columns.length === columns0.length, show(schema).slice(0, 300));
  ok('NEGATIVE CONTROL: diffColumns over meta.columns would report the calcs removed',
    sync.diffColumns((await meta()).columns, columns0).removed.includes('Margin'));

  const cleared = await H.as(ORG_A, () => H.liveDataset.setLiveCalcs(P, L, []));
  ok('setLiveCalcs([]) deletes the key; meta.columns is the warehouse\'s again', !!cleared && !('calculated' in (await raw())) && show((await meta()).columns) === show(columns0));
  ok('NEGATIVE CONTROL: setLiveCalcs on an extract answers false', (await H.as(ORG_A, () => H.liveDataset.setLiveCalcs(P, s.extractId, CALCS))) === false
    && !('calculated' in (await raw(s.extractId))));

  // ── § save ───────────────────────────────────────────────────────────────
  const set = async (c: unknown[], d = L): Promise<Reply> => (await post('live:setCalculated', { projectId: P, datasetId: d, calculated: c })).value;
  const check = async (expression: string, before?: number): Promise<Reply> =>
    (await post('live:checkCalc', { projectId: P, datasetId: L, expression, ...(before === undefined ? {} : { before }) })).value;
  H.queryCache.clear();
  const saved = await set(INPUT);
  ok('saves typed, in order', saved.ok === true && show(saved.calculated.map((c: Reply) => c.type)) === '["number","text"]'
    && show(saved.calculated.map((c: Reply) => c.name)) === '["Margin","Band"]', show(saved));
  ok('…stored verbatim at the top level, the epoch unchanged', show((await raw()).calculated) === show(saved.calculated) && (await meta()).live.epoch === e0);
  ok('…and stored as sanitize keeps it: twice == once', show(liveCalcs.sanitizeLiveCalcs(saved.calculated)) === show(saved.calculated));
  const again = await set(INPUT);
  ok('a re-save of the same list changes nothing', again.ok === true && show((await raw()).calculated) === show(saved.calculated));
  const trimmed = await set([{ name: '  Margin  ', expression: '[amt] - [qty]' }, INPUT[1]]);
  ok('a name is stored trimmed', trimmed.ok === true && trimmed.calculated[0].name === 'Margin');
  const LATER = [{ name: 'E', expression: '[F] * 2' }, { name: 'F', expression: '1' }];
  const BAD: [string, unknown[], boolean][] = [
    ['a name equal to a column, ignoring case', [{ name: 'AMT', expression: '1' }], false],
    ['two calcs differing by case', [{ name: 'margin', expression: '2' }], false],
    ['a reserved prefix (lv_)', [{ name: 'lv_x', expression: '1' }], false],
    ['a reserved prefix (O_, any case)', [{ name: 'O_y', expression: '1' }], false],
    ['a blank name', [{ name: '   ', expression: '1' }], false],
    ['len()', [{ name: 'L', expression: 'len([cat])' }], true],
    ['upper() (casing)', [{ name: 'U', expression: 'upper([cat])' }], true],
    ['a later calc', LATER, true],
    ['an unknown column', [{ name: 'U', expression: '[nope] + 1' }], true],
    ['a syntax error', [{ name: 'S', expression: '[amt] +' }], true],
    ['an LOD', [{ name: 'X', expression: '{FIXED [cat] : SUM([amt])}' }], true],
  ];
  for (const [why, bad, spanned] of BAD) {
    const r = await set([...INPUT, ...bad]);
    ok(`refused: ${why} (index, sentence${spanned ? ', span' : ''})`, r.ok === false && r.code === 'calc_invalid' && r.index === 2
      && typeof r.error === 'string' && r.error.length > 10 && (!spanned || (typeof r.at?.start === 'number' && r.at.end > r.at.start)), show(r));
  }
  ok('…and a refused save leaves the stored list as it was', show((await raw()).calculated) === show(saved.calculated));
  const len = await set([{ name: 'L', expression: 'len([cat])' }]);
  ok('the len() refusal says why and underlines len', /characters/.test(len.error) && 'len([cat])'.slice(len.at.start, len.at.end).startsWith('len'), show(len));
  const COLS = liveCalcs.declaredColumns(await meta());
  ok('Databricks: refused with its sentence', ((r) => r.ok === false && r.code === 'calc_dialect' && /Databricks/.test(r.error))(calcCheck.validateLiveCalcs(COLS, INPUT, 'databricks')));
  ok('NEGATIVE CONTROL: the same list passes on every other dialect', (['duckdb', 'snowflake', 'bigquery', 'redshift', 'clickhouse'] as const)
    .every((d) => calcCheck.validateLiveCalcs(COLS, INPUT, d).ok));

  const n0 = H.fake.calls.length;
  const c1 = await check('[amt] * 2');
  ok('checkCalc: type, tokens, no rows, a note, no warehouse call', c1.ok === true && c1.resultType === 'number' && c1.tokens.length === 3
    && c1.sample.rows.length === 0 && typeof c1.sample.note === 'string' && H.fake.calls.length === n0, show(c1));
  ok('checkCalc: an earlier calc is a column; a boolean reads logical', ((r) => r.ok && r.resultType === 'logical' && show(r.refs) === '["Margin"]')(await check('[Margin] > 1')));
  ok('checkCalc: text reads string', (await check("[Band] + ''")).ok === false && (await check('[Band]')).resultType === 'string');
  ok('checkCalc before 0: Band is LATER, refused as such', ((r) => r.ok === false && /later|after/i.test(r.error))(await check('[Band]', 0)));
  ok('checkCalc before 0: the calc being edited is not a column of itself', (await check('[Margin]', 0)).ok === false);
  ok('checkCalc: an unknown column has a did-you-mean', ((r) => r.ok === false && show(r.unknownRefs) === show([{ name: 'amtt', didYouMean: 'amt' }]) && r.at)(await check('[amtt] + 1')), show(await check('[amtt] + 1')));
  ok('checkCalc: a refused function carries its span', ((r) => r.ok === false && typeof r.at?.start === 'number')(await check('len([cat])')));
  ok('…and none of the checks asked the warehouse', H.fake.calls.length === n0);

  const docs = (await post('formula:functions', undefined)).value as Reply[];
  const doc = (n: string) => docs.find((d) => d.name === n) ?? {};
  ok('formula:functions: len is not live and says why', doc('len').live === false && /characters/.test(doc('len').liveWhy), show(doc('len')));
  ok('formula:functions: abs is live, with no why', doc('abs').live === true && doc('abs').liveWhy === undefined);
  ok('formula:functions: an LOD keyword is not live', doc('fixed').live === false && typeof doc('fixed').liveWhy === 'string');
  ok('formula:functions: every doc says', docs.length > 80 && docs.every((d) => typeof d.live === 'boolean'));

  const grants = (rank: number) => ({ query: async () => ({ rows: [{ rank }] }) }) as unknown as import('pg').Pool;
  const decide = (who: import('../src/server/context').Identity, channel: 'live:setCalculated' | 'live:checkCalc' | 'dataset:liveSchema', rank: number) =>
    H.as(who, () => authz.authorize(api.contracts[channel], { projectId: P, datasetId: L, calculated: [], expression: '' }, who, grants(rank)));
  ok('access: a viewer may not set them', !(await decide(VIEWER, 'live:setCalculated', 1)).ok);
  ok('access: a viewer may not check one either', !(await decide(VIEWER, 'live:checkCalc', 1)).ok);
  ok('access NEGATIVE CONTROL: an editor may set and check them', (await decide(EDITOR, 'live:setCalculated', 2)).ok && (await decide(EDITOR, 'live:checkCalc', 2)).ok);
  const sc = api.contracts['live:setCalculated'];
  ok('contract: strict, at most 50, names ≤ 200, expressions ≤ 4,000', !sc.input.safeParse({ projectId: P, datasetId: L, calculated: INPUT, x: 1 }).success
    && !sc.input.safeParse({ projectId: P, datasetId: L, calculated: Array.from({ length: 51 }, (_, i) => ({ name: `c${i}`, expression: '1' })) }).success
    && !sc.input.safeParse({ projectId: P, datasetId: L, calculated: [{ name: 'n'.repeat(201), expression: '1' }] }).success
    && !sc.input.safeParse({ projectId: P, datasetId: L, calculated: [{ name: 'n', expression: 'x'.repeat(4_001) }] }).success
    && !sc.input.safeParse({ projectId: P, datasetId: L, calculated: [{ name: 'n', expression: '1', type: 'number' }] }).success
    && sc.input.safeParse({ projectId: P, datasetId: L, calculated: INPUT }).success);
  ok('NEGATIVE CONTROL: an extract answers not_live', (await set(INPUT, s.extractId)).code === 'not_live' && !('calculated' in (await raw(s.extractId))));

  // ── § doors ──────────────────────────────────────────────────────────────
  const M = (column: string, aggregation: string) => ({ column, aggregation });
  const F = (column: string, op: string, value?: unknown, values?: unknown[]) => ({ type: 'filter', column, op, ...(value === undefined ? {} : { value }), ...(values ? { values } : {}) });
  const chart = async (encoding: unknown, filters: unknown[] = [], d = L): Promise<Reply> => (await post('visual:data', { projectId: P, datasetId: d, encoding, filters })).value;
  const kpi = async (column: string, aggregation: string, filters: unknown[] = [], d = L): Promise<Reply> =>
    (await post('dashboard:metric', { projectId: P, datasetId: d, column, aggregation, filters })).value;
  const last = () => H.fake.calls.at(-1)!;
  const PLAIN = { category: 'region', values: [M('amt', 'sum')] };
  const ENC = { category: 'cat', values: [M('amt', 'sum')] };
  const hydrated0 = hydrated.length;

  await set([]);
  H.queryCache.clear();
  await chart(PLAIN);
  const before = { sql: last().sql, params: show(last().params) };
  const QUOTED = { name: 'Q', expression: "IF [cat] = 'o\\'k' THEN 1 ELSE 0 END" };
  const D_CALCS = [...INPUT, QUOTED, { name: 'Margin2', expression: '[Margin] * 2' }];
  ok('the door calcs save', (await set(D_CALCS)).ok === true);
  H.queryCache.clear();
  await chart(PLAIN);
  ok('NEGATIVE CONTROL: a statement naming no calc is byte-identical to before the calcs were saved',
    last().sql === before.sql && show(last().params) === before.params && !last().sql.includes('Margin'), last().sql);

  for (const [label, enc] of [
    ['sum of a calc', { category: 'cat', values: [M('Margin', 'sum')] }],
    ['a text calc as the category', { category: 'Band', values: [M('amt', 'sum')] }],
    ['bins over a calc', { category: 'Margin', values: [M('qty', 'count')] }],
    ['a split by a calc', { category: 'cat', series: 'Band', values: [M('amt', 'sum')] }],
    ['a calc over a calc', { category: 'cat', values: [M('Margin2', 'max')] }],
  ] as [string, unknown][]) {
    const r = await chart(enc);
    ok(`${label}: answered from the warehouse`, r.ok === true && r.asOf?.mode === 'live' && r.data.labels.length > 0, show(r).slice(0, 300));
  }
  const two = last().sql;
  ok('a calc over a calc: two derived tables, both calcs, in order', (two.match(/\) AS lv_src/g) ?? []).length === 3
    && two.indexOf('AS "Margin2" FROM (') < two.indexOf('AS "Margin" FROM ('), two);
  H.queryCache.clear();
  await chart({ category: 'cat', values: [M('Margin', 'sum')] });
  const sqlAll = last().sql;
  const one = sqlAll.slice(sqlAll.indexOf('FROM (SELECT'), sqlAll.lastIndexOf(') AS lv_src') + 1); // the layers alone
  ok('…and a layer projects only what is still needed (never *, never an unread column)', one.length > 0 && !one.includes('*') && !one.includes('"region"') && !one.includes('"Band"')
    && !one.includes('"Margin2"') && one.includes('"amt"') && one.includes('"qty"') && one.includes('"cat"'), one);
  ok('a filter on a calc applies', ((a, b) => a.ok && b.ok && show(a.data) !== show(b.data))(await chart(ENC, [F('Band', '=', 'big')]), await chart(ENC)));
  ok('a filter on a calc is never skipped as an unknown column', ((r) => r.ok && !show(r.warnings).includes('unknown column'))(await chart(ENC, [F('Band', '=', 'big')])));
  const q = await chart({ category: 'cat', values: [M('Q', 'sum')] });
  ok('literals are bound: the quote never reaches SQL text', q.ok === true && !last().sql.includes("o'k") && last().params.some((x) => x.value === "o'k"), show(last().params));
  const kM = await kpi('Margin', 'sum');
  ok('a KPI over a calc', kM.ok === true && typeof kM.value === 'number', show(kM));
  ok('a KPI filtered on a calc', ((r) => r.ok === true && r.value !== kM.value)(await kpi('Margin', 'sum', [F('Band', '=', 'big')])));
  const card = (await post('answer:card', { projectId: P, spec: {
    datasetId: L, category: 'Band', measures: [M('Margin', 'sum')], filters: [{ column: 'Band', op: 'in', values: ['BIG'] }], chartType: 'bar', title: 'Margin by band',
  } })).value;
  ok('an answer card over calcs, its text filter fixed to the stored spelling', card.ok === true && show(card.steps) === show([{ type: 'filter', column: 'Band', op: 'in', values: ['big'] }]), show(card).slice(0, 400));
  const distinct = (await post('dataset:distinct', { projectId: P, datasetId: L, column: 'Band' })).value;
  ok('a calc has no value list: the "not sampled" state', distinct.ok === false && distinct.reason === 'notSampled', show(distinct));

  // An edit moves the cache key with no epoch bump. Written as ANOTHER pod would see it: no cache cleared here.
  const ASK = { category: 'cat', values: [M('Margin', 'sum')] };
  const was = await chart(ASK);
  const k1 = H.fake.calls.length;
  ok('NEGATIVE CONTROL: asked again unchanged, it is a cache hit', (await chart(ASK)).ok && H.fake.calls.length === k1);
  await H.as(ORG_A, () => H.liveDataset.setLiveCalcs(P, L, [{ name: 'Margin', expression: '[amt] + [qty]', type: 'number' }, ...saved.calculated.slice(1)]));
  const now = await chart(ASK);
  ok('an edit moves the cache key with no epoch bump: a new warehouse call, a new figure', now.ok && H.fake.calls.length > k1 && show(now.data) !== show(was.data)
    && (await meta()).live.epoch === e0);
  await H.as(ORG_A, () => H.liveDataset.setMaxCacheAge(P, L, 0));
  H.fake.hook = async () => ({ ok: false, error: 'warehouse suspended' });
  ok('NEGATIVE CONTROL: unchanged, a failing warehouse serves the stale answer', ((r) => r.ok && r.asOf.stale === true)(await chart(ASK)));
  await H.as(ORG_A, () => H.liveDataset.setLiveCalcs(P, L, [{ name: 'Margin', expression: '[amt] * [qty]', type: 'number' }, ...saved.calculated.slice(1)]));
  const failed = await chart(ASK);
  ok('…but after an edit the stale fallback never serves the old formula\'s answer', failed.ok === false && failed.code === 'live_failed', show(failed).slice(0, 200));
  H.fake.hook = null;
  await H.as(ORG_A, () => H.liveDataset.setMaxCacheAge(P, L, 300));
  ok('getDataset is never called (the liveRoute spy)', !hydrated.slice(hydrated0).includes(L), show(hydrated.slice(hydrated0)));

  ok('a row access rule on a calc is refused (its column is checked against raw.columns, which never holds one)',
    !rowPolicy.textColumn(await raw(), 'Band') && rowPolicy.textColumn(await raw(), 'cat'));
  // ── § base filters (part 1 step 08 with step 04) ─────────────────────────
  // On its own table, so the other sections never see the filters.
  await H.warehouseExec(ORG_A, 'CREATE TABLE live_calc5 AS SELECT * FROM live_typed');
  const L5 = (await H.as(ORG_A, () => H.liveOver(P, { table: 'live_calc5' }, H.fx.COLUMNS))).liveId;
  const setBase = async (filters: unknown[]): Promise<Reply> => (await post('live:setBaseFilters', { projectId: P, datasetId: L5, filters })).value;
  const BASE = [F('region', '!=', 'North')];
  ok('base: the filter on a warehouse column saves', (await setBase(BASE)).ok === true);
  H.queryCache.clear();
  await chart(PLAIN, [], L5);
  const part1 = { sql: last().sql, params: show(last().params) };
  ok('the calcs save beside the base filters', (await set(INPUT, L5)).ok === true);
  const onCalc = await setBase([...BASE, F('Band', '=', 'big')]);
  ok('a base filter naming a calc is refused at save (it would run before any calc exists)', onCalc.ok === false && onCalc.reason === 'baseFilter'
    && show((await raw(L5)).baseFilters) === show(BASE), show(onCalc));
  H.queryCache.clear();
  await chart(PLAIN, [], L5);
  ok('NEGATIVE CONTROL: with base filters, a statement naming no calc is byte-identical to part 1\'s', last().sql === part1.sql && show(last().params) === part1.params, last().sql);
  const byCalc = await chart({ category: 'cat', values: [M('Margin', 'sum')] }, [F('Band', '=', 'big')], L5);
  const layered = last().sql;
  const outer = layered.slice(layered.lastIndexOf(') AS lv_src')); // after the layers: the outer WHERE
  ok('a statement naming a calc: the base filter sits innermost, once, and the outer WHERE holds the question\'s filter only',
    byCalc.ok === true && /"live_calc5" AS lv_src WHERE [^)]*"region"/.test(layered) && (layered.match(/"region"/g) ?? []).length === 1
    && !outer.includes('"region"') && outer.includes('"Band"'), layered);
  ok('…the region values are bound, never SQL text', !layered.includes("'North'") && last().params.some((x) => x.value === 'North'), show(last().params));
  const kBase = await kpi('Margin', 'sum', [], L5);
  await setBase([]);
  const kNone = await kpi('Margin', 'sum', [], L5);
  ok('NEGATIVE CONTROL: the base filter changes a calc\'s KPI', kBase.ok === true && kNone.ok === true && kBase.value !== kNone.value, show([kBase.value, kNone.value]));
  await setBase(BASE);
  const baseCopy = (await post('dataset:copyLive', { projectId: P, datasetId: L5 })).value;
  const BC = baseCopy.dataset?.id as string;
  ok('Make a copy: its Prepare steps are the base filters, then the calcs', baseCopy.ok === true && show((await meta(BC)).steps) === show([...BASE, ...INPUT.map((c) => ({ type: 'calculated_field', ...c }))]), show(baseCopy));
  // max and count are exact on both sides (Object.is); chart parity over base filters and calcs is test-liveParity's (liveParityCalcs).
  const KPIS: [string, string, unknown[]][] = [['Margin', 'max', []], ['Band', 'count', []], ['Margin', 'max', [F('Band', '=', 'big')]], ['amt', 'count', [F('Band', '=', 'small')]]];
  const pairs: Reply[][] = [];
  for (const [c, a, fl] of KPIS) pairs.push([await kpi(c, a, fl, L5), await kpi(c, a, fl, BC)]);
  const kMax = pairs[0][0];
  ok('…and its figures are Live\'s: max and count of calcs, plain and filtered on a calc (Object.is)', pairs.every(([l, c]) => l.ok && c.ok && typeof l.value === 'number' && Object.is(l.value, c.value)),
    show(pairs.map(([l, c]) => [l.value, c.value])));
  const switchedB = (await post('dataset:setMode', { projectId: P, datasetId: L5, mode: 'extract' })).value;
  ok('Copy the data instead: the base filters then the calcs, and neither top-level key', switchedB.ok === true
    && show((await raw(L5)).steps.map((x: Reply) => x.type)) === '["filter","calculated_field","calculated_field"]'
    && !('calculated' in (await raw(L5))) && !('baseFilters' in (await raw(L5))) && Object.is((await kpi('Margin', 'max', [], L5)).value, kMax.value), show(switchedB));

  // A second dataset over its own table, so its warehouse can change under it.
  await H.warehouseExec(ORG_A, 'CREATE TABLE live_calc2 AS SELECT * FROM live_typed');
  const L2 = (await H.as(ORG_A, () => H.liveOver(P, { table: 'live_calc2' }, H.fx.COLUMNS))).liveId;
  ok('the second dataset takes the calcs', (await set(INPUT, L2)).ok === true);
  await H.warehouseExec(ORG_A, 'ALTER TABLE live_calc2 DROP COLUMN qty');
  ok('the sync drops qty', ((r) => r.ok && show(r.removed) === '["qty"]')((await post('dataset:syncLiveSchema', { projectId: P, datasetId: L2 })).value));
  const gone = await chart({ category: 'cat', values: [M('Margin', 'sum')] }, [], L2);
  ok('a dropped input refuses what reads the calc: columnMissing', gone.ok === false && gone.reason === 'columnMissing' && /qty/.test(gone.error), show(gone));
  ok('…and only that: the other calc and the columns still answer', (await chart({ category: 'Band', values: [M('amt', 'sum')] }, [], L2)).ok
    && (await chart(PLAIN, [], L2)).ok);
  ok('…a filter on the broken calc refuses too, never skips', ((r) => r.ok === false && r.reason === 'columnMissing')(await chart(PLAIN, [F('Margin', '>', 0)], L2)));
  await H.warehouseExec(ORG_A, 'ALTER TABLE live_calc2 ADD COLUMN band VARCHAR');
  await post('dataset:syncLiveSchema', { projectId: P, datasetId: L2 });
  const clash = await chart({ category: 'Band', values: [M('amt', 'sum')] }, [], L2);
  ok('a warehouse column spelled like a calc (ignoring case): the calc refuses, typed', clash.ok === false && clash.reason === 'calculated' && /Band/.test(clash.error), show(clash));
  ok('…and so does the warehouse column: nothing silently reads either', ((r) => r.ok === false && r.reason === 'calculated')(await chart({ category: 'band', values: [M('amt', 'sum')] }, [], L2)));
  ok('…while a statement naming neither answers', (await chart(PLAIN, [], L2)).ok);

  // ── § schema ─────────────────────────────────────────────────────────────
  const view = (await liveSchema(L2)).calculated;
  ok('the Schema reply lists the calcs with formula and type', view.allowed === true && show(view.fields.map((f: Reply) => [f.name, f.expression, f.type]))
    === show(saved.calculated.map((c: Reply) => [c.name, c.expression, c.type])), show(view));
  ok('a calc whose input was dropped shows its problem, naming it', /qty/.test(view.fields[0].problem ?? ''), show(view.fields[0]));
  ok('a calc a warehouse column now spells shows that problem', /already a column/.test(view.fields[1].problem ?? ''), show(view.fields[1]));
  ok('NEGATIVE CONTROL: a calc that runs has no problem', ((v) => v.fields.every((f: Reply) => f.problem === undefined))((await liveSchema(L)).calculated));
  ok('Databricks: not allowed, and why', ((v) => v.allowed === false && /Databricks/.test(v.why ?? ''))(calcIpc.calculatedView(await meta(), 'databricks', false)));
  const closedView = calcIpc.calculatedView(await meta(L2), 'duckdb', true);
  ok('a restricted caller gets each name and type, never the formula or its problem', show(closedView.fields.map((f) => [f.name, f.type, f.expression, f.hidden, f.problem]))
    === show(saved.calculated.map((c: Reply) => [c.name, c.type, '', true, undefined])), show(closedView));
  ok('redactCalcs: open is as is', show(liveCalcs.redactCalcs(saved.calculated, false)) === show(saved.calculated));

  // ── § copies ─────────────────────────────────────────────────────────────
  ok('the copy calcs save', (await set(INPUT)).ok === true);
  H.queryCache.clear();
  const metaOf = (d: string) => meta(d);
  const liveMax = await kpi('Margin', 'max');
  const liveBand = await kpi('Band', 'count');
  const n1 = (await H.as(ORG_A, () => H.datasets.listDatasets(P))).length;
  const copied = (await post('dataset:copyLive', { projectId: P, datasetId: L })).value;
  ok('Make a copy answers', copied.ok === true && (await H.as(ORG_A, () => H.datasets.listDatasets(P))).length === n1 + 1, show(copied));
  const C = copied.dataset.id as string;
  ok('Make a copy: its Prepare steps are the calcs, in order', show((await metaOf(C)).steps) === show(INPUT.map((c) => ({ type: 'calculated_field', ...c }))), show((await metaOf(C)).steps));
  ok('…its columns are the warehouse\'s then the calcs', show((await metaOf(C)).columns.map((c) => c.name).slice(-2)) === '["Margin","Band"]' && (await metaOf(C)).sourceColumns?.length === H.fx.COLUMNS.length);
  ok('…its record has no Live keys', ((r) => !('calculated' in r) && r.mode === undefined && r.live === undefined)(await raw(C)));
  const copyMax = await kpi('Margin', 'max', [], C);
  const copyBand = await kpi('Band', 'count', [], C);
  ok('…and its figures are Live\'s (max and count, Object.is)', liveMax.ok && copyMax.ok && Object.is(copyMax.value, liveMax.value)
    && Object.is(copyBand.value, liveBand.value), show([liveMax.value, copyMax.value, liveBand.value, copyBand.value]));
  ok('…and the Live record is left as it was', show((await raw()).calculated) === show(saved.calculated) && (await meta()).mode === 'live');

  await H.warehouseExec(ORG_A, 'CREATE TABLE live_calc3 AS SELECT * FROM live_typed');
  const L3 = (await H.as(ORG_A, () => H.liveOver(P, { table: 'live_calc3' }, H.fx.COLUMNS))).liveId;
  await set(INPUT, L3);
  const switched = (await post('dataset:setMode', { projectId: P, datasetId: L3, mode: 'extract' })).value;
  const after = await raw(L3);
  ok('Copy the data instead: same id, the steps, no calculated key, no Live block', switched.ok === true && switched.mode === 'extract' && after.id === L3
    && show(after.steps.map((x: Reply) => x.type)) === '["calculated_field","calculated_field"]' && !('calculated' in after) && after.mode === undefined, show(switched));
  ok('…and its figures are Live\'s too', Object.is((await kpi('Margin', 'max', [], L3)).value, liveMax.value));

  await H.warehouseExec(ORG_A, 'CREATE TABLE live_calc4 AS SELECT * FROM live_typed');
  const L4 = (await H.as(ORG_A, () => H.liveOver(P, { table: 'live_calc4' }, H.fx.COLUMNS))).liveId;
  await set(INPUT, L4);
  await H.warehouseExec(ORG_A, 'ALTER TABLE live_calc4 DROP COLUMN qty');
  const n2 = (await H.as(ORG_A, () => H.datasets.listDatasets(P))).length;
  const short = (await post('dataset:copyLive', { projectId: P, datasetId: L4 })).value;
  ok('a copy whose fetched rows lack a calc\'s input refuses, typed, and saves nothing', short.ok === false && short.code === 'live_refused' && short.reason === 'calculated' && /Margin/.test(short.error)
    && (await H.as(ORG_A, () => H.datasets.listDatasets(P))).length === n2, show(short));
  const shortSwitch = (await post('dataset:setMode', { projectId: P, datasetId: L4, mode: 'extract' })).value;
  ok('…and so does Copy the data instead: the record stays Live', shortSwitch.ok === false && shortSwitch.reason === 'calculated' && (await meta(L4)).mode === 'live', show(shortSwitch));
  await H.as(ORG_A, () => rec.serialized(rec.datasetFilePath(P, L4), (r) => { r.calculated = [saved.calculated[0], 7]; }));
  ok('an unreadable list still refuses a copy (calculatedUnreadable)', ((r) => r.ok === false && r.reason === 'calculatedUnreadable')((await post('dataset:copyLive', { projectId: P, datasetId: L4 })).value));

  await close();
  finish();
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
  finish();
});
