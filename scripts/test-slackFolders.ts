// Ordinate in Slack: team folders in the check (docs/slack/00-design.md, "What changed with the new ask flow" 1 and 5).
// A dataset in a folder that is not open to everyone is restricted and goes through case B; a member whose folder level is
// `none` makes the check fail; admins with equal views pass. Over the team-folders world (scripts/folderHarness.ts) and a
// local stub of Slack. Skips without DATABASE_URL.
//
//   npm run build:ts && DATABASE_URL=… node scripts/test-slackFolders.js

export {}; // module scope — sibling test scripts share top-level names
import { createSecretKey, randomBytes } from 'crypto';
import { ok, finish } from './selfcheck';
import * as F from './folderHarness';
import { startSlackStub } from './slackStub';

const store: typeof import('../src/server/slack/db') = require('../src/server/slack/db');
const checkMod: typeof import('../src/server/slack/check') = require('../src/server/slack/check');
const secretsMod: typeof import('../src/server/secrets/store') = require('../src/server/secrets/store');

(async () => {
  const W = await F.world('slack folders');
  if (!W) return;
  const stub = await startSlackStub();
  try {
    process.env.SSRF_ALLOW = [process.env.SSRF_ALLOW, '127.0.0.1/32'].filter(Boolean).join(',');
    process.env.ORDINATE_TEST_SLACK_BASE = stub.origin;
    store.useSlackDb(W.pool, secretsMod.createSecretStore(W.pool, createSecretKey(randomBytes(32))));
    if (!(await W.pool.query(`SELECT 1 FROM folders LIMIT 1`)).rowCount) await W.plantFolders();
    const TEAM = stub.team.id;
    await store.saveInstall({ teamId: TEAM, orgId: 'acme', teamName: 'Acme', enterpriseId: null, appId: 'A1', botUserId: stub.team.botUser, clientId: 'c', mode: 'events' });
    await store.putSecret('acme', 'botToken', stub.team.botToken);
    const inst = (await store.installByOrg('acme')) as import('../src/server/slack/db').Install;
    const people: F.Person[] = ['boss', 'padmin', 'opsViewer', 'finViewer'];
    for (const p of people) {
      stub.users.set(`U${p}`, { id: `U${p}`, team_id: TEAM });
      await W.call(p, 'projects:list');
    }
    const channel = (id: string, members: F.Person[]) => stub.channels.set(id, { id, members: [stub.team.botUser, ...members.map((p) => `U${p}`)] });
    const link = (p: F.Person) => store.saveLink('acme', TEAM, `U${p}`, `${p.toLowerCase()}@acme.test`);
    const run = (ch: string, asker: F.Person, ds: string[], boards: string[] = []) =>
      W.as(asker, () => checkMod.check(W.pool, inst, stub.team.botToken, ch, `U${asker}`, { projectId: W.P, datasetIds: ds, dashboardIds: boards }));
    const restricted = (ds: string[]) => W.as('boss', () => checkMod.restricted({ projectId: W.P, datasetIds: ds, dashboardIds: [] }));

    ok('Folders: a dataset in a team folder with no grants is restricted', await restricted([W.hr.ds]));
    ok('Folders: a dataset in a team folder some teams may open is restricted too (not open to everyone)', await restricted([W.ops.ds]));
    ok('Folders (control): a dataset in Everyone, with no row or column rules, is not restricted', !(await restricted([W.plain])));

    channel('CUNLINKED', ['boss', 'opsViewer']);
    const a = await run('CUNLINKED', 'boss', [W.plain]);
    const b = await run('CUNLINKED', 'boss', [W.ops.ds]);
    ok('Folders: unrestricted data posts with an unlinked member present (case A)', a.post === true && a.case === 'A', JSON.stringify(a));
    ok('Folders: a dataset in a non-Everyone folder is case B — the same unlinked member makes it private', b.post === false && b.why === 'unlinked', JSON.stringify(b));

    for (const p of people) await link(p);
    channel('CHRFIN', ['boss', 'finViewer']);
    const none = await run('CHRFIN', 'boss', [W.hr.ds]);
    ok('Folders: a member whose folder level is `none` makes the check fail', none.post === false && none.why === 'no_access', JSON.stringify(none));
    channel('CHRADMIN', ['boss', 'padmin']);
    const equal = await run('CHRADMIN', 'boss', [W.hr.ds]);
    ok('Folders: two admins who may open the folder and see it alike pass', equal.post === true && equal.case === 'B', JSON.stringify(equal));
    const board = await run('CHRFIN', 'boss', [W.plain], [W.hr.board]);
    ok('Folders: a dashboard the member cannot open (folder level `none`) makes the check fail', board.post === false && board.why === 'no_access', JSON.stringify(board));
    const boardOk = await run('CHRADMIN', 'boss', [W.plain], [W.hr.board]);
    ok('Folders (control): the same dashboard with members who may open it passes', boardOk.post === true, JSON.stringify(boardOk));
    channel('COPSVIEW', ['opsViewer', 'finViewer']);
    const viewers = await run('COPSVIEW', 'opsViewer', [W.ops.ds]);
    ok('Folders: a viewer asking on Ops data with a Finance viewer present fails (Finance cannot open Ops)', viewers.post === false && viewers.why === 'no_access', JSON.stringify(viewers));
  } finally {
    store.useSlackDb(null, null);
    await stub.close();
    await W.close();
  }
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
}).finally(finish);
