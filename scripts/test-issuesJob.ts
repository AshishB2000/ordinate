// The issues board's weekly check, end to end over real rows (docs/issues-board/00-design.md): off by default; reads stored conversations and
// thumbs only, with NO engine query (a spy on every query path, and a negative control that the spy sees one); groups by cause; hides a group
// under three questions until it grows; a rerun adds nothing; a resolved issue that comes back reopens, an ignored one stays; hidden
// conversations and research turns are skipped; the model sees question words and signal names only (a canary: a planted figure and row value
// in the answers never reach the prompt or any row the board keeps); forced row-level security.
//
//   npm run build:ts && DATABASE_URL=… node scripts/test-issuesJob.js

export {}; // module scope — sibling test scripts share top-level names
import { randomUUID } from 'crypto';
import { ok, finish } from './selfcheck';
import { evalWorld } from './evalHarness';

const analyze: any = require('../src/ai/analyze'); // any: the stub replaces its exports
const weekly: typeof import('../src/server/issues/weekly') = require('../src/server/issues/weekly');
const store: typeof import('../src/server/issues/db') = require('../src/server/issues/db');
const nameMod: typeof import('../src/ai/issueName') = require('../src/ai/issueName');
const note: typeof import('../src/ai/numberAuditNote') = require('../src/ai/numberAuditNote');
const duck: Record<string, unknown> = require('../src/engine/duckdb');
const pool: Record<string, unknown> = require('../src/engine/duckdbPool');
const datasets: any = require('../src/data/datasets'); // any: the spy replaces getDataset

const FIG = '8675309';
const ROW = 'ROWVALUE_CANARY_3141';
const DAY = 86_400_000;

(async () => {
  const S = await evalWorld('issues job');
  if (!S) return;
  const { W } = S;
  const prompts: string[] = [];
  let naming: 'ok' | 'digit' | 'fail' = 'ok';
  const baseDispatch = analyze.dispatch;
  analyze.dispatch = async (system: string, messages: Array<{ text: string }>) => {
    if (system !== nameMod.NAME_SYSTEM) return baseDispatch(system, messages);
    prompts.push(messages[messages.length - 1].text);
    if (naming === 'fail') return { error: { ok: false, errorType: 'provider', message: 'provider error' } };
    return { rawText: naming === 'digit' ? '{"title":"Fix 3 filters","fix":"Do it."}' : '{"title":"Define the missing name","fix":"Define it as a business term."}' };
  };
  try {
    const P = W.P;
    const run = () => W.as('boss', () => weekly.checkOrg(Date.now() + 60_000));
    let n = 0;
    /** One conversation: `[question, answerBody, answerText?]` pairs, seconds apart. */
    const seed = async (owner: string, pairs: Array<[string, Record<string, unknown>, string?]>, o: { hidden?: boolean; ageMs?: number } = {}) => {
      const thread = randomUUID();
      const t0 = Date.now() - (o.ageMs ?? 2 * DAY);
      await W.pool.query(`INSERT INTO assistant_threads (org_id, project_id, id, owner, title, created_at, updated_at, hidden) VALUES ('acme', $1, $2, $3, 'T', $4, $4, $5)`, [P, thread, owner, new Date(t0), !!o.hidden]);
      let seq = 0;
      const ids: string[] = [];
      for (const [q, body, text] of pairs) {
        const at = new Date(t0 + seq * 300_000);
        await W.pool.query(`INSERT INTO assistant_turns (org_id, project_id, thread_id, id, seq, role, text, created_at, body) VALUES ('acme', $1, $2, $3, $4, 'user', $5, $6, '{}')`, [P, thread, randomUUID(), seq++, q, at]);
        const id = randomUUID();
        ids.push(id);
        await W.pool.query(`INSERT INTO assistant_turns (org_id, project_id, thread_id, id, seq, role, text, created_at, body) VALUES ('acme', $1, $2, $3, $4, 'assistant', $5, $6, $7)`, [P, thread, id, seq++, text ?? `I could not chart that. ${FIG} ${ROW}`, new Date(at.getTime() + 1000), JSON.stringify({ factsFrom: [W.plain], ...body })]);
      }
      return ids;
    };
    const thumb = (owner: string, question: string, reason = 'wrong_number') => W.pool.query(
      `INSERT INTO assistant_feedback (org_id, project_id, turn_id, thread_id, owner, value, reason, question, dataset_ids, created_at, updated_at) VALUES ('acme', $1, $2, $3, $4, 'down', $5, $6, $7::jsonb, now() - interval '1 day', now() - interval '1 day')`,
      [P, `th${++n}`, randomUUID(), owner, reason, question, JSON.stringify([W.plain])]);
    const option = { label: 'Customer', spec: { datasetId: W.plain, category: 'region', measures: [{ column: 'sales', aggregation: 'sum' }] } };
    const define = (said: string) => ({ define: true, suggest: { part: 'filter', said, options: [option] }, snapshot: { card: { rows: [[ROW, FIG]] } }, ledger: [{ value: Number(FIG) }] });
    const list = async (who = 'ed') => (await W.call(who, 'issues:list', { projectId: P })).body;

    // ── off by default ──────────────────────────────────────────────────────────────────────────────────────────────────────
    for (const who of ['u1', 'u2', 'u3', 'u4']) await seed(`${who}@acme.test`, [[`How many active customers did we add in ${who}?`, define('active customer')]]);
    await seed('u5@acme.test', [['Active customers by region?', define('active customer')]]);
    await seed('u6@acme.test', [['Payroll by team?', { outside: { dataset: 'Payroll' } }]]);
    await seed('u7@acme.test', [['Payroll per employee?', { outside: { dataset: 'Payroll' } }]]);
    await seed('ghost@acme.test', [['How many active customers?', define('active customer')], ['Active customers please', define('active customer')], ['Show active customers', define('active customer')]], { hidden: true });
    await seed('r@acme.test', [['Why did churn rise?', { research: { runId: randomUUID() }, ...define('active customer') }]]);
    const settings = (await W.call('ed', 'issues:settings', { projectId: P })).body;
    ok('the check is OFF by default', settings.ok && settings.enabled === false && settings.lastRunAt === null, JSON.stringify(settings));
    let seen = 0;
    const spied: Array<[Record<string, unknown>, string, unknown]> = [];
    const spy = async <T>(fn: () => Promise<T>): Promise<{ out: T; calls: number }> => {
      let calls = 0;
      for (const m of [duck, pool]) for (const k of Object.keys(m)) if (typeof m[k] === 'function') { spied.push([m, k, m[k]]); const real = m[k] as (...a: unknown[]) => unknown; m[k] = (...a: unknown[]) => { calls += 1; return real(...a); }; }
      const realGet = datasets.getDataset;
      datasets.getDataset = (...a: unknown[]) => { calls += 1; return realGet(...a); };
      try { return { out: await fn(), calls }; } finally { for (const [m, k, f] of spied.splice(0)) m[k] = f; datasets.getDataset = realGet; }
    };
    const idle = await spy(run);
    ok('while off, a pass reads nothing, calls no model and makes no issue', (await W.pool.query('SELECT count(*)::int AS n FROM issues')).rows[0].n === 0 && prompts.length === 0 && idle.calls === 0);
    ok('NEGATIVE CONTROL: the spy sees an engine path being called', (await spy(async () => datasets.getDataset(P, W.plain).catch(() => null))).calls > 0);

    ok('a viewer cannot switch it on, and nor can an editor', (await Promise.all(['east', 'ed'].map((who) => W.call(who, 'issues:setEnabled', { projectId: P, enabled: true })))).every((r) => r.status === 403));
    ok('the project admin switches it on', (await W.call('boss', 'issues:setEnabled', { projectId: P, enabled: true })).body?.ok === true && (await W.call('ed', 'issues:settings', { projectId: P })).body.enabled === true);

    // ── the first check ─────────────────────────────────────────────────────────────────────────────────────────────────────
    await thumb('t1@acme.test', 'Orders last week looks wrong?');
    await thumb('t2@acme.test', 'Why are orders last week so low?');
    await thumb('t3@acme.test', 'Orders last week by ship date?', 'wrong_data');
    await seed('t4@acme.test', [['Total sales this month?', {}, `Sales were up.\n\n${note.GUARD_NOTE}${FIG}`]]);
    const first = await spy(run);
    ok('the weekly pass makes NO engine query and hydrates no dataset', first.calls === 0, `${first.calls} calls`);
    const rows = (await W.pool.query('SELECT key, status, named, title, fix FROM issues ORDER BY key')).rows;
    const byKey = (k: string) => rows.find((r: { key: string }) => r.key === k);
    ok('the groups: the missing name, the out-of-scope dataset, the words of the thumbs-down questions, and the lone untraced one', rows.length === 4 && !!byKey('name:active customer') && !!byKey('outside:payroll') && rows.some((r: { key: string }) => r.key.startsWith('words:') && r.key.includes('orders')), JSON.stringify(rows.map((r: { key: string }) => r.key)));
    ok('hidden conversations and research turns were not read: the name group holds 5 questions, not 8', Number((await W.pool.query(`SELECT count(DISTINCT turn_id) AS n FROM issue_signals s JOIN issues i ON i.id = s.issue_id WHERE i.key = 'name:active customer'`)).rows[0].n) === 5);
    const board = await list();
    ok('the board shows groups of three or more only: the missing name (5) and the thumbs-down words (3)', board.ok && board.issues.length === 2 && board.issues.some((i: { questions: number; people: number }) => i.questions === 5 && i.people === 5) && board.issues.some((i: { questions: number }) => i.questions === 3), JSON.stringify(board.issues?.map((i: { title: string; questions: number }) => [i.title, i.questions])));
    ok('the Payroll group (2) and the untraced one (1) are stored and hidden', byKey('outside:payroll') && !board.issues.some((i: { kinds: Array<{ kind: string }> }) => i.kinds.some((k) => k.kind === 'outside')));
    ok('one model call per new group on the board (2), none for a hidden one', prompts.length === 2 && rows.filter((r: { named: boolean }) => r.named).length === 2, `${prompts.length} calls`);
    const allPrompts = prompts.join('\n');
    ok('the prompt holds question words and signal names', /undefined_name x5/.test(allPrompts) && /active customers/i.test(allPrompts) && /thumbs_down\(wrong_number\) x2/.test(allPrompts));
    const everything = JSON.stringify({ allPrompts, board, rows: (await W.pool.query('SELECT * FROM issues')).rows, signals: (await W.pool.query('SELECT * FROM issue_signals')).rows, settings: (await W.pool.query('SELECT * FROM issue_settings')).rows });
    ok('CANARY: a planted figure and row value, in answers, snapshots, ledgers and the audit note, are in no prompt and no row of the board', !everything.includes(FIG) && !everything.includes(ROW) && !/ledger|snapshot/.test(everything), everything.length + '');
    ok('NEGATIVE CONTROL: the canary IS in the stored answers (the test plants what it hunts)', (await W.pool.query(`SELECT count(*)::int AS n FROM assistant_turns WHERE text LIKE '%${ROW}%' OR body LIKE '%${ROW}%'`)).rows[0].n > 5);
    ok('the board carries no asker: no email, no owner', !JSON.stringify(board).includes('@') && !/owner|asker/.test(JSON.stringify(board)));

    const again = await run();
    ok('a second pass the same day adds nothing (not due: the last check is stamped)', (await W.pool.query('SELECT count(*)::int AS n FROM issue_signals')).rows[0].n === Number((await W.pool.query('SELECT count(*)::int AS n FROM issue_signals')).rows[0].n) && again === false && prompts.length === 2);
    const before = (await W.pool.query('SELECT count(*)::int AS n FROM issue_signals')).rows[0].n;
    await W.pool.query(`UPDATE issue_settings SET last_run_at = now() - interval '8 days'`);
    await run();
    ok('a forced rerun over the same rows adds no signal and no issue and names nothing twice', (await W.pool.query('SELECT count(*)::int AS n FROM issue_signals')).rows[0].n === before && (await W.pool.query('SELECT count(*)::int AS n FROM issues')).rows[0].n === 4 && prompts.length === 2);

    // ── growth ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
    await seed('u8@acme.test', [['Payroll by region?', { outside: { dataset: 'Payroll' } }]], { ageMs: DAY });
    await W.pool.query(`UPDATE issue_settings SET last_run_at = now() - interval '8 days'`);
    await run();
    const grown = await list();
    ok('a group that grows to three appears on the board, and is named then', grown.issues.length === 3 && grown.issues.some((i: { kinds: Array<{ kind: string }> }) => i.kinds[0].kind === 'outside') && prompts.length === 3, `${grown.issues.length} issues, ${prompts.length} prompts`);
    ok('the new group\'s prompt names the dataset the questions point to', /names: Payroll/.test(prompts[2]));
    const nameIssue = grown.issues.find((i: { kinds: Array<{ kind: string }> }) => i.kinds.some((k) => k.kind === 'name' || k.kind === 'undefined_name'));
    await seed('u9@acme.test', [['Another active customer question?', define('active customer')]], { ageMs: DAY });
    await W.pool.query(`UPDATE issue_settings SET last_run_at = now() - interval '8 days'`);
    await run();
    ok('a group already on the board grows (6 questions), with no new model call', (await list()).issues.find((i: { id: string }) => i.id === nameIssue.id).questions === 6 && prompts.length === 3);

    // ── status, reopen ──────────────────────────────────────────────────────────────────────────────────────────────────────
    ok('an editor resolves it', (await W.call('ed', 'issues:setStatus', { projectId: P, id: nameIssue.id, status: 'resolved' })).body?.ok === true && (await list()).issues.find((i: { id: string }) => i.id === nameIssue.id).status === 'resolved');
    await run(); // not due: nothing changes
    ok('a resolved issue stays resolved while nothing new comes', (await list()).issues.find((i: { id: string }) => i.id === nameIssue.id).status === 'resolved');
    await new Promise((r) => setTimeout(r, 1100));
    await seed('u10@acme.test', [['Active customers again?', define('active customer')]], { ageMs: 0 });
    await W.pool.query(`UPDATE issue_settings SET last_run_at = now() - interval '8 days'`);
    await run();
    const reopened = (await list()).issues.find((i: { id: string }) => i.id === nameIssue.id);
    ok('a resolved issue that comes back reopens itself, and counts it', reopened.status === 'open' && reopened.reopened === 1 && reopened.questions === 7, JSON.stringify(reopened));
    await W.call('ed', 'issues:setStatus', { projectId: P, id: nameIssue.id, status: 'ignored' });
    await new Promise((r) => setTimeout(r, 1100));
    await seed('u11@acme.test', [['Active customer count?', define('active customer')]], { ageMs: 0 });
    await W.pool.query(`UPDATE issue_settings SET last_run_at = now() - interval '8 days'`);
    await run();
    const ignored = (await list()).issues.find((i: { id: string }) => i.id === nameIssue.id);
    ok('NEGATIVE CONTROL: an ignored issue stays ignored when it comes back, and still counts', ignored.status === 'ignored' && ignored.reopened === 1 && ignored.questions === 8);
    ok('a bad status is refused at the contract', (await W.call('ed', 'issues:setStatus', { projectId: P, id: nameIssue.id, status: 'done' })).status === 400);
    ok('an unknown issue is not found', (await W.call('ed', 'issues:setStatus', { projectId: P, id: randomUUID(), status: 'open' })).body?.ok === false);

    // ── a model that fails or breaks the rules ─────────────────────────────────────────────────────────────────────────────
    naming = 'digit';
    for (const who of ['v1', 'v2', 'v3']) await seed(`${who}@acme.test`, [[`Refund rate for premium plans ${who}?`, { suggest: { part: 'measure', said: 'refund rate', options: [option] } }]], { ageMs: 0 });
    await W.pool.query(`UPDATE issue_settings SET last_run_at = now() - interval '8 days'`);
    await run();
    const refunds = (await W.pool.query(`SELECT named, title, fix FROM issues WHERE key = 'miss:measure:refund rate'`)).rows[0];
    ok('a reply with a digit is refused: the app\'s own title stands, unnamed, to try again', refunds && refunds.named === false && refunds.title.includes('refund rate') && !/\d/.test(refunds.title), JSON.stringify(refunds));
    naming = 'fail';
    await W.pool.query(`UPDATE issue_settings SET last_run_at = now() - interval '8 days'`);
    await run();
    ok('a failing model changes nothing and the check still finishes', (await W.pool.query(`SELECT named FROM issues WHERE key = 'miss:measure:refund rate'`)).rows[0].named === false && (await W.pool.query('SELECT last_error FROM issue_settings')).rows[0].last_error === null);
    naming = 'ok';
    await W.pool.query(`UPDATE issue_settings SET last_run_at = now() - interval '8 days'`);
    await run();
    ok('the next check names it', (await W.pool.query(`SELECT named, title FROM issues WHERE key = 'miss:measure:refund rate'`)).rows[0].named === true);

    // ── the check now ───────────────────────────────────────────────────────────────────────────────────────────────────────
    ok('"Check now" is the project admin\'s; an editor is refused', (await W.call('ed', 'issues:checkNow', { projectId: P })).status === 403 && (await W.call('boss', 'issues:checkNow', { projectId: P })).body?.ok === true);

    // ── row-level security ──────────────────────────────────────────────────────────────────────────────────────────────────
    const ordinary = await S.ordinary();
    const asOrg = async (org: string | null, sql: string) => {
      const c = await ordinary.connect();
      try {
        await c.query('BEGIN');
        if (org) await c.query(`SELECT set_config('ordinate.org', $1, true)`, [org]);
        const r = await c.query(sql);
        await c.query('ROLLBACK');
        return r;
      } finally { c.release(); }
    };
    for (const t of ['issues', 'issue_signals', 'issue_settings', 'issue_tickets', 'tracker_integrations']) {
      const mine = await asOrg('acme', `SELECT count(*)::int AS n FROM ${t}`);
      const none = await asOrg(null, `SELECT count(*)::int AS n FROM ${t}`);
      const other = await asOrg('other', `SELECT count(*)::int AS n FROM ${t}`);
      ok(`rls: ${t} shows its org's rows (control) and none to another org or to no org`, (t === 'issue_tickets' || t === 'tracker_integrations' || mine.rows[0].n > 0) && none.rows[0].n === 0 && other.rows[0].n === 0);
    }
    let refused = false;
    try { await asOrg('other', `INSERT INTO issues (org_id, id, project_id, key, kind) VALUES ('acme', gen_random_uuid(), gen_random_uuid(), 'x', 'refused')`); } catch { refused = true; }
    ok('rls: NEGATIVE CONTROL: a write for another org is refused', refused);
    void seen;
  } finally {
    analyze.dispatch = baseDispatch;
    await S.close();
  }
  finish();
})().catch((e) => { console.error(e); process.exit(1); });
