// Governance readers over the real route (semantic layer part 4, release A), as real users in a scratch
// Postgres (scripts/rowPolicyHarness.ts): a dataset carrying `columnAccess` (written by a newer release)
// has column rules this pod cannot apply, so it is CLOSED, reason `columns`, to every project viewer, whether
// or not its row rules name them, and to every fan-out (publish, embed, subscription, alert); a dataset built
// from it is closed too (`derived`). Editors and admins read it as before.
// NEGATIVE CONTROLS: the editor reads it; with the key removed, the viewer is answered and the publish planned.
//
//   npm run build:ts && DATABASE_URL=… node scripts/test-governanceReaders-db.js

export {}; // module scope: sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import * as H from './rowPolicyHarness';

const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
const rec: typeof import('../src/data/datasetRecord') = require('../src/data/datasetRecord');
const rowAccess: typeof import('../src/data/rowAccess') = require('../src/data/rowAccess');

const CA = { columns: [{ column: 'sales', visibleTo: [] }], readersHash: 'h', updatedBy: 'boss@acme.test', updatedAt: '2026-11-04T00:00:00.000Z' };
const enc = { category: 'customer', values: [{ column: 'sales', aggregation: 'sum' }] };
const show = (r: H.Reply): string => `${r.status} ${r.text.slice(0, 200)}`;
/** Answered: a 200 that is not `{ok:false}` (a grid page carries no `ok`). */
const answered = (r: H.Reply): boolean => r.status === 200 && r.body?.ok !== false;

(async () => {
  const W = await H.world('governance readers (db) suite');
  if (!W) return finish();
  try {
    const { P, east: EAST, plain } = W;
    // Planted as a newer release writes it: a metadata write (serialized), as Task 2's suite does.
    const write = (id: string, edit: (r: Record<string, unknown>) => void) => W.as('boss', () => rec.serialized(rec.datasetFilePath(P, id), (r) => { edit(r); return true; }));
    const plantColumnAccess = (id: string) => write(id, (r) => { r.columnAccess = CA; });
    const removeColumnAccess = (id: string) => write(id, (r) => { delete r.columnAccess; });
    const chart = (who: string, d: string) => W.call(who, 'visual:data', { projectId: P, datasetId: d, encoding: enc });
    const page = (d: string) => ({ projectId: P, datasetId: d, offset: 0, limit: 200 });
    const stats = (d: string) => ({ projectId: P, datasetId: d });
    const dashOn = async (d: string): Promise<string> => {
      const v = await W.call('boss', 'visual:save', { projectId: P, datasetId: d, name: 'Sales', chartType: 'bar', encoding: enc });
      const a = await W.call('boss', 'analysis:create', { projectId: P, name: 'Board', sheets: [{ name: 'One', cards: [
        { id: crypto.randomUUID(), type: 'visual', layout: { x: 0, y: 0, w: 6, h: 4 }, visualId: String(v.body?.visual?.id ?? v.body?.id) },
      ] }] });
      return String(a.body?.id ?? a.body?.analysis?.id);
    };
    const planOver = async (d: string) => ({ projectId: P, dashboardIds: [await dashOn(d)], storyIds: [], scorecardIds: [], options: { title: 'Site' } });
    const builtFromPlain = await W.as('boss', async () => {
      const id = (await datasets.saveDataset(P, { name: 'Union', sourceKind: 'csv', columns: H.COLUMNS, rows: H.only('North') }))!.id;
      await datasets.updateSteps(P, id, [{ type: 'union', datasetId: plain }]);
      return id;
    });
    const plan = await planOver(plain);
    const sendsAllowed = (d: string) => W.as('boss', () => rowAccess.assertFanOutAllowed(P, [d]).then(() => true, (err: unknown) => (rowAccess.isRowPolicyError(err) ? false : Promise.reject(err))));
    ok('setup: without the key east reads the plain dataset, one built from it and its own subset, and the publish is planned',
      (await chart('east', plain)).body?.ok === true && answered(await W.call('east', 'dataset:page', page(builtFromPlain)))
      && (await chart('east', EAST)).body?.ok === true && (await W.call('boss', 'publish:plan', plan)).body?.ok === true);

    // ── A dataset with column rules and no row rules ─────────────────────
    await plantColumnAccess(plain);
    const refusedChart = await chart('east', plain);
    ok('east is refused a chart on it, typed `columns`', H.refused(refusedChart, 'columns'), show(refusedChart));
    const grid = await W.call('east', 'dataset:page', page(plain));
    const net = await W.call('east', 'dataset:stats', stats(plain));
    ok('…its grid and its stats (the net)', H.refused(grid, 'columns') && H.refused(net, 'columns'), `${show(grid)} | ${show(net)}`);
    ok('…and every other viewer, named in no rule, is refused too', H.refused(await chart('nobody', plain), 'columns') && H.refused(await chart('west', plain), 'columns'));
    const built = await W.call('east', 'dataset:page', page(builtFromPlain));
    ok('a dataset built from it is closed to east too', H.refused(built, 'derived'), show(built));
    const planned = await W.call('boss', 'publish:plan', plan);
    ok('a publish reading it refuses for everyone (an admin too)', H.refused(planned, 'fanout'), show(planned));
    ok('…and so does the send check every subscription, alert and /p/ page makes', (await sendsAllowed(plain)) === false);
    const edChart = await chart('ed', plain);
    ok('NEGATIVE CONTROL: the editor reads it as before', edChart.body?.ok === true, show(edChart));
    ok('NEGATIVE CONTROL: …its grid and its stats too', answered(await W.call('ed', 'dataset:page', page(plain))) && answered(await W.call('ed', 'dataset:stats', stats(plain))));
    await removeColumnAccess(plain);
    ok('NEGATIVE CONTROL: without the key east is answered again', (await chart('east', plain)).body?.ok === true && answered(await W.call('east', 'dataset:stats', stats(plain))));
    ok('NEGATIVE CONTROL: …the dataset built from it opens, and the publish is planned and sends again',
      answered(await W.call('east', 'dataset:page', page(builtFromPlain))) && (await W.call('boss', 'publish:plan', plan)).body?.ok === true && (await sendsAllowed(plain)) === true);

    // ── A dataset with BOTH row rules and column rules ──────────────────
    await plantColumnAccess(EAST);
    const named = await chart('east', EAST);
    ok('east, whom the row rules name, is refused it too (`columns`, never its row lock)', H.refused(named, 'columns'), show(named));
    ok('…its grid as well', H.refused(await W.call('east', 'dataset:page', page(EAST)), 'columns'));
    ok('NEGATIVE CONTROL: the editor reads it as before', (await chart('ed', EAST)).body?.ok === true);
    await removeColumnAccess(EAST);
    ok('NEGATIVE CONTROL: without the key east reads it through its row lock again', (await chart('east', EAST)).body?.ok === true);
  } finally {
    await W.close();
  }
  finish();
})().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
