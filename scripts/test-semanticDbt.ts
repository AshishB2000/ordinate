// Self-check for the dbt Semantic Layer backend's encoder and answer reading (semantic layer part 7, d1, BETA;
// docs/live-data/dbt-semantic-layer.md). No dbt, no network.
//
//   § encode   every question the plan asks (scripts/semanticShapes.ts SHAPES) as ONE createQuery's variables: decoded
//              back to the same question by a strict parser of exactly that body (./semanticFakeDbt.ts), every value
//              only inside `where` text and never in a name, pinned by a golden recorded once; what dbt cannot express
//              is refused `layerFilter` naming dbt, before anything is asked. NEGATIVE CONTROLS: an encoder that drops
//              a filter fails the round trip; one that writes a value into a name fails the value check.
//   § reply    readPage / finishRows: columns by name in any case, a missing or doubled one refused, metric text as a
//              number and `007` kept, '' and NULL in one dimension refused, the cap, a cut with a NULL first asked
//              again, a value list's blanks dropped before its cut.
//   § matrix   the semantic parity matrix (./semanticParityMatrix.ts) through the encoder, dbt's reading of the body,
//              the fake's answer as jsonResult pages (a NULL first on a descending order) and the connector's reading:
//              equal to the extract (Object.is; sum/avg within 1e-13), the filters dbt cannot express refused.
//
//   npm run build:ts && node scripts/test-semanticDbt.js

export {}; // module scope — sibling test scripts share top-level names
import { isDeepStrictEqual } from 'util';
import { ok, finish } from './selfcheck';
import type { DbtBody } from '../src/connectors/dbtWire';
import type { LiveColumn, LiveIR, LiveRefusal } from '../src/engine/live/liveSpec';
import type { SemanticEnv, SemanticQuery } from '../src/engine/live/semantic/semanticQuery';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-semdbt-'));
process.env.ORDINATE_LOCAL_DIR = tmp;
process.env.ORDINATE_TODAY = '2025-03-15'; // inside the fixture's dates, as test-semanticParity pins it

const dbt: typeof import('../src/engine/live/semantic/dbt') = require('../src/engine/live/semantic/dbt');
const wire: typeof import('../src/connectors/dbtWire') = require('../src/connectors/dbtWire');
const adapters: typeof import('../src/engine/live/semantic/adapters') = require('../src/engine/live/semantic/adapters');
const es: typeof import('../src/engine/live/semantic/evaluateSemantic') = require('../src/engine/live/semantic/evaluateSemantic');
const spec: typeof import('../src/engine/live/liveSpec') = require('../src/engine/live/liveSpec');
const sq: typeof import('../src/engine/live/semantic/semanticQuery') = require('../src/engine/live/semantic/semanticQuery');
const qc: typeof import('../src/engine/queryCache') = require('../src/engine/queryCache');
const ck: typeof import('../src/analysis/categoryKey') = require('../src/analysis/categoryKey');
const shaped: typeof import('./semanticShapes') = require('./semanticShapes');
const fakeDbt: typeof import('./semanticFakeDbt') = require('./semanticFakeDbt');

const show = (v: unknown): string => JSON.stringify(v);
const GOLDEN = path.join(__dirname, 'fixtures', 'golden', 'semantic-dbt.json');
const MODEL = 'orders';
const NAMES = { dataset: 'Orders', layer: 'dbt' };

// The shapes' dimensions as dbt types them: categorical (text) and time (date); dbt reports no number dimension.
const COLS: LiveColumn[] = [
  { name: 'region', type: 'text' }, { name: 'many', type: 'text' }, { name: 'amt', type: 'text' }, { name: 'tier', type: 'text' }, { name: 'd', type: 'date' },
];
const ENV: SemanticEnv = {
  dataset: 'Orders', layer: 'dbt', columns: COLS,
  metrics: new Map(['revenue', 'orders', 'avg_amount'].map((m) => [m, { additive: m !== 'avg_amount' }])),
  grains: new Map([['d', ck.DATE_GRAINS]]),
  caps: { lookups: true, binaryCompare: false },
};
/** What dbt cannot express exactly: an order on a categorical dimension, a whitespace-aware empty, a LIKE needing an escape. */
const REFUSED = new Set(['filter text <', 'filter number >', 'filter number <=', 'filter number >=', 'filter contains', 'filter empty', 'filter not empty']);

const encode = (q: SemanticQuery, columns = COLS): import('../src/connectors/semanticRun').SemanticRequest | LiveRefusal => dbt.dbtAdapter.encode(q, MODEL, columns, NAMES);
const bodyOf = (q: SemanticQuery): DbtBody => {
  const r = encode(q);
  if (spec.isRefusal(r)) throw new Error(`refused: ${r.code}`);
  return r.body as DbtBody;
};
const throwsWith = (fn: () => unknown, re: RegExp): boolean => {
  try {
    fn();
    return false;
  } catch (err) {
    return re.test(err instanceof Error ? err.message : String(err));
  }
};

/** Every value of `q` that shows up outside a `where` entry's quoted literals: in a name, an order, the saved query. */
const outsideWhere = (q: SemanticQuery, body: DbtBody): Array<string | number> => {
  const names = show({ ...body, where: undefined });
  return shaped.valuesOf(q).filter((v) => names.includes(String(v)));
};
/** Every value of `q` written into the where text as a quoted literal (a date as its day). */
const quotedInWhere = (q: SemanticQuery, body: DbtBody): boolean => {
  const where = body.where.map((w) => w.sql).join('\n');
  return shaped.valuesOf(q).every((v) => where.includes(`'${String(v).replace(/'/g, "''")}'`) || where.includes(`'%${String(v)}%'`));
};

function encodeSection(): void {
  const SHAPES = shaped.shapes(ENV);
  const golden: Array<[string, unknown]> = [];
  for (const [name, q] of SHAPES) {
    const r = encode(q);
    if (spec.isRefusal(r)) {
      golden.push([name, { refused: r.code }]);
      ok(`${name}: refused layerFilter, naming dbt and the field`, REFUSED.has(name) && r.code === 'layerFilter' && /dbt/.test(r.message) && r.params?.column === q.where[0]?.column, show(r));
      continue;
    }
    ok(`${name}: encoded (dbt can express it)`, !REFUSED.has(name));
    const body = r.body as DbtBody;
    golden.push([name, body]);
    let back: ReturnType<typeof fakeDbt.decodeDbt> | null = null;
    try {
      back = fakeDbt.decodeDbt(body, COLS);
    } catch (err) {
      ok(`${name}: decodes`, false, `${err instanceof Error ? err.message : String(err)}\n${show(body)}`);
      continue;
    }
    ok(`${name}: decodes back to the same question, on the same saved query`, back.savedQuery === MODEL && isDeepStrictEqual(back.query, fakeDbt.canonical(q, COLS)), show({ back: back.query, want: fakeDbt.canonical(q, COLS) }));
    ok(`${name}: every value is a quoted literal inside where text, none in a name`, outsideWhere(q, body).length === 0 && quotedInWhere(q, body), show(outsideWhere(q, body)));
    ok(`${name}: one kind 'semantic' request, its rows named as the plan reads them`, r.kind === 'semantic' && show(r.columns) === show(sq.answerColumns(q)));
  }
  // Recorded once (2026-11-05) and read by hand; never re-recorded to make this pass.
  ok('the golden requests are unchanged (never re-recorded)', fs.existsSync(GOLDEN) && qc.stableStringify(golden) === fs.readFileSync(GOLDEN, 'utf8'));
  ok('…and the shapes dbt refuses are exactly the ones it cannot express', golden.filter(([, b]) => (b as { refused?: string }).refused).map(([n]) => n).sort().join() === [...REFUSED].sort().join());

  const kpi = (where: SemanticQuery['where']): SemanticQuery => ({ dimensions: [], metrics: ['revenue'], where, order: [] });
  const withNull = kpi([{ kind: 'in', column: 'region', values: ['East', null], negate: false }]);
  const nb = bodyOf(withNull);
  ok('a NULL in a text list: the values, OR the blank, OR IS NULL', show(nb.where) === show([{ sql: "({{ Dimension('region') }} IN ('East') OR {{ Dimension('region') }} = '' OR {{ Dimension('region') }} IS NULL)" }]), show(nb.where));
  const dropped = fakeDbt.decodeDbt({ ...nb, where: [{ sql: "{{ Dimension('region') }} IN ('East')" }] }, COLS);
  ok('NEGATIVE CONTROL: an encoder that drops the NULL fails the round trip', !isDeepStrictEqual(dropped.query, fakeDbt.canonical(withNull, COLS)));
  const lost = fakeDbt.decodeDbt({ ...bodyOf(kpi([{ kind: 'compare', column: 'region', op: '=', value: 'West' }])), where: [] }, COLS);
  ok('NEGATIVE CONTROL: an encoder that drops a filter fails the round trip', !isDeepStrictEqual(lost.query, fakeDbt.canonical(kpi([{ kind: 'compare', column: 'region', op: '=', value: 'West' }]), COLS)));
  const westQ = kpi([{ kind: 'compare', column: 'region', op: '=', value: 'West' }]);
  ok('NEGATIVE CONTROL: a value written into a name fails the value check', outsideWhere(westQ, { ...bodyOf(westQ), metrics: [{ name: 'revenue_West' }] }).length > 0);
  // A value list's own "not empty": '' and NULL out at dbt, whitespace out when read, its cut after.
  const values = bodyOf({ dimensions: [{ name: 'many' }], metrics: [], where: [{ kind: 'empty', column: 'many', negate: true }], order: [{ by: 'many', desc: false }], limit: 201 });
  ok('a value list\'s "not empty": D <> \'\' at dbt, the blanks named for the connector, dbt asked for every value and the cut after',
    show(values.where) === show([{ sql: "{{ Dimension('many') }} <> ''" }]) && show(values.nonBlank) === '["many"]' && values.cut === 201 && values.limit === undefined);
  const latest = bodyOf({ dimensions: [{ name: 'd', grain: 'day' }], metrics: [], where: [{ kind: 'empty', column: 'd', negate: true }], order: [{ by: 'd', desc: true }], limit: 1 });
  ok('the latest day: a day group-by, IS NOT NULL, latest first, limit 1', show(latest) === show({ savedQuery: 'orders', metrics: [], groupBy: [{ name: 'd', grain: 'DAY' }], where: [{ sql: "{{ TimeDimension('d', 'day') }} IS NOT NULL" }], orderBy: [{ groupBy: { name: 'd', grain: 'DAY' }, descending: true }], limit: 1 }), show(latest));

  const [, q] = SHAPES[0];
  ok('a saved query name that is no dbt name is refused', throwsWith(() => dbt.dbtAdapter.encode(q, "orders') }}", COLS, NAMES), /saved query/) && throwsWith(() => dbt.dbtAdapter.encode(q, 'Orders', COLS, NAMES), /saved query/));
  ok('a metric or dimension name that is no dbt name is refused', throwsWith(() => encode({ ...q, metrics: ['Revenue'] }), /dbt name/) && throwsWith(() => encode({ ...q, dimensions: [{ name: 'x y' }] }, [...COLS, { name: 'x y', type: 'text' }]), /dbt name/));
  ok('a dimension the dataset does not declare, or a number one (dbt types none), is refused',
    throwsWith(() => encode({ ...q, dimensions: [{ name: 'nope' }] }), /nope/) && throwsWith(() => encode({ ...q, dimensions: [{ name: 'n' }] }, [...COLS, { name: 'n', type: 'number' }]), /number/));
  ok('a member asked twice, a date with no grain, an order by what is not asked, a limit past the cap: each refused',
    throwsWith(() => encode({ ...q, metrics: ['revenue', 'revenue'] }), /twice/) && throwsWith(() => encode({ ...q, dimensions: [{ name: 'd' }] }), /grain/)
      && throwsWith(() => encode({ ...q, order: [{ by: 'tier', desc: false }] }), /not asked/) && throwsWith(() => encode({ ...q, limit: 100_001 }), /limit/));
  const files = (require('./dbtFixture') as typeof import('./dbtFixture')).fixtureFiles();
  ok('the nightly\'s dbt project files are what scripts/dbtFixture.ts writes (scripts/fixtures/dbt-sl/project)',
    Object.entries(files).every(([f, text]) => fs.readFileSync(path.join(__dirname, 'fixtures', 'dbt-sl', 'project', f), 'utf8') === text));
  ok('the dbt encoder is a shipped backend', adapters.adapterFor('dbt') === dbt.dbtAdapter);
  ok('…so no test may register another for it', throwsWith(() => adapters.registerTestSemanticAdapter('dbt', dbt.dbtAdapter), /shipped/));
}

async function checkSection(): Promise<void> {
  // The runner says, before anything is asked, that dbt cannot express a filter: not even the latest day is looked up.
  const target = { semantic: { backend: 'dbt', model: MODEL, env: ENV } } as unknown as import('../src/engine/live/liveTarget').LiveTarget;
  const check = adapters.semanticRunner(target, new AbortController().signal, () => undefined).check;
  const asked: string[] = [];
  const run = Object.assign(async (_q: SemanticQuery, step: string) => {
    asked.push(step);
    return { columns: [], rows: [] };
  }, { check });
  const ir: LiveIR = { ...shaped.chartIr(), filters: [{ kind: 'compare', column: 'many', op: '=', value: 'it’s' }, { kind: 'latest', column: 'd', period: 'last_quarter', yearsBack: 0 }] };
  const r = await es.evaluateSemantic(ir, ENV, run);
  ok('a value the encoder cannot write is refused layerFilter before anything is asked (not even "last quarter"\'s latest day)', !r.ok && r.code === 'layerFilter' && asked.length === 0, show([r, asked]));
}

const rowsOf = (r: ReturnType<typeof wire.finishRows>): import('../src/connectors/types').ConnectorRows | null => ('rows' in r ? r : null);

function replySection(): void {
  const body: DbtBody = { savedQuery: 'orders', metrics: [{ name: 'revenue' }], groupBy: [{ name: 'region' }, { name: 'd', grain: 'MONTH' }], where: [], orderBy: [{ metric: { name: 'revenue' }, descending: true }, { groupBy: { name: 'region' }, descending: false }], limit: 3 };
  const page = (fields: string[], data: unknown[]): string => JSON.stringify({ schema: { fields: [{ name: 'index', type: 'integer' }, ...fields.map((name) => ({ name }))], primaryKey: ['index'] }, data });
  const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'dbt-sl', 'query-successful.json'), 'utf8')) as { reply: { data: { query: { jsonResult: string } } } };
  const doc: DbtBody = { savedQuery: 'order_metrics', metrics: [{ name: 'order_total' }], groupBy: [{ name: 'metric_time', grain: 'DAY' }], where: [], orderBy: [] };
  const read = wire.readPage(doc, fixture.reply.data.query.jsonResult);
  ok('the documented answer (scripts/fixtures/dbt-sl/query-successful.json) reads as the page prints it', show(read) === show([['2023-08-07T00:00:00.000', 3], ['2023-08-08T00:00:00.000', 112], ['2023-08-09T00:00:00.000', 12], ['2023-08-10T00:00:00.000', 5123]]), show(read));
  const upper = wire.readPage(body, page(['REGION', 'D__MONTH', 'REVENUE'], [{ index: 0, REGION: '007', D__MONTH: '2024-01-01T00:00:00.000', REVENUE: '12.50' }, { index: 1, REGION: 'East', D__MONTH: null, REVENUE: null }]));
  ok('columns are found by name in any case; metric text is a number, a dimension\'s 007 stays text', show(upper) === show([['007', '2024-01-01T00:00:00.000', 12.5], ['East', null, null]]), show(upper));
  ok('a reply without a column it was asked for is refused', 'error' in (wire.readPage(body, page(['region', 'revenue'], [])) as object));
  ok('a reply with two columns differing only by case is refused', /two columns/.test(show(wire.readPage(body, page(['region', 'Region', 'd__month', 'revenue'], [])))));
  ok('a jsonResult that is no table is refused', 'error' in (wire.readPage(body, '{"rows": []}') as object) && 'error' in (wire.readPage(body, null) as object));
  const twoBlanks = wire.finishRows(body, [['', 'a', 1], [null, 'a', 2]], 3, 100);
  ok('a dimension answered both as \'\' and as NULL is refused (Ordinate keeps one blank)', !('rows' in twoBlanks) && /blank/.test(show(twoBlanks)));
  ok('…past the row cap the reply is truncated (the door\'s tooManyGroups)', rowsOf(wire.finishRows({ ...body, limit: undefined }, [['a', 'x', 1], ['b', 'x', 2], ['c', 'x', 3]], 3, 2))?.truncated === true);
  ok('a full reply with a NULL first on the order is asked again without the cut', show(wire.finishRows(body, [['z', 'x', null], ['a', 'x', 9], ['b', 'x', 8]], 3, 100)) === '{"recut":true}');
  ok("a full reply with one blank form in a dimension is asked again without the cut (its '' may be past it)", show(wire.finishRows(body, [['a', 'x', 9], [null, 'x', 8], ['b', 'x', 7]], 3, 100)) === '{"recut":true}');
  ok('NEGATIVE CONTROL: …a NULL in a date dimension is no blank form, the reply kept', rowsOf(wire.finishRows(body, [['a', 'x', 9], ['b', null, 8], ['c', 'x', 7]], 3, 100))?.rows.length === 3);
  ok('NEGATIVE CONTROL: a full reply with its NULLs last is kept', rowsOf(wire.finishRows(body, [['a', 'x', 9], ['b', 'x', 8], ['z', 'x', null]], 3, 100))?.rows.length === 3);
  const list: DbtBody = { savedQuery: 'orders', metrics: [], groupBy: [{ name: 'many' }], where: [], orderBy: [{ groupBy: { name: 'many' }, descending: false }], nonBlank: ['many'], cut: 2 };
  ok('a value list: whitespace-only values dropped, then the cut', show(rowsOf(wire.finishRows(list, [['\t'], ['  '], ['a'], ['b'], ['c']], 100_001, 100_000))?.rows) === '[["a"],["b"]]');
  ok('a GraphQL errors array is an error with its words', show(wire.dataOf({ errors: [{ message: 'User is not authorized' }], data: null })) === '{"ok":false,"error":"User is not authorized"}');
}

async function matrixSection(): Promise<void> {
  const fx: typeof import('./liveParityFixture') = require('./liveParityFixture');
  const mx: typeof import('./liveParityMatrix') = require('./liveParityMatrix');
  const fake: typeof import('./semanticFake') = require('./semanticFake');
  const pm: typeof import('./semanticParityMatrix') = require('./semanticParityMatrix');
  const TABLE = 'dbt_fixture';
  const x = await mx.setupExtract(ok);
  if (!x) return;
  const layout = fx.layout(fx.COLUMNS);
  const source = await fx.duckEngine.load(TABLE, layout, fx.warehouseCells(fx.COLUMNS, x.rows));
  const typed = mx.declared(fx.duckEngine, layout);
  // dbt types every categorical dimension text: the encoder and dbt see that. The plan keeps the fixture's types, as the
  // matrix's extract twins total `amt` (its filters on `amt` reach the encoder as text and are refused, pinned).
  const columns = fakeDbt.asDbtTypes(typed);
  const env: SemanticEnv = {
    dataset: 'Fixture', layer: 'dbt', columns: typed,
    metrics: new Map(Object.keys(fake.FAKE_METRICS).map((m) => [m, { additive: fake.FAKE_ADDITIVE.has(m) }])),
    grains: new Map([['d', ck.DATE_GRAINS]]),
    caps: { lookups: true, binaryCompare: false },
  };
  let creates = 0;
  /** dbt as the fake plays it: the body read as dbt runs it, answered as jsonResult pages, a NULL first on a descending order. */
  const answer = async (b: DbtBody, limit: number): Promise<unknown[][]> => {
    creates += 1;
    const { query } = fakeDbt.decodeDbt({ ...b, limit }, columns, 'dbt');
    const all = await fake.runFake(TABLE, columns, { ...query, limit: undefined });
    const rows: unknown[][] = [];
    for (const p of fakeDbt.jsonPages({ ...b, limit }, query, all.rows, 1024)) {
      const read = wire.readPage(b, p);
      if ('error' in read) throw new Error(read.error);
      rows.push(...read);
    }
    return rows;
  };
  const ask = (log: import('./semanticParityMatrix').Log): import('../src/engine/live/semantic/evaluateSemantic').SemanticRunner => async (q, step) => {
    const req = dbt.dbtAdapter.encode(q, 'orders', columns, { dataset: env.dataset, layer: env.layer });
    if (spec.isRefusal(req)) return req;
    const b = req.body as DbtBody;
    let done: ReturnType<typeof wire.finishRows> = { recut: true };
    for (const limit of [b.limit ?? 100_001, 100_001]) {
      done = wire.finishRows(b, (await answer(b, limit)) as import('../src/connectors/httpShared').Cell[][], limit, 100_000);
      if (!('recut' in done)) break;
    }
    if (!('rows' in done)) throw new Error(show(done));
    if (done.truncated) throw new Error('past the cap');
    const rows = sq.alignRows(done.columns.map((c) => c.name), done.rows, req.columns);
    if (!rows) return spec.refuse('rowShape');
    log.push({ q, step, rows: rows.length });
    return { columns: req.columns.slice(), rows };
  };
  const b: import('./semanticParityMatrix').Bench = { x, env, typed: fx.env(source, typed), kit: mx.parityKit(x, fx.runDuck), ask, refused: fakeDbt.dbtRefusedFilters(), refusedCases: fakeDbt.dbtRefusedCases() };
  await pm.matrix(b, (label, cond, extra) => ok(`dbt: ${label}`, cond, extra));
  ok(`…every question went to the fake dbt as its createQuery (${creates} queries)`, creates > 50);
  const values = await ask([])({ dimensions: [{ name: 'cat' }], metrics: [], where: [{ kind: 'empty', column: 'cat', negate: true }], order: [{ by: 'cat', desc: false }] }, 'chart');
  const listed = spec.isRefusal(values) ? [] : values.rows.map((r) => r[0]);
  ok('a value list over the fixture\'s blanks: no NULL, \'\', space, tab or NBSP in it, every other value once', listed.length > 5 && listed.every((v) => typeof v === 'string' && v.trim() !== '') && new Set(listed).size === listed.length, show(listed));
}

void (async () => {
  try {
    encodeSection();
    await checkSection();
    replySection();
    await matrixSection();
  } catch (err) {
    ok('the suite reached its end', false, err instanceof Error ? err.stack : String(err));
  }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  finish();
})();
