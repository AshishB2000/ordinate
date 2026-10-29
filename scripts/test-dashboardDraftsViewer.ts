// A viewer reads published dashboards only (docs/analysis/00-model.md, the
// drafts design's anti-goal: "a viewer can read a draft, a draft's name, or its
// history through any channel"). As scripts/test-liveSafetyNet.ts walks every
// row-reading channel, this walks every dashboard-reading one AS A PROJECT
// VIEWER, in the request context the RPC route gives them (authz/caller: read
// access only), and looks for the draft's words in every reply.
//
// The world: dashboard D, never published ("Draftcanary plan", a draftcanary
// heading, a comment and a catalog note on it); dashboard E, published as
// "Shown board" and then edited ("Editcanary board"); a draft in the Trash.
//
// 1. THE SWEEP: every `read` contract a projectId alone satisfies, and every
//    org-level `read` one that takes nothing, called as the viewer — no reply
//    carries a canary.
// 2. BY ID: analysis:open (D: refused like a missing id; E: the published copy,
//    whatever is asked), versions:list/get/diff/figures (no history),
//    catalog:get / catalog:sensitivity, subscription:preview, search:query, the
//    MCP list_dashboards — no canary, and E's published words where they belong.
// 3. NEGATIVE CONTROL: the same calls as a project EDITOR (not an org admin)
//    find the canaries — the walk can see them, so their absence above is the
//    guard, not a blind walk.
//
//   npm run build:ts && node scripts/test-dashboardDraftsViewer.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');

const context: typeof import('../src/server/context') = require('../src/server/context');
const poolMod: typeof import('../src/engine/duckdbPool') = require('../src/engine/duckdbPool');
const appMod: typeof import('../src/server/app') = require('../src/server/app');
const rpc: typeof import('../src/server/rpc') = require('../src/server/rpc');
const api: typeof import('../src/api/index') = require('../src/api/index');
const caller: typeof import('../src/server/authz/caller') = require('../src/server/authz/caller');

type Identity = import('../src/server/context').Identity;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-draftsviewer-'));
const ADMIN: Identity = { user: { email: 'ana@acme.test', role: 'admin' }, org: { id: 'acme' } };
const VIEWER: Identity = { user: { email: 'vic@acme.test', role: 'viewer' }, org: { id: 'acme' } };
const EDITOR: Identity = { user: { email: 'eve@acme.test', role: 'viewer' }, org: { id: 'acme' } };
const CANARY = /canary/i;
// Channels the sweep leaves out: each needs something no projectId-only call has (a model, a socket), or is the
// walk's own subject asked by id below.
const SKIP = new Set(['analysis:open']);

void (async () => {
  context.enterServerMode(DATA);
  poolMod.routeByOrg({ dataDir: DATA, maxWorkers: 2, memoryLimit: '512MiB', threads: 2, queryTimeoutMs: 60_000, idleMs: 60_000 });
  appMod.registerHandlers();
  const projects: typeof import('../src/app/projects') = require('../src/app/projects');
  const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
  const visuals: typeof import('../src/analysis/visuals') = require('../src/analysis/visuals');
  const automation: typeof import('../src/automation/handlers') = require('../src/automation/handlers');

  const callAs = (who: Identity, rank: number | null, P: string) => async (channel: string, payload: unknown): Promise<unknown> =>
    context.runInContext(who, `as-${who.user.email}`, async () => {
      if (rank !== null) caller.seedRank(P, rank); // what the RPC route seeds from `authorize` (no Postgres here)
      const h = rpc.handlers.get(channel);
      if (!h) return { missing: channel };
      try {
        return await h({}, payload);
      } catch (err) {
        return { threw: err instanceof Error ? err.message : String(err) };
      }
    });

  try {
    const s = await context.runInContext(ADMIN, 'seed', async () => {
      await projects.init();
      const P = (await projects.createProject('Drafts and viewers')).id;
      const d = await datasets.saveDataset(P, { name: 'Orders', sourceKind: 'csv', columns: [{ name: 'region', type: 'text' }, { name: 'amount', type: 'number' }], rows: [['North', 1], ['South', 2]] });
      const v = d && (await visuals.saveVisual(P, { name: 'Sales', datasetId: d.id, chartType: 'bar', encoding: { category: 'region', values: [{ column: 'amount', aggregation: 'sum' }] } } as never));
      if (!d || !v) throw new Error('seed');
      return { P, ds: d.id, vid: v.id };
    });
    const P = s.P;
    const admin = callAs(ADMIN, null, P);
    const card = (type: string, extra: object) => ({ id: crypto.randomUUID(), type, layout: { x: 0, y: 0, w: 4, h: 3 }, ...extra });
    const sheets = (heading: string) => [{ name: 'One', cards: [card('text', { heading }), card('visual', { visualId: s.vid }), card('metric', { metric: { datasetId: s.ds, column: 'amount', aggregation: 'sum', label: 'Revenue' } })] }];
    const D = ((await admin('analysis:create', { projectId: P, name: 'Draftcanary plan', sheets: sheets('draftcanary heading') })) as { id: string }).id;
    await admin('analysis:update', { projectId: P, id: D, name: 'Draftcanary plan v2' }); // a history
    const E = ((await admin('analysis:create', { projectId: P, name: 'Shown board', sheets: sheets('shown heading') })) as { id: string }).id;
    await admin('analysis:publish', { projectId: P, id: E });
    await admin('analysis:update', { projectId: P, id: E, name: 'Editcanary board', sheets: sheets('editcanary heading') });
    const T = ((await admin('analysis:create', { projectId: P, name: 'Trashcanary board' })) as { id: string }).id;
    await admin('analysis:delete', { projectId: P, id: T });
    await admin('comment:add', { projectId: P, target: { kind: 'analysis', id: D }, body: 'the commentcanary thread' });
    await admin('catalog:set', { projectId: P, ref: `analysis:${D}`, patch: { description: 'a docscanary note' } });
    const keysOf = async (id: string) => ((await admin('versions:list', { projectId: P, type: 'dashboard', id })) as { key: string }[]).map((v) => v.key);
    const [dKeys, eKeys] = [await keysOf(D), await keysOf(E)];
    ok('setup: D has a history, E is published with edits not live', dKeys.length >= 2 && eKeys.length >= 2
      && ((await admin('analysis:gallery', { projectId: P })) as { id: string; status: string }[]).find((x) => x.id === E)?.status === 'edited');

    // ── The calls ────────────────────────────────────────────────────────
    const sweep: Array<[string, unknown]> = [];
    for (const [ch, c] of Object.entries(api.contracts) as Array<[string, import('../src/api/contract').Contract]>) {
      if (c.access !== 'read' || SKIP.has(ch)) continue;
      if ('project' in c && c.input.safeParse({ projectId: P }).success) sweep.push([ch, { projectId: P }]);
      else if ('org' in c && c.input.safeParse({}).success) sweep.push([ch, {}]);
    }
    const subDraft = (analysisId: string) => ({ name: 'Weekly', analysisId, content: { mode: 'all', cardIds: [] }, schedule: { kind: 'weekly', weekday: 1, hour: 9, minute: 0 }, timezone: 'UTC', channelIds: [], message: { title: '', note: '', includeLink: true }, conditions: { skipUnchanged: false, onlyWhenRefreshed: false } });
    const byId: Array<[string, string, unknown]> = [
      ['open D', 'analysis:open', { projectId: P, id: D }],
      ['open D, published asked', 'analysis:open', { projectId: P, id: D, published: true }],
      ['open E', 'analysis:open', { projectId: P, id: E }],
      ['versions:list D', 'versions:list', { projectId: P, type: 'dashboard', id: D }],
      ['versions:list E', 'versions:list', { projectId: P, type: 'dashboard', id: E }],
      ['versions:get D', 'versions:get', { projectId: P, type: 'dashboard', id: D, key: dKeys[0] }],
      ['versions:get E', 'versions:get', { projectId: P, type: 'dashboard', id: E, key: eKeys[0] }],
      ['versions:diff D', 'versions:diff', { projectId: P, type: 'dashboard', id: D, from: dKeys[1], to: dKeys[0] }],
      ['versions:diff E', 'versions:diff', { projectId: P, type: 'dashboard', id: E, from: eKeys[1], to: eKeys[0] }],
      ['versions:figures E', 'versions:figures', { projectId: P, type: 'dashboard', id: E, from: eKeys[1], to: eKeys[0] }],
      ['catalog:get D', 'catalog:get', { projectId: P, ref: `analysis:${D}` }],
      ['catalog:sensitivity D', 'catalog:sensitivity', { projectId: P, analysisId: D }],
      ['subscription:preview D', 'subscription:preview', { projectId: P, draft: subDraft(D) }],
      ['subscription:preview E', 'subscription:preview', { projectId: P, draft: subDraft(E) }],
      ['search:query', 'search:query', { projectId: P, query: 'canary' }],
      ['search:query board', 'search:query', { projectId: P, query: 'board' }],
    ];
    const walk = async (who: Identity, rank: number | null) => {
      const as = callAs(who, rank, P);
      const out = new Map<string, string>();
      for (const [ch, payload] of sweep) out.set(ch, JSON.stringify(await as(ch, payload)) ?? 'undefined');
      for (const [label, ch, payload] of byId) out.set(label, JSON.stringify(await as(ch, payload)) ?? 'undefined');
      out.set('mcp list_dashboards', JSON.stringify(await context.runInContext(who, 'mcp', async () => {
        if (rank !== null) caller.seedRank(P, rank);
        return automation.dashboardsList({ projectId: P } as never);
      })));
      return out;
    };

    // ── 1 + 2. As the viewer ─────────────────────────────────────────────
    const seen = await walk(VIEWER, 1);
    const leaks = [...seen].filter(([, reply]) => CANARY.test(reply)).map(([k, reply]) => `${k}: ${reply.slice(0, 160)}`);
    ok(`viewer: no reply of ${seen.size} calls (${sweep.length} swept) carries a draft's name, words, history, comment or note`, leaks.length === 0, leaks.join('\n'));
    ok('viewer: the sweep reached the dashboard list, the catalog, comments, Trash and the metric table', ['analysis:gallery', 'catalog:list', 'comment:list', 'trash:list', 'metric:table'].every((c) => seen.has(c)), [...seen.keys()].join(' '));
    const gallery = JSON.parse(seen.get('analysis:gallery')!);
    ok('viewer: the gallery lists the published dashboard only, by its published name, as published', gallery.length === 1 && gallery[0].id === E && gallery[0].name === 'Shown board' && gallery[0].status === 'published', seen.get('analysis:gallery'));
    const openD = JSON.parse(seen.get('open D')!);
    const missing = await callAs(VIEWER, 1, P)('analysis:open', { projectId: P, id: crypto.randomUUID() });
    ok('viewer: a draft never published is refused exactly as a missing id is', JSON.stringify(openD) === JSON.stringify(missing) && JSON.stringify(JSON.parse(seen.get('open D, published asked')!)) === JSON.stringify(missing), seen.get('open D'));
    const openE = JSON.parse(seen.get('open E')!);
    ok('viewer: E opens as the published copy — its words, frozen chart, published status, no publisher internals', openE.ok && openE.showing === 'published' && openE.status === 'published'
      && openE.analysis.name === 'Shown board' && openE.analysis.sheets[0].cards[0].heading === 'shown heading' && openE.visuals.length === 1 && !('versionKey' in (openE.published || {})), seen.get('open E')?.slice(0, 300));
    ok('viewer: no dashboard history at all — list empty, get null, diff refused', seen.get('versions:list D') === '[]' && seen.get('versions:list E') === '[]' && seen.get('versions:get E') === 'null'
      && JSON.parse(seen.get('versions:diff E')!).ok === false && JSON.parse(seen.get('versions:figures E')!).ok === false);
    ok('viewer: MCP list_dashboards names the published one only', JSON.parse(seen.get('mcp list_dashboards')!).map((d: { name: string }) => d.name).join() === 'Shown board', seen.get('mcp list_dashboards'));

    // ── 3. NEGATIVE CONTROL: a project editor ────────────────────────────
    const editor = await walk(EDITOR, 2);
    const hits = (k: string) => CANARY.test(editor.get(k) ?? '');
    const SPARED = ['analysis:gallery', 'home:overview', 'open D', 'versions:get E', 'versions:diff D', 'catalog:get D', 'comment:list', 'trash:list', 'search:query', 'mcp list_dashboards', 'subscription:preview D'];
    ok('NEGATIVE CONTROL: the editor\'s same calls find every canary the viewer was spared', SPARED.every(hits), SPARED.filter((k) => !hits(k)).join(', '));
    ok('NEGATIVE CONTROL: the editor reads the drafts\' history', JSON.parse(editor.get('versions:list D')!).length === dKeys.length && JSON.parse(editor.get('versions:list E')!).length === eKeys.length);
    const edGallery = JSON.parse(editor.get('analysis:gallery')!) as { id: string; status: string; name: string }[];
    ok('NEGATIVE CONTROL: the editor\'s gallery has the drafts, by their draft names, with their status', edGallery.length === 2 && edGallery.find((x) => x.id === D)?.status === 'draft'
      && edGallery.find((x) => x.id === E)?.name === 'Editcanary board' && edGallery.find((x) => x.id === E)?.status === 'edited');
  } catch (err) {
    ok('suite ran to completion', false, err instanceof Error ? err.stack : String(err));
  } finally {
    fs.rmSync(DATA, { recursive: true, force: true });
    finish();
  }
})();
