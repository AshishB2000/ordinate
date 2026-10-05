// A column rename / retype on a dataset WITH prepare steps lands on the column
// the user is looking at (T2.6; the open item T2.3 logged). The edit arrives
// indexed against the SHOWN (prepared) columns and is resolved by name
// (src/data/columnEdit.ts):
//
//   1. A pipeline that drops and adds columns shifts every index; renaming /
//      retyping shown column i hits the source column of that NAME — and the
//      old by-position rule (the negative control, run on the same input)
//      would have hit a different one.
//   2. A step-made column: a rename becomes a rename_column step (the derived
//      output carries it, output === applyPipeline(source, steps) still holds);
//      a retype is refused with the reason, and nothing is written.
//   3. No pipeline: the by-position edit, exactly as before.
//   4. The same through the shipped `dataset:update` handler.
//
//   npm run build:ts && node scripts/test-columnEdit.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');

const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-coledit-'));
process.env.ORDINATE_LOCAL_DIR = tmpUserData;

const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
const projects: typeof import('../src/app/projects') = require('../src/app/projects');
const transforms: typeof import('../src/data/transforms') = require('../src/data/transforms');
const edit: typeof import('../src/data/columnEdit') = require('../src/data/columnEdit');

type Col = { name: string; type: 'text' | 'number' | 'date' };
const names = (cols: { name: string }[]) => cols.map((c) => c.name).join(',');

(async () => {
  await projects.init();
  const proj = await projects.createProject('Column edits');
  const source: Col[] = [
    { name: 'id', type: 'text' },
    { name: 'secret', type: 'text' },
    { name: 'region', type: 'text' },
    { name: 'amount', type: 'text' },
  ];
  const ds = await datasets.saveDataset(proj.id, {
    name: 'Orders', sourceKind: 'csv', columns: source,
    rows: [['1', 'x', 'East', '10'], ['2', 'y', 'West', '20']],
  });
  if (!ds) throw new Error('fixture not saved');
  // Drop `secret` (every later index shifts left), add a calculated column at the end.
  const steps = [{ type: 'drop_column', column: 'secret' }, { type: 'calculated_field', name: 'tag', expression: 'upper([region])' }];
  const r = await datasets.updateSteps(proj.id, ds.id, steps);
  const shown = r!.dataset.columns as Col[];
  ok('fixture: shown columns are id, region, amount, tag', names(shown) === 'id,region,amount,tag', names(shown));

  // ── 1. Shown index 2 is `amount`: retype it to a number, rename it ──
  const patch = shown.map((c) => (c.name === 'amount' ? { name: 'total', type: 'number' as const } : c));
  const control = edit.resolveColumnEdit(source, source, patch, null); // the old rule: by position against the stored base
  ok('negative control: by position, shown[2] lands on the SOURCE\'s third column (region)', control.columns[2].name === 'total' && source[2].name === 'region');
  const after = await datasets.updateDataset(proj.id, ds.id, { columns: patch });
  const src = after!.source!.columns as Col[];
  ok('by name: the source\'s `amount` became `total`, a number', names(src) === 'id,secret,region,total' && src[3].type === 'number', JSON.stringify(src));
  ok('…and `region` is untouched', src[2].name === 'region' && src[2].type === 'text');
  ok('…its cells were re-coerced to numbers', after!.source!.rows.every((row) => typeof row[3] === 'number'), JSON.stringify(after!.source!.rows));
  ok('…the shown columns follow', names(after!.columns) === 'id,region,total,tag', names(after!.columns));
  const recomputed = transforms.applyPipeline(after!.source!, after!.steps!);
  ok('output === applyPipeline(source, steps)', JSON.stringify(recomputed.rows) === JSON.stringify(after!.rows));

  // ── 2. A step-made column ──
  const rename = after!.columns.map((c) => (c.name === 'tag' ? { ...c, name: 'label' } : c));
  const renamed = await datasets.updateDataset(proj.id, ds.id, { columns: rename });
  const last = renamed!.steps![renamed!.steps!.length - 1] as unknown as Record<string, unknown>;
  ok('a step-made column\'s rename is a rename_column step at the end', last.type === 'rename_column' && last.from === 'tag' && last.to === 'label', JSON.stringify(last));
  ok('…the shown columns carry it, the source does not', names(renamed!.columns) === 'id,region,total,label' && !renamed!.source!.columns.some((c) => c.name === 'label' || c.name === 'tag'));
  const before = await datasets.getDataset(proj.id, ds.id);
  let refused = '';
  try {
    await datasets.updateDataset(proj.id, ds.id, { columns: renamed!.columns.map((c) => (c.name === 'label' ? { ...c, type: 'number' } : c)) });
  } catch (e) {
    refused = e instanceof Error ? e.message : String(e);
  }
  ok('a step-made column\'s retype is refused with the reason', /made by a prepare step/.test(refused), refused);
  const unchanged = await datasets.getDataset(proj.id, ds.id);
  ok('…and nothing was written', JSON.stringify(unchanged) === JSON.stringify(before));

  // ── 3. No pipeline: by position, as before ──
  const plain = await datasets.saveDataset(proj.id, { name: 'Plain', sourceKind: 'csv', columns: [{ name: 'a', type: 'text' }, { name: 'b', type: 'text' }], rows: [['1', '2']] });
  const p2 = await datasets.updateDataset(proj.id, plain!.id, { columns: [{ name: 'a', type: 'text' }, { name: 'bee', type: 'number' }] });
  ok('no pipeline: the second column renamed and retyped', names(p2!.columns) === 'a,bee' && p2!.columns[1].type === 'number' && p2!.rows[0][1] === 2);

  // ── 4. Through the shipped handler ──
  const rpc: typeof import('../src/server/rpc') = require('../src/server/rpc');
  (require('../src/ipc/datasets') as { register: () => void }).register();
  const h = rpc.handlers.get('dataset:update')!;
  const cur = (await datasets.getDatasetMeta(proj.id, ds.id))!.columns;
  const viaRpc = (await h(null, { projectId: proj.id, datasetId: ds.id, columns: cur.map((c) => (c.name === 'region' ? { ...c, name: 'area' } : c)) })) as Record<string, any>; // any: the handler's reply
  const afterRpc = (await datasets.getDataset(proj.id, ds.id))!;
  // `region` is read by the calculated field, so renaming it in the source would leave that step reading nothing.
  ok('dataset:update renames the shown `region` — read by a step, so as a rename step, the step still reading it',
    viaRpc.ok === true && names(afterRpc.source!.columns) === 'id,secret,region,total' && names(afterRpc.columns) === 'id,area,total,label'
      && afterRpc.rows.every((row) => row[3] === String(row[1]).toUpperCase()), JSON.stringify(afterRpc.rows));
  const free = (await datasets.updateDataset(proj.id, ds.id, { columns: afterRpc.columns.map((c) => (c.name === 'id' ? { ...c, name: 'order_id' } : c)) }))!;
  ok('a source column no step reads is renamed in the source itself', names(free.source!.columns) === 'id,secret,region,total'.replace('id,', 'order_id,') && free.steps!.length === afterRpc.steps!.length);
  const refusedRpc = (await h(null, { projectId: proj.id, datasetId: ds.id, columns: cur.map((c) => (c.name === 'label' ? { ...c, type: 'date' } : c)) })) as Record<string, any>; // any: the handler's reply
  ok('dataset:update answers a refused retype with ok:false and the reason', refusedRpc.ok === false && /made by a prepare step/.test(refusedRpc.error), JSON.stringify(refusedRpc));
})()
  .catch((err) => ok('suite ran to completion', false, err instanceof Error ? err.stack : err))
  .finally(() => {
    fs.rmSync(tmpUserData, { recursive: true, force: true });
    finish();
  });
