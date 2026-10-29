// Dashboard drafts and Publish (src/analysis/publishedCopy.ts, publishDashboard.ts)
// over the real RPC route, in server mode, as an org admin.
//
// 1. DIFFERENTIAL: right after Publish, every tile of the published copy —
//    computed through the same doors the canvas asks (`analysis:tiles` →
//    `visual:data` / vizDataFor, `dashboard:metric` / computeCardMetric) from
//    the copy's FROZEN chart definitions — is Object.is-equal to the draft's,
//    computed from the Visuals store. The frozen definition equals the stored
//    one, overlays included.
// 2. FROZEN: a chart edited in Visuals after Publish changes the draft's tile
//    and not the published copy's — its definition or its figures.
// 3. STATUS: draft → published → edited → (undo) published; a version per
//    Publish / Unpublish / Discard, the Publish one diffable to now.
// 4. DISCARD restores the copy as the draft: visual cards keep their visualId,
//    drop the frozen definition, and draw the chart as it is now — the Visuals
//    store is never written.
// 5. MIGRATION: a stored `ready: true` becomes a published copy, charts frozen,
//    once — the second read writes nothing; the edit tag does not move.
// 6. UNTRUSTED: a stored copy is sanitized like every other field; an
//    unusable one is no copy at all.
//
//   npm run build:ts && node scripts/test-dashboardDrafts.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import { withCsrf } from './csrfPair';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');

const context: typeof import('../src/server/context') = require('../src/server/context');
const poolMod: typeof import('../src/engine/duckdbPool') = require('../src/engine/duckdbPool');
const appMod: typeof import('../src/server/app') = require('../src/server/app');
const envMod: typeof import('../src/server/env') = require('../src/server/env');
const wire: typeof import('../src/server/wire') = require('../src/server/wire');
const tags: typeof import('../src/app/editConflict') = require('../src/app/editConflict');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-drafts-'));
const ADMIN: import('../src/server/context').Identity = { user: { email: 'ana@acme.test', role: 'admin' }, org: { id: 'acme' } };
const ENC = { category: 'region', values: [{ column: 'amount', aggregation: 'sum' }] };
// any: each channel's own reply
type Body = any;

/** Deep equality with Object.is at every leaf (NaN, -0 and null kept apart). */
function same(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || !a || !b || Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a as object);
  const kb = Object.keys(b as object);
  return ka.length === kb.length && ka.every((k) => same((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

/** The tiles a canvas asks for one open reply: each card through its own definition, as web/src/features/analyses does. */
function tilesOf(open: Body): unknown[] {
  const defs = new Map<string, Body>(open.visuals.map((v: Body) => [v.id, v]));
  const out: unknown[] = [];
  for (const c of open.analysis.sheets.flatMap((s: Body) => s.cards)) {
    if (c.type === 'visual') {
      const v = defs.get(c.visualId);
      if (v) out.push({ kind: 'visual', datasetId: v.datasetId, encoding: v.encoding, filters: v.filters, chartType: v.chartType, ...(v.analytics ? { analytics: v.analytics } : {}), visualId: c.visualId });
    } else if (c.type === 'metric') {
      out.push({ kind: 'metric', datasetId: c.metric.datasetId, column: c.metric.column, aggregation: c.metric.aggregation });
    }
  }
  return out;
}

void (async () => {
  context.enterServerMode(DATA);
  poolMod.routeByOrg({ dataDir: DATA, maxWorkers: 2, memoryLimit: '512MiB', threads: 2, queryTimeoutMs: 60_000, idleMs: 60_000 });
  appMod.registerHandlers();
  const projects: typeof import('../src/app/projects') = require('../src/app/projects');
  const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
  const visuals: typeof import('../src/analysis/visuals') = require('../src/analysis/visuals');
  const analysis: typeof import('../src/analysis/analysis') = require('../src/analysis/analysis');
  const recordFs: typeof import('../src/app/recordFs') = require('../src/app/recordFs');
  const as = <T>(fn: () => Promise<T>): Promise<T> => context.runInContext(ADMIN, 'test', fn);

  const s = await as(async () => {
    await projects.init();
    const P = (await projects.createProject('Drafts')).id;
    const rows: Array<[string, number]> = [];
    for (let i = 0; i < 40; i++) rows.push([['North', 'South', 'East', 'West'][i % 4], (i * 37) % 101 + 0.25]);
    const d = await datasets.saveDataset(P, { name: 'Orders', sourceKind: 'csv', columns: [{ name: 'region', type: 'text' }, { name: 'amount', type: 'number' }], rows });
    if (!d) throw new Error('seed dataset');
    const v1 = await visuals.saveVisual(P, { name: 'Sales by region', datasetId: d.id, chartType: 'bar', encoding: ENC, analytics: [{ id: crypto.randomUUID(), kind: 'reference', value: { type: 'stat', stat: 'avg' } }] } as never);
    const v2 = await visuals.saveVisual(P, { name: 'Big orders', datasetId: d.id, chartType: 'column', encoding: ENC, filters: [{ type: 'filter', column: 'amount', op: '>', value: 30 }] } as never);
    if (!v1 || !v2) throw new Error('seed visual');
    return { P, ds: d.id, v1: v1.id, v2: v2.id };
  });
  const P = s.P;
  const card = (type: string, x: number, extra: object) => ({ id: crypto.randomUUID(), type, layout: { x, y: 0, w: 3, h: 4 }, ...extra });
  const SHEETS = [{ id: crypto.randomUUID(), name: 'Overview', cards: [
    card('text', 0, { heading: 'Hello' }),
    card('visual', 3, { visualId: s.v1 }),
    card('visual', 6, { visualId: s.v2 }),
    card('visual', 9, { visualId: '00000000-0000-4000-8000-000000000000' }), // a hole, in both
    card('metric', 0, { metric: { datasetId: s.ds, column: 'amount', aggregation: 'sum', label: 'Revenue' } }),
  ] }];

  const app = appMod.buildApp(envMod.parseEnv({ AUTH_MODE: 'dev', LOG_LEVEL: 'silent', DATA_DIR: DATA }), undefined, () => ADMIN);
  const call = async (channel: string, payload: unknown): Promise<{ status: number; body: Body }> => {
    const r = await app.inject({ method: 'POST', url: `/api/rpc/${encodeURIComponent(channel)}`, headers: withCsrf({ 'content-type': 'application/json' }), payload: wire.encode({ args: [payload] }) });
    return { status: r.statusCode, body: r.statusCode === 200 ? wire.decode(r.body) : r.body };
  };
  const open = async (id: string, published = false) => (await call('analysis:open', { projectId: P, id, ...(published ? { published } : {}) })).body;
  const status = async (id: string) => ((await call('analysis:gallery', { projectId: P })).body as Body[]).find((x) => x.id === id)?.status;
  const versionsOf = async (id: string) => (await call('versions:list', { projectId: P, type: 'dashboard', id })).body as Body[];
  const tiles = async (o: Body) => (await call('analysis:tiles', { projectId: P, items: tilesOf(o) })).body as unknown[];
  const appPaths: typeof import('../src/app/paths') = require('../src/app/paths');
  const dir = await as(async () => path.join(appPaths.userData(), 'projects', P, 'analyses'));
  const stored = async (id: string) => JSON.parse(await as(() => recordFs.readFile(path.join(dir, id + '.json'), 'utf8')));

  try {
    const made = (await call('analysis:create', { projectId: P, name: 'Board', sheets: SHEETS })).body;
    const id: string = made.id;
    ok('setup: a draft', (await status(id)) === 'draft' && !('published' in (await stored(id))));

    // ── 1. Publish, and the differential ─────────────────────────────────
    const draftOpen = await open(id);
    const pub = await call('analysis:publish', { projectId: P, id, base: draftOpen.tag });
    ok('publish: published, in sync', pub.body.ok && pub.body.status === 'published' && (await status(id)) === 'published', JSON.stringify(pub.body));
    const rec = await stored(id);
    const frozen = rec.published.sheets[0].cards.filter((c: Body) => c.type === 'visual');
    ok('publish: each visual card keeps its visualId and carries its chart, frozen; a hole stays a hole', frozen.length === 3
      && frozen[0].visualId === s.v1 && frozen[0].visual?.chartType === 'bar' && frozen[1].visual?.chartType === 'column' && frozen[2].visual === undefined, JSON.stringify(frozen).slice(0, 300));
    ok('publish: the draft\'s own cards carry no frozen chart', rec.sheets[0].cards.every((c: Body) => c.visual === undefined));
    const pubOpen = await open(id, true);
    ok('open published: the copy, with the frozen definitions as its visuals (and nothing else)', pubOpen.ok && pubOpen.showing === 'published' && pubOpen.visuals.length === 2
      && pubOpen.tag === tags.contentTag('dashboard', pubOpen.analysis), JSON.stringify(pubOpen.visuals.map((v: Body) => v.id)));
    const def = (o: Body, vid: string) => { const { tag: _t, updatedAt: _u, ...rest } = o.visuals.find((v: Body) => v.id === vid); return rest; };
    ok('DIFFERENTIAL: the frozen definitions equal the stored ones — overlays included', same(def(pubOpen, s.v1), def(draftOpen, s.v1)) && same(def(pubOpen, s.v2), def(draftOpen, s.v2))
      && Array.isArray(def(pubOpen, s.v1).analytics), JSON.stringify([def(pubOpen, s.v1), def(draftOpen, s.v1)]).slice(0, 400));
    const [draftTiles, pubTiles] = [await tiles(draftOpen), await tiles(pubOpen)];
    ok('DIFFERENTIAL: every figure of the published copy right after Publish is Object.is-equal to the draft\'s (analysis:tiles)', draftTiles.length === 3 && same(draftTiles, pubTiles)
      && (draftTiles as Body[]).every((t) => t.ok !== false), JSON.stringify(pubTiles).slice(0, 300));

    // ── 2. A chart edited in Visuals after Publish ──────────────────────
    await as(() => visuals.updateVisual(P, s.v2, { chartType: 'line', filters: [{ type: 'filter', column: 'amount', op: '>', value: 60 }] }));
    const [draft2, pub2] = [await open(id), await open(id, true)];
    const [draftTiles2, pubTiles2] = [await tiles(draft2), await tiles(pub2)];
    ok('frozen: the published copy keeps the chart as published — definition and figures', def(pub2, s.v2).chartType === 'column' && same(pubTiles2, pubTiles));
    ok('NEGATIVE CONTROL: the draft draws the chart as edited', def(draft2, s.v2).chartType === 'line' && !same(draftTiles2, draftTiles));
    ok('status: a chart edited in Visuals does not make the draft differ (Discard could not undo it)', (await status(id)) === 'published');

    // ── 3. Status follows the draft's content ────────────────────────────
    const asOpened: Body[] = draftOpen.analysis.sheets; // what the editor holds: an undo puts exactly this back
    const edited = asOpened.map((sh) => ({ ...sh, cards: sh.cards.map((c: Body) => (c.type === 'text' ? { ...c, heading: 'Changed' } : c)) }));
    await call('analysis:update', { projectId: P, id, sheets: edited });
    ok('status: an edit to the draft — edits not live; the copy unchanged', (await status(id)) === 'edited'
      && (await open(id, true)).analysis.sheets[0].cards[0].heading === 'Hello');
    await call('analysis:update', { projectId: P, id, sheets: asOpened });
    ok('status: undone back to what was published — in sync again', (await status(id)) === 'published');
    const vs = await versionsOf(id);
    const published = vs.find((v) => v.event === 'published');
    ok('versions: Publish recorded one, its key the copy\'s versionKey, "Published"', !!published && published.key === rec.published.versionKey && published.summary === 'Published', JSON.stringify(vs.map((v) => [v.key, v.event, v.summary])));
    await call('analysis:update', { projectId: P, id, sheets: edited, name: 'Board v2' });
    const diff = await call('versions:diff', { projectId: P, type: 'dashboard', id, from: rec.published.versionKey, to: (await versionsOf(id))[0].key });
    ok('versions: published → now diffs with versions:diff (the "Not live yet" strip)', diff.body.ok === true && /changed|renamed|Renamed|Changed/.test(JSON.stringify(diff.body)), JSON.stringify(diff.body).slice(0, 300));

    // ── 4. Discard edits ─────────────────────────────────────────────────
    const v2Before = JSON.stringify(await as(() => visuals.getVisual(P, s.v2)));
    const dis = await call('analysis:discard', { projectId: P, id });
    const afterDiscard = await stored(id);
    ok('discard: the draft is the copy again — name, text — and in sync', dis.body.ok && dis.body.status === 'published' && dis.body.analysis.name === 'Board'
      && dis.body.analysis.sheets[0].cards[0].heading === 'Hello' && (await status(id)) === 'published' && dis.body.tag === (await open(id)).tag, JSON.stringify(dis.body).slice(0, 200));
    ok('discard: visual cards keep their visualId and drop the frozen chart (the draft points at the chart again)', afterDiscard.sheets[0].cards.filter((c: Body) => c.type === 'visual').every((c: Body) => c.visualId && c.visual === undefined));
    ok('discard: the Visuals store is never written — the draft draws the chart as it is now', JSON.stringify(await as(() => visuals.getVisual(P, s.v2))) === v2Before && def(await open(id), s.v2).chartType === 'line');
    ok('versions: Discard recorded one', (await versionsOf(id))[0].event === 'discarded');
    ok('discard NEGATIVE CONTROL: a draft never published has nothing to go back to', (await call('analysis:discard', { projectId: P, id: (await call('analysis:create', { projectId: P, name: 'Lone' })).body.id })).body.ok === false);

    // ── Unpublish ────────────────────────────────────────────────────────
    const tagBefore = (await open(id)).tag;
    const off = await call('analysis:unpublish', { projectId: P, id });
    ok('unpublish: a draft again, a version recorded, the draft and its tag untouched', off.body.ok && off.body.status === 'draft' && (await versionsOf(id))[0].event === 'unpublished'
      && (await open(id)).tag === tagBefore && !('published' in (await stored(id))));
    const n = (await versionsOf(id)).length;
    ok('unpublish: again is a no-op — no second version', (await call('analysis:unpublish', { projectId: P, id })).body.ok && (await versionsOf(id)).length === n);

    // ── 5. Migration from `ready: true` ──────────────────────────────────
    const file = dir;
    const readyId = crypto.randomUUID();
    const plainId = crypto.randomUUID();
    const legacy = (rid: string, ready: boolean) => ({ id: rid, name: ready ? 'Was ready' : 'Never ready', sheets: SHEETS, filters: [], createdAt: '2026-10-01T10:00:00.000Z', updatedAt: '2026-10-02T10:00:00.000Z', schemaVersion: 1, ...(ready ? { ready: true } : {}) });
    await as(async () => {
      await recordFs.writeFile(path.join(file, readyId + '.json'), JSON.stringify(legacy(readyId, true)), 'utf8');
      await recordFs.writeFile(path.join(file, plainId + '.json'), JSON.stringify(legacy(plainId, false)), 'utf8');
    });
    const tagOf = async (rid: string) => (await as(() => analysis.readAnalysis(P, rid)))?.tag;
    const beforeTag = tags.contentTag('dashboard', legacy(readyId, true));
    ok('migration: a Ready dashboard lists as published, by the time it was last edited', (await status(readyId)) === 'published'
      && ((await call('analysis:gallery', { projectId: P })).body as Body[]).find((x) => x.id === readyId)?.publishedAt === '2026-10-02T10:00:00.000Z');
    const migrated = await stored(readyId);
    ok('migration: written once — a published copy with its charts frozen, `ready` gone, the content and updatedAt as they were', !('ready' in migrated)
      && migrated.published.sheets[0].cards[1].visual?.chartType === 'bar' && migrated.published.sheets[0].cards[2].visual?.chartType === 'line' && migrated.updatedAt === '2026-10-02T10:00:00.000Z' && (await tagOf(readyId)) === beforeTag, JSON.stringify(migrated).slice(0, 200));
    const bytes = JSON.stringify(await stored(readyId));
    await open(readyId);
    await status(readyId);
    ok('migration: idempotent — the next reads write nothing', JSON.stringify(await stored(readyId)) === bytes);
    ok('migration NEGATIVE CONTROL: a dashboard never Ready stays a draft, unwritten', (await status(plainId)) === 'draft' && !('published' in (await stored(plainId))));

    // ── 6. A stored copy is untrusted ────────────────────────────────────
    const hostileId = crypto.randomUUID();
    const junkId = crypto.randomUUID();
    await as(async () => {
      const copy = { name: 'Copy', sheets: [{ name: 'S', cards: [{ id: 'x', type: 'script', layout: {} }, { type: 'text', heading: 'Kept', layout: { x: 99, y: 0, w: 99, h: 1 } }] }], filters: 'nope', publishedAt: '2026-10-03T00:00:00.000Z', contentHash: 'h', versionKey: '../../etc' };
      await recordFs.writeFile(path.join(file, hostileId + '.json'), JSON.stringify({ ...legacy(hostileId, false), published: copy }), 'utf8');
      await recordFs.writeFile(path.join(file, junkId + '.json'), JSON.stringify({ ...legacy(junkId, false), published: { name: 'No date', contentHash: 'h' } }), 'utf8');
    });
    const hostile = (await open(hostileId, true)).analysis;
    ok('untrusted: a stored copy is sanitized like the draft — unknown cards dropped, layouts clamped, a bad version key gone', hostile.name === 'Copy' && hostile.sheets[0].cards.length === 1
      && hostile.sheets[0].cards[0].layout.w === 1 && Array.isArray(hostile.filters) && !JSON.stringify(await open(hostileId)).includes('etc'), JSON.stringify(hostile.sheets).slice(0, 200));
    ok('untrusted: a copy with no publish time is no copy — a draft', (await status(junkId)) === 'draft');
  } catch (err) {
    ok('suite ran to completion', false, err instanceof Error ? err.stack : String(err));
  } finally {
    await app.close();
    fs.rmSync(DATA, { recursive: true, force: true });
    finish();
  }
})();
