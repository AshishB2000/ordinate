// Saved views over the server's RPC (docs/dashboard-filters/00-design.md) —
// real HTTP, server mode, dev sign-in, records as files.
//
//   lifecycle   analysis:view create → rename → update → default → clear →
//               delete, each reply the list as stored
//   refusals    every failure sentence, word for word the catalog's; an unknown
//               op or a stray field is a 400 at the edge
//   lock        two view edits at once both land (recordFs.locked on the
//               record); NEGATIVE CONTROL: the same edits unheld lose one
//   isolation   a view op leaves the sheets and the name byte for byte and
//               records no version; an analysis:update afterwards keeps the
//               views. NEGATIVE CONTROL: a multi-shaped pick on a dropdown card
//               is stripped — the state is re-sanitized against the record
//   publish     a view picking value #100 of a 300-value column makes it an
//               option, once, though two views pick it, and it survives the
//               plan's trim; a view's date range is a date option.
//               DIFFERENTIAL: with no views the options are today's — the
//               column's first values as `dataset:distinct` lists them
//
//   npm run build:ts && node scripts/test-savedViewsServer.js

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
const analysis: typeof import('../src/analysis/analysis') = require('../src/analysis/analysis');
const dd: typeof import('../src/publish/dashboardData') = require('../src/publish/dashboardData');
const say: typeof import('../src/analysis/savedViewMessages') = require('../src/analysis/savedViewMessages');
const { MAX_OPTIONS_PER_CONTROL }: typeof import('../src/publish/combos') = require('../src/publish/combos');

type Identity = import('../src/server/context').Identity;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-views-'));
const ALICE: Identity = { user: { email: 'alice@acme.test', role: 'admin' }, org: { id: 'default' } };
const show = (v: unknown): string => JSON.stringify(v).slice(0, 300);
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const code = (i: number): string => `C${String(i).padStart(3, '0')}`;

async function main(): Promise<void> {
  context.enterServerMode(DATA);
  appMod.registerHandlers();
  const app = appMod.buildApp(envMod.parseEnv({ AUTH_MODE: 'dev', LOG_LEVEL: 'silent', DATA_DIR: DATA, ORDINATE_ENV: 'dev' }), undefined, () => ALICE);
  await app.listen({ port: 0, host: '127.0.0.1' });
  const base = `http://127.0.0.1:${(app.server.address() as import('net').AddressInfo).port}`;
  const call = async (channel: string, payload?: unknown) => {
    const res = await fetch(`${base}/api/rpc/${channel}`, { method: 'POST', headers: withCsrf({ 'content-type': 'application/json' }), body: wire.encode({ args: payload === undefined ? [] : [payload] }) });
    return { status: res.status, body: wire.decode(await res.text()) as any }; // any: each channel's own reply
  };
  try {
    const pid: string = (await call('projects:create', { name: 'Views' })).body.id;
    const DROP = crypto.randomUUID();
    const DATES = crypto.randomUUID();
    const seeded = await context.runInContext(ALICE, 'seed', async () => {
      // 300 codes in first-seen order, two orders each; the date column spans 2025.
      const rows: Array<[string, string, number]> = [];
      for (let i = 1; i <= 300; i++) for (const m of [1, 7]) rows.push([code(i), `2025-0${m}-${String((i % 28) + 1).padStart(2, '0')}`, i + m]);
      const d = await datasets.saveDataset(pid, { name: 'Codes', sourceKind: 'csv', columns: [{ name: 'code', type: 'text' }, { name: 'day', type: 'date' }, { name: 'amount', type: 'number' }], rows });
      if (!d) throw new Error('seed dataset');
      const layout = (y: number) => ({ x: 0, y, w: 3, h: 2 });
      const a = await analysis.saveAnalysis(pid, {
        name: 'Board',
        sheets: [{ name: 'One', cards: [
          { id: DROP, type: 'control', layout: layout(0), control: { kind: 'dropdown', label: 'Code', datasetId: d.id, column: 'code' } },
          { id: DATES, type: 'control', layout: layout(2), control: { kind: 'date_range', label: 'Day', datasetId: d.id, column: 'day' } },
          { id: crypto.randomUUID(), type: 'metric', layout: layout(4), metric: { datasetId: d.id, column: 'amount', aggregation: 'sum', label: 'Total' } },
        ] }],
      } as never);
      if (!a) throw new Error('seed analysis');
      return { ds: d.id, aid: a.id };
    });
    const aid = seeded.aid;
    const view = (op: unknown) => call('analysis:view', { projectId: pid, id: aid, op });
    const open = async () => (await call('analysis:open', { projectId: pid, id: aid })).body.analysis;
    const versions = async () => (await call('versions:list', { projectId: pid, type: 'dashboard', id: aid })).body;

    // ── Lifecycle ───────────────────────────────────────────────────────
    const before = await open();
    const versionsBefore = await versions();
    const east = await view({ op: 'create', name: '  East  ', state: { controls: { [DROP]: { value: code(100) } } } });
    ok('create: ok, the new view is the reply\'s viewId, its name trimmed', east.status === 200 && east.body.ok === true && east.body.views.length === 1
      && east.body.views[0].id === east.body.viewId && east.body.views[0].name === 'East', show(east.body));
    const V1: string = east.body.viewId;
    ok('create: the pick is stored as sent', same(east.body.views[0].state.controls, { [DROP]: { value: code(100) } }), show(east.body.views[0].state));
    const west = await view({ op: 'create', name: 'West', state: { page: before.sheets[0].id, controls: { [DROP]: { value: code(100) }, [DATES]: { from: '2025-02-01', to: '2025-02-28' } } } });
    const V2: string = west.body.viewId;
    ok('create: a second view', west.body.ok === true && west.body.views.length === 2 && typeof V2 === 'string');
    const renamed = await view({ op: 'rename', viewId: V2, name: 'West coast' });
    ok('rename: ok', renamed.body.ok === true && renamed.body.views.find((v: { id: string }) => v.id === V2).name === 'West coast', show(renamed.body));
    const updated = await view({ op: 'update', viewId: V1, state: { controls: { [DROP]: { value: code(100) } }, asOf: null } });
    ok('update: ok, the view keeps its name', updated.body.ok === true && updated.body.views[0].name === 'East' && updated.body.viewId === V1);
    const def = await view({ op: 'default', viewId: V1 });
    ok('default: set', def.body.ok === true && def.body.defaultViewId === V1);
    ok('default: stored on the record', (await open()).defaultViewId === V1);

    // ── Isolation: no sheet, name or version moves ──────────────────────
    const after = await open();
    ok('isolation: a view op leaves the sheets byte for byte', JSON.stringify(after.sheets) === JSON.stringify(before.sheets));
    ok('isolation: …and the name', after.name === before.name);
    ok('isolation: …and records no version', (await versions()).length === versionsBefore.length, `${versionsBefore.length} → ${(await versions()).length}`);
    const autosave = await call('analysis:update', { projectId: pid, id: aid, name: after.name, sheets: after.sheets, filters: after.filters, parameters: after.parameters, style: after.style });
    ok('isolation: an analysis:update afterwards keeps the views and the default', autosave.body.ok === true
      && autosave.body.analysis.views.length === 2 && autosave.body.analysis.defaultViewId === V1, show(autosave.body.analysis?.views));
    const stray = await view({ op: 'create', name: 'Stray', state: { controls: { [DROP]: { values: [code(1)] } } } });
    ok('NEGATIVE CONTROL: a multi-shaped pick on a dropdown card is stripped', stray.body.ok === true
      && same(stray.body.views.find((v: { id: string }) => v.id === stray.body.viewId).state.controls, {}), show(stray.body.views));
    await view({ op: 'delete', viewId: stray.body.viewId });

    // ── Refusals, word for word ─────────────────────────────────────────
    const taken = await view({ op: 'create', name: 'east', state: {} });
    ok('refuse: a name already taken, any case', same(taken.body, { ok: false, error: say.viewNameTaken('east') }) && taken.body.error === 'There is already a view called “east”.', show(taken.body));
    const blank = await view({ op: 'create', name: '   ', state: {} });
    ok('refuse: a blank name', same(blank.body, { ok: false, error: say.viewNameMissing() }) && blank.body.error === 'Give the view a name.', show(blank.body));
    const renameTaken = await view({ op: 'rename', viewId: V2, name: 'EAST' });
    ok('refuse: a rename onto another view\'s name', renameTaken.body.error === say.viewNameTaken('EAST'), show(renameTaken.body));
    const gone = await view({ op: 'rename', viewId: crypto.randomUUID(), name: 'x' });
    ok('refuse: a view that is not there', same(gone.body, { ok: false, error: say.viewGone() }) && gone.body.error === 'That view no longer exists.', show(gone.body));
    const noBoard = await call('analysis:view', { projectId: pid, id: crypto.randomUUID(), op: { op: 'default', viewId: '' } });
    ok('refuse: a dashboard that is not there', same(noBoard.body, { ok: false, error: say.dashboardGone() }) && noBoard.body.error === 'That dashboard could not be loaded.', show(noBoard.body));
    ok('refuse: the unknown-op sentence (the pure door)', say.viewUnknownOp() === 'Unknown view action.');
    ok('edge: an unknown op is a 400', (await view({ op: 'explode', viewId: V1 })).status === 400);
    ok('edge: a stray field on an op is a 400 (strict)', (await view({ op: 'delete', viewId: V1, name: 'x' })).status === 400);
    ok('edge: a non-UUID view id is a 400', (await view({ op: 'delete', viewId: 'west' })).status === 400);
    ok('edge: `views` on analysis:update is still a 400', (await call('analysis:update', { projectId: pid, id: aid, views: [] })).status === 400);

    // ── Publish: views' picks are options ───────────────────────────────
    const plan = () => context.runInContext(ALICE, 'plan', () => dd.planDashboard(pid, aid, 512));
    const optionsOf = async (label: string) => (await plan())!.specs.find((s) => s.domain.label === label)!.domain.options;
    const withViews = await optionsOf('Code');
    ok('publish: the view\'s pick (#100) leads the options, once, though two views pick it',
      withViews[1] === code(100) && withViews.filter((o) => o === code(100)).length === 1, show(withViews.slice(0, 4)));
    const dates = await optionsOf('Day');
    ok('publish: a view\'s date range is a date option', dates.filter((o) => o === '2025-02-01 – 2025-02-28').length === 1, show(dates));
    const built = await context.runInContext(ALICE, 'build', () => dd.buildDashboard(pid, aid, 8));
    const bar = built!.controls.find((c) => c.label === 'Code')!;
    ok('publish: the pick survives the plan\'s trim (8 combinations)', bar.options.includes(code(100)), show(bar.options));
    const east1 = built!.views.find((v) => v.name === 'East');
    ok('publish: the view is on the page, on that option', !!east1 && bar.options[east1.picks[built!.controls.indexOf(bar)]] === code(100), show(built!.views));
    ok('publish: a view whose pair of picks an 8-combination page does not carry is left out, not shown on wrong figures',
      !built!.views.some((v) => v.name === 'West coast'), show(built!.views));

    // Differential: no views → the options as `dataset:distinct` lists the column.
    await view({ op: 'delete', viewId: V1 });
    const last = await view({ op: 'delete', viewId: V2 });
    ok('delete: the list is empty and the default cleared with it', last.body.ok === true && last.body.views.length === 0 && last.body.defaultViewId === '', show(last.body));
    const distinct = (await call('dataset:distinct', { projectId: pid, datasetId: seeded.ds, column: 'code', limit: MAX_OPTIONS_PER_CONTROL })).body;
    const none = await optionsOf('Code');
    ok('DIFFERENTIAL: with no views the options are All + the column\'s first values, in its order',
      none.length === distinct.values.length + 1 && none.every((o, i) => Object.is(o, i === 0 ? 'All' : distinct.values[i - 1])), show(none.slice(0, 4)));
    ok('DIFFERENTIAL: with no views the date options are the presets alone', !(await optionsOf('Day')).includes('2025-02-01 – 2025-02-28'));

    // Two view edits at once both land: each holds the record (recordFs.locked) for its read-modify-write.
    const names = async () => ((await open()).views as Array<{ name: string }>).map((v) => v.name).sort();
    const both = await Promise.all([view({ op: 'create', name: 'One', state: {} }), view({ op: 'create', name: 'Two', state: {} })]);
    ok('lock: two view edits at once both land', both.every((r) => r.body.ok === true) && same(await names(), ['One', 'Two']), show(await names()));
    // NEGATIVE CONTROL: the same two edits through the store WITHOUT the hold — both read the list first, one write is lost.
    const savedViews: typeof import('../src/analysis/savedViews') = require('../src/analysis/savedViews');
    const unheld = (name: string) => context.runInContext(ALICE, 'race', async () => {
      const a = await analysis.getAnalysis(pid, aid);
      await new Promise((r) => setTimeout(r, 20)); // the other edit reads meanwhile
      const r = savedViews.applyViewOp(a!, { op: 'create', name, state: {} }, a!, new Date().toISOString(), () => crypto.randomUUID());
      if (r.ok) await analysis.updateAnalysis(pid, aid, { views: r.views, defaultViewId: r.defaultViewId });
    });
    await Promise.all([unheld('Three'), unheld('Four')]);
    const raced = await names();
    ok('lock: NEGATIVE CONTROL — unheld, one of two simultaneous edits is lost', raced.length === 3 && raced.includes('One') && raced.includes('Two'), show(raced));

    // The 51st view.
    await context.runInContext(ALICE, 'fill', () => analysis.updateAnalysis(pid, aid, {
      views: Array.from({ length: 50 }, (_, i) => ({ id: crypto.randomUUID(), name: `v${i}`, state: {} })),
    }));
    const full = await view({ op: 'create', name: 'One more', state: {} });
    ok('refuse: a 51st view, its limit formatted', same(full.body, { ok: false, error: say.viewLimit('50') }) && full.body.error === 'A dashboard keeps at most 50 views.', show(full.body));
  } finally {
    await app.close();
    fs.rmSync(DATA, { recursive: true, force: true });
  }
}

main().then(finish, (err) => {
  console.error(err);
  ok('suite ran', false, err instanceof Error ? err.stack : String(err));
  finish();
});
