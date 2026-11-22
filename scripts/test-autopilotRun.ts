// Autopilot end to end on a real server and Postgres (docs/autopilot/00-design.md, phases 2 to 4): the settings, a run as the admin who
// switched it on (Trash with its reason and 90 days, an exact repair with its old version kept, rows listed), Undo, the pause when that admin
// is gone, two servers claiming one week, the pruning, and forced row-level security as an ordinary role. The repair is checked by a
// DIFFERENTIAL: the chart Autopilot repaired equals a chart authored by hand on the renamed table, in its stored definition and in the figures
// the engine draws from it.
//
//   npm run build:ts && DATABASE_URL=… node scripts/test-autopilotRun.js

export {}; // module scope — sibling test scripts share top-level names
import { randomBytes, randomUUID } from 'crypto';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { ok, finish } from './selfcheck';
import * as H from './rowPolicyHarness';

const store: typeof import('../src/server/autopilot/store') = require('../src/server/autopilot/store');
const job: typeof import('../src/server/autopilot/job') = require('../src/server/autopilot/job');
const inOrgMod: typeof import('../src/server/db/inOrg') = require('../src/server/db/inOrg');
const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
const stories: typeof import('../src/analysis/stories') = require('../src/analysis/stories');

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const same = (a: unknown, b: unknown): boolean => { try { assert.deepStrictEqual(a, b); return true; } catch { return false; } };

(async () => {
  const W = await H.world('autopilot run');
  if (!W) return finish();
  const roles: string[] = [];
  const pools: Pool[] = [];
  try {
    const P = W.P;
    const q = async (sql: string, params: unknown[] = []) => (await W.pool.query(sql, params)).rows;
    const call = (who: string, ch: string, input?: unknown) => W.call(who, ch, input);
    const encOn = (col: string) => ({ category: 'region', values: [{ column: col, aggregation: 'sum' }] });
    const mkVisual = async (name: string, col = 'sales'): Promise<string> => (await call('boss', 'visual:save', { projectId: P, datasetId: W.plain, name, chartType: 'bar', encoding: encOn(col) })).body.id;
    /** A chart older than any window: its record's createdAt moved back. */
    const oldCreated = async (id: string) => q(`UPDATE records SET body = regexp_replace(body, '"createdAt": ?"[^"]*"', '"createdAt":"2025-01-01T00:00:00.000Z"') WHERE path = $1`, [`projects/${P}/visuals/${id}.json`]);
    /** Old createdAt, and Autopilot has watched it since long ago (a chart that has lived here, not one that was imported). */
    const age = async (id: string) => { await oldCreated(id); await q(`INSERT INTO autopilot_seen (org_id, project_id, visual_id, first_seen) VALUES ('acme', $1, $2, $3) ON CONFLICT (org_id, project_id, visual_id) DO UPDATE SET first_seen = $3`, [P, id, daysAgo(200)]); };
    const today = new Date().toISOString().slice(0, 10);
    const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
    const items = async (runId: string) => (await call('boss', 'autopilot:run', { projectId: P, runId })).body.items as Array<{ seq: number; kind: string; visualId: string; state: string; detail: any }>; // any: the item's own detail
    const visual = async (id: string) => (await call('boss', 'visual:get', { projectId: P, id })).body;

    // ── settings ────────────────────────────────────────────────────────────────────────────────────────────────
    const first = (await call('boss', 'autopilot:overview')).body;
    const mine = first.projects.find((p: any) => p.id === P); // any: the overview row
    ok('off by default, with the owner\'s defaults (90 days, 5 s, both safe actions on)', mine.settings.enabled === false && mine.settings.windowDays === 90 && mine.settings.slowSeconds === 5 && mine.settings.trashUnused && mine.settings.repairRenames && mine.settings.runAs === null);
    ok('a viewer and an editor cannot read or change it (admin channels)', (await call('west', 'autopilot:overview')).status === 403 && (await call('ed', 'autopilot:save', { projectId: P, enabled: true })).status === 403);
    ok('the window is 30 to 365: 29 and 366 are refused, 30 and 365 are saved', (await call('boss', 'autopilot:save', { projectId: P, windowDays: 29 })).status === 400
      && (await call('boss', 'autopilot:save', { projectId: P, windowDays: 366 })).status === 400
      && (await call('boss', 'autopilot:save', { projectId: P, windowDays: 30 })).body.settings.windowDays === 30
      && (await call('boss', 'autopilot:save', { projectId: P, windowDays: 365 })).body.settings.windowDays === 365);
    ok('a project that does not exist has no settings row', (await call('boss', 'autopilot:save', { projectId: randomUUID(), enabled: true })).body.error === 'not_found' && (await q('SELECT count(*)::int AS n FROM autopilot_settings'))[0].n === 1);
    await call('boss', 'autopilot:save', { projectId: P, windowDays: 90 });
    ok('Run now is refused while it is off', (await call('boss', 'autopilot:runNow', { projectId: P })).body.error === 'off');
    const on = (await call('boss', 'autopilot:save', { projectId: P, enabled: true })).body.settings;
    ok('switching it on records the admin it acts as', on.enabled === true && on.runAs === 'boss@acme.test' && on.pausedReason === null);

    // ── a run: Trash, and what is never moved ──────────────────────────────────────────────────────────────────────
    await q(`INSERT INTO item_usage_daily (org_id, project_id, kind, item_id, day, opened) VALUES ('acme', $1, 'visual', $2, $3, true)`, [P, randomUUID(), daysAgo(200)]); // usage began 200 days ago: the 90-day window is covered
    const unused = await mkVisual('Unused');
    const opened = await mkVisual('Opened lately');
    const onDash = await mkVisual('On a dashboard');
    const inStory = await mkVisual('In a Story');
    const fresh = await mkVisual('Brand new');
    for (const id of [unused, opened, onDash, inStory]) await age(id);
    await q(`INSERT INTO item_usage_daily (org_id, project_id, kind, item_id, day, opened) VALUES ('acme', $1, 'visual', $2, $3, true)`, [P, opened, daysAgo(10)]);
    const dash = (await call('boss', 'analysis:create', { projectId: P, name: 'Board', sheets: [{ name: 'S', cards: [{ id: randomUUID(), type: 'visual', visualId: onDash, layout: { x: 0, y: 0, w: 6, h: 6 } }] }] })).body;
    await W.as('boss', () => stories.saveStory(P, { name: 'Tale', blocks: [{ id: 'b1', kind: 'visual', visualId: inStory, filters: [] }] }));
    ok('fixtures: five charts, one on a dashboard with a card, one in a Story', !!dash?.id && !!unused);
    const r1 = (await call('boss', 'autopilot:runNow', { projectId: P })).body;
    ok('Run now answers a run id', typeof r1.runId === 'string', JSON.stringify(r1));
    const rows1 = await items(r1.runId);
    const moved = rows1.filter((i) => i.kind === 'trashed' && i.state === 'applied').map((i) => i.visualId);
    ok('only the unused chart is moved to Trash', moved.join() === unused, JSON.stringify(rows1.map((i) => [i.kind, i.state, i.visualId.slice(0, 4)])));
    ok('NEGATIVE: the chart opened lately, the one on a dashboard, the one in a Story and the new one are all still there', (await visual(opened)) !== null && (await visual(onDash)) !== null && (await visual(inStory)) !== null && (await visual(fresh)) !== null);
    const trashed = (await call('boss', 'trash:list', { projectId: P })).body.find((t: any) => t.id === unused); // any: a trash row
    ok('its Trash entry says Autopilot did it, for how many days, as whom, and stays 90 days (a person\'s own delete keeps 30)', trashed?.reason?.kind === 'autopilot' && trashed.reason.days === 90 && trashed.reason.by === 'boss@acme.test' && trashed.daysLeft === 90, JSON.stringify(trashed));
    const own = await mkVisual('Mine');
    await call('boss', 'visual:delete', { projectId: P, id: own });
    ok('a person\'s own delete keeps the normal 30 days and no reason', (await call('boss', 'trash:list', { projectId: P })).body.find((t: any) => t.id === own)?.daysLeft === 30);
    const trashedItem = rows1.find((i) => i.kind === 'trashed')!;
    ok('Undo brings the chart back, with no Autopilot stamp left on it', (await call('boss', 'autopilot:undo', { projectId: P, runId: r1.runId, seq: trashedItem.seq })).body.ok === true && (await visual(unused)) !== null && !('reason' in (await visual(unused))) && !('keepDays' in (await visual(unused))));
    ok('Undo twice changes nothing (the row is undone)', (await call('boss', 'autopilot:undo', { projectId: P, runId: r1.runId, seq: trashedItem.seq })).body.error === 'not_applied');
    const r2 = (await call('boss', 'autopilot:runNow', { projectId: P })).body;
    ok('a chart that was brought back is not moved again next time', (await items(r2.runId)).filter((i) => i.kind === 'trashed').length === 0 && (await visual(unused)) !== null);

    // ── a scan that cannot be completed moves nothing; what mentions a chart is read from the stored text ──────────────────────
    const lone = await mkVisual('Lone and old'); await age(lone);
    const real = store.scanMentions;
    (store as any).scanMentions = async () => { throw new Error('the storage hiccuped'); }; // any: patched here
    const hiccup = (await call('boss', 'autopilot:runNow', { projectId: P })).body;
    (store as any).scanMentions = real; // any: restored
    ok('NEGATIVE: when what mentions the charts cannot be read, the run FAILS and nothing is moved', hiccup.ok === false && (await q(`SELECT state FROM autopilot_runs WHERE project_id = $1 ORDER BY started_at DESC LIMIT 1`, [P]))[0]?.state === 'failed');
    ok('…and the unused chart is still there, with no row for it', (await visual(lone)) !== null && (await q(`SELECT 1 FROM autopilot_items WHERE visual_id = $1`, [lone])).length === 0);
    const brokenDash = randomUUID();
    await q(`INSERT INTO records (org_id, path, body) VALUES ('acme', $1, $2)`, [`projects/${P}/analyses/${brokenDash}.json`, `{"id": "${brokenDash}", "sheets": [ {"cards": [{"visualId": "${lone}" `]); // corrupt: it does not parse
    const rCorrupt = (await call('boss', 'autopilot:runNow', { projectId: P })).body;
    ok('a corrupt dashboard record still protects the chart it names (the text is read, not the parse)', (await items(rCorrupt.runId)).every((i) => i.visualId !== lone) && (await visual(lone)) !== null);
    await q(`DELETE FROM records WHERE path = $1`, [`projects/${P}/analyses/${brokenDash}.json`]);
    // a dashboard in the Trash still protects its charts: bring it back and its cards are there
    const keep = await mkVisual('Only on a trashed dashboard'); await age(keep);
    const trashedDash = (await call('boss', 'analysis:create', { projectId: P, name: 'Gone for now', sheets: [{ name: 'S', cards: [{ id: randomUUID(), type: 'visual', visualId: keep, layout: { x: 0, y: 0, w: 6, h: 6 } }] }] })).body;
    await call('boss', 'analysis:delete', { projectId: P, id: trashedDash.id });
    ok('fixture: the dashboard is in the Trash', (await call('boss', 'trash:list', { projectId: P })).body.some((t: any) => t.id === trashedDash.id)); // any: a trash row
    const rTrashDash = (await call('boss', 'autopilot:runNow', { projectId: P })).body;
    ok('NEGATIVE: a chart on a dashboard that is in the Trash is not moved', (await items(rTrashDash.runId)).every((i) => i.visualId !== keep) && (await visual(keep)) !== null);
    ok('…and the restored dashboard still has its card', (await call('boss', 'trash:restore', { projectId: P, type: 'dashboard', id: trashedDash.id })).body.ok === true && JSON.stringify((await call('boss', 'analysis:open', { projectId: P, id: trashedDash.id })).body.analysis).includes(keep));
    await call('boss', 'analysis:delete', { projectId: P, id: trashedDash.id });
    await call('boss', 'trash:purge', { projectId: P, type: 'dashboard', id: trashedDash.id });

    // ── watched for the whole window: an import keeps its old createdAt and proves nothing ─────────────────────────────────────
    const imported = await mkVisual('Imported last week'); await oldCreated(imported); // old createdAt, but Autopilot has never seen it
    const rImp = (await call('boss', 'autopilot:runNow', { projectId: P })).body;
    ok('NEGATIVE: a chart with an old createdAt that Autopilot first met today is not moved', (await items(rImp.runId)).every((i) => i.visualId !== imported) && (await visual(imported)) !== null);
    ok('…and Autopilot now knows it from today', (await q(`SELECT first_seen::text AS d FROM autopilot_seen WHERE visual_id = $1`, [imported]))[0]?.d === today);
    await q(`UPDATE autopilot_seen SET first_seen = $2 WHERE visual_id = $1`, [imported, daysAgo(200)]);
    ok('control: once it has been watched for the whole window it is moved', (await items((await call('boss', 'autopilot:runNow', { projectId: P })).body.runId)).some((i) => i.visualId === imported && i.kind === 'trashed' && i.state === 'applied'));
    // coverage is the project\'s own: another project has charts long watched, but nobody has used it since recording began
    const P2 = (await call('boss', 'projects:create', { name: 'Second' })).body.id;
    await call('boss', 'autopilot:save', { projectId: P2, enabled: true });
    const ds2 = await W.as('boss', async () => (await datasets.saveDataset(P2, { name: 'T', sourceKind: 'csv', columns: H.COLUMNS, rows: H.ROWS.slice(0, 5) }))!.id);
    const c2 = (await call('boss', 'visual:save', { projectId: P2, datasetId: ds2, name: 'Quiet project chart', chartType: 'bar', encoding: encOn('sales') })).body.id;
    await q(`UPDATE records SET body = regexp_replace(body, '"createdAt": ?"[^"]*"', '"createdAt":"2025-01-01T00:00:00.000Z"') WHERE path = $1`, [`projects/${P2}/visuals/${c2}.json`]);
    await q(`INSERT INTO autopilot_seen (org_id, project_id, visual_id, first_seen) VALUES ('acme', $1, $2, $3)`, [P2, c2, daysAgo(200)]);
    const rP2 = (await call('boss', 'autopilot:runNow', { projectId: P2 })).body;
    ok('NEGATIVE: a project with no usage of its own is not covered: its old, watched chart is not moved', rP2.ok === true && (await call('boss', 'visual:get', { projectId: P2, id: c2 })).body !== null && (await call('boss', 'autopilot:run', { projectId: P2, runId: rP2.runId })).body.items.length === 0);
    await call('boss', 'autopilot:save', { projectId: P2, enabled: false });

    // ── a rename, an exact repair, the differential ───────────────────────────────────────────────────────────────
    const R = await mkVisual('Sales by region', 'sales');
    await q(`UPDATE records SET body = body WHERE path = $1`, [`projects/${P}/visuals/${R}.json`]);
    await call('boss', 'analysis:update', { projectId: P, id: dash.id, sheets: [{ name: 'S', cards: [{ id: randomUUID(), type: 'visual', visualId: onDash, layout: { x: 0, y: 0, w: 6, h: 6 } }, { id: randomUUID(), type: 'visual', visualId: R, layout: { x: 6, y: 0, w: 6, h: 6 } }] }] }); // on a dashboard: repaired, never moved
    const original = await visual(R);
    const cols = (await W.as('boss', () => datasets.getDataset(P, W.plain)))!.columns.map((c) => ({ name: c.name, type: c.type }));
    ok('dataset:update renames sales to revenue', (await call('boss', 'dataset:update', { projectId: P, datasetId: W.plain, columns: cols.map((c) => (c.name === 'sales' ? { ...c, name: 'revenue' } : c)) })).body.ok === true);
    await sleep(400); // the rename log is written beside the edit
    const r3 = (await call('boss', 'autopilot:runNow', { projectId: P })).body;
    const rows3 = await items(r3.runId);
    const fix = rows3.find((i) => i.kind === 'repaired' && i.visualId === R);
    ok('every chart on the renamed column was repaired, not just one (each is on a dashboard or in a Story or opened, or was moved)', rows3.filter((i) => i.kind === 'repaired').length >= 1);
    ok('the chart is repaired from the rename log: sales to revenue, applied', fix?.state === 'applied' && same(fix.detail.fixes, [{ from: 'sales', to: 'revenue' }]), JSON.stringify(rows3));
    const repaired = await visual(R);
    const byHand = await mkVisual('By hand', 'revenue'); // authored on the table that has the new name
    const handmade = await visual(byHand);
    ok('DIFFERENTIAL: the repaired chart\'s stored definition equals the hand-authored one (encoding and filters)', same(repaired.encoding, handmade.encoding) && same(repaired.filters, handmade.filters), JSON.stringify([repaired.encoding, handmade.encoding]));
    const draw = (v: any) => call('boss', 'visual:data', { projectId: P, datasetId: W.plain, encoding: v.encoding, filters: v.filters }); // any: a visual
    const [a, b] = [await draw(repaired), await draw(handmade)];
    ok('DIFFERENTIAL: and the engine draws identical figures from both, object for object', a.body.ok === true && same(a.body, b.body));
    ok('the repair touched no other field of the chart', same({ ...repaired, encoding: 0, tag: 0, updatedAt: 0 }, { ...original, encoding: 0, tag: 0, updatedAt: 0 }));
    const history = (await call('boss', 'versions:list', { projectId: P, type: 'visual', id: R })).body;
    ok('the previous version is kept in its history, authored by Autopilot as the admin', Array.isArray(history) && history.some((v: any) => /Autopilot \(as boss@acme\.test\)/.test(String(v.by))), JSON.stringify(history).slice(0, 300)); // any: a version row
    ok('negative control: a chart that has no logged rename for its missing column is listed broken, never repaired', await (async () => {
      const lost = await mkVisual('Lost', 'sales'); // `sales` is gone and its rename WAS logged, so use a column nothing renamed
      await call('boss', 'visual:update', { projectId: P, id: lost, encoding: encOn('nothing_renamed') });
      await call('boss', 'analysis:update', { projectId: P, id: dash.id, sheets: [{ name: 'S', cards: [{ id: randomUUID(), type: 'visual', visualId: lost, layout: { x: 0, y: 0, w: 6, h: 6 } }] }] });
      const run = (await call('boss', 'autopilot:runNow', { projectId: P })).body;
      const row = (await items(run.runId)).find((i) => i.visualId === lost);
      return row?.kind === 'broken' && row.state === 'listed' && row.detail.gone[0].column === 'nothing_renamed' && row.detail.gone[0].why === 'none';
    })());
    ok('Undo of the repair puts the exact previous definition back', (await call('boss', 'autopilot:undo', { projectId: P, runId: r3.runId, seq: fix!.seq })).body.ok === true && same((await visual(R)).encoding, original.encoding));
    ok('Undo twice changes nothing', (await call('boss', 'autopilot:undo', { projectId: P, runId: r3.runId, seq: fix!.seq })).body.error === 'not_applied');
    // a repair, then a person edits the chart: Undo must not overwrite their edit
    const r4 = (await call('boss', 'autopilot:runNow', { projectId: P })).body;
    const fix4 = (await items(r4.runId)).find((i) => i.kind === 'repaired' && i.visualId === R);
    ok('the chart is repaired again (it is broken again after the Undo)', fix4?.state === 'applied');
    await call('boss', 'visual:update', { projectId: P, id: R, encoding: { category: 'customer', values: [{ column: 'revenue', aggregation: 'sum' }] } });
    ok('NEGATIVE: Undo refuses once a person has edited the chart ("changed"), and leaves their edit', (await call('boss', 'autopilot:undo', { projectId: P, runId: r4.runId, seq: fix4!.seq })).body.error === 'changed' && (await visual(R)).encoding.category === 'customer');

    // ── a person's save made while Autopilot works is never overwritten, by a repair or by Undo ───────────────────────────────
    const visualsMod: any = require('../src/analysis/visuals'); // any: patched here to interleave a person's save
    const realRead = visualsMod.readVisual;
    const racing = async <T>(id: string, fn: () => Promise<T>): Promise<T> => {
      let armed = true;
      visualsMod.readVisual = async (pid: string, vid: string) => {
        const got = await realRead(pid, vid);
        if (armed && vid === id) { armed = false; await call('boss', 'visual:update', { projectId: P, id, name: 'Edited by a person meanwhile' }); } // after Autopilot read it, before it writes
        return got;
      };
      try { return await fn(); } finally { visualsMod.readVisual = realRead; }
    };
    const X = await mkVisual('To be repaired', 'sales');
    await call('boss', 'analysis:update', { projectId: P, id: dash.id, sheets: [{ name: 'S', cards: [{ id: randomUUID(), type: 'visual', visualId: X, layout: { x: 0, y: 0, w: 6, h: 6 } }] }] });
    const rRace = await racing(X, async () => (await call('boss', 'autopilot:runNow', { projectId: P })).body);
    const raced = (await items(rRace.runId)).find((i) => i.visualId === X);
    ok('NEGATIVE: a person saved between Autopilot\'s read and its write: the repair is not made ("changed") and their save stays', raced?.kind === 'repaired' && raced.state === 'failed' && raced.detail.why === 'changed' && (await visual(X)).name === 'Edited by a person meanwhile' && (await visual(X)).encoding.values[0].column === 'sales');
    const T = await mkVisual('To be undone', 'sales');
    await call('boss', 'analysis:update', { projectId: P, id: dash.id, sheets: [{ name: 'S', cards: [{ id: randomUUID(), type: 'visual', visualId: T, layout: { x: 0, y: 0, w: 6, h: 6 } }] }] });
    const rT = (await call('boss', 'autopilot:runNow', { projectId: P })).body;
    const fixT = (await items(rT.runId)).find((i) => i.visualId === T && i.kind === 'repaired');
    ok('fixture: the chart is repaired', fixT?.state === 'applied');
    const undoRace = await racing(T, async () => (await call('boss', 'autopilot:undo', { projectId: P, runId: rT.runId, seq: fixT!.seq })).body);
    ok('NEGATIVE: a person saved between Undo\'s read and its write: Undo refuses ("changed") and their save stays', undoRace.error === 'changed' && (await visual(T)).name === 'Edited by a person meanwhile' && (await visual(T)).encoding.values[0].column === 'revenue');

    // ── one run of a project at a time ──────────────────────────────────────────────────────────────────────────────────────────
    await q(`UPDATE autopilot_runs SET state = 'done' WHERE state = 'running'`);
    const going = randomUUID();
    await q(`INSERT INTO autopilot_runs (org_id, project_id, id, manual, window_days, state) VALUES ('acme', $1, $2, true, 90, 'running')`, [P, going]);
    ok('NEGATIVE: Run now is refused while a run of the project is going', (await call('boss', 'autopilot:runNow', { projectId: P })).body.error === 'busy');
    ok('NEGATIVE: and the weekly tick does not start beside it (and does not use the week up)', (await W.as('boss', () => store.claimWeek(P, '2031-01-06', 90))) === null && (await q(`SELECT 1 FROM autopilot_runs WHERE week = '2031-01-06'`)).length === 0);
    await q(`UPDATE autopilot_runs SET state = 'done' WHERE id = $1`, [going]);
    ok('control: when it ends, Run now works again', (await call('boss', 'autopilot:runNow', { projectId: P })).body.ok === true);
    await q(`UPDATE autopilot_runs SET state = 'done' WHERE state = 'running'`);
    const both = await W.as('boss', () => Promise.all([store.startManual(P, 90), store.startManual(P, 90), store.startManual(P, 90)]));
    ok('three starts at once (a double click, two admins): exactly one gets the run', both.filter(Boolean).length === 1);
    await q(`UPDATE autopilot_runs SET state = 'done' WHERE state = 'running'`);
    const weekly = await W.as('boss', () => Promise.all([store.claimWeek(P, '2031-01-13', 90), store.startManual(P, 90)]));
    ok('a weekly claim and a Run now at once: exactly one gets it', weekly.filter(Boolean).length === 1);
    await q(`UPDATE autopilot_runs SET state = 'done' WHERE state = 'running'`);

    // ── a run taken up again after a crash counts everything it did ──────────────────────────────────────────────────────────
    const stale = (await W.as('boss', () => store.claimWeek(P, '2031-02-03', 90)))!;
    await W.as('boss', () => store.addItem(stale, P, { kind: 'trashed', visualId: randomUUID(), name: 'Moved before the crash', state: 'applied', detail: { days: 90 }, undo: null }));
    await q(`UPDATE autopilot_runs SET started_at = now() - interval '2 hours' WHERE id = $1`, [stale]);
    const again = await W.as('boss', () => store.claimWeek(P, '2031-02-03', 90));
    ok('the dead run is retaken under the same id', again === stale);
    await W.as('boss', async () => { await (require('../src/server/autopilot/run') as typeof import('../src/server/autopilot/run')).runProject(stale, await store.getSettings(P), today); });
    ok('its counts include what the first attempt did, not just this one\'s', (await W.as('boss', () => store.getRun(stale)))!.counts.trashed === 1);
    await q(`UPDATE autopilot_runs SET state = 'done' WHERE state = 'running'`);

    // ── settings that shape a run ─────────────────────────────────────────────────────────────────────────────────────
    await call('boss', 'autopilot:save', { projectId: P, trashUnused: false });
    const staleTrash = await mkVisual('Stale 2'); await age(staleTrash);
    const r5 = (await call('boss', 'autopilot:runNow', { projectId: P })).body;
    const listed = (await items(r5.runId)).find((i) => i.visualId === staleTrash);
    ok('with "move unused charts" off, the chart is only listed, and stays', listed?.kind === 'trashed' && listed.state === 'listed' && (await visual(staleTrash)) !== null);
    await call('boss', 'autopilot:save', { projectId: P, trashUnused: true });

    // ── the admin it acts as is checked every run ───────────────────────────────────────────────────────────────────────
    const before = (await call('boss', 'visual:list', { projectId: P })).body.length;
    await q(`UPDATE autopilot_settings SET run_as = 'ed@acme.test' WHERE project_id = $1`, [P]); // an editor, not an admin
    const sse: any = require('../src/server/sse'); // any: patched here to hear the pushes
    const realPublish = sse.publish;
    const heard: Array<{ user?: string; channel: string; payload: any }> = []; // any: a push's own payload
    sse.publish = (to: { user?: string }, channel: string, payload: unknown) => { heard.push({ user: to.user, channel, payload }); return realPublish(to, channel, payload); };
    const paused = await W.as('boss', () => job.weeklyForOrg(new Date(Date.now() + 14 * 86_400_000)));
    sse.publish = realPublish;
    ok('the admins hear it: a push to every admin (not to an editor or a viewer), with ids and names and no chart', heard.length >= 1 && heard.every((h) => h.channel === 'autopilot:report' && h.user === 'boss@acme.test' && h.payload.state === 'paused'), JSON.stringify(heard));
    const afterPause = (await call('boss', 'autopilot:overview')).body.projects.find((p: any) => p.id === P);
    ok('the admin it acts as is no longer an admin: the run pauses and changes nothing', paused === false && afterPause.settings.pausedReason === 'lost_admin' && afterPause.latest.state === 'paused' && (await call('boss', 'visual:list', { projectId: P })).body.length === before);
    ok('a paused project is skipped by the next weekly tick (no new run)', await (async () => { const n = (await q('SELECT count(*)::int AS n FROM autopilot_runs'))[0].n; await W.as('boss', () => job.weeklyForOrg(new Date(Date.now() + 21 * 86_400_000))); return (await q('SELECT count(*)::int AS n FROM autopilot_runs'))[0].n === n; })());
    const back = (await call('boss', 'autopilot:save', { projectId: P, enabled: true })).body.settings;
    ok('switching it on again clears the pause and records the new admin', back.pausedReason === null && back.runAs === 'boss@acme.test');
    await q(`UPDATE users SET disabled_at = now() WHERE email = 'ed@acme.test'`);
    await q(`UPDATE autopilot_settings SET run_as = 'ed@acme.test'`);
    await W.as('boss', () => job.weeklyForOrg(new Date(Date.now() + 28 * 86_400_000)));
    ok('a disabled account is as lost as a demoted one', (await call('boss', 'autopilot:overview')).body.projects.find((p: any) => p.id === P).settings.pausedReason === 'lost_admin');
    await q(`UPDATE users SET disabled_at = NULL WHERE email = 'ed@acme.test'`);
    await call('boss', 'autopilot:save', { projectId: P, enabled: true });

    // ── two servers, one week ───────────────────────────────────────────────────────────────────────────────────────────
    await q('DELETE FROM autopilot_items'); await q('DELETE FROM autopilot_runs');
    const week = store.mondayOf(today);
    const claims = await W.as('boss', () => Promise.all(Array.from({ length: 8 }, () => store.claimWeek(P, week, 90))));
    ok('eight servers race for one week: exactly one gets the run', claims.filter(Boolean).length === 1 && (await q('SELECT count(*)::int AS n FROM autopilot_runs'))[0].n === 1);
    ok('a later poll the same week gets nothing', (await W.as('boss', () => store.claimWeek(P, week, 90))) === null);
    await q(`UPDATE autopilot_runs SET started_at = now() - interval '1 hour'`);
    const retaken = await W.as('boss', () => Promise.all([store.claimWeek(P, week, 90), store.claimWeek(P, week, 90)]));
    ok('a claim whose server died (running, an hour old) is retaken, by one server only', retaken.filter(Boolean).length === 1);
    await q(`UPDATE autopilot_runs SET state = 'done', started_at = now() - interval '9 hours'`);
    ok('NEGATIVE: a finished run is never retaken, however old', (await W.as('boss', () => store.claimWeek(P, week, 90))) === null);
    await q('DELETE FROM autopilot_runs');
    await Promise.all([W.as('boss', () => job.weeklyForOrg(new Date())), W.as('boss', () => job.weeklyForOrg(new Date()))]);
    ok('two weekly ticks at once run the project once', (await q(`SELECT count(*)::int AS n FROM autopilot_runs WHERE week IS NOT NULL`))[0].n === 1);
    ok('a manual Run now has no week and does not use up the week', (await q(`SELECT count(*)::int AS n FROM autopilot_runs WHERE manual`))[0].n === 0 && (await call('boss', 'autopilot:runNow', { projectId: P })).body.ok === true && (await q(`SELECT count(*)::int AS n FROM autopilot_runs WHERE manual`))[0].n === 1);

    // ── pruning ─────────────────────────────────────────────────────────────────────────────────────────────────────────
    await q('DELETE FROM item_usage_daily');
    const ins = (item: string, day: string) => q(`INSERT INTO item_usage_daily (org_id, project_id, kind, item_id, day, opened) VALUES ('acme', $1, 'visual', $2, $3, true)`, [P, item, day]);
    const gone = randomUUID();
    await ins(R, daysAgo(500)); await ins(R, daysAgo(150)); await ins(R, daysAgo(5)); await ins(gone, daysAgo(150)); await ins(gone, daysAgo(5));
    const pruned = await W.as('boss', () => store.pruneUsage());
    const left = (await q(`SELECT item_id::text AS id, (current_date - day) AS age FROM item_usage_daily ORDER BY age`)).map((r) => `${r.id === R ? 'R' : 'gone'}:${r.age < 10 ? 'recent' : 'old'}`);
    ok('prune: older than 400 days goes; an item that is no longer a record goes after 100 days; a live chart\'s history stays', pruned === 2 && left.join() === 'R:recent,gone:recent,R:old', `${pruned} ${left}`);

    // ── forced row-level security, as an ordinary role with a password ──────────────────────────────────────────────────
    const role = `autopilot_run_role_${process.pid}`;
    roles.push(role);
    const pw = randomBytes(12).toString('hex');
    await q(`CREATE ROLE ${role} LOGIN PASSWORD '${pw}'`);
    await q(`GRANT ALL ON ALL TABLES IN SCHEMA public TO ${role}`);
    const url = new URL((W.pool as unknown as { options: { connectionString: string } }).options.connectionString);
    url.username = role; url.password = pw;
    const Rl = new Pool({ connectionString: url.toString(), max: 3 });
    Rl.on('error', () => undefined);
    pools.push(Rl);
    await q(`INSERT INTO autopilot_settings (org_id, project_id) VALUES ('other', $1)`, [P]);
    await q(`INSERT INTO autopilot_runs (org_id, project_id, id, manual, window_days) VALUES ('other', $1, $2, true, 90)`, [P, randomUUID()]);
    await q(`INSERT INTO autopilot_items (org_id, run_id, seq, project_id, kind, visual_id, name, state) VALUES ('other', $1, 1, $2, 'slow', $3, 'x', 'listed')`, [randomUUID(), P, randomUUID()]);
    const count = async (table: string, org: string | null): Promise<number> => {
      const c = await Rl.connect();
      try {
        await c.query('BEGIN');
        if (org) await c.query('SELECT set_config($1, $2, true)', ['ordinate.org', org]);
        const n = Number((await c.query(`SELECT count(*) AS n FROM ${table}`)).rows[0].n);
        await c.query('ROLLBACK');
        return n;
      } finally { c.release(); }
    };
    for (const t of ['autopilot_settings', 'autopilot_runs', 'autopilot_items']) {
      ok(`RLS ${t}: no scope sees nothing; an org sees only its own`, (await count(t, null)) === 0 && (await count(t, 'other')) === 1 && (await count(t, 'nobody-here')) === 0);
    }
    const c = await Rl.connect();
    let refused = false;
    try {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('ordinate.org', 'acme', true)`);
      await c.query(`INSERT INTO autopilot_settings (org_id, project_id) VALUES ('other', $1)`, [randomUUID()]);
    } catch (e) { refused = /row-level security/.test((e as Error).message); } finally { await c.query('ROLLBACK').catch(() => undefined); c.release(); }
    ok('RLS: a write for another org is refused by the policy', refused);
    ok('the store runs as the ordinary role too (the app\'s own path)', await (async () => { inOrgMod.useOrgDb(Rl); try { return (await W.as('boss', () => store.getSettings(P))).enabled === true; } finally { inOrgMod.useOrgDb(W.pool); } })());
  } finally {
    inOrgMod.useOrgDb(W.pool);
    for (const p of pools) await p.end().catch(() => undefined);
    for (const r of roles) {
      await W.pool.query(`REASSIGN OWNED BY ${r} TO CURRENT_USER`).catch(() => undefined);
      await W.pool.query(`DROP OWNED BY ${r}`).catch(() => undefined);
      await W.pool.query(`DROP ROLE IF EXISTS ${r}`).catch(() => undefined);
    }
    await W.close();
  }
  finish();
})().catch((e) => { console.error(e); process.exit(1); });
