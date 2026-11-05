// Assistant instructions (semantic layer part 3, release A): a pod of this release KEEPS what a newer one
// writes in the catalog's `instructions` and never drops it on a re-save. Nothing here writes one.
//
//   § catalog   an old-path catalog write (setColumn) keeps the section; a bad id is dropped and a line
//               break collapsed; at most 40; absent -> no key
//   § clip      text is one line of at most 300 characters, cut never inside a surrogate pair;
//               updatedBy and updatedAt are clipped; a duplicate id keeps the first
//   § twice     sanitizing twice gives what sanitizing once gives, on a cut that lands after a space
//               and on a cut that lands inside a surrogate pair
//   NEGATIVE CONTROLS: a non-array is no list; a non-object entry is dropped and the rest kept
//
//   npm run build:ts && node scripts/test-instructions.js

export {}; // module scope: sibling test scripts share top-level names
import { ok, finish } from './selfcheck';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');

const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-instructions-'));
process.env.ORDINATE_LOCAL_DIR = tmpUserData;

const catalog: typeof import('../src/app/catalog') = require('../src/app/catalog');
const projects: typeof import('../src/app/projects') = require('../src/app/projects');
const { sanitizeInstructions, MAX_INSTRUCTIONS, MAX_INSTRUCTION_LEN } = require('../src/app/instructions') as typeof import('../src/app/instructions');
const { stableStringify } = require('../src/engine/queryCache') as typeof import('../src/engine/queryCache');

const uuid = (n: number): string => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;
const [U1, U2, U3, DS] = [1, 2, 3, 4].map(uuid);

async function main(): Promise<void> {
  const P = (await projects.createProject('Instructions'))!.id;
  const file = path.join(tmpUserData, 'projects', P, 'catalog.json');
  const rawCatalog = (): any => JSON.parse(fs.readFileSync(file, 'utf8'));
  const writeRawCatalog = (extra: Record<string, unknown>): void =>
    fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, tags: {}, records: {}, columns: {}, ...extra }));

  // ── catalog ────────────────────────────────────────────────────────────────
  const I1 = { id: U1, text: 'Revenue means net_amount unless they say gross.', updatedBy: 'priya@x', updatedAt: '2026-10-12T00:00:00.000Z' };
  writeRawCatalog({ instructions: [I1, { id: 'nope', text: 'x' }, { id: U2, text: 'a\nb' }] });
  await catalog.setColumn(P, DS, 'region', { description: 'Sales region' }); // an old-path write
  const back = rawCatalog();
  ok('the write rewrote the file', back.columns[DS].region.description === 'Sales region');
  ok('an old-path write keeps instructions', back.instructions.length === 2 && stableStringify(back.instructions[0]) === stableStringify(I1));
  ok('a bad id is dropped, a line break collapsed', !back.instructions.some((i: any) => i.id === 'nope') && back.instructions[1].text === 'a b');
  ok('a missing updatedBy and updatedAt come back empty, the entry kept', back.instructions[1].updatedBy === '' && back.instructions[1].updatedAt === '');
  await catalog.setColumn(P, DS, 'region', { description: 'Sales region' });
  ok('a second write keeps them the same', stableStringify(rawCatalog().instructions) === stableStringify(back.instructions));

  ok('at most 40', sanitizeInstructions(Array.from({ length: 41 }, (_, k) => ({ id: uuid(100 + k), text: `t${k}` }))).length === MAX_INSTRUCTIONS && MAX_INSTRUCTIONS === 40);
  ok('…the first 40, in stored order', sanitizeInstructions(Array.from({ length: 41 }, (_, k) => ({ id: uuid(100 + k), text: `t${k}` }))).at(-1)!.text === 't39');
  ok('absent -> no key', !('instructions' in catalog.sanitizeCatalog({ schemaVersion: 1 })) && !('instructions' in catalog.emptyCatalog()));
  ok('an empty list -> no key', !('instructions' in catalog.sanitizeCatalog({ schemaVersion: 1, instructions: [{ id: 'bad', text: 'x' }] })));

  // ── clip ───────────────────────────────────────────────────────────────────
  ok('an empty text drops the entry', sanitizeInstructions([{ id: U1, text: ' \n\t ' }, { id: U2 }, { id: U3, text: 7 }]).length === 0);
  ok('a duplicate id keeps the first', sanitizeInstructions([{ id: U1, text: 'one' }, { id: U1.toUpperCase(), text: 'two' }, { id: U2, text: 'three' }]).map((i) => i.text).join() === 'one,three');
  ok('line breaks of every kind collapse to one space', sanitizeInstructions([{ id: U1, text: 'a\r\nb c\u0085d\u0000e\t\tf' }])[0].text === 'a b c d e f');
  ok('text is cut at 300', sanitizeInstructions([{ id: U1, text: 'x'.repeat(500) }])[0].text.length === MAX_INSTRUCTION_LEN && MAX_INSTRUCTION_LEN === 300);
  ok('updatedBy is cut at 80 and updatedAt at 40', (() => {
    const i = sanitizeInstructions([{ id: U1, text: 't', updatedBy: 'b'.repeat(200), updatedAt: 'a'.repeat(200) }])[0];
    return i.updatedBy.length === 80 && i.updatedAt.length === 40;
  })());
  ok('only the four fields survive', Object.keys(sanitizeInstructions([{ id: U1, text: 't', extra: 1 }])[0]).join() === 'id,text,updatedBy,updatedAt');
  const pair = '😀'; // two UTF-16 units
  const cut = sanitizeInstructions([{ id: U1, text: 'x'.repeat(299) + pair }])[0].text;
  ok('a cut never lands inside a surrogate pair', cut === 'x'.repeat(299));
  ok('…a pair that fits whole is kept', sanitizeInstructions([{ id: U1, text: 'x'.repeat(298) + pair }])[0].text === 'x'.repeat(298) + pair);

  // ── twice ──────────────────────────────────────────────────────────────────
  const once = (raw: unknown): string => stableStringify(sanitizeInstructions(raw));
  const twice = (raw: unknown): string => stableStringify(sanitizeInstructions(JSON.parse(JSON.stringify(sanitizeInstructions(raw)))));
  const awkward = [
    { id: U1, text: 'x'.repeat(299) + ' tail that is cut away', updatedBy: 'b'.repeat(79) + ' z', updatedAt: ' a ' },
    { id: U2, text: 'y'.repeat(299) + pair },
    { id: U3, text: '  a \n b  c  ' },
  ];
  ok('sanitizing twice gives what sanitizing once gives', once(awkward) === twice(awkward) && sanitizeInstructions(awkward)[0].text === 'x'.repeat(299));
  ok('…and a text that ended in a space after the cut keeps no space', !/\s$/.test(sanitizeInstructions(awkward)[0].text) && !/\s$/.test(sanitizeInstructions(awkward)[0].updatedBy));
  const full = catalog.sanitizeCatalog({ schemaVersion: 1, instructions: awkward });
  ok('the whole catalog sanitizes twice to the same file', stableStringify(catalog.sanitizeCatalog(JSON.parse(JSON.stringify(full)))) === stableStringify(full));

  // ── negative controls ──────────────────────────────────────────────────────
  ok('NEGATIVE CONTROL: a non-array is no list', sanitizeInstructions('Revenue means net').length === 0 && sanitizeInstructions({ 0: I1 }).length === 0 && sanitizeInstructions(null).length === 0);
  ok('NEGATIVE CONTROL: a non-object entry is dropped, the rest kept', sanitizeInstructions(['x', null, 3, [], I1]).length === 1);

  fs.rmSync(tmpUserData, { recursive: true, force: true });
  finish();
}

main().catch((err) => {
  console.error('FAIL (threw)', err);
  process.exit(1);
});
