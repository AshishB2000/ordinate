// Self-check for src/analysisPlan.ts — the AI plan: facts in, envelope out,
// validated, previewed, built.
//
// Style follows test-analysis.ts / test-vizRewire.ts: stub 'electron' via
// Module._load so userData is a fresh temp dir and every ipcMain.handle
// registration is captured, then drive the REAL modules against real disk. No
// framework.
//
// This suite exists to hold six properties, each of which fails silently
// otherwise:
//
//   1. AI IS OPTIONAL. With no model configured `analysis:draft` returns
//      not_ready — and `analysis:previewPlan` / `analysis:buildPlan` still work,
//      because a plan is data and validating data is app code.
//   2. THE ACCEPTANCE TEST FROM THE BRIEF. A plan carrying an invalid chart
//      type, an uncompilable formula and a bad encoding previews with EXACTLY
//      those three dropped, each with its own reported message.
//   3. THE FACTS BLOCK CARRIES NO ROWS AND NO SECRETS. Asserted against a
//      project with a saved connection whose password is a planted sentinel,
//      and a dataset whose cells are planted sentinels.
//   4. A PREVIEW NEVER HYDRATES A TABLE. `datasets.getDataset` is spied on and
//      must be called ZERO times — the same spy test-metricRewire.ts uses, for
//      the same reason: a fast path that silently stops firing would otherwise
//      pass green and inert.
//   5. AN AI FORMULA IS DATA, NOT CODE. The four injection shapes
//      scripts/test-formula.ts pins are re-run THROUGH THE PLAN VALIDATOR, so a
//      future "just check it looks like a formula" shortcut fails here.
//   6. THE BUILT RESULT MATCHES THE PREVIEW. The plan is built, then the SHIPPED
//      `visual:data` handler is invoked on the Visual that build created, and
//      its output must be byte-identical to what the preview showed.
//
// Plus one drift guard the module cannot state about itself: CHART_TYPE_IDS is
// compared against the REAL renderer list by vm-executing renderResult.js, the
// way scripts/test-plotSpec.ts does.
//
//   npm run build:ts && node scripts/test-analysisPlan.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, failureCount } from './selfcheck';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');
const vm: typeof import('vm') = require('vm');
const Module: any = require('module');

const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-analysisplan-'));

const ipcHandlers = new Map<string, (e: unknown, payload: unknown) => Promise<any>>();

const origLoad = Module._load;
Module._load = function (request: string, ...rest: any[]): any {
  if (request === 'electron') {
    return {
      app: { getPath: (_name: string) => tmpUserData },
      ipcMain: {
        handle: (ch: string, fn: (e: unknown, p: unknown) => Promise<any>) => { ipcHandlers.set(ch, fn); },
      },
      net: {},
      safeStorage: { isEncryptionAvailable: () => false },
    };
  }
  return origLoad.apply(this, [request, ...rest]);
};

// ponytail: compiled siblings of the real modules.
const plan: typeof import('../src/analysis/analysisPlan') = require('../src/analysis/analysisPlan');
const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
const projects: typeof import('../src/app/projects') = require('../src/app/projects');
const visuals: typeof import('../src/analysis/visuals') = require('../src/analysis/visuals');
const analysisStore: typeof import('../src/analysis/analysis') = require('../src/analysis/analysis');
const config: typeof import('../src/app/config') = require('../src/app/config');
const configSecrets: typeof import('../src/app/configSecrets') = require('../src/app/configSecrets');
const connections: typeof import('../src/connectors/connections') = require('../src/connectors/connections');
const ipcVisuals: typeof import('../src/ipc/visuals') = require('../src/ipc/visuals');
const analysesIpc: typeof import('../src/ipc/analyses') = require('../src/ipc/analyses');

type ParsedColumn = import('../src/data/parse').ParsedColumn;
type Cell = import('../src/data/transforms').Cell;


// ── The hydration spy ───────────────────────────────────────────────────────
// analysisPlan.js and ipc/visuals.js both resolve `datasets.getDataset` off the
// module namespace at CALL time, so replacing the export here is observed by the
// shipped code. Counting the calls is how "the preview did not hydrate" is
// PROVEN rather than hoped.
const realGetDataset = datasets.getDataset;
let hydrations = 0;
(datasets as any).getDataset = async (...args: any[]): Promise<any> => {
  hydrations += 1;
  return (realGetDataset as any)(...args);
};
function resetSpy(): void { hydrations = 0; }

// ── Sentinels ───────────────────────────────────────────────────────────────
// Planted so "no rows" and "no secrets" are checked against a value that could
// only have come from the place it was planted.
const SECRET = 'SECRET-connection-pw-abc123XYZ';
const CELL_SENTINEL = 'ROWVALUE-do-not-leak-9f3a';

// ── Fixtures ────────────────────────────────────────────────────────────────

const SALES_COLS: ParsedColumn[] = [
  { name: 'region', type: 'text' },
  { name: 'revenue', type: 'number' },
  { name: 'cost', type: 'number' },
  { name: 'code', type: 'text' }, // leading-zero id — must stay text
];
const SALES_ROWS: Cell[][] = [
  ['West', 100, 60, '007'],
  ['West', 250, 90, '008'],
  ['East', 175, 100, '009'],
  ['East', 25, 5, '010'],
  ['North', 400, 310, '011'],
  [CELL_SENTINEL, 12, 7, '012'],
];

let projectId = '';
let salesId = '';
let bigId = '';
let savedVisualId = '';

async function setup(): Promise<void> {
  const p = await projects.createProject('Plan project');
  if (!p) throw new Error('createProject failed');
  projectId = p.id;

  const ds = await datasets.saveDataset(projectId, {
    name: 'Sales', sourceKind: 'csv', columns: SALES_COLS, rows: SALES_ROWS,
  });
  if (!ds) throw new Error('saveDataset failed');
  salesId = ds.id;

  // A dataset whose RECORD claims far more rows than PREVIEW_MAX_HYDRATE_ROWS.
  // Used only to prove the preview refuses to hydrate rather than paying for it.
  const big = await datasets.saveDataset(projectId, {
    name: 'Huge', sourceKind: 'csv', columns: SALES_COLS, rows: SALES_ROWS,
  });
  if (!big) throw new Error('saveDataset(big) failed');
  bigId = big.id;

  const v = await visuals.saveVisual(projectId, {
    name: 'Revenue by region',
    datasetId: salesId,
    chartType: 'bar',
    encoding: { category: 'region', values: [{ column: 'revenue', aggregation: 'sum' }] },
  });
  if (!v) throw new Error('saveVisual failed');
  savedVisualId = v.id;

  // A connection carrying a SECRET, so the facts assertion has something real to
  // fail against. The secret goes where the app actually puts one.
  const c = await connections.saveConnection(projectId, {
    name: 'Warehouse', connectorId: 'postgres',
    values: { host: 'db.example.com', port: 5432, database: 'sales', user: 'reader' },
  } as any);
  if (c) configSecrets.setConnectionSecret(c.id, { password: SECRET });
}

// ── §1 CHART_TYPE_IDS is the REAL list ──────────────────────────────────────
function checkChartVocabulary(): void {
  const code = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'hub', 'renderResult.js'), 'utf8');
  const sandbox: Record<string, any> = { console };
  sandbox.globalThis = sandbox;
  sandbox.window = sandbox;
  sandbox.document = undefined;
  sandbox.localStorage = undefined;
  vm.createContext(sandbox);
  const got = vm.runInContext(code + '\n;({ALL_CHART_TYPE_IDS, VIZ_LABELS});', sandbox);
  const real: string[] = got.ALL_CHART_TYPE_IDS.concat(['table', 'map_bubble', 'map_choropleth']);
  ok('the chart vocabulary under test is the real one', real.length === 28, `${real.length} types`);
  ok('CHART_TYPE_IDS has exactly the renderer\'s types', plan.CHART_TYPE_IDS.size === real.length,
     `${plan.CHART_TYPE_IDS.size} vs ${real.length}`);
  const missing = real.filter((t) => !plan.CHART_TYPE_IDS.has(t));
  ok('no renderer chart type is missing from CHART_TYPE_IDS', missing.length === 0, missing.join(','));
  const extra = Array.from(plan.CHART_TYPE_IDS).filter((t) => !real.includes(t));
  ok('CHART_TYPE_IDS invents nothing the renderer cannot draw', extra.length === 0, extra.join(','));
  // Every label the picker shows exists for every accepted type — a type the
  // validator accepts but the picker cannot name would render an id as a chip.
  const unlabelled = Array.from(plan.CHART_TYPE_IDS).filter((t) => !got.VIZ_LABELS[t]);
  ok('every accepted chart type has a picker label', unlabelled.length === 0, unlabelled.join(','));
}

// ── §2 AI is optional ───────────────────────────────────────────────────────
async function checkNotReady(): Promise<void> {
  ok('no model is configured in this fixture', config.executionReady() === false);

  const draft = await analysesIpc.draftAnalysisPlan(projectId);
  ok('analysis:draft returns notReady with no model', draft.ok === false && draft.notReady === true,
     JSON.stringify(draft).slice(0, 120));
  ok('analysis:draft leaks no error text that pretends it worked', !('sheets' in draft));

  // The other two channels are NOT AI and must work regardless.
  const previewed = await plan.previewPlan(projectId, {
    name: 'Hand-written',
    sheets: [{ name: 'S', visuals: [{ dataset: 'Sales', name: 'R', chartType: 'bar',
      encoding: { category: 'region', values: [{ column: 'revenue', aggregation: 'sum' }] } }] }],
  });
  ok('previewPlan works with no model configured', previewed.ok === true && previewed.sheets[0].visuals.length === 1);
  ok('previewPlan drew the chart from real data',
     Array.isArray(previewed.sheets[0].visuals[0].data?.labels) && previewed.sheets[0].visuals[0].data!.labels.length === 4);

  const built = await plan.buildPlan(projectId, previewed.plan);
  ok('buildPlan works with no model configured', built.ok === true);
  if (built.ok) {
    ok('buildPlan created the analysis', typeof built.analysis.id === 'string' && built.analysis.sheets.length === 1);
    ok('buildPlan created one Visual', built.visualIds.length === 1);
    await analysisStore.deleteAnalysis(projectId, built.analysis.id);
    await visuals.deleteVisual(projectId, built.visualIds[0]);
  }
}

// ── §3 THE ACCEPTANCE TEST — exactly three drops, each reported ─────────────
async function checkThreeDrops(): Promise<void> {
  const envelope = {
    name: 'Q3 review',
    rationale: 'A look at revenue by region.',
    calculatedFields: [
      // (a) VALID — survives, and proves the three drops are not "everything failed".
      { dataset: 'Sales', name: 'Margin', formula: '(revenue - cost) / revenue' },
      // (b) DROP 2: does not compile.
      { dataset: 'Sales', name: 'Broken', formula: '1; process.exit(1)' },
    ],
    sheets: [{
      name: 'Overview',
      visuals: [
        // VALID.
        { dataset: 'Sales', name: 'Revenue by region', chartType: 'bar',
          encoding: { category: 'region', values: [{ column: 'revenue', aggregation: 'sum' }] } },
        // DROP 1: invented chart type.
        { dataset: 'Sales', name: 'Sales by moon phase', chartType: 'sunburst',
          encoding: { category: 'region', values: [{ column: 'revenue', aggregation: 'sum' }] } },
        // DROP 3: sum over a TEXT column.
        { dataset: 'Sales', name: 'Total region', chartType: 'column',
          encoding: { category: 'code', values: [{ column: 'region', aggregation: 'sum' }] } },
      ],
    }],
  };

  const preview = await plan.previewPlan(projectId, envelope);
  ok('acceptance: exactly three drops', preview.dropped.length === 3,
     preview.dropped.map((d) => d.kind).join(','));

  const byKind = new Map(preview.dropped.map((d) => [d.kind, d.message]));
  ok('acceptance: the invalid chart type is one of them', byKind.has('chartType'));
  ok('acceptance: the uncompilable formula is one of them', byKind.has('formula'));
  ok('acceptance: the bad encoding is one of them', byKind.has('encoding'));

  // Each is REPORTED — self-contained, names what and why, and is not a stack trace.
  const ct = byKind.get('chartType') || '';
  ok('chartType drop names the offending type and the card',
     ct.includes('"sunburst"') && ct.includes('Sales by moon phase') && ct.includes('28 chart types'), ct);
  const fm = byKind.get('formula') || '';
  ok('formula drop names the field and the parser\'s reason',
     fm.includes('"Broken"') && fm.includes('did not compile'), fm);
  const en = byKind.get('encoding') || '';
  ok('encoding drop names the aggregation, the column and its real type',
     en.includes('sum of "region"') && en.includes('needs a number column') && en.includes('is text'), en);

  // And what SURVIVED is exactly what should have.
  ok('acceptance: the one good visual survived', preview.sheets[0].visuals.length === 1);
  ok('acceptance: the surviving visual is the right one', preview.sheets[0].visuals[0].name === 'Revenue by region');
  ok('acceptance: the one good calculated field survived', preview.calculatedFields.length === 1);
  ok('acceptance: the surviving field is the right one', preview.calculatedFields[0].name === 'Margin');
  ok('acceptance: the uncompilable formula is NOT in the plan',
     !JSON.stringify(preview.plan).includes('process.exit'));
  ok('acceptance: the invented chart type is NOT in the plan',
     !JSON.stringify(preview.plan).includes('sunburst'));
  ok('acceptance: the good formula was compiled, not just copied',
     preview.calculatedFields[0].refs.slice().sort().join(',') === 'cost,revenue',
     preview.calculatedFields[0].refs.join(','));
  ok('acceptance: no unknown refs in the good formula', preview.calculatedFields[0].unknownRefs.length === 0);
  ok('acceptance: the sample is app-evaluated rows, never a model figure',
     Array.isArray(preview.calculatedFields[0].sample));
  if (preview.calculatedFields[0].sample.length > 0) {
    const first = preview.calculatedFields[0].sample[0];
    const expect = (100 - 60) / 100;
    ok('acceptance: the sample value is the app\'s own arithmetic',
       typeof first.value === 'number' && Math.abs((first.value as number) - expect) < 1e-12,
       String(first.value));
  }

  // BUILD it and prove the drops did not come back.
  const built = await plan.buildPlan(projectId, envelope);
  ok('build: succeeded', built.ok === true);
  if (!built.ok) return;
  ok('build: reported the same three drops', built.dropped.length === 3);
  ok('build: created exactly one Visual', built.visualIds.length === 1);
  const madeVisual = await visuals.getVisual(projectId, built.visualIds[0]);
  ok('build: the Visual carries the validated chart type', madeVisual?.chartType === 'bar');
  ok('build: no Visual was created for the invented chart type',
     (await visuals.listVisuals(projectId)).every((v) => v.chartType !== 'sunburst'));

  // The calculated field is an ORDINARY TransformStep — removable, reorderable.
  const meta = await datasets.getDatasetMeta(projectId, salesId);
  const steps = meta?.steps || [];
  ok('build: the calculated field is an ordinary calculated_field step',
     steps.length === 1 && steps[0].type === 'calculated_field' && (steps[0] as any).name === 'Margin',
     JSON.stringify(steps));
  ok('build: the uncompilable formula was never written', !JSON.stringify(steps).includes('process.exit'));
  ok('build: the new column exists on the dataset', !!meta?.columns.some((c) => c.name === 'Margin'));

  // Undo the fixture mutation so later sections see a pristine dataset.
  await datasets.updateSteps(projectId, salesId, []);
  await analysisStore.deleteAnalysis(projectId, built.analysis.id);
  for (const id of built.visualIds) await visuals.deleteVisual(projectId, id);
}

// ── §4 The FACTS block: no rows, no secrets ────────────────────────────────
async function checkFacts(): Promise<void> {
  const ctx = await plan.loadPlanContext(projectId);
  const facts = plan.buildFactsText(ctx);

  ok('facts: names every dataset', facts.includes('"Sales"') && facts.includes('"Huge"'));
  ok('facts: names every column with its declared type',
     facts.includes('region (text)') && facts.includes('revenue (number)'));
  ok('facts: carries the row count', facts.includes(`${SALES_ROWS.length} rows`));
  ok('facts: lists the saved visuals by name', facts.includes('"Revenue by region"'));
  ok('facts: lists the closed chart vocabulary', facts.includes('map_choropleth') && facts.includes('candlestick'));

  // NO ROWS. A cell value planted in the table must not appear anywhere.
  ok('facts: contains NO row value', !facts.includes(CELL_SENTINEL));
  ok('facts: contains no leading-zero id from the table', !facts.includes('007'));
  // Not even the most-common VALUE, which ColumnSummary carries and this omits
  // on purpose — a most-common value is a cell wearing a statistic's clothes.
  ok('facts: contains no category value at all',
     !facts.includes('West') && !facts.includes('East') && !facts.includes('North'));

  // NO SECRETS.
  const stored = JSON.stringify(config.get().connectionSecrets || {});
  ok('the secret really is stored (so its absence below means something)',
     stored.includes(SECRET), stored.slice(0, 60));
  ok('facts: contains NO connection secret', !facts.includes(SECRET));
  ok('facts: contains no connection at all', !facts.toLowerCase().includes('warehouse'));
  ok('facts: contains no api key field name', !/apiKey|password|bearer/i.test(facts));

  // The whole plan context is what a renderer could ever see; it must be clean too.
  const ctxJson = JSON.stringify(ctx);
  ok('the plan context carries no secret', !ctxJson.includes(SECRET));
  ok('the plan context carries no rows', !ctxJson.includes(CELL_SENTINEL));
}

// ── §4b Scoping the context to one dataset, and the user's intent ──────────
// The create wizard picks a dataset and takes free text. Both narrow what the
// model sees; neither may widen what it can produce.
async function checkScopeAndIntent(): Promise<void> {
  const all = await plan.loadPlanContext(projectId);
  ok('scope: unscoped context still sees every dataset', all.datasets.length >= 2,
     String(all.datasets.length));

  const one = await plan.loadPlanContext(projectId, salesId);
  ok('scope: a datasetId narrows the context to that dataset',
     one.datasets.length === 1 && one.datasets[0].id === salesId,
     JSON.stringify(one.datasets.map((d) => d.name)));
  const scopedFacts = plan.buildFactsText(one);
  ok('scope: the FACTS block names the chosen dataset', scopedFacts.includes('"Sales"'));
  ok('scope: and does NOT name the others', !scopedFacts.includes('"Huge"'));
  // Visuals ride with their dataset — offering one built on an excluded dataset
  // would get it dropped at validation, which reads as a bug rather than a scope.
  ok('scope: saved visuals are filtered to the chosen dataset too',
     one.visuals.every((v: any) => v.datasetId === salesId),
     JSON.stringify(one.visuals.map((v: any) => v.name)));
  // An unknown id must not silently fall back to "everything".
  const nothing = await plan.loadPlanContext(projectId, '00000000-0000-4000-8000-000000000000');
  ok('scope: an unmatched datasetId yields an EMPTY context, not the full one',
     nothing.datasets.length === 0, String(nothing.datasets.length));

  // The intent is the one untrusted string in the prompt.
  const plain = plan.buildFactsText(all);
  const withIntent = plan.buildFactsText(all, 'Revenue by region, flag concentration risk.');
  ok('intent: absent by default', plain === plan.buildFactsText(all, ''));
  ok('intent: appears when given', withIntent.includes('Revenue by region, flag concentration risk.'));
  ok('intent: is fenced and labelled a REQUEST, not a fact',
     withIntent.includes('<<<USER REQUEST') && /REQUEST/.test(withIntent));
  ok('intent: is placed AFTER the closed chart vocabulary',
     withIntent.indexOf('<<<USER REQUEST') > withIntent.indexOf('Chart types you may use'));
  ok('intent: adding one does not disturb the facts above it',
     withIntent.startsWith(plain), 'facts block is a prefix of the intent version');

  // Length cap: an intent cannot bury the FACTS it is supposed to live inside.
  const huge = 'x'.repeat(9000);
  const capped = plan.buildFactsText(all, huge);
  ok('intent: is length-capped', !capped.includes('x'.repeat(2001)),
     `${capped.length - plain.length} chars added for a 9,000-char intent`);

  // The point of the whole design: intent does NOT widen the vocabulary. A plan
  // that asks for an off-list chart type is still dropped, exactly as if the
  // model had invented it unprompted.
  const injected = await plan.previewPlan(projectId, {
    name: 'Injected',
    sheets: [{ name: 'S', visuals: [
      { dataset: 'Sales', name: 'Bad', chartType: 'spiral',
        encoding: { category: 'region', values: [{ column: 'revenue', aggregation: 'sum' }] } },
    ] }],
  }, one);
  ok('intent: an off-list chart type is still dropped and reported',
     injected.dropped.some((d: any) => d.kind === 'chartType'),
     JSON.stringify(injected.dropped.map((d: any) => d.kind)));
  // And a dataset outside the scope cannot be planned against.
  const outside = await plan.previewPlan(projectId, {
    name: 'Outside',
    sheets: [{ name: 'S', visuals: [
      { dataset: 'Huge', name: 'Nope', chartType: 'bar',
        encoding: { category: 'region', values: [{ column: 'revenue', aggregation: 'sum' }] } },
    ] }],
  }, one);
  ok('scope: a dataset outside the scope is dropped, not silently planned',
     outside.dropped.some((d: any) => d.kind === 'dataset'),
     JSON.stringify(outside.dropped.map((d: any) => d.kind)));
}

// ── §5 A preview never hydrates a table ────────────────────────────────────
async function checkNoHydration(): Promise<void> {
  const meta = await datasets.getDatasetMeta(projectId, salesId);
  ok('the fixture dataset is resident (Parquet-backed)', meta?.resident === true);

  resetSpy();
  const preview = await plan.previewPlan(projectId, {
    name: 'No hydrate',
    sheets: [{
      name: 'S',
      visuals: [
        { dataset: 'Sales', name: 'A', chartType: 'bar',
          encoding: { category: 'region', values: [{ column: 'revenue', aggregation: 'sum' }] } },
        { dataset: 'Sales', name: 'B', chartType: 'column',
          encoding: { category: 'region', values: [{ column: 'cost', aggregation: 'avg' }] } },
        { visual: 'Revenue by region' },
      ],
    }],
    calculatedFields: [{ dataset: 'Sales', name: 'Margin2', formula: 'revenue - cost' }],
  });
  ok('preview: NOT hydrated (0 getDataset calls)', hydrations === 0, `${hydrations} hydration(s)`);
  ok('preview: still produced data for every chart',
     preview.sheets[0].visuals.every((v) => v.data !== null && v.data.labels.length > 0));
  ok('preview: the referenced saved visual previewed through its stored definition',
     preview.sheets[0].visuals[2].kind === 'existing'
     && preview.sheets[0].visuals[2].visualId === savedVisualId
     && preview.sheets[0].visuals[2].encoding.category === 'region');
  ok('preview: the calculated-field sample cost no hydrate either', hydrations === 0);

  // A dataset too big for the JS fallback is REFUSED, not paid for. Simulated by
  // rewriting the record's rowCount — the ceiling is read from metadata, and a
  // real 1M-row fixture would cost minutes here for the same assertion.
  const file = path.join(tmpUserData, 'projects', projectId, 'datasets', bigId + '.json');
  const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
  rec.rowCount = 5_000_000;
  fs.writeFileSync(file, JSON.stringify(rec, null, 2), 'utf8');

  resetSpy();
  const tooBig = await plan.previewPlan(projectId, {
    name: 'Too big',
    // 'none' (raw, unaggregated) has no resident equivalent, so this is the one
    // shape that WOULD reach the JS fallback — which is exactly what is capped.
    sheets: [{ name: 'S', visuals: [{ dataset: 'Huge', name: 'Raw', chartType: 'scatter',
      encoding: { category: 'region', values: [{ column: 'revenue', aggregation: 'none' }] } }] }],
  });
  ok('preview: an oversized non-resident chart is NOT hydrated', hydrations === 0, `${hydrations} hydration(s)`);
  ok('preview: it is reported rather than silently blank',
     tooBig.sheets[0].visuals[0].data === null && !!tooBig.sheets[0].visuals[0].note,
     tooBig.sheets[0].visuals[0].note);
}

// ── §6 An AI formula is DATA, not code ─────────────────────────────────────
async function checkInjection(): Promise<void> {
  // The four anti-injection cases pinned by scripts/test-formula.ts, re-run
  // through the PLAN, so the real parser stays the gate.
  const INJECTIONS = [
    '1; process.exit(1)',
    'process.exit(1)',
    '`${1}`',
    '1 2 3',
    // and two more shapes a model could plausibly emit
    "require('fs').unlinkSync('/tmp/x')",
    'frobnicate(1)',
  ];
  const ctx = await plan.loadPlanContext(projectId);
  for (const expr of INJECTIONS) {
    const { plan: p, dropped } = plan.validatePlan(
      { name: 'X', calculatedFields: [{ dataset: 'Sales', name: 'Evil', formula: expr }], sheets: [] },
      ctx,
    );
    ok('injection rejected by the real parser: ' + expr,
       p.calculatedFields.length === 0 && dropped.length === 1 && dropped[0].kind === 'formula',
       dropped[0]?.message);
  }

  // A formula that WOULD overwrite an existing column is refused too — that is
  // data loss, not a style point (transforms.stepCalculatedField refuses it as
  // well; catching it here means the user is told instead of warned after).
  const clash = plan.validatePlan(
    { name: 'X', calculatedFields: [{ dataset: 'Sales', name: 'revenue', formula: '1 + 1' }], sheets: [] },
    ctx,
  );
  ok('a calculated field may not overwrite an existing column',
     clash.plan.calculatedFields.length === 0 && clash.dropped.length === 1,
     clash.dropped[0]?.message);

  // No eval / new Function anywhere in the plan module (static guarantee, the
  // same one test-formula.ts makes about the evaluator).
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'analysis', 'analysisPlan.ts'), 'utf8')
    .replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  ok('analysisPlan source contains no eval(', !/\beval\s*\(/.test(src));
  ok('analysisPlan source contains no new Function', !/new\s+Function\s*\(/.test(src));
}

// ── §7 The built result matches the preview ────────────────────────────────
async function checkPreviewMatchesBuild(): Promise<void> {
  const envelope = {
    name: 'Match',
    rationale: 'Two views of the same table.',
    sheets: [{
      name: 'Overview',
      visuals: [
        { dataset: 'Sales', name: 'Revenue by region', chartType: 'bar',
          encoding: { category: 'region', values: [{ column: 'revenue', aggregation: 'sum' }] },
          filters: [{ type: 'filter', column: 'revenue', op: '>', value: 20 }] },
        { dataset: 'Sales', name: 'Avg cost by region', chartType: 'column',
          encoding: { category: 'region', values: [{ column: 'cost', aggregation: 'avg' }] } },
        { visual: 'Revenue by region' },
      ],
    }],
  };

  const preview = await plan.previewPlan(projectId, envelope);
  ok('match: three cards previewed', preview.sheets[0].visuals.length === 3);
  ok('match: every previewed card carries data', preview.sheets[0].visuals.every((v) => v.data !== null));

  const built = await plan.buildPlan(projectId, preview.plan);
  ok('match: build succeeded', built.ok === true);
  if (!built.ok) return;
  ok('match: the reference reused the saved visual rather than copying it',
     built.visualIds[2] === savedVisualId);

  // The comparison that matters. Ask the SHIPPED `visual:data` handler — the one
  // the renderer calls to draw a dashboard card — for each built Visual, and
  // compare against what the preview showed.
  const visualData = ipcHandlers.get('visual:data');
  ok('match: the visual:data handler is registered', typeof visualData === 'function');
  if (!visualData) return;

  for (let i = 0; i < built.visualIds.length; i += 1) {
    const v = await visuals.getVisual(projectId, built.visualIds[i]);
    if (!v) { ok(`match: built visual ${i} loads`, false); continue; }
    const live = await visualData(null, {
      projectId, datasetId: v.datasetId, encoding: v.encoding, filters: v.filters,
    });
    const previewed = preview.sheets[0].visuals[i];
    ok(`match: built visual ${i} ("${v.name}") renders what the preview showed`,
       live.ok === true && JSON.stringify(live.data) === JSON.stringify(previewed.data),
       JSON.stringify(live.data) === JSON.stringify(previewed.data) ? '' :
         `preview=${JSON.stringify(previewed.data)} built=${JSON.stringify(live.data)}`);
    ok(`match: built visual ${i} kept the previewed chart type`, v.chartType === previewed.chartType);
    ok(`match: built visual ${i} kept the previewed encoding`,
       JSON.stringify(v.encoding) === JSON.stringify(previewed.encoding));
    ok(`match: built visual ${i} kept the previewed filters`,
       JSON.stringify(v.filters) === JSON.stringify(previewed.filters));
  }

  // The filter is not decorative: it really removed a row, in both.
  const filtered = preview.sheets[0].visuals[0].data!;
  ok('match: the visual-level filter was applied before aggregation',
     filtered.labels.length === 3 && !filtered.labels.includes(CELL_SENTINEL),
     JSON.stringify(filtered.labels));

  // Sheets → an Analysis, cards on the 12-column grid the app assigned.
  ok('match: one sheet with three cards', built.analysis.sheets.length === 1 && built.analysis.sheets[0].cards.length === 3);
  const layouts = built.analysis.sheets[0].cards.map((c: any) => `${c.layout.x},${c.layout.y},${c.layout.w},${c.layout.h}`);
  ok('match: the APP assigned the grid geometry, wrapping at 12 columns',
     layouts.join(' | ') === '0,0,6,6 | 6,0,6,6 | 0,6,6,6', layouts.join(' | '));
  ok('match: every card is a visual card referencing a real Visual',
     built.analysis.sheets[0].cards.every((c: any) => c.type === 'visual' && built.visualIds.includes(c.visualId)));

  for (const id of built.visualIds) if (id !== savedVisualId) await visuals.deleteVisual(projectId, id);
  await analysisStore.deleteAnalysis(projectId, built.analysis.id);
}

// ── §8 A card that depends on a proposed calculated field ──────────────────
// The one case where a preview legitimately cannot draw. It must show NOTHING
// (not an estimate, not a partial chart) and say why — a figure the built
// analysis could contradict is never drawn in the first place.
async function checkPendingCalcField(): Promise<void> {
  const envelope = {
    name: 'Margin view',
    // round(): a bare `(revenue - cost) / revenue` yields values like
    // 0.42857142857142855 — 17 significant digits, which parse.isFiniteNumber
    // deliberately refuses (a >15-digit literal cannot round-trip a JS double),
    // so the new column would be typed TEXT and could never be averaged. That is
    // pre-existing, correct app behaviour; the draft prompt tells the model to
    // round every division for exactly this reason, and §11 below pins it.
    calculatedFields: [{ dataset: 'Sales', name: 'Margin', formula: 'round((revenue - cost) / revenue, 4)' }],
    sheets: [{ name: 'S', visuals: [{ dataset: 'Sales', name: 'Margin by region', chartType: 'bar',
      encoding: { category: 'region', values: [{ column: 'Margin', aggregation: 'avg' }] } }] }],
  };

  const preview = await plan.previewPlan(projectId, envelope);
  ok('pending: the card was KEPT, not dropped', preview.sheets[0].visuals.length === 1 && preview.dropped.length === 0);
  const card = preview.sheets[0].visuals[0];
  ok('pending: no data is shown for it', card.data === null);
  ok('pending: it says why, naming the field', (card.note || '').includes('Margin'), card.note);
  ok('pending: the note contains no figure', !/\d/.test((card.note || '').replace(/[^0-9]/g, '') || 'x'));

  const built = await plan.buildPlan(projectId, preview.plan);
  ok('pending: build succeeded', built.ok === true);
  if (!built.ok) return;
  ok('pending: the calculated field was applied', built.calculatedFields.length === 1);

  // Now the column exists, so a re-preview of the SAME plan draws the chart.
  const again = await plan.previewPlan(projectId, envelope);
  const card2 = again.sheets[0].visuals[0];
  ok('pending: the field is no longer proposable a second time (column exists)',
     again.dropped.length === 1 && again.dropped[0].kind === 'formula');
  ok('pending: with the column present the chart now draws', card2.data !== null && card2.data!.labels.length === 4);

  const v = await visuals.getVisual(projectId, built.visualIds[0]);
  const visualData = ipcHandlers.get('visual:data')!;
  const live = await visualData(null, { projectId, datasetId: v!.datasetId, encoding: v!.encoding, filters: v!.filters });
  ok('pending: the built visual renders exactly the re-preview',
     live.ok === true && JSON.stringify(live.data) === JSON.stringify(card2.data));

  await datasets.updateSteps(projectId, salesId, []);
  for (const id of built.visualIds) await visuals.deleteVisual(projectId, id);
  await analysisStore.deleteAnalysis(projectId, built.analysis.id);
}

// ── §11 A rounded ratio is a number column; an unrounded one is not ────────
// Pinned because it is surprising, it is what the draft prompt instructs around,
// and if parse.isFiniteNumber's >15-digit rule ever changed this suite should
// say so rather than a user discovering it through a chart that will not draw.
async function checkRoundedRatioTyping(): Promise<void> {
  const build = async (name: string, formula: string): Promise<string | undefined> => {
    const res = await plan.buildPlan(projectId, {
      name: 'T', calculatedFields: [{ dataset: 'Sales', name, formula }], sheets: [],
    });
    const meta = await datasets.getDatasetMeta(projectId, salesId);
    if (res.ok) await analysisStore.deleteAnalysis(projectId, res.analysis.id);
    return meta?.columns.find((c) => c.name === name)?.type;
  };

  ok('an UNROUNDED ratio types as text (>15 significant digits)',
     (await build('RawRatio', '(revenue - cost) / revenue')) === 'text');
  await datasets.updateSteps(projectId, salesId, []);
  ok('a ROUNDED ratio types as number', (await build('Ratio', 'round((revenue - cost) / revenue, 4)')) === 'number');
  await datasets.updateSteps(projectId, salesId, []);
  ok('the draft prompt tells the model to round every division',
     fs.readFileSync(path.join(__dirname, '..', 'src', 'ai', 'analyze.ts'), 'utf8').includes('ALWAYS wrap a '));
}

// ── §9 Garbage in ──────────────────────────────────────────────────────────
async function checkGarbage(): Promise<void> {
  const ctx = await plan.loadPlanContext(projectId);
  const cases: [string, unknown][] = [
    ['null envelope', null],
    ['an array', [1, 2, 3]],
    ['a string', 'not a plan'],
    ['sheets is a number', { name: 'X', sheets: 7 }],
    ['visuals is a string', { name: 'X', sheets: [{ name: 'S', visuals: 'nope' }] }],
  ];
  for (const [label, raw] of cases) {
    let threw = false;
    let out: any = null;
    try { out = plan.validatePlan(raw, ctx); } catch { threw = true; }
    ok('validatePlan never throws on ' + label, !threw);
    ok('validatePlan always yields at least one sheet on ' + label, !threw && out.plan.sheets.length >= 1);
  }

  const unknownDs = plan.validatePlan(
    { name: 'X', sheets: [{ name: 'S', visuals: [{ dataset: 'Nope', chartType: 'bar',
      encoding: { category: 'a', values: [{ column: 'b', aggregation: 'sum' }] } }] }] },
    ctx,
  );
  ok('an unknown dataset is dropped and reported',
     unknownDs.plan.sheets[0].visuals.length === 0 && unknownDs.dropped[0].kind === 'dataset',
     unknownDs.dropped[0]?.message);

  const unknownCol = plan.validatePlan(
    { name: 'X', sheets: [{ name: 'S', visuals: [{ dataset: 'Sales', chartType: 'bar',
      encoding: { category: 'nosuch', values: [{ column: 'revenue', aggregation: 'sum' }] } }] }] },
    ctx,
  );
  ok('an unknown category column is dropped and reported',
     unknownCol.plan.sheets[0].visuals.length === 0 && unknownCol.dropped[0].kind === 'encoding',
     unknownCol.dropped[0]?.message);

  // `count` is the one aggregation that is legal over a text column.
  const counted = plan.validatePlan(
    { name: 'X', sheets: [{ name: 'S', visuals: [{ dataset: 'Sales', chartType: 'bar',
      encoding: { category: 'region', values: [{ column: 'code', aggregation: 'count' }] } }] }] },
    ctx,
  );
  ok('count over a text column is allowed', counted.plan.sheets[0].visuals.length === 1 && counted.dropped.length === 0);

  // A filter on a missing column loses the FILTER, not the chart.
  const badFilter = plan.validatePlan(
    { name: 'X', sheets: [{ name: 'S', visuals: [{ dataset: 'Sales', chartType: 'bar',
      encoding: { category: 'region', values: [{ column: 'revenue', aggregation: 'sum' }] },
      filters: [{ type: 'filter', column: 'ghost', op: '=', value: 1 }] }] }] },
    ctx,
  );
  ok('a filter on a missing column is dropped, the chart is kept',
     badFilter.plan.sheets[0].visuals.length === 1
     && badFilter.plan.sheets[0].visuals[0].filters.length === 0
     && badFilter.dropped.length === 1 && badFilter.dropped[0].kind === 'filter',
     badFilter.dropped[0]?.message);

  // A reference to a saved visual that does not exist.
  const ghostRef = plan.validatePlan(
    { name: 'X', sheets: [{ name: 'S', visuals: [{ visual: 'No such visual' }] }] }, ctx,
  );
  ok('a reference to a missing saved visual is dropped and reported',
     ghostRef.plan.sheets[0].visuals.length === 0 && ghostRef.dropped[0].kind === 'visual',
     ghostRef.dropped[0]?.message);

  // Determinism: the SAME envelope validated twice gives byte-identical output.
  // This is the property the preview/build guarantee actually rests on.
  const env = { name: 'D', calculatedFields: [{ dataset: 'Sales', name: 'M', formula: 'revenue - cost' }],
    sheets: [{ name: 'S', visuals: [{ dataset: 'Sales', chartType: 'bar',
      encoding: { category: 'region', values: [{ column: 'revenue', aggregation: 'sum' }] } }] }] };
  const a = JSON.stringify(plan.validatePlan(env, ctx));
  const b = JSON.stringify(plan.validatePlan(env, ctx));
  ok('validatePlan is deterministic (same input, byte-identical output)', a === b);
}

// ── §10 The IPC surface ────────────────────────────────────────────────────
async function checkChannels(): Promise<void> {
  analysesIpc.register();
  ipcVisuals.register();
  for (const ch of ['analysis:draft', 'analysis:previewPlan', 'analysis:buildPlan']) {
    ok('channel registered: ' + ch, ipcHandlers.has(ch));
  }
  ok('dashboard:draft is NOT resurrected', !ipcHandlers.has('dashboard:draft'));

  // Every channel returns a shaped reply rather than throwing, even on garbage.
  const preview = await ipcHandlers.get('analysis:previewPlan')!(null, { projectId, plan: null });
  ok('analysis:previewPlan survives a null plan', preview.ok === true && preview.sheets.length === 1);
  const build = await ipcHandlers.get('analysis:buildPlan')!(null, { projectId, plan: null });
  ok('analysis:buildPlan survives a null plan', build.ok === true || typeof build.error === 'string');
  if (build.ok) {
    await analysisStore.deleteAnalysis(projectId, build.analysis.id);
  }
  const badProject = await ipcHandlers.get('analysis:buildPlan')!(null, { projectId: '../etc', plan: {} });
  ok('analysis:buildPlan refuses a non-UUID project id', badProject.ok === false, JSON.stringify(badProject));
}

// ── Run ────────────────────────────────────────────────────────────────────
(async () => {
  // register() FIRST so ipcHandlers is populated before any section needs it.
  ipcVisuals.register();
  await projects.init();
  await datasets.init();
  await visuals.init();
  await analysisStore.init();
  await setup();

  checkChartVocabulary();
  await checkNotReady();
  await checkThreeDrops();
  await checkFacts();
  await checkScopeAndIntent();
  await checkNoHydration();
  await checkInjection();
  await checkPreviewMatchesBuild();
  await checkPendingCalcField();
  await checkRoundedRatioTyping();
  await checkGarbage();
  await checkChannels();

  if (failureCount()) {
    console.error('\n' + failureCount() + ' analysis-plan check(s) FAILED');
    process.exit(1);
  }
  console.log('\nAll analysis-plan checks passed.');
})().catch((err) => {
  console.error('UNEXPECTED', err);
  process.exit(1);
});
