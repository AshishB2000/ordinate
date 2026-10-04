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
const Module: any = require('module'); // ponytail: Node's loader hook is untyped

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-automation-tools-'));
const downloads = path.join(tmp, 'downloads');
const REPO = path.resolve(__dirname, '..');
const origLoad = Module._load;
Module._load = function (request: string, ...rest: any[]): any {
  if (request === 'electron') {
    return {
      app: { getPath: (n: string) => (n === 'downloads' ? downloads : tmp), getAppPath: () => REPO, getVersion: () => '9.9.9' },
      ipcMain: { handle: () => {} }, net: {}, dialog: {}, shell: {}, session: {}, BrowserWindow: function () {},
      safeStorage: { isEncryptionAvailable: () => false }, Notification: { isSupported: () => false },
    };
  }
  return origLoad.apply(this, [request, ...rest]);
};

// ponytail: compiled siblings of the real modules.
const sample: typeof import('../src/app/sampleProject') = require('../src/app/sampleProject');
const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
const visuals: typeof import('../src/analysis/visuals') = require('../src/analysis/visuals');
const analysis: typeof import('../src/analysis/analysis') = require('../src/analysis/analysis');
const plan: typeof import('../src/analysis/analysisPlan') = require('../src/analysis/analysisPlan');
const versions: typeof import('../src/app/versions') = require('../src/app/versions');
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
