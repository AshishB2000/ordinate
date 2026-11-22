// The issues board: who may do what (docs/issues-board/00-design.md). A viewer reads and works nothing; an editor reads and works the board
// and proposes a definition (#7's API, as that editor, with the board's own questions); only the project's admin switches the check on and
// runs it now; only the org admin touches the trackers. The board's replies carry no asker, answer, figure or token.
//
//   npm run build:ts && DATABASE_URL=… node scripts/test-issuesAccess.js

export {}; // module scope — sibling test scripts share top-level names
import { randomUUID } from 'crypto';
import { ok, finish } from './selfcheck';
import { evalWorld } from './evalHarness';
import { seeds } from './issuesHarness';

const analyze: any = require('../src/ai/analyze'); // any: the stub replaces its exports
const weekly: typeof import('../src/server/issues/weekly') = require('../src/server/issues/weekly');
const nameMod: typeof import('../src/ai/issueName') = require('../src/ai/issueName');
const draft: typeof import('../src/ai/proposalDraft') = require('../src/ai/proposalDraft');

(async () => {
  const S = await evalWorld('issues access');
  if (!S) return;
  const { W } = S;
  const baseDispatch = analyze.dispatch;
  const proposePrompts: string[] = [];
  analyze.dispatch = async (system: string, messages: Array<{ text: string }>) => {
    if (system === nameMod.NAME_SYSTEM) return { rawText: '{"title":"Define active customer","fix":"Define it as a metric."}' };
    if (system === draft.PROPOSE_SYSTEM) {
      proposePrompts.push(messages[messages.length - 1].text);
      return { rawText: '{"kind":"metric","name":"Active customers","dataset":"Plain","column":"customer","aggregation":"countd","description":"Customers who bought.","aliases":[]}' };
    }
    return baseDispatch(system, messages);
  };
  try {
    const P = W.P;
    const { seed, define } = seeds(W);
    const owners = ['ann', 'bob', 'cy', 'dee'];
    for (const o of owners) await seed(`${o}@acme.test`, [[`How many active customers did ${o} add?`, define('active customer')]]);
    await seed('bob@acme.test', [['Active customers by month?', define('active customer')]]); // bob twice: 5 questions, 4 people
    await W.call('boss', 'issues:setEnabled', { projectId: P, enabled: true });
    await W.as('boss', () => weekly.checkOrg(Date.now() + 60_000));

    const reads: Array<[string, unknown]> = [['issues:list', { projectId: P }]];
    for (const who of ['east', 'west', 'nobody']) {
      const rs = await Promise.all([
        ...reads.map(([c, p]) => W.call(who, c, p)),
        W.call(who, 'issues:setStatus', { projectId: P, id: randomUUID(), status: 'ignored' }), W.call(who, 'issues:propose', { projectId: P, id: randomUUID() }),
        W.call(who, 'issues:send', { projectId: P, id: randomUUID(), provider: 'linear' }), W.call(who, 'issues:setEnabled', { projectId: P, enabled: false }), W.call(who, 'issues:checkNow', { projectId: P }),
      ]);
      ok(`a viewer (${who}) is refused every channel of the board`, rs.every((r) => r.status === 403), rs.map((r) => r.status).join());
    }
    const board = (await W.call('ed', 'issues:list', { projectId: P })).body;
    ok('an editor reads the board: one issue, 5 questions from 4 people, with the title and fix', board.ok && board.issues.length === 1 && board.issues[0].questions === 5 && board.issues[0].people === 4 && board.issues[0].title === 'Define active customer');
    const text = JSON.stringify(board);
    ok('the board carries no email, no owner, no answer words and no figure', !/@/.test(text) && !/owner|asker|answer/i.test(text) && !text.includes('8675309') && !text.includes('ROWVALUE'));
    ok('an editor cannot switch the check, run it, or touch the trackers', (await Promise.all([W.call('ed', 'issues:setEnabled', { projectId: P, enabled: false }), W.call('ed', 'issues:checkNow', { projectId: P }), W.call('ed', 'tracker:status'), W.call('ed', 'tracker:disconnect', { provider: 'jira' })])).every((r) => r.status === 403));
    ok('another project\'s id is not found, not read', (await W.call('ed', 'issues:list', { projectId: randomUUID() })).status !== 200 || (await W.call('ed', 'issues:list', { projectId: randomUUID() })).body?.issues?.length === 0);

    // ── propose a definition (#7) ───────────────────────────────────────────────────────────────────────────────────────────
    const id = board.issues[0].id;
    const none = await W.call('ed', 'issues:propose', { projectId: P, id: randomUUID() });
    ok('proposing from an unknown issue is refused with a sentence, and costs no model call', none.body?.ok === false && proposePrompts.length === 0);
    const made = await W.call('ed', 'issues:propose', { projectId: P, id });
    ok('"Propose a definition": #7 drafts from the questions, as the editor, and raises one card', made.body?.ok === true && made.body.raised === false && made.body.asks === 5 && proposePrompts.length === 1, made.text);
    ok('the model is told the questions (their words) and the columns, never an answer or a figure', /active customers did ann add/.test(proposePrompts[0]) && /customer \(text\)/.test(proposePrompts[0]) && !proposePrompts[0].includes('8675309') && !proposePrompts[0].includes('ROWVALUE'));
    const row = (await W.pool.query(`SELECT p.name, p.state, (SELECT count(*)::int FROM metric_proposal_asks a WHERE a.proposal_id = p.id) AS asks FROM metric_proposals p`)).rows;
    ok('one open proposal exists, asked by the five questions (a person counts once per question)', row.length === 1 && row[0].name === 'Active customers' && row[0].state === 'open' && row[0].asks === 5, JSON.stringify(row));
    ok('the issue remembers it, and the board shows the link', (await W.call('ed', 'issues:list', { projectId: P })).body.issues[0].proposalId === made.body.id);
    ok('an editor reads it in #7\'s own list', (await W.call('ed', 'proposal:list', { projectId: P, decided: false })).body?.proposals?.length === 1);
    const again = await W.call('ed', 'issues:propose', { projectId: P, id });
    ok('proposing again raises the same card (no second proposal)', again.body?.ok === true && again.body.raised === true && (await W.pool.query('SELECT count(*)::int AS n FROM metric_proposals')).rows[0].n === 1);

    // ── check now, and the failure ──────────────────────────────────────────────────────────────────────────────────────────
    const now = await W.call('boss', 'issues:checkNow', { projectId: P });
    await W.as('boss', () => weekly.checkOrg(Date.now() + 60_000)); // the job any pod runs
    ok('the project admin asks for the check now; the job makes it, and nothing is added twice', now.body?.ok === true && now.body.started === true && (await W.pool.query('SELECT count(*)::int AS n FROM issue_signals')).rows[0].n === 5, now.text);
    ok('the settings: on, with the time of the last check, and no error', (await W.call('ed', 'issues:list', { projectId: P })).body.settings.lastRunAt !== null);
    ok('turning it off stops the weekly pass', (await W.call('boss', 'issues:setEnabled', { projectId: P, enabled: false })).body?.ok === true);
    await W.pool.query(`UPDATE issue_settings SET last_run_at = now() - interval '9 days'`);
    await seed('eve@acme.test', [['Active customers once more?', define('active customer')]], { ageMs: 0 });
    await W.as('boss', () => weekly.checkOrg(Date.now() + 60_000));
    ok('NEGATIVE CONTROL: with the check off, a due week reads nothing', (await W.call('ed', 'issues:list', { projectId: P })).body.issues[0].questions === 5);

    // ── a proposal keeps only the asks on its own dataset ───────────────────────────────────────────────────────────────────
    // Three people's answers showed Orders AND Plain, one's only Plain. The draft is about Plain: Orders-touching asks must not join it, because
    // anyone who edits Plain reads a proposal's questions, and a reviewer closed to Orders must not read a question whose answer showed Orders.
    await W.call('boss', 'issues:setEnabled', { projectId: P, enabled: true });
    for (const o of ['fay', 'gus', 'hal']) await seed(`${o}@acme.test`, [[`How many big customers did ${o} win?`, { ...define('big customer'), factsFrom: [W.orders, W.plain] }]], { ageMs: 0 });
    await seed('ivy@acme.test', [['How many big customers did ivy win?', define('big customer')]], { ageMs: 0 });
    await W.call('boss', 'issues:checkNow', { projectId: P });
    await W.as('boss', () => weekly.checkOrg(Date.now() + 60_000));
    const big = (await W.call('ed', 'issues:list', { projectId: P })).body.issues.find((i: { title: string; questions: number }) => i.questions === 4);
    ok('fixture: an issue of four questions, three of whose answers showed another dataset', !!big);
    const asksBefore = (await W.pool.query('SELECT count(*)::int AS n FROM metric_proposal_asks')).rows[0].n;
    const mixed = await W.call('ed', 'issues:propose', { projectId: P, id: big.id });
    const asks = (await W.pool.query(`SELECT user_email, question FROM metric_proposal_asks ORDER BY created_at DESC LIMIT 10`)).rows;
    const added = (await W.pool.query('SELECT count(*)::int AS n FROM metric_proposal_asks')).rows[0].n - asksBefore;
    ok('the proposal took ivy\'s ask only (its dataset), not the three whose answers showed Orders', mixed.body?.ok === true && added === 1 && asks.some((r: { user_email: string }) => r.user_email === 'ivy@acme.test') && !asks.some((r: { user_email: string }) => /^(fay|gus|hal)@/.test(r.user_email)), JSON.stringify([mixed.body, added]));
    const shown = JSON.stringify((await W.call('ed', 'proposal:list', { projectId: P, decided: false })).body);
    ok('NEGATIVE CONTROL: no reviewer\'s queue holds those three questions', !/big customers did (fay|gus|hal)/.test(shown) && /big customers did ivy/.test(shown));
    void owners;
  } finally {
    analyze.dispatch = baseDispatch;
    await S.close();
  }
  finish();
})().catch((e) => { console.error(e); process.exit(1); });
