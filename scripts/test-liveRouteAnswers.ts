// AI answers and the Assistant on a Live dataset (docs/live-data/00-plan.md
// L2.4), in server mode, against the fake warehouse.
//
//   case fix   "north" asked, "North" stored: a cached `SELECT DISTINCT … WHERE
//              key(col) IN (…) LIMIT 20` (per value asked) — compiled per dialect with the asked
//              values as PARAMETERS (an adversarial literal suite, and a
//              NEGATIVE CONTROL: an inlining dialect is caught), matching as JS
//              `trim().toLowerCase()` does (run on DuckDB), asked ONCE per set
//              of asked values whatever their case, spacing or order
//   guard      `guardAnswer` passes a narration citing the live answer's figures,
//              whose ledger carries the same figures as the extract's — and still
//              catches an invented number (NEGATIVE CONTROL)
//   copilot    a chart's facts come through `vizDataFor` (a spy on it), a Live
//              dataset's are its schema (never "0 rows"), a dashboard's Live KPI
//              card and a Live defined metric are the warehouse's figures — and,
//              the warehouse down, n/a and left out, the others still listed;
//              under the dashboard's saved filter the card is `analysis:tiles`'
//              figure; beside a scenario over a Live metric a question is still
//              answered, from the project
//   more       answer:explain, the Summary card, an alert rule — and a failing
//              warehouse skips that rule while the others are evaluated
//   spy        `datasets.getDataset` is never asked for the Live dataset
//
//   npm run build:ts && node scripts/test-liveRouteAnswers.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import type { Reply } from './liveRouteHarness';
import { H, close, hydrated, post } from './liveRouteHarness';
import type { AnswerSpec } from '../src/ai/answerSpec';
import type { CompileDialectId, SqlDialect } from '../src/engine/live/dialect';

const cmp: typeof import('./liveParityCompare') = require('./liveParityCompare');
const duck: typeof import('../src/engine/duckdb') = require('../src/engine/duckdb');
const comp: typeof import('../src/engine/live/compile') = require('../src/engine/live/compile');
const dialects: typeof import('../src/engine/live/dialects') = require('../src/engine/live/dialects');
const { duckdbDialect } = require('../src/engine/live/dialects/duckdb') as typeof import('../src/engine/live/dialects/duckdb');
const answers: typeof import('../src/ipc/answers') = require('../src/ipc/answers');
const catalog: typeof import('../src/app/catalog') = require('../src/app/catalog');
const copilotIpc: typeof import('../src/ipc/copilot') = require('../src/ipc/copilot');
const visualsIpc: typeof import('../src/ipc/visuals') = require('../src/ipc/visuals');
const visuals: typeof import('../src/analysis/visuals') = require('../src/analysis/visuals');
const analysis: typeof import('../src/analysis/analysis') = require('../src/analysis/analysis');
const alertStore: typeof import('../src/analysis/alertStore') = require('../src/analysis/alertStore');
const metricsStore: typeof import('../src/analysis/metrics') = require('../src/analysis/metrics');
const scenarios: typeof import('../src/analysis/scenarios') = require('../src/analysis/scenarios');
const relationships: typeof import('../src/analysis/relationships') = require('../src/analysis/relationships');

const { fake, queryCache, ORG_A } = H;
const show = (v: unknown): string => JSON.stringify(v);
const sameLabels = (a: unknown[], b: string[]): boolean => a.length === b.length && a.every((l, i) => String(l) === b[i]);
const M = (column: string, aggregation: 'sum' | 'avg' | 'count' | 'min' | 'max') => ({ column, aggregation });
const lookups = (): typeof fake.calls => fake.calls.filter((c) => c.sql.startsWith('SELECT DISTINCT'));

// The literals test-liveCompile throws at every filter form, at the case fix.
const HOSTILE = [
  "'", "''", '\\', "\\'", '‘’“”', '${x}', '\u0000', '?', '@p1', ':p0', '{p0:String}', '$1', '"', '`', '--',
  '/*', "'; DROP TABLE orders; --", '%', '_', '!', '\n', "Robert'); DROP TABLE students;--", 'a\u0000b', '‮', '\\x{0009}',
];
const SENTINEL = 'sentinel_value';
const ENV = (dialect: CompileDialectId | SqlDialect) => ({ dialect, source: { kind: 'table' as const, parts: ['db', 'orders'] }, columns: [{ name: 'region', type: 'text' as const }] });

/** The case-fix statement with `v` asked, and with a harmless value: the TEXT must not move, the value must be a parameter. */
function caseLeak(d: CompileDialectId | SqlDialect, v: string): string | null {
  const a = comp.compileCaseMatches('region', [v], ENV(d));
  const b = comp.compileCaseMatches('region', [SENTINEL], ENV(d));
  if (!a.ok || !b.ok) return `refused ${show(v)}`;
  if (a.query.sql !== b.query.sql || a.query.sql.includes(SENTINEL)) return `the value reached the text: ${show(v)}`;
  if (!a.query.params.some((p) => p.value === v)) return `not a parameter: ${show(v)}`;
  return null;
}

(async () => {
  const s = await H.setupOrg(ORG_A);
  const P = s.projectId;
  const L = s.liveId;
  const X = s.extractId;
  duck.forbidSyncOnMainThread();
  const from = hydrated.length;

  // ── 1. The case fix ────────────────────────────────────────────────────────
  for (const id of dialects.DIALECT_IDS) {
    const bad = HOSTILE.map((v) => caseLeak(id, v)).filter((x): x is string => !!x);
    ok(`${id}: the case fix's ${HOSTILE.length} hostile literals travel only as parameters`, bad.length === 0, bad.slice(0, 3).join(' | '));
    const q = comp.compileCaseMatches('region', ['west'], ENV(id));
    ok(`${id}: one DISTINCT, the key IN the asked values, LIMIT ${comp.CASE_FIX_LIMIT}`, q.ok && /^SELECT DISTINCT /.test(q.query.sql)
      && q.query.sql.endsWith(`LIMIT ${comp.CASE_FIX_LIMIT}`), q.ok ? q.query.sql : show(q));
  }
  const inlining: SqlDialect = { ...duckdbDialect, placeholder: (_i, p) => `'${String(p.value).replace(/'/g, "''")}'` };
  ok('NEGATIVE CONTROL: an inlining dialect is caught for every hostile literal', HOSTILE.every((v) => caseLeak(inlining, v) !== null));
  const notText = comp.compileCaseMatches('amt', ['1'], { ...ENV('duckdb'), columns: [{ name: 'amt', type: 'number' }] });
  ok('a case fix on a column not declared text is refused, typed', !notText.ok && notText.code === 'categoryType');

  // The key is JS's: trim() (NBSP and tab included) then toLowerCase() — run on DuckDB.
  const stored = ['West', ' west ', 'WEST', ' North\t', 'east', 'Northern', null];
  const rows = await H.as(ORG_A, async () => {
    await duck.execAsync('CREATE OR REPLACE TABLE case_fix (region VARCHAR)');
    await duck.queryAsync(`INSERT INTO case_fix VALUES ${stored.map((_v, i) => `(CAST($${i + 1} AS VARCHAR))`).join(', ')}`, stored);
    const q = comp.compileCaseMatches('region', ['west', 'north'], { ...ENV('duckdb'), source: { kind: 'table', parts: ['case_fix'] } });
    if (!q.ok) return null;
    return (await duck.queryAsync(q.query.sql, q.query.params.map((p) => p.value as string))).map((r) => String(r.o_v));
  });
  const want = stored.filter((v): v is string => typeof v === 'string' && ['west', 'north'].includes(v.trim().toLowerCase()));
  ok('on DuckDB the lookup returns exactly the spellings JS trim().toLowerCase() matches', !!rows && show([...rows].sort()) === show([...want].sort()), show([rows, want]));
  // An `in` of 30 values: the bound is per asked value, so none is left unfixed.
  const many = Array.from({ length: 30 }, (_v, i) => `V${String(i).padStart(2, '0')}`);
  const cut = await H.as(ORG_A, async () => {
    await duck.execAsync('CREATE OR REPLACE TABLE case_many (region VARCHAR)');
    await duck.queryAsync(`INSERT INTO case_many VALUES ${many.map((_v, i) => `($${i + 1})`).join(', ')}`, many);
    const q = comp.compileCaseMatches('region', many.map((v) => v.toLowerCase()), { ...ENV('duckdb'), source: { kind: 'table', parts: ['case_many'] } });
    if (!q.ok) return null;
    const run = async (sql: string): Promise<number> => (await duck.queryAsync(sql, q.query.params.map((x) => x.value as string))).length;
    return { all: await run(q.query.sql), fixed20: await run(q.query.sql.replace(/LIMIT \d+$/, `LIMIT ${comp.CASE_FIX_LIMIT}`)), sql: q.query.sql };
  });
  ok(`an \`in\` of 30 values asked: all 30 stored spellings come back (LIMIT ${comp.CASE_FIX_LIMIT} per value) — NEGATIVE CONTROL: one LIMIT ${comp.CASE_FIX_LIMIT} would fix only 20`,
    !!cut && cut.all === 30 && cut.fixed20 === comp.CASE_FIX_LIMIT && cut.sql.endsWith(`LIMIT ${30 * comp.CASE_FIX_LIMIT}`), show(cut));

  // Through the door: "north" fixed to "North", asked once, cached, order-blind.
  const spec = (values: string[]): AnswerSpec => ({
    datasetId: L, category: 'cat', measures: [M('amt', 'sum')], filters: [{ column: 'region', op: 'in', values }], chartType: 'bar', title: 'Sales by cat', top: 5,
  });
  queryCache.clear();
  H.fakeMod.resetFake();
  const first = (await post('answer:card', { projectId: P, spec: spec(['north', ' SOUTH']) })).value;
  const ext = (await post('answer:card', { projectId: P, spec: { ...spec(['north', ' SOUTH']), datasetId: X } })).value;
  ok('the answer\'s text filter is fixed to the stored spellings', first.ok === true && show(first.steps) === show([{ type: 'filter', column: 'region', op: 'in', values: ['North', 'South'] }]), show(first.steps));
  ok('…and draws what the extract draws', first.ok === true && ext.ok === true && cmp.compareCharts(ext.data, first.data, () => true, false).length === 0);
  const l1 = lookups();
  ok('one lookup statement, the asked values bound (keyed), never in its text', l1.length === 1 && show(l1[0].params.map((p) => p.value).slice(-2)) === show(['north', 'south'])
    && !/north|south/i.test(l1[0].sql), show(l1.map((c) => [c.sql, c.params])));
  let calls = fake.calls.length;
  await post('answer:card', { projectId: P, spec: spec(['NORTH ', 'south']) });
  ok('the same question asked in another case: ZERO warehouse calls (the lookup and the chart are cached)', fake.calls.length === calls, `${fake.calls.length - calls} more`);
  calls = fake.calls.length;
  const lookupsBefore = lookups().length;
  await post('answer:card', { projectId: P, spec: spec(['South', 'north']) });
  ok('…its values in another order: the lookup is the same statement (cached); only the chart is asked', lookups().length === lookupsBefore && fake.calls.length === calls + 1, `${fake.calls.length - calls} more`);
  const hostile = "x' OR '1'='1'; DROP TABLE live_typed; --\\ ’ ${1}";
  const adv = (await post('answer:card', { projectId: P, spec: spec([hostile]) })).value;
  const advLookup = lookups().at(-1);
  ok('an adversarial value asked: the lookup carries it as a parameter only', !!advLookup && advLookup.params.some((p) => p.value === hostile.trim().toLowerCase())
    && !advLookup.sql.includes('DROP') && !advLookup.sql.includes("'1'='1'"), show(advLookup));
  const advExt = (await post('answer:card', { projectId: P, spec: { ...spec([hostile]), datasetId: X } })).value;
  ok('…the answer is the extract\'s: an honest empty chart over a value nothing matches', adv.ok === true && advExt.ok === true
    && adv.data.labels.length === 0 && show(adv.data) === show(advExt.data) && show(adv.bullets) === show(advExt.bullets), show([adv.data, advExt.data]).slice(0, 300));
  ok('…and the warehouse table is still there', (await post('answer:card', { projectId: P, spec: spec(['north']) })).value.ok === true);

  // ── 2. guardAnswer audits a live answer ───────────────────────────────────
  const aSpec: AnswerSpec = { datasetId: L, category: 'region', measures: [M('amt', 'sum')], filters: [{ column: 'd', period: 'last_year' }], chartType: 'bar', title: 'Sales by region last year' };
  const builtLive = await H.as(ORG_A, () => answers.computeCard(P, aSpec));
  const builtExt = await H.as(ORG_A, () => answers.computeCard(P, { ...aSpec, datasetId: X }));
  if ('ok' in builtLive || 'ok' in builtExt) {
    ok('both answers built', false, show([builtLive, builtExt]).slice(0, 300));
  } else {
    const missing = builtExt.ledger.filter((e) => !builtLive.ledger.some((l) => l.label === e.label && cmp.sameNumber(e.value, l.value, true)));
    ok('the live card\'s ledger holds the extract\'s figures, label for label', missing.length === 0 && builtLive.ledger.length >= 4, show(missing).slice(0, 300));
    const line = builtLive.factsText.split('\n').find((x) => x.startsWith('- ') && x.includes('=')) ?? '';
    const [label, figure] = (line.split(': ')[1] ?? '').split(', ')[0].split('=');
    const fine = copilotIpc.guardAnswer(`${label} leads, at ${figure}.`, builtLive.ledger);
    ok(`guardAnswer passes a narration citing the live figure (${label} = ${figure})`, !!figure && fine.audit.ok && !fine.text.includes('did not compute'), show(fine));
    const made = copilotIpc.guardAnswer(`${label} leads, at 987654.321.`, builtLive.ledger);
    ok('NEGATIVE CONTROL: an invented number is still caught, and said', !made.audit.ok && made.text.includes('Contains a figure the app did not compute: 987654.321'), show(made));
    ok('the live card says when the warehouse answered, in its facts', /Data as of: .* UTC\./.test(builtLive.factsText) && builtLive.card.asOf?.mode === 'live');
  }

  // A filter VALUE on a column marked personal: the card a person sees says it, the facts a model narrates from do not.
  const KEPT_OUT = 'zq-canary-live';
  const markedSpec: AnswerSpec = { ...aSpec, filters: [{ column: 'cat', op: '!=', value: KEPT_OUT }] };
  await H.as(ORG_A, () => catalog.setColumn(P, L, 'cat', { sensitivity: 'personal' }));
  const hiddenLive = await H.as(ORG_A, () => answers.computeCard(P, markedSpec));
  await H.as(ORG_A, () => catalog.setColumn(P, L, 'cat', { sensitivity: 'none' }));
  const shownLive = await H.as(ORG_A, () => answers.computeCard(P, markedSpec));
  ok('a filter value on a marked column: on the live card, withheld from the facts its narration reads',
    !('ok' in hiddenLive) && hiddenLive.card.filterLabels[0] === `cat != ${KEPT_OUT}` && hiddenLive.factsText.includes('\nFiltered to: cat != (withheld).\n')
    && !hiddenLive.factsText.includes(KEPT_OUT), show(hiddenLive).slice(0, 400));
  ok('NEGATIVE CONTROL: unmarked, the same facts say it', !('ok' in shownLive) && shownLive.factsText.includes(`\nFiltered to: cat != ${KEPT_OUT}.\n`), show(shownLive).slice(0, 400));

  // A Live answer withholds what the Live FACTS withhold (src/ipc/liveProfile.ts `liveWithheld`): a column with a
  // PENDING proposal too, not only a marked one — its filter value, and its labels when the chart is BY it.
  const privacy: typeof import('../src/app/privacyStore') = require('../src/app/privacyStore');
  const byCat: AnswerSpec = { ...aSpec, category: 'cat', filters: [{ column: 'cat', op: '!=', value: KEPT_OUT }] };
  const proposed = await H.as(ORG_A, () => privacy.scanDataset(P, { id: L, columns: [{ name: 'cat', type: 'text' }], rows: [['a@x.test'], ['b@x.test'], ['c@x.test']] }));
  const asTurn = [{ id: 't', role: 'assistant' as const, text: '', createdAt: '', answer: byCat }];
  const pendingLive = await H.as(ORG_A, () => answers.computeCard(P, byCat));
  const pendingBlock = await H.as(ORG_A, () => answers.previousAnswer(P, asTurn));
  await H.as(ORG_A, () => privacy.decide(P, L, 'cat', 'none'));
  const dismissedLive = await H.as(ORG_A, () => answers.computeCard(P, byCat));
  const dismissedBlock = await H.as(ORG_A, () => answers.previousAnswer(P, asTurn));
  const catLabels = !('ok' in dismissedLive) ? dismissedLive.card.data.labels.map(String) : [];
  // The labels a text could not hold by chance (the fixture's hostile set has '', ' ' and '7' too).
  const telling = catLabels.filter((l) => l.trim().length >= 3 && !/^\d+$/.test(l.trim()));
  ok('pending: a proposal is on file for the column (the fixture holds)', proposed.some((p) => p.column === 'cat'), show(proposed));
  ok('pending: a live chart BY a column proposed as personal withholds its labels and its filter value from the facts — the card keeps them',
    !('ok' in pendingLive) && catLabels.length > 3 && telling.every((l) => !pendingLive.factsText.includes(l))
    && pendingLive.factsText.split(`${'(withheld)'}=`).length - 1 === catLabels.length
    && pendingLive.factsText.includes('(Labels from cat are withheld') && pendingLive.factsText.includes('cat != (withheld)') && !pendingLive.factsText.includes(KEPT_OUT)
    && sameLabels(pendingLive.card.data.labels, catLabels), !('ok' in pendingLive) ? pendingLive.factsText : show(pendingLive));
  ok('pending: a follow-up\'s PREVIOUS ANSWER block withholds the value too, and hands the merge that column',
    !!pendingBlock && !pendingBlock.block.includes(KEPT_OUT) && pendingBlock.withheld.has('cat') && !!dismissedBlock && dismissedBlock.block.includes(KEPT_OUT) && !dismissedBlock.withheld.has('cat'),
    show([pendingBlock?.block, dismissedBlock?.block]));
  ok('NEGATIVE CONTROL: dismissed, the same facts say them', !('ok' in dismissedLive) && telling.length >= 3 && telling.every((l) => dismissedLive.factsText.includes(l)) && dismissedLive.factsText.includes(KEPT_OUT));

  // ── 3. The Assistant's facts ───────────────────────────────────────────────
  const realViz = visualsIpc.vizDataFor;
  const drawn: string[] = [];
  (visualsIpc as { vizDataFor: typeof realViz }).vizDataFor = (p, d, e, f, o) => { drawn.push(d); return realViz(p, d, e, f, o); };
  const vis = await H.as(ORG_A, () => visuals.saveVisual(P, { name: 'Live by region', datasetId: L, chartType: 'bar', encoding: { category: 'region', values: [M('amt', 'sum')] }, filters: [] }));
  const facts = vis ? await H.as(ORG_A, () => copilotIpc.buildFacts(P, { kind: 'visual', id: vis.id })) : null;
  const chart = (await post('visual:data', { projectId: P, datasetId: L, encoding: { category: 'region', values: [M('amt', 'sum')] } })).value;
  ok('copilot: a chart\'s facts are drawn through vizDataFor (the spy saw the Live dataset)', drawn.includes(L), show(drawn));
  ok('…carrying the live figures, every one in the ledger', !!facts && chart.ok === true && chart.data.labels.every((lab: string, i: number) =>
    facts.text.includes(`${lab === null ? '' : lab}=${String(chart.data.series[0].values[i])}`) && facts.ledger.some((e) => Object.is(e.value, chart.data.series[0].values[i]))), facts ? facts.text : '');
  (visualsIpc as { vizDataFor: typeof realViz }).vizDataFor = realViz;
  const dsFacts = await H.as(ORG_A, () => copilotIpc.buildFacts(P, { kind: 'dataset', id: L }));
  ok('copilot: a Live dataset\'s facts are its schema — every column, LIVE, and never a row count', dsFacts.provenance.kind === 'dataset' && /— Live: its rows stay in the warehouse/.test(dsFacts.text)
    && H.fx.COLUMNS.every((c) => dsFacts.text.includes(`- ${c.name} (${c.type})`)) && !/\b0 rows\b|\brows,/.test(dsFacts.text), dsFacts.text);
  const board = await H.as(ORG_A, () => analysis.saveAnalysis(P, {
    name: 'Live KPIs', sheets: [{ name: 'One', cards: [{ type: 'metric', metric: { datasetId: L, column: 'qty', aggregation: 'sum', label: 'Live qty' }, layout: { x: 0, y: 0, w: 3, h: 2 } }] }],
  } as unknown as Parameters<typeof analysis.saveAnalysis>[1]));
  const kpi = (await post('dashboard:metric', { projectId: P, datasetId: L, column: 'qty', aggregation: 'sum' })).value;
  const aFacts = board ? await H.as(ORG_A, () => copilotIpc.buildFacts(P, { kind: 'analysis', id: board.id })) : null;
  ok('copilot: a dashboard\'s Live KPI card is the warehouse\'s figure', !!aFacts && aFacts.text.includes(`- Live qty: ${String(kpi.value)}`), aFacts ? aFacts.text : '');
  await H.as(ORG_A, async () => {
    await metricsStore.saveMetric(P, { name: 'Live revenue', datasetId: L, definition: { column: 'amt', aggregation: 'sum' } });
    await metricsStore.saveMetric(P, { name: 'Copy revenue', datasetId: X, definition: { column: 'amt', aggregation: 'sum' } });
  });
  const named = async (): Promise<string> => (board ? (await H.as(ORG_A, () => copilotIpc.buildFacts(P, { kind: 'analysis', id: board.id }))).text : '');
  queryCache.clear();
  const upFacts = await named();
  queryCache.clear();
  fake.hook = async () => ({ ok: false, error: 'warehouse down' });
  const downFacts = await H.capturingWarn(named);
  fake.hook = null;
  ok('copilot: the defined metrics carry a Live one\'s warehouse figure', upFacts.includes('Live revenue') && upFacts.includes('Copy revenue'), upFacts);
  ok('…its warehouse down: that metric is left out (never a guess), the others are still listed, the KPI card n/a', !downFacts.value.includes('Live revenue')
    && downFacts.value.includes('Copy revenue') && downFacts.value.includes('- Live qty: n/a'), downFacts.value);

  // The dashboard's saved filter reaches a Live KPI too (it was dropped): the facts' figure is `analysis:tiles`' own
  // reply to the item the open page sends for that card, under that filter — from the warehouse, never a hydration.
  const north = [{ type: 'filter', column: 'region', op: 'in', values: ['North'] }];
  const narrowed = await H.as(ORG_A, () => analysis.saveAnalysis(P, {
    name: 'Live KPIs, one region', filters: north, sheets: [{ name: 'One', cards: [{ type: 'metric', metric: { datasetId: L, column: 'qty', aggregation: 'sum', label: 'Live qty' }, layout: { x: 0, y: 0, w: 3, h: 2 } }] }],
  } as unknown as Parameters<typeof analysis.saveAnalysis>[1]));
  const tileOf = async (filters: unknown[]): Promise<Reply> => (await post('analysis:tiles', { projectId: P, params: [], items: [{ kind: 'metric', datasetId: L, column: 'qty', aggregation: 'sum', filters }] })).value[0];
  const [tNorth, tAll] = [await tileOf(north), await tileOf([])];
  const nFacts = narrowed ? (await H.as(ORG_A, () => copilotIpc.buildFacts(P, { kind: 'analysis', id: narrowed.id }))).text : '';
  const liveQty = (text: string): number => Number((/^- Live qty: (.+)$/m.exec(text) || [])[1]);
  ok('copilot: under a dashboard\'s saved filter a Live KPI card is analysis:tiles\' figure, and the facts name the filter\'s column', tNorth.ok === true && typeof tNorth.value === 'number'
    && Object.is(liveQty(nFacts), tNorth.value) && nFacts.includes('saved filters, on: "region".'), show([tNorth, nFacts]));
  ok('NEGATIVE CONTROL: the unfiltered tile is another figure — the one the unfiltered dashboard\'s facts carry, with no filter named', tAll.ok === true && !Object.is(tAll.value, tNorth.value)
    && Object.is(liveQty(upFacts), tAll.value) && !upFacts.includes('saved filters'), show([tAll, tNorth, upFacts]));

  // A scenario over a Live metric is refused whole (L2.6, test-liveSafetyNet). The dock beside one still answers —
  // from the project, with no scenario figure — instead of refusing every question while that page is open.
  const whatIf = async (metric: string): Promise<string> => H.as(ORG_A, async () => {
    const m = (await metricsStore.listMetrics(P)).find((x) => x.name === metric);
    const sc = m ? await scenarios.saveScenario(P, { name: 'What if', baseMetricIds: [m.id], drivers: [] }) : null;
    return sc ? (await copilotIpc.buildFacts(P, { kind: 'scenario', id: sc.id })).text : '';
  });
  const [liveIf, copyIf] = [await whatIf('Live revenue'), await whatIf('Copy revenue')];
  ok('copilot: beside a scenario over a Live metric a question is answered from the project, with no scenario figure', liveIf !== '' && !liveIf.includes('Scenario: "What if"'), liveIf);
  ok('NEGATIVE CONTROL: a scenario over the copy is the scenario\'s own facts', copyIf.includes('Scenario: "What if"'), copyIf);

  // ── 4. Explain, the Summary card, an alert ─────────────────────────────────
  const explained = (await post('answer:explain', { projectId: P, tile: { datasetId: L, encoding: { category: 'region', values: [M('amt', 'sum')] }, filters: [], chartType: 'bar', name: 'Live by region' } })).value;
  ok('answer:explain on a Live tile: a conversation with its card (no model: the bullets stand)', explained.ok === true && typeof explained.threadId === 'string', show(explained));
  // A follow-up on a Live answer: found from metadata alone, its refine merged by the app, the merged spec asked
  // of the warehouse. THE SPY below covers both — neither the lookup nor the merged card may hydrate.
  const liveSpec = answers.tileSpec({ datasetId: L, encoding: { category: 'region', values: [M('amt', 'sum')] }, filters: [], chartType: 'bar', name: 'Live by region' });
  const liveTurn = { id: '1', role: 'assistant' as const, text: '', createdAt: '', ...(liveSpec ? { answer: liveSpec } : {}) };
  const prev = await H.as(ORG_A, () => answers.previousAnswer(P, [liveTurn]));
  const narrowedTo = prev ? await H.as(ORG_A, () => answers.answerFromAction(P, {}, {
    kind: 'answer', intent: 'north only', spec: { refine: true, filters: [{ column: 'region', op: '=', value: 'north' }] },
  }, 'north only', copilotIpc.guardAnswer, prev.spec)) : null;
  ok('a follow-up on a Live answer: told of it by name, merged, and answered by the warehouse — one more filter, the same dataset',
    !!prev && /^PREVIOUS ANSWER[^\n]*\ndataset "[^"]+"; category "region"; measures sum\(amt\); chart bar\.$/.test(prev.block)
    && !!narrowedTo && narrowedTo.ok === true && narrowedTo.spec.datasetId === L && show(narrowedTo.spec.filters) === show([{ column: 'region', op: '=', value: 'north' }]),
    show([prev, narrowedTo]).slice(0, 400));
  const summary = (await post('summary:compute', { projectId: P, pages: [{ cards: [{ id: '0b8d3c2e-9a4f-4e1b-8c7d-6f5e4d3c2b1a', type: 'metric', layout: { x: 0, y: 0, w: 3, h: 2 }, metric: { datasetId: L, column: 'qty', aggregation: 'sum', label: 'Live qty' } }] }] })).value;
  ok('summary:compute: the Live KPI\'s sentence, from the warehouse\'s figure', summary.ok === true && (summary.sentences as Reply[]).some((x) => x.kind === 'kpi' && String(x.text).includes('Live qty')), show(summary));

  const rule = (datasetId: string, name: string) => ({ name, datasetId, metric: { column: 'amt', aggregation: 'sum' }, compare: 'threshold', threshold: { op: '>', value: 1 }, enabled: true });
  await H.as(ORG_A, async () => {
    await alertStore.saveRule(P, rule(L, 'Live sales'));
    await alertStore.saveRule(P, rule(X, 'Copy sales'));
  });
  queryCache.clear();
  const fired = await H.as(ORG_A, () => alertStore.evaluateProject(P));
  ok('alerts: a threshold rule on the Live dataset is evaluated on the warehouse\'s figure, and fires', fired.some((e) => e.ruleName === 'Live sales') && fired.some((e) => e.ruleName === 'Copy sales'), show(fired.map((e) => e.ruleName)));
  queryCache.clear();
  fake.hook = async () => ({ ok: false, error: 'warehouse down' });
  const before = (await H.as(ORG_A, () => alertStore.load(P))).rules.find((r) => r.name === 'Live sales');
  const warned = await H.capturingWarn(() => H.as(ORG_A, () => alertStore.evaluateProject(P)));
  const after = (await H.as(ORG_A, () => alertStore.load(P))).rules.find((r) => r.name === 'Live sales');
  ok('…a warehouse that does not answer skips that rule (its state untouched) and the others are still evaluated', show(before) === show(after)
    && (await H.as(ORG_A, () => alertStore.load(P))).rules.filter((r) => r.name === 'Copy sales').every((r) => (r.history || []).length >= 2), show(warned.lines).slice(0, 200));
  fake.hook = null;

  ok('THE SPY: nothing here asked getDataset for the Live dataset', !hydrated.slice(from).includes(L), show(hydrated.slice(from)));

  // AFTER the spy, because this case IS the safety net: a saved filter that reaches the Live dataset through a
  // relationship makes the join ask for its table, and getDataset refuses. The tile answers that ONE card
  // `live_dataset`, so the facts say n/a for it — the dock beside that dashboard still answers.
  const joined = await H.as(ORG_A, async () => {
    const side = await H.datasets.saveDataset(P, { name: 'Targets', sourceKind: 'csv', columns: [{ name: 'region', type: 'text' as const }, { name: 'units', type: 'number' as const }], rows: [['North', 5], ['South', 7]] });
    if (!side) return null;
    await relationships.saveRelationship(P, { from: { datasetId: side.id, column: 'region' }, to: { datasetId: L, column: 'region' }, cardinality: 'many_to_one' });
    const card = { type: 'metric', metric: { datasetId: side.id, column: 'units', aggregation: 'sum', label: 'Units' }, layout: { x: 0, y: 0, w: 3, h: 2 } };
    const save = (name: string, filters: unknown[]) => analysis.saveAnalysis(P, { name, filters, sheets: [{ name: 'One', cards: [card] }] } as unknown as Parameters<typeof analysis.saveAnalysis>[1]);
    // `amt` is a column only the Live side has: the filter is answered by the join.
    return { side: side.id, across: await save('Across the join', [{ type: 'filter', column: 'amt', op: '>', value: 0 }]), plain: await save('No filter', []) };
  });
  if (joined && joined.across && joined.plain) {
    const acrossFilter = [{ type: 'filter', column: 'amt', op: '>', value: 0 }];
    const refused = (await post('analysis:tiles', { projectId: P, params: [], items: [{ kind: 'metric', datasetId: joined.side, column: 'units', aggregation: 'sum', filters: acrossFilter }] })).value[0];
    const acrossFacts = await H.as(ORG_A, () => copilotIpc.buildFacts(P, { kind: 'analysis', id: joined.across!.id })).then((f) => f.text, (err: unknown) => `THREW ${String(err)}`);
    const plainFacts = (await H.as(ORG_A, () => copilotIpc.buildFacts(P, { kind: 'analysis', id: joined.plain!.id }))).text;
    ok('copilot: a card its tile refuses as live_dataset is n/a in the facts, and the question is still answered', refused.ok === false && refused.code === 'live_dataset'
      && acrossFacts.includes('- Units: n/a'), show([refused, acrossFacts]));
    ok('NEGATIVE CONTROL: without that filter the same card has its figure', /^- Units: 12$/m.test(plainFacts), plainFacts);
  } else {
    ok('the joined fixture saved', false);
  }
  await close();
  finish();
})().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
