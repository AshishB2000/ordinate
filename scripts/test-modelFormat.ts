// The model files' format (semantic layer part 7, a1 Task 1; docs/semantic-layer/07-portability.md D1, D2):
// the JSON writer (sorted keys, 2 spaces, a trailing newline), slugs, `base` hashes and the zip entry whitelist.
//
// 1. modelJson: same object, any key order, same bytes.
// 2. slugsFor: folded and joined; a clash takes -2 in id order; at most 60 characters.
// 3. objectBase: ignores its own key, follows content.
// 4. MODEL_POLICY: the D2 names pass. NEGATIVE CONTROL: anything else is refused, with the sentence.
//
//   npm run build:ts && node scripts/test-modelFormat.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';

const { modelJson, slugsFor, objectBase, MODEL_POLICY, MODEL_FORMAT, MODEL_VERSION, MODEL_ZIP_TIME }: typeof import('../src/app/modelFormat') = require('../src/app/modelFormat');
const { modelEntryRefused }: typeof import('../src/app/modelFileMessages') = require('../src/app/modelFileMessages');
const { OTHER_RECORD_MAX_BYTES }: typeof import('../src/app/bundleRules') = require('../src/app/bundleRules');

const U1 = '10000000-0000-4000-8000-000000000001';
const U2 = '20000000-0000-4000-8000-000000000002';
const U3 = '30000000-0000-4000-8000-000000000003';
const U4 = '40000000-0000-4000-8000-000000000004';

// ── 1. The writer ──────────────────────────────────────────────────────────
ok('keys sorted, 2 spaces, trailing newline', modelJson({ b: 1, a: { d: [2], c: null } }) === '{\n  "a": {\n    "c": null,\n    "d": [\n      2\n    ]\n  },\n  "b": 1\n}\n');
ok('same object, other key order: same bytes', modelJson({ x: 1, y: 2 }) === modelJson({ y: 2, x: 1 }));
ok('an undefined key is not written', modelJson({ a: 1, b: undefined }) === '{\n  "a": 1\n}\n');
ok('format ids', MODEL_FORMAT === 'ordinate-model' && MODEL_VERSION === 1 && MODEL_ZIP_TIME.getFullYear() === 1980);

// ── 2. Slugs ───────────────────────────────────────────────────────────────
const s = slugsFor([{ id: U2, name: 'Avg basket' }, { id: U1, name: 'avg  Basket!' }, { id: U3, name: '' }, { id: U4, name: 'Ünïcode 2024' }]);
ok('clash: id order decides who gets -2', s.get(U1) === 'avg-basket' && s.get(U2) === 'avg-basket-2', JSON.stringify([...s]));
ok('empty → untitled; accents folded (NFD), the rest dropped', s.get(U3) === 'untitled' && s.get(U4) === 'unicode-2024', JSON.stringify([...s]));
const long = slugsFor([{ id: U1, name: 'x'.repeat(70) }, { id: U2, name: 'x'.repeat(70) }]);
ok('at most 60 characters, a suffix included', long.get(U1)!.length === 60 && long.get(U2) === 'x'.repeat(58) + '-2', JSON.stringify([...long]));
const taken = slugsFor([{ id: U1, name: 'A' }, { id: U2, name: 'a' }, { id: U3, name: 'a 2' }]);
ok('a suffix never takes another name\'s slug twice', new Set(taken.values()).size === 3, JSON.stringify([...taken]));
ok('every slug passes the whitelist', [...s.values(), ...long.values(), ...taken.values()].every((v) => MODEL_POLICY.refuseName(`metrics/${v}.json`) === null));

// ── 3. base ────────────────────────────────────────────────────────────────
ok('base ignores its own key and follows content', objectBase({ id: U1, name: 'A', base: 'x' }) === objectBase({ name: 'A', id: U1 }) && objectBase({ id: U1, name: 'A' }) !== objectBase({ id: U1, name: 'B' }));
ok('base is sha256 as base64url', /^[A-Za-z0-9_-]{43}$/.test(objectBase({ id: U1 })));
ok('base keeps a nested base (a period metric names its base metric there)', objectBase({ id: U1, definition: { base: U2 } }) !== objectBase({ id: U1, definition: { base: U3 } }));

// ── 4. The zip whitelist ───────────────────────────────────────────────────
ok('whitelist: D2 names pass', ['model.json', 'datasets/orders.json', 'datasets/orders.md', 'metrics/revenue-2.json', 'terms/emea.json', 'relationships.json'].every((n) => MODEL_POLICY.refuseName(n) === null));
const refused = ['datasets/Orders.json', 'datasets/a/b.json', 'secrets.json', '../x.json', 'datasets/x.parquet', 'metrics/x.md', 'terms/-x.json', `terms/${'x'.repeat(61)}.json`];
ok('NEGATIVE CONTROL: anything else is refused', refused.every((n) => MODEL_POLICY.refuseName(n) !== null), refused.filter((n) => MODEL_POLICY.refuseName(n) === null).join());
ok('the refusal names the entry', MODEL_POLICY.refuseName('secrets.json') === modelEntryRefused('secrets.json') && modelEntryRefused('secrets.json').includes('secrets.json'));
ok('caps: a guide 32 KiB, a JSON file a record\'s', MODEL_POLICY.capOf('datasets/orders.md') === 32 * 1024 && MODEL_POLICY.capOf('datasets/orders.json') === OTHER_RECORD_MAX_BYTES);
ok('entry and total limits', MODEL_POLICY.maxEntries === 20_000 && MODEL_POLICY.maxTotal === 256 * 1024 * 1024);

finish();
