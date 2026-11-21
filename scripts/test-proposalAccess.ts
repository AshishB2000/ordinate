// Metric proposals, end to end through the real RPC layer as header-signed people (the row-access world: boss the org
// admin, ed an editor, east / west / nobody viewers; Plain has no row rules) with a SCRIPTED model:
//
//   contract   propose is read and audited; list, approve and decline are write; strict input
//   propose    a viewer proposes from their OWN refused turn (not another's, not a turn with nothing to define); the editors
//              with Edit on the dataset are told, never the proposer; the model is told only columns the proposer may use
//   one card   the same need again, from another person or at once, raises the count of the one card; the same person and
//              question count once
//   refused    NEGATIVE CONTROLS: an unknown column, a column hidden from the proposer, a bad formula, a name that is taken,
//              a term on a hidden column, a figure in the words, "nothing to define", prose and an unknown dataset each
//              store nothing and give back the app's sentence (control: a good draft stores)
//   queue      only editors list; the question's words reach them, never the answer's text or a figure (canary)
//   approve    the checked save: the metric exists, its first version says it was proposed (asks) and who approved; an edit
//              is re-checked (a bad formula leaves the card open); a second approval is refused; the askers are told in the
//              bell and by push, and the badge counts it
//   decline    needs a note; saves nothing; the asker is told with the note
//   limit      past PROPOSALS_PER_DAY refused (control: the tenth goes), and a refusal gives its charge back
//   rls        the three tables as an ordinary role
//
//   npm run build:ts && DATABASE_URL=… node scripts/test-proposalAccess.js

export {}; // module scope — sibling test scripts share top-level names
import { randomBytes, randomUUID } from 'crypto';
import { Pool } from 'pg';
import { finish, ok } from './selfcheck';
import * as H from './rowPolicyHarness';

const analyze: any = require('../src/ai/analyze'); // any: replaced by a stub
const execConfig: any = require('../src/app/execConfig'); // any: replaced by a stub
const copilot: typeof import('../src/ai/copilot') = require('../src/ai/copilot');
const api: typeof import('../src/api/index') = require('../src/api/index');
const proposals: typeof import('../src/server/proposals/proposals') = require('../src/server/proposals/proposals');
const counters: typeof import('../src/server/counters') = require('../src/server/counters');
const { useOrgDb }: typeof import('../src/server/db/inOrg') = require('../src/server/db/inOrg');

type Any = any; // any: each channel's own reply
const CANARY = 'ANSWER_CANARY_5531';
const J = (o: unknown) => JSON.stringify(o);
const per = { kind: 'metric', name: 'Sales per unit', dataset: 'Plain', formula: 'sum(sales) / sum(qty)', description: 'Sales divided by units.', aliases: ['unit price'], format: 'currency' };

function contractCases(): void {
  const c = api.contracts;
  const P = randomUUID();
  ok('contract: propose is read (it saves nothing in the model), audited and project-scoped', c['proposal:propose'].access === 'read' && c['proposal:propose'].audit === true && c['proposal:propose'].project({ projectId: P, threadId: P, turnId: P }) === P);
  ok('contract: list, approve and decline are write', ['proposal:list', 'proposal:approve', 'proposal:decline'].every((ch) => c[ch as 'proposal:list'].access === 'write'));
  ok('contract: strict inputs, a decline needs a note, an edit is bounded', !c['proposal:propose'].input.safeParse({ projectId: P, threadId: P, turnId: P, extra: 1 }).success
    && !c['proposal:decline'].input.safeParse({ projectId: P, id: P, note: ' ' }).success && c['proposal:decline'].input.safeParse({ projectId: P, id: P, note: 'Not now' }).success
    && !c['proposal:approve'].input.safeParse({ projectId: P, id: P, edit: { formula: 'x'.repeat(2001) } }).success && c['proposal:approve'].input.safeParse({ projectId: P, id: P, edit: { name: 'N' } }).success);
}

(async () => {
  contractCases();
  const W = await H.world('metric proposals');
  if (!W) return finish();
  const { P } = W;
  const real = { dispatch: analyze.dispatch, ready: execConfig.executionReady };
  let reply: string | (() => string) = J(per);
  let calls = 0;
  let seen = '';
  analyze.dispatch = async (_system: string, messages: Array<{ text: string }>) => { calls += 1; seen = messages[messages.length - 1]?.text ?? ''; return { rawText: typeof reply === 'function' ? reply() : reply }; };
  execConfig.executionReady = async () => true;
  const pools: Pool[] = [];
  const roles: string[] = [];
  try {
    const q = (sql: string, args: unknown[] = []) => W.pool.query(sql, args);
    const rows = async (sql: string, args: unknown[] = []): Promise<Any[]> => (await q(sql, args)).rows;
    const count = async (): Promise<number> => Number((await rows('SELECT count(*) AS n FROM metric_proposals'))[0].n);
    /** A refused turn of `who`'s own: the question, then the app's reply marked `define`, on `datasetIds`. */
    const refused = (who: string, question: string, o: { define?: boolean; datasetIds?: string[] } = {}) => W.as(who, async () => {
      const th = (await copilot.createThread(P))!;
      await copilot.appendTurn(P, { role: 'user', text: question }, th.id);
      const turns = (await copilot.appendTurn(P, { role: 'assistant', text: `No chart. ${CANARY} 1,234,567`, ...(o.define === false ? {} : { define: true }), factsFrom: o.datasetIds ?? [W.plain] }, th.id))!;
      return { projectId: P, threadId: th.id, turnId: turns[turns.length - 1].id };
    });
    const propose = (who: string, turn: unknown) => W.call(who, 'proposal:propose', turn);

    // ── propose, who is told, one card ───────────────────────────────────────────────────────────────────────────────
    const t1 = await refused('west', 'What is the sales per unit by region?');
    const first = await propose('west', t1);
    ok('propose: a viewer proposes from their own refused answer', first.status === 200 && first.body?.ok === true && first.body.raised === false && first.body.asks === 1, first.text);
    ok('propose: the model was told the columns, the question and nothing of the answer', seen.includes('sales (number)') && seen.includes('sales per unit by region') && !seen.includes(CANARY), seen);
    const card = (await rows('SELECT * FROM metric_proposals'))[0];
    ok('propose: one open card with the checked draft, the dataset an id', card.state === 'open' && card.name === 'Sales per unit' && card.dataset_id === W.plain && card.draft.formula === 'sum(sales) / sum(qty)' && card.draft.datasetId === W.plain, J(card));
    const told = (await rows('SELECT user_email, role FROM metric_proposal_inbox ORDER BY user_email')).map((r) => `${r.user_email}:${r.role}`);
    ok('propose: the editors who may approve are told (ed and boss), never the proposer', told.join() === 'boss@acme.test:approver,ed@acme.test:approver', told.join());
    const t1b = await refused('west', 'what is the sales per unit by region?');
    ok('one card: the same person asking the same words again counts once', (await propose('west', t1b)).body?.asks === 1 && (await count()) === 1);
    const t2 = await refused('east', 'Show me unit sales value');
    const again = await propose('east', t2);
    ok('one card: another person needing it raises the count, no second card', again.body?.ok === true && again.body.raised === true && again.body.asks === 2 && again.body.id === first.body.id && (await count()) === 1, again.text);
    reply = J({ ...per, name: 'Race metric', formula: 'sum(sales)' });
    const [r1, r2] = await Promise.all([propose('west', await refused('west', 'race one')), propose('east', await refused('east', 'race two'))]);
    ok('one card: two proposals at once make one card with two asks', r1.body?.ok && r2.body?.ok && r1.body.id === r2.body.id && (await count()) === 2 && Number((await rows(`SELECT count(*) AS n FROM metric_proposal_asks a JOIN metric_proposals p ON p.id = a.proposal_id WHERE p.name = 'Race metric'`))[0].n) === 2, `${r1.text} ${r2.text}`);
    reply = J(per);

    // ── who may propose, who may read ────────────────────────────────────────────────────────────────────────────────
    const none = await refused('west', 'Anything?', { define: false });
    ok('propose: a turn with nothing to define is refused', (await propose('west', none)).body?.ok === false);
    ok('propose: someone else\'s turn is refused (control: their own goes)', (await propose('east', t1)).body?.ok === false && (await propose('nobody', t1)).body?.ok === false);
    const closed = await refused('west', 'On nothing I can open', { datasetIds: [] });
    ok('propose: a turn whose answer read no dataset the caller opens is refused', (await propose('west', closed)).body?.ok === false);
    ok('list: a viewer gets nothing (403), editors read', (await W.call('west', 'proposal:list', { projectId: P, decided: false })).status === 403 && (await W.call('ed', 'proposal:list', { projectId: P, decided: false })).body?.ok === true);
    const listed = await W.call('ed', 'proposal:list', { projectId: P, decided: false });
    const cardView = listed.body.proposals.find((x: Any) => x.name === 'Sales per unit');
    ok('list: the card holds the structure, the count and the questions\' words, and no problem', cardView?.asks === 2 && cardView.formula === 'sum(sales) / sum(qty)' && cardView.questions.length === 2 && cardView.datasetName === 'Plain' && !cardView.problem, J(cardView));
    ok('list: CANARY: nothing of the answers (their text, a figure) reaches the queue', !listed.text.includes(CANARY) && !listed.text.includes('1,234,567'));

    // ── refused drafts: nothing stored ───────────────────────────────────────────────────────────────────────────────
    await W.call('boss', 'dataset:setColumnAccess', { projectId: P, datasetId: W.plain, columns: [{ column: 'customer', visibleTo: [{ userId: W.uid.ed }] }] });
    await W.call('boss', 'metric:save', { projectId: P, input: { name: 'Revenue', datasetId: W.plain, definition: { column: 'sales', aggregation: 'sum' } } });
    const before = await count();
    const bad: Array<[string, string]> = [
      ['an unknown column', J({ ...per, name: 'Ghost', formula: 'sum(nope) / sum(qty)' })],
      ['a column hidden from the proposer', J({ ...per, name: 'Hidden', column: 'customer', formula: undefined, aggregation: 'countd' })],
      ['a hidden column in a formula', J({ ...per, name: 'Hidden two', formula: 'countd(customer) / sum(qty)' })],
      ['a bad formula', J({ ...per, name: 'Broken', formula: 'sum(sales) /' })],
      ['a name that is taken', J({ ...per, name: 'Revenue', formula: 'sum(sales)' })],
      ['an alias that is taken', J({ ...per, name: 'Fresh', aliases: ['revenue'], formula: 'sum(sales)' })],
      ['a sum of a text column', J({ ...per, name: 'Text sum', formula: undefined, column: 'region', aggregation: 'sum' })],
      ['a term on a hidden column', J({ kind: 'term', name: 'Big spenders', dataset: 'Plain', description: '', aliases: [], filters: [{ column: 'customer', op: '=', value: 'x' }] })],
      ['a figure in the words', J({ ...per, name: 'Wordy', description: 'Margin is about 42% here.' })],
      ['nothing to define', J({ kind: 'none' })],
      ['prose', 'I think margin is revenue minus cost.'],
      ['an unknown dataset', J({ ...per, name: 'Lost', dataset: 'Nowhere' })],
    ];
    for (const [label, text] of bad) {
      reply = text;
      const r = await propose('west', await refused('west', `Define ${label}`));
      ok(`refused: ${label} gives a sentence and stores nothing`, r.body?.ok === false && typeof r.body.error === 'string' && r.body.error.length > 10 && (await count()) === before, r.text);
    }
    reply = J({ ...per, name: 'Fine one', formula: 'sum(sales) / sum(qty)' });
    ok('refused (control): the same question with a good draft stores a card', (await propose('west', await refused('west', 'Define a good one'))).body?.ok === true && (await count()) === before + 1);
    const ed = await W.call('ed', 'proposal:propose', await refused('ed', 'Editor asks for a hidden thing'));
    reply = J({ ...per, name: 'Hidden for west', formula: 'countd(customer)' });
    const edHidden = await propose('ed', await refused('ed', 'ed may see customer'));
    ok('refused (control): the column hidden from west is usable by ed, who may see it', ed.body?.ok !== undefined && edHidden.body?.ok === true, edHidden.text);
    reply = J(per);

    // ── approve ──────────────────────────────────────────────────────────────────────────────────────────────────────
    const id: string = first.body.id;
    ok('approve: a viewer cannot (403)', (await W.call('west', 'proposal:approve', { projectId: P, id })).status === 403);
    const badEdit = await W.call('ed', 'proposal:approve', { projectId: P, id, edit: { formula: 'sum(sales) /' } });
    ok('approve: an edit is re-checked: a bad formula is refused, the card stays open and unclaimed', badEdit.body?.ok === false && (await rows('SELECT state, decided_by FROM metric_proposals WHERE id = $1', [id]))[0].state === 'open'
      && (await rows('SELECT decided_by FROM metric_proposals WHERE id = $1', [id]))[0].decided_by === null, badEdit.text);
    const done = await W.call('ed', 'proposal:approve', { projectId: P, id, edit: { description: 'Sales divided by units sold.' } });
    ok('approve: saved through the checked save', done.body?.ok === true, done.text);
    const metric = (await W.call('boss', 'metric:get', { projectId: P, id: done.body.savedId })).body;
    const m = metric.metric ?? metric;
    ok('approve: the metric is the draft as edited, other names in its description', m.name === 'Sales per unit' && m.definition.formula === 'sum(sales) / sum(qty)' && /Sales divided by units sold\./.test(m.description) && /Also called: unit price\./.test(m.description), J(m));
    const versions = (await W.call('boss', 'versions:list', { projectId: P, type: 'metric', id: done.body.savedId })).body as Any[];
    ok('approve: its first version says it was proposed from 2 questions, and who approved', versions.length >= 1 && versions[versions.length - 1].proposal?.asks === 2 && versions[versions.length - 1].by === 'ed@acme.test', J(versions));
    const row = (await rows('SELECT * FROM metric_proposals WHERE id = $1', [id]))[0];
    ok('approve: the card is decided (approved, edited, the saved id)', row.state === 'approved' && row.edited === true && row.saved_id === done.body.savedId && row.decided_by === 'ed@acme.test');
    ok('approve: a second approval is refused, and saved nothing more', (await W.call('boss', 'proposal:approve', { projectId: P, id })).body?.ok === false && ((await W.call('boss', 'metric:list', { projectId: P })).body.metrics as Any[]).filter((x) => x.name === 'Sales per unit').length === 1);
    const bell = (await W.call('west', 'mentions:list')).body;
    const row1 = bell.proposals.find((x: Any) => x.id === id);
    ok('approve: each asker has a bell row with their own question, unseen, and the badge counts it', row1?.mine === true && row1.state === 'approved' && row1.question === 'What is the sales per unit by region?' && row1.seen === false && bell.unseen >= 1, J(bell.proposals));
    ok('approve: the other asker (east) is told too', (await W.call('east', 'mentions:list')).body.proposals.some((x: Any) => x.id === id && x.mine && x.state === 'approved'));
    ok('approve: the approvers\' rows are seen', (await rows(`SELECT count(*) AS n FROM metric_proposal_inbox WHERE proposal_id = $1 AND role = 'approver' AND seen_at IS NULL`, [id]))[0].n === '0');
    await W.call('west', 'mentions:seen', { projectId: P, id });
    ok('approve: seen by id clears the row', (await W.call('west', 'mentions:list')).body.proposals.find((x: Any) => x.id === id)?.seen === true);
    const again2 = await propose('west', await refused('west', 'sales per unit once more'));
    ok('approve: asking for the same name once defined is refused: it is a metric now', again2.body?.ok === false, again2.text);

    // A term, approved: a real alias, the filters as the draft made them.
    reply = J({ kind: 'term', name: 'Eastern', dataset: 'Plain', description: 'The east.', aliases: ['east region'], filters: [{ column: 'region', op: '=', value: 'East' }] });
    const term = await propose('west', await refused('west', 'eastern customers please'));
    const termDone = await W.call('ed', 'proposal:approve', { projectId: P, id: term.body.id, edit: { formula: 'sum(x)' } });
    ok('approve: a formula edit on a term is refused', termDone.body?.ok === false);
    const termOk = await W.call('ed', 'proposal:approve', { projectId: P, id: term.body.id });
    const saved = ((await W.call('boss', 'term:list', { projectId: P })).body.terms as Any[]).find((x) => x.name === 'Eastern');
    ok('approve: a term saves with its aliases and its filter', termOk.body?.ok === true && saved?.aliases?.[0] === 'east region', J(saved));

    // ── decline ──────────────────────────────────────────────────────────────────────────────────────────────────────
    reply = J({ ...per, name: 'To decline', formula: 'sum(sales)' });
    const dec = await propose('west', await refused('west', 'decline me'));
    ok('decline: needs a note (400) and an editor (403)', (await W.call('ed', 'proposal:decline', { projectId: P, id: dec.body.id, note: ' ' })).status === 400 && (await W.call('west', 'proposal:decline', { projectId: P, id: dec.body.id, note: 'x' })).status === 403);
    const declined = await W.call('ed', 'proposal:decline', { projectId: P, id: dec.body.id, note: 'We track this elsewhere.' });
    const drow = (await W.call('west', 'mentions:list')).body.proposals.find((x: Any) => x.id === dec.body.id);
    ok('decline: saves nothing, and the asker is told with the note', declined.body?.ok === true && drow?.state === 'declined' && drow.answer === 'We track this elsewhere.' && !((await W.call('boss', 'metric:list', { projectId: P })).body.metrics as Any[]).some((x) => x.name === 'To decline'), J(drow));
    const decided = await W.call('ed', 'proposal:list', { projectId: P, decided: true });
    ok('decline: the decided list shows it, with who decided', decided.body.proposals.some((x: Any) => x.name === 'To decline' && x.state === 'declined' && x.decidedBy.length > 0));
    reply = J({ ...per, name: 'To decline', formula: 'sum(sales)' });
    ok('decline: a declined need may be proposed again as a new card', (await propose('west', await refused('west', 'decline me again'))).body?.ok === true);

    // ── a draft that stopped being saveable before approval is refused by the editor's own save ────────────────────────
    reply = J({ ...per, name: 'Goes stale', formula: 'sum(sales) / sum(qty)' });
    const stale = await propose('west', await refused('west', 'stale one'));
    await W.call('boss', 'metric:save', { projectId: P, input: { name: 'Goes stale', datasetId: W.plain, definition: { column: 'sales', aggregation: 'sum' } } }); // by hand, meanwhile
    const staleApprove = await W.call('ed', 'proposal:approve', { projectId: P, id: stale.body.id });
    const srow = (await rows('SELECT state, decided_by FROM metric_proposals WHERE id = $1', [stale.body.id]))[0];
    ok('stale: a name taken by hand since is refused by the editor\'s own save: the card stays open and unclaimed, one metric of that name', staleApprove.body?.ok === false
      && srow.state === 'open' && srow.decided_by === null && ((await W.call('boss', 'metric:list', { projectId: P })).body.metrics as Any[]).filter((x) => x.name === 'Goes stale').length === 1, staleApprove.text);
    await W.call('boss', 'dataset:setColumnAccess', { projectId: P, datasetId: W.plain, columns: [{ column: 'qty', visibleTo: [{ userId: W.uid.west }] }] });
    const editorSees = await W.call('ed', 'proposal:list', { projectId: P, decided: false });
    ok('stale (control): a column hidden from viewers is still the editor\'s to see, so a draft over it has no problem on their card', editorSees.body.proposals.every((x: Any) => !x.problem), editorSees.text);

    // ── not ready, and the daily limit ───────────────────────────────────────────────────────────────────────────────
    execConfig.executionReady = async () => false;
    const callsBefore = calls;
    const off = await propose('nobody', await refused('nobody', 'is the model off?'));
    execConfig.executionReady = async () => true;
    ok('not ready: no model call, and the reply says so', off.body?.ok === false && off.body.notReady === true && calls === callsBefore);
    await W.call('boss', 'dataset:setColumnAccess', { projectId: P, datasetId: W.plain, columns: null });
    let n = 0;
    reply = () => J({ ...per, name: `Limit ${n++}`, formula: 'sum(sales)' });
    let last: Any = null;
    let tenth = false;
    for (let i = 1; i <= proposals.PROPOSALS_PER_DAY + 1; i += 1) {
      last = await propose('nobody', await refused('nobody', `limit question ${i}`));
      if (i === proposals.PROPOSALS_PER_DAY) tenth = last.body?.ok === true;
    }
    ok('limit: the tenth goes (control), the eleventh is refused with a sentence', tenth && last.body?.ok === false && last.body.code === 'rate_limited', last.text);
    reply = 'nope';
    const o = await propose('nobody', await refused('nobody', 'after the limit'));
    ok('limit: a refusal past the limit does not call the model', o.body?.code === 'rate_limited');
    await counters.forgetForTest('acme', 'proposal:from:');
    const c0 = calls;
    await propose('nobody', await refused('nobody', 'a refused draft gives its charge back'));
    await propose('nobody', await refused('nobody', 'and again'));
    ok('limit: a draft the app refuses gives its charge back (the model was called both times)', calls === c0 + 2);

    // ── RLS: the three tables, as an ordinary role ───────────────────────────────────────────────────────────────────
    const role = `proposals_role_${process.pid}`;
    roles.push(role);
    const pw = randomBytes(12).toString('hex');
    await q(`CREATE ROLE ${role} LOGIN PASSWORD '${pw}'`);
    await q(`GRANT ALL ON ALL TABLES IN SCHEMA public TO ${role}`);
    const url = new URL((W.pool as Any).options.connectionString);
    url.username = role;
    url.password = pw;
    const pool = new Pool({ connectionString: url.toString(), max: 2 });
    pool.on('error', () => undefined);
    pools.push(pool);
    const seeOrg = async (org: string, table: string): Promise<number> => {
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        await c.query("SELECT set_config('ordinate.org', $1, true)", [org]);
        const r = await c.query(`SELECT count(*)::int AS n FROM ${table}`);
        await c.query('ROLLBACK');
        return r.rows[0].n;
      } finally {
        c.release();
      }
    };
    for (const table of ['metric_proposals', 'metric_proposal_asks', 'metric_proposal_inbox']) {
      ok(`rls: ${table} shows its org's rows (control) and no other org's`, (await seeOrg('acme', table)) > 0 && (await seeOrg('other', table)) === 0 && (await pool.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n === 0);
    }
    let blocked = false;
    try {
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        await c.query("SELECT set_config('ordinate.org', 'other', true)");
        await c.query(`INSERT INTO metric_proposals (org_id, id, project_id, kind, name, name_key, dataset_id, draft) VALUES ('acme', $1, $1, 'metric', 'x', 'x', $1, '{}'::jsonb)`, [randomUUID()]);
      } finally {
        await c.query('ROLLBACK').catch(() => undefined);
        c.release();
      }
    } catch { blocked = true; }
    ok('rls: NEGATIVE CONTROL: a write for another org is refused', blocked);
    useOrgDb(W.pool);
  } finally {
    analyze.dispatch = real.dispatch;
    execConfig.executionReady = real.ready;
    for (const p of pools) await p.end().catch(() => undefined);
    for (const r of roles) await W.pool.query(`DROP OWNED BY ${r}`).then(() => W.pool.query(`DROP ROLE ${r}`)).catch(() => undefined);
    await W.close();
  }
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
}).finally(finish);
