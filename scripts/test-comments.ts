// Self-check for comments and annotations — src/app/commentModel.ts (pure),
// src/app/comments.ts (the store + sync), the bundle entry, and the one
// rule the Assistant depends on: comments never enter buildFacts.
//
//   1. TARGETING   every kind, a point with and without a series, bad kinds
//                  and ids dropped, every length capped.
//   2. RESOLVE     the state transitions, and a slow clock still stamping later.
//   3. RECONCILE   "two machines": divergent copies of one base reconcile to the
//                  SAME value both ways — edits, replies on both sides, a delete
//                  tombstone, resolve vs reopen — and reconcile(x, x) is x.
//   4. AUTHOR      the display name, else the OS user.
//   5. STORE       two machines on one synced project folder: the sync
//                  service's conflict copies are folded in by id and removed,
//                  both machines converge; a half-written copy is left alone;
//                  only the author deletes.
//   6. BUNDLE      comments.json travels, and its target ids follow the remap.
//   7. FACTS       a comment's words and figures never reach buildFacts.
//
// The 'electron' module is stubbed (Module._load) so userData can be switched
// between two "machines" inside one process: config.load() re-reads the
// config of whichever one is current.
//
//   npm run build:ts && node scripts/test-comments.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');
const { randomUUID }: typeof import('crypto') = require('crypto');
const Module: any = require('module'); // ponytail: Node's private _load hook, untyped

const REPO = path.resolve(__dirname, '..');
const tmp = (tag: string): string => fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-comments-' + tag + '-'));
const MACHINE_A = tmp('a');
const MACHINE_B = tmp('b');
let userData = MACHINE_A;

const origLoad = Module._load;
Module._load = function (request: string, ...rest: any[]): any {
  if (request === 'electron') {
    return {
      app: { getPath: (_name: string) => userData, getAppPath: () => REPO, getVersion: () => '9.9.9' },
      ipcMain: { handle: () => {} }, net: {}, dialog: {}, shell: {},
      safeStorage: { isEncryptionAvailable: () => false },
    };
  }
  return origLoad.apply(this, [request, ...rest]);
};

// ponytail: compiled siblings of the modules under test.
const model: typeof import('../src/app/commentModel') = require('../src/app/commentModel');
const comments: typeof import('../src/app/comments') = require('../src/app/comments');
const config: typeof import('../src/app/config') = require('../src/app/config');
const projects: typeof import('../src/app/projects') = require('../src/app/projects');
const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
const analysis: typeof import('../src/analysis/analysis') = require('../src/analysis/analysis');
const bundle: typeof import('../src/app/bundle') = require('../src/app/bundle');
const ipcCopilot: typeof import('../src/ipc/copilot') = require('../src/ipc/copilot');

type Comment = import('../src/app/commentModel').Comment;

const ID = (): string => randomUUID();
const T0 = '2026-09-01T10:00:00.000Z';
const at = (min: number): string => new Date(Date.parse(T0) + min * 60_000).toISOString();
const J = (x: unknown): string => JSON.stringify(x);

function use(dir: string): void {
  userData = dir;
  config.load();
}

// ── 1. targeting ──────────────────────────────────────────────────────────────

function targeting(): void {
  const id = ID();
  for (const kind of model.TARGET_KINDS) {
    ok('target: kind "' + kind + '" is accepted', J(model.sanitizeTarget({ kind, id })) === J({ kind, id }));
  }
  ok('target: a point keeps its label and series',
    J(model.sanitizeTarget({ kind: 'card', id, point: { label: 'Q3', series: 'West' } })) === J({ kind: 'card', id, point: { label: 'Q3', series: 'West' } }));
  ok('target: a point without a series has no series key',
    J(model.sanitizeTarget({ kind: 'visual', id, point: { label: 'Q3', series: '' } })) === J({ kind: 'visual', id, point: { label: 'Q3' } }));
  ok('target: a numeric label is kept, as text', model.sanitizeTarget({ kind: 'visual', id, point: { label: 2024 } })!.point!.label === '2024');
  ok('target: an unknown kind is dropped', model.sanitizeTarget({ kind: 'metric', id }) === null);
  ok('target: a non-UUID id is dropped', model.sanitizeTarget({ kind: 'card', id: '../../etc' }) === null);
  ok('target: a missing target is dropped', model.sanitizeTarget(null) === null);
  const long = 'x'.repeat(model.LABEL_MAX + 50);
  const capped = model.sanitizeTarget({ kind: 'card', id, point: { label: long, series: long } })!;
  ok('target: label and series are capped', capped.point!.label.length === model.LABEL_MAX && capped.point!.series!.length === model.LABEL_MAX);

  const c = model.makeComment(ID(), { kind: 'dataset', id }, '  **hello**  ', 'Ada', T0);
  ok('create: body is trimmed, author and time set', !!c && c.body === '**hello**' && c.author === 'Ada' && c.createdAt === T0 && c.replies.length === 0);
  ok('create: an empty body is refused', model.makeComment(ID(), { kind: 'dataset', id }, '   ', 'Ada', T0) === null);
  ok('create: a bad target is refused', model.makeComment(ID(), { kind: 'nope', id }, 'x', 'Ada', T0) === null);
  const big = model.makeComment(ID(), { kind: 'story', id }, 'y'.repeat(model.BODY_MAX + 10), 'A'.repeat(200), T0)!;
  ok('create: body and author are capped', big.body.length === model.BODY_MAX && big.author.length === model.AUTHOR_MAX);

  const list = model.sanitizeComments([
    { ...c, extra: 'dropped' },
    { id: 'not-a-uuid', target: { kind: 'card', id }, body: 'x', createdAt: T0 },
    { id: ID(), target: { kind: 'card', id }, body: 'x', createdAt: 'yesterday-ish' },
    { id: ID(), target: { kind: 'card', id }, body: '', createdAt: T0 },
    'garbage',
  ]);
  ok('sanitize: bad ids, times and bodies are dropped; unknown keys too', list.length === 1 && !('extra' in list[0]));
  const dup = model.sanitizeComments([c, { ...c, body: 'later', updatedAt: at(5) }]);
  ok('sanitize: a duplicated id folds into one thread (the later edit)', dup.length === 1 && dup[0].body === 'later');
}

// ── 2. resolve state ──────────────────────────────────────────────────────────

function resolveState(): void {
  const c = model.makeComment(ID(), { kind: 'analysis', id: ID() }, 'Is this right?', 'Ada', T0)!;
  const r = model.resolve(c, at(1))!;
  ok('resolve: sets resolvedAt and stateAt', r.resolvedAt === at(1) && r.stateAt === at(1));
  ok('resolve: resolving a resolved thread is a no-op (null)', model.resolve(r, at(2)) === null);
  const o = model.reopen(r, at(3))!;
  ok('reopen: clears resolvedAt, stamps stateAt', !('resolvedAt' in o) && o.stateAt === at(3));
  ok('reopen: reopening an open thread is a no-op (null)', model.reopen(o, at(4)) === null);
  const slow = model.resolve(o, at(2))!; // this machine's clock is behind the last reopen
  ok('resolve: a slow clock still stamps AFTER the state it replaces', slow.stateAt! > o.stateAt!);
  const dead = model.tombstone(o, at(5))!;
  ok('delete: a tombstone empties body and replies', dead.deletedAt === at(5) && dead.body === '' && dead.replies.length === 0);
  ok('delete: a tombstone cannot be resolved or replied to',
    model.resolve(dead, at(6)) === null && model.addReply(dead, ID(), 'hi', 'Grace', at(6)) === null);
  const withReply = model.addReply(c, ID(), 'Yes — net of returns.', 'Grace', at(1))!;
  const gone = model.deleteReply(withReply, withReply.replies[0].id, at(2))!;
  ok('reply delete: tombstoned in place, hidden from view',
    gone.replies[0].deletedAt === at(2) && model.visible([gone])[0].replies.length === 0);
  ok('edit: a new body stamps updatedAt; the same body is a no-op',
    model.editBody(c, 'Changed', at(1))!.updatedAt === at(1) && model.editBody(c, 'Is this right?', at(1)) === null);
}

// ── 3. reconcile: two machines from one base ──────────────────────────────────

function bothWays(label: string, a: Comment[], b: Comment[]): Comment[] {
  const ab = model.reconcileComments(a, b);
  const ba = model.reconcileComments(b, a);
  ok('reconcile: ' + label + ' — the same both ways', J(ab) === J(ba), J(ab) + '\n  vs ' + J(ba));
  ok('reconcile: ' + label + ' — idempotent', J(model.reconcileComments(ab, ab)) === J(ab) && J(model.reconcileComments(ab, a)) === J(ab));
  return ab;
}

function reconcile(): void {
  const target = { kind: 'card', id: ID() };
  const base = [
    model.makeComment(ID(), target, 'One', 'Ada', at(0))!,
    model.makeComment(ID(), target, 'Two', 'Ada', at(1))!,
    model.makeComment(ID(), target, 'Three', 'Grace', at(2))!,
  ];
  const [one, two, three] = base;

  // Machine A: edits One, replies on Two, resolves Three, writes a new thread.
  const aOne = model.editBody(one, 'One (edited on A)', at(10))!;
  const aTwo = model.addReply(two, ID(), 'A replies', 'Ada', at(11))!;
  const aThree = model.resolve(three, at(12))!;
  const aNew = model.makeComment(ID(), target, 'Only on A', 'Ada', at(13))!;
  const A = [aOne, aTwo, aThree, aNew];
  // Machine B: edits One LATER, replies on Two too, reopens Three after A resolved it.
  const bOne = model.editBody(one, 'One (edited on B, later)', at(20))!;
  const bTwo = model.addReply(two, ID(), 'B replies', 'Grace', at(14))!;
  const bThree = model.reopen(model.resolve(three, at(5))!, at(21))!;
  const B = [bOne, bTwo, bThree];

  const m = bothWays('divergent edits, replies, resolve vs reopen', A, B);
  const byId = (id: string) => m.find((c) => c.id === id)!;
  ok('reconcile: the later edit wins the body', byId(one.id).body === 'One (edited on B, later)');
  ok('reconcile: replies from both sides are kept, in time order',
    J(byId(two.id).replies.map((r) => r.body)) === J(['A replies', 'B replies']));
  ok('reconcile: A resolved at t1, B reopened at t2 > t1 → open', !byId(three.id).resolvedAt);
  ok('reconcile: a thread only one side has is kept', !!byId(aNew.id));
  ok('reconcile: the union is ordered oldest first', J(m.map((c) => c.createdAt)) === J(m.map((c) => c.createdAt).sort()));

  // Resolve AFTER a reopen elsewhere → resolved.
  const late = bothWays('reopen then a later resolve', [model.reopen(model.resolve(three, at(3))!, at(4))!], [model.resolve(three, at(9))!]);
  ok('reconcile: the later resolve wins over an earlier reopen', !!late[0].resolvedAt);

  // A deletes Two; B still has the old copy → it stays deleted.
  const aDel = model.tombstone(two, at(30))!;
  const kept = bothWays('a delete against an older copy', [one, aDel, three], base);
  ok('reconcile: a tombstone beats an older live copy (no resurrection)', !!kept.find((c) => c.id === two.id)!.deletedAt);
  ok('reconcile: the view hides the deleted thread', model.visible(kept).length === 2);
  // …but a reply written after the delete, on a machine that never saw it, is not lost.
  const bLate = model.addReply(two, ID(), 'Replied after A deleted', 'Grace', at(31))!;
  const back = bothWays('a reply newer than the delete', [aDel], [bLate]);
  ok('reconcile: activity newer than a delete keeps the thread (and the reply)',
    !back[0].deletedAt && back[0].replies.some((r) => r.body === 'Replied after A deleted'));

  // Reply tombstones win over the live reply.
  const withR = model.addReply(one, ID(), 'to delete', 'Ada', at(40))!;
  const rDel = model.deleteReply(withR, withR.replies[0].id, at(41))!;
  const rm = bothWays('a deleted reply vs its live copy', [withR], [rDel]);
  ok('reconcile: a reply delete wins', !!rm[0].replies[0].deletedAt);

  ok('reconcile: empty with empty is empty', J(model.reconcileComments([], [])) === '[]');
}

// ── 4. author ─────────────────────────────────────────────────────────────────

function author(): void {
  ok('author: a display name wins over the OS user', model.resolveAuthor('Ada Lovelace', 'ada') === 'Ada Lovelace');
  ok('author: no display name → the OS user', model.resolveAuthor('', 'ada') === 'ada' && model.resolveAuthor('   ', 'ada') === 'ada');
  ok('author: neither → "Me"', model.resolveAuthor('', '') === 'Me');
  ok('author: whitespace collapses and the name is capped',
    model.resolveAuthor('  Ada   Byron  ', 'x') === 'Ada Byron' && model.resolveAuthor('n'.repeat(300), 'x').length === model.AUTHOR_MAX);
}

// ── 5. the store: two machines, one synced project folder ─────────────────────
//
// A project in a sync folder (src/app/syncFolder.ts) is one folder the sync
// service keeps identical on both machines. Here each machine has its own copy
// of that folder, and `syncTo` plays the service: a clean copy when only one
// side changed, and — when both did — the other side's file kept beside ours as
// a conflict copy, named the way Dropbox and iCloud name them.

const J2 = (f: string): any => JSON.parse(fs.readFileSync(f, 'utf8'));

async function store(): Promise<void> {
  use(MACHINE_A);
  config.save({ displayName: '' });
  ok('store: with no display name, comments are signed with the OS user', comments.author() === os.userInfo().username);
  config.save({ displayName: 'Ada' });
  use(MACHINE_B);
  config.save({ displayName: 'Grace' });

  const pid = ID();
  const dash = ID();
  const localA = path.join(MACHINE_A, 'projects', pid, 'comments.json');
  const localB = path.join(MACHINE_B, 'projects', pid, 'comments.json');
  const syncTo = (from: string, to: string, conflictName?: string): void => {
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, conflictName ? path.join(path.dirname(to), conflictName) : to);
  };

  use(MACHINE_A);
  const added = await comments.add(pid, { kind: 'analysis', id: dash }, 'Is **Q3** net of returns?');
  ok('store: add answers with the list, signed by the display name',
    added.ok && added.comments.length === 1 && added.comments[0].author === 'Ada', J(added));
  ok('store: the file is { schemaVersion: 1, comments }, in the project folder', J2(localA).schemaVersion === 1);
  const cid = added.ok ? added.comments[0].id : '';
  syncTo(localA, localB);

  use(MACHINE_B);
  const seen = await comments.list(pid);
  ok('store: machine B reads machine A\'s comment from the synced folder', seen.ok && seen.comments.length === 1 && seen.comments[0].id === cid);
  const notMine = await comments.remove(pid, cid);
  ok('store: only the author can delete', !notMine.ok && /author/i.test((notMine as any).error));

  // A resolves, and the service carries it to B. Then both change the thread
  // before the service catches up: A replies, B reopens it and replies.
  use(MACHINE_A);
  await comments.resolve(pid, cid);
  syncTo(localA, localB);
  await comments.reply(pid, cid, 'Checked — yes.');
  use(MACHINE_B);
  await new Promise((r) => setTimeout(r, 5));
  const reopened = await comments.reopen(pid, cid);
  ok('store: B saw A\'s resolve before reopening', reopened.ok && !reopened.comments[0].resolvedAt);
  await comments.reply(pid, cid, 'Reopened: the October file changed.');
  // The service keeps both: B's file lands in A's folder as a Dropbox conflict
  // copy, A's lands in B's folder as an iCloud one.
  const dropbox = "comments (Grace's conflicted copy 2026-09-26).json";
  syncTo(localB, localA, dropbox);
  syncTo(localA, localB, 'comments 2.json');

  use(MACHINE_A);
  const onA = await comments.list(pid);
  use(MACHINE_B);
  const onB = await comments.list(pid);
  ok('store: A folds B\'s conflict copy in — B\'s later reopen wins, both replies kept',
    onA.ok && !onA.comments[0].resolvedAt && onA.comments[0].replies.length === 2, J(onA));
  ok('store: B folds A\'s copy in to the same thread', onB.ok && J(onB.comments) === J(onA.ok ? onA.comments : []));
  ok('store: the folded copies are removed', !fs.existsSync(path.join(path.dirname(localA), dropbox)) && !fs.existsSync(path.join(path.dirname(localB), 'comments 2.json')));
  ok('store: both machines hold identical bytes', fs.readFileSync(localA, 'utf8') === fs.readFileSync(localB, 'utf8'));

  // A half-downloaded conflict copy is not folded, and not deleted.
  use(MACHINE_A);
  const partial = path.join(path.dirname(localA), 'comments 3.json');
  fs.writeFileSync(partial, '{"schemaVersion":1,"comm');
  const survived = await comments.list(pid);
  ok('store: an unreadable conflict copy is left alone, the local file still answers',
    survived.ok && survived.comments.length === 1 && fs.readFileSync(partial, 'utf8') === '{"schemaVersion":1,"comm');
  fs.rmSync(partial);
  ok('store: a file that only looks numbered is not a conflict copy', await (async () => {
    const stray = path.join(path.dirname(localA), 'comments 1.json');
    fs.writeFileSync(stray, '{"schemaVersion":1,"comments":[]}');
    await comments.list(pid);
    const kept = fs.existsSync(stray);
    fs.rmSync(stray);
    return kept;
  })());
  fs.writeFileSync(localA, 'not json');
  const recovered = await comments.list(pid);
  ok('store: a corrupt local file is kept aside, never fatal', recovered.ok && fs.existsSync(localA + '.corrupt'));

  const deleted = await comments.add(pid, { kind: 'card', id: ID(), point: { label: 'West' } }, 'pin');
  const pinId = deleted.ok ? deleted.comments.find((c) => c.body === 'pin')!.id : '';
  const afterDel = await comments.remove(pid, pinId);
  ok('store: the author can delete; the thread leaves the list', afterDel.ok && !afterDel.comments.some((c) => c.id === pinId));
  ok('store: …leaving a tombstone on disk for the other machine',
    J2(localA).comments.some((c: any) => c.id === pinId && c.deletedAt));
  ok('store: an unknown project id is refused, never a path', !(await comments.list('../..')).ok);
}

// ── 6 + 7. bundle and facts, on one real project ──────────────────────────────

async function bundleAndFacts(): Promise<void> {
  use(MACHINE_A);
  await projects.init();
  const proj = await projects.createProject('Commented project');
  const ds = await datasets.saveDataset(proj.id, {
    name: 'Cities', sourceKind: 'csv',
    columns: [{ name: 'city', type: 'text' as const }, { name: 'pop', type: 'number' as const }],
    rows: [['Paris', 100], ['Berlin', 300], ['Rome', 200]],
  });
  const a = await analysis.saveAnalysis(proj.id, {
    name: 'Q3 draft',
    sheets: [{ name: 'Overview', cards: [{ type: 'metric', layout: { x: 0, y: 0, w: 3, h: 2 },
      metric: { datasetId: ds!.id, column: 'pop', aggregation: 'sum', label: 'Total pop' } }] }],
  });
  const cardId = a!.sheets[0].cards[0].id;
  const PHRASE = 'ZEBRAPLUM escalation';
  const FIGURES = ['987654', '4242'];
  const body = `${PHRASE}: the real total is 987654.321 across 4242 stores`;
  await comments.add(proj.id, { kind: 'analysis', id: a!.id }, body);
  await comments.add(proj.id, { kind: 'card', id: cardId, point: { label: 'Total pop' } }, body);
  await comments.add(proj.id, { kind: 'dataset', id: ds!.id }, body);

  // 7. buildFacts never reads comments — for the dashboard, the dataset, and the project.
  for (const ctx of [{ kind: 'analysis', id: a!.id }, { kind: 'dataset', id: ds!.id }, { kind: '', id: '' }]) {
    const facts = await ipcCopilot.buildFacts(proj.id, ctx);
    const hay = facts.text + '\n' + J(facts.ledger);
    ok('facts (' + (ctx.kind || 'project') + '): no comment phrase', !hay.includes('ZEBRAPLUM'));
    ok('facts (' + (ctx.kind || 'project') + '): no comment figure', FIGURES.every((f) => !hay.includes(f)), FIGURES.filter((f) => hay.includes(f)).join());
  }
  const factsA = await ipcCopilot.buildFacts(proj.id, { kind: 'analysis', id: a!.id });
  ok('facts: the app\'s own figure is still there (the check is not vacuous)', factsA.text.includes('Total pop: 600'));

  // 6. The bundle carries comments.json; importing on this machine remaps the dashboard id.
  const out = await bundle.exportProject(proj.id);
  const names = out ? bundle.readZip(out.bytes).map((e) => e.name) : [];
  ok('bundle: comments.json travels', names.includes('comments.json'), J(names));
  const res = await bundle.importBundle(out!.bytes);
  ok('bundle: a bundle with comments imports', res.ok === true, J(res).slice(0, 300));
  const np = res.project!;
  const newA = (await analysis.listAnalyses(np.id))[0];
  const imported = JSON.parse(fs.readFileSync(path.join(MACHINE_A, 'projects', np.id, 'comments.json'), 'utf8'));
  const kinds = imported.comments.map((c: any) => c.target.kind + ':' + c.target.id);
  ok('bundle: the dashboard thread points at the NEW dashboard id', newA.id !== a!.id && kinds.includes('analysis:' + newA.id), J(kinds));
  ok('bundle: no thread still points at the source dashboard', !kinds.includes('analysis:' + a!.id));
  const listed = await comments.list(np.id);
  ok('bundle: the imported threads read back through the store', listed.ok && listed.comments.length === 3);
}

async function main(): Promise<void> {
  targeting();
  resolveState();
  reconcile();
  author();
  await store();
  await bundleAndFacts();
}

main()
  .then(() => {
    Module._load = origLoad;
    for (const d of [MACHINE_A, MACHINE_B]) {
      try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) { /* temp dir */ }
    }
    finish();
  })
  .catch((err) => {
    console.error('FAIL (threw)', err);
    process.exit(1);
  });
