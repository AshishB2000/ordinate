// Self-check for VALUE LABELS, the pure rules (semantic layer, PR 06): which pairs a chart reply
// carries, how a shown text goes back to the stored value, and what a list may not contain.
// src/analysis/valueLabels.ts is a LEAF the web imports, so nothing here may need a Node module.
//
// What is pinned here, and why each would break quietly:
//   1. PAIRS ARE THE REPLY'S. A pair only for a raw value that is on the axis; a reply with none carries no
//      `valueLabels` key at all (replies and golden fixtures stay byte-identical).
//   2. EXACT MATCH. `'EU '` is not `'EU'`.
//   3. A LABEL NEVER MAKES TWO BARS ONE. A label equal to another stored value on the axis drops the pair and
//      is returned so the caller can warn.
//   4. THE "OTHER" BUCKET IS THE APP'S, and the leaf's copy of its name is categoryKey's.
//   5. SHOWN AND RAW. `shownChart` draws labels; `rawOf` goes back; a value named `__proto__` is a value.
//   6. A LIST IS CHECKED, with a sentence for each refusal. What the check passes, the store keeps
//      unchanged (differential against sanitizeValueLabels).
//   7. A SAVE REFUSES, it never drops quietly: `catalog:setColumn { values }` over the real handlers
//      stores a text column's list (labels trimmed, values verbatim), and any refusal saves NOTHING
//      of the patch. A number column, a column the dataset lacks, a merge, a repeat, a blank, a cap.
//
//   npm run build:ts && node scripts/test-valueLabels.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import * as categoryKey from '../src/analysis/categoryKey';
import * as vl from '../src/analysis/valueLabels';
import * as msg from '../src/analysis/valueLabelMessages';

const fs: typeof import('fs') = require('fs');
const path: typeof import('path') = require('path');

// ── 1. The pairs a reply carries ────────────────────────────────────────────
const L = [{ value: 'EU', label: 'Europe' }, { value: 'NA', label: 'North America' }];
const d = { labels: ['EU', 'APAC', 'NA'], series: [{ name: 'sum of amount', values: [1, 2, 3] }] };
const r = vl.applyValueLabels(d, { category: L });
ok('pairs only for values in the reply', JSON.stringify(r.data.valueLabels) === '{"category":[["EU","Europe"],["NA","North America"]]}');
ok('raw labels untouched', JSON.stringify(r.data.labels) === '["EU","APAC","NA"]');
ok('no labels → no valueLabels key', !('valueLabels' in vl.applyValueLabels(d, {}).data));
ok('an empty list → no valueLabels key', !('valueLabels' in vl.applyValueLabels(d, { category: [], series: [] }).data));
ok('a value not in the reply gets no pair', !('valueLabels' in vl.applyValueLabels({ ...d, labels: ['APAC'] }, { category: L }).data));
ok('a reply with no pair is the same object', vl.applyValueLabels(d, {}).data === d);
const clash = vl.applyValueLabels({ ...d, labels: ['EU', 'Europe'] }, { category: L });
ok('collision: the pair is dropped and named, with its axis', !('valueLabels' in clash.data) && JSON.stringify(clash.dropped) === '[{"label":"Europe","axis":"category"}]', JSON.stringify(clash));
ok('collision control: a label no other value uses keeps its pair', vl.applyValueLabels({ ...d, labels: ['EU', 'Euro'] }, { category: L }).dropped.length === 0);
const part = vl.applyValueLabels({ ...d, labels: ['EU', 'Europe', 'NA'] }, { category: L });
ok('collision drops only the clashing pair', JSON.stringify(part.data.valueLabels) === '{"category":[["NA","North America"]]}' && part.dropped.map((x) => x.label).join() === 'Europe', JSON.stringify(part));
ok('the Other bucket is the app\'s', !('valueLabels' in vl.applyValueLabels({ ...d, labels: ['Other'] }, { category: [{ value: 'Other', label: 'Misc' }] }, { otherBucket: true }).data));
ok('Other control: without a bucket, a value named Other is a value',
  JSON.stringify(vl.applyValueLabels({ ...d, labels: ['Other'] }, { category: [{ value: 'Other', label: 'Misc' }] }).data.valueLabels) === '{"category":[["Other","Misc"]]}');
// The bucket is the app's the other way too: a stored label may not rename it.
const rename = vl.applyValueLabels({ ...d, labels: ['misc', 'Other'] }, { category: [{ value: 'misc', label: 'Other' }] }, { otherBucket: true });
ok('the Other bucket is the app\'s: a stored label cannot rename it', !('valueLabels' in rename.data) && JSON.stringify(rename.dropped) === '[{"label":"Other","axis":"category"}]', JSON.stringify(rename));
ok('Other control: with no bucket on the axis, "Other" is a label like any other',
  JSON.stringify(vl.applyValueLabels({ ...d, labels: ['misc'] }, { category: [{ value: 'misc', label: 'Other' }] }, { otherBucket: true }).data.valueLabels) === '{"category":[["misc","Other"]]}');
// A value labelled as itself says nothing: no pair, so a reply with nothing to show carries no key.
const selfPair = vl.applyValueLabels(d, { category: [{ value: 'EU', label: 'EU' }] });
ok('a value labelled as itself has no pair, and the reply is the same object', selfPair.data === d && !('valueLabels' in selfPair.data) && selfPair.dropped.length === 0, JSON.stringify(selfPair));
ok('self-pair control: beside a real pair only the real one rides',
  JSON.stringify(vl.applyValueLabels(d, { category: [{ value: 'EU', label: 'EU' }, { value: 'NA', label: 'North America' }] }).data.valueLabels) === '{"category":[["NA","North America"]]}');
ok('exact match: "EU " is not "EU"', !('valueLabels' in vl.applyValueLabels({ ...d, labels: ['EU '] }, { category: L }).data));
ok('exact match: "eu" is not "EU"', !('valueLabels' in vl.applyValueLabels({ ...d, labels: ['eu'] }, { category: L }).data));
ok('a number on the axis is not a text value', !('valueLabels' in vl.applyValueLabels({ ...d, labels: [7] }, { category: [{ value: '7', label: 'Seven' }] }).data));
ok('split legend', JSON.stringify(vl.applyValueLabels({ labels: ['x'], series: [{ name: 'EU', values: [1] }] }, { series: L }).data.valueLabels) === '{"series":[["EU","Europe"]]}');
ok('split legend collides on series names, not on categories',
  vl.applyValueLabels({ labels: ['Europe'], series: [{ name: 'EU', values: [1] }] }, { series: L }).dropped.length === 0
  && JSON.stringify(vl.applyValueLabels({ labels: ['x'], series: [{ name: 'EU', values: [1] }, { name: 'Europe', values: [1] }] }, { series: L }).dropped) === '[{"label":"Europe","axis":"series"}]');
const twice = vl.applyValueLabels({ labels: ['EU', 'Europe'], series: [{ name: 'NA', values: [1] }, { name: 'North America', values: [1] }] }, { category: L, series: L });
ok('dropped names the axis of each clash, so a warning can name the column', JSON.stringify(twice.dropped) === '[{"label":"Europe","axis":"category"},{"label":"North America","axis":"series"}]' && !('valueLabels' in twice.data), JSON.stringify(twice));
const both = vl.applyValueLabels({ labels: ['EU'], series: [{ name: 'NA', values: [1] }] }, { category: L, series: L });
ok('both axes at once', JSON.stringify(both.data.valueLabels) === '{"category":[["EU","Europe"]],"series":[["NA","North America"]]}');
ok('other keys of the reply ride along', (vl.applyValueLabels({ ...d, geo: 1, dataShape: 'x' }, { category: L }).data as { geo?: number }).geo === 1);

// ── 4. The leaf's copy of "Other" is categoryKey's ──────────────────────────
ok('drift guard: the leaf\'s Other IS categoryKey\'s', vl.VL_OTHER_LABEL === categoryKey.OTHER_LABEL, `${vl.VL_OTHER_LABEL} ${categoryKey.OTHER_LABEL}`);

// ── 5. Shown and raw ────────────────────────────────────────────────────────
ok('shownChart', JSON.stringify(vl.shownChart(r.data)) === JSON.stringify({ labels: ['Europe', 'APAC', 'North America'], series: d.series }));
ok('shownChart without pairs is the reply', vl.shownChart(d) === d);
ok('shownChart names a legend', JSON.stringify(vl.shownChart(vl.applyValueLabels({ labels: ['x'], series: [{ name: 'EU', values: [1] }, { name: 'sum', values: [2], role: 'overlay' as const }] }, { series: L }).data))
  === JSON.stringify({ labels: ['x'], series: [{ name: 'Europe', values: [1] }, { name: 'sum', values: [2], role: 'overlay' }] }));
ok('shownChart leaves the stored reply alone', JSON.stringify(r.data.labels) === '["EU","APAC","NA"]');
ok('rawOf inverts, and passes an unlabelled value through', vl.rawOf('Europe', r.data.valueLabels!.category) === 'EU' && vl.rawOf('APAC', r.data.valueLabels!.category) === 'APAC');
ok('rawOf with no pairs is the text', vl.rawOf('Europe') === 'Europe' && vl.rawOf(5, [['5', 'x']]) === 5);
ok('shownText with no pairs is a copy', JSON.stringify(vl.shownText(['a', 1])) === '["a",1]');
ok('shownText leaves a number alone', vl.shownText([5], [['5', 'Five']])[0] === 5);
ok('a value named __proto__ is a value', vl.shownText(['__proto__'], [['__proto__', 'P']])[0] === 'P');
ok('a value named __proto__ goes back', vl.rawOf('P', [['__proto__', 'P']]) === '__proto__');
ok('a value named constructor is not a hit', vl.shownText(['constructor'], [['EU', 'Europe']])[0] === 'constructor');
ok('a pair for __proto__ rides the reply', JSON.stringify(vl.applyValueLabels({ labels: ['__proto__'], series: [] }, { category: [{ value: '__proto__', label: 'P' }] }).data.valueLabels) === '{"category":[["__proto__","P"]]}');

// ── 6. What a list may not contain ──────────────────────────────────────────
const kind = (list: vl.ValueLabel[]): string | undefined => vl.valueLabelProblem(list)?.kind;
ok('problems', vl.valueLabelProblem([...L, { value: 'EU', label: 'x' }])?.kind === 'repeatValue'
  && vl.valueLabelProblem([...L, { value: 'EUR', label: 'Europe' }])?.kind === 'sharedLabel'
  && vl.valueLabelProblem(Array.from({ length: 501 }, (_, i) => ({ value: `v${i}`, label: `l${i}` })))?.kind === 'tooMany'
  && vl.valueLabelProblem(L) === null);
ok('problem names what is wrong', JSON.stringify(vl.valueLabelProblem([...L, { value: 'EU', label: 'x' }])) === '{"kind":"repeatValue","value":"EU"}'
  && JSON.stringify(vl.valueLabelProblem([...L, { value: 'EUR', label: 'Europe' }])) === '{"kind":"sharedLabel","label":"Europe","values":["EU","EUR"]}');
ok('exactly 500 is allowed, 501 is not', kind(Array.from({ length: 500 }, (_, i) => ({ value: `v${i}`, label: `l${i}` }))) === undefined
  && kind(Array.from({ length: 501 }, (_, i) => ({ value: `v${i}`, label: `l${i}` }))) === 'tooMany');
ok('an empty list is fine', vl.valueLabelProblem([]) === null);
ok('"EU" and "EU " are two values', vl.valueLabelProblem([{ value: 'EU', label: 'a' }, { value: 'EU ', label: 'b' }]) === null);
ok('a label is compared trimmed', kind([{ value: 'a', label: 'Europe' }, { value: 'b', label: ' Europe ' }]) === 'sharedLabel');
ok('a whitespace-only value is refused', kind([{ value: '  ', label: 'x' }]) === 'blankValue' && kind([{ value: '', label: 'x' }]) === 'blankValue');
ok('a value over 256 is refused, 256 is not', kind([{ value: 'v'.repeat(vl.MAX_VALUE_LEN + 1), label: 'x' }]) === 'valueTooLong'
  && kind([{ value: 'v'.repeat(vl.MAX_VALUE_LEN), label: 'x' }]) === undefined);
ok('a label empty after trimming is refused', JSON.stringify(vl.valueLabelProblem([{ value: 'EU', label: '   ' }])) === '{"kind":"emptyLabel","value":"EU"}');
ok('a value is not trimmed before it is kept: " EU" is a value', kind([{ value: ' EU', label: 'a' }]) === undefined);

// What the check passes, the store keeps: DIFFERENTIAL against sanitizeValueLabels over lists built from the awkward cases
// (case, padding, blank, the length edges, a label clipped into another). A refusal is exactly what the reader would drop.
let seed = 7;
const roll = (n: number): number => (seed = (seed * 1103515245 + 12345) % 2147483648) % n;
const V = ['a', 'A', ' a', 'a ', '', '  ', 'b', 'v'.repeat(vl.MAX_VALUE_LEN), 'v'.repeat(vl.MAX_VALUE_LEN + 1)];
const T = ['L', 'l', ' L ', '', '   ', 'M', 'y'.repeat(vl.MAX_LABEL_LEN), 'y'.repeat(vl.MAX_LABEL_LEN + 1), 'y'.repeat(vl.MAX_LABEL_LEN + 2)];
const disagree: string[] = [];
let passed = 0;
let refused = 0;
for (let i = 0; i < 4000; i++) {
  const list = Array.from({ length: roll(6) }, () => ({ value: V[roll(V.length)], label: T[roll(T.length)] }));
  const kept = vl.sanitizeValueLabels(list);
  const asStored = list.map((r) => ({ value: r.value, label: r.label.trim().slice(0, vl.MAX_LABEL_LEN) }));
  const problem = vl.valueLabelProblem(list);
  if (problem === null) passed += 1; else refused += 1;
  const agree = problem === null ? JSON.stringify(kept) === JSON.stringify(asStored) : kept.length < list.length;
  if (!agree) disagree.push(JSON.stringify({ list, problem, kept }));
}
ok('differential: a list the check passes is stored unchanged (after trim and clip); one it refuses loses a row', disagree.length === 0, disagree[0]);
ok('differential control: the lists drawn include both passing and refused ones', passed > 100 && refused > 100, `${passed} passed, ${refused} refused`);
const over = Array.from({ length: vl.MAX_VALUE_LABELS + 1 }, (_, i) => ({ value: `v${i}`, label: `l${i}` }));
ok('differential: 501 rows are refused and the store would keep 500', vl.valueLabelProblem(over)?.kind === 'tooMany' && vl.sanitizeValueLabels(over).length === vl.MAX_VALUE_LABELS);

// ── The sentences ───────────────────────────────────────────────────────────
ok('valueListedTwice', msg.valueListedTwice('EU') === '“EU” is listed twice.');
ok('labelShared', msg.labelShared('Europe', 'EU', 'EUR') === '“Europe” would name both “EU” and “EUR”. A label can name one value only.');
ok('tooManyLabels', msg.tooManyLabels(500) === 'A column can have at most 500 value labels.');
ok('labelsTextOnly', msg.labelsTextOnly('amount', 'number') === 'Value labels are for text columns. amount is a number column.');
ok('labelNotShown', msg.labelNotShown('Europe', 'region') === '“Europe” is also a value of region, so its labelled value shows as stored.');
ok('valueBlank', /blank/.test(msg.valueBlank()));
ok('valueTooLong', msg.valueTooLong(256).includes('256'));
ok('labelEmpty', msg.labelEmpty('EU').includes('“EU”'));
ok('labelColumnGone', msg.labelColumnGone('gone') === '“gone” is not a column of this dataset.');
// Each problem has a sentence of its own, and the switch covers all six kinds.
const problems: [vl.ValueLabelProblem, string][] = [
  [{ kind: 'repeatValue', value: 'a' }, msg.valueListedTwice('a')],
  [{ kind: 'sharedLabel', label: 'l', values: ['a', 'b'] }, msg.labelShared('l', 'a', 'b')],
  [{ kind: 'tooMany' }, msg.tooManyLabels(vl.MAX_VALUE_LABELS)],
  [{ kind: 'blankValue' }, msg.valueBlank()],
  [{ kind: 'valueTooLong', value: 'a' }, msg.valueTooLong(vl.MAX_VALUE_LEN)],
  [{ kind: 'emptyLabel', value: 'a' }, msg.labelEmpty('a')],
];
ok('valueLabelProblemText says each of the six in its own sentence', problems.every(([p, said]) => msg.valueLabelProblemText(p) === said) && new Set(problems.map(([, said]) => said)).size === 6);

// ── The leaf stays a leaf (the web imports it) ──────────────────────────────
const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'analysis', 'valueLabels.ts'), 'utf8');
ok('valueLabels.ts imports nothing', !/^\s*import\b/m.test(src) && !/\brequire\(/.test(src) && !/\bfrom\s+['"]/.test(src));

// ── 7. Saving: the real handlers over a scratch project ─────────────────────
const os: typeof import('os') = require('os');
const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-valuelabels-'));
process.env.ORDINATE_LOCAL_DIR = tmpUserData;
type IpcHandler = (event: unknown, payload?: unknown) => Promise<any>; // any: each channel's own reply
const handlers: Map<string, IpcHandler> = require('../src/server/rpc').handlers;
const projects: typeof import('../src/app/projects') = require('../src/app/projects');
const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
const catalog: typeof import('../src/app/catalog') = require('../src/app/catalog');
const api: typeof import('../src/api/index') = require('../src/api/index');
require('../src/ipc/catalog').register();
const call = (ch: string, payload: unknown): Promise<any> => handlers.get(ch)!({}, payload);
const json = (v: unknown): string => JSON.stringify(v);

async function main(): Promise<void> {
  await projects.init();
  await datasets.init();
  const P = (await projects.createProject('value labels')).id;
  const orders = (await datasets.saveDataset(P, {
    name: 'Orders', sourceKind: 'csv',
    columns: [{ name: 'region', type: 'text' }, { name: 'amount', type: 'number' }, { name: 'zip', type: 'text' }],
    rows: [['EU', 1, '02134'], ['NA', 2, '10001']],
  }))!;
  const D = orders.id;
  const set = (column: string, patch: unknown): Promise<any> => call('catalog:setColumn', { projectId: P, datasetId: D, column, patch });
  const cols = async (): Promise<Record<string, { values?: unknown; description: string }>> => (await call('catalog:columns', { projectId: P, datasetId: D })).columns;
  const stored = (): string => fs.readFileSync(path.join(tmpUserData, 'projects', P, 'catalog.json'), 'utf8');

  // The contract: strict rows, and the leaf's caps.
  const input = api.contracts['catalog:setColumn'].input;
  const accepts = (values: unknown): boolean => input.safeParse({ projectId: P, datasetId: D, column: 'region', patch: { values } }).success;
  const rows = (n: number): { value: string; label: string }[] => Array.from({ length: n }, (_, i) => ({ value: `v${i}`, label: `l${i}` }));
  ok('contract: values is an optional list, [] included', accepts(L) && accepts([]) && input.safeParse({ projectId: P, datasetId: D, column: 'region', patch: { description: 'x' } }).success);
  ok('contract: a row is {value, label} and nothing else', !accepts([{ value: 'EU', label: 'x', extra: 1 }]) && !accepts([{ value: 'EU' }]) && !accepts('EU'));
  ok('contract: caps are the leaf\'s — 500 rows, a value of 1 to 256, a label to 120',
    accepts(rows(vl.MAX_VALUE_LABELS)) && !accepts(rows(vl.MAX_VALUE_LABELS + 1))
    && accepts([{ value: 'v'.repeat(vl.MAX_VALUE_LEN), label: 'x' }]) && !accepts([{ value: 'v'.repeat(vl.MAX_VALUE_LEN + 1), label: 'x' }]) && !accepts([{ value: '', label: 'x' }])
    && accepts([{ value: 'a', label: 'l'.repeat(vl.MAX_LABEL_LEN) }]) && !accepts([{ value: 'a', label: 'l'.repeat(vl.MAX_LABEL_LEN + 1) }]));

  // Save, read back.
  ok('nothing is labelled yet: no values key on the column docs', !('values' in ((await cols()).region ?? {})));
  const saved = await set('region', { values: L });
  ok('setColumn stores value labels', saved.ok === true && json(saved.column.values) === json(L), json(saved));
  ok('catalog:columns reads them back', json((await cols()).region.values) === json(L));

  // Refusals: a sentence, and NOTHING of the patch saved (the description beside it too).
  const refuses = async (label: string, column: string, values: unknown, sentence: string): Promise<void> => {
    const before = stored();
    const r = await set(column, { description: 'half a patch', values });
    ok(`refused: ${label}`, r.ok === false && r.error === sentence, json(r));
    ok(`refused: ${label} — nothing of the patch is saved`, stored() === before && (await cols())[column]?.description !== 'half a patch');
  };
  await refuses('two values with one label', 'region', [...L, { value: 'EUR', label: 'Europe' }], '“Europe” would name both “EU” and “EUR”. A label can name one value only.');
  ok('…and the list that was saved still stands', json((await cols()).region.values) === json(L));
  await refuses('a value listed twice', 'region', [{ value: 'EU', label: 'a' }, { value: 'EU', label: 'b' }], '“EU” is listed twice.');
  await refuses('a blank value', 'region', [{ value: '  ', label: 'x' }], 'A value cannot be blank.');
  await refuses('a value over 256 characters (a sentence, not only zod\'s 400)', 'region', [{ value: 'v'.repeat(vl.MAX_VALUE_LEN + 1), label: 'x' }], 'A value can have at most 256 characters.');
  await refuses('a label empty once trimmed', 'region', [{ value: 'EU', label: '   ' }], '“EU” needs a label.');
  await refuses('a number column', 'amount', L, 'Value labels are for text columns. amount is a number column.');
  await refuses('a column the dataset does not have', 'gone', L, '“gone” is not a column of this dataset.');
  const ghost = await call('catalog:setColumn', { projectId: P, datasetId: '33333333-3333-4333-8333-333333333333', column: 'region', patch: { values: L } });
  ok('refused: a dataset that does not exist is a column that is not there', ghost.ok === false && ghost.error === '“region” is not a column of this dataset.', json(ghost));
  const tooMany = await catalog.setColumn(P, D, 'region', { values: rows(vl.MAX_VALUE_LABELS + 1) }).then(() => 'saved', (e: Error) => e.message);
  ok('refused: the store backs the contract — 501 rows are a sentence, not a quiet cut to 500', tooMany === 'A column can have at most 500 value labels.', tooMany);
  ok('control: exactly 500 rows are stored whole', (await catalog.setColumn(P, D, 'zip', { values: rows(vl.MAX_VALUE_LABELS) }))?.values?.length === vl.MAX_VALUE_LABELS);
  ok('control: "EU" and "EU " are two values, each stored as typed', json((await set('zip', { values: [{ value: 'EU', label: 'a' }, { value: 'EU ', label: 'b' }] })).column.values) === '[{"value":"EU","label":"a"},{"value":"EU ","label":"b"}]');
  await set('zip', { values: [] });

  // What is stored.
  const padded = await set('region', { values: [{ value: 'EU ', label: '  Europe  ' }] });
  ok('a label is stored trimmed, a value verbatim', padded.ok === true && json(padded.column.values) === '[{"value":"EU ","label":"Europe"}]', json(padded));
  ok('a leading-zero code stays text: "02134" is a value as typed', json((await set('zip', { values: [{ value: '02134', label: 'Boston' }] })).column.values) === '[{"value":"02134","label":"Boston"}]');
  await set('region', { values: L });
  ok('a later patch of another field keeps the list', (await set('region', { description: 'x' })).column.values?.length === 2 && json((await cols()).region.values) === json(L));
  ok('"Also called" keeps the list too', json((await set('region', { aliases: ['area'] })).column.values) === json(L));
  const added = await call('catalog:addAlias', { projectId: P, datasetId: D, column: 'region', alias: 'territory' });
  ok('catalog:addAlias keeps the list, and an open caller reads it back in the reply', added.ok === true && json(added.column.values) === json(L), json(added));
  ok('a values patch leaves the other fields as they were', (await set('region', { values: L })).column.description === 'x');
  const list2 = [{ value: 'EU', label: 'Europe' }, { value: 'EMEA', label: 'Middle East' }];
  ok('the list is REPLACED, not merged', json((await set('region', { values: list2 })).column.values) === json(list2));
  ok('a value named __proto__ is a value', json((await set('region', { values: [{ value: '__proto__', label: 'P' }] })).column.values) === '[{"value":"__proto__","label":"P"}]');

  // Removing.
  await set('zip', { values: [] });
  const cleared = await set('region', { values: [] });
  ok('[] removes the list: no values key in the reply, the read or the file', cleared.ok === true && !('values' in cleared.column) && !('values' in (await cols()).region) && !/"values"/.test(stored()), json(cleared));
  await set('amount', { description: 'money' });
  ok('[] is allowed on a column that is not text (a stale list can always be removed)', (await set('amount', { values: [] })).ok === true);
  ok('a patch with no values never writes the key', !/"values"/.test(stored()));
}

void main()
  .catch((err: unknown) => { ok('unexpected error', false, err instanceof Error ? err.stack : err); })
  .then(() => {
    try { fs.rmSync(tmpUserData, { recursive: true, force: true }); } catch { /* best effort */ }
    finish();
  });
