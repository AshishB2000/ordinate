// Assistant instructions on POSTGRES (semantic layer part 3, p3-03). With DATABASE_URL the catalog is a `records` row,
// and the catalog's lock (recordFs.locked) holds across pods — the store's "two editors never lose each other's edit"
// rests on it. test-instructions and test-guidance cover the same store and loader on files.
//
//   1. four concurrent adds all land, each stamped with the request's user; no catalog file is written
//   2. the fence marker is refused and nothing is stored; an edit and a remove change one item
//   3. an old-path catalog write (a column note) keeps the list; the guidance loader reads it back from the row
//   NEGATIVE CONTROL: a plain read, an add meanwhile, then a whole-file write of what was read — a whole-list
//   replace — loses the add
//
// Needs a Postgres it may CREATE DATABASE on; without DATABASE_URL it prints one skip line.
//
//   npm run build:ts && DATABASE_URL=… node scripts/test-instructions-db.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import { scratchDb } from './podHarness';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');
const { randomUUID }: typeof import('crypto') = require('crypto');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-instructions-db-'));
const context: typeof import('../src/server/context') = require('../src/server/context');
context.enterServerMode(TMP);
const recordFs: typeof import('../src/app/recordFs') = require('../src/app/recordFs');
const appPaths: typeof import('../src/app/paths') = require('../src/app/paths');
const mig: typeof import('../src/server/db/migrate') = require('../src/server/db/migrate');
const projects: typeof import('../src/app/projects') = require('../src/app/projects');
const catalog: typeof import('../src/app/catalog') = require('../src/app/catalog');
const store: typeof import('../src/app/instructions') = require('../src/app/instructions');
const msg: typeof import('../src/app/instructionMessages') = require('../src/app/instructionMessages');
const guidance: typeof import('../src/ipc/guidance') = require('../src/ipc/guidance');

let req = 0;
const as = <T>(fn: () => Promise<T>): Promise<T> =>
  context.runInContext({ user: { email: 'ana@acme.test', role: 'admin' }, org: { id: 'acme' } }, `r${++req}`, fn);
const refusal = (p: Promise<unknown>): Promise<string> => p.then(() => '', (e: Error) => e.message);

async function legs(): Promise<void> {
  const P = (await as(() => projects.createProject('Instructions on Postgres'))).id;
  const file = await as(async () => path.join(appPaths.userData(), 'projects', P, 'catalog.json'));
  const texts = (list: { text: string }[]): string => list.map((i) => i.text).sort().join('|');

  // ── 1. Concurrent adds ───────────────────────────────────────────────────
  await as(() => Promise.all(['A', 'B', 'C', 'D'].map((t) => store.changeInstructions(P, { kind: 'add', text: `Rule ${t}.` }))));
  const four = await as(() => store.listInstructions(P));
  ok('db: four concurrent adds all land', texts(four) === 'Rule A.|Rule B.|Rule C.|Rule D.', texts(four));
  ok('db: …each stamped with the request\'s user', four.every((i) => i.updatedBy === 'ana@acme.test' && /^\d{4}-/.test(i.updatedAt)));
  ok('db: the catalog is a records row, never a file on the pod\'s disk', !fs.existsSync(file));

  // ── 2. Refusals and one-item changes ─────────────────────────────────────
  ok('db: the fence marker is refused with the catalog sentence', (await refusal(as(() => store.changeInstructions(P, { kind: 'add', text: 'x <<<GUIDANCE' })))) === msg.instructionFence());
  ok('db: …and nothing was stored', (await as(() => store.listInstructions(P))).length === 4);
  const [first, second] = four;
  await as(() => store.changeInstructions(P, { kind: 'edit', id: first.id, text: 'Revenue means net_amount.' }));
  await as(() => store.changeInstructions(P, { kind: 'remove', id: second.id }));
  const three = await as(() => store.listInstructions(P));
  ok('db: an edit changes one text in place and a remove deletes one', three.length === 3 && three[0].id === first.id && three[0].text === 'Revenue means net_amount.' && !three.some((i) => i.id === second.id));
  ok('db: an edit of the removed id is refused', (await refusal(as(() => store.changeInstructions(P, { kind: 'edit', id: second.id, text: 'x' })))) === msg.instructionGone());

  // ── 3. Kept through another catalog write, read back by the loader ───────
  await as(() => catalog.setColumn(P, randomUUID(), 'region', { description: 'Sales region' }));
  ok('db: an old-path catalog write keeps the list', texts(await as(() => store.listInstructions(P))) === texts(three));
  const g = await as(() => guidance.askGuidance(P, {}, 'scorecard'));
  ok('db: the guidance loader reads the list from the row', g.text.includes('<<<GUIDANCE\n- Revenue means net_amount.\n') && g.used.instructions === 3, g.text);
  ok('db: …and so does the narration\'s', (await as(() => guidance.instructionsGuidance(P))).text === g.text);

  // ── NEGATIVE CONTROL: a whole-list replace loses an edit ─────────────────
  const stale = await as(() => catalog.load(P));
  await as(() => store.changeInstructions(P, { kind: 'add', text: 'Added meanwhile.' }));
  await as(async () => {
    const tmp = `${file}.${randomUUID()}.tmp`;
    await recordFs.writeFile(tmp, JSON.stringify(stale));
    await recordFs.rename(tmp, file);
  });
  ok('db NEGATIVE CONTROL: a plain read, an add meanwhile and a whole-file write lose the add', !(await as(() => store.listInstructions(P))).some((i) => i.text === 'Added meanwhile.'));
}

(async () => {
  if (!process.env.DATABASE_URL) {
    console.log('skip instructions DB checks: DATABASE_URL is unset (set it to a Postgres this suite may CREATE DATABASE on)');
    return;
  }
  const scratch = (await scratchDb('instructions'))!;
  try {
    await mig.migrate(scratch.pool);
    recordFs.useRecordDb(scratch.pool);
    await legs();
  } finally {
    recordFs.useRecordDb(null);
    await scratch.drop();
  }
})()
  .catch((e) => ok('instructions DB suite ran to the end', false, e && e.stack ? e.stack : String(e)))
  .finally(() => {
    fs.rmSync(TMP, { recursive: true, force: true });
    finish();
  });
