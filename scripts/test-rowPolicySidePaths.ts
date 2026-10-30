// Row access rules on two side paths, over the real RPC route, as real users
// with real grants, in a scratch Postgres (scripts/rowPolicyHarness.ts):
//
// 1. THE TRASH (NV-16): a trashed dataset keeps its rules. East is refused an
//    input table's versions (its whole table) after an editor trashes it, and
//    a dataset built from a trashed Orders stays 'derived' (grid refused, value
//    search skips it). NEGATIVE CONTROLS: the editor reads both; a trashed
//    input table WITHOUT rules stays open to east; restored, Orders still
//    governs what was built from it.
// 2. CAPTURES (NV-20): a capture's stored table and screenshot are refused
//    when ANY dataset its rows were saved into has rules — a composer save
//    with a join (which writes no link), a link a second save moved to an
//    unruled copy that was then deleted, and a link to a trashed ruled
//    dataset. NEGATIVE CONTROLS: the editor gets the table; a capture saved
//    nowhere opens for east; its thumbnail is kept.
// 3. NOTHING LEAKS: no reply to east carries a West value.
//
//   npm run build:ts && DATABASE_URL=… node scripts/test-rowPolicySidePaths.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import * as H from './rowPolicyHarness';

const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
const history: typeof import('../src/app/history') = require('../src/app/history');

(async () => {
  const W = await H.world('row access side paths');
  if (!W) return finish();
  try {
    const { P, orders, plain } = W;
    const eastReplies: string[] = [];
    const east = async (channel: string, payload: unknown): Promise<H.Reply> => {
      const r = await W.call('east', channel, payload);
      eastReplies.push(r.text);
      return r;
    };
    const rules = async (d: string) => (await W.call('boss', 'dataset:setRowPolicy', { projectId: P, datasetId: d, policy: { column: 'region', rules: H.RULES(W.team, W.uid.west) } })).body?.ok === true;
    const trash = async (d: string) => (await W.call('ed', 'dataset:delete', { projectId: P, id: d })).body?.ok === true;

    // ── 1. The trash (NV-16) ────────────────────────────────────────────
    const input = async (name: string, other: string) => {
      const created = await W.call('boss', 'input:create', { projectId: P, name, columns: [{ name: 'region', type: 'text' }, { name: 'customer', type: 'text' }] });
      const id = String(created.body?.id ?? '');
      await W.call('boss', 'input:save', { projectId: P, id, batches: [{ label: 'Add', ops: [{ t: 'ins', at: 0, rows: [['East', 'e1'], ['West', other]] }] }] });
      const keys = ((await W.call('boss', 'versions:list', { projectId: P, type: 'dataset', id })).body as { key: string }[] | null ?? []).map((v) => v.key);
      return { id, keys };
    };
    const ledger = await input('Ledger', `${H.W_CANARY}_9`);
    const openLedger = await input('Open ledger', 'OPEN_ROW');
    ok('setup: two input tables with versions; the first given rules', ledger.keys.length > 0 && openLedger.keys.length > 0 && (await rules(ledger.id)), JSON.stringify([ledger, openLedger]));
    const version = (who: string, t: { id: string; keys: string[] }) => W.call(who, 'versions:get', { projectId: P, type: 'dataset', id: t.id, key: t.keys[0] });
    ok('control: before the trash, east is refused the governed table\'s version', H.refused(await version('east', ledger)));
    ok('setup: the editor trashes both tables', (await trash(ledger.id)) && (await trash(openLedger.id)));
    const listed = await east('trash:list', { projectId: P });
    ok('the trashed table\'s id is one a viewer can learn (trash:list)', listed.text.includes(ledger.id));
    const v = await east('versions:get', { projectId: P, type: 'dataset', id: ledger.id, key: ledger.keys[0] });
    ok('trash: versions:get of a trashed table with rules still refuses east, typed', H.refused(v), `${v.status} ${v.text.slice(0, 200)}`);
    const d = await east('versions:diff', { projectId: P, type: 'dataset', id: ledger.id, from: ledger.keys[ledger.keys.length - 1], to: ledger.keys[0] });
    ok('trash: versions:diff refuses east too', H.refused(d), `${d.status} ${d.text.slice(0, 200)}`);
    ok('NEGATIVE CONTROL: the editor reads the trashed version, West row and all', H.leaks((await version('ed', ledger)).text));
    const openV = await W.call('east', 'versions:get', { projectId: P, type: 'dataset', id: openLedger.id, key: openLedger.keys[0] });
    ok('NEGATIVE CONTROL: a trashed table WITHOUT rules stays open to east', !H.refused(openV) && openV.text.includes('OPEN_ROW'), `${openV.status} ${openV.text.slice(0, 160)}`);

    // A dataset built from Orders: 'derived' while Orders is live — and while it sits in the Trash.
    const built = await W.as('boss', async () => (await datasets.saveDataset(P, {
      name: 'Built', sourceKind: 'combined', columns: H.COLUMNS, rows: H.ROWS,
      origin: { kind: 'composed', baseId: orders, joins: [{ datasetId: plain, mode: 'left', on: { left: 'customer', right: 'customer' } }] },
    }))!.id);
    const page = { projectId: P, datasetId: built, offset: 0, limit: 200 };
    ok('control: a dataset built from Orders is refused east (derived)', H.refused(await W.call('east', 'dataset:page', page), 'derived'));
    ok('setup: the editor trashes Orders', await trash(orders));
    const builtPage = await east('dataset:page', page);
    ok('trash: built from a TRASHED Orders, it is still refused east (derived)', H.refused(builtPage, 'derived'), `${builtPage.status} ${builtPage.text.slice(0, 200)}`);
    const search = await east('dataSearch:query', { projectId: P, term: H.W_CANARY });
    ok('trash: value search still skips it for east', search.status === 200 && !search.text.includes(built), search.text.slice(0, 200));
    const searchEd = await W.call('ed', 'dataSearch:query', { projectId: P, term: H.W_CANARY });
    ok('NEGATIVE CONTROL: the editor\'s search finds the West values in it', searchEd.text.includes(built) && H.leaks(searchEd.text));
    ok('NEGATIVE CONTROL: the editor reads its grid', H.leaks((await W.call('ed', 'dataset:page', page)).text));
    const restored = await W.call('ed', 'trash:restore', { projectId: P, type: 'dataset', id: orders });
    ok('restored, Orders governs it as before', restored.body?.ok === true && H.refused(await W.call('east', 'dataset:page', page), 'derived'));

    // ── 2. Captures (NV-20) ─────────────────────────────────────────────
    const cols = [{ name: 'region', type: 'text' }, { name: 'customer', type: 'text' }];
    const capture = async (id: string, other: string) => {
      await W.as('boss', () => history.saveThread({
        id, projectId: P, datasetId: null, title: 'Captured', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), cropPath: null,
        thumb: 'data:image/png;base64,iVBORw0KGgo=',
        result: { title: 'Captured', extractedTable: { columns: [{ id: 'region', label: 'region', type: 'text' }, { id: 'customer', label: 'customer', type: 'text' }], rows: [{ region: 'East', customer: 'e1' }, { region: 'West', customer: other }] } },
      }));
      return id;
    };
    const save = async (captureId: string, joins: unknown[]) => {
      const r = await W.call('ed', 'dataset:composeSave', {
        projectId: P, name: 'Cap', base: { inline: { name: 'Cap', columns: cols, rows: [['East', 'e1'], ['West', `${H.W_CANARY}_8`]] } }, joins, steps: [],
        sourceKind: 'capture', origin: { kind: 'capture', captureId },
      });
      return String(r.body?.dataset?.id ?? '');
    };
    const stamp = Date.now();
    const joined = await capture(`${stamp}1`, `${H.W_CANARY}_8`);
    const moved = await capture(`${stamp}2`, `${H.W_CANARY}_8`);
    const trashedLink = await capture(`${stamp}3`, `${H.W_CANARY}_8`);
    const nowhere = await capture(`${stamp}4`, 'OPEN_CAPTURE_ROW');

    // (a) Saved through the composer WITH a join: the capture's rows become base B, and no link is written.
    const composed = await save(joined, [{ datasetId: plain, mode: 'left', on: { left: 'region', right: 'region' } }]);
    const base = await W.as('boss', async () => {
      const o = (await datasets.getDatasetMeta(P, composed))?.origin;
      return o && o.kind === 'composed' ? o.baseId : '';
    });
    const thread = await W.as('boss', () => history.loadThread(joined));
    ok('setup: a capture saved with a join — base and composed datasets, no link on the capture', !!composed && !!base && thread?.datasetId == null && (await rules(base)), `${composed} ${base} ${thread?.datasetId}`);
    ok('control: east is refused the composed dataset (derived from the ruled base)', H.refused(await W.call('east', 'dataset:page', { projectId: P, datasetId: composed, offset: 0, limit: 10 }), 'derived'));
    // (b) Saved twice with no joins: the link moves from the ruled copy to an unruled one, which is then deleted.
    const first = await save(moved, []);
    const ruledFirst = await rules(first);
    const second = await save(moved, []);
    const link = (await W.as('boss', () => history.loadThread(moved)))?.datasetId;
    ok('setup: the link moved to the second, unruled copy, which the editor then trashes', ruledFirst && !!second && link === second && (await trash(second)), `${first} ${second} ${link}`);
    // (c) Saved once, linked, given rules, then trashed (NV-16's capture variant).
    const only = await save(trashedLink, []);
    ok('setup: a capture linked to a ruled dataset that is then trashed', !!only && (await rules(only)) && (await trash(only)));

    for (const [label, id] of [['saved with a join (no link)', joined], ['whose link moved off the ruled copy', moved], ['linked to a trashed ruled dataset', trashedLink]] as const) {
      const got = await east('captureDataset:get', { projectId: P, captureId: id });
      ok(`capture ${label}: captureDataset:get refuses east, typed`, H.refused(got), `${got.status} ${got.text.slice(0, 200)}`);
      const img = await east('captureDataset:image', { projectId: P, captureId: id });
      ok(`capture ${label}: captureDataset:image refuses east, typed`, H.refused(img), `${img.status} ${img.text.slice(0, 200)}`);
      const theirs = await W.call('ed', 'captureDataset:get', { projectId: P, captureId: id });
      ok(`NEGATIVE CONTROL: capture ${label} — the editor gets the table`, theirs.body?.ok === true && H.leaks(theirs.text), theirs.text.slice(0, 160));
    }
    const open = await east('captureDataset:get', { projectId: P, captureId: nowhere });
    ok('NEGATIVE CONTROL: a capture saved nowhere opens for east', open.body?.ok === true && open.text.includes('OPEN_CAPTURE_ROW'), open.text.slice(0, 160));
    const list = await east('captureDataset:list', { projectId: P });
    const row = (r: H.Reply, id: string) => (r.body as { id: string; thumb?: string | null; hasImage?: boolean }[]).find((x) => x.id === id);
    ok('captureDataset:list strips the thumbnail of every capture saved into a ruled dataset', [joined, moved, trashedLink].every((id) => row(list, id) && !row(list, id)!.thumb && row(list, id)!.hasImage === false), list.text.slice(0, 200));
    ok('NEGATIVE CONTROL: …and keeps the one saved nowhere', !!row(list, nowhere)?.thumb);
    ok('NEGATIVE CONTROL: the editor\'s list keeps every thumbnail', !!row(await W.call('ed', 'captureDataset:list', { projectId: P }), joined)?.thumb);

    // ── 3. Nothing leaks ────────────────────────────────────────────────
    const leaked = eastReplies.filter(H.leaks);
    ok(`nothing of West's in any of east's ${eastReplies.length} replies`, leaked.length === 0, leaked.map((t) => t.slice(0, 120)).join(' | '));
  } finally {
    await W.close();
  }
  finish();
})().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
