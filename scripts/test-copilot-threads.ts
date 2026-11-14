// Self-check for the MANY-conversations half of src/copilot.ts: the v1 → v2
// migration contract, thread titling, the two ring caps (200 turns per thread,
// 50 threads per project), and the "most recent thread" resolution that keeps
// loadHistory()/appendTurn() working for callers that know nothing about threads.
//
// Two halves, deliberately: normalize() is exported and exercised as a PURE
// function (a v1 object in, v2 threads out — no disk, so the migration contract is
// asserted directly), then the same contract is re-asserted through real files on
// disk, because a migration that only works in memory is not a migration. Style
// follows test-copilot.ts / test-datasetsMigration.ts: point userData
// (ORDINATE_LOCAL_DIR) at a temp dir, run the REAL module, no framework.
//
// Sections 6–10 are scripts/copilotStoreChecks.ts, which scripts/test-copilotRows.ts runs on the
// Postgres rows as well.

export {}; // module scope — sibling test scripts share top-level names
import { ok, failureCount } from './selfcheck';
import { oneMember, twoMembers } from './copilotStoreChecks';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');

const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-copilot-threads-'));

process.env.ORDINATE_LOCAL_DIR = tmpUserData;

// ponytail: compiled siblings of the .ts sources under test.
const copilot: typeof import('../src/ai/copilot') = require('../src/ai/copilot');
const projects: typeof import('../src/app/projects') = require('../src/app/projects');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// A v1 file exactly as the pre-threads build wrote it.
function v1File(projectId: string, turns: any[]): any {
  return { projectId, turns, schemaVersion: 1 };
}
function v1Turn(role: string, text: string, n: number): any {
  return {
    id: '00000000-0000-4000-8000-' + String(n).padStart(12, '0'),
    role,
    text,
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString(),
  };
}

function copilotJson(projectId: string): string {
  return path.join(tmpUserData, 'projects', projectId, 'copilot.json');
}

async function main(): Promise<void> {
  await projects.init();
  await copilot.init(); // no-op stub

  // ── 1. normalize(): a v1 object becomes ONE v2 thread, turns intact ──────────
  {
    const v1 = v1File('p', [
      v1Turn('user', 'How big is this dataset?', 1),
      v1Turn('assistant', 'It has 3 rows.', 2),
      v1Turn('user', 'And the max?', 3),
    ]);
    const threads = copilot.normalize(v1);
    ok('a v1 file normalizes to exactly ONE thread', threads.length === 1);
    ok('the migrated thread gets a UUID-shaped id', UUID_RE.test(threads[0].id));
    // Stability matters: normalize() runs on every read and the migration is not
    // written back until something appends, so two reads must agree on the id or
    // the renderer's "open this thread" would miss.
    ok('the migrated thread id is STABLE across reads',
      copilot.normalize(v1)[0].id === threads[0].id);
    ok('every v1 turn survives migration (same count)', threads[0].turns.length === 3);
    ok('turn texts and order survive migration verbatim',
      JSON.stringify(threads[0].turns.map((t) => t.text)) ===
      JSON.stringify(['How big is this dataset?', 'It has 3 rows.', 'And the max?']));
    ok('turn roles survive migration',
      JSON.stringify(threads[0].turns.map((t) => t.role)) ===
      JSON.stringify(['user', 'assistant', 'user']));
    ok('the migrated title comes from the FIRST user turn',
      threads[0].title === 'How big is this dataset?');
    ok('migrated timestamps come from the turns themselves',
      threads[0].createdAt === v1.turns[0].createdAt && threads[0].updatedAt === v1.turns[2].createdAt);
  }

  // ── 2. Titling edge cases ───────────────────────────────────────────────────
  {
    const noUser = copilot.normalize(v1File('p', [v1Turn('assistant', 'Hello there.', 1)]));
    ok('a v1 thread with NO user turn gets the fallback title',
      noUser.length === 1 && noUser[0].title === 'Conversation');

    const blank = copilot.normalize(v1File('p', [v1Turn('user', '   ', 1), v1Turn('user', 'Real question', 2)]));
    ok('a whitespace-only user turn does not name the thread', blank[0].title === 'Real question');

    const long = 'x'.repeat(200);
    const cut = copilot.normalize(v1File('p', [v1Turn('user', long, 1)]));
    ok('a long title is hard-truncated to 60 chars (no ellipsis)',
      cut[0].title.length === 60 && cut[0].title === 'x'.repeat(60));

    const multiline = copilot.normalize(v1File('p', [v1Turn('user', 'line one\nline two', 1)]));
    ok('a multi-line question collapses to one title line',
      multiline[0].title === 'line one line two');
  }

  // ── 3. normalize() never throws on junk, and re-sanitizes untrusted fields ───
  {
    ok('normalize(null) is []', copilot.normalize(null).length === 0);
    ok('normalize(undefined) is []', copilot.normalize(undefined).length === 0);
    ok('normalize("nope") is []', copilot.normalize('nope').length === 0);
    ok('normalize({}) is []', copilot.normalize({}).length === 0);
    ok('normalize of a v1 file with no turns is []', copilot.normalize(v1File('p', [])).length === 0);

    const junkThreads = copilot.normalize({
      projectId: 'p',
      schemaVersion: 2,
      threads: [null, 'nope', 42, { id: 'keep-me', title: 12345, turns: 'not-an-array' }],
    });
    ok('non-object threads are dropped, the real one survives', junkThreads.length === 1);
    ok('a non-string stored title is coerced to a string', typeof junkThreads[0].title === 'string');
    ok('a non-array turns field degrades to an empty thread', junkThreads[0].turns.length === 0);
    ok('a thread with no timestamps gets ISO ones',
      !Number.isNaN(Date.parse(junkThreads[0].createdAt)) &&
      !Number.isNaN(Date.parse(junkThreads[0].updatedAt)));

    // The title is untrusted-on-disk like text and provenance: length-capped too.
    const longStored = copilot.normalize({
      projectId: 'p', schemaVersion: 2,
      threads: [{ id: 'a', title: 'y'.repeat(500), createdAt: 'x', updatedAt: 'x', turns: [] }],
    });
    ok('a stored title from disk is re-capped at 60 chars', longStored[0].title.length === 60);

    // Stored provenance stays whitelisted through the thread wrapper.
    const prov = copilot.normalize({
      projectId: 'p', schemaVersion: 2,
      threads: [{ id: 'a', title: 't', turns: [
        { id: 'x', role: 'assistant', text: 'hi', createdAt: 'x',
          provenance: { kind: 'dataset', name: 'Cities', note: 'stats app-computed', evil: 'drop me' } },
      ] }],
    });
    ok('provenance stays whitelisted inside a thread',
      (prov[0].turns[0].provenance as any).evil === undefined &&
      prov[0].turns[0].provenance!.kind === 'dataset');
  }

  // ── 4. The same migration, through real files on disk ───────────────────────
  const proj = await projects.createProject('Threads project');
  {
    await fs.promises.writeFile(
      copilotJson(proj.id),
      JSON.stringify(v1File(proj.id, [
        v1Turn('user', 'What is the total?', 1),
        v1Turn('assistant', 'The total is 600.', 2),
      ]), null, 2),
      'utf8',
    );

    const hist = await copilot.loadHistory(proj.id);
    ok('loadHistory still returns the v1 turns after migration',
      hist.length === 2 && hist[0].text === 'What is the total?' && hist[1].text === 'The total is 600.');

    const list = await copilot.listThreads(proj.id);
    ok('a v1 file lists as exactly one conversation', list.length === 1);
    ok('the listed conversation is titled from the first user turn', list[0].title === 'What is the total?');
    ok('the listed conversation reports its turn count', list[0].turnCount === 2);
    ok('latestThreadId resolves the migrated thread', (await copilot.latestThreadId(proj.id)) === list[0].id);

    // The v1 file is untouched until something writes; the write upgrades it.
    const onDiskBefore = JSON.parse(await fs.promises.readFile(copilotJson(proj.id), 'utf8'));
    ok('a read alone does NOT rewrite the v1 file', onDiskBefore.schemaVersion === 1);

    const after = await copilot.appendTurn(proj.id, { role: 'user', text: 'And the max?' });
    ok('appending lands in the migrated thread (not a new one)', after !== null && after.length === 3);
    ok('appending did not fork a second conversation', (await copilot.listThreads(proj.id)).length === 1);

    const onDiskAfter = JSON.parse(await fs.promises.readFile(copilotJson(proj.id), 'utf8'));
    ok('the file on disk is now schemaVersion 2', onDiskAfter.schemaVersion === 2);
    ok('the file on disk now carries threads, not turns',
      Array.isArray(onDiskAfter.threads) && onDiskAfter.turns === undefined);
    ok('the upgraded file kept all three turns', onDiskAfter.threads[0].turns.length === 3);
    ok('the upgraded file kept its derived title', onDiskAfter.threads[0].title === 'What is the total?');
    ok('no .tmp litter after the upgrade',
      fs.readdirSync(path.dirname(copilotJson(proj.id))).every((f) => !f.includes('.tmp')));
  }

  // ── 5. A CORRUPT file still yields an empty thread list, never a throw ───────
  {
    const corrupt = await projects.createProject('Corrupt project');
    await fs.promises.writeFile(copilotJson(corrupt.id), '{ not valid json', 'utf8');
    ok('loadThreads of a corrupt file is []', (await copilot.loadThreads(corrupt.id)).length === 0);
    ok('listThreads of a corrupt file is []', (await copilot.listThreads(corrupt.id)).length === 0);
    ok('loadHistory of a corrupt file is []', (await copilot.loadHistory(corrupt.id)).length === 0);
    ok('latestThreadId of a corrupt file is null', (await copilot.latestThreadId(corrupt.id)) === null);
    ok('loadThreads of a traversal projectId is []', (await copilot.loadThreads('..')).length === 0);
    ok('createThread rejects a traversal projectId', (await copilot.createThread('..')) === null);
    ok('createThread rejects a nonexistent project',
      (await copilot.createThread('00000000-0000-0000-0000-000000000000')) === null);
  }

  // ── 6–9. The store's rules (scripts/copilotStoreChecks.ts: the rows run them too) ──
  await oneMember('file');

  // ── 10. NV-34: the cap is per member — another member's threads never evict yours ──
  {
    const context: typeof import('../src/server/context') = require('../src/server/context');
    const serverDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-copilot-owners-'));
    context.enterServerMode(serverDir); // last: there is no way back to the desktop
    const as = (email: string) => <T>(fn: () => T): T => context.runInContext({ user: { email, role: 'viewer' }, org: { id: 'acme' } }, 'nv34', fn);
    const boss = as('boss@acme.test');
    const vic = as('vic@acme.test');
    await twoMembers('file', boss, vic);

    // ── 11. A newer release's `guidance` on an assistant turn survives every thread write ──
    // copilot.json holds EVERY member's threads, so one member's append rewrites all of them: the re-save
    // goes through ANOTHER member's thread. Nothing here writes guidance through a channel.
    const { sanitizeGuidance } = require('../src/ai/turnGuidance') as typeof import('../src/ai/turnGuidance');
    const appPathsMod: typeof import('../src/app/paths') = require('../src/app/paths');
    const uuid = (n: number): string => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;
    const [V, E1, E2] = [1, 2, 3].map(uuid);
    const G = { verifiedId: V, instructions: 3, examples: [E1, E2] };
    const q = await boss(() => projects.createProject('Guidance project'));
    const file = boss(() => path.join(appPathsMod.userData(), 'projects', q.id, 'copilot.json'));
    const rawThreads = (): any[] => JSON.parse(fs.readFileSync(file, 'utf8')).threads;
    const at = '2026-11-01T00:00:00.000Z';
    const aTurn = (guidance: unknown): any => ({ id: uuid(9), role: 'assistant', text: 'r', createdAt: at, guidance });
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ projectId: q.id, schemaVersion: 2, threads: [{
      id: uuid(8), title: 'q', createdAt: at, updatedAt: at, owner: 'boss@acme.test',
      turns: [{ id: uuid(7), role: 'user', text: 'q', createdAt: at, guidance: G }, aTurn({ ...G, examples: [E1, 'bad'], extra: 1 })],
    }] }));
    await vic(() => copilot.appendTurn(q.id, { role: 'user', text: 'hello' })); // another member's append rewrites the file
    const kept = rawThreads().find((t) => t.owner === 'boss@acme.test').turns;
    ok('another member\'s append keeps guidance', kept[1].guidance?.verifiedId === V && kept[1].guidance.instructions === 3 && kept[1].guidance.examples.join() === E1, JSON.stringify(kept[1].guidance));
    ok('…and only its three fields', Object.keys(kept[1].guidance).join() === 'verifiedId,instructions,examples');
    ok('a user turn in the file never carries guidance', !('guidance' in kept[0]));
    ok('a user turn appended with guidance has none', (await vic(() => copilot.appendTurn(q.id, { role: 'user', text: 'x', guidance: G } as any)))!.at(-1)!.guidance === undefined);
    ok('appendTurn keeps it on an assistant turn', (await vic(() => copilot.appendTurn(q.id, { role: 'assistant', text: 'y', guidance: G })))!.at(-1)!.guidance!.examples.join() === `${E1},${E2}`);
    const reload = async (extra: object): Promise<any> => (await vic(() => copilot.appendTurn(q.id, { role: 'assistant', text: 'z', ...extra } as any)))!.at(-1);
    ok('a turn with no guidance has no guidance key (byte-identical)', !('guidance' in (await reload({}))) && !('guidance' in rawThreads().flatMap((t) => t.turns).at(-1)));
    ok('NEGATIVE CONTROL: an unknown turn key is still dropped', !('foo' in (await reload({ foo: 1 }))) && !('foo' in rawThreads().flatMap((t) => t.turns).at(-1)));

    ok('a count past 40 drops the guidance whole', sanitizeGuidance({ instructions: 41, examples: [] }) === undefined);
    ok('…so does a negative, fractional or non-number count', [-1, 1.5, '3', null, undefined].every((n) => sanitizeGuidance({ instructions: n, examples: [E1] }) === undefined));
    ok('…and a value that is no object', [null, 'x', 7, [], undefined].every((v) => sanitizeGuidance(v) === undefined));
    ok('0 and 40 are kept', sanitizeGuidance({ instructions: 0, examples: [] })!.instructions === 0 && sanitizeGuidance({ instructions: 40, examples: [] })!.instructions === 40);
    ok('a bad verifiedId is dropped, the rest kept', (() => { const g = sanitizeGuidance({ verifiedId: 'nope', instructions: 1, examples: [] })!; return !('verifiedId' in g) && g.instructions === 1; })());
    ok('examples keep UUIDs only, at most 5', sanitizeGuidance({ instructions: 1, examples: [1, 2, 3, 4, 5, 6, 7].map(uuid).concat('x') })!.examples.length === 5
      && sanitizeGuidance({ instructions: 1, examples: 'nope' })!.examples.length === 0);
    const once = sanitizeGuidance({ verifiedId: V, instructions: 2, examples: [E1, 'x', E2, 7] });
    ok('sanitizing twice gives what sanitizing once gives', JSON.stringify(sanitizeGuidance(JSON.parse(JSON.stringify(once)))) === JSON.stringify(once));
    fs.rmSync(serverDir, { recursive: true, force: true });
  }
}

main()
  .then(() => {
    try { fs.rmSync(tmpUserData, { recursive: true, force: true }); } catch (_) {}
    console.log('');
    if (failureCount()) { console.error(failureCount() + ' copilot thread check(s) FAILED'); process.exit(1); }
    console.log('All copilot thread checks passed.');
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
