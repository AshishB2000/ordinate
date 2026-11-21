// Evaluation suites: who may do what, and what never leaves (docs/eval-suites/00-design.md). The thumbs: only on one's own answer, a
// thumbs-down shares the QUESTION with the editors and never a word of the answer or a figure, a thumbs-up shares nothing, a flip or a
// clear takes the question back; the inbox is the editors', without the asker; a case from a verified question, an answer of one's own
// conversation or an inbox question; a verified SQL question and an answer without a chart are refused with a sentence; a viewer
// cannot make, read or run anything; the Judge model is the admin's.
//
//   npm run build:ts && DATABASE_URL=… node scripts/test-evalAccess.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import { evalWorld, answerAction } from './evalHarness';

const store: typeof import('../src/server/evals/db') = require('../src/server/evals/db');
const say: typeof import('../src/server/evalMessages') = require('../src/server/evalMessages');
const verified: typeof import('../src/ipc/verified') = require('../src/ipc/verified');

const CANARY = 'ANSWER_CANARY_4417';
const BY_REGION = answerAction({ dataset: 'Plain', category: 'region', measures: [{ column: 'sales', aggregation: 'sum' }] });

(async () => {
  const S = await evalWorld('eval access');
  if (!S) return;
  const { W, stub } = S;
  try {
    const askAs = async (who: string, question: string, text = `Total sales were 6252 ${CANARY}.`, action: Record<string, unknown> | null = BY_REGION) => {
      stub.asks[question] = { text, ...(action ? { action } : {}) };
      const a = await W.call(who, 'copilot:ask', { projectId: W.P, context: { kind: '' }, question });
      if (a.body?.ok !== true) throw new Error('ask failed: ' + a.text.slice(0, 200));
      return { threadId: a.body.threadId as string, turnId: a.body.turns.at(-1).id as string };
    };
    const rate = (who: string, t: { threadId: string; turnId: string }, value: string, reason?: string) => W.call(who, 'feedback:rate', { projectId: W.P, threadId: t.threadId, turnId: t.turnId, value, ...(reason ? { reason } : {}) });
    const rows = async () => (await W.pool.query('SELECT * FROM assistant_feedback ORDER BY created_at, turn_id')).rows;
    const inbox = async (who = 'ed') => (await W.call(who, 'feedback:inbox', { projectId: W.P })).body;
    const history = async (who: string, threadId: string) => (await W.call(who, 'copilot:history', { projectId: W.P, threadId })).body.turns as Array<{ id: string; feedback?: { value: string; reason?: string } }>;

    // ── thumbs ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
    const e1 = await askAs('east', 'Why are East sales low?');
    const down = await rate('east', e1, 'down', 'wrong_number');
    ok('a viewer rates their own answer: thumbs down, with a reason', down.body?.ok === true && down.body.feedback?.value === 'down' && down.body.feedback.reason === 'wrong_number', down.text);
    const row = (await rows())[0];
    ok('the row holds the value, the reason, the QUESTION, the asker and the agent (none)', row.value === 'down' && row.reason === 'wrong_number' && row.question === 'Why are East sales low?' && row.owner === 'east@acme.test' && row.agent_id === null && row.project_id === W.P);
    ok('NEGATIVE CONTROL (Q1): the row holds no word of the answer and no figure, anywhere', !JSON.stringify(await rows()).includes(CANARY) && !JSON.stringify(await rows()).includes('6252'));
    ok('the turn keeps it: a reload shows the thumb, and its stored body holds a value and a reason only', (await history('east', e1.threadId)).find((t) => t.id === e1.turnId)?.feedback?.reason === 'wrong_number'
      && /"feedback":\{"value":"down","reason":"wrong_number"\}/.test((await W.pool.query('SELECT body FROM assistant_turns WHERE id::text = $1', [e1.turnId])).rows[0].body));
    ok('another person cannot rate east\'s answer: an editor, an admin, nobody', (await Promise.all(['ed', 'boss', 'west'].map((w) => rate(w, e1, 'up')))).every((r) => r.body?.ok === false) && (await rows()).length === 1);
    ok('an unknown turn, or a user turn, cannot be rated', (await rate('east', { threadId: e1.threadId, turnId: 'nope' }, 'up')).body?.ok === false && (await rate('east', { threadId: e1.threadId, turnId: ((await history('east', e1.threadId))[0].id) }, 'up')).body?.ok === false);
    ok('an invalid value or reason is refused at the contract', (await W.call('east', 'feedback:rate', { projectId: W.P, threadId: e1.threadId, turnId: e1.turnId, value: 'meh' })).status === 400 && (await W.call('east', 'feedback:rate', { projectId: W.P, threadId: e1.threadId, turnId: e1.turnId, value: 'down', reason: 'because' })).status === 400);

    const w1 = await askAs('west', 'Top customers?');
    const up = await rate('west', w1, 'up');
    const upRow = (await rows()).find((r) => r.turn_id === w1.turnId);
    ok('a thumbs up shares nothing: no question copy, and it is not in the inbox', up.body?.ok === true && upRow.value === 'up' && upRow.question === null && (await inbox()).items.length === 1);

    // ── the inbox ───────────────────────────────────────────────────────────────────────────────────────────────────────────
    const box = await inbox('ed');
    ok('the inbox (an editor): the question, the reason, no agent', box.ok && box.items.length === 1 && box.items[0].question === 'Why are East sales low?' && box.items[0].reason === 'wrong_number' && box.items[0].agentId === null, JSON.stringify(box));
    const boxText = JSON.stringify(box) + JSON.stringify((await inbox('boss')));
    ok('NEGATIVE CONTROL (Q1): the inbox carries neither the answer, a figure, nor who asked', !boxText.includes(CANARY) && !boxText.includes('6252') && !boxText.includes('east@') && !/owner|asker|threadId/.test(boxText));
    ok('a viewer cannot open the inbox or dismiss from it', (await Promise.all(['east', 'west', 'nobody'].flatMap((w) => [W.call(w, 'feedback:inbox', { projectId: W.P }), W.call(w, 'feedback:dismiss', { projectId: W.P, turnId: e1.turnId })]))).every((r) => r.status === 403));

    // flip and clear
    await rate('east', e1, 'up');
    ok('a flip to thumbs up takes the question back: gone from the inbox and the row', (await inbox()).items.length === 0 && (await rows()).find((r) => r.turn_id === e1.turnId).question === null);
    await rate('east', e1, 'down', 'other');
    ok('flipping back down copies the question again', (await inbox()).items.length === 1);
    await rate('east', e1, 'none');
    ok('clearing a thumb deletes its row, and the turn forgets it', !(await rows()).some((r) => r.turn_id === e1.turnId) && (await history('east', e1.threadId)).find((t) => t.id === e1.turnId)?.feedback === undefined && (await inbox()).items.length === 0);

    // a case from the inbox
    await rate('east', e1, 'down', 'wrong_data');
    const noWords = await W.call('ed', 'eval:caseFrom', { projectId: W.P, newSuite: { name: 'From thumbs' }, from: { kind: 'inbox', turnId: e1.turnId } });
    ok('an inbox question needs words or a refusal to become a case, and nothing is made without them', noWords.body?.ok === false && noWords.body.error === say.badCase() && (await store.listSuites('acme', W.P)).length === 0);
    const fromInbox = await W.call('ed', 'eval:caseFrom', { projectId: W.P, newSuite: { name: 'From thumbs' }, from: { kind: 'inbox', turnId: e1.turnId, say: 'explains why East is low' } });
    const cases = fromInbox.body?.ok ? (await W.call('ed', 'eval:cases', { projectId: W.P, suiteId: fromInbox.body.suiteId })).body.cases : [];
    ok('the inbox question becomes a case in a new suite, with the editor\'s words, and leaves the inbox', fromInbox.body?.ok === true && cases.length === 1 && cases[0].question === 'Why are East sales low?' && cases[0].say === 'explains why East is low' && cases[0].source === 'inbox' && cases[0].compute === null && (await inbox()).items.length === 0, fromInbox.text);
    ok('the same inbox item cannot be added twice', (await W.call('ed', 'eval:caseFrom', { projectId: W.P, suiteId: fromInbox.body.suiteId, from: { kind: 'inbox', turnId: e1.turnId, refuse: true } })).body?.error === say.inboxGone());
    await rate('east', e1, 'up'); // handled stays handled for the same value; a flip re-opens it
    await rate('east', e1, 'down');
    ok('a handled item comes back only when the person flips their thumb', (await inbox()).items.length === 1);
    const dismissed = await W.call('boss', 'feedback:dismiss', { projectId: W.P, turnId: e1.turnId });
    ok('an editor dismisses it; a second dismissal is "no longer in the inbox"', dismissed.body?.ok === true && (await inbox()).items.length === 0 && (await W.call('ed', 'feedback:dismiss', { projectId: W.P, turnId: e1.turnId })).body?.error === say.inboxGone());

    // ── cases from an answer and from a verified question ───────────────────────────────────────────────────────────────────
    const own = await askAs('ed', 'Sales by region, ed?');
    const mkSuite = await W.call('ed', 'eval:suiteSave', { projectId: W.P, name: 'Mine' });
    const suiteId = mkSuite.body.id as string;
    const fromTurn = await W.call('ed', 'eval:caseFrom', { projectId: W.P, suiteId, from: { kind: 'turn', threadId: own.threadId, turnId: own.turnId } });
    const turnCase = (await W.call('ed', 'eval:cases', { projectId: W.P, suiteId })).body.cases.find((c: { id: string }) => c.id === fromTurn.body?.caseId);
    ok('an answer of one\'s own conversation becomes a case with its spec and its question', fromTurn.body?.ok === true && turnCase?.question === 'Sales by region, ed?' && turnCase.compute?.spec.datasetId === W.plain && turnCase.compute.datasetName === 'Plain' && turnCase.source === 'answer', fromTurn.text.slice(0, 300));
    ok('NEGATIVE CONTROL: someone else\'s answer cannot become a case, nor can a missing one', (await W.call('boss', 'eval:caseFrom', { projectId: W.P, suiteId, from: { kind: 'turn', threadId: own.threadId, turnId: own.turnId } })).body?.ok === false && (await W.call('ed', 'eval:caseFrom', { projectId: W.P, suiteId, from: { kind: 'turn', threadId: own.threadId, turnId: 'nope' } })).body?.ok === false);
    const prose = await askAs('ed', 'Just words?', 'Only words.', null);
    ok('an answer with no chart is refused with its sentence', (await W.call('ed', 'eval:caseFrom', { projectId: W.P, suiteId, from: { kind: 'turn', threadId: prose.threadId, turnId: prose.turnId } })).body?.error === say.noChart());
    const spec = { datasetId: W.plain, category: 'region', measures: [{ column: 'sales', aggregation: 'sum' as const }], filters: [], chartType: 'column', title: 'Sales by region' };
    const v = await W.as('boss', () => verified.saveVerifiedQuestion(W.P, { question: 'Revenue by region', spec }));
    if (!v.ok) throw new Error('fixture: ' + JSON.stringify(v));
    const fromV = await W.call('ed', 'eval:caseFrom', { projectId: W.P, suiteId, from: { kind: 'verified', id: v.q.id, say: 'says West leads' } });
    const vCase = (await W.call('ed', 'eval:cases', { projectId: W.P, suiteId })).body.cases.find((c: { id: string }) => c.id === fromV.body?.caseId);
    ok('a verified question is a case in one click: its spec, its question, and words if given', fromV.body?.ok === true && vCase.question === 'Revenue by region' && vCase.compute.spec.datasetId === W.plain && vCase.say === 'says West leads' && vCase.source === 'verified');
    const sqlQ = await W.call('boss', 'verified:save', { projectId: W.P, input: { question: 'Sales by SQL', sql: 'SELECT region, sum(sales) AS total FROM plain GROUP BY region' } });
    ok('a verified SQL question is refused with its sentence', sqlQ.body?.ok === true && (await W.call('ed', 'eval:caseFrom', { projectId: W.P, suiteId, from: { kind: 'verified', id: sqlQ.body.id ?? sqlQ.body.q?.id ?? sqlQ.body.question?.id } })).body?.error === say.sqlQuestion(), sqlQ.text.slice(0, 200));
    ok('a verified question that does not exist is not found', (await W.call('ed', 'eval:caseFrom', { projectId: W.P, suiteId, from: { kind: 'verified', id: '99999999-9999-4999-8999-999999999999' } })).body?.error === say.notFound());

    // ── editing, deleting, and who may ──────────────────────────────────────────────────────────────────────────────────────
    const edit = await W.call('ed', 'eval:caseSave', { projectId: W.P, suiteId, id: fromV.body.caseId, question: 'Revenue by region (edited)', refuse: true, say: 'new words' });
    const edited = (await W.call('ed', 'eval:cases', { projectId: W.P, suiteId })).body.cases.find((c: { id: string }) => c.id === fromV.body.caseId);
    ok('an edit changes the question and the words but never turns a figure case into a refusal', edit.body?.ok === true && edited.question === 'Revenue by region (edited)' && edited.say === 'new words' && edited.refuse === false && edited.compute !== null);
    ok('NEGATIVE CONTROL: a case with nothing to check is refused', (await W.call('ed', 'eval:caseSave', { projectId: W.P, suiteId, question: 'q' })).body?.error === say.badCase());
    ok('a case of another suite or project cannot be edited or deleted through this one', (await W.call('ed', 'eval:caseDelete', { projectId: W.P, suiteId: '99999999-9999-4999-8999-999999999999', id: fromV.body.caseId })).body?.ok === false);
    ok('a viewer cannot make, read, edit or run anything', (await Promise.all(['east', 'west', 'nobody'].flatMap((w) => [
      W.call(w, 'eval:suiteSave', { projectId: W.P, name: 'x' }), W.call(w, 'eval:cases', { projectId: W.P, suiteId }), W.call(w, 'eval:caseSave', { projectId: W.P, suiteId, question: 'q', say: 'x' }),
      W.call(w, 'eval:caseFrom', { projectId: W.P, suiteId, from: { kind: 'verified', id: v.q.id } }), W.call(w, 'eval:runStart', { projectId: W.P, suiteId }), W.call(w, 'eval:runList', { projectId: W.P }), W.call(w, 'eval:suiteDelete', { projectId: W.P, id: suiteId }),
    ]))).every((r) => r.status === 403));
    ok('an admin and an editor may both manage suites', (await W.call('boss', 'eval:suiteSave', { projectId: W.P, id: suiteId, name: 'Renamed' })).body?.ok === true && (await W.call('ed', 'eval:suites', { projectId: W.P })).body.suites.some((s: { name: string }) => s.name === 'Renamed'));
    const elsewhere = (await W.call('boss', 'projects:create', { name: 'Other project' })).body.id as string;
    ok('a project the editor is not in is closed to them, and a suite of this project named in another admin\'s project is not found', (await W.call('ed', 'eval:cases', { projectId: elsewhere, suiteId })).status === 403 && (await W.call('boss', 'eval:cases', { projectId: elsewhere, suiteId })).body?.error === say.notFound());

    // ── the Judge model is the admin's ──────────────────────────────────────────────────────────────────────────────────────
    ok('Judge model: an editor cannot read or set it', (await W.call('ed', 'eval:judge')).status === 403 && (await W.call('ed', 'eval:setJudge', { pick: null })).status === 403);
    ok('Judge model: none by default; the admin clears it', (await W.call('boss', 'eval:judge')).body?.pick === null && (await W.call('boss', 'eval:setJudge', { pick: null })).body?.ok === true);
    const bad = await W.call('boss', 'eval:setJudge', { pick: { provider: 'anthropic', model: 'not-enabled' } });
    ok('NEGATIVE CONTROL: a model that is not enabled in Admin → AI is refused, and nothing is saved', bad.body?.ok === false && bad.body.error === say.judgeNotEnabled() && (await store.judgePick('acme')) === null, bad.text);
  } finally {
    await S.close();
  }
})().catch((err) => { console.error(err); process.exitCode = 1; }).finally(finish);
