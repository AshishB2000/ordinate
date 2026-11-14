// The Assistant's conversations as Postgres rows (src/ai/copilotRows.ts, 0023_assistant_threads.sql,
// docs/assistant-threads/00-design.md), on the real app over a scratch database
// (scripts/notifyHarness.ts). Without DATABASE_URL: one skip line.
//
//   (a) the store's rules: scripts/copilotStoreChecks.ts, the same checks the file store runs;
//   (b) one member never reads, appends to, renames, marks or deletes another's conversation,
//       directly or over RPC — control: the other's conversation is there (loadThreads sees all);
//   (c) moving copilot.json keeps every turn of every owner: the file store's view against the
//       rows' view, every field with Object.is — NEGATIVE CONTROL: one changed field is caught.
//       The record is gone after; one an older pod writes later is moved too; a corrupt one is
//       kept aside, never fatal; a clear during a half-done move sticks — NEGATIVE CONTROL: without
//       the record lock the cleared conversations come back;
//   (d) an append writes no record (no project-wide rewrite) — NEGATIVE CONTROL: the file store does;
//   (e) a NUL in a turn's text is stored as U+FFFD — NEGATIVE CONTROL: Postgres refuses it raw;
//       appends number turns 1, 2, 3, and a moved file's new turn after them — NEGATIVE CONTROL:
//       a second turn with one number in one conversation is refused;
//   (f) deleting the project (projects:delete) deletes its conversations; a database failure
//       reaches the reply as a catalog sentence — NEGATIVE CONTROL: the raw error has text of its own;
//   (g) forced RLS: an ordinary role sees its org's rows only, and none with no org set.
//
// Concurrent appends from two members: scripts/test-copilotThreadLock.ts (its Postgres leg).
//
//   npm run build:ts && DATABASE_URL=… node scripts/test-copilotRows.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import { oneMember, twoMembers } from './copilotStoreChecks';
import { BOSS, ORG, ordinaryRole, refusedAs, seenAs, show, withServer, type Identity } from './notifyHarness';

const copilot: typeof import('../src/ai/copilot') = require('../src/ai/copilot');
const projects: typeof import('../src/app/projects') = require('../src/app/projects');
const recordFs: typeof import('../src/app/recordFs') = require('../src/app/recordFs');
const inOrg: typeof import('../src/server/db/inOrg') = require('../src/server/db/inOrg');

type Thread = import('../src/ai/copilot').CopilotThread;
const ANN = 'ann@acme.test';
const BEA = 'bea@acme.test';
const who = (email: string): Identity => ({ user: { email, role: 'editor' }, org: { id: ORG } });
const id = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const at = (n: number): string => new Date(Date.UTC(2026, 9, 1, 12, 0, n)).toISOString();

/** Every primitive in `v` with its path, in key order. */
function leaves(v: unknown, at = '$', out: Array<[string, unknown]> = []): Array<[string, unknown]> {
  if (v !== null && typeof v === 'object') {
    out.push([at, Array.isArray(v) ? 'array' : 'object']);
    for (const [k, x] of Object.entries(v)) leaves(x, `${at}.${k}`, out);
  } else out.push([at, v]);
  return out;
}
/** The first path where `a` and `b` differ (Object.is on each leaf), or null when they agree. */
function differs(a: unknown, b: unknown): string | null {
  const [x, y] = [leaves(a), leaves(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if (!x[i] || !y[i] || x[i][0] !== y[i][0] || !Object.is(x[i][1], y[i][1])) return `${show(x[i])} vs ${show(y[i])}`;
  }
  return null;
}

// A copilot.json as this release's file store writes it: two members, a desktop import's
// conversation (no owner), every optional turn field, and two conversations touched in one millisecond.
function fixture(projectId: string): object {
  const spec = { datasetId: id(900), category: 'region', measures: [{ column: 'sales', aggregation: 'sum' }], filters: [{ column: 'year', op: '=', value: 2026 }], chartType: 'column', title: 'Sales by region', series: 'channel', top: 5 };
  const turn = (n: number, role: string, text: string, extra: object = {}): object => ({ id: id(n), role, text, createdAt: at(n), ...extra });
  return { projectId, schemaVersion: 2, threads: [
    { id: id(1), title: 'Sales by region?', createdAt: at(1), updatedAt: at(4), owner: ANN, turns: [
      turn(2, 'user', 'Sales by region?'),
      turn(3, 'assistant', 'North leads with "1.2M" 🚀\nthen South.', {
        provenance: { kind: 'dataset', name: 'Shop', datasetName: 'Shop', columns: ['region', 'sales'], note: 'stats app-computed' },
        answer: spec, learn: { said: 'turnover', column: 'sales' }, savedVisualId: id(901), guidance: { verifiedId: id(902), instructions: 2, examples: [id(903)] },
      }),
      turn(4, 'user', 'And by channel?'),
    ] },
    { id: id(10), title: 'From the desktop', createdAt: at(5), updatedAt: at(6), turns: [turn(11, 'user', 'An old desktop question')] },
    { id: id(20), title: 'Conversation', createdAt: at(7), updatedAt: at(8), owner: BEA, turns: [
      turn(21, 'assistant', 'Which one did you mean?', { suggest: { part: 'measure', said: 'revenue', options: [{ label: 'Sum of sales', spec, column: 'sales' }] } }),
    ] },
    { id: id(30), title: 'Tie A', createdAt: at(9), updatedAt: at(9), owner: ANN, turns: [turn(31, 'user', 'Tie A')] },
    { id: id(40), title: 'Tie B', createdAt: at(9), updatedAt: at(9), owner: ANN, turns: [turn(41, 'user', 'Tie B')] },
  ] };
}

/** What each public read returns, for every member and every one of their conversations. */
async function views(run: <T>(i: Identity, fn: () => Promise<T>) => Promise<T>, pid: string): Promise<object> {
  const all = await run(who(ANN), () => copilot.loadThreads(pid));
  const per: Record<string, object> = {};
  for (const m of [ANN, BEA]) {
    per[m] = await run(who(m), async () => ({
      list: await copilot.listThreads(pid),
      latest: await copilot.latestThreadId(pid),
      bare: await copilot.loadHistory(pid),
      each: await Promise.all(all.filter((t) => t.owner === m).map((t) => copilot.loadHistory(pid, t.id))),
    }));
  }
  return { all, per };
}

withServer('copilot-rows', {}, async (b) => {
  const run = b.run;
  const as = (email: string) => <T>(fn: () => Promise<T>): Promise<T> => run(who(email), fn);
  const appPool = inOrg.orgDb();
  ok('the app keeps conversations as rows (DATABASE_URL)', appPool !== null);
  const rowsOff = <T>(fn: () => Promise<T>): Promise<T> => {
    inOrg.useOrgDb(null); // the file store, on records: what a pod of the release before wrote
    return fn().finally(() => inOrg.useOrgDb(appPool));
  };
  const fileOf = (pid: string): string => copilot.copilotFilePath(pid);

  // ── (a) the store's rules ─────────────────────────────────────────────────
  await as(ANN)(() => oneMember('rows'));
  await twoMembers('rows', as(ANN), as(BEA));

  // ── (b) one member never touches another's conversation ──────────────────
  {
    const pid = (await run(BOSS, () => projects.createProject('Isolation'))).id;
    await b.provision('bea');
    await b.share(pid, 'bea', 'viewer');
    const spec = { datasetId: id(900), category: 'region', measures: [{ column: 'sales', aggregation: 'sum' as const }], filters: [], chartType: 'column', title: 'Sales by region' };
    const annT = (await as(ANN)(() => copilot.createThread(pid)))!.id;
    await as(ANN)(() => copilot.appendTurn(pid, { role: 'user', text: 'ann private question' }, annT));
    const annTurn = (await as(ANN)(() => copilot.appendTurn(pid, { role: 'assistant', text: 'ann answer', answer: spec as never }, annT)))!.at(-1)!;
    const all = await as(ANN)(() => copilot.loadThreads(pid));
    ok('isolation control: Ann\'s conversation is there, with both turns', all.some((t) => t.id === annT && t.owner === ANN && t.turns.length === 2));
    const bea = as(BEA);
    ok('isolation: Bea\'s list leaves it out', !(await bea(() => copilot.listThreads(pid))).some((t) => t.id === annT));
    ok('isolation: Bea asking for it by id gets none of its turns', (await bea(() => copilot.loadHistory(pid, annT))).every((t) => !t.text.startsWith('ann')));
    ok('isolation: it is never Bea\'s most recent', (await bea(() => copilot.latestThreadId(pid))) !== annT);
    const beaTurns = await bea(() => copilot.appendTurn(pid, { role: 'user', text: 'bea writes' }, annT));
    ok('isolation: Bea appending to its id lands in a conversation of her own', !!beaTurns && beaTurns.map((t) => t.text).join() === 'bea writes', show(beaTurns));
    ok('isolation: Bea cannot rename, mark or delete it',
      (await bea(() => copilot.renameThread(pid, annT, 'taken'))) === null
        && (await bea(() => copilot.markSaved(pid, annT, annTurn.id, spec as never, id(950)))) === false
        && (await bea(() => copilot.deleteThread(pid, annT))) === false);
    const after = (await as(ANN)(() => copilot.loadThreads(pid))).find((t) => t.id === annT);
    ok('isolation: …and Ann\'s conversation is unchanged', after?.title === 'ann private question' && after.turns.length === 2 && after.turns[1].savedVisualId === undefined, show(after));
    const api = b.as('bea');
    const listed = (await api.call('copilot:threads', { projectId: pid })).body;
    const hist = (await api.call('copilot:history', { projectId: pid, threadId: annT })).body;
    const del = (await api.call('copilot:deleteThread', { projectId: pid, threadId: annT })).body;
    ok('isolation over RPC: copilot:threads, copilot:history and copilot:deleteThread give Bea nothing of Ann\'s',
      listed.ok && !listed.threads.some((t: { id: string }) => t.id === annT) && hist.ok && hist.threadId !== annT
        && hist.turns.every((t: { text: string }) => !t.text.startsWith('ann')) && del.ok === false,
      show([listed, hist, del]));
    ok('isolation over RPC: …and Ann\'s conversation is still there', (await as(ANN)(() => copilot.listThreads(pid))).some((t) => t.id === annT));
  }

  // ── (c) the move from copilot.json ────────────────────────────────────────
  {
    const pid = (await run(BOSS, () => projects.createProject('Move'))).id;
    await as(ANN)(() => recordFs.writeFile(fileOf(pid), JSON.stringify(fixture(pid), null, 2)));
    const before = await rowsOff(() => views(run, pid));
    const stored = (before as { all: Thread[] }).all;
    ok('move control: the file store reads all 5 conversations of the fixture (2 members and a desktop one)', stored.length === 5 && stored.flatMap((t) => t.turns).length === 7, show(stored));
    const moved = await views(run, pid);
    const diff = differs(before, moved);
    ok('move: every conversation and turn of every owner reads the same from the rows, field by field (Object.is)', diff === null, diff);
    ok('move: …including the desktop conversation, still nobody\'s', (moved as { all: Thread[] }).all.some((t) => t.id === id(10) && !('owner' in t)));
    ok('move: …and the millisecond tie still goes to the one touched last', (await as(ANN)(() => copilot.latestThreadId(pid))) === id(40));
    const changed = JSON.parse(JSON.stringify(moved));
    changed.all[0].turns[1].guidance.instructions = 3;
    const dropped = JSON.parse(JSON.stringify(moved));
    dropped.per[ANN].each[0].pop();
    ok('move NEGATIVE CONTROL: one changed field, or one missing turn, is caught', differs(before, changed) !== null && differs(before, dropped) !== null);
    ok('move: the record is gone', !(await as(ANN)(() => recordFs.exists(fileOf(pid)))));
    ok('move: a second read moves nothing twice', (await as(ANN)(() => copilot.loadThreads(pid))).flatMap((t) => t.turns).length === 7);

    // An older pod, mid-rollout, writes copilot.json again: the next call moves that too.
    await rowsOff(() => as(ANN)(() => copilot.appendTurn(pid, { role: 'user', text: 'from an older pod' }, id(1))));
    ok('move control: the older pod wrote copilot.json again', await as(ANN)(() => recordFs.exists(fileOf(pid))));
    const later = await as(ANN)(() => copilot.loadThreads(pid));
    ok('move: …and the next call moves its turn in, with every earlier one kept',
      later.flatMap((t) => t.turns).length === 8 && later.some((t) => t.turns.some((x) => x.text === 'from an older pod'))
        && later.find((t) => t.id === id(1))?.turns.length === 3 && !(await as(ANN)(() => recordFs.exists(fileOf(pid)))),
      show(later.map((t) => [t.id, t.turns.length])));

    // A file holding a conversation already moved (a desktop import run twice), with one turn more
    // at its START: that turn is numbered after the conversation's own, as an append numbers it.
    // Numbered by its place in the file it would clash with seq 1, and the move would fail for good.
    const again = fixture(pid) as { threads: Array<{ turns: object[] }> };
    again.threads = [again.threads[0]];
    again.threads[0].turns.unshift({ id: id(50), role: 'user', text: 'one more', createdAt: at(50) });
    await as(ANN)(() => recordFs.writeFile(fileOf(pid), JSON.stringify(again)));
    await as(ANN)(() => copilot.loadThreads(pid));
    const seqs = (await b.pool.query<{ id: string; seq: number }>('SELECT id::text, seq FROM assistant_turns WHERE project_id = $1 AND thread_id = $2 ORDER BY seq', [pid, id(1)])).rows;
    ok('move: a conversation found again with one more turn numbers it after its own (1–3 kept, 4 new), and the file goes',
      seqs.map((r) => `${r.seq}:${r.id.slice(-2)}`).join() === '1:02,2:03,3:04,4:50' && !(await as(ANN)(() => recordFs.exists(fileOf(pid)))), show(seqs));

    // A copilot.json that is not JSON: skipped as the file store skipped it, and kept aside.
    const bad = (await run(BOSS, () => projects.createProject('Corrupt'))).id;
    await as(ANN)(() => recordFs.writeFile(fileOf(bad), '{ not json'));
    ok('move: a corrupt copilot.json reads as no conversations, never an error', (await as(ANN)(() => copilot.listThreads(bad))).length === 0);
    ok('move: …it is kept as copilot.json.corrupt, byte for byte, and not read again',
      !(await as(ANN)(() => recordFs.exists(fileOf(bad)))) && (await as(ANN)(() => recordFs.readFile(fileOf(bad) + '.corrupt', 'utf8'))) === '{ not json');

    // Clear history while a move is half done — its first look at the file (`pause` 1) or its read
    // under the lock (2) held back until the clear has started: the cleared conversations never come back.
    const clearMidMove = async (pause: 1 | 2): Promise<{ moved: number; left: number }> => {
      const p = (await run(BOSS, () => projects.createProject('Clear race'))).id;
      await as(ANN)(() => recordFs.writeFile(fileOf(p), JSON.stringify(fixture(p))));
      const real = recordFs.readFile;
      let reached!: () => void;
      let go!: () => void;
      const atGate = new Promise<void>((r) => (reached = r));
      const gate = new Promise<void>((r) => (go = r));
      let reads = 0;
      (recordFs as { readFile: unknown }).readFile = async (f: string, enc: BufferEncoding) => {
        const out = await real(f, enc);
        if (f === fileOf(p) && ++reads === pause) { reached(); await gate; }
        return out;
      };
      try {
        const moving = as(ANN)(() => copilot.listThreads(p));
        await atGate;
        const clearing = as(ANN)(() => copilot.clearHistory(p));
        await Promise.race([clearing, new Promise((r) => setTimeout(r, 300))]);
        go();
        const [list] = await Promise.all([moving, clearing]);
        const left = (await b.pool.query<{ n: number }>('SELECT count(*)::int AS n FROM assistant_threads WHERE project_id = $1', [p])).rows[0].n;
        return { moved: list.length, left };
      } finally {
        (recordFs as { readFile: unknown }).readFile = real;
      }
    };
    const early = await clearMidMove(1);
    ok('move: a clear right after a move\'s first look leaves no conversation (the move finds the file gone)', early.moved === 0 && early.left === 0, show(early));
    const locked = await clearMidMove(2);
    ok('move: a clear during a half-done move leaves no conversation — control: the move did move Ann\'s 3',
      locked.moved === 3 && locked.left === 0, show(locked));
    const realLocked = recordFs.locked;
    (recordFs as { locked: unknown }).locked = (_p: string, f: () => Promise<unknown>) => f();
    let bare: { moved: number; left: number };
    try {
      bare = await clearMidMove(2);
    } finally {
      (recordFs as { locked: unknown }).locked = realLocked;
    }
    ok('move NEGATIVE CONTROL: without the record lock, the half-done move brings the cleared conversations back', bare.left > 0, show(bare));
  }

  // ── (d) an append rewrites no record ──────────────────────────────────────
  {
    const pid = (await run(BOSS, () => projects.createProject('Cost'))).id;
    const spied = async (fn: () => Promise<unknown>): Promise<number> => {
      const real = { writeFile: recordFs.writeFile, rename: recordFs.rename };
      let n = 0;
      const rf = recordFs as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
      for (const k of ['writeFile', 'rename'] as const) rf[k] = (...a: unknown[]) => { n++; return (real[k] as (...x: unknown[]) => Promise<unknown>)(...a); };
      try {
        await fn();
      } finally {
        Object.assign(recordFs, real);
      }
      return n;
    };
    await as(ANN)(() => copilot.appendTurn(pid, { role: 'user', text: 'first' }));
    const writes = await spied(() => as(ANN)(() => copilot.appendTurn(pid, { role: 'user', text: 'second' })));
    ok('cost: an append writes no record (its turn and its conversation are rows)', writes === 0, writes);
    const turns = (await b.pool.query<{ n: number }>('SELECT count(*)::int AS n FROM assistant_turns WHERE project_id = $1', [pid])).rows[0].n;
    ok('cost: …and both turns are rows of assistant_turns', turns === 2, turns);
    const fileWrites = await spied(() => rowsOff(() => as(ANN)(() => copilot.appendTurn(pid, { role: 'user', text: 'third' }))));
    ok('cost NEGATIVE CONTROL: the same append on the file store rewrites copilot.json', fileWrites > 0, fileWrites);
  }

  // ── (e) a NUL in a turn's text ────────────────────────────────────────────
  {
    const pid = (await run(BOSS, () => projects.createProject('Nul'))).id;
    const turns = await as(ANN)(() => copilot.appendTurn(pid, { role: 'user', text: 'a\0b' }));
    ok('nul: a turn whose text holds a NUL is stored, as U+FFFD', turns?.at(-1)?.text === 'a\uFFFDb' && (await as(ANN)(() => copilot.loadHistory(pid)))[0]?.text === 'a\uFFFDb', show(turns));
    const raw = await b.pool.query(`INSERT INTO assistant_turns (org_id, project_id, thread_id, id, seq, role, text, created_at) SELECT org_id, project_id, id, $2, 9, 'user', $3, now() FROM assistant_threads WHERE project_id = $1`, [pid, id(990), 'a\0b'])
      .then(() => 'stored', (e: Error) => e.message);
    ok('nul NEGATIVE CONTROL: Postgres refuses the raw text', /0x00/.test(raw), raw);
  }

  // ── (e2) one number per turn in a conversation ────────────────────────────
  {
    const pid = (await run(BOSS, () => projects.createProject('Seq'))).id;
    for (const text of ['q1', 'q2', 'q3']) await as(ANN)(() => copilot.appendTurn(pid, { role: 'user', text }));
    const rows = (await b.pool.query<{ seq: number; thread_id: string }>('SELECT seq, thread_id::text FROM assistant_turns WHERE project_id = $1 ORDER BY seq', [pid])).rows;
    ok('seq: appends number a conversation\'s turns 1, 2, 3', rows.map((r) => r.seq).join() === '1,2,3' && new Set(rows.map((r) => r.thread_id)).size === 1, show(rows));
    const dup = await b.pool.query(`INSERT INTO assistant_turns (org_id, project_id, thread_id, id, seq, role, text, created_at) VALUES ($1, $2, $3, $4, 2, 'user', 'x', now())`, [ORG, pid, rows[0].thread_id, id(991)])
      .then(() => 'stored', (e: { code?: string }) => e.code ?? 'error');
    ok('seq NEGATIVE CONTROL: a second turn numbered 2 in the same conversation is refused (unique index)', dup === '23505', dup);
  }

  // ── (f) deleting the project deletes its conversations ───────────────────
  {
    const pid = (await run(BOSS, () => projects.createProject('Doomed'))).id;
    await as(BOSS.user.email)(() => copilot.appendTurn(pid, { role: 'user', text: 'soon gone' }));
    const count = async (): Promise<number> => (await b.pool.query<{ n: number }>('SELECT (SELECT count(*) FROM assistant_threads WHERE project_id = $1) + (SELECT count(*) FROM assistant_turns WHERE project_id = $1) AS n', [pid])).rows[0].n;
    const had = Number(await count());
    const del = await b.as('boss').call('projects:delete', { id: pid });
    ok('project delete: control — it had a conversation and a turn', had === 2, had);
    ok('project delete: projects:delete deletes its conversations and turns', del.body?.ok === true && Number(await count()) === 0, show([del.status, del.body]));
  }

  // ── (f2) a database failure reaches the reply in the catalog's words only ──
  {
    const pid = (await run(BOSS, () => projects.createProject('Hiccup'))).id;
    const { Pool } = require('pg') as typeof import('pg');
    const dead = new Pool({ connectionString: 'postgres://nobody@127.0.0.1:1/none', connectionTimeoutMillis: 300 });
    dead.on('error', () => undefined);
    inOrg.useOrgDb(dead);
    try {
      const raw = await run(BOSS, () => inOrg.inOrg((c) => c.query('SELECT 1'))).then(() => '', (e: Error) => e.message);
      const hist = (await b.as('boss').call('copilot:history', { projectId: pid })).body;
      const fresh = (await b.as('boss').call('copilot:newThread', { projectId: pid })).body;
      ok('hiccup NEGATIVE CONTROL: the database\'s own error has text of its own (what would have reached the reply)', raw !== '' && !raw.includes('Try again'), raw);
      ok('hiccup: a read says "This could not be read…", a save "This could not be saved…", never the database\'s text',
        hist.ok === false && hist.error === 'This could not be read. Try again in a moment.'
          && fresh.ok === false && fresh.error === 'This could not be saved. Try again in a moment.'
          && !JSON.stringify([hist, fresh]).includes(raw),
        show([hist, fresh]));
      ok('hiccup: …and the log says why', b.log.some((l) => l.includes('conversation rows not read') && l.includes(raw.slice(0, 20))));
    } finally {
      inOrg.useOrgDb(appPool);
      await dead.end().catch(() => undefined);
    }
  }

  // ── (g) forced RLS ────────────────────────────────────────────────────────
  {
    await b.pool.query(`INSERT INTO assistant_threads (org_id, project_id, id, owner, title, created_at, updated_at) VALUES ('globex', $1, $1, 'g@globex.test', 't', now(), now())`, [id(980)]);
    const role = await ordinaryRole(b, ['assistant_threads', 'assistant_turns'], [], 'SELECT, INSERT, UPDATE, DELETE');
    await b.pool.query(`GRANT USAGE ON SEQUENCE assistant_threads_touched TO ${(await role.query<{ u: string }>('SELECT current_user AS u')).rows[0].u}`);
    try {
      for (const table of ['assistant_threads', 'assistant_turns']) {
        const all = (await b.pool.query<{ org_id: string }>(`SELECT org_id FROM ${table}`)).rows;
        const acme = await seenAs(role, table, ORG);
        ok(`rls ${table}: as acme an ordinary role sees exactly acme's rows (not vacuous)`, acme.length > 0 && acme.length === all.filter((r) => r.org_id === ORG).length);
        ok(`rls ${table}: with no org set, nothing`, (await seenAs(role, table, null)).length === 0);
        ok(`rls ${table}: as globex, none of acme's`, (await seenAs(role, table, 'globex')).every((r) => r.org_id === 'globex'));
      }
      ok('rls: a write for another org is refused (WITH CHECK)', await refusedAs(role, 'globex',
        `INSERT INTO assistant_threads (org_id, project_id, id, owner, title, created_at, updated_at) VALUES ('acme', $1, $1, 'x', 't', now(), now())`, [id(981)]));
      inOrg.useOrgDb(role);
      const viaRole = await as(ANN)(async () => {
        const pid = (await run(BOSS, () => projects.createProject('Role'))).id;
        return (await copilot.appendTurn(pid, { role: 'user', text: 'as an ordinary role' }))?.length === 1 && (await copilot.listThreads(pid)).length === 1;
      });
      ok('rls: the store\'s own statements pass as an ordinary role', viaRole);
    } finally {
      inOrg.useOrgDb(appPool);
      await role.end();
    }
  }
})
  .catch((e) => ok('copilot rows suite ran to the end', false, e && e.stack ? e.stack : String(e)))
  .finally(finish);
