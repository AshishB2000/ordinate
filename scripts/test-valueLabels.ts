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
//   6. A LIST IS CHECKED, with a sentence for each refusal.
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
ok('collision: the pair is dropped and named', !('valueLabels' in clash.data) && clash.dropped[0] === 'Europe', JSON.stringify(clash));
ok('collision control: a label no other value uses keeps its pair', vl.applyValueLabels({ ...d, labels: ['EU', 'Euro'] }, { category: L }).dropped.length === 0);
const part = vl.applyValueLabels({ ...d, labels: ['EU', 'Europe', 'NA'] }, { category: L });
ok('collision drops only the clashing pair', JSON.stringify(part.data.valueLabels) === '{"category":[["NA","North America"]]}' && part.dropped.join() === 'Europe', JSON.stringify(part));
ok('the Other bucket is the app\'s', !('valueLabels' in vl.applyValueLabels({ ...d, labels: ['Other'] }, { category: [{ value: 'Other', label: 'Misc' }] }, { otherBucket: true }).data));
ok('Other control: without a bucket, a value named Other is a value',
  JSON.stringify(vl.applyValueLabels({ ...d, labels: ['Other'] }, { category: [{ value: 'Other', label: 'Misc' }] }).data.valueLabels) === '{"category":[["Other","Misc"]]}');
ok('exact match: "EU " is not "EU"', !('valueLabels' in vl.applyValueLabels({ ...d, labels: ['EU '] }, { category: L }).data));
ok('exact match: "eu" is not "EU"', !('valueLabels' in vl.applyValueLabels({ ...d, labels: ['eu'] }, { category: L }).data));
ok('a number on the axis is not a text value', !('valueLabels' in vl.applyValueLabels({ ...d, labels: [7] }, { category: [{ value: '7', label: 'Seven' }] }).data));
ok('split legend', JSON.stringify(vl.applyValueLabels({ labels: ['x'], series: [{ name: 'EU', values: [1] }] }, { series: L }).data.valueLabels) === '{"series":[["EU","Europe"]]}');
ok('split legend collides on series names, not on categories',
  vl.applyValueLabels({ labels: ['Europe'], series: [{ name: 'EU', values: [1] }] }, { series: L }).dropped.length === 0
  && vl.applyValueLabels({ labels: ['x'], series: [{ name: 'EU', values: [1] }, { name: 'Europe', values: [1] }] }, { series: L }).dropped[0] === 'Europe');
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

// ── The sentences ───────────────────────────────────────────────────────────
ok('valueListedTwice', msg.valueListedTwice('EU') === '“EU” is listed twice.');
ok('labelShared', msg.labelShared('Europe', 'EU', 'EUR') === '“Europe” would name both “EU” and “EUR”. A label can name one value only.');
ok('tooManyLabels', msg.tooManyLabels(500) === 'A column can have at most 500 value labels.');
ok('labelsTextOnly', msg.labelsTextOnly('amount', 'number') === 'Value labels are for text columns. amount is a number column.');
ok('labelNotShown', msg.labelNotShown('Europe', 'region') === '“Europe” is also a value of region, so its labelled value shows as stored.');
ok('valueBlank', /blank/.test(msg.valueBlank()));
ok('valueTooLong', msg.valueTooLong(256).includes('256'));
ok('labelEmpty', msg.labelEmpty('EU').includes('“EU”'));
// Each problem has a sentence of its own.
const sentences = new Set([
  msg.valueListedTwice('a'), msg.labelShared('l', 'a', 'b'), msg.tooManyLabels(500), msg.valueBlank(), msg.valueTooLong(256), msg.labelEmpty('a'),
]);
ok('six problems, six sentences', sentences.size === 6);

// ── The leaf stays a leaf (the web imports it) ──────────────────────────────
const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'analysis', 'valueLabels.ts'), 'utf8');
ok('valueLabels.ts imports nothing', !/^\s*import\b/m.test(src) && !/\brequire\(/.test(src) && !/\bfrom\s+['"]/.test(src));

finish();
