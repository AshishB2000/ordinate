// Prepare and pipelines over the real RPC route, in server mode (T2.6).
//
// 1. Step-mutating replies carry the pipeline's shape and NOTHING else: no
//    rows, no source, no origin (a URL with a key in it, here) — while the
//    stored table really changed (`dataset:page` agrees with the reply's count).
// 2. The formula editor's verdicts come from the server's compile(): a valid
//    expression's eight sample results are Object.is-equal to the same
//    expression evaluated over the same rows by the formula engine; an unknown
//    column names its nearest real one; a parse error carries its position.
// 3. Every figure the screen prints is the server's: the keyword preview's
//    shares and bars, the text profile's bars and mood, the spatial preview's
//    matched share and "outside", the pipelines strip's counts and a run's tally.
// 4. The contracts refuse what the handlers would otherwise coerce.
//
//   npm run build:ts && node scripts/test-prepareServer.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import { withCsrf } from './csrfPair';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');

const context: typeof import('../src/server/context') = require('../src/server/context');
const appMod: typeof import('../src/server/app') = require('../src/server/app');
const envMod: typeof import('../src/server/env') = require('../src/server/env');
const wire: typeof import('../src/server/wire') = require('../src/server/wire');
const summary: typeof import('../src/app/pipelineSummary') = require('../src/app/pipelineSummary');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-prepare-'));
const SECRET = 'S3CRET-prepare-origin-key';
type Any = any; // any: each channel's own reply shape, read field by field below

(async () => {
  context.enterServerMode(DATA);
  appMod.registerHandlers();
  const env = envMod.parseEnv({ LOG_LEVEL: 'silent', DATA_DIR: DATA });
  const app = appMod.buildApp(env);
  const dev = context.identityFor(env)({} as never);
  if (!dev) throw new Error('no dev identity');
  const inOrg = <T>(fn: () => Promise<T>): Promise<T> => context.runInContext(dev, 'test', fn);

  const projects: typeof import('../src/app/projects') = require('../src/app/projects');
  const sample: typeof import('../src/app/sampleProject') = require('../src/app/sampleProject');
  const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
  const formula: typeof import('../src/formula/formula') = require('../src/formula/formula');

  const { projectId, datasetId, urlId, reviewsId, pointsId } = await inOrg(async () => {
    await projects.init();
    const pid = String((await sample.seedSampleProject()).projectId);
    const did = (await datasets.listDatasets(pid))[0].id;
    const u = await datasets.saveDataset(pid, {
      name: 'From a URL', sourceKind: 'json',
      columns: [{ name: 'a', type: 'number' }, { name: 'b', type: 'text' }], rows: [[1, 'x'], [2, 'y'], [3, 'y']],
      origin: { kind: 'url', url: `https://example.com/d.json?api_key=${SECRET}` },
    } as never);
    const long = (s: string) => `${s} — the delivery was quick and the support team answered every question I had.`;
    const r = await datasets.saveDataset(pid, {
      name: 'Reviews', sourceKind: 'csv', columns: [{ name: 'review', type: 'text' }],
      rows: [[long('Great product, I love it')], [long('Terrible, broken on arrival')], [long('Fine')], [long('Great value')]],
    } as never);
    const p = await datasets.saveDataset(pid, {
      name: 'Points', sourceKind: 'csv', columns: [{ name: 'lat', type: 'number' }, { name: 'lng', type: 'number' }],
      rows: [[30.27, -97.74], [40.71, -74.0], [0, -30], [null, null]],
    } as never);
    return { projectId: pid, datasetId: did, urlId: u!.id, reviewsId: r!.id, pointsId: p!.id };
  });

  const post = async (channel: string, payload?: unknown): Promise<{ status: number; body: string; json: Any }> => {
    const r = await app.inject({
      method: 'POST', url: `/api/rpc/${encodeURIComponent(channel)}`,
      headers: withCsrf({ 'content-type': 'application/json' }),
      payload: wire.encode({ args: payload === undefined ? [] : [payload] }),
    });
    return { status: r.statusCode, body: r.body, json: r.statusCode === 200 ? wire.decode(r.body) : null };
  };
  const total = async (id: string): Promise<number> => (await post('dataset:page', { projectId, datasetId: id, offset: 0, limit: 1 })).json.total;

  // ── 1. The opening state and the step replies ────────────────────────────
  const g0 = await post('prepare:get', { projectId, datasetId });
  const n0: number = g0.json.steps.length; // the sample arrives with its own (row-neutral) steps
  ok('prepare:get: 200, 5,000 rows, a count per step', g0.status === 200 && g0.json.rowCount === 5000 && g0.json.stepCounts.length === n0, g0.body.slice(0, 200));
  ok('prepare:get: exactly the pipeline\'s fields',
    Object.keys(g0.json).sort().join() === 'columns,id,name,rowCount,stepCounts,steps,updatedAt', Object.keys(g0.json).join());

  const add = await post('dataset:addStep', { projectId, datasetId, step: { type: 'filter', column: 'region', op: '=', value: 'East' } });
  const a = add.json;
  ok('dataset:addStep: ok, one more step', add.status === 200 && a.ok === true && a.dataset.steps.length === n0 + 1, add.body.slice(0, 300));
  ok('…the reply has no rows and no source', !('rows' in a.dataset) && !('source' in a.dataset) && !('rows' in a.preview), Object.keys(a.dataset).join());
  ok('…and is small (the pipeline, not the table)', add.body.length < 4000, String(add.body.length));
  ok('…its count is the stored table\'s', a.preview.rowCount > 0 && a.preview.rowCount < 5000 && a.preview.rowCount === await total(datasetId), String(a.preview.rowCount));
  ok('…with the rows into and out of the step', a.preview.stepCounts[n0].before === 5000 && a.preview.stepCounts[n0].after === a.preview.rowCount, JSON.stringify(a.preview.stepCounts));

  const u = await post('dataset:addStep', { projectId, datasetId: urlId, step: { type: 'trim' } });
  ok('a dataset with a keyed URL origin: the step reply never carries it', u.status === 200 && u.json.ok === true && !u.body.includes(SECRET) && !u.body.includes('example.com'), u.body.slice(0, 300));

  const calc = { type: 'calculated_field', name: 'double', expression: '[units] * 2' };
  const add2 = await post('dataset:addStep', { projectId, datasetId, step: calc });
  ok('a calculated field lands last', add2.json.ok && add2.json.dataset.steps.length === n0 + 2 && add2.json.dataset.columns.some((c: Any) => c.name === 'double'));
  const order = [...Array(n0).keys(), n0 + 1, n0];
  const ro = await post('dataset:reorderSteps', { projectId, datasetId, order });
  ok('dataset:reorderSteps: the order changes, the count does not', ro.json.ok && ro.json.dataset.steps[n0].type === 'calculated_field' && ro.json.preview.rowCount === a.preview.rowCount);
  const up = await post('dataset:updateStep', { projectId, datasetId, index: n0 + 1, step: { type: 'filter', column: 'region', op: '=', value: 'West' } });
  ok('dataset:updateStep: replaces the filter', up.json.ok && up.json.dataset.steps[n0 + 1].value === 'West' && up.json.preview.rowCount === await total(datasetId));
  const rm = await post('dataset:removeStep', { projectId, datasetId, index: n0 + 1 });
  ok('dataset:removeStep: the filter goes, every row is back', rm.json.ok && rm.json.dataset.steps.length === n0 + 1 && rm.json.preview.rowCount === 5000);
  const g1 = await post('prepare:get', { projectId, datasetId });
  ok('prepare:get after the edits: the steps and their counts', g1.json.steps.length === n0 + 1 && g1.json.stepCounts.length === n0 + 1 && g1.json.columns.some((c: Any) => c.name === 'double'));
  const set = await post('dataset:setSteps', { projectId, datasetId, steps: [] });
  ok('dataset:setSteps []: the source again', set.json.ok && set.json.dataset.steps.length === 0 && set.json.preview.rowCount === 5000 && await total(datasetId) === 5000);

  // ── 2. The formula editor ────────────────────────────────────────────────
  const expr = 'round([revenue] / [units], 2)';
  const fc = await post('formula:check', { projectId, datasetId, expression: expr });
  const f = fc.json;
  ok('formula:check: ok, number, tokens for the highlight', fc.status === 200 && f.ok === true && f.resultType === 'number' && f.tokens.length > 5, fc.body.slice(0, 300));
  const page = (await post('dataset:page', { projectId, datasetId, offset: 0, limit: 8 })).json;
  const names = (g0.json.columns as Any[]).map((c) => c.name);
  const compiled = formula.compile(expr);
  const expected = page.rows.map((row: Any[]) => {
    const m: Record<string, Any> = {};
    names.forEach((n: string, i: number) => { m[n] = row[i]; });
    return compiled.ok ? compiled.fn.evaluate(m) : undefined;
  });
  ok('formula:check: eight results, Object.is-equal to the engine over the same rows',
    f.sample.rows.length === 8 && f.sample.rows.every((r: Any, i: number) => Object.is(r.result, expected[i])), JSON.stringify(f.sample.rows.map((r: Any) => r.result)));
  const unk = (await post('formula:check', { projectId, datasetId, expression: '[reveune] * 2' })).json;
  ok('an unknown column names its nearest real one', unk.ok === true && unk.unknownRefs[0].name === 'reveune' && unk.unknownRefs[0].didYouMean === 'revenue', JSON.stringify(unk.unknownRefs));
  const bad = (await post('formula:check', { projectId, datasetId, expression: '[units] * (2' })).json;
  ok('a parse error carries its message and position', bad.ok === false && typeof bad.error === 'string' && typeof bad.at?.start === 'number', JSON.stringify(bad).slice(0, 200));
  const fns = await post('formula:functions');
  ok('formula:functions: the catalog, LOD entries last', fns.status === 200 && fns.json.length > 50 && fns.json.at(-1).category === 'lod');

  // ── 3. Server-computed figures ───────────────────────────────────────────
  const pd = (await post('prepare:stepPreview', { projectId, datasetId, index: -1, step: { type: 'parse_date', column: 'order_date', format: 'YYYY-MM-DD' } })).json;
  ok('prepare:stepPreview parse_date: every value parsed', pd.ok && pd.parseDate.parsed === 5000 && pd.parseDate.failed === 0 && pd.parseDate.filled === 5000, JSON.stringify(pd).slice(0, 200));

  const kw = (await post('text:preview', {
    projectId, datasetId, index: -1,
    step: { type: 'keyword_rules', column: 'region', rules: [{ pattern: 'East', match: 'word', category: 'E' }], otherwise: 'Other' },
  })).json;
  const cats: Any[] = kw.categories || [];
  const sum = cats.reduce((s, c) => s + c.count, 0);
  const max = Math.max(...cats.map((c) => c.count));
  ok('text:preview keyword rules: each category\'s share and bar, from the server',
    kw.ok && cats.length === 2 && cats.every((c) => c.pct === Math.round((c.count / sum) * 100) && c.barPct === Math.max(c.count ? 2 : 0, Math.round((c.count / max) * 100))), JSON.stringify(cats));

  const tp = (await post('text:profile', { projectId, datasetId: reviewsId, column: 'review' })).json;
  ok('text:profile: eligible, bars on the terms, a mood', tp.ok && tp.profile.eligible === true && tp.profile.topTerms.length > 0
    && tp.profile.topTerms.every((t: Any) => typeof t.barPct === 'number') && tp.profile.topTerms[0].barPct === 100
    && ['positive', 'neutral', 'negative'].includes(tp.profile.mood), JSON.stringify(tp).slice(0, 300));
  const short = (await post('text:profile', { projectId, datasetId, column: 'region' })).json;
  ok('text:profile: short labels are not text', short.ok && short.profile.eligible === false);

  const sp = (await post('geo:spatialPreview', { projectId, datasetId: pointsId, index: -1, step: { type: 'spatial_join', lat: 'lat', lng: 'lng', boundary: 'us_state', as: 'region' } })).json;
  ok('geo:spatialPreview: matched share and "outside" from the server',
    sp.ok && sp.stats.total === 4 && sp.stats.matched === 2 && sp.stats.pct === 50 && sp.stats.noCoords === 1 && sp.stats.outside === 1, JSON.stringify(sp));
  const sources = (await post('geo:boundarySources', { projectId })).json;
  ok('geo:boundarySources: the bundled three', sources.ok && sources.bundled.length >= 3);

  // ── 4. Refusals ──────────────────────────────────────────────────────────
  const refusals: [string, string, Record<string, unknown>][] = [
    ['an index below -1', 'prepare:stepPreview', { projectId, datasetId, index: -2, step: { type: 'trim' } }],
    ['a step with no type', 'dataset:addStep', { projectId, datasetId, step: { column: 'x' } }],
    ['a fractional index', 'dataset:removeStep', { projectId, datasetId, index: 0.5 }],
    ['an unknown key', 'prepare:get', { projectId, datasetId, [SECRET]: 1 }],
    ['an unknown language', 'text:profile', { projectId, datasetId, column: 'region', lang: 'xx' }],
    ['a retry count over 3', 'pipelines:setPolicy', { projectId, policy: { retries: 9, backoffMs: 30_000 } }],
    ['a refresh interval that does not exist', 'pipelines:setNodeSchedule', { projectId, nodeId: `dataset:${datasetId}`, every: 'yearly' }],
  ];
  for (const [label, ch, body] of refusals) {
    const r = await post(ch, body);
    ok(`400 ${label} (${ch}), never echoing the value`, r.status === 400 && !r.body.includes(SECRET), `${r.status} ${r.body}`);
  }

  // ── 5. Pipelines ─────────────────────────────────────────────────────────
  const pg = await post('pipelines:get', { projectId });
  const pv = pg.json;
  ok('pipelines:get: ok, the refreshable dataset as a step, a summary', pv.ok === true && pv.nodes.some((n: Any) => n.id === `dataset:${urlId}`) && typeof pv.summary?.stages === 'number', pv.nodes.map((n: Any) => n.id + ' ' + n.name).join(' | '));
  ok('pipelines:get: a URL source\'s id is masked — the origin never reaches the browser',
    !pg.body.includes(SECRET) && !pg.body.includes('example.com/d.json') && pv.nodes.some((n: Any) => /^source:url:#[0-9a-f]{16}$/.test(n.id)), pv.nodes.map((n: Any) => n.id).join(' '));
  const srcNode = pv.nodes.find((n: Any) => n.id.startsWith('source:url:#')).id;
  ok('pipelines:setPaused takes the masked id', (await post('pipelines:setPaused', { projectId, nodeId: srcNode, paused: false })).json.ok === true);
  ok('…and refuses a real URL id (a browser never had one)', (await post('pipelines:setPaused', { projectId, nodeId: `source:url:https://example.com/d.json?api_key=${SECRET}`, paused: true })).json.ok === false);
  ok('pipelines:get: the summary is summarize() over the nodes', JSON.stringify(pv.summary) === JSON.stringify(summary.summarize(pv.nodes)));
  const cron = (await post('pipelines:preview', { cron: '0 6 * * *', tz: 'UTC' })).json;
  ok('pipelines:preview: three next runs at 06:00 UTC', cron.ok && cron.next.length === 3 && cron.next.every((x: string) => x.endsWith('T06:00:00.000Z')), JSON.stringify(cron));
  const badCron = (await post('pipelines:preview', { cron: 'every day', tz: 'UTC' })).json;
  ok('pipelines:preview: not a schedule', badCron.ok === false);
  ok('pipelines:setSchedule', (await post('pipelines:setSchedule', { projectId, cron: '0 6 * * *', tz: 'UTC' })).json.ok === true);
  ok('pipelines:setPolicy', (await post('pipelines:setPolicy', { projectId, policy: { retries: 1, backoffMs: 10_000 } })).json.ok === true);
  const node = `dataset:${urlId}`;
  ok('pipelines:setPaused', (await post('pipelines:setPaused', { projectId, nodeId: node, paused: true })).json.ok === true);
  const pv2 = (await post('pipelines:get', { projectId })).json;
  ok('…the schedule, the policy and the pause read back', pv2.schedule?.cron === '0 6 * * *' && pv2.policy.retries === 1 && pv2.nodes.find((n: Any) => n.id === node)?.paused === true, JSON.stringify(pv2.schedule));
  const t0 = Date.now();
  const runR = await post('pipelines:run', { projectId });
  console.log(`pipelines:run took ${Date.now() - t0} ms`);
  const run = runR.json;
  ok('pipelines:run: no origin in the outcomes', !runR.body.includes(SECRET), runR.body.slice(0, 300));
  ok('pipelines:run: the tally is tally() over the outcomes', run.ok === true && run.done === run.outcomes.length
    && JSON.stringify({ done: run.done, failed: run.failed, blocked: run.blocked }) === JSON.stringify(summary.tally(run.outcomes)), JSON.stringify(run).slice(0, 300));
  const pv3 = (await post('pipelines:get', { projectId })).json;
  const withRows = pv3.nodes.flatMap((n: Any) => n.runs).find((r: Any) => typeof r.rows === 'number' && typeof r.rowsBefore === 'number');
  ok('pipelines:get after a run: history, and rowsDelta where both counts exist', pv3.nodes.some((n: Any) => n.runs.length > 0)
    && (!withRows || withRows.rowsDelta === withRows.rows - withRows.rowsBefore), JSON.stringify(withRows));
  ok('pipelines:get: the paused step was stepped over', pv3.nodes.find((n: Any) => n.id === node)?.runs[0]?.status === 'paused');

  await app.close();
})()
  .catch((err) => ok('suite ran to completion', false, err instanceof Error ? err.stack : err))
  .finally(() => {
    fs.rmSync(DATA, { recursive: true, force: true });
    finish();
  });
