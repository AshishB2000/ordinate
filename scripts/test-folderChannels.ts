// The folder channels (docs/team-folders/00-design.md E7: src/api/folders.ts, src/server/authz/folderTree.ts and
// folderMove.ts), over the real RPC route as the note's people (scripts/folderHarness.ts), each rule with its
// NEGATIVE CONTROL.
//
// Without a database: the channels answer that folders need one, the tree is empty; and the move warning's per-person
// rule (folderPeople.levelAt) is Object.is-equal to the resolver's (folders.accessFrom) over every rank, grant and
// membership (NEGATIVE CONTROL: a rule without the role's cap differs).
// ORDINATE_FOLDERS (D22's gate): off unless set to `on`, and a typo stops startup.
// With DATABASE_URL:
//   0. FOLDERS OFF (the default): `folder:create`, `folder:grant`, `folder:setShareFigures`, `folder:moveImpact` and
//      `folder:move` answer the off sentence and change nothing; `folder:tree` and `folder:access` say `enabled: false`;
//      rename and delete still work. CONTROL: turned on, the same create lands (and sections 1–8 run with it on).
//   1. ADMIN-ONLY TOP LEVEL: an editor's top-level create, rename and delete are refused; a viewer's create is 403.
//      NEGATIVE CONTROL: the project admin's land.
//   2. SUBFOLDERS: Edit on the parent makes one (Ops leads in Ops, an editor under Everyone); Can view refuses `edit`,
//      no access `closed`, as an unknown parent.
//   3. DEPTH: 5 levels below a top-level folder and below Everyone; the 6th refuses, and the 5th is in the tree of
//      someone its root opens to. NEGATIVE CONTROL: the 5th lands.
//   4. NAMES: unique among siblings whatever the case (create and rename), the same name elsewhere is fine, a blank or
//      121-character name is 400.
//   5. DELETE-EMPTY: a folder holding a dashboard, or only a trashed one, refuses `not_empty`; purged, it deletes with
//      its empty subfolders. NEGATIVE CONTROL: the emptied folder deletes.
//   6. GRANTS AND THE SWITCH: top-level folders only; an unknown team is refused; a grant opens the folder to the team
//      (its tree), taking it away closes it; the tree of someone a folder is closed to never names it.
//   7. THE MOVE HASH: a move with the warning's hash lands; one whose access changed since (a grant) refuses
//      `move_changed` and moves nothing; a made-up hash too. NEGATIVE CONTROL: the fresh warning's hash lands.
//      Edit on both ends: Can view refuses `edit`, a closed item or destination `closed`. *Move everything to
//      Everyone* is the project admin's and leaves no placement.
//   8. A deleted project leaves no folder, grant or placement behind. NEGATIVE CONTROL: it had all three.
//   9. WHO CAN'T OPEN A PAGE: `outsideCount` (the Publish and embed dialogs' "Shows data from folders N people can't
//      open") is Object.is-equal to the resolver run as each member over the same items; `publish:plan` and
//      `embed:columns` carry it for the Ops board (Finance's viewer and the editor outside Ops: 2); the subscription
//      preview's `closedRecipients` is Object.is-equal to what `audience` leaves out of the send. NEGATIVE CONTROLS:
//      a page of Everyone's items, and recipients who all open the board, count 0.
//
//   npm run build:ts && [DATABASE_URL=…] node scripts/test-folderChannels.js

export {}; // module scope — sibling test scripts share top-level names
import { randomUUID } from 'crypto';
import { ok, finish } from './selfcheck';
import * as H from './folderHarness';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');
const folders: typeof import('../src/server/authz/folders') = require('../src/server/authz/folders');
const people: typeof import('../src/server/authz/folderPeople') = require('../src/server/authz/folderPeople');
const tree: typeof import('../src/server/authz/folderTree') = require('../src/server/authz/folderTree');
const msg: typeof import('../src/server/folderMessages') = require('../src/server/folderMessages');
const envMod: typeof import('../src/server/env') = require('../src/server/env');
const outside: typeof import('../src/server/authz/folderOutside') = require('../src/server/authz/folderOutside');
const emailChannel: typeof import('../src/server/mail/emailChannel') = require('../src/server/mail/emailChannel');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-folderchannels-'));

/** The resolver's level for one person, from accessFrom, against folderPeople.levelAt for the same person. */
function ruleParity(rule: typeof people.levelAt): string[] {
  const P = randomUUID();
  const top = randomUUID();
  const teams = [randomUUID(), randomUUID()];
  const bad: string[] = [];
  for (const rank of [1, 2] as const) {
    for (const g0 of [null, 'view', 'edit'] as const) {
      for (const g1 of [null, 'view', 'edit'] as const) {
        for (const member of [[], [0], [1], [0, 1]]) {
          const grants: Array<{ teamId: string; level: 'view' | 'edit' }> = [];
          if (g0) grants.push({ teamId: teams[0], level: g0 });
          if (g1) grants.push({ teamId: teams[1], level: g1 });
          const mine = grants.filter((g) => member.some((i) => teams[i] === g.teamId)).map((g) => g.level);
          const best = mine.includes('edit') ? 'edit' : mine.includes('view') ? 'view' : null;
          const access = folders.accessFrom(P, rank, [{ id: top, parentId: null, shareFigures: true, grant: best }]);
          const m = { id: 'u', email: 'u@x', rank, teams: member.map((i) => teams[i]) };
          for (const root of [P, top]) {
            const want = folders.levelIn(access, root);
            const got = rule(m, root, P, grants);
            if (!Object.is(want, got)) bad.push(`rank ${rank} grants ${g0}/${g1} in ${member.join('+') || 'none'} on ${root === P ? 'Everyone' : 'top'}: ${got} ≠ ${want}`);
          }
        }
      }
    }
  }
  return bad;
}

const id = (r: H.Reply): string => String(r.body?.folder?.id ?? '');
const okReply = (r: H.Reply): boolean => r.status === 200 && r.body?.ok === true;
const says = (r: H.Reply, sentence: string): boolean => r.status === 200 && r.body?.ok === false && r.body?.error === sentence;
const short = (r: H.Reply): string => `${r.status} ${r.text.slice(0, 160)}`;

(async () => {
  // ── Without a database ────────────────────────────────────────────────
  const parity = ruleParity(people.levelAt);
  ok('the move warning\'s per-person rule is Object.is-equal to the resolver\'s over every rank, grant and membership', parity.length === 0, parity.join('\n'));
  const uncapped: typeof people.levelAt = (m, root, p, grants) => (root === p ? (m.rank === 2 ? 'edit' : 'view') : grants.some((g) => m.teams.includes(g.teamId) && g.level === 'edit') ? 'edit' : grants.some((g) => m.teams.includes(g.teamId)) ? 'view' : 'none');
  ok('NEGATIVE CONTROL: a rule without the role\'s cap differs from the resolver', ruleParity(uncapped).length > 0);
  const base = { AUTH_MODE: 'dev', LOG_LEVEL: 'silent' };
  ok('ORDINATE_FOLDERS is off by default', envMod.parseEnv(base).folders === false && envMod.parseEnv({ ...base, ORDINATE_FOLDERS: 'off' }).folders === false);
  ok('CONTROL: ORDINATE_FOLDERS=on turns folders on', envMod.parseEnv({ ...base, ORDINATE_FOLDERS: 'on' }).folders === true);
  let typo = '';
  try {
    envMod.parseEnv({ ...base, ORDINATE_FOLDERS: 'yes' });
  } catch (err) {
    typo = err instanceof Error ? err.message : String(err);
  }
  ok('a typo in ORDINATE_FOLDERS stops startup, naming it', typo.startsWith('ORDINATE_FOLDERS must be one of on|off'), typo);
  if (!process.env.DATABASE_URL) {
    const context: typeof import('../src/server/context') = require('../src/server/context');
    context.enterServerMode(DATA);
    const P = randomUUID();
    const t = await context.runInContext({ user: { email: 'admin@acme.test', role: 'admin' }, org: { id: 'acme' } }, 'nodb', async () => ({
      tree: await tree.folderTree(P),
      made: await tree.createFolder(P, null, 'Finance'),
    }));
    ok('without a database the tree is empty and not available', !t.tree.available && t.tree.folders.length === 0, JSON.stringify(t.tree));
    ok('without a database a create answers that folders need one', t.made.ok === false && t.made.error === msg.folderNeedsDatabaseMessage(), JSON.stringify(t.made));
  }

  const W = await H.world('folder channels', {}); // ORDINATE_FOLDERS unset: off, as a server starts by default
  if (!W) return;
  try {
    const { P, call } = W;
    await W.plantFolders();
    const F = W.folders;
    const create = (who: H.Person, parentId: string | null, name: string) => call(who, 'folder:create', { projectId: P, parentId, name });
    const treeOf = async (who: H.Person) => (await call(who, 'folder:tree', { projectId: P })).body as import('../src/server/authz/folderTree').FolderTree;

    // 0. Folders off: what makes, shares or moves a folder is refused, in the catalog's words; the rest works.
    const off = msg.folderOffMessage();
    const countRows = async () => (await W.pool.query<{ n: number }>(
      `SELECT (SELECT count(*) FROM folders WHERE project_id = $1) * 1000000 + (SELECT count(*) FROM folder_grants WHERE project_id = $1) * 1000 + (SELECT count(*) FROM folder_items WHERE project_id = $1) AS n`, [P])).rows[0].n;
    const rowsBefore = Number(await countRows());
    const plainMove = { projectId: P, items: [{ kind: 'dataset', id: W.plain }], to: F.ops };
    const refusedOff: Array<[string, H.Reply]> = [
      ['folder:create', await create('padmin', null, 'Made while off')],
      ['folder:create (a subfolder)', await create('opsLead', F.ops, 'Made while off')],
      ['folder:grant', await call('padmin', 'folder:grant', { projectId: P, folderId: F.ops, teamId: W.teams.fin, level: 'view' })],
      ['folder:setShareFigures', await call('padmin', 'folder:setShareFigures', { projectId: P, folderId: F.fin, on: false })],
      ['folder:moveImpact', await call('padmin', 'folder:moveImpact', plainMove)],
      ['folder:move', await call('padmin', 'folder:move', { ...plainMove, hash: 'a'.repeat(64) })],
    ];
    for (const [channel, r] of refusedOff) ok(`0. off: ${channel} answers that folders are off`, says(r, off), short(r));
    ok('0. off: nothing was made, given, switched or moved', Number(await countRows()) === rowsBefore, `${rowsBefore} → ${await countRows()}`);
    const offTree = await treeOf('padmin');
    ok('0. off: folder:tree still answers, with enabled false', offTree.available === true && offTree.enabled === false && offTree.folders.some((f) => f.id === F.ops), JSON.stringify(offTree).slice(0, 200));
    const offAccess = (await call('padmin', 'folder:access', { projectId: P })).body as import('../src/server/authz/folderTree').FolderAccessReply;
    ok('0. off: folder:access still answers, with enabled false', offAccess.ok === true && offAccess.enabled === false && offAccess.folders.some((f) => f.id === F.ops));
    ok('0. off: a rename still works (a folder can only exist if it was made while on)',
      okReply(await call('padmin', 'folder:rename', { projectId: P, folderId: F.ops, name: 'Ops renamed' })) && okReply(await call('padmin', 'folder:rename', { projectId: P, folderId: F.ops, name: 'Ops' })));
    const spare = randomUUID();
    await W.pool.query('INSERT INTO folders (org_id, project_id, id, parent_id, name, created_by) VALUES ($1, $2, $3, NULL, $4, $5)', ['acme', P, spare, 'Spare', 'boss@acme.test']);
    ok('0. off: deleting an empty folder still works', okReply(await call('padmin', 'folder:delete', { projectId: P, folderId: spare })) && !(await treeOf('padmin')).folders.some((f) => f.id === spare));
    tree.useFolders(true);
    const onMade = await create('padmin', null, 'Made while on');
    ok('CONTROL: turned on, the same create lands and the tree says enabled', okReply(onMade) && (await treeOf('padmin')).enabled === true, short(onMade));
    await call('padmin', 'folder:delete', { projectId: P, folderId: id(onMade) });

    // 1. Admin-only top level.
    const edTop = await create('opsLead', null, 'Leads only');
    ok('1. an editor\'s top-level folder is refused, in the catalog\'s words', says(edTop, msg.folderTopLevelAdminMessage()), short(edTop));
    ok('1. a viewer cannot make a folder at all (403)', (await create('opsViewer', P, 'Mine')).status === 403);
    ok('1. an editor cannot rename or delete a top-level folder they edit', says(await call('opsLead', 'folder:rename', { projectId: P, folderId: F.ops, name: 'Ops two' }), msg.folderTopLevelAdminMessage())
      && says(await call('opsLead', 'folder:delete', { projectId: P, folderId: F.ops }), msg.folderTopLevelAdminMessage()));
    const board = await create('padmin', null, 'Board');
    ok('NEGATIVE CONTROL: the project admin\'s top-level folder lands', okReply(board) && id(board).length === 36, short(board));
    const boardId = id(board);

    // 2. Subfolders: Edit on the parent.
    const q1 = await create('opsLead', F.ops, 'Q1');
    ok('2. Ops leads (Can edit on Ops) make a subfolder of Ops', okReply(q1), short(q1));
    ok('2. an editor with Can view on Ops is refused `edit`', H.refused(await create('opsEditorView', F.ops, 'Q2'), 'edit'));
    ok('2. an editor with no team on Ops is refused `closed`, as for an unknown parent', H.refused(await create('ed', F.ops, 'Q2'), 'closed') && H.refused(await create('ed', randomUUID(), 'Q2'), 'closed'));
    const under = await create('ed', P, 'Shared');
    ok('2. any editor makes a subfolder of Everyone', okReply(under), short(under));

    // 3. Depth.
    const chain = async (who: H.Person, from: string, word: string): Promise<{ made: string[]; last: H.Reply }> => {
      const made: string[] = [];
      let parent = from;
      for (let i = 1; i <= 5; i++) {
        const r = await create(who, parent, `${word} ${i}`);
        if (!okReply(r)) return { made, last: r };
        parent = id(r);
        made.push(parent);
      }
      return { made, last: await create(who, parent, `${word} 6`) };
    };
    const deep = await chain('opsLead', F.ops, 'Deep'); // Ops is top-level: Ops/Deep 1 … Ops/Deep 5
    ok('3. five levels below a top-level folder land, the sixth is refused', deep.made.length === 5 && says(deep.last, msg.folderTooDeepMessage()), `${deep.made.length} ${short(deep.last)}`);
    const wide = await chain('ed', P, 'Wide'); // under Everyone
    ok('3. five levels below Everyone land, the sixth is refused', wide.made.length === 5 && says(wide.last, msg.folderTooDeepMessage()), `${wide.made.length} ${short(wide.last)}`);
    const opsView = await treeOf('opsViewer');
    ok('3. the fifth level is in the tree of someone its root opens to (the resolver walks as deep)', opsView.folders.some((f) => f.id === deep.made[4] && f.level === 'view') && opsView.folders.some((f) => f.id === wide.made[4]));
    ok('NEGATIVE CONTROL: the fifth landed where the sixth did not', deep.made.length === 5 && wide.made.length === 5);

    // 4. Names.
    ok('4. a top-level name is unique whatever its case', says(await create('padmin', null, 'oPS'), msg.folderNameTakenMessage()));
    ok('4. the same name under another parent is fine', okReply(await create('padmin', boardId, 'Ops')));
    ok('4. a rename onto a sibling\'s name is refused; onto its own in another case it lands',
      says(await call('padmin', 'folder:rename', { projectId: P, folderId: boardId, name: 'finance' }), msg.folderNameTakenMessage()) && okReply(await call('padmin', 'folder:rename', { projectId: P, folderId: boardId, name: 'BOARD' })));
    ok('4. a blank name and a 121-character one are refused before the handler (400)', (await create('padmin', null, '   ')).status === 400 && (await create('padmin', null, 'x'.repeat(121))).status === 400);
    ok('4. Everyone is not renamed or deleted', says(await call('padmin', 'folder:rename', { projectId: P, folderId: P, name: 'All' }), msg.folderEveryoneFixedMessage()));

    // 5. Delete-empty.
    const doomed = await create('padmin', null, 'Doomed');
    const doomedId = id(doomed);
    const kid = await create('padmin', doomedId, 'Kid');
    const made = await call('padmin', 'analysis:create', { projectId: P, name: 'Doomed board', folderId: id(kid) });
    const madeId = String(made.body?.id ?? '');
    ok('5. a folder whose subfolder holds a dashboard refuses `not_empty`', H.refused(await call('padmin', 'folder:delete', { projectId: P, folderId: doomedId }), 'not_empty'));
    await call('padmin', 'analysis:delete', { projectId: P, id: madeId });
    ok('5. …and still does when that dashboard is only in the Trash', H.refused(await call('padmin', 'folder:delete', { projectId: P, folderId: doomedId }), 'not_empty'));
    await call('padmin', 'trash:purge', { projectId: P, type: 'dashboard', id: madeId });
    const gone = await call('padmin', 'folder:delete', { projectId: P, folderId: doomedId });
    ok('NEGATIVE CONTROL: purged, the folder deletes with its empty subfolder', okReply(gone) && !(await treeOf('padmin')).folders.some((f) => f.id === doomedId || f.id === id(kid)), short(gone));
    ok('5. Ops leads delete a subfolder of Ops they made', okReply(await call('opsLead', 'folder:delete', { projectId: P, folderId: deep.made[4] })));

    // 6. Grants and the switch.
    const fin = W.teams.fin;
    ok('6. a subfolder takes no grant and no switch', says(await call('padmin', 'folder:grant', { projectId: P, folderId: F.returns, teamId: fin, level: 'view' }), msg.folderTopLevelOnlyMessage())
      && says(await call('padmin', 'folder:setShareFigures', { projectId: P, folderId: F.returns, on: false }), msg.folderTopLevelOnlyMessage()));
    ok('6. an unknown team is refused', says(await call('padmin', 'folder:grant', { projectId: P, folderId: boardId, teamId: randomUUID(), level: 'view' }), msg.folderUnknownTeamMessage()));
    ok('6. editors and viewers cannot grant (403)', (await call('opsLead', 'folder:grant', { projectId: P, folderId: F.ops, teamId: fin, level: 'view' })).status === 403
      && (await call('opsViewer', 'folder:grant', { projectId: P, folderId: F.ops, teamId: fin, level: 'view' })).status === 403);
    const before = (await treeOf('finViewer')).folders.some((f) => f.id === boardId);
    ok('6. a grant opens the folder to the team', okReply(await call('padmin', 'folder:grant', { projectId: P, folderId: boardId, teamId: fin, level: 'view' })) && (await treeOf('finViewer')).folders.some((f) => f.id === boardId && f.level === 'view'));
    const access = (await call('padmin', 'folder:access', { projectId: P })).body as import('../src/server/authz/folderTree').FolderAccessReply;
    const boardRow = access.folders.find((f) => f.id === boardId);
    ok('6. Share → Folders counts the people a grant adds up to', boardRow?.people === 1 && boardRow.grants[0]?.team === 'Finance' && access.everyone === 5, JSON.stringify(boardRow));
    ok('6. taking the grant away closes it again', okReply(await call('padmin', 'folder:grant', { projectId: P, folderId: boardId, teamId: fin, level: null })) && !(await treeOf('finViewer')).folders.some((f) => f.id === boardId));
    ok('NEGATIVE CONTROL: before the grant finViewer did not have it', !before);
    ok('6. the reach switch turns off and on', okReply(await call('padmin', 'folder:setShareFigures', { projectId: P, folderId: F.fin, on: false })) && (await treeOf('padmin')).folders.find((f) => f.id === F.fin)?.shareFigures === false
      && okReply(await call('padmin', 'folder:setShareFigures', { projectId: P, folderId: F.fin, on: true })));
    const opsTree = await call('opsViewer', 'folder:tree', { projectId: P });
    ok('6. opsViewer\'s tree names neither HR nor Finance, nor where HR\'s items are', !H.CANARY.test(opsTree.text) && !opsTree.text.includes(F.fin) && !opsTree.text.includes(W.hr.ds) && !opsTree.text.includes(F.hr));
    const adminTree = await treeOf('padmin');
    ok('NEGATIVE CONTROL: padmin\'s tree has HR, marked as seen only as an admin, and where HR\'s dataset is', adminTree.folders.some((f) => f.id === F.hr && f.adminOnly === true) && adminTree.placed.dataset[W.hr.ds] === F.hr);

    // 7. The move hash, and Edit on both ends.
    const items = [{ kind: 'dataset', id: W.plain }];
    const impact = async (who: H.Person, to: string, list: object[] = items) => call(who, 'folder:moveImpact', { projectId: P, items: list, to });
    const move = (who: H.Person, to: string, hash: string, list: object[] = items) => call(who, 'folder:move', { projectId: P, items: list, to, hash });
    const where = async () => (await treeOf('padmin')).placed.dataset[W.plain] ?? P;
    const first = await impact('opsLead', F.ops);
    ok('7. moving Plain from Everyone to Ops: everyone but Ops loses it, by head count, with no address in the reply',
      first.body?.ok === true && first.body.to === 'Ops' && first.body.lose.some((g: H.Reply['body']) => g.team === null && g.people === 2) && !first.text.includes('@'), short(first));
    await call('padmin', 'folder:grant', { projectId: P, folderId: F.ops, teamId: fin, level: 'view' }); // access changes since the warning
    const stale = await move('opsLead', F.ops, first.body.hash);
    ok('7. a move whose access changed since the warning refuses `move_changed` and moves nothing', H.refused(stale, 'move_changed') && (await where()) === P, short(stale));
    ok('7. a made-up hash refuses too', H.refused(await move('opsLead', F.ops, 'a'.repeat(64)), 'move_changed'));
    const fresh = await impact('opsLead', F.ops);
    ok('7. the fresh warning differs: finViewer no longer loses it', fresh.body?.hash !== first.body.hash);
    const landed = await move('opsLead', F.ops, fresh.body.hash);
    ok('NEGATIVE CONTROL: the fresh warning\'s hash moves it', okReply(landed) && landed.body.moved === 1 && (await where()) === F.ops, short(landed));
    await call('padmin', 'folder:grant', { projectId: P, folderId: F.ops, teamId: fin, level: null });
    ok('7. Can view on where it is refuses `edit`', H.refused(await impact('opsEditorView', P), 'edit'));
    ok('7. an item in a closed folder, or an unknown one, is `closed`', H.refused(await impact('ed', P, [{ kind: 'dataset', id: W.hr.ds }]), 'closed') && H.refused(await impact('padmin', P, [{ kind: 'dashboard', id: randomUUID() }]), 'closed'));
    ok('7. a destination the caller cannot open is `closed`', H.refused(await impact('opsLead', F.hr), 'closed'));
    const back = await impact('opsLead', P);
    ok('7. Ops leads move it back to Everyone', okReply(await move('opsLead', P, back.body.hash)) && (await where()) === P);
    const everything = { projectId: P, items: [], to: P, from: P };
    ok('7. *Move everything to Everyone* is the project admin\'s', says(await call('opsLead', 'folder:moveImpact', everything), msg.folderEverythingAdminMessage()));
    const all = await call('padmin', 'folder:moveImpact', everything);
    ok('7. its warning names who gains: everyone in the project', all.body?.ok === true && all.body.gain.some((g: H.Reply['body']) => g.team === null) && all.body.lose.length === 0, short(all));
    const emptied = await call('padmin', 'folder:move', { ...everything, hash: all.body.hash });
    const left = (await W.pool.query<{ n: number }>('SELECT count(*)::int AS n FROM folder_items WHERE project_id = $1', [P])).rows[0].n;
    ok('7. …and leaves no placement, the Trash\'s included', okReply(emptied) && emptied.body.moved > 0 && left === 0, `${short(emptied)} left ${left}`);

    // 8. A deleted project leaves no folder, grant or placement behind.
    const gone2 = String((await call('boss', 'projects:create', { name: 'Short-lived' })).body?.id ?? '');
    const f = id(await call('boss', 'folder:create', { projectId: gone2, parentId: null, name: 'Temporary' }));
    await call('boss', 'folder:grant', { projectId: gone2, folderId: f, teamId: fin, level: 'view' });
    const b2 = String((await call('boss', 'analysis:create', { projectId: gone2, name: 'Placed', folderId: f })).body?.id ?? '');
    const rowsOf = async () => (await W.pool.query<{ n: number }>(
      `SELECT (SELECT count(*) FROM folders WHERE project_id = $1) + (SELECT count(*) FROM folder_grants WHERE project_id = $1) + (SELECT count(*) FROM folder_items WHERE project_id = $1) AS n`, [gone2])).rows[0].n;
    const had = Number(await rowsOf());
    await call('boss', 'projects:delete', { id: gone2 });
    ok('8. a deleted project leaves no folder, grant or placement behind', Number(await rowsOf()) === 0, `${b2} ${await rowsOf()}`);
    ok('NEGATIVE CONTROL: it had a folder, a grant and a placement before', had === 3, String(had));

    // 9. Who can't open a page (section 7 emptied every folder: place Ops's and HR's items again).
    for (const [kind, item, f] of [['dataset', W.ops.ds, F.ops], ['dashboard', W.ops.board, F.ops], ['dataset', W.hr.ds, F.hr], ['dashboard', W.hr.board, F.hr]] as const) {
      await W.pool.query('INSERT INTO folder_items (org_id, project_id, kind, item_id, folder_id, moved_by) VALUES ($1, $2, $3, $4, $5, $6)', ['acme', P, kind, item.toLowerCase(), f, 'boss@acme.test']);
    }
    type Items = Array<{ kind: 'dataset' | 'dashboard'; id: string }>;
    const restricted: H.Person[] = ['opsViewer', 'opsLead', 'opsEditorView', 'finViewer', 'ed']; // a project role below admin
    const byResolver = async (items: Items): Promise<number> => {
      let n = 0;
      for (const who of restricted) if ((await Promise.all(items.map((i) => W.as(who, () => folders.levelOn(P, i.kind, i.id))))).includes('none')) n++;
      return n;
    };
    const pages: Array<[string, Items]> = [
      ['the Ops board and its dataset', [{ kind: 'dashboard', id: W.ops.board }, { kind: 'dataset', id: W.ops.ds }]],
      ['the HR board', [{ kind: 'dashboard', id: W.hr.board }]],
      ['an Everyone board showing HR\'s dataset', [{ kind: 'dashboard', id: W.reach.everyoneBoard }, { kind: 'dataset', id: W.hr.ds }]],
      ['Plain alone (Everyone)', [{ kind: 'dataset', id: W.plain }]],
    ];
    for (const [what, items] of pages) {
      const got = await W.as('padmin', () => outside.outsideCount(P, items));
      ok(`9. ${what}: the count is Object.is-equal to the resolver run as each member`, Object.is(got, await byResolver(items)), `${got}`);
    }
    ok('9. Ops\'s page leaves out 2 (finViewer, ed), HR\'s all 5', (await W.as('padmin', () => outside.outsideCount(P, pages[0][1]))) === 2 && (await W.as('padmin', () => outside.outsideCount(P, pages[1][1]))) === 5);
    ok('NEGATIVE CONTROL: a page of Everyone\'s items counts 0', (await W.as('padmin', () => outside.outsideCount(P, pages[3][1]))) === 0);
    const target = { projectId: P, dashboardIds: [W.ops.board], options: { maxCombos: 32 } };
    const plan = await call('padmin', 'publish:plan', target);
    ok('9. publish:plan says the Ops board shows data 2 people can\'t open', plan.body?.ok === true && plan.body.outside === 2, short(plan));
    const bare = String((await call('padmin', 'analysis:create', { projectId: P, name: 'Bare board' })).body?.id ?? '');
    const barePlan = await call('padmin', 'publish:plan', { ...target, dashboardIds: [bare] });
    ok('NEGATIVE CONTROL: an empty Everyone board\'s plan says 0', barePlan.body?.ok === true && barePlan.body.outside === 0, short(barePlan));
    const site = await call('padmin', 'publish:run', target);
    const cols = await call('padmin', 'embed:columns', { projectId: P, siteId: String(site.body?.site?.id ?? ''), dashboardId: W.ops.board });
    ok('9. embed:columns says the embedded Ops board shows data 2 people can\'t open', cols.body?.ok === true && cols.body.outside === 2, `${short(site)} | ${short(cols)}`);
    const to = { userIds: [W.uid.padmin, W.uid.finViewer], teamIds: [W.teams.ops] };
    const msgModel = { title: 'x', subtitle: [], note: '', kpis: [], visuals: [], link: null, footer: '' } as never;
    for (const board of [W.ops.board, W.hr.board, bare]) {
      const closed = await W.as('padmin', () => emailChannel.closedRecipients([to, { userIds: [W.uid.finViewer], teamIds: [] }], P, board));
      const all = await W.as('padmin', () => emailChannel.recipients(to, P));
      const sent = await W.as('padmin', () => emailChannel.audience(to, { kind: 'dashboard', projectId: P, analysisId: board, message: msgModel }));
      ok(`9. closedRecipients is Object.is-equal to what audience leaves out (${board === bare ? 'Everyone' : board === W.ops.board ? 'Ops' : 'HR'})`, Object.is(closed, all.length - sent.length), `${closed} vs ${all.length} - ${sent.length}`);
    }
    ok('9. of padmin, finViewer and Ops, finViewer can\'t open the Ops board; only padmin opens HR\'s',
      (await W.as('padmin', () => emailChannel.closedRecipients([to], P, W.ops.board))) === 1 && (await W.as('padmin', () => emailChannel.closedRecipients([to], P, W.hr.board))) === 3);
    ok('NEGATIVE CONTROL: on a board in Everyone no recipient is left out', (await W.as('padmin', () => emailChannel.closedRecipients([to], P, bare))) === 0);
  } finally {
    tree.useFolders(false);
    await W.close();
  }
})()
  .catch((err) => ok('suite ran to completion', false, err instanceof Error ? err.stack : err))
  .finally(() => {
    fs.rmSync(DATA, { recursive: true, force: true });
    finish();
  });
