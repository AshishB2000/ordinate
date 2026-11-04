// A Live dataset's calculated fields (semantic layer part 8, step 04), end to end on the fake warehouse.
//
// § record   `setLiveCalcs` stores them at the record's top level; `applyLive` shows them as typed
//            columns at the end of `meta.columns`, never in `raw.columns`; a schema sync neither
//            removes, misses nor profiles them; the Schema reply lists warehouse columns only.
// § save     `live:setCalculated` checks the whole list (names unique ignoring case, no compiler prefix,
//            v1 formulas over earlier calcs only, never Databricks) and stores each with its static
//            type; `live:checkCalc` answers the editor's check with no rows and no warehouse call;
//            `formula:functions` marks what Live cannot run, and why.
//
//   npm run build:ts && node scripts/test-liveCalcs.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import type { Reply } from './liveRouteHarness';
import { H, close, post } from './liveRouteHarness';

const fs: typeof import('fs') = require('fs');
const rec: typeof import('../src/data/datasetRecord') = require('../src/data/datasetRecord');
const sync: typeof import('../src/engine/live/schemaSync') = require('../src/engine/live/schemaSync');
const liveCalcs: typeof import('../src/data/liveCalcs') = require('../src/data/liveCalcs');
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

  await close();
  finish();
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
  finish();
});
