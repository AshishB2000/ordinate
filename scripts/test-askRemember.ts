// "REMEMBER THIS" — a name corrected once holds for everyone in the project.
// Through the real handlers (`copilot:ask`, `answer:rerun`, `answer:card`,
// `catalog:addAlias`), userData in a temp dir, the model stubbed at
// analyze.askCopilot (as test-askDidYouMean.ts).
//
//   1. THE LOOP. The model says "sales"; the reply is refused with options, the
//      one that puts a column there carries it (a dataset's does not). Run with
//      `learn`, the new turn keeps the name — a reload too — and its card
//      offers it; remembered, the card says it is known. DIFFERENTIAL: after,
//      a spec written with "sales" validates to the very spec written with the
//      real name, and draws the same card (Object.is); before, it was refused
//      (negative control). The next question that says it is answered outright.
//   2. WHAT A TURN KEEPS. A column the answer does not use, a name that is not
//      one name (a comma, too long, the column's own) → nothing kept, from a
//      client or from a stored turn (negative controls).
//   3. THE CATALOG'S RULES, the Columns tab's: a repeat in another case adds
//      nothing, a name another column answers to is refused with its sentence,
//      spaces are collapsed, a full list is refused with a sentence and never
//      cut, a column the dataset no longer has is refused, nothing written.
//   4. ACCESS. `catalog:addAlias` is `write`, project-scoped, strict: a project
//      viewer is refused before the handler — NEGATIVE CONTROL: the same viewer
//      may draw the card. `answer:card` / `answer:rerun` take `learn` only in
//      its strict shape.
//
//   npm run build:ts && node scripts/test-askRemember.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');

const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-remember-'));
const handlers: Map<string, (e: unknown, payload: unknown) => Promise<any>> = require('../src/server/rpc').handlers;
process.env.ORDINATE_LOCAL_DIR = tmpUserData;

const A: typeof import('../src/ai/answerSpec') = require('../src/ai/answerSpec');
const S: typeof import('../src/ai/answerSuggest') = require('../src/ai/answerSuggest');
const copilot: typeof import('../src/ai/copilot') = require('../src/ai/copilot');
const projects: typeof import('../src/app/projects') = require('../src/app/projects');
const catalog: typeof import('../src/app/catalog') = require('../src/app/catalog');
const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
const analyze: typeof import('../src/ai/analyze') = require('../src/ai/analyze');
const execConfig: typeof import('../src/app/execConfig') = require('../src/app/execConfig');
const copilotIpc: typeof import('../src/ipc/copilot') = require('../src/ipc/copilot');
const catalogIpc: typeof import('../src/ipc/catalog') = require('../src/ipc/catalog');
const answers: typeof import('../src/ipc/answers') = require('../src/ipc/answers');
const api: typeof import('../src/api/index') = require('../src/api/index');
const context: typeof import('../src/server/context') = require('../src/server/context');
const authz: typeof import('../src/server/authz/index') = require('../src/server/authz/index');

type AnswerSpec = import('../src/ai/answerSpec').AnswerSpec;
type Card = import('../src/ipc/answers').AnswerCard;
type Identity = import('../src/server/context').Identity;

const show = (v: unknown): string => JSON.stringify(v);
function sameLeaves(a: unknown, b: unknown): boolean {
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return Object.is(a, b);
  const ka = Object.keys(a);
  return Array.isArray(a) === Array.isArray(b) && ka.length === Object.keys(b).length
    && ka.every((k) => k in b && sameLeaves((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}
const sameData = (a: Card, b: Card): boolean => a.ok && b.ok && sameLeaves(a.data, b.data) && sameLeaves(a.headline, b.headline);

const COLS: import('../src/data/parse').ParsedColumn[] = [
  { name: 'order_date', type: 'date' }, { name: 'region', type: 'text' }, { name: 'net_sales', type: 'number' }, { name: 'sales_tax', type: 'number' },
];
const ROWS: import('../src/data/transforms').Cell[][] = [
  ['2024-10-02', 'West', 1234.5, 10], ['2024-11-15', 'East', 987.25, 20], ['2024-12-20', 'East', 456.75, 30], ['2024-11-03', 'West', 2468.25, 50],
];

async function main(): Promise<void> {
  const pid = (await projects.createProject('Remember'))!.id;
  const ds = (await datasets.saveDataset(pid, { name: 'Orders', sourceKind: 'csv', columns: COLS, rows: ROWS }))!;
  await catalog.setColumn(pid, ds.id, 'net_sales', { displayName: 'Net Sales' }, COLS.map((c) => c.name));
  copilotIpc.register();
  catalogIpc.register();
  const call = (ch: string, payload: unknown): Promise<any> => handlers.get(ch)!({}, payload);
  const card = (spec: unknown, learn?: unknown): Promise<Card> => call('answer:card', { projectId: pid, spec, ...(learn ? { learn } : {}) });
  const validate = async (raw: unknown) => A.validateAnswerSpec(raw, await answers.specDatasets(pid), { title: 'sales by region' });
  const aliases = async (column: string): Promise<string[]> => (await catalog.getColumns(pid, ds.id))[column]?.aliases ?? [];
  const addAlias = (column: string, alias: string, datasetId = ds.id) => call('catalog:addAlias', { projectId: pid, datasetId, column, alias });

  const replies: any[] = [];
  let asked = 0;
  (analyze as any).askCopilot = async () => { asked += 1; return replies.shift(); };
  (execConfig as any).executionReady = () => true;
  const answerWith = (spec: unknown) => ({ ok: true, text: 'Here it is.', suggestedAction: { kind: 'answer', intent: 'sales by region', spec } });
  const narration = { ok: true, text: 'West leads.', suggestedAction: { kind: 'none', intent: '' } };
  const lastOf = (r: any) => r.turns[r.turns.length - 1];
  const thread = async (): Promise<string> => (await call('copilot:newThread', { projectId: pid })).thread.id;
  const SAID = { dataset: 'Orders', category: 'region', measures: ['sum(sales)'] };
  const RIGHT = { dataset: 'Orders', category: 'region', measures: ['sum(net_sales)'] };

  // ── 1. The loop ───────────────────────────────────────────────────────────
  const before = await validate(SAID);
  ok('before: a spec that says "sales" is refused, the name missed (negative control for the differential below)',
    !before.ok && before.miss?.part === 'measure' && before.miss.said === 'sales', show(before));

  replies.push(answerWith(SAID));
  const r1 = await call('copilot:ask', { projectId: pid, context: {}, question: 'sales by region', threadId: await thread() });
  const refused = lastOf(r1);
  ok('refused: each option that puts a column where "sales" missed names that column',
    show(refused.suggest?.options.map((o: { label: string; column?: string }) => [o.label, o.column])) === show([['Net Sales', 'net_sales'], ['sales_tax', 'sales_tax']]), show(refused.suggest));
  replies.push(answerWith({ ...RIGHT, dataset: 'Ordrs' }));
  const rDs = lastOf(await call('copilot:ask', { projectId: pid, context: {}, question: 'sales by region', threadId: await thread() }));
  ok('refused: an option that puts a DATASET there names no column (nothing to remember)',
    rDs.suggest?.part === 'dataset' && rDs.suggest.options.length === 1 && !('column' in rDs.suggest.options[0]), show(rDs.suggest));

  const picked = refused.suggest.options[0];
  replies.push(narration);
  const run = await call('answer:rerun', { projectId: pid, threadId: r1.threadId, spec: picked.spec, label: picked.label, learn: { said: refused.suggest.said, column: picked.column } });
  const taught = lastOf(run);
  ok('rerun: the new answer turn keeps the name it can remember', run.ok && show(taught.learn) === show({ said: 'sales', column: 'net_sales' }) && !!taught.answer, show(taught));
  const kept = lastOf(await call('copilot:history', { projectId: pid, threadId: r1.threadId }));
  ok('rerun: …and a reload keeps it', sameLeaves(kept.learn, taught.learn) && sameLeaves(kept.answer, taught.answer), show(kept));

  const offered = await card(taught.answer, taught.learn);
  ok('card: offered — the said name, the column, the name it is shown by', offered.ok && show(offered.learn) === show({ said: 'sales', column: 'net_sales', label: 'Net Sales', state: 'offer' }), show(offered.learn));
  ok('card: asked without a name, none (negative control)', !('learn' in (await card(taught.answer))));

  const added = await addAlias('net_sales', 'sales');
  ok('remember: the name is added to the column\'s "Also called"', added.ok && show(await aliases('net_sales')) === '["sales"]', show(added));
  const known = await card(taught.answer, taught.learn);
  ok('card: …and now it is known', known.ok && known.learn?.state === 'known' && known.learn.label === 'Net Sales', show(known.learn));

  const after = await validate(SAID);
  const right = await validate(RIGHT);
  ok('DIFFERENTIAL: "sales" now validates to the very spec the real name does', after.ok && right.ok && sameLeaves(after.spec, right.spec), show([after, right]));
  ok('DIFFERENTIAL: …and draws the same card, Object.is on every figure',
    after.ok && right.ok && sameData(await card(after.spec), await card(right.spec)) && (await card(right.spec)).data.labels.length === 2);
  replies.push(answerWith(SAID), narration);
  const next = lastOf(await call('copilot:ask', { projectId: pid, context: {}, question: 'sales by region', threadId: await thread() }));
  ok('next time: the same words are answered outright — a chart, no "Did you mean"',
    !!next.answer && !('suggest' in next) && right.ok && sameLeaves(next.answer.measures, right.spec.measures), show(next));

  // ── 2. What a turn keeps ──────────────────────────────────────────────────
  const rerunWith = async (learn: unknown) => {
    replies.push(narration);
    return lastOf(await call('answer:rerun', { projectId: pid, threadId: r1.threadId, spec: picked.spec, label: picked.label, learn }));
  };
  ok('keeps nothing: a column the answer does not use', !('learn' in (await rerunWith({ said: 'sales', column: 'sales_tax' }))));
  ok('keeps nothing: a column that is not there at all', !('learn' in (await rerunWith({ said: 'sales', column: 'nope' }))));
  ok('keeps nothing: two names, or a name too long to store whole',
    !('learn' in (await rerunWith({ said: 'sales, revenue', column: 'net_sales' }))) && !('learn' in (await rerunWith({ said: 'x'.repeat(61), column: 'net_sales' }))));
  ok('keeps nothing: the column\'s own name', !('learn' in (await rerunWith({ said: 'NET_SALES', column: 'net_sales' }))));
  ok('keeps a name with its spacing as the catalog would store it, and not otherwise',
    !('learn' in (await rerunWith({ said: ' sales ', column: 'net_sales' }))) && show((await rerunWith({ said: 'gross sales', column: 'net_sales' })).learn) === show({ said: 'gross sales', column: 'net_sales' }));
  const spec = picked.spec as AnswerSpec;
  /** One stored turn, through the loader every history read takes. */
  const loaded = (turn: unknown) => copilot.normalize({ threads: [{ id: 't', title: 'x', turns: [turn] }] })[0].turns[0];
  ok('a stored turn is re-read: a name for a column its answer does not use is dropped on load',
    !('learn' in loaded({ role: 'assistant', text: '', answer: spec, learn: { said: 'sales', column: 'sales_tax' } }))
    && show(loaded({ role: 'assistant', text: '', answer: spec, learn: { said: 'sales', column: 'net_sales' } }).learn) === show({ said: 'sales', column: 'net_sales' }));
  ok('a stored turn is re-read: no name without an answer', !('learn' in loaded({ role: 'assistant', text: '', learn: { said: 'sales', column: 'net_sales' } })));
  ok('pure: sanitizeLearn on a refused shape', S.sanitizeLearn(null, spec) === undefined && S.sanitizeLearn({ said: 1, column: 'net_sales' }, spec) === undefined);

  // ── 3. The catalog's rules ────────────────────────────────────────────────
  const again = await addAlias('net_sales', 'SALES');
  ok('a repeat in another case adds nothing', again.ok && show(await aliases('net_sales')) === '["sales"]');
  const clash = await addAlias('net_sales', 'Sales Tax');
  ok('a name another column answers to is refused with the Columns tab\'s sentence, nothing written',
    !clash.ok && clash.error === '"Sales Tax" is already what people call sales_tax.' && show(await aliases('net_sales')) === '["sales"]', show(clash));
  const spaced = await addAlias('net_sales', '  big   spenders ');
  ok('spaces are collapsed as the Columns tab stores them', spaced.ok && show(await aliases('net_sales')) === '["sales","big spenders"]', show(await aliases('net_sales')));
  const comma = await addAlias('net_sales', 'a,b');
  ok('a comma is not one name: nothing added', comma.ok && (await aliases('net_sales')).length === 2);
  for (const n of ['n3', 'n4', 'n5', 'n6', 'n7', 'n8']) await addAlias('net_sales', n);
  ok('fills to eight', (await aliases('net_sales')).length === 8);
  const full = await addAlias('net_sales', 'n9');
  ok('a full list is refused with a sentence that names the column as it is shown — never cut',
    !full.ok && full.error === 'Net Sales already has 8 other names.' && (await aliases('net_sales')).length === 8 && !(await aliases('net_sales')).includes('n9'), show(full));
  ok('…while a name already on a full list is no refusal', (await addAlias('net_sales', 'N8')).ok);
  const fullBare = [];
  for (const n of ['r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7', 'r8', 'r9']) fullBare.push(await addAlias('region', n));
  ok('a column with no display name is named by its own name', fullBare[8].error === 'region already has 8 other names.', show(fullBare[8]));
  const gone = await addAlias('profit', 'margin');
  ok('a column the dataset does not have is refused, nothing written', !gone.ok && !('profit' in (await catalog.getColumns(pid, ds.id))), show(gone));
  const replaced = await call('catalog:setColumn', { projectId: pid, datasetId: ds.id, column: 'net_sales', patch: { aliases: ['sales'] } });
  ok('the Columns tab\'s door is unchanged: `aliases` still replaces the list', replaced.ok && show(await aliases('net_sales')) === '["sales"]');

  // ── 4. Access ─────────────────────────────────────────────────────────────
  const contract = api.contracts['catalog:addAlias'];
  const input = { projectId: pid, datasetId: ds.id, column: 'net_sales', alias: 'sales' };
  ok('contract: write, project-scoped by projectId', contract.access === 'write' && 'project' in contract && contract.project(input) === pid);
  ok('contract: strict — a list, a patch, an empty or a 61-character name is refused',
    contract.input.safeParse(input).success && !contract.input.safeParse({ ...input, aliases: ['x'] }).success
    && !contract.input.safeParse({ ...input, alias: '  ' }).success && !contract.input.safeParse({ ...input, alias: 'x'.repeat(61) }).success);
  const learnIn = (ch: 'answer:card' | 'answer:rerun', learn: unknown) => api.contracts[ch].input.safeParse({ projectId: pid, spec, learn }).success;
  ok('contract: answer:card and answer:rerun take a name in its strict shape only',
    learnIn('answer:card', { said: 'sales', column: 'net_sales' }) && learnIn('answer:rerun', { said: 'sales', column: 'net_sales' })
    && !learnIn('answer:card', { said: 'sales', column: 'net_sales', alias: 'x' }) && !learnIn('answer:rerun', { said: 'sales' }));
  const VIEWER: Identity = { user: { email: 'vic@acme.test', role: 'viewer' }, org: { id: 'acme' } };
  const EDITOR: Identity = { user: { email: 'eve@acme.test', role: 'editor' }, org: { id: 'acme' } };
  const grants = (rank: number) => ({ query: async () => ({ rows: [{ rank }] }) }) as unknown as import('pg').Pool;
  const decide = (who: Identity, ch: 'catalog:addAlias' | 'answer:card', payload: unknown, rank: number) =>
    context.runInContext(who, 'authz', () => authz.authorize(api.contracts[ch], payload, who, grants(rank)));
  ok('access: a project VIEWER may not teach a name', !(await decide(VIEWER, 'catalog:addAlias', input, 1)).ok);
  ok('access NEGATIVE CONTROL: the same viewer may draw the card', (await decide(VIEWER, 'answer:card', { projectId: pid, spec }, 1)).ok);
  ok('access: a project editor may teach it', (await decide(EDITOR, 'catalog:addAlias', input, 2)).ok);

  ok('the stub was asked exactly as often as it had replies', replies.length === 0 && asked > 0, String(replies.length));
  finish();
}

main().catch((e) => { console.error(e); process.exit(1); });
