// Self-check for the automation HANDLERS over real data — src/automation/.
//
// On the REAL sample project (seeded through the first-launch path), every
// call goes through `registry.dispatch`, the one entry point the CLI and both
// MCP transports share. The house style holds:
//
//   • DIFFERENTIAL: `aggregate` equals `vizDataFor` on the same sanitized
//     encoding, `metric_value` equals `resolveMetric`, `insights` equals
//     `insightsForDataset` — Object.is on every figure.
//   • ROUND TRIP: a valid create_visual / create_dashboard input survives
//     `sanitizeEncoding` / `validatePlan` unchanged; an invalid one is refused
//     with the validator's own reason.
//   • RECORDS ONLY: the creators leave every dataset file byte-for-byte alone,
//     write a record, record a version and log an `automation` job.
//   • SECRETS: a dataset whose origin carries a token in its URL, and a file
//     path, never shows either in any output.
//   • publish / dashboards export run against a STUBBED contract module
//     (src/publish/publish.ts is filled in by another commit): the file I/O,
//     argument handling and error paths are what is tested here.
//
//   npm run build:ts && node scripts/test-automationTools.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-automation-tools-'));
// Outside server mode every app folder is ORDINATE_LOCAL_DIR (src/app/paths.ts), downloads included.
const downloads = tmp;
process.env.ORDINATE_LOCAL_DIR = tmp;

// ponytail: compiled siblings of the real modules.
const sample: typeof import('../src/app/sampleProject') = require('../src/app/sampleProject');
const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
const visuals: typeof import('../src/analysis/visuals') = require('../src/analysis/visuals');
const analysis: typeof import('../src/analysis/analysis') = require('../src/analysis/analysis');
const plan: typeof import('../src/analysis/analysisPlan') = require('../src/analysis/analysisPlan');
const versions: typeof import('../src/app/versions') = require('../src/app/versions');
const tableDocs: typeof import('../src/app/tableDocs') = require('../src/app/tableDocs');
const jobs: typeof import('../src/app/jobs') = require('../src/app/jobs');
const publishing: typeof import('../src/publish/publish') = require('../src/publish/publish');
const vis: typeof import('../src/ipc/visuals') = require('../src/ipc/visuals');
const mets: typeof import('../src/ipc/metrics') = require('../src/ipc/metrics');
const ins: typeof import('../src/ipc/insights') = require('../src/ipc/insights');
const reg: typeof import('../src/automation/registry') = require('../src/automation/registry');
const cli: typeof import('../src/automation/cli') = require('../src/automation/cli');

// The search index is written beside the Parquet on a 1.5 s timer after the
// seed — inside the creators' before/after window when the machine is slow,
// which adds `<id>.search.json` files no creator wrote. A cache, not a dataset file.
(require('../src/engine/dataSearchResident') as { scheduleIndex: () => void }).scheduleIndex = () => undefined;

type Transport = import('../src/automation/registry').Transport;

async function call(tool: string, args: Record<string, unknown>, transport: Transport = 'stdio'): Promise<any> {
  const cmd = reg.findTool(tool) || reg.findCli(tool);
  if (!cmd) throw new Error('no command ' + tool);
  return reg.dispatch(cmd, args, { transport, cwd: tmp, headless: true });
}

async function refusal(tool: string, args: Record<string, unknown>, transport: Transport = 'stdio'): Promise<{ code: string; message: string; stage?: string }> {
  try {
    await call(tool, args, transport);
    return { code: 'none', message: '' };
  } catch (e: any) {
    return { code: e.code || 'throw', message: String(e.message), stage: e.stage };
  }
}

/** Every file under the project's datasets dir, with its size and mtime. */
function datasetFiles(pid: string): string {
  const dir = path.join(tmp, 'projects', pid, 'datasets');
  return fs.readdirSync(dir).sort().map((n) => {
    const st = fs.statSync(path.join(dir, n));
    return `${n}:${st.size}:${st.mtimeMs}`;
  }).join('\n');
}

async function main(): Promise<void> {
  const seeded = await sample.seedSampleProject();
  const pid = seeded.projectId!;
  const ds = (await datasets.listDatasets(pid))[0];

  // ── Reads ──────────────────────────────────────────────────────────────────
  const projects = await call('list_projects', {});
  ok('list_projects: the sample project, marked default', projects.length === 1 && projects[0].id === pid && projects[0].default === true);
  const list = await call('list_datasets', {});
  ok('list_datasets: the sample dataset with its counts', list.length === 1 && list[0].name === ds.name && list[0].rows === ds.rowCount);
  ok('list_datasets: --project by name resolves the same', (await call('list_datasets', { project: 'My project' }))[0].id === ds.id);
  ok('an unknown project is not_found', (await refusal('list_datasets', { project: 'Nope' })).code === 'not_found');

  const d = await call('describe_dataset', { dataset: ds.name });
  const meta = (await datasets.getDatasetMeta(pid, ds.id))!;
  ok('describe_dataset: every column with its declared type',
    JSON.stringify(d.columns.map((c: any) => [c.name, c.type])) === JSON.stringify(meta.columns.map((c) => [c.name, c.type])));
  ok('describe_dataset: the SQL name', d.sqlName === 'retail_orders' && d.queryable === true);
  ok('describe_dataset: by id works, a missing one is not_found',
    (await call('describe_dataset', { dataset: ds.id })).id === ds.id && (await refusal('describe_dataset', { dataset: 'Nope' })).code === 'not_found');

  // The user's notes on the table ride in the same reply: empty strings and no key check until they are written.
  ok('describe_dataset: no table notes yet — empty fields, no keyCheck',
    JSON.stringify(d.table) === JSON.stringify({ role: '', key: '', grain: '', guide: '' }), JSON.stringify(d.table));
  await tableDocs.setTableDoc(pid, ds.id, { role: 'dimension', guide: 'g', key: meta.columns[0].name });
  const noted = await call('describe_dataset', { dataset: ds.name });
  ok('describe_dataset: the table notes after catalog:setTable — role and guide', noted.table.role === 'dimension' && noted.table.guide === 'g' && noted.table.key === meta.columns[0].name && noted.table.grain === '' && !('keyCheck' in noted.table), JSON.stringify(noted.table));
  await tableDocs.writeKeyCheck(pid, ds.id, meta.columns[0].name, { rows: 4, empty: 0, repeatedKeys: 1, checkedAt: '2026-11-04T00:00:00.000Z' });
  ok('describe_dataset: …and the key check once it was counted',
    JSON.stringify((await call('describe_dataset', { dataset: ds.id })).table.keyCheck) === JSON.stringify({ rows: 4, empty: 0, repeatedKeys: 1, checkedAt: '2026-11-04T00:00:00.000Z' }));
  ok('describe_dataset: the rest of the reply is what it was (columns, SQL name)', noted.columns.length === meta.columns.length && noted.sqlName === 'retail_orders');
  // Value labels: what a text column's stored codes mean, on that column; nothing on a column without them.
  const catalogStore: typeof import('../src/app/catalog') = require('../src/app/catalog');
  const textCol = meta.columns.find((c) => c.type === 'text')!.name;
  const L = [{ value: 'EU', label: 'Europe' }, { value: 'NA', label: 'North America' }];
  ok('describe_dataset: no labels, no valueLabels key on any column', !d.columns.some((c: any) => 'valueLabels' in c));
  await catalogStore.setColumn(pid, ds.id, textCol, { values: L });
  const labelled = await call('describe_dataset', { dataset: ds.id });
  ok('describe_dataset: a text column carries its value labels', JSON.stringify(labelled.columns.find((c: any) => c.name === textCol).valueLabels) === JSON.stringify(L), JSON.stringify(labelled.columns));
  ok('describe_dataset: …and only that column', labelled.columns.filter((c: any) => 'valueLabels' in c).length === 1);
  await catalogStore.setColumn(pid, ds.id, textCol, { sensitivity: 'personal' });
  ok('describe_dataset: a column marked personal carries no value labels (its codes are its values)', !(await call('describe_dataset', { dataset: ds.id })).columns.some((c: any) => 'valueLabels' in c));
  await catalogStore.setColumn(pid, ds.id, textCol, { sensitivity: 'none', values: [] });
  const numCol = meta.columns.find((c) => c.type === 'number')!.name;
  await catalogStore.setColumn(pid, ds.id, numCol, { values: [{ value: '5', label: 'Five' }] }); // the store knows no types: a list left on a retyped column
  ok('describe_dataset: a list left on a column that is not text is not said', !(await call('describe_dataset', { dataset: ds.id })).columns.some((c: any) => 'valueLabels' in c));
  await catalogStore.setColumn(pid, ds.id, numCol, { values: [] });

  // Secrets: an origin with a token in its URL, and one with a file path.
  const secretUrl = 'https://data.example/export.csv?token=SEKRET-TOKEN-123';
  const cols = [{ name: 'a', type: 'number' as const }];
  await datasets.saveDataset(pid, { name: 'Remote', sourceKind: 'url', columns: cols, rows: [[1]], origin: { kind: 'url', url: secretUrl } });
  await datasets.saveDataset(pid, { name: 'Local', sourceKind: 'csv', columns: cols, rows: [[2]], origin: { kind: 'file', path: '/Users/someone/private/ledger.csv' } });
  const dump = JSON.stringify([await call('list_datasets', {}), await call('describe_dataset', { dataset: 'Remote' }), await call('describe_dataset', { dataset: 'Local' })]);
  ok('secrets: no URL token, URL or file path in any output', !/SEKRET|data\.example|ledger\.csv|\/Users\/someone/.test(dump));
  ok('secrets: the origin KIND is still reported', (await call('describe_dataset', { dataset: 'Remote' })).origin === 'url');

  const q = await call('query_sql', { sql: 'SELECT region, sum(revenue) AS r FROM retail_orders GROUP BY 1 ORDER BY 1', limit: 2 });
  ok('query_sql: bounded by limit, says so', q.rowCount === 2 && q.rows.length === 2 && q.truncated === true && q.columns[0].name === 'region');
  const w = await refusal('query_sql', { sql: 'DROP TABLE retail_orders' });
  ok('query_sql: the read-only gate refuses a write', w.code === 'runtime' && w.message.length > 0);
  ok('query_sql: two statements are refused', (await refusal('query_sql', { sql: 'select 1; select 2' })).code === 'runtime');

  // aggregate ≡ vizDataFor (differential)
  const enc = { category: 'region', values: [{ column: 'revenue', aggregation: 'sum' }] };
  const agg = await call('aggregate', { dataset: ds.name, encoding: enc });
  const ref = await vis.vizDataFor(pid, ds.id, visuals.sanitizeEncoding(enc), []);
  const same = ref.ok && agg.labels.length === ref.data.labels.length
    && agg.labels.every((l: unknown, i: number) => Object.is(l, ref.data.labels[i]))
    && agg.series[0].values.every((v: unknown, i: number) => Object.is(v, ref.data.series[0].values[i]));
  ok('aggregate: identical to vizDataFor, Object.is on every figure', same);
  const fAgg = await call('aggregate', { dataset: ds.name, encoding: enc, filters: [{ column: 'region', op: '=', value: 'West' }] });
  ok('aggregate: a filter narrows it (type is filled in, never dropped)', fAgg.labels.length === 1 && fAgg.labels[0] === 'West');
  const badF = await refusal('aggregate', { dataset: ds.name, encoding: enc, filters: [{ column: 'region', op: 'resembles', value: 'x' }] });
  ok('aggregate: an unreadable filter is refused, not silently dropped', badF.code === 'usage' && /Filter 1/.test(badF.message));
  // The list sanitizer keeps a step of an unknown type (a glossary term); an agent's filter must still be a plain filter.
  const termF = await refusal('aggregate', { dataset: ds.name, encoding: enc, filters: [{ type: 'term', term: '7d2c1f4e-1111-4222-8333-444455556666' }] });
  const futureF = await refusal('aggregate', { dataset: ds.name, encoding: enc, filters: [{ column: 'region', op: '=', value: 'West' }, { type: 'future_x', a: 1 }] });
  ok('NEGATIVE CONTROL: aggregate refuses a term and an unknown-typed step by position (the plain filter before it passes)',
    termF.code === 'usage' && /Filter 1/.test(termF.message) && futureF.code === 'usage' && /Filter 2/.test(futureF.message), termF.message + ' | ' + futureF.message);
  const txt = await refusal('aggregate', { dataset: ds.name, encoding: { category: 'region', values: [{ column: 'state', aggregation: 'sum' }] } });
  ok('aggregate: sum of a text column refused with the validator\'s reason', txt.code === 'usage' && txt.message.includes('needs a number column'));
  const missCol = await refusal('aggregate', { dataset: ds.name, encoding: { category: 'nope', values: [{ column: 'revenue', aggregation: 'sum' }] } });
  ok('aggregate: an unknown column refused', missCol.code === 'usage' && missCol.message.includes('is not a column'));

  // metric_value ≡ resolveMetric; insights ≡ insightsForDataset
  const mList = await call('list_metrics', {});
  const margin = mList.find((m: any) => m.name === 'Margin %');
  const mv = await call('metric_value', { metric: 'margin %' });
  const mr = (await mets.resolveMetric(pid, margin.id, {}))!;
  ok('metric_value: by name, case-insensitive, identical to resolveMetric', Object.is(mv.value, mr.value) && mv.display === mr.display);
  ok('metric_value: an unknown metric is not_found', (await refusal('metric_value', { metric: 'Nope' })).code === 'not_found');
  // Glossary terms (semantic D12): list_terms, and a `terms` arg on aggregate and metric_value that the doors expand.
  const termsStore: typeof import('../src/analysis/terms') = require('../src/analysis/terms');
  const westT = (await termsStore.saveTerm(pid, { name: 'West only', aliases: ['Westside'], datasetId: ds.id, filters: [{ type: 'filter', column: 'region', op: '=', value: 'West' }] }))!;
  const tAgg = await call('aggregate', { dataset: ds.name, encoding: enc, terms: ['westside'] });
  ok('aggregate with terms:["westside"] (an alias) equals the inline filter', JSON.stringify(tAgg.labels) === JSON.stringify(fAgg.labels)
    && tAgg.series.every((sr: any, i: number) => sr.values.every((v: unknown, k: number) => Object.is(v, fAgg.series[i].values[k]))), JSON.stringify([tAgg, fAgg]).slice(0, 300));
  const withT = await call('metric_value', { metric: 'margin %', terms: ['West only'] });
  const inlineT = (await mets.resolveMetric(pid, margin.id, { filters: [{ type: 'filter', column: 'region', op: '=', value: 'West' }] }))!;
  ok('metric_value with a term differs from without, and equals the metric under the inline filter', withT.value !== mv.value && Object.is(withT.value, inlineT.value), JSON.stringify([withT, mv.value, inlineT.value]));
  ok('a term nobody is called is refused, never dropped', (await refusal('aggregate', { dataset: ds.name, encoding: enc, terms: ['Nope'] })).code === 'usage'
    && (await refusal('metric_value', { metric: 'margin %', terms: ['Nope'] })).code === 'usage');
  const tl = await call('list_terms', {});
  ok('list_terms: the term, its other names, its dataset and its filter in words', tl.length === 1 && tl[0].id === westT.id && tl[0].aliases[0] === 'Westside'
    && tl[0].dataset === ds.name && tl[0].definition === 'region = West', JSON.stringify(tl));
  // Status (semantic part 4): certified first with who and when; a retired metric still computes and names its replacement.
  const stStore: typeof import('../src/analysis/statusStore') = require('../src/analysis/statusStore');
  const { pinOf }: typeof import('../src/analysis/statusPin') = require('../src/analysis/statusPin');
  const stBefore = JSON.stringify([await call('list_metrics', {}), await call('list_terms', {}), await call('list_datasets', {})]);
  const retiredM = mList.find((m: any) => m.id !== margin.id);
  await stStore.certify(pid, `metric:${margin.id}`, (await pinOf(pid, `metric:${margin.id}`))!, '');
  await stStore.retire(pid, `metric:${retiredM.id}`, `metric:${margin.id}`, '');
  const stList = await call('list_metrics', {});
  ok('list_metrics: certified first with who and when', stList[0].id === margin.id && stList[0].status === 'certified' && typeof stList[0].certifiedBy === 'string' && typeof stList[0].certifiedAt === 'string', JSON.stringify(stList[0]));
  ok('list_metrics: a retired one names its replacement', stList.find((m: any) => m.id === retiredM.id).replacedBy === margin.name);
  const stV = await call('metric_value', { metric: retiredM.id });
  const stR = (await mets.resolveMetric(pid, retiredM.id, {}))!;
  ok('metric_value on a retired metric: the figure, plus what replaces it', Object.is(stV.value, stR.value) && stV.status === 'retired' && stV.replacedBy === margin.name, JSON.stringify(stV));
  await stStore.clearStatus(pid, `metric:${margin.id}`);
  await stStore.clearStatus(pid, `metric:${retiredM.id}`);
  ok('NEGATIVE CONTROL: a project without status lists exactly as before', JSON.stringify([await call('list_metrics', {}), await call('list_terms', {}), await call('list_datasets', {})]) === stBefore);
  const found = await call('insights', { dataset: ds.name });
  ok('insights: the same findings the app ranks', found.length === (await ins.insightsForDataset(pid, ds.id)).length && found.length > 0);
  const dash = await call('list_dashboards', {});
  ok('list_dashboards: the sample dashboard', dash.some((x: any) => x.id === seeded.analysisId && Array.isArray(x.reports)));

  // ── Creators ───────────────────────────────────────────────────────────────
  jobs.reset();
  const before = datasetFiles(pid);
  const vIn = {
    dataset: ds.name, name: 'Revenue by region (automation)', chartType: 'bar',
    encoding: { category: 'region', values: [{ column: 'revenue', aggregation: 'sum' }] },
    filters: [{ column: 'region', op: '!=', value: 'East' }],
  };
  const created = await call('create_visual', vIn);
  const saved = (await visuals.getVisual(pid, created.id))!;
  ok('create_visual: a valid encoding survives sanitizeEncoding unchanged',
    JSON.stringify(saved.encoding) === JSON.stringify(vIn.encoding) && JSON.stringify(visuals.sanitizeEncoding(vIn.encoding)) === JSON.stringify(vIn.encoding));
  const ctx = await plan.loadPlanContext(pid, ds.id);
  const rt = plan.validatePlan({ name: 'x', sheets: [{ name: 's', visuals: [{ ...vIn, datasetId: ds.id, filters: vIn.filters.map((f) => ({ type: 'filter', ...f })) }] }] }, ctx);
  ok('create_visual: …and validatePlan with no drops, the saved visual equal to its verdict',
    rt.dropped.length === 0 && JSON.stringify(rt.plan.sheets[0].visuals[0].encoding) === JSON.stringify(saved.encoding)
      && JSON.stringify(rt.plan.sheets[0].visuals[0].filters) === JSON.stringify(saved.filters) && saved.chartType === 'bar');
  ok('create_visual: a version is recorded', (await versions.list(pid, 'visual', created.id)).length === 1);
  await new Promise((r) => setTimeout(r, 10));
  const recent = jobs.snapshot().recent;
  ok('create_visual: logged as a finished automation job', recent.length === 1 && recent[0].kind === 'automation' && recent[0].state === 'done' && /Revenue by region/.test(recent[0].label));

  const sunburst = await refusal('create_visual', { ...vIn, chartType: 'sunburst' });
  ok('create_visual: an invented chart type fails the schema (-32602 over MCP)', sunburst.code === 'usage' && sunburst.stage === 'args');
  const textSum = await refusal('create_visual', { ...vIn, encoding: { category: 'region', values: [{ column: 'category', aggregation: 'avg' }] } });
  const expected = plan.validatePlan({ name: 'x', sheets: [{ name: 'S', visuals: [{ ...vIn, datasetId: ds.id, encoding: { category: 'region', values: [{ column: 'category', aggregation: 'avg' }] } }] }] }, ctx).dropped[0].message;
  ok('create_visual: an invalid one is refused with the validator\'s own reason', textSum.code === 'usage' && textSum.message === expected.replace(/^Sheet "S" visual 1 /, 'Visual '), textSum.message);
  const pv = await call('create_visual', { dataset: ds.name, name: 'Pivot (automation)', chartType: 'pivot',
    encoding: { pivot: { rows: [{ column: 'region' }], values: [{ column: 'revenue', aggregation: 'sum' }] } } });
  const pvSaved = (await visuals.getVisual(pid, pv.id))!;
  ok('create_visual: a pivot gets its mirrored chart fields, as the builder saves one',
    pvSaved.encoding.category === 'region' && pvSaved.encoding.pivot!.rows[0].column === 'region' && pvSaved.encoding.values[0].column === 'revenue');
  const pvBad = await refusal('create_visual', { dataset: ds.name, name: 'P', chartType: 'pivot', encoding: { category: 'region', values: [{ column: 'revenue', aggregation: 'sum' }] } });
  ok('create_visual: a pivot with no pivot block is refused', pvBad.code === 'usage' && pvBad.message.includes('pivot'));

  const rawPlan = {
    name: 'Automation board',
    calculatedFields: [{ dataset: ds.name, name: 'double_rev', formula: '[revenue] * 2' }],
    sheets: [{
      name: 'Main',
      metrics: [{ dataset: ds.name, column: 'revenue', aggregation: 'sum', label: 'Revenue' }],
      visuals: [
        { dataset: ds.name, name: 'Revenue by category', chartType: 'column', encoding: { category: 'category', values: [{ column: 'revenue', aggregation: 'sum' }] } },
        { dataset: ds.name, name: 'Invented', chartType: 'sunburst', encoding: { category: 'category', values: [{ column: 'revenue', aggregation: 'sum' }] } },
      ],
      texts: [{ heading: 'Notes', text: 'Built by automation.' }],
    }],
  };
  const stepsBefore = (meta.steps || []).length;
  const board = await call('create_dashboard', { plan: rawPlan });
  const built = (await analysis.getAnalysis(pid, board.id))!;
  ok('create_dashboard: built, with the tiles that validated', built.name === 'Automation board' && built.sheets[0].cards.map((c: any) => c.type).sort().join() === 'metric,text,visual', JSON.stringify(built.sheets[0].cards.map((c: any) => c.type)));
  const noCalc = { ...rawPlan } as Record<string, unknown>;
  delete noCalc.calculatedFields;
  const verdict = plan.validatePlan(noCalc, await plan.loadPlanContext(pid));
  ok('create_dashboard: reports exactly the validator\'s drops, plus the refused calculated field',
    board.dropped.length === verdict.dropped.length + 1 && board.dropped[0].where === 'calculatedFields'
      && board.dropped.slice(1).every((x: any, i: number) => x.message === verdict.dropped[i].message));
  ok('create_dashboard: the calculated field was NOT applied — the dataset\'s pipeline is untouched',
    ((await datasets.getDatasetMeta(pid, ds.id))!.steps || []).length === stepsBefore);
  ok('creators: every dataset file byte-for-byte untouched', datasetFiles(pid) === before);
  ok('create_dashboard: a version and a job', (await versions.list(pid, 'dashboard', board.id)).length === 1
    && jobs.snapshot().recent.some((j) => j.kind === 'automation' && /Automation board/.test(j.label)));
  const empty = await refusal('create_dashboard', { plan: { name: 'Nothing', sheets: [{ name: 'S', visuals: [{ dataset: 'Nope', chartType: 'bar' }] }] } });
  ok('create_dashboard: a plan with nothing buildable is refused with the reasons', empty.code === 'usage' && empty.message.includes('unknown dataset'));

  // ── publish, against a stubbed contract ────────────────────────────────────
  const pub = publishing as any; // ponytail: monkeypatching the module's exports object
  let seen: any = null;
  pub.sanitizePublishConfig = (raw: any) => (raw.dashboardIds && raw.dashboardIds.length ? { ...raw, storyIds: [], options: {} } : { error: 'Choose at least one dashboard.' });
  pub.publishSite = async (cfg: any, pctx: any) => { seen = cfg; pctx.progress(0.5, 'Writing pages'); return { outDir: cfg.outDir, files: ['index.html', 'manifest.json'], bytes: 42, combos: 0 }; };
  const cfgDir = path.join(tmp, 'cfg');
  fs.mkdirSync(cfgDir);
  fs.writeFileSync(path.join(cfgDir, 'site.json'), JSON.stringify({ dashboardIds: [seeded.analysisId], outDir: 'site' }));
  const published = await call('publish', { config: 'cfg/site.json' }, 'cli');
  ok('publish: project filled from --project, relative outDir resolved against the config file',
    seen.projectId === pid && seen.outDir === path.join(cfgDir, 'site') && published.files.length === 2);
  ok('publish: runs as a publish job', jobs.snapshot().recent.some((j) => j.kind === 'publish' && j.state === 'done'));
  fs.writeFileSync(path.join(cfgDir, 'none.json'), JSON.stringify({ dashboardIds: [], outDir: 'x' }));
  const pe = await refusal('publish', { config: 'cfg/none.json' }, 'cli');
  ok('publish: the sanitizer\'s refusal is a usage error with its message', pe.code === 'usage' && pe.message === 'Choose at least one dashboard.');
  fs.writeFileSync(path.join(cfgDir, 'bad.json'), '{nope');
  ok('publish: invalid JSON is a usage error', (await refusal('publish', { config: 'cfg/bad.json' }, 'cli')).code === 'usage');
  ok('publish: a missing file is not_found', (await refusal('publish', { config: 'cfg/missing.json' }, 'cli')).code === 'not_found');
  ok('publish: not an MCP tool', !reg.findTool('publish'));

  // ── dashboards export --html, against a stubbed page ───────────────────────
  pub.dashboardPageHtml = async () => '<!doctype html><title>Retail</title><p>page</p>';
  const out1 = await call('dashboards export', { dashboard: 'Retail overview', format: 'html', out: 'one.html' }, 'cli');
  ok('export --html: written where --out says', out1.path === path.join(tmp, 'one.html') && fs.readFileSync(out1.path, 'utf8').includes('<p>page</p>'));
  const out2 = await call('dashboards export', { dashboard: 'Retail overview', format: 'html' }, 'cli');
  ok('export --html: default is ./<name>.html', out2.path === path.join(tmp, 'Retail overview.html'));
  const m1 = await call('export_dashboard', { dashboard: 'Retail overview', format: 'html' });
  const m2 = await call('export_dashboard', { dashboard: 'Retail overview', format: 'html' });
  ok('export over MCP: always a NEW file in Downloads/Ordinate',
    path.dirname(m1.path) === path.join(downloads, 'Ordinate') && m2.path.endsWith('Retail overview (2).html'));
  pub.dashboardPageHtml = async () => { throw new Error('Publishing is not available yet.'); };
  const ee = await refusal('dashboards export', { dashboard: 'Retail overview', format: 'html' }, 'cli');
  ok('export: a failing renderer is a runtime error with its message', ee.code === 'throw' || ee.code === 'runtime');

  // ── The Share policy on automation (its EXPORT path) ────────────────────────
  {
    const catalog: typeof import('../src/app/catalog') = require('../src/app/catalog');
    const privacy: typeof import('../src/app/privacyStore') = require('../src/app/privacyStore');
    const text = meta.columns.find((c) => c.type === 'text')!;
    const sql = `select "${text.name}" from retail_orders limit 5`;
    const agg = { dataset: ds.name, encoding: { category: text.name, values: [{ column: meta.columns.find((c) => c.type === 'number')!.name, aggregation: 'sum' }] } };
    const rawRows = (await call('query_sql', { sql })).rows.map((r: any[]) => r[0]);
    const rawLabels = (await call('aggregate', agg)).labels;
    await catalog.setColumn(pid, ds.id, text.name, { sensitivity: 'personal' } as any); // any: a ColumnPatch literal
    const masked = await call('query_sql', { sql });
    ok('policy: query_sql masks a sensitive column\'s values and says so',
      masked.rows.every((r: any[], i: number) => r[0] !== rawRows[i]) && masked.sharePolicy.masked.includes(text.name), JSON.stringify(masked.sharePolicy));
    const maskedAgg = await call('aggregate', agg);
    ok('policy: aggregate returns tokens for a sensitive category, same figures',
      maskedAgg.labels.every((l: any) => !rawLabels.includes(l)) && maskedAgg.labels.length === rawLabels.length);
    await privacy.setPolicy(pid, { export: 'drop' });
    const droppedQ = await call('query_sql', { sql });
    ok('policy: under drop the column is gone from the result', droppedQ.columns.length === 0 && droppedQ.sharePolicy.dropped.includes(text.name));
    ok('policy: under drop an aggregate over it is refused', /share policy/i.test((await refusal('aggregate', agg)).message));
    await privacy.setPolicy(pid, { export: 'mask' });
    await catalog.setColumn(pid, ds.id, text.name, { sensitivity: 'none' } as any); // any: a ColumnPatch literal
  }

  // ── metric_value on the Share policy's EXPORT path, as aggregate: refused, typed, under drop ──
  {
    const catalog: typeof import('../src/app/catalog') = require('../src/app/catalog');
    const privacy: typeof import('../src/app/privacyStore') = require('../src/app/privacyStore');
    const metricsStore: typeof import('../src/analysis/metrics') = require('../src/analysis/metrics');
    const crypto: typeof import('crypto') = require('crypto');
    const [marked, open] = meta.columns.filter((c) => c.type === 'number').map((c) => c.name);
    const save = async (name: string, definition: object) => (await metricsStore.saveMetric(pid, { name, datasetId: ds.id, definition } as any))!; // any: a record literal the saver sanitizes
    const plainM = await save('Policy marked total', { column: marked, aggregation: 'sum' });
    const formulaM = await save('Policy marked half', { formula: '[Policy marked total] / 2' });
    const openM = await save('Policy open total', { column: open, aggregation: 'sum' });
    const value = (metric: string) => call('metric_value', { metric });
    const unmarked = [await value(plainM.name), await value(formulaM.name), await value(openM.name)];
    const sha = crypto.createHash('sha256').update(JSON.stringify(unmarked).replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, 'U')).digest('hex');
    ok('policy PIN: with nothing marked, metric_value answers what it answered before this change', sha === 'fcf0c0cda9efb583c84d944b729b4bf757f9e69aea00f48c3344d8c54b00a44e', sha); // the replies develop 98176da9 gave
    await catalog.setColumn(pid, ds.id, marked, { sensitivity: 'financial' } as any); // any: a ColumnPatch literal
    await privacy.setPolicy(pid, { export: 'drop' });
    for (const m of [plainM, formulaM]) {
      const r = await refusal('metric_value', { metric: m.name });
      ok(`policy: under drop metric_value "${m.name}" over the marked column is refused, typed, as aggregate is`,
        r.code === 'runtime' && /share policy/i.test(r.message) && !r.message.includes(String(Math.round(unmarked[0].value))), JSON.stringify(r));
    }
    ok('policy NEGATIVE CONTROL: under drop, a metric over a column nobody marked still answers', JSON.stringify(await value(openM.name)) === JSON.stringify(unmarked[2]));
    await privacy.setPolicy(pid, { export: 'mask' });
    ok('policy: under mask metric_value answers the figure, as aggregate passes an aggregate', JSON.stringify([await value(plainM.name), await value(formulaM.name)]) === JSON.stringify(unmarked.slice(0, 2)));
    await catalog.setColumn(pid, ds.id, marked, { sensitivity: 'none' } as any); // any: a ColumnPatch literal
    await privacy.setPolicy(pid, { export: 'drop' });
    ok('policy NEGATIVE CONTROL: unmarked again, drop answers as before', JSON.stringify(await value(plainM.name)) === JSON.stringify(unmarked[0]));
    await privacy.setPolicy(pid, { export: 'mask' });
  }

  // ── Verified questions and instructions (semantic part 3 step 09) ──────────
  {
    const answers: typeof import('../src/ipc/answers') = require('../src/ipc/answers');
    const store: typeof import('../src/analysis/verifiedQuestions') = require('../src/analysis/verifiedQuestions');
    const catalog: typeof import('../src/app/catalog') = require('../src/app/catalog');
    const privacy: typeof import('../src/app/privacyStore') = require('../src/app/privacyStore');
    const byQ = (l: any[], q: string): any => l.find((x) => x.question === q);
    const specOf = async (q: string) => (await store.listVerified(pid)).find((v) => v.question === q)!.spec;
    const list = (await call('list_verified_questions', {})).questions;
    ok('verified: lists the sample\'s set', list.length === 4 && list.every((q: any) => q.runs && q.dataset === ds.name && q.verifiedBy), JSON.stringify(list.map((q: any) => q.question)));
    ok('verified: aggregate args only where aggregate can say it',
      !!byQ(list, 'Revenue by region').aggregate && !!byQ(list, 'Profit by category').aggregate
      && !byQ(list, 'Top 5 states by revenue').aggregate && !byQ(list, 'Revenue by month last year').aggregate);
    ok('verified: …and the others say where to go', /answer_verified_question/.test(byQ(list, 'Top 5 states by revenue').use) && !('use' in byQ(list, 'Revenue by region')));
    const ans = await call('answer_verified_question', { question: 'revenue BY region?' });
    const card = await answers.computeCard(pid, await specOf('Revenue by region'));
    ok('verified: figures are answer:card\'s, Object.is', 'card' in card && ans.labels.length > 0
      && ans.labels.every((l: any, i: number) => Object.is(l, card.card.data.labels[i]))
      && ans.series[0].values.every((v: number, i: number) => Object.is(v, card.card.data.series[0].values[i])));
    const agg = await call('aggregate', byQ(list, 'Revenue by region').aggregate);
    ok('verified: aggregate with the listed args agrees, label by label',
      ans.labels.every((l: string, i: number) => Object.is(agg.series[0].values[agg.labels.indexOf(l)], ans.series[0].values[i])));
    ok('verified: who verified it, and as-of', ans.verifiedBy.length > 0 && !!ans.asOf && ans.id === byQ(list, 'Revenue by region').id && ans.headline.length > 0);
    ok('verified: by id and by a phrasing, the same answer',
      JSON.stringify((await call('answer_verified_question', { question: ans.id })).series) === JSON.stringify(ans.series)
      && JSON.stringify((await call('answer_verified_question', { question: 'Which region sells the most' })).series) === JSON.stringify(ans.series));
    ok('verified: an unknown question refuses',
      (await refusal('answer_verified_question', { question: 'revenue by planet' })).message === 'No verified question \u201crevenue by planet\u201d in this project.');
    ok('verified: so does punctuation alone (an empty key matches nothing)', (await refusal('answer_verified_question', { question: '???' })).code === 'not_found');
    const ins = await call('get_instructions', {});
    ok('verified: instructions, with the framing', ins.instructions.length === 3 && ins.framing.startsWith('GUIDANCE FROM THIS PROJECT\'S EDITORS')
      && ins.instructions.every((i: any) => i.text && i.updatedBy && i.updatedAt));
    await catalog.mutateCatalog(pid, (f) => { f.instructions = [...(f.instructions ?? []), { id: '11111111-1111-4111-8111-111111111111', text: 'x <<<GUIDANCE y', updatedBy: 'u', updatedAt: 't' }]; });
    const fenced = await call('get_instructions', {});
    ok('verified: a text holding the fence is left out', fenced.instructions.length === 3 && !JSON.stringify(fenced).includes('<<<GUIDANCE y'));
    ok('verified: NEGATIVE CONTROL — it is stored', (await (require('../src/app/instructions') as typeof import('../src/app/instructions')).listInstructions(pid)).length === 4);
    // The Share policy's export path: a masked label leaves as a token, and no headline names it.
    await catalog.setColumn(pid, ds.id, 'region', { sensitivity: 'personal' } as any); // any: a ColumnPatch literal
    const masked = await call('answer_verified_question', { question: 'Revenue by region' });
    ok('verified: a sensitive category leaves masked, with no headline', !('headline' in masked) && !JSON.stringify(masked).includes('West') && masked.labels.length === ans.labels.length);
    await privacy.setPolicy(pid, { export: 'drop' });
    ok('verified: under drop it is refused as aggregate refuses', /share policy/i.test((await refusal('answer_verified_question', { question: 'Revenue by region' })).message));
    await privacy.setPolicy(pid, { export: 'mask' });
    await catalog.setColumn(pid, ds.id, 'region', { sensitivity: 'none' } as any);
    const open = await call('answer_verified_question', { question: 'Revenue by region' });
    ok('verified: NEGATIVE CONTROL — unmarked, the labels and the headline are there', JSON.stringify(open).includes('West') && open.headline.length > 0);
  }

  // ── The CLI end to end, real registry ──────────────────────────────────────
  const run = async (argv: string[]): Promise<{ code: number; out: string }> => {
    let out = '';
    const code = await cli.runCli(argv, { out: (t) => { out += t; }, err: () => {} }, { headless: true, cwd: tmp });
    return { code, out };
  };
  const j = await run(['query', 'select count(*) as n from retail_orders', '--json']);
  ok('cli: query --json answers with the count', j.code === 0 && JSON.parse(j.out).result.rows[0][0] === ds.rowCount);
  ok('cli: a missing dataset exits 3', (await run(['insights', 'Nope'])).code === 3);
  ok('cli: a SQL error exits 1', (await run(['query', 'select nope from retail_orders'])).code === 1);
  ok('cli: a malformed call exits 2', (await run(['query', 'select 1', '--limit', '0'])).code === 2);
}

main()
  .catch((e) => ok('no unexpected throw', false, e && e.stack))
  .finally(() => {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* temp dir */ }
    finish();
  });
