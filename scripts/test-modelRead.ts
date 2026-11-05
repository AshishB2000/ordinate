// Reading model files back (semantic layer part 7, a2 Task 1; docs/semantic-layer/07-portability.md D4, D5), over
// ./modelFixture.ts. An upload is untrusted: the zip reader with MODEL_POLICY (names, caps, no encryption or data
// descriptor), each JSON entry through the value budget, each object through a whitelist reader.
//
// 1. a1's export reads back to the same shapes, from the files and from its zip.
// 2. The whole file is refused: an unknown entry, a path outside the layout, no or a broken model.json, another format,
//    a newer formatVersion, an entry past its cap, past the value budget, an encrypted entry, a data descriptor.
// 3. One bad object is one invalid item, never a refusal: not JSON, not an object, a bad id, a wrong type, a repeated
//    id, a guide past 8,000 characters (its dataset with it). Unknown keys are dropped.
//
//   npm run build:ts && node scripts/test-modelRead.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import { H, close } from './liveRouteHarness';
import { buildModelFixture, GUIDE } from './modelFixture';
import type { ParsedModel } from '../src/app/modelRead';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');
const { exportModel }: typeof import('../src/app/modelExport') = require('../src/app/modelExport');
const { modelZip }: typeof import('../src/ipc/modelFiles') = require('../src/ipc/modelFiles');
const { readModelFiles, readModelZip }: typeof import('../src/app/modelRead') = require('../src/app/modelRead');
const { stableStringify }: typeof import('../src/engine/queryCache') = require('../src/engine/queryCache');
const msg: typeof import('../src/app/modelFileMessages') = require('../src/app/modelFileMessages');

type Files = Map<string, string>;
const withEntry = (files: Files, p: string, text: string): Files => new Map([...files, [p, text]]);
const without = (files: Files, p: string): Files => new Map([...files].filter(([k]) => k !== p));
const edit = (files: Files, p: string, change: (o: Record<string, any>) => void): Files => { // any: a model file, edited as git would
  const o = JSON.parse(files.get(p) as string);
  change(o);
  return withEntry(files, p, JSON.stringify(o));
};
const refusedOf = (r: ParsedModel | { refused: string }): string => ('refused' in r ? r.refused : '');
const parsedOf = (r: ParsedModel | { refused: string }): ParsedModel => {
  if ('refused' in r) throw new Error(`refused: ${r.refused}`);
  return r;
};

/** The first central-directory entry's general-purpose flags OR-ed with `bit`: what a forged upload carries. */
function forged(zip: Buffer, bit: number): Buffer {
  const out = Buffer.from(zip);
  const at = out.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  out.writeUInt16LE(out.readUInt16LE(at + 8) | bit, at + 8);
  return out;
}

(async () => {
  const F = await buildModelFixture();
  const { files } = await H.as(H.ORG_A, () => exportModel(F.P));
  const parsedFiles = (prefix: string): unknown[] => [...files.keys()].filter((p) => p.startsWith(prefix) && p.endsWith('.json')).sort().map((p) => JSON.parse(files.get(p) as string));
  const read = (f: Files) => H.as(H.ORG_A, () => readModelFiles(f));

  // ── 1. Round trip ─────────────────────────────────────────────────────────
  const back = parsedOf(await read(files));
  ok('a1 export reads back to the same shapes', stableStringify(back.metrics) === stableStringify(parsedFiles('metrics/')) && stableStringify(back.terms) === stableStringify(parsedFiles('terms/'))
    && stableStringify(back.datasets) === stableStringify(parsedFiles('datasets/')) && back.invalid.length === 0, JSON.stringify(back.invalid));
  ok('relationships and the guide read back', stableStringify(back.relationships) === stableStringify(JSON.parse(files.get('relationships.json') as string).relationships) && back.guides.get(F.orders) === GUIDE && back.guides.size === 1);
  ok('the manifest reads back', back.manifest.format === 'ordinate-model' && back.manifest.formatVersion === 1 && back.manifest.project.name === 'Retail model');
  const { bytes } = await H.as(H.ORG_A, () => modelZip(F.P));
  const zipFile = path.join(os.tmpdir(), `model-read-${process.pid}.zip`);
  const fromZip = async (b: Buffer) => {
    fs.writeFileSync(zipFile, b);
    try {
      return await H.as(H.ORG_A, () => readModelZip(zipFile));
    } finally {
      fs.rmSync(zipFile, { force: true });
    }
  };
  ok('the zip reads to the same shapes as its files', stableStringify(parsedOf(await fromZip(bytes))) === stableStringify(back));

  // ── 2. Refused as a whole ─────────────────────────────────────────────────
  const said = async (f: Files) => refusedOf(await read(f));
  ok('an unknown entry refuses the whole file, naming it', (await said(withEntry(files, 'notes.txt', 'x'))) === (await H.as(H.ORG_A, async () => msg.modelEntryRefused('notes.txt'))));
  ok('a path outside the layout is refused', !!(await said(withEntry(files, '../model.json', '{}'))) && !!(await said(withEntry(files, 'datasets/../model.json', '{}'))) && !!(await said(withEntry(files, 'metrics/Revenue.json', '{}'))) && !!(await said(withEntry(files, '/etc/passwd', 'x'))));
  ok('a name with control characters is shown without them', !(await said(withEntry(files, 'a\u0000b‮.txt', 'x'))).includes('\u0000'));
  const notModel = await H.as(H.ORG_A, async () => msg.modelNotAModel());
  ok('no model.json refuses', (await said(without(files, 'model.json'))) === notModel);
  ok('a model.json that is not JSON refuses', (await said(withEntry(files, 'model.json', '{"format":'))) === notModel);
  ok('another format refuses', (await said(edit(files, 'model.json', (m) => { m.format = 'ordinate-bundle'; }))) === notModel);
  ok('formatVersion 2 refuses, with the sentence', (await said(edit(files, 'model.json', (m) => { m.formatVersion = 2; }))) === (await H.as(H.ORG_A, async () => msg.modelTooNew('2'))));
  ok('a formatVersion that is not a whole number refuses', !!(await said(edit(files, 'model.json', (m) => { m.formatVersion = '1'; }))) && !!(await said(edit(files, 'model.json', (m) => { m.formatVersion = 0.5; }))));
  ok('an entry past its cap refuses', !!(await said(withEntry(files, 'datasets/orders.md', 'x'.repeat(33 * 1024)))));
  ok('past the value budget refuses', (await said(withEntry(files, 'metrics/huge.json', `[${'0,'.repeat(1_000_001)}0]`))) === (await H.as(H.ORG_A, async () => msg.modelTooManyValues())));
  ok('an encrypted entry is refused by the reader', !!refusedOf(await fromZip(forged(bytes, 0x1))));
  ok('a data descriptor is refused by the reader', !!refusedOf(await fromZip(forged(bytes, 0x8))));
  ok('NEGATIVE CONTROL: the unforged zip reads', !('refused' in (await fromZip(bytes))));

  // ── 3. One bad object is one invalid item ─────────────────────────────────
  const invalidOf = async (f: Files) => parsedOf(await read(f)).invalid;
  const unreadable = await H.as(H.ORG_A, async () => msg.modelObjectUnreadable());
  const seven = await invalidOf(withEntry(files, 'metrics/bad.json', '7'));
  ok('a broken metric file is one invalid item, not a refusal', seven.length === 1 && seven[0].path === 'metrics/bad.json' && seven[0].error === unreadable, JSON.stringify(seven));
  ok('a metric file that is not JSON is invalid', (await invalidOf(withEntry(files, 'metrics/bad.json', '{"id":'))).length === 1);
  ok('a metric with a bad id is invalid', (await invalidOf(edit(files, 'metrics/revenue.json', (m) => { m.id = '../../etc'; })))[0]?.path === 'metrics/revenue.json');
  ok('a term with filters that are not a list is invalid', (await invalidOf(edit(files, 'terms/emea.json', (t) => { t.filters = 'region = EU'; })))[0]?.path === 'terms/emea.json');
  ok('a field with a label list that is not one is invalid', (await invalidOf(edit(files, 'datasets/orders.json', (d) => { d.fields[1].values = [{ value: 7 }]; })))[0]?.path === 'datasets/orders.json');
  const badEnd = parsedOf(await read(edit(files, 'relationships.json', (o) => { o.relationships.push({ ...o.relationships[0], id: '1b000000-0000-4000-8000-00000000001b', from: { dataset: 'x', column: 'a' } }); })));
  ok('a relationship with a bad end is invalid, the others read', badEnd.invalid.length === 1 && badEnd.invalid[0].path === 'relationships.json' && badEnd.relationships.length === 1, JSON.stringify(badEnd.invalid));
  const twice = parsedOf(await read(withEntry(files, 'metrics/zz-copy.json', files.get('metrics/revenue.json') as string)));
  ok('a repeated id: the first file is read, the second is invalid', twice.metrics.filter((m) => m.id === F.revenue).length === 1 && twice.invalid[0]?.path === 'metrics/zz-copy.json' && twice.invalid[0]?.error === (await H.as(H.ORG_A, async () => msg.modelDuplicateId())), JSON.stringify(twice.invalid));
  const extra = parsedOf(await read(edit(files, 'metrics/revenue.json', (m) => { m.secret = 'planted'; m.updatedBy = 'x'; })));
  ok('unknown keys are dropped', !JSON.stringify(extra.metrics).includes('planted') && !JSON.stringify(extra.metrics).includes('updatedBy') && extra.invalid.length === 0);
  const long = parsedOf(await read(withEntry(files, 'datasets/orders.md', 'x'.repeat(9000))));
  ok('a 9,000-character guide is invalid, and its dataset with it', long.invalid.length === 1 && long.invalid[0].path === 'datasets/orders.md' && long.invalid[0].id === F.orders && long.invalid[0].error === (await H.as(H.ORG_A, async () => msg.modelGuideTooLong())) && !long.datasets.some((d) => d.id === F.orders), JSON.stringify(long.invalid));
  ok('NEGATIVE CONTROL: an 8,000-character guide reads', parsedOf(await read(withEntry(files, 'datasets/orders.md', 'x'.repeat(8000)))).invalid.length === 0);
  ok('a guide is trimmed as the store trims it', parsedOf(await read(withEntry(files, 'datasets/orders.md', `${GUIDE}\n`))).guides.get(F.orders) === GUIDE);
  ok('a guide with no dataset file is invalid', (await invalidOf(withEntry(files, 'datasets/gone.md', 'x')))[0]?.path === 'datasets/gone.md');

  await close();
  finish();
})().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
