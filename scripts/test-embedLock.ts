// Locked filters on every figure path an embedded page uses
// (src/publish/embedLock.ts, docs/embed/00-design.md) — server mode, no DB.
//
//   differential  every tile of an embed locked to `region = East` equals —
//                 Object.is, value by value — the same tile of the same
//                 PUBLISHED dashboard with `region = East` as a dashboard
//                 filter: charts (vizDataFor), KPIs (computeCardMetric and a
//                 saved metric through resolveMetric), a statistics tile, a
//                 metric tree of plain metrics (every node and segment), and
//                 every filter-bar combination the embed carries
//   options       the filter bar offers only what exists under the lock: the
//                 locked column's own values, a text column's values inside
//                 East (West's only channel is not listed); a control over a
//                 dataset without the column is left out
//   fail closed   a chart, a KPI and a statistics tile over a dataset WITHOUT
//                 `region`, a KPI over a formula metric, the Summary card and
//                 a metric tree with a formula in it or over that dataset
//                 are refused, not drawn — NEGATIVE CONTROL: unlocked, the same
//                 tiles draw (the pipeline would have skipped the filter)
//   no leak       nothing of North, South or West — a label, a figure, an
//                 option — is anywhere in the built page; NEGATIVE CONTROL:
//                 the unlocked page has them
//   definition    the embed is built from the dashboard AS PUBLISHED: a tile
//                 added afterwards is not in it (NEGATIVE CONTROL: /p/'s
//                 builder with no definition reads the edit)
//   no widening   an empty lock, a lock naming a parameter, are refused before
//                 anything is built; the lock steps are context filters, first
//
//   npm run build:ts && node scripts/test-embedLock.js

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
const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
const visuals: typeof import('../src/analysis/visuals') = require('../src/analysis/visuals');
const analysis: typeof import('../src/analysis/analysis') = require('../src/analysis/analysis');
const metrics: typeof import('../src/analysis/metrics') = require('../src/analysis/metrics');
const hosted: typeof import('../src/publish/hosted') = require('../src/publish/hosted');
const dd: typeof import('../src/publish/dashboardData') = require('../src/publish/dashboardData');
const lockMod: typeof import('../src/publish/embedLock') = require('../src/publish/embedLock');
const embedPage: typeof import('../src/publish/embedPage') = require('../src/publish/embedPage');
const recordFs: typeof import('../src/app/recordFs') = require('../src/app/recordFs');
const say: typeof import('../src/server/embedMessages') = require('../src/server/embedMessages');

type Identity = import('../src/server/context').Identity;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-embed-lock-'));
const ALICE: Identity = { user: { email: 'alice@acme.test', role: 'admin' }, org: { id: 'default' } };
const show = (v: unknown): string => JSON.stringify(v).slice(0, 300);

/** Object.is at every leaf. */
function same(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a as object);
  const kb = Object.keys(b as object);
  return ka.length === kb.length && ka.every((k) => same((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

/** The page's data block, parsed. */
function dataBlock(html: string): any { // any: the page's JSON, read field by field
  const m = /<script type="application\/json" id="ordinate-page">([\s\S]*?)<\/script>/.exec(html);
  return m ? JSON.parse(m[1]) : null;
}

// Region figures that never coincide, so a leaked one is recognisable anywhere: West's amounts end in 7.
const REGIONS: Array<[string, number]> = [['North', 1000], ['South', 2000], ['East', 3000], ['West', 4007]];
const CHANNEL: Record<string, string[]> = { North: ['Web', 'Store'], South: ['Web', 'Store'], East: ['Web', 'Store'], West: ['Partner'] };

async function seed(projectId: string) {
  return context.runInContext(ALICE, 'seed', async () => {
    const rows: Array<[string, string, string, number]> = [];
    for (let m = 1; m <= 6; m++) {
      for (const [r, base] of REGIONS) for (const [i, ch] of CHANNEL[r].entries()) rows.push([r, ch, `2025-0${m}-15`, base + m * 10 + i]);
    }
    const orders = await datasets.saveDataset(projectId, {
      name: 'Orders', sourceKind: 'csv',
      columns: [{ name: 'region', type: 'text' }, { name: 'channel', type: 'text' }, { name: 'day', type: 'date' }, { name: 'amount', type: 'number' }],
      rows,
    });
    const targets = await datasets.saveDataset(projectId, {
      name: 'Targets', sourceKind: 'csv',
      columns: [{ name: 'team', type: 'text' }, { name: 'target', type: 'number' }],
      rows: [['Alpha', 91], ['Beta', 92]],
    });
    if (!orders || !targets) throw new Error('seed datasets');
    const enc = (category: string, column: string, aggregation: string, extra: object = {}) => ({ category, values: [{ column, aggregation }], ...extra });
    const byRegion = await visuals.saveVisual(projectId, { name: 'Sales by region', datasetId: orders.id, chartType: 'bar', encoding: enc('region', 'amount', 'sum'), filters: [] } as never);
    const byChannel = await visuals.saveVisual(projectId, { name: 'Sales by channel', datasetId: orders.id, chartType: 'pie', encoding: enc('channel', 'amount', 'sum'), filters: [] } as never);
    const byMonth = await visuals.saveVisual(projectId, { name: 'Monthly', datasetId: orders.id, chartType: 'line', encoding: enc('day', 'amount', 'avg', { grain: 'month' }), filters: [] } as never);
    const table = await visuals.saveVisual(projectId, { name: 'Detail', datasetId: orders.id, chartType: 'table', encoding: { category: 'region', series: 'channel', values: [{ column: 'amount', aggregation: 'max' }] }, filters: [] } as never);
    const teams = await visuals.saveVisual(projectId, { name: 'Targets by team', datasetId: targets.id, chartType: 'bar', encoding: enc('team', 'target', 'sum'), filters: [] } as never);
    const revenue = await metrics.saveMetric(projectId, { name: 'Revenue', datasetId: orders.id, definition: { column: 'amount', aggregation: 'sum' }, format: { kind: 'number', decimals: 0 } } as never);
    const ratio = await metrics.saveMetric(projectId, { name: 'Ratio', datasetId: orders.id, definition: { formula: '[Revenue] / 2' }, format: { kind: 'number', decimals: 0 } } as never);
    // Metric trees (docs/metric-tree): a plain metric split by channel may be drawn under the lock; a tree
    // with a formula in it, or over a dataset without the locked column, is refused.
    const amount = await metrics.saveMetric(projectId, { name: 'Amount', datasetId: orders.id, definition: { column: 'amount', aggregation: 'sum' }, format: { kind: 'number', decimals: 0 }, tree: { split: 'channel' } } as never);
    const ratioTree = ratio ? await metrics.updateMetric(projectId, ratio.id, { tree: { split: 'channel' } }) : null;
    const targetTree = await metrics.saveMetric(projectId, { name: 'Target total', datasetId: targets.id, definition: { column: 'target', aggregation: 'sum' }, format: { kind: 'number', decimals: 0 }, tree: { split: 'team' } } as never);
    if (!amount?.tree || !ratioTree?.tree || !targetTree?.tree) throw new Error('seed trees');
    if (!byRegion || !byChannel || !byMonth || !table || !teams || !revenue) throw new Error('seed visuals');
    let x = 0;
    const card = (type: string, extra: object) => ({ id: crypto.randomUUID(), type, layout: { x: (x++ % 4) * 3, y: Math.floor(x / 4) * 4, w: 3, h: 4 }, ...extra });
    const control = (label: string, datasetId: string, column: string) => card('control', { control: { kind: 'dropdown', label, datasetId, column } });
    const cards = {
      region: control('Region', orders.id, 'region'),
      channel: control('Channel', orders.id, 'channel'),
      team: control('Team', targets.id, 'team'),
      vRegion: card('visual', { visualId: byRegion.id }),
      vChannel: card('visual', { visualId: byChannel.id }),
      vMonth: card('visual', { visualId: byMonth.id }),
      vTable: card('visual', { visualId: table.id }),
      vTeams: card('visual', { visualId: teams.id }),
      kSum: card('metric', { metric: { datasetId: orders.id, column: 'amount', aggregation: 'sum', label: 'Total' } }),
      kRevenue: card('metric', { metric: { datasetId: orders.id, column: 'amount', aggregation: 'sum', metricId: revenue.id } }),
      kRatio: card('metric', { metric: { datasetId: orders.id, column: 'amount', aggregation: 'sum', metricId: ratio?.id ?? crypto.randomUUID(), label: 'Ratio' } }),
      kTarget: card('metric', { metric: { datasetId: targets.id, column: 'target', aggregation: 'sum', label: 'Target' } }),
      stats: card('stats', { stats: { kind: 'distribution', datasetId: orders.id, columns: ['amount'], view: 'table' } }),
      statsTeams: card('stats', { stats: { kind: 'distribution', datasetId: targets.id, columns: ['target'], view: 'table' } }),
      summary: card('summary', {}),
      tAmount: card('metricTree', { metricTree: { metricId: amount.id } }),
      tRatio: card('metricTree', { metricTree: { metricId: ratioTree.id } }),
      tTarget: card('metricTree', { metricTree: { metricId: targetTree.id } }),
      text: card('text', { heading: 'Notes', text: 'Figures by region.' }),
    };
    const a = await analysis.saveAnalysis(projectId, { name: 'Customer board', sheets: [{ name: 'Overview', cards: Object.values(cards) }] });
    if (!a) throw new Error('seed analysis');
    return { orders: orders.id, targets: targets.id, aid: a.id, cards, formulaMetric: !!ratio };
  });
}

async function main(): Promise<void> {
  context.enterServerMode(DATA);
  appMod.registerHandlers();
  const app = appMod.buildApp(envMod.parseEnv({ AUTH_MODE: 'dev', LOG_LEVEL: 'silent', DATA_DIR: DATA, ORDINATE_ENV: 'dev' }), undefined, () => ALICE);
  await app.listen({ port: 0, host: '127.0.0.1' });
  const base = `http://127.0.0.1:${(app.server.address() as import('net').AddressInfo).port}`;
  const call = async (channel: string, payload?: unknown) => {
    const res = await fetch(`${base}/api/rpc/${channel}`, { method: 'POST', headers: withCsrf({ 'content-type': 'application/json' }), body: wire.encode({ args: payload === undefined ? [] : [payload] }) });
    return wire.decode(await res.text()) as any; // any: each channel's own reply
  };
  try {
    const created = await call('projects:create', { name: 'Embeds' });
    const pid: string = created.id;
    ok('project created', typeof pid === 'string', show(created));
    const s = await seed(pid);
    const run = await call('publish:run', { projectId: pid, dashboardIds: [s.aid] });
    ok('published', run.ok === true, show(run));
    const site = run.site as import('../src/publish/hosted').HostedSite;

    const inOrg = <T>(fn: () => Promise<T>) => context.runAsPublished(ALICE, 'embed-test', () => recordFs.withReadMemo(fn));
    const defs = await inOrg(() => hosted.getDefs(site.id));
    ok('definition: the publish kept the dashboard and its visuals', !!defs && !!defs[s.aid] && Object.keys(defs[s.aid].visuals).length === 5, show(defs && Object.keys(defs)));
    const def = defs![s.aid];
    const lock = lockMod.makeLock({ region: ['East'] });
    const outgoing = undefined;
    const locked = await inOrg(() => dd.buildDashboard(pid, s.aid, 64, {}, outgoing, { def, lock }));
    const unlocked = await inOrg(() => dd.buildDashboard(pid, s.aid, 64, {}, outgoing, { def }));
    const eastStep = { type: 'filter' as const, column: 'region', op: '=' as const, value: 'East' };
    const reference = await inOrg(() => dd.buildDashboard(pid, s.aid, 64, {}, outgoing, { def: { ...def, analysis: { ...def.analysis, filters: [eastStep] } } }));
    if (!locked || !unlocked || !reference) throw new Error('builds');
    const tile = (d: typeof locked, id: string) => d.sheets[0].cards.find((c) => c.id === id)!;
    const C = s.cards;

    // ── Options ─────────────────────────────────────────────────────────
    const opts = (d: typeof locked, label: string) => d.controls.find((c) => c.label === label)?.options;
    ok('options: the locked column offers its locked value only', same(opts(locked, 'Region'), ['All', 'East']), show(opts(locked, 'Region')));
    ok('options: a text column offers only the values inside the lock — not West\'s Partner', same([...(opts(locked, 'Channel') ?? [])].sort(), ['All', 'Store', 'Web']), show(opts(locked, 'Channel')));
    ok('options: NEGATIVE CONTROL — unlocked, the same control lists Partner', (opts(unlocked, 'Channel') ?? []).includes('Partner'));
    ok('options: a control over a dataset without the locked column is left out', opts(locked, 'Team') === undefined && opts(unlocked, 'Team') !== undefined);

    // ── Fail closed ─────────────────────────────────────────────────────
    const refused = (d: typeof locked, id: string) => tile(d, id).kind === 'broken' && (tile(d, id) as { reason?: string }).reason === say.embedTileLocked();
    for (const [label, id] of [['a chart over Targets', C.vTeams.id], ['a KPI over Targets', C.kTarget.id], ['a statistics tile over Targets', C.statsTeams.id], ['the Summary card', C.summary.id]] as const) {
      ok(`fail closed: ${label} is refused under the lock`, refused(locked, id), show(tile(locked, id)));
      ok(`fail closed: NEGATIVE CONTROL — unlocked, ${label} is drawn`, !refused(unlocked, id), show(tile(unlocked, id)));
    }
    if (s.formulaMetric) ok('fail closed: a KPI over a formula metric is refused under the lock', refused(locked, C.kRatio.id), show(tile(locked, C.kRatio.id)));
    for (const [label, id] of [['a metric tree with a formula in it', C.tRatio.id], ['a metric tree over Targets', C.tTarget.id]] as const) {
      ok(`fail closed: ${label} is refused under the lock`, refused(locked, id), show(tile(locked, id)));
      ok(`fail closed: NEGATIVE CONTROL — unlocked, ${label} is drawn`, !refused(unlocked, id), show(tile(unlocked, id)));
    }
    const treeRows = (d: typeof locked) => (tile(d, C.tAmount.id).payloads[tile(d, C.tAmount.id).variants[0]] as { labels?: string[] }).labels ?? [];
    ok('metric tree: a plain metric\'s tree is drawn under the lock, its segments only the lock\'s channels',
      !refused(locked, C.tAmount.id) && same(treeRows(locked).slice(1).sort(), ['↳ Store', '↳ Web']), show(treeRows(locked)));
    ok('metric tree: NEGATIVE CONTROL — unlocked, West\'s Partner is a segment', treeRows(unlocked).includes('↳ Partner'), show(treeRows(unlocked)));

    // ── Differential: every tile, every combination the embed carries ──
    const labelsOf = (d: typeof locked, key: string) => key === '' ? [] : key.split('.').map((n, i) => d.controls[i].label + '=' + d.controls[i].options[Number(n)]);
    const refKeyOf = new Map(reference.keys.map((k) => [labelsOf(reference, k).filter((l) => !l.startsWith('Team=')).join('|'), k]));
    let compared = 0;
    let mismatches: string[] = [];
    for (const [ki, key] of locked.keys.entries()) {
      const want = labelsOf(locked, key).join('|');
      const rk = refKeyOf.get(want);
      if (rk === undefined) { mismatches.push(`no reference combination for ${want}`); continue; }
      const ri = reference.keys.indexOf(rk);
      for (const id of [C.vRegion.id, C.vChannel.id, C.vMonth.id, C.vTable.id, C.kSum.id, C.kRevenue.id, C.stats.id, C.tAmount.id]) {
        const a = tile(locked, id);
        const b = tile(reference, id);
        compared++;
        if (!same(a.payloads[a.variants[ki]], b.payloads[b.variants[ri]])) mismatches.push(`${id} @ ${want}: ${show(a.payloads[a.variants[ki]])} vs ${show(b.payloads[b.variants[ri]])}`);
      }
    }
    ok(`differential: ${compared} tile answers under the lock equal the dashboard filtered to East (Object.is)`, compared >= 6 * 8 && mismatches.length === 0, mismatches.slice(0, 3).join(' ; '));
    const total = (d: typeof locked) => (tile(d, C.kSum.id).payloads[tile(d, C.kSum.id).variants[0]] as { value: number }).value;
    const east = REGIONS.filter(([r]) => r === 'East').reduce((n, [, b]) => n + [1, 2, 3, 4, 5, 6].reduce((m, mo) => m + CHANNEL.East.reduce((k, _c, i) => k + b + mo * 10 + i, 0), 0), 0);
    ok('the KPI under the lock is East\'s total', Object.is(total(locked), east), `${total(locked)} vs ${east}`);
    ok('NEGATIVE CONTROL: the unlocked KPI is not', total(unlocked) > east);
    ok('the lock steps are context filters, first in every scope', lock !== null && lock.steps.every((st) => st.context === true) && lock.steps[0].column === 'region');

    // ── No leak: the whole page ─────────────────────────────────────────
    const claims = { pub: site.id, dash: s.aid, exp: 0, params: { region: ['East'] }, hide: [] } as unknown as import('../src/server/embed/token').EmbedClaims;
    const page = await inOrg(() => embedPage.embedHtml(site, s.aid, claims));
    const html = 'html' in page ? page.html : '';
    const block = dataBlock(html);
    const westFigure = /\b40(1|2|3|4|5|6)\d\b/; // West's amounts: 4017 … 4067
    // A v4 UUID's third group is 4xxx, so `-4023-` in a random id matched the figure ~1.5% of runs.
    const noIds = (s: string): string => s.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '');
    ok('page: built, a dashboard page with its pinned CSP', !!block && block.kind === 'dashboard' && /script-src 'sha256-/.test(html));
    ok('no leak: no other region\'s name anywhere in the page', !/North|South|West/.test(JSON.stringify(block)), (JSON.stringify(block).match(/.{40}(North|South|West).{40}/) || [''])[0]);
    ok('no leak: no West figure, no Partner option', !westFigure.test(noIds(JSON.stringify(block))) && !JSON.stringify(block).includes('Partner'), (noIds(JSON.stringify(block)).match(/.{30}\b40[1-6]\d\b.{30}/) || [''])[0]);
    const open = await inOrg(() => embedPage.embedHtml(site, s.aid, { ...claims, params: {} }));
    const openBlock = 'html' in open ? JSON.stringify(dataBlock(open.html)) : '';
    ok('no leak: NEGATIVE CONTROL — the unlocked embed has them', /West/.test(openBlock) && openBlock.includes('Partner') && westFigure.test(noIds(openBlock)));
    ok('page: the embed has no site header to link out of (nav empty), and says it is embedded', Array.isArray(block.site.nav) && block.site.nav.length === 0 && block.embed && block.embed.hideTitle === false);
    const dark = await inOrg(() => embedPage.embedHtml(site, s.aid, { ...claims, theme: 'dark', hide: ['title', 'filters'] }));
    const darkBlock = 'html' in dark ? dataBlock(dark.html) : null;
    ok('page: theme and hide claims reach the page (the dark theme, both switches)', !!darkBlock && darkBlock.dashboard.style.theme === 'dark' && darkBlock.embed.hideTitle === true && darkBlock.embed.hideFilters === true && /dash-theme--dark/.test('html' in dark ? dark.html : ''));

    // ── The published definition, not the editable one ─────────────────
    await context.runInContext(ALICE, 'edit', async () => {
      const a = await analysis.getAnalysis(pid, s.aid);
      const extra = { id: crypto.randomUUID(), type: 'text', layout: { x: 0, y: 40, w: 3, h: 2 }, heading: 'Draft tile', text: 'Not published yet' };
      await analysis.updateAnalysis(pid, s.aid, { sheets: [{ ...a!.sheets[0], cards: [...a!.sheets[0].cards, extra] }] } as never);
    });
    embedPage.clearEmbedCache();
    const after = await inOrg(() => embedPage.embedHtml(site, s.aid, claims));
    ok('definition: a tile added after publishing is not embedded', 'html' in after && !after.html.includes('Draft tile'));
    const live = await inOrg(() => dd.buildDashboard(pid, s.aid, 1, {}, undefined, { defaultOnly: true }));
    ok('definition: NEGATIVE CONTROL — the editable dashboard has it', !!live && JSON.stringify(live).includes('Draft tile'));
    await inOrg(async () => { await recordFs.rm(path.join(require('../src/app/paths').userData(), 'published', site.id, 'defs.json'), { force: true }); });
    embedPage.clearEmbedCache();
    const old = await inOrg(() => embedPage.embedHtml(site, s.aid, claims));
    ok('definition: a link published before definitions were kept asks to be published again', 'missing' in old && old.missing === 'republish');

    // ── Stored cross-row values: computed over every customer before any filter ──
    const ledger = await context.runInContext(ALICE, 'ledger', async () => {
      const d = await datasets.saveDataset(pid, { name: 'Ledger', sourceKind: 'csv', columns: [{ name: 'region', type: 'text' }, { name: 'amount', type: 'number' }], rows: REGIONS.map(([r, b]) => [r, b]) });
      return d!.id;
    });
    const coveredWith = async (steps: unknown[]) => {
      await context.runInContext(ALICE, 'steps', () => datasets.updateSteps(pid, ledger, steps));
      return inOrg(() => lockMod.makeLock({ region: ['East'] })!.covers(pid, ledger));
    };
    ok('cross-row: a dataset with no prepare steps is covered (control)', await coveredWith([]));
    ok('cross-row: a running total over every region is NOT covered — its East rows carry other regions\' sums',
      !(await coveredWith([{ type: 'window', fn: 'running_sum', as: 'cum', column: 'amount' }])));
    ok('cross-row: the same window partitioned by the locked column is covered (NEGATIVE CONTROL of the rule)',
      await coveredWith([{ type: 'window', fn: 'running_sum', as: 'cum', column: 'amount', partitionBy: ['region'] }]));
    ok('cross-row: a stored LOD field (a FIXED total) is NOT covered',
      !(await coveredWith([{ type: 'calculated_field', name: 'all_total', expression: '{FIXED : SUM([amount])}' }])));
    ok('cross-row: the steps really stored (the record names them)', ((await inOrg(() => datasets.getDatasetMeta(pid, ledger)))?.steps ?? []).length === 1);

    // ── No widening before anything is built ────────────────────────────
    let threw = 0;
    try { lockMod.makeLock({ region: [] }); } catch { threw++; }
    try { lockMod.makeLock({ region: ['[[p]]'] }); } catch { threw++; }
    ok('no widening: an empty lock and a lock naming a parameter are refused', threw === 2);
    ok('no lock: an empty params object is no lock at all', lockMod.makeLock({}) === null);
  } finally {
    await app.close();
  }
}

main().then(finish, (err) => {
  console.error(err);
  ok('suite ran', false, err instanceof Error ? err.stack : String(err));
  finish();
});
