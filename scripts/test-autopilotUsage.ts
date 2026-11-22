// Autopilot phase 1 (docs/autopilot/00-design.md): what is recorded, and that recording never gets in the way.
//   - without a database every call is a no-op (runs first, with or without DATABASE_URL);
//   - with one: the real server's channels record an open or a timed compute per item per day; the store is under forced
//     row-level security as an ORDINARY role with a password; an open is one row per day; both kinds of rename are logged;
//   - negative controls: lists, thumbs and the gallery record nothing, a draft open does not mark every chart, a made-up id
//     never becomes a row, a refused open records nothing, a hung database never makes an open wait.
//
//   npm run build:ts && DATABASE_URL=… node scripts/test-autopilotUsage.js

export {}; // module scope — sibling test scripts share top-level names
import { randomBytes, randomUUID } from 'crypto';
import { Pool } from 'pg';
import { ok, finish } from './selfcheck';
import * as H from './rowPolicyHarness';

const usage: typeof import('../src/server/autopilot/usage') = require('../src/server/autopilot/usage');
const renames: typeof import('../src/server/autopilot/renames') = require('../src/server/autopilot/renames');
const inOrgMod: typeof import('../src/server/db/inOrg') = require('../src/server/db/inOrg');
const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');

const DAY = '2026-03-10';
const at = (day: string, h = 12) => () => Date.parse(`${day}T${String(h).padStart(2, '0')}:00:00Z`);

(async () => {
  // ── no database: a harmless no-op ───────────────────────────────────────────────────────────────────────────
  usage.resetForTest();
  const saved = inOrgMod.orgDb();
  inOrgMod.useOrgDb(null);
  usage.noteOpen('visual', randomUUID(), randomUUID(), 'acme');
  usage.noteCompute('visual', randomUUID(), randomUUID(), 5, { org: 'acme' });
  renames.logRenames(randomUUID(), randomUUID(), [{ from: 'a', to: 'b', kind: 'source' }], new Date().toISOString());
  await usage.flushUsage();
  ok('no database: nothing is buffered, nothing throws', usage.pending() === 0);
  inOrgMod.useOrgDb(saved);

  const W = await H.world('autopilot usage');
  if (!W) return finish();
  const roles: string[] = [];
  const pools: Pool[] = [];
  try {
    const P = W.P;
    const q = async (sql: string, params: unknown[] = []) => (await W.pool.query(sql, params)).rows;
    const rowsOf = (id: string) => q('SELECT opened, computes, total_ms::int AS total, max_ms, day::text AS day FROM item_usage_daily WHERE item_id = $1 ORDER BY day', [id]);
    const flush = async () => { await usage.flushUsage(); };
    const reset = async () => { usage.resetForTest(); usage.setClockForTest(at(DAY)); await q('DELETE FROM item_usage_daily'); };
    await reset();

    // fixtures: a chart, a second chart, a dashboard
    const enc = { category: 'region', values: [{ column: 'sales', aggregation: 'sum' }] };
    const v1 = (await W.call('boss', 'visual:save', { projectId: P, datasetId: W.plain, name: 'Sales', chartType: 'bar', encoding: enc })).body;
    const v2 = (await W.call('boss', 'visual:save', { projectId: P, datasetId: W.plain, name: 'Other', chartType: 'bar', encoding: enc })).body;
    const dash = (await W.call('boss', 'analysis:create', { projectId: P, name: 'Board' })).body;
    ok('fixtures: two charts and a dashboard exist', !!v1?.id && !!v2?.id && !!dash?.id, JSON.stringify([v1, v2, dash]).slice(0, 200));
    await reset(); // saving a chart is not an open

    // ── an open is recorded, once a day ─────────────────────────────────────────────────────────────────────────
    await W.call('boss', 'visual:get', { projectId: P, id: v1.id });
    await W.call('boss', 'visual:get', { projectId: P, id: v1.id });
    ok('buffered, not written: the request path never wrote a row', (await rowsOf(v1.id)).length === 0 && usage.pending() === 1);
    await flush();
    let r = await rowsOf(v1.id);
    ok('visual:get: ONE row for the day, opened, no compute', r.length === 1 && r[0].opened === true && r[0].computes === 0 && r[0].day === DAY, JSON.stringify(r));
    await W.call('boss', 'visual:get', { projectId: P, id: v1.id });
    await flush();
    r = await rowsOf(v1.id);
    ok('once per day: a later flush of the same day updates the same row', r.length === 1);
    usage.setClockForTest(at('2026-03-11', 0));
    await W.call('boss', 'visual:get', { projectId: P, id: v1.id });
    await flush();
    r = await rowsOf(v1.id);
    ok('once per day: the next UTC day is a second row', r.length === 2 && r[1].day === '2026-03-11');
    usage.setClockForTest(at(DAY));

    // ── a timed compute of a named chart (a dashboard tile) ─────────────────────────────────────────────────────
    const tile = { kind: 'visual', datasetId: W.plain, encoding: enc, visualId: v2.id };
    await W.call('boss', 'analysis:tiles', { projectId: P, items: [tile] });
    await W.call('boss', 'analysis:tiles', { projectId: P, items: [tile, tile] });
    await flush();
    r = await rowsOf(v2.id);
    ok('tiles: computes counted (3), total and slowest kept, the chart counts as opened', r.length === 1 && r[0].computes === 3 && r[0].total >= r[0].max_ms && r[0].max_ms >= 0 && r[0].opened === true, JSON.stringify(r));
    const noId = await q('SELECT count(*)::int AS n FROM item_usage_daily');
    await W.call('boss', 'visual:data', { projectId: P, datasetId: W.plain, encoding: enc });
    await flush();
    ok('negative control: a compute that names no saved chart records nothing', (await q('SELECT count(*)::int AS n FROM item_usage_daily'))[0].n === noId[0].n);
    // share paths 'publish' and 'bundle' reach the chart door only from the server itself (the contract takes 'export' only)
    const door = usage.timedViz(async () => ({ ok: true }));
    await q('UPDATE item_usage_daily SET opened = false WHERE item_id = $1', [v2.id]);
    await W.as('boss', async () => { await door({ projectId: P, visualId: v2.id, share: 'publish' }); await door({ projectId: P, visualId: v2.id, share: 'bundle' }); });
    await flush();
    r = await rowsOf(v2.id);
    ok('a publish or bundle build is timed but is not an open', r[0].computes === 5 && r[0].opened === false, JSON.stringify(r));
    await W.call('boss', 'story:figures', { projectId: P, blocks: [{ id: 'b1', kind: 'visual', visualId: v2.id }] });
    await flush();
    ok('a Story\'s read of the chart (story:figures, the report path) is an open and a timed compute', (await rowsOf(v2.id))[0].opened === true && (await rowsOf(v2.id))[0].computes === 6, JSON.stringify(await rowsOf(v2.id)));

    // ── dashboards ──────────────────────────────────────────────────────────────────────────────────────────────
    await reset();
    await W.call('boss', 'analysis:open', { projectId: P, id: dash.id });
    await flush();
    ok('analysis:open (the draft) records the dashboard', (await rowsOf(dash.id)).length === 1);
    ok('negative control: a draft open does not mark every chart of the project', (await q('SELECT count(*)::int AS n FROM item_usage_daily WHERE kind = $1', ['visual']))[0].n === 0);
    await reset();
    const refusedOpen = await W.call('nobody', 'analysis:open', { projectId: P, id: dash.id });
    await flush();
    ok('negative control: a refused open (a viewer, a draft never published) records nothing', refusedOpen.body?.ok === false && (await rowsOf(dash.id)).length === 0);
    const missing = await W.call('boss', 'analysis:open', { projectId: P, id: randomUUID() });
    await flush();
    ok('negative control: opening an id that does not exist records nothing', missing.body?.ok === false && (await q('SELECT count(*)::int AS n FROM item_usage_daily'))[0].n === 0);

    // ── lists, thumbs and the gallery are not opens ────────────────────────────────────────────────────────────
    await W.call('boss', 'visual:list', { projectId: P });
    await W.call('boss', 'visual:thumbs', { projectId: P, ids: [v1.id, v2.id] });
    await W.call('boss', 'analysis:gallery', { projectId: P });
    ok('negative control: list, thumbs and gallery buffer nothing', usage.pending() === 0);

    // ── an id the client made up never becomes a row ───────────────────────────────────────────────────────────
    const ghost = randomUUID();
    await W.call('boss', 'visual:data', { projectId: P, datasetId: W.plain, encoding: enc, visualId: ghost });
    usage.noteOpen('visual', P, 'not-a-uuid');
    usage.noteOpen('visual', 'nope', ghost);
    ok('a bad id is dropped at once; a well-formed made-up one waits for the flush', usage.pending() === 1);
    await flush();
    ok('negative control: the made-up id is not a record, so it is never written', (await rowsOf(ghost)).length === 0);
    // a flood of made-up ids fills the buffer: a real open still lands (the full buffer is written, the flush drops the junk)
    await reset();
    for (let i = 0; i < usage.MAX_ENTRIES; i += 1) usage.noteOpen('visual', P, randomUUID(), 'acme');
    ok('a flood of ids cannot grow the buffer past its cap', usage.pending() === usage.MAX_ENTRIES);
    usage.noteOpen('visual', P, v1.id, 'acme');
    await flush();
    await flush();
    ok('S4: past the cap a real open is NOT dropped (the full buffer is written first)', (await rowsOf(v1.id)).length === 1 && (await rowsOf(v1.id))[0].opened === true);
    ok('S4 (control): the junk of the flood was never written', (await q('SELECT count(*)::int AS n FROM item_usage_daily'))[0].n === 1);
    // the database is down and the buffer is full of compute rows: an open still gets a place
    await reset();
    const down = { connect: () => Promise.reject(new Error('down')), on: () => undefined } as unknown as Pool;
    const live = inOrgMod.orgDb();
    inOrgMod.useOrgDb(down);
    usage.noteCompute('visual', P, randomUUID(), 3, { opened: false, org: 'acme' });
    await usage.flushUsage(); // fails: a full buffer will not hammer the database for a few seconds
    for (let i = 1; i < usage.MAX_ENTRIES; i += 1) usage.noteCompute('visual', P, randomUUID(), 3, { opened: false, org: 'acme' });
    usage.noteOpen('visual', P, v1.id, 'acme');
    usage.noteCompute('visual', P, randomUUID(), 3, { opened: false, org: 'acme' });
    ok('S4: with the database down the buffer stays at its cap', usage.pending() === usage.MAX_ENTRIES);
    inOrgMod.useOrgDb(live);
    await flush();
    ok('S4: and the open survived the compute rows', (await rowsOf(v1.id)).length === 1 && (await rowsOf(v1.id))[0].opened === true);
    await reset();

    // S2: what was noted while a write was running is written at shutdown too
    const slowWrite = usage.flushUsage; // (the real one)
    usage.noteOpen('visual', P, v1.id, 'acme');
    const inFlight = slowWrite();
    usage.noteOpen('visual', P, v2.id, 'acme');
    await usage.stopUsage();
    await inFlight;
    ok('S2: stopUsage writes the open that arrived after the running write began', (await rowsOf(v1.id)).length === 1 && (await rowsOf(v2.id)).length === 1);
    await reset();

    // ── forced row-level security, as an ordinary role with a password ──────────────────────────────────────────
    const role = `autopilot_role_${process.pid}`;
    roles.push(role);
    const pw = randomBytes(12).toString('hex'); // CI's Postgres asks for a password over TCP
    await q(`CREATE ROLE ${role} LOGIN PASSWORD '${pw}'`);
    await q(`GRANT ALL ON ALL TABLES IN SCHEMA public TO ${role}`);
    await q(`GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO ${role}`);
    const url = new URL((W.pool as unknown as { options: { connectionString: string } }).options.connectionString);
    url.username = role;
    url.password = pw;
    const R = new Pool({ connectionString: url.toString(), max: 4 });
    R.on('error', () => undefined);
    pools.push(R);
    inOrgMod.useOrgDb(R);
    usage.noteOpen('visual', P, v1.id, 'acme');
    await flush();
    ok('written through the ordinary role (the app\'s own path)', (await rowsOf(v1.id)).length === 1);
    await q(`INSERT INTO item_usage_daily (org_id, project_id, kind, item_id, day, opened) VALUES ('other', $1, 'visual', $2, $3, true)`, [P, randomUUID(), DAY]);
    await q(`INSERT INTO column_renames (org_id, project_id, dataset_id, edit_id, kind, old_name, new_name, dataset_at) VALUES ('other', $1, $2, $3, 'source', 'a', 'b', now())`, [P, randomUUID(), randomUUID()]);
    const count = async (table: string, org: string | null): Promise<number> => {
      const c = await R.connect();
      try {
        await c.query('BEGIN');
        if (org) await c.query('SELECT set_config($1, $2, true)', ['ordinate.org', org]);
        const n = Number((await c.query(`SELECT count(*) AS n FROM ${table}`)).rows[0].n);
        await c.query('ROLLBACK');
        return n;
      } finally { c.release(); }
    };
    for (const t of ['item_usage_daily', 'column_renames']) {
      ok(`RLS ${t}: no scope sees no row`, (await count(t, null)) === 0);
      ok(`RLS ${t}: an org sees only its own`, (await count(t, 'other')) === 1 && (await count(t, 'nobody-here')) === 0);
    }
    ok('RLS: acme sees its usage row and not the other org\'s', (await count('item_usage_daily', 'acme')) === 1);
    const c = await R.connect();
    let refused = false;
    try {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('ordinate.org', 'acme', true)`);
      await c.query(`INSERT INTO column_renames (org_id, project_id, dataset_id, edit_id, kind, old_name, new_name, dataset_at) VALUES ('other', $1, $2, $3, 'source', 'a', 'b', now())`, [P, randomUUID(), randomUUID()]);
    } catch (e) { refused = /row-level security/.test((e as Error).message); } finally { await c.query('ROLLBACK').catch(() => undefined); c.release(); }
    ok('RLS: a write for another org is refused by the policy', refused);
    ok('the tables have no user column (per item, never per person)', (await q(`SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name = 'item_usage_daily' AND column_name ~ '(user|email|actor|who)'`))[0].n === 0);

    // ── both kinds of rename are logged ─────────────────────────────────────────────────────────────────────────
    await q('DELETE FROM column_renames');
    const cols = (await W.as('boss', () => datasets.getDataset(P, W.plain)))!.columns.map((x) => ({ name: x.name, type: x.type }));
    const rename = (from: string, to: string) => cols.map((x) => (x.name === from ? { ...x, name: to } : x));
    ok('dataset:update (a plain rename)', (await W.call('boss', 'dataset:update', { projectId: P, datasetId: W.plain, columns: rename('customer', 'client') })).body?.ok === true);
    await W.as('boss', () => usage.flushUsage()); // (renames are written at once; this only drains the usage buffer)
    await W.as('boss', async () => { await new Promise((res) => setTimeout(res, 300)); });
    let log = await W.as('boss', () => renames.renamesOf(W.plain));
    ok('a source rename: logged with both names and kind "source"', log.length === 1 && log[0].from === 'customer' && log[0].to === 'client' && log[0].kind === 'source', JSON.stringify(log));
    // a step reads qty: its rename becomes a rename_column step, and is logged as kind "step"
    await W.as('boss', () => datasets.updateSteps(P, W.plain, [{ type: 'calculated_field', name: 'q2', expression: '[qty]*2' }]));
    const shown = (await W.as('boss', () => datasets.getDataset(P, W.plain)))!.columns.map((x) => ({ name: x.name, type: x.type }));
    const patch = shown.map((x) => (x.name === 'qty' ? { ...x, name: 'quantity' } : x));
    ok('dataset:update (a rename a step depends on)', (await W.call('boss', 'dataset:update', { projectId: P, datasetId: W.plain, columns: patch })).body?.ok === true);
    await W.as('boss', async () => { await new Promise((res) => setTimeout(res, 300)); });
    log = await W.as('boss', () => renames.renamesOf(W.plain));
    const stepRow = log[log.length - 1];
    const stepsNow = (await W.as('boss', () => datasets.getDataset(P, W.plain)))!.steps as Array<{ type: string; from?: string; to?: string }>;
    ok('a step rename: logged as kind "step", and the dataset really holds that rename_column step', log.length === 2 && stepRow.from === 'qty' && stepRow.to === 'quantity' && stepRow.kind === 'step'
      && stepsNow.some((s) => s.type === 'rename_column' && s.from === 'qty' && s.to === 'quantity'), JSON.stringify(log));
    // a swap in ONE edit keeps both rows, in one edit, in order
    const shown2 = (await W.as('boss', () => datasets.getDataset(P, W.plain)))!.columns.map((x) => ({ name: x.name, type: x.type }));
    const swapped = shown2.map((x) => (x.name === 'region' ? { ...x, name: 'sales' } : x.name === 'sales' ? { ...x, name: 'region' } : x));
    await W.call('boss', 'dataset:update', { projectId: P, datasetId: W.plain, columns: swapped });
    await W.as('boss', async () => { await new Promise((res) => setTimeout(res, 300)); });
    log = await W.as('boss', () => renames.renamesOf(W.plain));
    const last2 = log.slice(-2);
    ok('a swap: both renames logged, one edit_id, in order', last2.length === 2 && last2[0].editId === last2[1].editId && last2[0].seq < last2[1].seq && last2.map((x) => `${x.from}>${x.to}`).sort().join() === 'region>sales,sales>region', JSON.stringify(last2));
    const before = log.length;
    const now3 = (await W.as('boss', () => datasets.getDataset(P, W.plain)))!.columns.map((x) => ({ name: x.name, type: x.type }));
    await W.call('boss', 'dataset:update', { projectId: P, datasetId: W.plain, columns: now3 });
    await W.as('boss', async () => { await new Promise((res) => setTimeout(res, 300)); });
    ok('negative control: an edit that renames nothing (a same-name patch) logs nothing', (await W.as('boss', () => renames.renamesOf(W.plain))).length === before);

    // ── a prepare step edit is a rename too (Prepare, a plan, a version restore all go through updateSteps) ─────────────────────
    await q('DELETE FROM column_renames');
    const base = (await W.as('boss', () => datasets.getDataset(P, W.plain)))!.steps ?? [];
    const step = { type: 'rename_column', from: 'quantity', to: 'units' };
    await W.as('boss', () => datasets.updateSteps(P, W.plain, [...base, step]));
    await W.as('boss', async () => { await new Promise((res) => setTimeout(res, 300)); });
    let slog = await W.as('boss', () => renames.renamesOf(W.plain));
    ok('S1: a rename_column step added in Prepare is logged as kind "step"', slog.length === 1 && slog[0].from === 'quantity' && slog[0].to === 'units' && slog[0].kind === 'step', JSON.stringify(slog));
    await W.as('boss', () => datasets.updateSteps(P, W.plain, [...base, step]));
    await W.as('boss', async () => { await new Promise((res) => setTimeout(res, 300)); });
    ok('S1 (control): saving the same steps again logs nothing', (await W.as('boss', () => renames.renamesOf(W.plain))).length === 1);
    await W.as('boss', () => datasets.updateSteps(P, W.plain, base)); // a version restore that removes the step
    await W.as('boss', async () => { await new Promise((res) => setTimeout(res, 300)); });
    slog = await W.as('boss', () => renames.renamesOf(W.plain));
    ok('S1: removing the step (a restore) is logged reversed, units back to quantity', slog.length === 2 && slog[1].from === 'units' && slog[1].to === 'quantity' && slog[1].kind === 'step', JSON.stringify(slog));
    // two quick edits written out of order still replay in the dataset's own order (a to b, then b to c)
    await q('DELETE FROM column_renames');
    const ins = (from: string, to: string, at: string) => q(`INSERT INTO column_renames (org_id, project_id, dataset_id, edit_id, kind, old_name, new_name, dataset_at) VALUES ('acme', $1, $2, $3, 'source', $4, $5, $6)`, [P, W.plain, randomUUID(), from, to, at]);
    await ins('b', 'c', '2026-03-10T12:00:00.002Z'); // written first, but the later edit
    await ins('a', 'b', '2026-03-10T12:00:00.001Z');
    slog = await W.as('boss', () => renames.renamesOf(W.plain));
    ok('S5: renames replay by the dataset\'s updatedAt, not by arrival', slog.map((x) => `${x.from}>${x.to}`).join() === 'a>b,b>c', JSON.stringify(slog));

    // ── a hung database never makes an open wait ────────────────────────────────────────────────────────────────
    await reset();
    inOrgMod.useOrgDb({ connect: () => new Promise(() => undefined), on: () => undefined } as unknown as Pool); // every connect hangs
    await W.call('boss', 'analysis:open', { projectId: P, id: dash.id }).catch(() => undefined); // wire it up
    usage.noteOpen('visual', P, v1.id, 'acme');
    void usage.flushUsage(); // hangs: the write is stuck
    const t0 = Date.now();
    const slow = await W.call('boss', 'analysis:open', { projectId: P, id: dash.id });
    const tiles = await W.call('boss', 'analysis:tiles', { projectId: P, items: [tile] });
    ok('open and tiles answer correctly and at once while the write is stuck', Date.now() - t0 < 4000 && slow.body?.ok === true && Array.isArray(tiles.body) && tiles.body[0]?.ok === true, `${Date.now() - t0} ms`);
    usage.resetForTest();

    // ── a failed write is retried, not lost ─────────────────────────────────────────────────────────────────────
    inOrgMod.useOrgDb({ connect: () => Promise.reject(new Error('down')), on: () => undefined } as unknown as Pool);
    usage.noteOpen('visual', P, v1.id, 'acme');
    await usage.flushUsage();
    ok('a failed write puts the batch back', usage.pending() === 1);
    inOrgMod.useOrgDb(R);
    await usage.flushUsage();
    ok('and the next tick writes it', usage.pending() === 0 && (await rowsOf(v1.id)).length === 1);
  } finally {
    usage.resetForTest();
    usage.setClockForTest(null);
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
