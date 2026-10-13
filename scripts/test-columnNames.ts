// Self-check for the names people call a column — src/app/columnNames.ts (the
// rules), the `aliases` field of src/app/catalog.ts (the store), and the path
// from the store to the answer spec's validator (src/ipc/answers.ts
// `specDatasets` → src/ai/answerSpec.ts `resolveColumn`).
//
// What is pinned, and why each one matters:
//   1. THE STORED SHAPE — an "Also called" list is sanitised on every write AND
//      every read (a hand-edited catalog is untrusted), and a doc written
//      before the field existed reads as [] with the file still schemaVersion 1.
//   2. THE COLLISION RULE — a name another column answers to is refused with a
//      sentence, and NOTHING of that patch is saved. DIFFERENTIAL against the
//      resolver: the rule refuses exactly the names that, taught anyway, would
//      not resolve to the column they were taught for.
//   3. THE PATH TO THE VALIDATOR — a spec written in a taught name resolves
//      through the real store; a doc left under an old column name teaches
//      nothing; the catalog is read ONCE per project and no table is hydrated.
//
//   npm run build:ts && node scripts/test-columnNames.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, failureCount } from './selfcheck';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');

const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-columnnames-'));
process.env.ORDINATE_LOCAL_DIR = tmpUserData;

const N: typeof import('../src/app/columnNames') = require('../src/app/columnNames');
const A: typeof import('../src/ai/answerSpec') = require('../src/ai/answerSpec');
const catalog: typeof import('../src/app/catalog') = require('../src/app/catalog');
const projects: typeof import('../src/app/projects') = require('../src/app/projects');
const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
const answers: typeof import('../src/ipc/answers') = require('../src/ipc/answers');
const contract: typeof import('../src/api/catalog') = require('../src/api/catalog');
const handlers: Map<string, (e: unknown, payload: unknown) => Promise<any>> = require('../src/server/rpc').handlers; // any: a handler's reply

type ParsedColumn = import('../src/data/parse').ParsedColumn;

const COLS: ParsedColumn[] = [
  { name: 'gross', type: 'number' }, { name: 'net_amount', type: 'number' }, { name: 'region', type: 'text' },
];
const json = (v: unknown): string => JSON.stringify(v);

async function main(): Promise<void> {
  // ── 1. the stored shape (pure) ─────────────────────────────────────────────
  ok('sanitise: trimmed, inner whitespace collapsed, empties dropped, first-seen order',
    json(N.sanitizeAliases(['  sales ', 'net \t\n sales', '', '   ', 'revenue'], 'net_amount')) === json(['sales', 'net sales', 'revenue']));
  ok('sanitise: repeats go, ignoring case; so does the column\'s own name',
    json(N.sanitizeAliases(['Sales', 'SALES', 'sales', 'Net_Amount', 'net_amount', 'takings'], 'net_amount')) === json(['Sales', 'takings']));
  ok('sanitise: each name is cut to 60 characters',
    N.sanitizeAliases(['x'.repeat(200)], 'c')[0] === 'x'.repeat(N.MAX_ALIAS_LEN) && N.MAX_ALIAS_LEN === 60);
  ok('sanitise: at most 8 names are kept, the first 8',
    json(N.sanitizeAliases(Array.from({ length: 20 }, (_, i) => 'n' + i), 'c')) === json(['n0', 'n1', 'n2', 'n3', 'n4', 'n5', 'n6', 'n7']) && N.MAX_ALIASES === 8);
  ok('sanitise: a comma separates names, so a stored name never holds one',
    json(N.sanitizeAliases(['sales, revenue', 'takings'], 'c')) === json(['sales', 'revenue', 'takings'])
    && json(N.sanitizeAliases('sales, revenue', 'c')) === json(['sales', 'revenue']));
  ok('sanitise: anything that is not text is no name',
    N.sanitizeAliases([42, null, { a: 1 }, ['x']], 'c').length === 0 && N.sanitizeAliases(undefined, 'c').length === 0 && N.sanitizeAliases({ 0: 'x' }, 'c').length === 0);
  const messy = ['  Sales  figure ', 'sales figure', 7, 'x'.repeat(90), 'a,b', ...Array.from({ length: 12 }, (_, i) => 'more' + i)];
  ok('sanitise: sanitising what was sanitised changes nothing',
    json(N.sanitizeAliases(N.sanitizeAliases(messy, 'c'), 'c')) === json(N.sanitizeAliases(messy, 'c')) && N.sanitizeAliases(messy, 'c').length === 8);

  // ── 2. the collision rule (pure), against the resolver ─────────────────────
  const docs = { gross: { displayName: 'Gross Sales', aliases: ['top line'] } };
  const others = [{ name: 'gross', ...docs.gross }, { name: 'region' }];
  const hit = N.aliasCollision(['takings', 'GROSS  SALES'.replace(/\s+/g, ' ')], others);
  ok('collision: names the alias and the column that already answers to it',
    !!hit && hit.alias === 'GROSS SALES' && hit.column.name === 'gross' && hit.column.displayName === 'Gross Sales', json(hit));
  ok('collision: nothing taken → null', N.aliasCollision(['takings', 'net'], others) === null && N.aliasCollision([], others) === null);
  // DIFFERENTIAL: for every candidate, "the rule refuses it" must equal "taught
  // anyway, the resolver would not hand back net_amount for it". Said in its
  // LOOSEST spelling — every letter apart, so it equals nothing as written and
  // only the squashed passes can match: the rule compares squashed, so that it
  // holds however the name is later typed, where the resolver's earlier passes
  // would still tell "TopLine" from "top line".
  const loosest = (c: string): string => (N.squash(c) ? N.squash(c).split('').join(' ') : c);
  const candidates = ['sales', 'net', '売上', 'Gross Sales', 'gross-sales', 'GROSS', 'top line', 'TopLine', 'Top_Line', 'region', 'Region ', 're-gion'];
  let refusals = 0;
  for (const c of candidates) {
    const refused = N.aliasCollision(N.sanitizeAliases([c], 'net_amount'), others) !== null;
    const taught = N.taughtNames(COLS, { ...docs, net_amount: { aliases: [c] } });
    const resolved = A.resolveColumn(loosest(c), COLS, taught)?.name === 'net_amount';
    if (refused) refusals += 1;
    ok(`collision ≡ resolver: ${json(c)} is ${refused ? 'refused, and would not have resolved' : 'accepted, and resolves to its column'}`, refused === !resolved);
  }
  ok('collision ≡ resolver: the candidates include both kinds (the check is not vacuous)', refusals === 9, String(refusals));

  ok('taughtNames: display name first, then the aliases; a column with neither has no entry',
    json(N.taughtNames(COLS, { gross: { displayName: 'Gross Sales', aliases: ['top line'] }, region: { displayName: '', aliases: [] } })) === json({ gross: ['Gross Sales', 'top line'] }));
  const withStale = { ...docs, old_amount: { displayName: 'Old', aliases: ['takings'] } };
  ok('taughtNames: a doc filed under a name that is not a current column teaches nothing',
    json(N.taughtNames(COLS, withStale)) === json(N.taughtNames(COLS, docs)) && json(N.taughtNames(COLS, undefined)) === '{}');

  // ── 3. the store, on disk ──────────────────────────────────────────────────
  await projects.init();
  const proj = await projects.createProject('Names project');
  const pid = proj!.id;
  const ds = await datasets.saveDataset(pid, { name: 'Orders', sourceKind: 'csv', columns: COLS, rows: [[10, 8, 'West'], [20, 15, 'East']] });
  const other = await datasets.saveDataset(pid, { name: 'Budget', sourceKind: 'csv', columns: [{ name: 'region', type: 'text' }, { name: 'plan', type: 'number' }], rows: [['West', 5]] });
  const D = ds!.id;
  const names = COLS.map((c) => c.name);

  await catalog.setColumn(pid, D, 'gross', { displayName: 'Gross Sales', aliases: ['top line'] }, names);
  const saved = await catalog.setColumn(pid, D, 'net_amount', { aliases: ['  Sales ', 'sales', 'net   sales', 'net_amount'] }, names);
  ok('store: setColumn saves the sanitised list and hands it back', !!saved && json(saved.aliases) === json(['Sales', 'net sales']), json(saved));
  ok('store: …and it reads back the same', json((await catalog.getColumns(pid, D)).net_amount.aliases) === json(['Sales', 'net sales']));
  const kept = await catalog.setColumn(pid, D, 'net_amount', { description: 'After discounts' }, names);
  ok('store: a patch without aliases leaves the list alone', !!kept && json(kept.aliases) === json(['Sales', 'net sales']) && kept.description === 'After discounts');

  const before = fs.readFileSync(path.join(tmpUserData, 'projects', pid, 'catalog.json'), 'utf8');
  const refuse = async (column: string, patch: import('../src/app/catalog').ColumnPatch, cols?: string[]): Promise<string> => {
    try { await catalog.setColumn(pid, D, column, patch, cols); return ''; } catch (err) { return err instanceof Error ? err.message : String(err); }
  };
  ok('refusal: another column\'s display name, in any case or spacing — the sentence names it',
    (await refuse('net_amount', { aliases: ['takings', 'gross_sales'], displayName: 'Net', sensitivity: 'financial' }, names)) === '"gross_sales" is already what people call Gross Sales.');
  ok('refusal: another column\'s alias', (await refuse('net_amount', { aliases: ['Top Line'] }, names)) === '"Top Line" is already what people call Gross Sales.');
  ok('refusal: another column\'s own name, documented or not', (await refuse('net_amount', { aliases: ['Region'] }, names)) === '"Region" is already what people call region.');
  ok('refusal: an alias already taught the other way round', (await refuse('gross', { aliases: ['net-sales'] }, names)) === '"net-sales" is already what people call net_amount.');
  ok('refusal: NOTHING of a refused patch is saved — the file is byte for byte what it was',
    fs.readFileSync(path.join(tmpUserData, 'projects', pid, 'catalog.json'), 'utf8') === before);
  ok('refusal: …and the store still takes the next write (negative control: an untaken name is saved)',
    json((await catalog.setColumn(pid, D, 'net_amount', { aliases: ['Sales', 'net sales', 'takings'] }, names))!.aliases) === json(['Sales', 'net sales', 'takings']));
  ok('refusal: without the dataset\'s columns, the documented ones are still checked',
    (await refuse('region', { aliases: ['Gross Sales'] })) === '"Gross Sales" is already what people call Gross Sales.'
    && (await refuse('region', { aliases: ['unit'] })) === '');
  ok('refusal: the same name on a column of ANOTHER dataset is no collision',
    json((await catalog.setColumn(pid, other!.id, 'plan', { aliases: ['Sales', 'top line'] }, ['region', 'plan']))!.aliases) === json(['Sales', 'top line']));

  // The handler: the sentence reaches the browser as `error`, and the contract bounds the list.
  require('../src/ipc/catalog').register();
  const call = (payload: unknown): Promise<any> => handlers.get('catalog:setColumn')!({}, payload); // any: a handler's reply
  const refused = await call({ projectId: pid, datasetId: D, column: 'region', patch: { aliases: ['gross'] } });
  ok('handler: a refusal is { ok: false, error: the sentence }, checked against the record\'s columns',
    refused.ok === false && refused.error === '"gross" is already what people call Gross Sales.', json(refused));
  const stored = await call({ projectId: pid, datasetId: D, column: 'region', patch: { aliases: ['area', 'territory'] } });
  ok('handler: a save answers with the stored doc', stored.ok === true && json(stored.column.aliases) === json(['area', 'territory']), json(stored));
  const input = contract.catalog['catalog:setColumn'].input;
  const patchOf = (aliases: unknown) => ({ projectId: pid, datasetId: D, column: 'region', patch: { aliases } });
  ok('contract: 8 names of up to 60 characters pass; a 9th, a 61st character or a non-string does not',
    input.safeParse(patchOf(Array.from({ length: 8 }, () => 'x'.repeat(60)))).success
    && !input.safeParse(patchOf(Array.from({ length: 9 }, () => 'x'))).success
    && !input.safeParse(patchOf(['x'.repeat(61)])).success && !input.safeParse(patchOf([7])).success && !input.safeParse(patchOf('sales')).success);

  // A doc from before the field, and a hand-edited one: both are sanitised on read.
  const old = await projects.createProject('Old catalog');
  const oldFile = path.join(tmpUserData, 'projects', old!.id, 'catalog.json');
  fs.writeFileSync(oldFile, JSON.stringify({
    schemaVersion: 1, tags: {}, records: {},
    columns: { [D]: {
      disc_pct: { description: 'Share off', displayName: 'Discount', example: '0.1', sensitivity: 'financial', updatedBy: 'ana', updatedAt: '2026-01-01T00:00:00.000Z' },
      edited: { displayName: 'Edited', aliases: [' a  b ', 'A B', 'edited', 9, 'x'.repeat(99), ...Array.from({ length: 12 }, (_, i) => 'k' + i)] },
      broken: { aliases: 'not, a list' },
    } },
  }));
  const oldCols = await catalog.getColumns(old!.id, D);
  ok('read: a doc written before the field reads as [] and keeps everything else',
    Array.isArray(oldCols.disc_pct.aliases) && oldCols.disc_pct.aliases.length === 0
    && oldCols.disc_pct.displayName === 'Discount' && oldCols.disc_pct.sensitivity === 'financial' && oldCols.disc_pct.updatedBy === 'ana');
  ok('read: a hand-edited list is sanitised exactly as a written one is',
    json(oldCols.edited.aliases) === json(N.sanitizeAliases([' a  b ', 'A B', 'edited', 9, 'x'.repeat(99), ...Array.from({ length: 12 }, (_, i) => 'k' + i)], 'edited'))
    && oldCols.edited.aliases.length === 8 && json(oldCols.broken.aliases) === json(['not', 'a list']));
  await catalog.setColumn(old!.id, D, 'disc_pct', { aliases: ['discount rate'] });
  ok('write: the file stays schemaVersion 1 (the field is additive)', JSON.parse(fs.readFileSync(oldFile, 'utf8')).schemaVersion === 1);

  // ── 4. the path to the validator ───────────────────────────────────────────
  await catalog.setColumn(pid, D, 'old_amount', { displayName: 'Old amount', aliases: ['bookings'] }); // a doc a rename step left behind
  const realLoad = catalog.load;
  const realGet = datasets.getDataset;
  let loads = 0;
  let hydrated = 0;
  (catalog as { load: typeof realLoad }).load = (p: string) => { loads += 1; return realLoad(p); };
  (datasets as { getDataset: typeof realGet }).getDataset = (...args: Parameters<typeof realGet>) => { hydrated += 1; return realGet(...args); };
  const spec = await answers.specDatasets(pid);
  (catalog as { load: typeof realLoad }).load = realLoad;
  (datasets as { getDataset: typeof realGet }).getDataset = realGet;
  ok('path: two datasets, ONE catalog read, no table hydrated', spec.length === 2 && loads === 1 && hydrated === 0, `${spec.length} datasets, ${loads} loads, ${hydrated} hydrations`);
  const orders = spec.find((d) => d.id === D)!;
  ok('path: the names are the store\'s, for current columns only',
    json(orders.names) === json(N.taughtNames(COLS, await catalog.getColumns(pid, D)))
    && json(orders.names) === json({ gross: ['Gross Sales', 'top line'], net_amount: ['Sales', 'net sales', 'takings'], region: ['area', 'territory'] }), json(orders.names));
  const byReal = A.validateAnswerSpec({ dataset: 'Orders', category: 'region', measures: ['sum(net_amount)', 'gross'] }, spec);
  const bySaid = A.validateAnswerSpec({ dataset: 'Orders', category: 'Territory', measures: ['sum(net sales)', 'Gross Sales'] }, spec);
  ok('path: a spec in the display name and the taught names is the spec the real names give', byReal.ok && bySaid.ok && json(bySaid.spec) === json(byReal.spec), json(bySaid));
  const stale = A.validateAnswerSpec({ dataset: 'Orders', category: 'region', measures: ['bookings'] }, spec);
  ok('path: a name left under an old column resolves to nothing', !stale.ok && stale.reason === 'Unknown measure column "bookings".', json(stale));
  const elsewhere = A.validateAnswerSpec({ dataset: 'Budget', category: 'region', measures: ['top line'] }, spec);
  ok('path: a dataset answers to its own names only', elsewhere.ok && elsewhere.spec.measures[0].column === 'plan', json(elsewhere));
}

main()
  .then(() => {
    try { fs.rmSync(tmpUserData, { recursive: true, force: true }); } catch (_) { /* a temp dir */ }
    if (failureCount()) { console.error('\n' + failureCount() + ' column-name check(s) FAILED'); process.exit(1); }
    console.log('\nAll column-name checks passed.');
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
