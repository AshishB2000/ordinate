// Self-check for the Cube backend's encoder and reply reading (semantic layer part 7, e1; docs/live-data/cube.md).
// No Cube, no network.
//
//   § encode   every question the plan asks (scripts/semanticShapes.ts SHAPES) as ONE Cube query object: decoded back
//              to the same question by a strict parser of exactly that object (./semanticFakeCube.ts), every value
//              a string in a `values` array and never in a member name, pinned by a golden recorded once; what Cube
//              cannot express is refused `layerFilter` naming Cube, before anything is asked; names outside
//              CUBE_NAME_RE refused. NEGATIVE CONTROLS: an encoder that drops a NULL from a list fails the round
//              trip; one that writes a value into a member name fails the value check.
//   § reply    readLoad / loadRows: numbers by Cube's own annotation only, a missing member, '' and NULL in one
//              dimension refused, a reply at the cap truncated, a cut with a NULL first asked again, a value list's
//              blanks dropped before its cut.
//   § matrix   the semantic parity matrix (./semanticParityMatrix.ts) asked through the encoder, Cube's reading of
//              the query, the fake's answer in Cube's wire shape (a NULL first on `desc`, as Postgres) and loadRows:
//              equal to the extract (Object.is; sum/avg within 1e-13), the filters Cube cannot express refused.
//
//   npm run build:ts && node scripts/test-semanticCube.js

export {}; // module scope — sibling test scripts share top-level names
import { isDeepStrictEqual } from 'util';
import { ok, finish } from './selfcheck';
import type { CubeBody, CubeFilter } from '../src/connectors/cubeWire';
import type { LiveColumn, LiveIR, LiveRefusal } from '../src/engine/live/liveSpec';
import type { SemanticEnv, SemanticQuery } from '../src/engine/live/semantic/semanticQuery';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-semcube-'));
process.env.ORDINATE_LOCAL_DIR = tmp;
process.env.ORDINATE_TODAY = '2025-03-15'; // inside the fixture's dates, as test-semanticParity pins it

const cube: typeof import('../src/engine/live/semantic/cube') = require('../src/engine/live/semantic/cube');
const wire: typeof import('../src/connectors/cubeWire') = require('../src/connectors/cubeWire');
const adapters: typeof import('../src/engine/live/semantic/adapters') = require('../src/engine/live/semantic/adapters');
const es: typeof import('../src/engine/live/semantic/evaluateSemantic') = require('../src/engine/live/semantic/evaluateSemantic');
const spec: typeof import('../src/engine/live/liveSpec') = require('../src/engine/live/liveSpec');
const sq: typeof import('../src/engine/live/semantic/semanticQuery') = require('../src/engine/live/semantic/semanticQuery');
const qc: typeof import('../src/engine/queryCache') = require('../src/engine/queryCache');
const ck: typeof import('../src/analysis/categoryKey') = require('../src/analysis/categoryKey');
const shaped: typeof import('./semanticShapes') = require('./semanticShapes');
const fakeCube: typeof import('./semanticFakeCube') = require('./semanticFakeCube');
const cubeFixture: typeof import('./cubeFixture') = require('./cubeFixture');

const show = (v: unknown): string => JSON.stringify(v);
const GOLDEN = path.join(__dirname, 'fixtures', 'golden', 'semantic-cube.json');
const MODEL = 'orders';
const NAMES = { dataset: 'Orders', layer: 'Cube' };

const COLS: LiveColumn[] = [
  { name: 'region', type: 'text' }, { name: 'many', type: 'text' }, { name: 'amt', type: 'number' }, { name: 'tier', type: 'number' }, { name: 'd', type: 'date' },
];
const ENV: SemanticEnv = {
  dataset: 'Orders', layer: 'Cube', columns: COLS,
  metrics: new Map(['revenue', 'orders', 'avg_amount'].map((m) => [m, { additive: m !== 'avg_amount' }])),
  grains: new Map([['d', ck.DATE_GRAINS]]),
  caps: { lookups: true, binaryCompare: false },
};
/** The shapes Cube cannot express exactly: text order, a case-sensitive contains, a text "empty" (whitespace). */
const REFUSED = new Set(['filter text <', 'filter contains', 'filter empty']);

const encode = (q: SemanticQuery, columns = COLS): import('../src/connectors/semanticRun').SemanticRequest | LiveRefusal => cube.cubeAdapter.encode(q, MODEL, columns, NAMES);
const bodyOf = (q: SemanticQuery): CubeBody => {
  const r = encode(q);
  if (spec.isRefusal(r)) throw new Error(`refused: ${r.code}`);
  return r.body as CubeBody;
};
const throwsWith = (fn: () => unknown, re: RegExp): boolean => {
  try {
    fn();
    return false;
  } catch (err) {
    return re.test(err instanceof Error ? err.message : String(err));
  }
};

/** The query with every `values` array taken out: what may name things, never carry a value. */
function withoutValues(f: unknown): unknown {
  if (Array.isArray(f)) return f.map(withoutValues);
  if (f && typeof f === 'object') return Object.fromEntries(Object.entries(f).filter(([k]) => k !== 'values').map(([k, v]) => [k, withoutValues(v)]));
  return f;
}
const outsideValues = (q: SemanticQuery, body: CubeBody): Array<string | number> => {
  const text = show(withoutValues(body.query));
  return shaped.valuesOf(q).filter((v) => text.includes(show(String(v))) || text.includes(String(v)));
};

function encodeSection(): void {
  const SHAPES = shaped.shapes(ENV);
  const golden: Array<[string, unknown]> = [];
  for (const [name, q] of SHAPES) {
    const r = encode(q);
    if (spec.isRefusal(r)) {
      golden.push([name, { refused: r.code }]);
      ok(`${name}: refused layerFilter, naming Cube and the field`, REFUSED.has(name) && r.code === 'layerFilter' && /Cube/.test(r.message) && r.params?.column === q.where[0]?.column, show(r));
      continue;
    }
    ok(`${name}: encoded (Cube can express it)`, !REFUSED.has(name));
    const body = r.body as CubeBody;
    golden.push([name, body]);
    let back: ReturnType<typeof fakeCube.decodeCube> | null = null;
    try {
      back = fakeCube.decodeCube(body, COLS);
    } catch (err) {
      ok(`${name}: decodes`, false, `${err instanceof Error ? err.message : String(err)}\n${show(body)}`);
      continue;
    }
    ok(`${name}: decodes back to the same question, on the same model`, back.model === MODEL && isDeepStrictEqual(back.query, fakeCube.canonical(q, COLS)), show({ back: back.query, want: fakeCube.canonical(q, COLS) }));
    ok(`${name}: every value is a string in a values array, none outside one`, outsideValues(q, body).length === 0 && show(body.query).split('"values":').slice(1).every((v) => /^\[("([^"\\]|\\.)*"(,"([^"\\]|\\.)*")*)?\]/.test(v)), show(outsideValues(q, body)));
    ok(`${name}: one kind 'semantic' request, its rows named as the plan reads them, always an explicit limit`,
      r.kind === 'semantic' && show(r.columns) === show(sq.answerColumns(q)) && Number.isInteger(body.query.limit) && body.query.limit <= wire.CUBE_ROW_LIMIT && body.query.timezone === 'UTC');
  }
  // Recorded once (2026-11-05) and read by hand; never re-recorded to make this pass.
  ok('the golden requests are unchanged (never re-recorded)', fs.existsSync(GOLDEN) && qc.stableStringify(golden) === fs.readFileSync(GOLDEN, 'utf8'));
  ok('…and the shapes Cube refuses are exactly the three it cannot express', golden.filter(([, b]) => (b as { refused?: string }).refused).map(([n]) => n).sort().join() === [...REFUSED].sort().join());

  // A NULL (or a blank) in a text list matches '' and NULL both, exactly: `or` with `notSet`.
  const kpi = (where: SemanticQuery['where']): SemanticQuery => ({ dimensions: [], metrics: ['revenue'], where, order: [] });
  const withNull = kpi([{ kind: 'in', column: 'region', values: ['East', null], negate: false }]);
  const nb = bodyOf(withNull);
  ok('a NULL in a text list: equals the values and the blank, OR notSet', show(nb.query.filters) === show([{ or: [{ member: 'orders.region', operator: 'equals', values: ['East', ''] }, { member: 'orders.region', operator: 'notSet' }] }]), show(nb.query.filters));
  const dropNull = (f: CubeFilter): CubeFilter => ('or' in f ? { member: 'orders.region', operator: 'equals', values: ['East'] } : f);
  const dropped = fakeCube.decodeCube({ ...nb, query: { ...nb.query, filters: nb.query.filters.map(dropNull) } }, COLS);
  ok('NEGATIVE CONTROL: an encoder that drops the NULL fails the round trip', !isDeepStrictEqual(dropped.query, fakeCube.canonical(withNull, COLS)));
  const notIn = bodyOf(kpi([{ kind: 'in', column: 'region', values: ['East', ''], negate: true }]));
  ok('…not in a list holding a blank: notEquals AND set (Cube\'s notEquals keeps a NULL otherwise)', show(notIn.query.filters) === show([{ and: [{ member: 'orders.region', operator: 'notEquals', values: ['East', ''] }, { member: 'orders.region', operator: 'set' }] }]));
  const notInPlain = bodyOf(kpi([{ kind: 'in', column: 'region', values: ['East'], negate: true }]));
  ok('…not in a list without one: notEquals alone, which keeps a NULL as `not in` does', show(notInPlain.query.filters) === show([{ member: 'orders.region', operator: 'notEquals', values: ['East'] }]));
  const ops = (f: SemanticQuery['where'][number]): unknown => bodyOf(kpi([f])).query.filters[0];
  ok('a number ≠ leaves a NULL out (it is no number): notEquals AND set', show(ops({ kind: 'compare', column: 'amt', op: '!=', value: 3 })) === show({ and: [{ member: 'orders.amt', operator: 'notEquals', values: ['3'] }, { member: 'orders.amt', operator: 'set' }] }));
  ok('a comparison with no number keeps nothing; a list with none keeps nothing, its `not in` everything',
    show(ops({ kind: 'compare', column: 'amt', op: '>', value: 'x' })) === show({ and: [{ member: 'orders.amt', operator: 'set' }, { member: 'orders.amt', operator: 'notSet' }] })
      && show(ops({ kind: 'in', column: 'amt', values: ['x'], negate: true })) === show({ or: [{ member: 'orders.amt', operator: 'set' }, { member: 'orders.amt', operator: 'notSet' }] }));
  ok('a day: = is [d, d+1), < keeps a NULL (it compares as \'\'), > is from the next day',
    show(ops({ kind: 'compare', column: 'd', op: '=', value: '2024-02-28' })) === show({ and: [{ member: 'orders.d', operator: 'afterOrOnDate', values: ['2024-02-28'] }, { member: 'orders.d', operator: 'beforeDate', values: ['2024-02-29'] }] })
      && show(ops({ kind: 'compare', column: 'd', op: '<', value: '2024-12-31' })) === show({ or: [{ member: 'orders.d', operator: 'beforeDate', values: ['2024-12-31'] }, { member: 'orders.d', operator: 'notSet' }] })
      && show(ops({ kind: 'compare', column: 'd', op: '>', value: '2024-12-31' })) === show({ member: 'orders.d', operator: 'afterOrOnDate', values: ['2025-01-01'] }));
  const refusedOn = (f: SemanticQuery['where'][number]): string => {
    const r = encode(kpi([f]));
    return spec.isRefusal(r) ? r.code : 'encoded';
  };
  ok('refused: a day that is not an ISO day, a list of days, a text order, contains, a text "empty"',
    ['2024-6-30', '2024-02-30', '', 'soon'].every((v) => refusedOn({ kind: 'compare', column: 'd', op: '>', value: v }) === 'layerFilter')
      && refusedOn({ kind: 'in', column: 'd', values: ['2024-01-01'], negate: false }) === 'layerFilter'
      && refusedOn({ kind: 'compare', column: 'region', op: '>=', value: 'M' }) === 'layerFilter'
      && refusedOn({ kind: 'contains', column: 'region', value: 'a' }) === 'layerFilter'
      && refusedOn({ kind: 'empty', column: 'region', negate: true }) === 'layerFilter');
  ok('…as on any Live dataset: a period on text, contains on a number, an unknown field',
    refusedOn({ kind: 'range', column: 'region', from: '2024-01-01' }) === 'periodNotDate' && refusedOn({ kind: 'contains', column: 'amt', value: '1' }) === 'containsNumber'
      && refusedOn({ kind: 'compare', column: 'nope', op: '=', value: 'x' }) === 'unknownColumn');
  // A value list's own "not empty": '' and NULL out at Cube, whitespace out when read, its cut after.
  const values = bodyOf({ dimensions: [{ name: 'many' }], metrics: [], where: [{ kind: 'empty', column: 'many', negate: true }], order: [{ by: 'many', desc: false }], limit: 201 });
  ok('a value list\'s "not empty": notEquals \'\' AND set at Cube, the blanks named for the connector, Cube asked for every value and the cut after',
    show(values.nonBlank) === '["orders.many"]' && values.limit === 201 && values.query.limit === wire.CUBE_ROW_LIMIT
      && show(values.query.filters) === show([{ and: [{ member: 'orders.many', operator: 'notEquals', values: [''] }, { member: 'orders.many', operator: 'set' }] }]));

  const [, q] = SHAPES[0];
  ok('a model name outside CUBE_NAME_RE is refused', throwsWith(() => cube.cubeAdapter.encode(q, 'orders"; x', COLS, NAMES), /identifiers/) && throwsWith(() => cube.cubeAdapter.encode(q, 'a.b', COLS, NAMES), /identifiers/));
  ok('a member name outside it is refused', throwsWith(() => encode({ ...q, metrics: ['rev enue'] }), /identifiers/) && throwsWith(() => encode({ ...q, dimensions: [{ name: 'x.y' }] }, [...COLS, { name: 'x.y', type: 'text' }]), /identifiers/));
  ok('a dimension the dataset does not declare is refused', throwsWith(() => encode({ ...q, dimensions: [{ name: 'nope' }] }), /nope/));
  ok('a member asked twice is refused', throwsWith(() => encode({ ...q, metrics: ['revenue', 'revenue'] }), /twice/));
  ok('a date with no grain, an order by what is not asked, a limit at the cap: each refused',
    throwsWith(() => encode({ ...q, dimensions: [{ name: 'd' }] }), /grain/) && throwsWith(() => encode({ ...q, order: [{ by: 'tier', desc: false }] }), /not asked/)
      && throwsWith(() => encode({ ...q, limit: wire.CUBE_ROW_LIMIT }), /limit/));
  const inlined = { ...bodyOf(SHAPES.find(([n]) => n === 'filter text =')![1]) };
  inlined.query = { ...inlined.query, filters: [{ member: 'orders.region_Zanzibar', operator: 'set' }] };
  ok('NEGATIVE CONTROL: a value written into a member name fails the value check', outsideValues(SHAPES.find(([n]) => n === 'filter text =')![1], inlined).length > 0);

  ok('the Cube encoder is a shipped backend', adapters.adapterFor('cube') === cube.cubeAdapter);
  ok('…so no test may register another for it', throwsWith(() => adapters.registerTestSemanticAdapter('cube', cube.cubeAdapter), /shipped/));
  const files = cubeFixture.fixtureFiles();
  ok('the deployment\'s seed and model are what scripts/cubeFixture.ts writes (scripts/fixtures/cube)',
    Object.entries(files).every(([f, text]) => fs.readFileSync(path.join(__dirname, 'fixtures', 'cube', f), 'utf8') === text));
}

async function checkSection(): Promise<void> {
  // The runner says, before anything is asked, that Cube cannot express a filter: not even the latest day is looked up.
  const target = { semantic: { backend: 'cube', model: MODEL, env: ENV } } as unknown as import('../src/engine/live/liveTarget').LiveTarget;
  const check = adapters.semanticRunner(target, new AbortController().signal, () => undefined).check;
  const asked: string[] = [];
  const run = Object.assign(async (_q: SemanticQuery, step: string) => {
    asked.push(step);
    return { columns: [], rows: [] };
  }, { check });
  const ir: LiveIR = { ...shaped.chartIr(), filters: [{ kind: 'contains', column: 'many', value: 'm1' }, { kind: 'latest', column: 'd', period: 'last_quarter', yearsBack: 0 }] };
  const r = await es.evaluateSemantic(ir, ENV, run);
  ok('a filter Cube cannot express is refused before anything is asked (not even "last quarter"\'s latest day)', !r.ok && r.code === 'layerFilter' && asked.length === 0, show([r, asked]));
  const unchecked = await es.evaluateSemantic(ir, ENV, async (_q, step) => {
    asked.push(step);
    return { columns: ['d'], rows: [] };
  });
  ok('NEGATIVE CONTROL: a runner without the check asks the latest day first', asked[0] === 'latest' && !unchecked.ok, show(asked));
}

const rowsOf = (r: ReturnType<typeof wire.readLoad>): import('../src/connectors/types').ConnectorRows | null => ('rows' in r ? r : null);
const refusedRead = (r: ReturnType<typeof wire.readLoad>): string => ('error' in r ? r.error : '');

async function replySection(): Promise<void> {
  const body: CubeBody = { query: { measures: ['orders.revenue'], dimensions: ['orders.region', 'orders.tier'], timeDimensions: [], filters: [], order: [['orders.revenue', 'desc'], ['orders.region', 'asc']], limit: 3, timezone: 'UTC' } };
  const ann = { measures: { 'orders.revenue': { type: 'number' } }, dimensions: { 'orders.region': { type: 'string' }, 'orders.tier': { type: 'number' } } };
  const row = (region: unknown, tier: unknown, revenue: unknown) => ({ 'orders.region': region, 'orders.tier': tier, 'orders.revenue': revenue });
  const read = wire.readLoad(body, { data: [row('007', '2', '12.5'), row('East', 3, null)], annotation: ann });
  ok('a reply is read by member, a number only where Cube\'s annotation types it (007 stays text)',
    show(rowsOf(read)?.rows) === show([['007', 2, 12.5], ['East', 3, null]]) && show(rowsOf(read)?.columns.map((c) => c.name)) === '["region","tier","revenue"]', show(read));
  const missing = wire.readLoad(body, { data: [{ 'orders.region': 'x', 'orders.revenue': '1' }], annotation: ann });
  ok('a reply without a member it was asked for is refused', /without a member/.test(refusedRead(missing)));
  const twoBlanks = wire.readLoad(body, { data: [row('', 1, '1'), row(null, 1, '2')], annotation: ann });
  ok('a dimension answered both as \'\' and as NULL is refused (Ordinate keeps one blank)', /NULLIF/.test(refusedRead(twoBlanks)));
  const oneBlank = wire.readLoad(body, { data: [row('', 1, '1'), row('x', 1, '2')], annotation: ann });
  ok('NEGATIVE CONTROL: a \'\' alone is read', rowsOf(oneBlank)?.rows.length === 2);
  const capped = { ...body, query: { ...body.query, limit: wire.CUBE_ROW_LIMIT } };
  const full = wire.readLoad(capped, { data: Array.from({ length: wire.CUBE_ROW_LIMIT }, (_v, i) => row(`r${i}`, 1, '1')), annotation: ann });
  ok('a reply that fills the cap is truncated (refused tooLarge at the door)', rowsOf(full)?.truncated === true);

  // A cut is exact when every order column's NULLs come after its values, within the rows tied before it.
  ok('cutIsExact: values then NULLs (NULLS LAST) is exact', wire.cutIsExact([[3, 'a'], [2, 'b'], [null, 'c']], [0, 1]));
  ok('…a NULL first (Postgres on desc) is not', !wire.cutIsExact([[null, 'c'], [3, 'a'], [2, 'b']], [0, 1]));
  ok('…a NULL key inside the boundary tie, first, is not; last, is', !wire.cutIsExact([[3, 'a'], [2, null], [2, 'b']], [0, 1]) && wire.cutIsExact([[3, 'a'], [2, 'b'], [2, null]], [0, 1]));
  ok('…a NULL key outside the tie does not matter', wire.cutIsExact([[3, null], [2, 'a'], [1, 'b']], [0, 1]));
  const posts: number[] = [];
  const nullsFirst = await wire.loadRows(body, async (b) => {
    posts.push(b.query.limit);
    return { ok: true, json: { data: b.query.limit === 3 ? [row('z', 1, null), row('a', 1, '9'), row('b', 1, '8')] : [row('a', 1, '9'), row('b', 1, '8'), row('c', 1, '7'), row('z', 1, null)], annotation: ann } };
  });
  ok('a full reply with a NULL first is asked again without the cut, and every row comes back to be ranked here',
    show(posts) === show([3, wire.CUBE_ROW_LIMIT]) && nullsFirst.ok && 'rows' in nullsFirst && nullsFirst.rows.length === 4, show([posts, nullsFirst]));
  posts.length = 0;
  await wire.loadRows(body, async (b) => {
    posts.push(b.query.limit);
    return { ok: true, json: { data: [row('a', 1, '9'), row('b', 1, '8'), row('z', 1, null)], annotation: ann } };
  });
  ok('NEGATIVE CONTROL: a full reply with its NULLs last is asked once', show(posts) === '[3]');
  const list: CubeBody = { query: { measures: [], dimensions: ['orders.many'], timeDimensions: [], filters: [], order: [['orders.many', 'asc']], limit: wire.CUBE_ROW_LIMIT, timezone: 'UTC' }, nonBlank: ['orders.many'], limit: 2 };
  const listed = wire.readLoad(list, { data: ['\t', '  ', 'a', 'b', 'c'].map((v) => ({ 'orders.many': v })), annotation: { dimensions: { 'orders.many': { type: 'string' } } } });
  ok('a value list: whitespace-only values dropped, then the cut', show(rowsOf(listed)?.rows) === '[["a"],["b"]]', show(listed));
}

async function matrixSection(): Promise<void> {
  const fx: typeof import('./liveParityFixture') = require('./liveParityFixture');
  const mx: typeof import('./liveParityMatrix') = require('./liveParityMatrix');
  const fake: typeof import('./semanticFake') = require('./semanticFake');
  const pm: typeof import('./semanticParityMatrix') = require('./semanticParityMatrix');
  const TABLE = 'cube_fixture';
  const x = await mx.setupExtract(ok);
  if (!x) return;
  const layout = fx.layout(fx.COLUMNS);
  const source = await fx.duckEngine.load(TABLE, layout, fx.warehouseCells(fx.COLUMNS, x.rows));
  const columns = mx.declared(fx.duckEngine, layout);
  const env: SemanticEnv = {
    dataset: 'Fixture', layer: 'Cube', columns,
    metrics: new Map(Object.keys(fake.FAKE_METRICS).map((m) => [m, { additive: fake.FAKE_ADDITIVE.has(m) }])),
    grains: new Map([['d', ck.DATE_GRAINS]]),
    caps: { lookups: true, binaryCompare: false },
  };
  let posts = 0;
  /** Cube as the fake plays it: the query read as Cube runs it, answered in its wire shape, a NULL first on desc. */
  const post = async (b: CubeBody): Promise<{ ok: true; json: unknown }> => {
    posts += 1;
    const { query } = fakeCube.decodeCube(b, columns, 'cube');
    const all = await fake.runFake(TABLE, columns, { ...query, limit: undefined });
    return { ok: true, json: fakeCube.cubeReply(b, query, all.rows, columns) };
  };
  const ask = (log: import('./semanticParityMatrix').Log): import('../src/engine/live/semantic/evaluateSemantic').SemanticRunner => async (q, step) => {
    const req = cube.cubeAdapter.encode(q, 'orders', columns, { dataset: env.dataset, layer: env.layer });
    if (spec.isRefusal(req)) return req;
    const r = await wire.loadRows(req.body as CubeBody, post);
    if (!r.ok) throw new Error(r.error);
    if (r.truncated) throw new Error('past the cap'); // the door refuses it (tooLarge)
    const rows = sq.alignRows(r.columns.map((c) => c.name), r.rows, req.columns);
    if (!rows) return spec.refuse('rowShape');
    log.push({ q, step, rows: rows.length });
    return { columns: req.columns.slice(), rows };
  };
  const refused = (require('./semanticCubeLive') as typeof import('./semanticCubeLive')).cubeRefusedFilters(); // the nightly's own pins
  const b: import('./semanticParityMatrix').Bench = { x, env, typed: fx.env(source, columns), kit: mx.parityKit(x, fx.runDuck), ask, refused };
  await pm.matrix(b, (label, cond, extra) => ok(`Cube: ${label}`, cond, extra));
  ok(`…every question went to the fake Cube as its query object (${posts} posts)`, posts > 50);
  const values = await ask([])({ dimensions: [{ name: 'cat' }], metrics: [], where: [{ kind: 'empty', column: 'cat', negate: true }], order: [{ by: 'cat', desc: false }] }, 'chart');
  const listed = spec.isRefusal(values) ? [] : values.rows.map((r) => r[0]);
  ok('a value list over the fixture\'s blanks: no NULL, \'\', space, tab or NBSP in it, every other value once', listed.length > 5 && listed.every((v) => typeof v === 'string' && v.trim() !== '') && new Set(listed).size === listed.length, show(listed));
}

void (async () => {
  try {
    encodeSection();
    await checkSection();
    await replySection();
    await matrixSection();
  } catch (err) {
    ok('the suite reached its end', false, err instanceof Error ? err.stack : String(err));
  }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  finish();
})();
