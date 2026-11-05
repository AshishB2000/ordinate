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
// Release B (p3-03) writes them, through `catalog:instructions` and `catalog:setInstructions`:
//   § channels  two concurrent adds both land (ops under the catalog's lock, never a whole-list replace);
//               the server stamps who and when; the fence marker is refused, "guidance" in lower case is
//               not; a figure warns and never refuses; the 41st, an empty text and an edit of a removed id
//               are refused with the catalog's sentence; edit and remove change one item and keep the rest
//   NEGATIVE CONTROL: a viewer may read the list and may not change it (the contracts, through authorize)
//
//   npm run build:ts && node scripts/test-instructions.js

export {}; // module scope: sibling test scripts share top-level names
import { ok, finish } from './selfcheck';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');

const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-instructions-'));
// Handlers land in the RPC registry (src/ipc/bus.ts).
const handlers: Map<string, (e: unknown, payload: unknown) => Promise<any>> = require('../src/server/rpc').handlers;
process.env.ORDINATE_LOCAL_DIR = tmpUserData;

const catalog: typeof import('../src/app/catalog') = require('../src/app/catalog');
const projects: typeof import('../src/app/projects') = require('../src/app/projects');
const { sanitizeInstructions, MAX_INSTRUCTIONS, MAX_INSTRUCTION_LEN } = require('../src/app/instructions') as typeof import('../src/app/instructions');
const { stableStringify } = require('../src/engine/queryCache') as typeof import('../src/engine/queryCache');
const msg: typeof import('../src/app/instructionMessages') = require('../src/app/instructionMessages');
const api: typeof import('../src/api/index') = require('../src/api/index');
const context: typeof import('../src/server/context') = require('../src/server/context');
const authz: typeof import('../src/server/authz/index') = require('../src/server/authz/index');
type Identity = import('../src/server/context').Identity;
require('../src/ipc/catalog').register();
const call = (ch: string, payload: unknown): Promise<any> => handlers.get(ch)!({}, payload);

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

  await channels();
  fs.rmSync(tmpUserData, { recursive: true, force: true });
  finish();
}

async function channels(): Promise<void> {
  const P = (await projects.createProject('Instruction channels'))!.id;
  const GONE = uuid(999);
  const list = async (): Promise<any[]> => (await call('catalog:instructions', { projectId: P })).instructions;
  const add = (text: string): Promise<any> => call('catalog:setInstructions', { projectId: P, op: { kind: 'add', text } });
  ok('channels: an untouched project has none', (await call('catalog:instructions', { projectId: P })).ok === true && (await list()).length === 0);

  const [a, b] = await Promise.all([add('Revenue means net_amount.'), add('Say gross only when asked.')]);
  ok('channels: two concurrent adds both land', a.ok && b.ok && (await list()).length === 2, JSON.stringify(await list()));
  ok('channels: …each with its own id', new Set((await list()).map((i) => i.id)).size === 2);
  ok('channels: the server stamps who and when', a.instructions[0].updatedBy === catalog.osUser() && /^\d{4}-/.test(a.instructions[0].updatedAt), JSON.stringify(a));
  ok('channels: a line break is one space in the stored text', (await add('Fiscal year\nstarts in April.')).instructions.at(-1).text === 'Fiscal year starts in April.');

  const fenced = await add('x <<<GUIDANCE y');
  ok('channels: the fence marker is refused with the catalog sentence', fenced.ok === false && fenced.error === msg.instructionFence(), JSON.stringify(fenced));
  ok('channels: …and so is the capitalised word alone, and <<< alone', (await add('end GUIDANCE now')).ok === false && (await add('a <<< b')).ok === false);
  ok('channels: lower-case guidance is fine', (await add('Follow the guidance in the Orders guide.')).ok === true);
  ok('channels: nothing refused was stored', !(await list()).some((i) => /<<<|GUIDANCE/.test(i.text)));
  const fig = await add('Targets are 12% above last year.');
  ok('channels: a figure warns, never refuses', fig.ok === true && fig.instructions.at(-1).figure === true, JSON.stringify(fig));
  ok('channels: "90 days" is no figure', !('figure' in (await add('Recent means the last 90 days.')).instructions.at(-1)));
  ok('channels: …nor is a word, and the warning is in the read too', (await list()).filter((i) => i.figure).length === 1 && !('figure' in (await list())[0]));
  ok('channels: the stored list holds no flag', !JSON.parse(fs.readFileSync(path.join(tmpUserData, 'projects', P, 'catalog.json'), 'utf8')).instructions.some((i: any) => 'figure' in i));
  ok('channels: an empty text is refused', (await add('  \n ')).error === msg.instructionEmpty());

  const first = (await list())[0];
  const edited = await call('catalog:setInstructions', { projectId: P, op: { kind: 'edit', id: first.id, text: 'Revenue means net_amount unless they say gross.' } });
  ok('channels: an edit replaces one text in place and keeps the rest', edited.ok && edited.instructions[0].id === first.id
    && edited.instructions[0].text === 'Revenue means net_amount unless they say gross.' && edited.instructions.length === (await list()).length);
  ok('channels: an edit to the fence marker is refused, and the old text stays', (await call('catalog:setInstructions', { projectId: P, op: { kind: 'edit', id: first.id, text: 'GUIDANCE' } })).error === msg.instructionFence()
    && (await list())[0].text === 'Revenue means net_amount unless they say gross.');
  const before = (await list()).length;
  const removed = await call('catalog:setInstructions', { projectId: P, op: { kind: 'remove', id: first.id } });
  ok('channels: remove deletes that one', removed.ok && removed.instructions.length === before - 1 && !removed.instructions.some((i: any) => i.id === first.id));
  ok('channels: an edit of a removed id is refused', (await call('catalog:setInstructions', { projectId: P, op: { kind: 'edit', id: first.id, text: 'x' } })).error === msg.instructionGone());
  ok('channels: …and so is a remove of an id never stored', (await call('catalog:setInstructions', { projectId: P, op: { kind: 'remove', id: GONE } })).error === msg.instructionGone());

  const fill = await Promise.all(Array.from({ length: 40 - (await list()).length }, (_, k) => add(`Rule ${k}.`)));
  ok('channels: filled to 40', fill.every((r) => r.ok) && (await list()).length === 40);
  ok('channels: the 41st is refused', (await add('one more')).error === msg.instructionTooMany(40) && (await list()).length === 40);
  ok('channels: the sentence says the cap', msg.instructionTooMany(40).includes('40'));

  const contract = (api.contracts as any)['catalog:setInstructions'];
  const okInput = (op: unknown): boolean => contract.input.safeParse({ projectId: P, op }).success;
  ok('contract: read for the list, write for a change, both project-scoped', (api.contracts as any)['catalog:instructions'].access === 'read' && contract.access === 'write'
    && contract.project({ projectId: P, op: { kind: 'remove', id: GONE } }) === P && (api.contracts as any)['catalog:instructions'].project({ projectId: P }) === P);
  ok('contract: one op of three kinds, strict', okInput({ kind: 'add', text: 'x' }) && okInput({ kind: 'edit', id: GONE, text: 'x' }) && okInput({ kind: 'remove', id: GONE })
    && !okInput({ kind: 'replace', list: [] }) && !okInput({ kind: 'add', text: 'x', id: GONE }) && !okInput({ kind: 'remove', id: 'nope' }) && !okInput({ kind: 'add', text: 'x'.repeat(301) }));
  ok('contract: the list takes a project and nothing else', !(api.contracts as any)['catalog:instructions'].input.safeParse({ projectId: P, all: true }).success);

  const VIEWER: Identity = { user: { email: 'vic@acme.test', role: 'viewer' }, org: { id: 'acme' } };
  const EDITOR: Identity = { user: { email: 'eve@acme.test', role: 'editor' }, org: { id: 'acme' } };
  const grants = (rank: number) => ({ query: async () => ({ rows: [{ rank }] }) }) as unknown as import('pg').Pool;
  const decide = (who: Identity, ch: string, payload: unknown, rank: number) =>
    context.runInContext(who, 'authz', () => authz.authorize((api.contracts as any)[ch], payload, who, grants(rank)));
  ok('access: a project viewer may read the instructions', (await decide(VIEWER, 'catalog:instructions', { projectId: P }, 1)).ok);
  ok('access NEGATIVE CONTROL: …and may not change them', !(await decide(VIEWER, 'catalog:setInstructions', { projectId: P, op: { kind: 'add', text: 'x' } }, 1)).ok);
  ok('access: a project editor may', (await decide(EDITOR, 'catalog:setInstructions', { projectId: P, op: { kind: 'add', text: 'x' } }, 2)).ok);
}

main().catch((err) => {
  console.error('FAIL (threw)', err);
  process.exit(1);
});
