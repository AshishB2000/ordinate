// The Assistant's conversation rules, asserted through src/ai/copilot.ts's public functions on
// whichever store is wired: copilot.json (scripts/test-copilot-threads.ts) or the Postgres rows
// (scripts/test-copilotRows.ts). A helper, not a suite; every label starts with the store's tag.

import { ok } from './selfcheck';

const copilot: typeof import('../src/ai/copilot') = require('../src/ai/copilot');
const projects: typeof import('../src/app/projects') = require('../src/app/projects');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type As = <T>(fn: () => Promise<T>) => Promise<T>;

const tagged = (tag: string) => (label: string, cond: boolean, extra?: unknown): void => ok(`${tag}: ${label}`, cond, extra);

/** `fn` with every `new Date()` / `Date.now()` at one instant, so each write lands in the same millisecond. */
async function frozen<T>(fn: () => Promise<T>): Promise<T> {
  const Real = Date;
  const at = Real.now();
  class Still extends Real {
    constructor(...a: unknown[]) {
      super(...((a.length ? a : [at]) as [number]));
    }
    static now(): number { return at; }
  }
  (globalThis as { Date: DateConstructor }).Date = Still as DateConstructor;
  try {
    return await fn();
  } finally {
    (globalThis as { Date: DateConstructor }).Date = Real;
  }
}

/**
 * One member: turn ids and times, provenance, titles, "most recent" and its same-millisecond
 * tie-break, appendTurn targeting, both caps, rename, delete and clear. Run it inside that
 * member's request context (or on the desktop, where there is one person).
 */
export async function oneMember(tag: string): Promise<void> {
  const check = tagged(tag);

  // ── 5b. A turn as stored: its id, its time, its whitelisted provenance ──────
  {
    const p = await projects.createProject('Turn project');
    const turns = (await copilot.appendTurn(p.id, {
      role: 'assistant', text: 'It has 2 rows.',
      provenance: { kind: 'dataset', name: 'Cities', columns: ['city', 'pop'], note: 'stats app-computed', evil: 'drop me' } as never,
    }))!;
    check('appendTurn assigns a UUID id and an ISO createdAt', UUID_RE.test(turns[0].id) && new Date(turns[0].createdAt).toISOString() === turns[0].createdAt);
    check('provenance is whitelisted, and survives a reload',
      JSON.stringify((await copilot.loadHistory(p.id))[0].provenance) === JSON.stringify({ kind: 'dataset', name: 'Cities', note: 'stats app-computed', columns: ['city', 'pop'] }));
    check('a role that is neither is stored as user', (await copilot.appendTurn(p.id, { role: 'system' as never, text: 'x' }))!.at(-1)!.role === 'user');
  }

  // ── 5c. Same millisecond: the last one touched is the most recent ───────────
  {
    const p = await projects.createProject('Tie project');
    const [a, b, last, list, times] = await frozen(async () => {
      const a = (await copilot.createThread(p.id))!;
      const b = (await copilot.createThread(p.id))!;
      const first = await copilot.latestThreadId(p.id);
      await copilot.appendTurn(p.id, { role: 'user', text: 'back to a' }, a.id);
      const list = await copilot.listThreads(p.id);
      return [a, b, first, list, new Set(list.map((t) => t.updatedAt))] as const;
    });
    check('control: every write here shares one millisecond (the tie-break alone orders them)', times.size === 1, [...times]);
    check('a tie goes to the conversation created last', last === b.id);
    check('…and an append makes its conversation the most recent and first in the list', list[0].id === a.id && list[1].id === b.id, JSON.stringify(list));
  }

  // ── 6. Many threads: isolation, titling, and "most recent" resolution ────────
  {
    const p = await projects.createProject('Multi project');
    const a = await copilot.createThread(p.id);
    check('createThread returns a summary with a UUID id', a !== null && UUID_RE.test(a.id));
    check('a brand-new thread is titled Conversation', a !== null && a.title === 'Conversation');
    check('a brand-new thread has no turns', a !== null && a.turnCount === 0);

    await copilot.appendTurn(p.id, { role: 'user', text: 'Question A' }, a!.id);
    const b = await copilot.createThread(p.id);
    await copilot.appendTurn(p.id, { role: 'user', text: 'Question B' }, b!.id);

    check('threads stay separate', (await copilot.loadHistory(p.id, a!.id)).length === 1 &&
      (await copilot.loadHistory(p.id, b!.id)).length === 1);
    check('each thread keeps its own turn', (await copilot.loadHistory(p.id, a!.id))[0].text === 'Question A');
    check('the first user turn renames the thread',
      (await copilot.listThreads(p.id)).find((t) => t.id === a!.id)!.title === 'Question A');
    check('a bare loadHistory targets the most recent thread',
      (await copilot.loadHistory(p.id))[0].text === 'Question B');
    check('listThreads is newest-touched first', (await copilot.listThreads(p.id))[0].id === b!.id);

    // Touching the OLDER thread makes it the most recent one again.
    await copilot.appendTurn(p.id, { role: 'user', text: 'Back to A' }, a!.id);
    check('appending to an older thread makes it most recent again',
      (await copilot.latestThreadId(p.id)) === a!.id);
    check('a bare appendTurn now targets that thread',
      (await copilot.appendTurn(p.id, { role: 'assistant', text: 'Answer A2' }))!.length === 3);

    // An unknown threadId falls back to the most recent thread, never errors.
    const stale = await copilot.loadHistory(p.id, '99999999-9999-4999-8999-999999999999');
    check('an unknown threadId falls back to the most recent thread', stale.length === 3);
  }

  // ── 7. MAX_TURNS (200) still holds PER THREAD ───────────────────────────────
  {
    const p = await projects.createProject('Turn cap project');
    const t = await copilot.createThread(p.id);
    let list: Awaited<ReturnType<typeof copilot.appendTurn>> = [];
    for (let i = 0; i < 205; i += 1) {
      list = await copilot.appendTurn(p.id, { role: 'user', text: 'msg ' + i }, t!.id);
    }
    check('MAX_TURNS caps a thread at 200', list !== null && list.length === 200);
    check('the turn ring keeps the NEWEST turns',
      list !== null && list[list.length - 1].text === 'msg 204' && list[0].text === 'msg 5');
    check('the turn cap survives a reload', (await copilot.loadHistory(p.id, t!.id)).length === 200);
    check('the title survives its naming turn falling out of the ring',
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
    check('MAX_THREADS caps a project at 50 conversations', list.length === 50);
    const titles = new Set(list.map((t) => t.title));
    check('the thread ring dropped the OLDEST conversations',
      !titles.has('thread 0') && !titles.has('thread 4') && titles.has('thread 5'));
    check('the thread ring kept the newest conversation', titles.has('thread 54'));
    check('the thread cap survives a reload', (await copilot.loadThreads(p.id)).length === 50);
  }

  // ── 8b. renameThread / deleteThread ─────────────────────────────────────────
  {
    const p = await projects.createProject('Rename and delete project');
    const a = (await copilot.createThread(p.id))!;
    await copilot.appendTurn(p.id, { role: 'user', text: 'first question' }, a.id);
    const b = (await copilot.createThread(p.id))!;
    await copilot.appendTurn(p.id, { role: 'user', text: 'second question' }, b.id);
    const order = async () => JSON.stringify((await copilot.listThreads(p.id)).map((t) => [t.id, t.updatedAt]));
    const titleOf = async (id: string) => (await copilot.loadThreads(p.id)).find((t) => t.id === id)?.title;
    const before = await order();

    const renamed = await copilot.renameThread(p.id, a.id, '  Q3\n board   pack  ');
    check('renameThread returns the summary with the title cleaned to one line',
      renamed !== null && renamed.title === 'Q3 board pack' && renamed.id === a.id && renamed.turnCount === 1, JSON.stringify(renamed));
    check('a rename is not a touch: order and updatedAt are unchanged', (await order()) === before);
    check('the rename survives a reload', (await titleOf(a.id)) === 'Q3 board pack');
    check('the other conversation keeps its own title', (await titleOf(b.id)) === 'second question');
    await copilot.appendTurn(p.id, { role: 'user', text: 'a later question' }, a.id);
    check('a later turn does not re-derive a renamed title', (await titleOf(a.id)) === 'Q3 board pack');
    check('a long title is cut at 60', (await copilot.renameThread(p.id, a.id, 'x'.repeat(200)))?.title === 'x'.repeat(60));
    check('an empty title renames nothing', (await copilot.renameThread(p.id, a.id, ' \n ')) === null && (await titleOf(a.id)) === 'x'.repeat(60));
    check('an unknown thread renames nothing', (await copilot.renameThread(p.id, '11111111-1111-4111-8111-111111111111', 'x')) === null);
    check('renameThread rejects a traversal projectId', (await copilot.renameThread('..', a.id, 'x')) === null);

    check('deleteThread removes the conversation', (await copilot.deleteThread(p.id, a.id)) === true);
    const left = await copilot.listThreads(p.id);
    check('…and only that one: the other keeps its turns', left.length === 1 && left[0].id === b.id && left[0].turnCount === 1, JSON.stringify(left));
    check('its turns are gone: its id now resolves to the most recent conversation',
      (await copilot.loadHistory(p.id, a.id)).map((t) => t.text).join() === 'second question');
    check('the delete survives a reload', (await copilot.loadThreads(p.id)).length === 1);
    check('deleting it again is false', (await copilot.deleteThread(p.id, a.id)) === false);
    check('deleteThread rejects a traversal projectId', (await copilot.deleteThread('..', b.id)) === false && (await copilot.loadThreads(p.id)).length === 1);
  }

  // ── 9. clearHistory still wipes everything ──────────────────────────────────
  {
    const proj = await projects.createProject('Clear project');
    await copilot.appendTurn(proj.id, { role: 'user', text: 'one' });
    await copilot.appendTurn(proj.id, { role: 'user', text: 'two' }, (await copilot.createThread(proj.id))!.id);
    check('clearHistory returns true', (await copilot.clearHistory(proj.id)) === true);
    check('clearHistory removes every conversation', (await copilot.listThreads(proj.id)).length === 0);
    check('clearHistory leaves loadHistory empty', (await copilot.loadHistory(proj.id)).length === 0);
    check('clearHistory rejects a traversal projectId', (await copilot.clearHistory('..')) === false);
  }
}

/** NV-34: the cap is per member — another member's threads never evict yours. */
export async function twoMembers(tag: string, boss: As, vic: As): Promise<void> {
  const check = tagged(tag);
  const p = await boss(() => projects.createProject('Shared project'));
  const mine = (await boss(() => copilot.createThread(p.id)))!;
  await boss(() => copilot.appendTurn(p.id, { role: 'user', text: 'boss question' }, mine.id));
  for (let i = 0; i < 50; i += 1) await vic(() => copilot.createThread(p.id));
  check('NV-34: 50 new threads by another member leave the owner\'s conversation',
    (await boss(() => copilot.listThreads(p.id))).some((t) => t.id === mine.id)
      && (await boss(() => copilot.loadHistory(p.id, mine.id))).map((t) => t.text).join() === 'boss question');
  const vicFirst = (await vic(() => copilot.listThreads(p.id))).at(-1)!.id;
  await vic(() => copilot.createThread(p.id));
  const vicNow = await vic(() => copilot.listThreads(p.id));
  check('NV-34 control: a member\'s own 51st thread still evicts their own oldest', vicNow.length === 50 && !vicNow.some((t) => t.id === vicFirst));
  check('NV-34: …and the store keeps both members\' conversations after a reload',
    (await boss(() => copilot.loadThreads(p.id))).length === 51);
}
