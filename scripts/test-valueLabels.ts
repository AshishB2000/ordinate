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

  // A save that worked is reported as saved even when the rules read after it fails: the list is withheld instead (fail closed).
  const rowAccess: typeof import('../src/data/rowAccess') = require('../src/data/rowAccess');
  const realClosed = rowAccess.closedToCaller;
  (rowAccess as { closedToCaller: unknown }).closedToCaller = async () => { throw new Error('policy store down'); };
  const afterWrite = await set('region', { values: L });
  const afterAlias = await call('catalog:addAlias', { projectId: P, datasetId: D, column: 'region', alias: 'zone' });
  (rowAccess as { closedToCaller: unknown }).closedToCaller = realClosed;
  ok('a save that worked is not reported as failed when the rules cannot be read after it: saved, the list withheld',
    afterWrite.ok === true && !('values' in afterWrite.column) && afterAlias.ok === true && !('values' in afterAlias.column) && /"Europe"/.test(stored()), json([afterWrite, afterAlias]));
  ok('control: with the rules readable the same save returns the list', json((await set('region', { values: L })).column.values) === json(L));
  await set('region', { values: [] });

  await charts(P);
}

// ── 8. Chart replies, answer cards and captions carry the labels ────────────
// Pairs ride BESIDE the raw values, only for values in that reply, after the Share policy; a reply with none is byte-identical.
require('../src/ipc/visuals').register();
require('../src/ipc/vizSample').register();
require('../src/ipc/copilot').register();
const answers: typeof import('../src/ipc/answers') = require('../src/ipc/answers');
const OTHER_NOTE = categoryKey.OTHER_NOTE;

/** The first path where two replies differ, leaf by leaf with Object.is; '' when none. */
function differ(a: unknown, b: unknown, at = ''): string {
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return Object.is(a, b) ? '' : at || '(root)';
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const d = differ((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], `${at}.${k}`);
    if (d) return d;
  }
  return '';
}

async function charts(P: string): Promise<void> {
  const save = async (name: string, rows: (string | number)[][], pid = P): Promise<string> => (await datasets.saveDataset(pid, {
    name, sourceKind: 'csv', columns: [{ name: 'region', type: 'text' }, { name: 'tier', type: 'text' }, { name: 'amount', type: 'number' }], rows,
  }))!.id;
  const ROWS = [['EU', 'gold', 5], ['NA', 'gold', 3], ['APAC', 'silver', 1], ['EU', 'silver', 2]];
  const S = await save('Sales', ROWS);
  const label = (datasetId: string, column: string, values: unknown) => call('catalog:setColumn', { projectId: P, datasetId, column, patch: { values } });
  ok('setup: region is labelled', (await label(S, 'region', L)).ok === true);
  const M = [{ column: 'amount', aggregation: 'sum' }];
  const enc = { category: 'region', values: M };
  const chart = (datasetId: string, encoding: unknown, extra: object = {}, pid = P): Promise<any> => call('visual:data', { projectId: pid, datasetId, encoding, ...extra });
  const keyless = (r: any): boolean => r.ok === true && !('valueLabels' in r.data);

  const PAIRS = '{"category":[["EU","Europe"],["NA","North America"]]}';
  const byRegion = await chart(S, enc);
  ok('visual:data carries the category\'s labels', byRegion.ok === true && json(byRegion.data.valueLabels) === PAIRS, json(byRegion));
  ok('…beside the raw labels, untouched', byRegion.data.labels.includes('EU') && byRegion.data.labels.includes('APAC') && !byRegion.data.labels.includes('Europe'));
  const geo = await chart(S, { ...enc, geo: { level: 'country' } }, { chartType: 'map_choropleth' });
  ok('a map keeps its region names: no valueLabels', keyless(geo), json(geo).slice(0, 200));
  const pivot = await chart(S, { ...enc, pivot: { rows: [{ column: 'region' }], columns: [], values: M } });
  ok('a pivot keeps its headers: no valueLabels, though its rows are the labelled values', keyless(pivot) && pivot.data.labels.includes('EU'), json(pivot).slice(0, 200));
  const split = await chart(S, { category: 'tier', values: M, series: 'region' });
  ok('a split by region carries the legend\'s labels', split.ok === true && json(split.data.valueLabels) === '{"series":[["EU","Europe"],["NA","North America"]]}', json(split));
  const preview = await call('visual:preview', { projectId: P, datasetId: S, encoding: enc });
  ok('visual:preview carries them too', preview.ok === true && json(preview.data.valueLabels) === PAIRS, json(preview).slice(0, 200));
  const batch = await call('visual:dataBatch', { projectId: P, items: [{ datasetId: S, encoding: enc }] });
  ok('visual:dataBatch carries them too', json(batch[0].data.valueLabels) === PAIRS && json(batch[0]) === json(byRegion));

  // Byte-identical without labels: the same reply as one built with no label list at all (catalog stubbed empty).
  const stubbed = async <T>(fn: () => Promise<T>): Promise<T> => {
    const real = catalog.load;
    (catalog as { load: unknown }).load = async () => catalog.emptyCatalog();
    try { return await fn(); } finally { (catalog as { load: unknown }).load = real; }
  };
  const P2 = (await projects.createProject('no labels')).id;
  const S2 = await save('Sales', ROWS, P2);
  const plain = await chart(S2, enc, {}, P2);
  const plainStub = await stubbed(() => chart(S2, enc, {}, P2));
  ok('a project without labels: the reply is the one built with no label list, key by key (Object.is) and as text', keyless(plain) && differ(plain, plainStub) === '' && json(plain) === json(plainStub), differ(plain, plainStub));
  const { valueLabels: _pairs, ...rawData } = byRegion.data;
  const bare = await stubbed(() => chart(S, enc));
  ok('labels ADD the pairs and change nothing else: the labelled reply minus valueLabels is the unlabelled one', keyless(bare) && differ({ ...byRegion, data: rawData }, bare) === '', differ({ ...byRegion, data: rawData }, bare));
  ok('control: differ sees a difference — the pairs are the one it names', differ(byRegion, bare) === '.data.valueLabels', differ(byRegion, bare));
  ok('an unlabelled column of a labelled project: the same reply', differ(await chart(S, { category: 'tier', values: M }), await stubbed(() => chart(S, { category: 'tier', values: M }))) === '');

  // A label that is also a stored value: two bars would both read "Europe". The pair is left off, and said.
  const C = await save('Sales and a Europe row', [...ROWS, ['Europe', 'gold', 4]]);
  await label(C, 'region', L);
  const clash = await chart(C, enc);
  ok('a row region = "Europe": the pair for EU is gone, the others stay', clash.ok === true && json(clash.data.valueLabels) === '{"category":[["NA","North America"]]}', json(clash));
  ok('…and the warning says why', clash.warnings.includes('“Europe” is also a value of region, so its labelled value shows as stored.'), json(clash.warnings));
  ok('control: without that row no such warning', !byRegion.warnings.some((w: string) => w.includes('also a value')), json(byRegion.warnings));

  // The capped axis's "Other" is the app's bucket, not the stored value Other.
  const K = (await datasets.saveDataset(P, { name: 'Keys', sourceKind: 'csv', columns: [{ name: 'key', type: 'text' }, { name: 'amount', type: 'number' }], rows: Array.from({ length: 60 }, (_, i) => [`k${i}`, 60 - i]) }))!.id;
  await label(K, 'key', [{ value: 'Other', label: 'Misc' }, { value: 'k0', label: 'Key zero' }]);
  const capped = await chart(K, { category: 'key', values: M });
  ok('the capped axis\'s Other bucket gets no pair; a value on it does', capped.ok === true && capped.category?.note === OTHER_NOTE && capped.data.labels.includes('Other')
    && json(capped.data.valueLabels) === '{"category":[["k0","Key zero"]]}', json({ note: capped.category, pairs: capped.data.valueLabels }));
  const O = (await datasets.saveDataset(P, { name: 'Other is a value', sourceKind: 'csv', columns: [{ name: 'key', type: 'text' }, { name: 'amount', type: 'number' }], rows: [['Other', 1], ['k0', 2]] }))!.id;
  await label(O, 'key', [{ value: 'Other', label: 'Misc' }]);
  ok('control: with no cap, a stored value called Other is labelled like any other', json((await chart(O, { category: 'key', values: M })).data.valueLabels) === '{"category":[["Other","Misc"]]}');

  // Share policy first, labels after: a masked region gets no pair, and no raw value rides in the reply.
  await catalog.setColumn(P, S, 'region', { sensitivity: 'personal' });
  const shared = await chart(S, enc, { share: 'export' });
  ok('the Share policy masks region: no valueLabels, and the reply holds neither EU nor Europe', keyless(shared) && !/EU|Europe|North America/.test(json(shared)), json(shared).slice(0, 300));
  ok('control: the same chart in the app carries them', json((await chart(S, enc)).data.valueLabels) === PAIRS);
  await catalog.setColumn(P, S, 'region', { sensitivity: 'none' });

  // An answer card: the text a person reads says the labels; the chart keeps the raw values beside them; the model's facts keep the values (F5).
  const spec = { datasetId: S, category: 'region', measures: M, filters: [], chartType: 'column', title: 'By region' };
  const card = await call('answer:card', { projectId: P, spec });
  ok('answer:card by region: its caption says Europe, not EU', card.ok === true && card.caption.startsWith('Europe') && !/\bEU\b/.test(card.caption), json(card).slice(0, 300));
  ok('…its headline and bullets say the labels', card.headline.some((h: { label: string }) => h.label === 'Highest · Europe') && card.bullets[0].startsWith('Europe is highest')
    && !/\bEU\b|\bNA\b/.test(json([card.headline, card.bullets])), json([card.headline, card.bullets]));
  ok('…its chart keeps the raw labels, the pairs beside them', card.data.labels.includes('EU') && json(card.data.valueLabels) === PAIRS, json(card.data));
  const built = await answers.computeCard(P, spec as never);
  ok('…and the model\'s facts keep the stored values', 'factsText' in built && built.factsText.includes('EU=7') && !built.factsText.includes('Europe'), 'factsText' in built ? built.factsText : json(built));
  const unlabelled = await call('answer:card', { projectId: P2, spec: { ...spec, datasetId: S2 } });
  ok('control: unlabelled, the card says the stored value and carries no pairs', unlabelled.caption.startsWith('EU') && !('valueLabels' in unlabelled.data), json(unlabelled).slice(0, 200));

  // The card's filter text the server writes (the "Filtered to" bullet, the filter chips, the "did you mean" options) says the label too;
  // the step still filters by the raw value, and the model's facts keep it.
  const filtered = { ...spec, filters: [{ column: 'region', op: '=', value: 'EU' }] };
  const fCard = await call('answer:card', { projectId: P, spec: filtered });
  ok('a labelled EU filter: the bullet reads "Filtered to region = Europe", and so does its chip', fCard.ok === true && fCard.bullets.includes('Filtered to region = Europe.') && json(fCard.filterLabels) === '["region = Europe"]', json(fCard).slice(0, 400));
  ok('…while the step filters by the raw value', json(fCard.steps) === '[{"type":"filter","column":"region","op":"=","value":"EU"}]', json(fCard.steps));
  const fBuilt = await answers.computeCard(P, filtered as never);
  ok('…and the model\'s facts keep "region = EU"', 'factsText' in fBuilt && fBuilt.factsText.includes('Filtered to: region = EU.') && !fBuilt.factsText.includes('Europe'), 'factsText' in fBuilt ? fBuilt.factsText : json(fBuilt));
  const fPlainSpec = { projectId: P2, spec: { ...filtered, datasetId: S2 } };
  const fPlain = await call('answer:card', fPlainSpec);
  const fPlainStub = await stubbed(() => call('answer:card', fPlainSpec));
  ok('NEGATIVE CONTROL: no labels, the bullet reads "Filtered to region = EU", byte-identical to a card built with no list', fPlain.bullets.includes('Filtered to region = EU.')
    && json(fPlain.filterLabels) === '["region = EU"]' && differ(fPlain, fPlainStub) === '' && json(fPlain) === json(fPlainStub), differ(fPlain, fPlainStub));
  ok('NEGATIVE CONTROL: …its keys in the order the card always had', Object.keys(fPlain).join() === 'ok,spec,title,chartType,datasetName,data,caption,headline,bullets,chips,filterLabels,steps,notes,asOf', Object.keys(fPlain).join());
  // (A code under MIN_LOOSE characters is never suggested, so this one is longer.)
  const LONG = `Region code ${'x'.repeat(90)}`; // longer than an option's 80-character cut
  const E = (await datasets.saveDataset(P, { name: 'Codes', sourceKind: 'csv', columns: [{ name: 'key', type: 'text' }, { name: 'amount', type: 'number' }], rows: [['EMEA', 1], ['APAC', 2], [LONG, 3]] }))!.id;
  await label(E, 'key', [{ value: 'EMEA', label: 'Europe and Africa' }, { value: LONG, label: 'Long region' }]);
  const near = await call('answer:card', { projectId: P, spec: { ...spec, datasetId: E, category: 'key', filters: [{ column: 'key', op: '=', value: 'EME' }] } });
  ok('a value not stored: the "did you mean" option says the label, and picks the raw value', near.noMatch?.options.length === 1
    && near.noMatch.options[0].label === 'Europe and Africa' && json(near.noMatch.options[0].spec.filters) === '[{"column":"key","op":"=","value":"EMEA"}]', json(near.noMatch));
  ok('…while the filter it fixes says what was asked: "EME" is no stored value, so it has no label', json(near.filterLabels) === '["key = EME"]', json(near.filterLabels));
  const nearLong = await call('answer:card', { projectId: P, spec: { ...spec, datasetId: E, category: 'key', filters: [{ column: 'key', op: '=', value: LONG.slice(0, 85) }] } });
  ok('a "did you mean" over 80 characters is looked up by the whole stored value: it says its label', nearLong.noMatch?.options[0]?.label === 'Long region'
    && nearLong.noMatch.options[0].spec.filters[0].value === LONG, json(nearLong.noMatch).slice(0, 300));
  // A spelling the steps fix ("eu" → EU) is said by the label of the value it is; a value MATCHED to a stored one is noted by its label.
  const caseFixed = await call('answer:card', { projectId: P, spec: { ...spec, filters: [{ column: 'region', op: '=', value: 'eu ' }] } });
  ok('a case-fixed filter value is said by its label; the step holds the stored value', json(caseFixed.filterLabels) === '["region = Europe"]' && caseFixed.steps[0].value === 'EU', json([caseFixed.filterLabels, caseFixed.steps]));
  // Loose, as answer:rerun and a model's spec are (computeCard's `loose`): "EME" is matched to EMEA.
  const rerun = await answers.computeCard(P, { ...spec, datasetId: E, category: 'key', filters: [{ column: 'key', op: '=', value: 'EME' }] } as never, true);
  const matched = 'card' in rerun ? rerun.card : null;
  ok('a value matched to a stored one: the note and the chip name its label, the step keeps the value', !!matched
    && matched.notes.some((n: string) => n.includes('Europe and Africa') && !n.includes('EMEA')) && json(matched.filterLabels) === '["key = Europe and Africa"]' && matched.steps[0].value === 'EMEA', json(matched ? [matched.notes, matched.filterLabels] : rerun));

  // A card's label that is also a stored value is left off, and the card says why, as a chart reply does.
  const clashCard = await call('answer:card', { projectId: P, spec: { ...spec, datasetId: C } });
  ok('a card whose label is also a stored value: the pair is left off and the note says why', json(clashCard.data.valueLabels) === '{"category":[["NA","North America"]]}'
    && clashCard.notes.includes('“Europe” is also a value of region, so its labelled value shows as stored.'), json([clashCard.data.valueLabels, clashCard.notes]));
  ok('control: without that row the card has no such note', !card.notes.some((n: string) => n.includes('also a value')), json(card.notes));
  // …and so does a FILTER's label: "Filtered to region = Europe" would not say which.
  const clashFilter = await call('answer:card', { projectId: P, spec: { ...spec, datasetId: C, category: 'tier', filters: [{ column: 'region', op: '=', value: 'EU' }] } });
  ok('a filter whose label is also a stored value says the value, and the card notes why', json(clashFilter.filterLabels) === '["region = EU"]'
    && clashFilter.notes.filter((n: string) => n === '“Europe” is also a value of region, so its labelled value shows as stored.').length === 1, json([clashFilter.filterLabels, clashFilter.notes]));
  ok('control: a filter on a label no value shares has no such note', !fCard.notes.some((n: string) => n.includes('also a value')), json(fCard.notes));
  const bothClash = await call('answer:card', { projectId: P, spec: { ...spec, datasetId: C, filters: [{ column: 'region', op: 'in', values: ['EU', 'Europe'] }] } });
  ok('the axis and the filter leaving off one label say it once', bothClash.notes.filter((n: string) => n.includes('also a value')).length === 1, json(bothClash.notes));

  // Which lists a chart reads (labelListsFor): its category's and its split's, text columns only, never the six raw-valued kinds.
  const replies: typeof import('../src/ipc/valueLabelReplies') = require('../src/ipc/valueLabelReplies');
  const lists = (e: object): Promise<string> => replies.labelListsFor(P, S, e as never).then(json);
  ok('labelListsFor: the category\'s list, and the split\'s', await lists(enc) === json({ category: L }) && await lists({ category: 'tier', values: M, series: 'region' }) === json({ series: L }));
  for (const kind of ['geo', 'pivot', 'cohort', 'eventFunnel', 'facet', 'drivers']) {
    ok(`labelListsFor: nothing for a ${kind} chart`, await lists({ ...enc, series: 'region', [kind]: {} }) === '{}');
  }
  await catalog.setColumn(P, S, 'amount', { values: [{ value: '5', label: 'Five' }] }); // the store knows no types: a list left on a column that is not text
  ok('labelListsFor: a column not declared text gets none, though a list is stored for it', await lists({ category: 'amount', values: M }) === '{}');
  const R = await save('Regions', ROWS);
  await label(R, 'region', [{ value: 'EU', label: 'Europa' }]);
  ok('labelListsFor: a category or split from another dataset reads that dataset\'s list',
    await lists({ ...enc, categoryDatasetId: R }) === '{"category":[{"value":"EU","label":"Europa"}]}'
    && await lists({ category: 'tier', values: M, series: 'region', seriesDatasetId: R }) === '{"series":[{"value":"EU","label":"Europa"}]}');
  let loads = 0;
  let metas = 0;
  const realLoad = catalog.load;
  const realMeta = datasets.getDatasetMeta;
  (catalog as { load: unknown }).load = (pid: string) => { loads += 1; return realLoad(pid); };
  (datasets as { getDatasetMeta: unknown }).getDatasetMeta = (pid: string, id: string) => { metas += 1; return realMeta(pid, id); };
  await lists({ ...enc, series: 'region', seriesDatasetId: R });
  const both = [loads, metas];
  loads = 0; metas = 0;
  await lists({ category: 'tier', values: M });
  (catalog as { load: unknown }).load = realLoad;
  (datasets as { getDatasetMeta: unknown }).getDatasetMeta = realMeta;
  ok('labelListsFor: ONE catalog read for both axes, a meta read per labelled dataset; none for a column without labels', json(both) === '[1,2]' && loads === 1 && metas === 0, json([both, loads, metas]));
}

void main()
  .catch((err: unknown) => { ok('unexpected error', false, err instanceof Error ? err.stack : err); })
  .then(() => {
    try { fs.rmSync(tmpUserData, { recursive: true, force: true }); } catch { /* best effort */ }
    finish();
  });
