// Self-check for the MANY-conversations half of src/copilot.ts: the v1 → v2
// migration contract, thread titling, the two ring caps (200 turns per thread,
// 50 threads per project), and the "most recent thread" resolution that keeps
// loadHistory()/appendTurn() working for callers that know nothing about threads.
//
// Two halves, deliberately: normalize() is exported and exercised as a PURE
// function (a v1 object in, v2 threads out — no disk, so the migration contract is
// asserted directly), then the same contract is re-asserted through real files on
// disk, because a migration that only works in memory is not a migration. Style
// follows test-copilot.ts / test-datasetsMigration.ts: stub 'electron' via
// Module._load so userData points at a temp dir, run the REAL module, no framework.

export {}; // module scope — sibling test scripts share top-level names
import { ok, failureCount } from './selfcheck';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');
const Module: any = require('module');

const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-copilot-threads-'));

const origLoad = Module._load;
Module._load = function (request: string, ...rest: any[]): any {
  if (request === 'electron') return { app: { getPath: (_n: string) => tmpUserData } };
  return origLoad.apply(this, [request, ...rest]);
};

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

  // ── 6. Many threads: isolation, titling, and "most recent" resolution ────────
  {
    const p = await projects.createProject('Multi project');
    const a = await copilot.createThread(p.id);
    ok('createThread returns a summary with a UUID id', a !== null && UUID_RE.test(a.id));
    ok('a brand-new thread is titled Conversation', a !== null && a.title === 'Conversation');
    ok('a brand-new thread has no turns', a !== null && a.turnCount === 0);

    await copilot.appendTurn(p.id, { role: 'user', text: 'Question A' }, a!.id);
    const b = await copilot.createThread(p.id);
    await copilot.appendTurn(p.id, { role: 'user', text: 'Question B' }, b!.id);

    ok('threads stay separate', (await copilot.loadHistory(p.id, a!.id)).length === 1 &&
      (await copilot.loadHistory(p.id, b!.id)).length === 1);
    ok('each thread keeps its own turn', (await copilot.loadHistory(p.id, a!.id))[0].text === 'Question A');
    ok('the first user turn renames the thread',
      (await copilot.listThreads(p.id)).find((t) => t.id === a!.id)!.title === 'Question A');
    ok('a bare loadHistory targets the most recent thread',
      (await copilot.loadHistory(p.id))[0].text === 'Question B');
    ok('listThreads is newest-touched first', (await copilot.listThreads(p.id))[0].id === b!.id);

    // Touching the OLDER thread makes it the most recent one again.
    await copilot.appendTurn(p.id, { role: 'user', text: 'Back to A' }, a!.id);
    ok('appending to an older thread makes it most recent again',
      (await copilot.latestThreadId(p.id)) === a!.id);
    ok('a bare appendTurn now targets that thread',
      (await copilot.appendTurn(p.id, { role: 'assistant', text: 'Answer A2' }))!.length === 3);

    // An unknown threadId falls back to the most recent thread, never errors.
    const stale = await copilot.loadHistory(p.id, '99999999-9999-4999-8999-999999999999');
    ok('an unknown threadId falls back to the most recent thread', stale.length === 3);
  }

  // ── 7. MAX_TURNS (200) still holds PER THREAD ───────────────────────────────
  {
    const p = await projects.createProject('Turn cap project');
    const t = await copilot.createThread(p.id);
    let list: Awaited<ReturnType<typeof copilot.appendTurn>> = [];
    for (let i = 0; i < 205; i += 1) {
      list = await copilot.appendTurn(p.id, { role: 'user', text: 'msg ' + i }, t!.id);
    }
    ok('MAX_TURNS caps a thread at 200', list !== null && list.length === 200);
    ok('the turn ring keeps the NEWEST turns',
      list !== null && list[list.length - 1].text === 'msg 204' && list[0].text === 'msg 5');
    ok('the turn cap survives a reload', (await copilot.loadHistory(p.id, t!.id)).length === 200);
    ok('the title survives its naming turn falling out of the ring',
      (await copilot.listThreads(p.id))[0].title === 'msg 0');
  }

  // ── 8. MAX_THREADS (50) — oldest-created drops first ────────────────────────
  {
    const p = await projects.createProject('Thread cap project');
    for (let i = 0; i < 55; i += 1) {
      const t = await copilot.createThread(p.id);
      await copilot.appendTurn(p.id, { role: 'user', text: 'thread ' + i }, t!.id);
    }
    const list = await copilot.listThreads(p.id);
    ok('MAX_THREADS caps a project at 50 conversations', list.length === 50);
    const titles = new Set(list.map((t) => t.title));
    ok('the thread ring dropped the OLDEST conversations',
      !titles.has('thread 0') && !titles.has('thread 4') && titles.has('thread 5'));
    ok('the thread ring kept the newest conversation', titles.has('thread 54'));
    ok('the thread cap survives a reload', (await copilot.loadThreads(p.id)).length === 50);
  }

  // ── 9. clearHistory still wipes everything ──────────────────────────────────
  {
    ok('clearHistory returns true', (await copilot.clearHistory(proj.id)) === true);
    ok('clearHistory removes every conversation', (await copilot.listThreads(proj.id)).length === 0);
    ok('clearHistory leaves loadHistory empty', (await copilot.loadHistory(proj.id)).length === 0);
    ok('clearHistory rejects a traversal projectId', (await copilot.clearHistory('..')) === false);
  }
}

main()
  .then(() => {
    try { fs.rmSync(tmpUserData, { recursive: true, force: true }); } catch (_) {}
    Module._load = origLoad;
    console.log('');
    if (failureCount()) { console.error(failureCount() + ' copilot thread check(s) FAILED'); process.exit(1); }
    console.log('All copilot thread checks passed.');
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
