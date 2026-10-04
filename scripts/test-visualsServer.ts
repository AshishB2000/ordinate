// Self-check for the Visuals screen's server channels (T2.7) — REAL HTTP,
// server mode, no Electron:
//
//   visual:list/get/save/update/duplicate/delete   the store's own answers, in
//                   its order (favourites first); a write is validated at the
//                   door and again by the store's whitelists
//   visual:thumbs   DIFFERENTIAL: each thumbnail is exactly what `visual:data`
//                   answers for that visual's stored encoding + filters
//                   (Object.is at every figure); a missing id is a per-item
//                   refusal; > 50 ids is a 400
//   visual:preview  on a small table it IS `visual:data` (Object.is)
//   visual:data     `share: 'export'` is accepted (Copy data)
//   visual:suggest  no model → { notReady }, never a 500
//   boundary:*      list; import by an UPLOADED file token (single use)
//   relationship:related   reachable (the builder's "From …" groups)
//   scope           another org's caller is refused every channel (403)
//
//   npm run build:ts && node scripts/test-visualsServer.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import { withCsrf } from './csrfPair';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');
const Module: any = require('module'); // any: Module._load's own signature

const origLoad = Module._load;
Module._load = function (request: string, ...rest: any[]): any { // any: Module._load's own signature
  if (request === 'electron') throw new Error('electron is not available in server mode');
  return origLoad.apply(this, [request, ...rest]);
};

const context: typeof import('../src/server/context') = require('../src/server/context');
const appMod: typeof import('../src/server/app') = require('../src/server/app');
const envMod: typeof import('../src/server/env') = require('../src/server/env');
const wire: typeof import('../src/server/wire') = require('../src/server/wire');

type Identity = import('../src/server/context').Identity;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-visuals-'));
const who = (org: string): Identity => ({ user: { email: `u@${org}`, role: 'admin' }, org: { id: org } });

/** Deep equality with Object.is at the leaves (NaN, -0 and a null-vs-0 all count). */
function same(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || !a || !b || Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a as object);
  const kb = Object.keys(b as object);
  return ka.length === kb.length && ka.every((k) => same((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

(async () => {
  context.enterServerMode(DATA);
  appMod.registerHandlers();
  const app = appMod.buildApp(envMod.parseEnv({ LOG_LEVEL: 'silent', DATA_DIR: DATA }), undefined, (h) =>
    typeof h['x-test-org'] === 'string' ? who(h['x-test-org']) : null);
  await app.listen({ port: 0, host: '127.0.0.1' });
  const base = `http://127.0.0.1:${(app.server.address() as import('net').AddressInfo).port}`;
  const hdr = (org: string) => withCsrf({ 'x-test-org': org });
  const call = async (org: string, channel: string, payload: unknown) => {
    const res = await fetch(`${base}/api/rpc/${channel}`, {
      method: 'POST', body: wire.encode({ args: [payload] }), headers: { 'content-type': 'application/json', ...hdr(org) },
    });
    const text = await res.text();
    return { status: res.status, body: (res.status === 200 ? wire.decode(text) : text) as any }; // any: each channel's own reply
  };
  const upload = async (org: string, name: string, body: string) => {
    const form = new FormData();
    form.append('file', new Blob([body], { type: 'application/geo+json' }), name);
    const res = await fetch(`${base}/api/files`, { method: 'POST', body: form, headers: hdr(org) });
    return (await res.json()) as { fileToken: string };
  };

  const projects: typeof import('../src/app/projects') = require('../src/app/projects');
  const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
  const visuals: typeof import('../src/analysis/visuals') = require('../src/analysis/visuals');

  const seed = await context.runInContext(who('org-a'), 'seed', async () => {
    const p = await projects.createProject('Visuals project');
    const regions = ['North', 'South', 'East', 'West'];
    const ds = await datasets.saveDataset(p.id, {
      name: 'Orders', sourceKind: 'csv',
      columns: [{ name: 'region', type: 'text' }, { name: 'month', type: 'date' }, { name: 'amount', type: 'number' }, { name: 'zip', type: 'text' }],
      rows: Array.from({ length: 120 }, (_, i) => [regions[i % 4], `2025-${String(1 + (i % 12)).padStart(2, '0')}-01`, i % 7 === 0 ? null : i * 1.25 - 20, String(i).padStart(5, '0')]),
    });
    if (!ds) throw new Error('dataset not saved');
    const v = async (name: string, chartType: string, encoding: unknown, filters: unknown[] = []) => {
      const saved = await visuals.saveVisual(p.id, { name, datasetId: ds.id, chartType, encoding, filters });
      if (!saved) throw new Error('visual not saved');
      return saved.id;
    };
    const ids = [
      await v('Amount by region', 'column', { category: 'region', values: [{ column: 'amount', aggregation: 'sum' }] }),
      await v('Avg by month', 'line', { category: 'month', values: [{ column: 'amount', aggregation: 'avg' }], grain: 'month' }),
      await v('Filtered count', 'bar', { category: 'region', values: [{ column: 'zip', aggregation: 'count' }] }, [{ type: 'filter', column: 'region', op: 'in', values: ['North', 'East'] }]),
    ];
    return { pid: p.id, dsid: ds.id, ids };
  });
  const { pid, dsid, ids } = seed;

  // ── list / get ─────────────────────────────────────────────────────────────
  const list = await call('org-a', 'visual:list', { projectId: pid });
  const direct = await context.runInContext(who('org-a'), 'd', () => visuals.listVisuals(pid));
  ok('visual:list: the store\'s list, in its order', list.status === 200 && same(list.body, direct), JSON.stringify(list.body));
  const got = await call('org-a', 'visual:get', { projectId: pid, id: ids[2] });
  ok('visual:get: the whole record (encoding, filters, overrides)', got.status === 200 && got.body.id === ids[2]
    && got.body.encoding.category === 'region' && got.body.filters.length === 1 && typeof got.body.overrides === 'object', JSON.stringify(got.body));
  ok('visual:get: an unknown id is null', (await call('org-a', 'visual:get', { projectId: pid, id: '00000000-0000-4000-8000-000000000000' })).body === null);
  ok('visual:get: a non-UUID id is a 400', (await call('org-a', 'visual:get', { projectId: pid, id: '../x' })).status === 400);

  // ── thumbs: differential against visual:data on the stored definition ────────
  const thumbs = await call('org-a', 'visual:thumbs', { projectId: pid, ids });
  ok('visual:thumbs: one answer per id, in order', thumbs.status === 200 && thumbs.body.length === 3 && thumbs.body.every((t: any, i: number) => t.id === ids[i]), JSON.stringify(thumbs.body).slice(0, 300)); // any: a reply item
  for (let i = 0; i < ids.length; i++) {
    const rec = (await call('org-a', 'visual:get', { projectId: pid, id: ids[i] })).body;
    const ref = await call('org-a', 'visual:data', { projectId: pid, datasetId: dsid, encoding: rec.encoding, filters: rec.filters });
    const t = thumbs.body[i];
    ok(`visual:thumbs[${i}]: Object.is-equal to visual:data on the stored encoding + filters`, ref.body.ok === true && t.ok === true
      && same(t.data, ref.body.data) && t.recommendedShape === ref.body.recommendedShape, JSON.stringify({ t: t.data, ref: ref.body.data }).slice(0, 400));
    ok(`visual:thumbs[${i}]: carries the chart type and the stored overrides`, t.chartType === rec.chartType && same(t.overrides, rec.overrides));
  }
  const filtered = thumbs.body[2].data;
  ok('the stored filter really applied (only North and East counted)', same(filtered.labels, ['East', 'North']) || same(filtered.labels, ['North', 'East']), JSON.stringify(filtered.labels));
  const ghost = await call('org-a', 'visual:thumbs', { projectId: pid, ids: [ids[0], '00000000-0000-4000-8000-000000000000'] });
  ok('visual:thumbs: a missing visual is a per-item refusal, the rest still answer', ghost.body[0].ok === true && ghost.body[1].ok === false && /no longer exists/.test(ghost.body[1].error));
  ok('visual:thumbs: more than 50 ids is a 400', (await call('org-a', 'visual:thumbs', { projectId: pid, ids: Array(51).fill(ids[0]) })).status === 400);
  ok('visual:thumbs: no ids is a 400', (await call('org-a', 'visual:thumbs', { projectId: pid, ids: [] })).status === 400);

  // ── preview / data ────────────────────────────────────────────────────────────
  const enc = { category: 'region', values: [{ column: 'amount', aggregation: 'max' }, { column: 'amount', aggregation: 'min' }] };
  const pv = await call('org-a', 'visual:preview', { projectId: pid, datasetId: dsid, encoding: enc, filters: [] });
  const dv = await call('org-a', 'visual:data', { projectId: pid, datasetId: dsid, encoding: enc, filters: [] });
  ok('visual:preview on a small table IS visual:data (no sample)', pv.body.ok && same(pv.body.data, dv.body.data) && pv.body.sample === undefined, JSON.stringify(pv.body).slice(0, 300));
  const exp = await call('org-a', 'visual:data', { projectId: pid, datasetId: dsid, encoding: enc, share: 'export' });
  ok('visual:data takes share: "export" (Copy data) — with no Share policy, the same figures', exp.status === 200 && same(exp.body.data, dv.body.data));
  ok('visual:data refuses any other share path (400)', (await call('org-a', 'visual:data', { projectId: pid, datasetId: dsid, encoding: enc, share: 'publish' })).status === 400);

  // ── save / update / duplicate / delete ─────────────────────────────────────────
  const saved = await call('org-a', 'visual:save', { projectId: pid, datasetId: dsid, name: '  New one  ', chartType: 'pie', encoding: enc, overrides: { title: 'T', bogus: 1 }, filters: [] });
  ok('visual:save: stored, name trimmed, unknown override keys dropped by the whitelist', saved.status === 200 && saved.body.name === 'New one'
    && saved.body.chartType === 'pie' && saved.body.overrides.title === 'T' && !('bogus' in saved.body.overrides), JSON.stringify(saved.body));
  ok('visual:save: an empty chart type is a 400', (await call('org-a', 'visual:save', { projectId: pid, datasetId: dsid, name: 'x', chartType: '', encoding: enc })).status === 400);
  ok('visual:save: an unknown aggregation is a 400', (await call('org-a', 'visual:save', { projectId: pid, datasetId: dsid, name: 'x', chartType: 'bar', encoding: { category: 'region', values: [{ column: 'amount', aggregation: 'median' }] } })).status === 400);
  const noDs = await call('org-a', 'visual:save', { projectId: pid, datasetId: '00000000-0000-4000-8000-000000000000', name: 'x', chartType: 'bar', encoding: enc });
  ok('visual:save: a dataset the project does not have is refused', noDs.status === 200 && noDs.body.ok === false, JSON.stringify(noDs.body));
  const fav = await call('org-a', 'visual:update', { projectId: pid, id: ids[2], favorite: true });
  ok('visual:update: the star alone', fav.body.ok === true && fav.body.visual.favorite === true && fav.body.visual.name === 'Filtered count');
  const after = (await call('org-a', 'visual:list', { projectId: pid })).body;
  ok('the favourite lists first', after[0].id === ids[2] && after.length === 4, JSON.stringify(after.map((v: any) => v.name))); // any: a summary
  const ren = await call('org-a', 'visual:update', { projectId: pid, id: ids[0], name: 'Renamed', overrides: { valueMode: 'all', color: '#4f7cd4' } });
  ok('visual:update: name and overrides', ren.body.visual.name === 'Renamed' && ren.body.visual.overrides.valueMode === 'all' && ren.body.visual.encoding.category === 'region');
  const dup = await call('org-a', 'visual:duplicate', { projectId: pid, id: ids[0] });
  ok('visual:duplicate: an unpinned copy named "(copy)"', dup.body.ok === true && dup.body.visual.name === 'Renamed (copy)' && dup.body.visual.id !== ids[0] && dup.body.visual.favorite === false);
  const del = await call('org-a', 'visual:delete', { projectId: pid, id: dup.body.visual.id });
  const afterDel = (await call('org-a', 'visual:list', { projectId: pid })).body;
  ok('visual:delete: to the Trash, gone from the gallery', del.status === 200 && del.body.ok !== false && !afterDel.some((v: any) => v.id === dup.body.visual.id), JSON.stringify(del.body)); // any: a summary
  ok('visual:delete: the desktop\'s `permanent` is not accepted (400)', (await call('org-a', 'visual:delete', { projectId: pid, id: ids[1], permanent: true })).status === 400);

  // ── suggest (no model configured) ────────────────────────────────────────────
  const sug = await call('org-a', 'visual:suggest', { projectId: pid, datasetId: dsid, intent: 'amount by region' });
  ok('visual:suggest with no model: { notReady }, not a 500', sug.status === 200 && sug.body.ok === false && sug.body.notReady === true, JSON.stringify(sug.body));
  ok('visual:suggest: an intent over 2,000 characters is a 400', (await call('org-a', 'visual:suggest', { projectId: pid, datasetId: dsid, intent: 'x'.repeat(2001) })).status === 400);

  // ── boundaries ─────────────────────────────────────────────────────────────────
  ok('boundary:list: none yet', same((await call('org-a', 'boundary:list', { projectId: pid })).body, { ok: true, boundaries: [] }));
  const geojson = JSON.stringify({
    type: 'FeatureCollection',
    features: ['North', 'South'].map((n, i) => ({
      type: 'Feature', properties: { name: n, code: i },
      geometry: { type: 'Polygon', coordinates: [[[i, 0], [i + 1, 0], [i + 1, 1], [i, 1], [i, 0]]] },
    })),
  });
  const tok = await upload('org-a', 'regions.geojson', geojson);
  const imp = await call('org-a', 'boundary:import', { projectId: pid, fileToken: tok.fileToken });
  ok('boundary:import: the uploaded GeoJSON becomes a boundary set', imp.body.ok === true && imp.body.boundary.featureCount === 2, JSON.stringify(imp.body));
  const listed = (await call('org-a', 'boundary:list', { projectId: pid })).body;
  ok('boundary:list: now lists it', listed.boundaries.length === 1 && listed.boundaries[0].id === imp.body.boundary.id);
  const again = await call('org-a', 'boundary:import', { projectId: pid, fileToken: tok.fileToken });
  ok('boundary:import: the token is single-use', again.body.ok === false, JSON.stringify(again.body));
  ok('boundary:import: a malformed token is a 400', (await call('org-a', 'boundary:import', { projectId: pid, fileToken: '../../etc' })).status === 400);

  // ── related columns ─────────────────────────────────────────────────────────────
  const rel = await call('org-a', 'relationship:related', { projectId: pid, datasetId: dsid });
  ok('relationship:related: reachable, no relationships → no groups', rel.status === 200 && same(rel.body, { ok: true, groups: [] }), JSON.stringify(rel.body));

  // ── drill: the rows behind a figure, and the same set as a download ───────────
  const whole = await call('org-a', 'visual:rows', { projectId: pid, datasetId: dsid, encoding: enc, filters: [], page: { offset: 0, limit: 500 } });
  ok('visual:rows: the whole visual is every row, with the dataset\'s columns', whole.body.ok && whole.body.available && whole.body.total === 120
    && whole.body.columns.length === 4 && whole.body.rows.length === 120, JSON.stringify(whole.body).slice(0, 200));
  const north = await call('org-a', 'visual:rows', { projectId: pid, datasetId: dsid, encoding: enc, filters: [], mark: { category: 'North' }, page: { offset: 0, limit: 5, sortColumn: 'zip', sortDir: 'desc' } });
  ok('visual:rows: a clicked mark is exactly its category\'s rows (30), paged and sorted in SQL', north.body.total === 30 && north.body.rows.length === 5
    && north.body.rows.every((r: unknown[]) => r[0] === 'North') && north.body.rows[0][3] === '00116', JSON.stringify(north.body).slice(0, 300));
  ok('visual:rows: the mark becomes a chip-able filter step', north.body.filters.some((f: any) => f.column === 'region')); // any: a step
  ok('visual:rows: a page over 5,000 is a 400', (await call('org-a', 'visual:rows', { projectId: pid, datasetId: dsid, encoding: enc, page: { limit: 5001 } })).status === 400);
  const dl = await call('org-a', 'visual:rowsDownload', { projectId: pid, datasetId: dsid, encoding: enc, mark: { category: 'North' }, name: 'Amount / North' });
  ok('visual:rowsDownload: a single-use download token, and the row count', dl.body.ok === true && /^[A-Za-z0-9_-]{43}$/.test(dl.body.downloadToken) && dl.body.rows === 30, JSON.stringify(dl.body));
  const file = await fetch(`${base}/api/files/${dl.body.downloadToken}`, { headers: hdr('org-a') });
  const csv = await file.text();
  ok('the file is the drilled set as CSV: a header, then 30 rows, all North', file.status === 200 && csv.split('\r\n').filter(Boolean).length === 31
    && csv.startsWith('region,month,amount,zip') && /filename="amount-north\.csv"/.test(file.headers.get('content-disposition') || ''), csv.slice(0, 120));
  ok('…and the token is single-use', (await fetch(`${base}/api/files/${dl.body.downloadToken}`, { headers: hdr('org-a') })).status === 404);

  // ── period picker: the presets' names and a spec's dates, both the server's ──────
  const dateIntel: typeof import('../src/analysis/dateIntel') = require('../src/analysis/dateIntel');
  const pk = await call('org-a', 'period:picker', { spec: { preset: 'last_n_days', n: 30 } });
  const allNamed = pk.body.groups.flatMap((g: any) => g.items).every((it: any) => it.label === dateIntel.describePeriod(it.spec, dateIntel.getCalendar())); // any: picker rows
  ok('period:picker: every preset named by dateIntel.describePeriod', pk.status === 200 && pk.body.groups.length === 3 && allNamed, JSON.stringify(pk.body).slice(0, 300));
  const r30 = dateIntel.resolvePeriodNow({ preset: 'last_n_days', n: 30 })!;
  ok('period:picker: the spec resolved today, with its range text', pk.body.current.label === 'Last 30 days' && pk.body.current.from === r30.from && pk.body.current.to === r30.to
    && typeof pk.body.current.range === 'string' && pk.body.current.range.length > 0, JSON.stringify(pk.body.current));
  ok('period:picker: no spec, no `current`', (await call('org-a', 'period:picker', {})).body.current === undefined);

  // ── distinct values (the filter dialog's list), searched in SQL ──────────────────
  const dist = await call('org-a', 'dataset:distinct', { projectId: pid, datasetId: dsid, column: 'region', limit: 200 });
  ok('dataset:distinct: the column\'s distinct values and their total', dist.status === 200 && dist.body.total === 4 && dist.body.values.length === 4, JSON.stringify(dist.body));
  const ds2 = await call('org-a', 'dataset:distinct', { projectId: pid, datasetId: dsid, column: 'region', limit: 200, search: 'or' });
  ok('dataset:distinct: a search narrows on the server', same(ds2.body.values, ['North']), JSON.stringify(ds2.body));

  // ── the project's colour map ───────────────────────────────────────────────────
  const dealt = await call('org-a', 'format:colors:assign', { projectId: pid, column: 'region', values: ['West', 'East'] });
  ok('format:colors:assign: values dealt the first free slots, stored', dealt.body.changed === true && dealt.body.colors.West === 'chart-1' && dealt.body.colors.East === 'chart-2', JSON.stringify(dealt.body));
  const set = await call('org-a', 'format:colors:set', { projectId: pid, column: 'region', value: 'East', token: 'chart-7' });
  ok('format:colors:set: one value moved', set.body.colors.East === 'chart-7');
  ok('format:colors:get: the stored map', same((await call('org-a', 'format:colors:get', { projectId: pid })).body, { region: { West: 'chart-1', East: 'chart-7' } }));
  ok('format:colors:set: an unknown slot is a 400', (await call('org-a', 'format:colors:set', { projectId: pid, column: 'region', value: 'East', token: 'red' })).status === 400);
  await call('org-a', 'format:colors:reset', { projectId: pid, column: 'region' });
  ok('format:colors:reset: the column forgotten', same((await call('org-a', 'format:colors:get', { projectId: pid })).body, {}));

  // ── scope: another org never reaches the project ─────────────────────────────────
  const foreign: [string, unknown][] = [
    ['visual:list', { projectId: pid }],
    ['visual:get', { projectId: pid, id: ids[0] }],
    ['visual:thumbs', { projectId: pid, ids }],
    ['visual:update', { projectId: pid, id: ids[0], favorite: false }],
    ['visual:delete', { projectId: pid, id: ids[0] }],
    ['visual:preview', { projectId: pid, datasetId: dsid, encoding: enc }],
    ['boundary:list', { projectId: pid }],
    ['visual:rows', { projectId: pid, datasetId: dsid, encoding: enc }],
    ['visual:rowsDownload', { projectId: pid, datasetId: dsid, encoding: enc }],
    ['format:colors:get', { projectId: pid }],
    ['dataset:distinct', { projectId: pid, datasetId: dsid, column: 'region' }],
  ];
  for (const [channel, payload] of foreign) ok(`${channel}: another org's caller → 403`, (await call('org-b', channel, payload)).status === 403);
  const still = (await call('org-a', 'visual:list', { projectId: pid })).body;
  ok('…and nothing changed for org-a', same(still, afterDel), JSON.stringify(still));

  await app.close();
  fs.rmSync(DATA, { recursive: true, force: true });
  finish();
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
