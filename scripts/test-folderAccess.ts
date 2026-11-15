// The folder resolver (src/server/authz/folders.ts) against docs/team-folders/00-design.md, "Who can open
// what": case by case, both modes.
//
// PURE (always): the rule over project roles × the best team grant × nesting (depth 5 resolves, 6 does not,
// nor a cycle, an orphan or an unknown id) × Everyone and its subfolders × admin; subfolder grants ignored;
// the reach switch inherited; no folders → today's access at every rank; `wholeProject` and a published request; the refusal's
// sentences, its 409 over the real route and the tagging of a caught one.
// NEGATIVE CONTROLS: an uncapped resolver fails the table; a caught unrelated error is not tagged.
//
// DATABASE (DATABASE_URL, a Postgres this suite may CREATE DATABASE and ROLE on): the note's people with
// real grants and teams, through an ordinary role so forced RLS applies — each person's level on each
// folder and item; `openerEmails` ≡ the resolver for every anchor and level (Object.is on sorted lists);
// a project without folders ≡ authorize's rank, and `openerEmails` there ≡ readerEmails / writerEmails;
// one query per request (memo), none for an admin; a database error refuses and is not remembered; another
// org's rows invisible (NEGATIVE CONTROL: the superuser sees them); the tables' constraints.
//
//   npm run build:ts && DATABASE_URL=… node scripts/test-folderAccess.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import { withCsrf } from './csrfPair';
import { randomBytes, randomUUID } from 'crypto';
import { Client, Pool } from 'pg';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');

const F: typeof import('../src/server/authz/folders') = require('../src/server/authz/folders');
const authz: typeof import('../src/server/authz/index') = require('../src/server/authz/index');
const caller: typeof import('../src/server/authz/caller') = require('../src/server/authz/caller');
const context: typeof import('../src/server/context') = require('../src/server/context');
const inOrgMod: typeof import('../src/server/db/inOrg') = require('../src/server/db/inOrg');
const mig: typeof import('../src/server/db/migrate') = require('../src/server/db/migrate');
const appMod: typeof import('../src/server/app') = require('../src/server/app');
const envMod: typeof import('../src/server/env') = require('../src/server/env');
const rpc: typeof import('../src/server/rpc') = require('../src/server/rpc');
const wire: typeof import('../src/server/wire') = require('../src/server/wire');

type Identity = import('../src/server/context').Identity;
type Level = import('../src/server/authz/folders').FolderLevel;
type Row = import('../src/server/authz/folders').FolderRow;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-folders-'));
const id = (): string => randomUUID();
const show = (v: unknown): string => JSON.stringify(v).slice(0, 400);
const sorted = (xs: readonly string[]): string => [...xs].sort().join(',');
const run = <T>(who: Identity, fn: () => Promise<T>): Promise<T> => context.runInContext(who, `t:${randomUUID()}`, fn);

// ── The world of the pure leg ─────────────────────────────────────────────
const P = id();
const [OPS, OPS_R, FIN, HR, HR_SUB, CYC_A, CYC_B, ORPH] = [id(), id(), id(), id(), id(), id(), id(), id()];
const DEEP = [OPS, id(), id(), id(), id(), id(), id()]; // DEEP[d] sits d below Ops: 5 resolves, 6 does not
const EV = [P, id(), id(), id(), id(), id(), id()]; // EV[d] sits d below Everyone
const rowsWith = (opsGrant: Row['grant']): Row[] => [
  { id: OPS, parentId: null, shareFigures: true, grant: opsGrant },
  { id: OPS_R, parentId: OPS, shareFigures: false, grant: 'edit' }, // a subfolder's grant (and switch) are ignored (D4)
  ...DEEP.slice(1).map((f, d) => ({ id: f, parentId: DEEP[d], shareFigures: true, grant: null })),
  ...EV.slice(1).map((f, d) => ({ id: f, parentId: EV[d], shareFigures: true, grant: null })),
  { id: FIN, parentId: null, shareFigures: true, grant: null },
  { id: HR, parentId: null, shareFigures: false, grant: null },
  { id: HR_SUB, parentId: HR, shareFigures: true, grant: null },
  { id: CYC_A, parentId: CYC_B, shareFigures: true, grant: null },
  { id: CYC_B, parentId: CYC_A, shareFigures: true, grant: null },
  { id: ORPH, parentId: id(), shareFigures: true, grant: null },
];

// The note's rule as a table: the cap by project rank, and a top-level folder's level by rank × best grant.
const CAP: Record<number, Level> = { 0: 'none', 1: 'view', 2: 'edit', 3: 'manage' };
const TOP: Record<number, Record<'none' | 'view' | 'edit', Level>> = {
  0: { none: 'none', view: 'none', edit: 'none' },
  1: { none: 'none', view: 'view', edit: 'view' },
  2: { none: 'none', view: 'view', edit: 'edit' },
  3: { none: 'manage', view: 'manage', edit: 'manage' },
};

/** Every (rank, Ops grant, folder) the resolver gets wrong. */
function mismatches(resolve: (rank: number, rows: Row[]) => import('../src/server/authz/folders').FolderAccess): string[] {
  const out: string[] = [];
  for (const rank of [0, 1, 2, 3]) {
    for (const g of [null, 'view', 'edit'] as const) {
      const a = resolve(rank, rowsWith(g));
      const ops = TOP[rank][g ?? 'none'];
      const closed = rank === 3 ? 'manage' : 'none';
      const want: [string, string, Level][] = [
        ['Everyone', P, CAP[rank]], ...EV.slice(1, 6).map((f, d): [string, string, Level] => [`Everyone/${d + 1}`, f, CAP[rank]]), ['Everyone/6', EV[6], closed],
        ['Ops', OPS, ops], ['Ops/Returns', OPS_R, ops], ...DEEP.slice(1, 6).map((f, d): [string, string, Level] => [`Ops/${d + 1}`, f, ops]), ['Ops/6', DEEP[6], closed],
        ['Finance (no grant)', FIN, closed], ['HR', HR, closed], ['HR/sub', HR_SUB, closed],
        ['a cycle', CYC_A, closed], ['an orphan', ORPH, closed], ['not a folder', id(), closed],
      ];
      for (const [label, f, level] of want) {
        const got = F.levelIn(a, f.toUpperCase()); // ids are compared lowercase
        if (got !== level) out.push(`rank ${rank}, Ops ${g ?? 'none'}: ${label} ${got} ≠ ${level}`);
      }
    }
  }
  return out;
}

async function pure(): Promise<void> {
  const miss = mismatches((rank, rows) => F.accessFrom(P, rank, rows));
  ok('rule: every rank × Ops grant × folder matches the note\'s table (caps, Everyone, nesting to 5, subfolder grants ignored, cycles, orphans)', miss.length === 0, miss.slice(0, 6).join('; '));
  const uncapped = mismatches((rank, rows) => F.accessFrom(P, rank === 1 ? 2 : rank, rows));
  ok('NEGATIVE CONTROL: a resolver without the viewer cap fails the table', uncapped.some((m) => m.startsWith('rank 1, Ops edit: Ops ')), uncapped.slice(0, 2).join('; '));

  const viewer = F.accessFrom(P, 1, rowsWith('edit'));
  const editor = F.accessFrom(P, 2, rowsWith('view'));
  ok('lists: viewOnly is open minus edit, edit within open', !viewer.all && !editor.all && sorted(editor.viewOnly) === sorted(editor.open.filter((f) => !editor.edit.includes(f))) && editor.edit.every((f) => editor.open.includes(f)) && viewer.edit.length === 0, show(editor));
  const share = !viewer.all ? sorted(viewer.shareFigures) : '';
  ok('reach switch: Everyone and its subfolders, Ops and all under it (its subfolder\'s own switch ignored), Finance; never HR, HR/sub or an unresolvable folder',
    share === sorted([...EV.slice(0, 6), ...DEEP.slice(0, 6), OPS_R, FIN]), share);
  ok('a project with no folders: noFolders, and only Everyone', (() => { const a = F.accessFrom(P, 1, []); return !a.all && a.noFolders && sorted(a.open) === P && a.edit.length === 0; })());
  ok('rank 3 is { all: true } whatever the folders; levelIn says manage', F.accessFrom(P, 3, rowsWith(null)).all && F.levelIn(F.accessFrom(P, 3, []), HR) === 'manage');
  ok('atLeast orders none < view < edit < manage', F.atLeast('edit', 'view') && F.atLeast('manage', 'edit') && !F.atLeast('view', 'edit') && !F.atLeast('none', 'view'));

  // ── In a request, no database: today's access, wholeProject ──
  context.enterServerMode(DATA);
  const viewerId: Identity = { user: { email: 'vic@acme.test', role: 'viewer' }, org: { id: 'acme' } };
  const today: string[] = [];
  for (const rank of [0, 1, 2, 3]) {
    const got = await run(viewerId, async () => {
      caller.seedRank(P, rank);
      return [F.levelIn(await F.folderAccessOn(P), P), await F.levelOn(P, 'dataset', id()), (await F.placementOf(P, 'dashboard', [OPS])).get(OPS)];
    });
    if (got.join() !== `${CAP[rank]},${CAP[rank]},${P}`) today.push(`rank ${rank}: ${got.join()}`);
  }
  ok('no Postgres: every rank opens Everyone at its project role, and every item is in Everyone', today.length === 0, today.join('; '));
  const admin: Identity = { user: { email: 'boss@acme.test', role: 'admin' }, org: { id: 'acme' } };
  ok('an org admin (and the jobs\' identity, desktop) is { all: true }', (await run(admin, () => F.folderAccessOn(P))).all);
  const walk = await run(viewerId, async () => {
    caller.seedRank(P, 1);
    const inside = await F.wholeProject(async () => { await new Promise((r) => setTimeout(r, 1)); return F.folderAccessOn(P); });
    return { inside: inside.all, after: (await F.folderAccessOn(P)).all, flag: F.inWholeProject() };
  });
  ok('wholeProject: { all: true } inside, across awaits; restricted again after it', walk.inside && !walk.after && !walk.flag, show(walk));
  // A published page's request (/p/, a signed embed) is its link's audience, chosen at Publish (D17): every folder.
  const anon: Identity = { user: { email: 'anonymous', role: 'viewer' }, org: { id: 'acme' } };
  ok('a published request ({ published }) is { all: true }; the same identity in an ordinary request is not',
    (await context.runAsPublished(anon, 'p', () => F.folderAccessOn(P))).all && !(await run(anon, () => F.folderAccessOn(P))).all);
  let kindThrew = false;
  await run(viewerId, () => F.placementOf(P, 'story' as never, [OPS])).catch(() => (kindThrew = true));
  ok('placementOf refuses a kind that is not placed', kindThrew);

  // ── The refusal ──
  const sentences = F.FOLDER_REASONS.map((r) => new F.FolderError(r));
  ok('every reason has its own fixed catalog sentence (no parameter, so it can name nothing)', sentences.every((e) => e.message.length > 10 && !/[{}]/.test(e.message)) && new Set(sentences.map((e) => e.message)).size === F.FOLDER_REASONS.length, sentences.map((e) => e.message).join(' | '));
  ok('isFolderError: by class, and by name and code across a module copy', F.isFolderError(sentences[0]) && F.isFolderError({ name: 'FolderError', code: 'folder' }) && !F.isFolderError(new Error(sentences[0].message)) && !F.isFolderError(null));
  const closed = sentences[0].message;
  const batch = F.tagFolderRefusals([{ ok: false, error: closed }, { ok: false, error: 'Pick a measure.' }, { ok: true }]);
  ok('a caught refusal in a batch is typed folder/closed', show(batch[0]) === show({ ok: false, error: closed, code: 'folder', reason: 'closed' }), show(batch));
  ok('NEGATIVE CONTROL: an unrelated failure and a success are left alone', show(batch.slice(1)) === show([{ ok: false, error: 'Pick a measure.' }, { ok: true }]));

  // ── The route: 409 `folder` with the sentence; a caught one typed ──
  rpc.registry.handle('projects:roles', async () => { throw new F.FolderError('edit'); });
  rpc.registry.handle('prefs:get', async () => { try { throw new F.FolderError('closed'); } catch (e) { return [{ ok: false, error: (e as Error).message }]; } });
  const app = appMod.buildApp(envMod.parseEnv({ AUTH_MODE: 'dev', LOG_LEVEL: 'silent', DATA_DIR: DATA }), undefined, () => viewerId);
  const post = (ch: string) => app.inject({ method: 'POST', url: `/api/rpc/${ch}`, headers: withCsrf({ 'content-type': 'application/json' }), payload: wire.encode({ args: [] }) });
  const thrown = await post('projects:roles');
  ok('route: a thrown FolderError is 409 { error, code: folder, reason, message } — the sentence and nothing else', thrown.statusCode === 409 && thrown.body === JSON.stringify({ error: 'folder', code: 'folder', reason: 'edit', message: new F.FolderError('edit').message }), `${thrown.statusCode} ${thrown.body}`);
  const caught = await post('prefs:get');
  ok('route: a refusal a handler caught keeps its type', caught.statusCode === 200 && show(wire.decode(caught.body)) === show([{ ok: false, error: closed, code: 'folder', reason: 'closed' }]), caught.body);
  await app.close();
  rpc.registry.removeHandler('projects:roles');
  rpc.registry.removeHandler('prefs:get');
}

// ── The database leg ──────────────────────────────────────────────────────
async function db(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.log('skip folder access DB leg: DATABASE_URL is unset (set it to a Postgres this suite may CREATE DATABASE on)');
    return;
  }
  const dbName = `ordinate_folders_${process.pid}_${Date.now()}`;
  const role = `folders_role_${process.pid}`;
  const root = new Client({ connectionString: url });
  await root.connect();
  await root.query(`CREATE DATABASE ${dbName}`);
  const scratch = new URL(url);
  scratch.pathname = '/' + dbName;
  const sup = new Pool({ connectionString: scratch.toString(), max: 4 });
  sup.on('error', () => undefined);
  let plain: Pool | null = null;
  try {
    await mig.migrate(sup);
    const pw = randomBytes(12).toString('hex');
    await sup.query(`CREATE ROLE ${role} LOGIN PASSWORD '${pw}'`);
    await sup.query(`GRANT SELECT ON folders, folder_grants, folder_items, users, teams, team_members, project_grants TO ${role}`);
    const pu = new URL(scratch.toString());
    pu.username = role;
    pu.password = pw;
    plain = new Pool({ connectionString: pu.toString(), max: 2 });
    plain.on('error', () => undefined);
    let connects = 0;
    const realConnect = plain.connect.bind(plain) as () => Promise<import('pg').PoolClient>;
    (plain as unknown as { connect: () => Promise<unknown> }).connect = () => { connects++; return realConnect(); };
    inOrgMod.useOrgDb(plain); // forced RLS applies: this role is no superuser
    caller.register(() => sup);

    const q = (sql: string, args: unknown[] = []) => sup.query(sql, args);
    for (const o of ['acme', 'beta']) await q('INSERT INTO orgs (id, name) VALUES ($1, $1)', [o]);
    const team = async (name: string, org = 'acme'): Promise<string> => (await q('INSERT INTO teams (org_id, name) VALUES ($1, $2) RETURNING id::text', [org, name])).rows[0].id;
    const T = { ops: await team('Ops'), leads: await team('Ops leads'), fin: await team('Finance'), viewers: await team('Viewers') };
    const Q = id(); // a project with the same grants and no folders
    type Person = { role: 'admin' | 'editor' | 'viewer'; grant?: 'admin' | 'editor' | 'viewer'; teams?: string[]; disabled?: boolean };
    const PEOPLE: Record<string, Person> = {
      boss: { role: 'admin' }, padmin: { role: 'viewer', grant: 'admin' }, opsViewer: { role: 'viewer', grant: 'viewer', teams: [T.ops] },
      opsLead: { role: 'editor', grant: 'editor', teams: [T.leads] }, opsEditorView: { role: 'editor', grant: 'editor', teams: [T.ops] },
      finViewer: { role: 'viewer', grant: 'viewer', teams: [T.fin] }, ed: { role: 'editor', grant: 'editor' }, nobody: { role: 'viewer', teams: [T.ops, T.leads] },
      teamViewer: { role: 'editor', teams: [T.viewers, T.ops, T.leads] }, // a project viewer through a team; Ops leads' edit capped at view
      twoTeams: { role: 'viewer', grant: 'editor', teams: [T.ops, T.leads] }, gone: { role: 'viewer', grant: 'editor', teams: [T.leads], disabled: true },
    };
    const who: Record<string, Identity> = {};
    for (const [name, p] of Object.entries(PEOPLE)) {
      const email = `${name.toLowerCase()}@acme.test`;
      who[name] = { user: { email, role: p.role }, org: { id: 'acme' } };
      const u = (await q('INSERT INTO users (org_id, email, role, disabled_at) VALUES ($1, $2, $3, $4) RETURNING id::text', ['acme', email, p.role, p.disabled ? new Date() : null])).rows[0].id;
      for (const t of p.teams ?? []) await q('INSERT INTO team_members (team_id, user_id) VALUES ($1, $2)', [t, u]);
      for (const proj of [P, Q]) if (p.grant) await q('INSERT INTO project_grants (org_id, project_id, user_id, role) VALUES ($1, $2, $3, $4)', ['acme', proj, u, p.grant]);
    }
    for (const proj of [P, Q]) await q('INSERT INTO project_grants (org_id, project_id, team_id, role) VALUES ($1, $2, $3, $4)', ['acme', proj, T.viewers, 'viewer']);
    const folder = (fid: string, parent: string | null, name: string, share = true, org = 'acme') =>
      q('INSERT INTO folders (org_id, project_id, id, parent_id, name, share_figures, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7)', [org, P, fid, parent, name, share, 'boss@acme.test']);
    const grant = (fid: string, t: string, level: string, org = 'acme') => q('INSERT INTO folder_grants (org_id, project_id, folder_id, team_id, level) VALUES ($1, $2, $3, $4, $5)', [org, P, fid, t, level]);
    const place = (kind: string, item: string, fid: string, org = 'acme') => q('INSERT INTO folder_items (org_id, project_id, kind, item_id, folder_id, moved_by) VALUES ($1, $2, $3, $4, $5, $6)', [org, P, kind, item, fid, 'boss@acme.test']);
    const EVSUB = EV[1];
    await folder(OPS, null, 'Ops');
    await folder(OPS_R, OPS, 'Returns');
    for (let d = 1; d <= 6; d++) await folder(DEEP[d], DEEP[d - 1], `Level ${d}`);
    await folder(FIN, null, 'Finance');
    await folder(HR, null, 'HR', false);
    await folder(HR_SUB, HR, 'Payroll');
    await folder(EVSUB, P, 'Shared');
    await grant(OPS, T.ops, 'view');
    await grant(OPS, T.leads, 'edit');
    await grant(FIN, T.fin, 'view');
    await grant(OPS_R, T.fin, 'edit'); // a subfolder grant: ignored
    const item = { ops: id(), returns: id(), deep5: id(), deep6: id(), fin: id(), hr: id(), hrSub: id(), evSub: id(), everyone: id() };
    const FOLDER_OF: Record<keyof typeof item, string> = { ops: OPS, returns: OPS_R, deep5: DEEP[5], deep6: DEEP[6], fin: FIN, hr: HR, hrSub: HR_SUB, evSub: EVSUB, everyone: P };
    for (const [k, f] of Object.entries(FOLDER_OF)) if (f !== P) await place('dataset', item[k as keyof typeof item], f);
    const board = id();
    await place('dashboard', board, FIN);

    // Another org's rows under the SAME project and folder ids (ids repeat across orgs after an import).
    const betaTeam = await team('Ops', 'beta');
    const BETA_ONLY = id();
    await folder(OPS, null, 'BETACANARY', true, 'beta');
    await folder(BETA_ONLY, null, 'BETACANARY 2', true, 'beta');
    await grant(BETA_ONLY, betaTeam, 'edit', 'beta');
    await place('dataset', item.everyone, BETA_ONLY, 'beta');

    // Each person's level on each folder and item, as the note's rule says.
    const L = (x: string): Level[] => x.split('').map((c) => ({ M: 'manage', E: 'edit', V: 'view', '-': 'none' })[c] as Level);
    //                     Everyone EvSub Ops Returns Deep5 Deep6 Fin HR HRsub
    const WANT: Record<string, Level[]> = {
      boss: L('MMMMMMMMM'), padmin: L('MMMMMMMMM'), opsViewer: L('VVVVV----'), opsLead: L('EEEEE----'), opsEditorView: L('EEVVV----'),
      finViewer: L('VV----V--'), ed: L('EE-------'), nobody: L('---------'), teamViewer: L('VVVVV----'), twoTeams: L('EEEEE----'), gone: L('---------'),
    };
    const COLS = [P, EVSUB, OPS, OPS_R, DEEP[5], DEEP[6], FIN, HR, HR_SUB];
    const ITEM_COL: Record<keyof typeof item, number> = { everyone: 0, evSub: 1, ops: 2, returns: 3, deep5: 4, deep6: 5, fin: 6, hr: 7, hrSub: 8 };
    const levels: Record<string, Record<keyof typeof item, Level>> = {};
    const wrong: string[] = [];
    for (const [name, want] of Object.entries(WANT)) {
      const got = await run(who[name], async () => {
        const a = await F.folderAccessOn(P);
        const items = {} as Record<keyof typeof item, Level>;
        for (const k of Object.keys(item) as (keyof typeof item)[]) items[k] = await F.levelOn(P, 'dataset', item[k]);
        return { folders: COLS.map((f) => F.levelIn(a, f)), items, beta: !a.all && (a.open.includes(BETA_ONLY) || a.shareFigures.includes(BETA_ONLY)) };
      });
      levels[name] = got.items;
      if (got.folders.join() !== want.join()) wrong.push(`${name} folders ${got.folders.join()} ≠ ${want.join()}`);
      for (const [k, col] of Object.entries(ITEM_COL)) if (got.items[k as keyof typeof item] !== want[col]) wrong.push(`${name} item ${k} ${got.items[k as keyof typeof item]} ≠ ${want[col]}`);
      if (got.beta) wrong.push(`${name} sees another org's folder`);
    }
    ok('db: each person × folder and item resolves as the note\'s rule says (roles, teams, caps, nesting, Everyone, admins, disabled)', wrong.length === 0, wrong.slice(0, 6).join('; '));

    // openerEmails ≡ the resolver, for every anchor and level, outside a request (as a job asks).
    const disagree: string[] = [];
    const anchors: [string, 'dataset' | 'dashboard', string, Record<string, Level>][] = Object.entries(item).map(([k, v]) => [k, 'dataset', v, Object.fromEntries(Object.keys(WANT).map((n) => [n, levels[n][k as keyof typeof item]]))]);
    const boardLevels: Record<string, Level> = {};
    for (const n of Object.keys(WANT)) boardLevels[n] = await run(who[n], () => F.levelOn(P, 'dashboard', board));
    anchors.push(['the Finance board', 'dashboard', board, boardLevels]);
    for (const [label, kind, anchorId, byPerson] of anchors) {
      for (const min of ['view', 'edit'] as const) {
        const sql = await F.openerEmails(sup, 'acme', P, { kind, id: anchorId }, min);
        const js = Object.keys(WANT).filter((n) => F.atLeast(byPerson[n], min)).map((n) => who[n].user.email);
        if (sorted(sql) !== sorted(js)) disagree.push(`${label} ≥ ${min}: sql ${sorted(sql)} | resolver ${sorted(js)}`);
      }
    }
    ok(`db: openerEmails ≡ the resolver for ${anchors.length} anchors × view and edit (Object.is on the sorted lists)`, disagree.length === 0, disagree.slice(0, 3).join('; '));

    // A project without folders: today's access for every person, by authorize's own rank.
    const todays: string[] = [];
    for (const [name, w] of Object.entries(who)) {
      const got = await run(w, async () => [await F.levelOn(Q, 'dataset', id()), F.levelIn(await F.folderAccessOn(Q), Q)]);
      const rank = name === 'boss' ? 3 : await authz.grantRank(sup, w, Q);
      if (got.join() !== `${CAP[rank]},${CAP[rank]}`) todays.push(`${name}: ${got.join()} vs rank ${rank}`);
    }
    ok('db: no folders → every person opens Everyone exactly at authorize\'s rank (differential over every role)', todays.length === 0, todays.join('; '));
    const anyItem = { kind: 'dataset' as const, id: id() };
    ok('db: no folders → openerEmails ≡ readerEmails and writerEmails',
      sorted(await F.openerEmails(sup, 'acme', Q, anyItem, 'view')) === sorted(await authz.readerEmails(sup, 'acme', Q))
      && sorted(await F.openerEmails(sup, 'acme', Q, anyItem, 'edit')) === sorted(await authz.writerEmails(sup, 'acme', Q)));

    // The memo: one query per request for the tree, one per new set of ids; none for an admin.
    const memo = await run(who.opsViewer, async () => {
      const at = (): number => connects;
      const n0 = at();
      await F.folderAccessOn(P); await F.folderAccessOn(P); await F.levelOn(P, 'dataset', item.fin);
      const tree = at() - n0;
      await F.placementOf(P, 'dataset', [item.fin, item.ops]);
      const again = at() - n0;
      await F.placementOf(P, 'dataset', [item.hr]);
      await F.levelOn(Q, 'dataset', id()); // no folders there: the tree, and no placement query
      return { tree, again, more: at() - n0 };
    });
    ok('db memo: the tree once a request, a placement once per id, none for a project without folders', memo.tree === 2 && memo.again === 3 && memo.more === 5, show(memo));
    const next = connects;
    await run(who.opsViewer, () => F.folderAccessOn(P));
    ok('NEGATIVE CONTROL: the next request asks again (the memo dies with the request)', connects === next + 1);
    // A list across projects (projects:overview): which have a folder, in one round trip through forced RLS; the rest bare.
    const batch = await run(who.opsViewer, async () => {
      const n0 = connects;
      const has = [...(await F.foldersRestrict([P, Q]))];
      const one = connects - n0;
      await F.folderAccessOn(Q); // known bare: no tree
      const bare = connects - n0;
      await F.folderAccessOn(P);
      return { has, one, bare, foldered: connects - n0 };
    });
    ok('db: foldersRestrict names the project with folders (P, not Q) in one round trip, as the app\'s role; Q\'s resolver then asks nothing, P\'s asks its tree',
      JSON.stringify(batch) === JSON.stringify({ has: [P.toLowerCase()], one: 1, bare: 1, foldered: 2 }), show(batch));
    const adminB = connects;
    ok('NEGATIVE CONTROL: for an org admin it names none and reads nothing', (await run(who.boss, () => F.foldersRestrict([P, Q]))).size === 0 && connects === adminB);
    const adminN = connects;
    await run(who.boss, async () => { await F.folderAccessOn(P); await F.levelOn(P, 'dataset', item.hr); });
    ok('db: an org admin needs no query at all', connects === adminN);
    const fail = await run(who.opsViewer, async () => {
      inOrgMod.useOrgDb({ connect: async () => { throw new Error('db down'); } } as unknown as Pool);
      const first = await F.folderAccessOn(P).then(() => 'answered', () => 'refused');
      inOrgMod.useOrgDb(plain);
      const second = F.levelIn(await F.folderAccessOn(P), OPS);
      return `${first} ${second}`;
    });
    ok('db: a database error refuses (never falls back), and is not remembered as an answer', fail === 'refused view', fail);

    // Forced RLS: another org's rows are invisible to the app's role, whatever the WHERE.
    const seen = async (org: string | null): Promise<string> => {
      const c = await (plain as Pool).connect();
      try {
        await c.query('BEGIN');
        if (org) await c.query(`SELECT set_config('ordinate.org', $1, true)`, [org]);
        const r = await c.query<{ n: string }>(`SELECT (SELECT count(*) FROM folders) || '/' || (SELECT count(*) FROM folder_grants) || '/' || (SELECT count(*) FROM folder_items) AS n`);
        await c.query('COMMIT');
        return r.rows[0].n;
      } finally {
        c.release();
      }
    };
    const total = (await q(`SELECT (SELECT count(*) FROM folders) || '/' || (SELECT count(*) FROM folder_grants) || '/' || (SELECT count(*) FROM folder_items) AS n`)).rows[0].n;
    ok('db RLS: no ordinate.org → no rows; acme → acme\'s only; beta → beta\'s only', (await seen(null)) === '0/0/0' && (await seen('acme')) === '12/4/9' && (await seen('beta')) === '2/1/1', `${await seen('acme')} ${await seen('beta')}`);
    ok('NEGATIVE CONTROL: the superuser sees both orgs\' rows', total === '14/5/10', total);
    ok('db RLS: acme\'s unplaced item stays in Everyone though beta placed the same id', (await run(who.opsViewer, () => F.placementOf(P, 'dataset', [item.everyone]))).get(item.everyone) === P);

    // The tables' constraints (0032).
    const refused = async (sql: string, args: unknown[]): Promise<boolean> => q(sql, args).then(() => false, () => true);
    const [PARENT, CHILD] = [id(), id()];
    await folder(PARENT, null, 'Empty parent');
    await folder(CHILD, PARENT, 'Child');
    ok('db: a folder holding an item, or a subfolder, cannot be deleted', await refused('DELETE FROM folders WHERE org_id = $1 AND id = $2', ['acme', FIN]) && await refused('DELETE FROM folders WHERE org_id = $1 AND id = $2', ['acme', PARENT]));
    ok('db: a whole subtree goes in one statement (a project\'s deletion)', !(await refused('DELETE FROM folders WHERE org_id = $1 AND id = ANY($2::uuid[])', ['acme', [PARENT, CHILD]])));
    ok('db: sibling names are unique regardless of case; the same name elsewhere is fine', await refused('INSERT INTO folders (org_id, project_id, id, parent_id, name, created_by) VALUES ($1, $2, $3, NULL, $4, $5)', ['acme', P, id(), 'OPS', 'x'])
      && !(await refused('INSERT INTO folders (org_id, project_id, id, parent_id, name, created_by) VALUES ($1, $2, $3, $4, $5, $6)', ['acme', P, id(), EVSUB, 'Ops', 'x'])));
    ok('db: a parent in no folder of the project, an empty name, the project id as a folder, a level beyond view and edit, an upper-case item id: refused',
      await refused('INSERT INTO folders (org_id, project_id, id, parent_id, name, created_by) VALUES ($1, $2, $3, $4, $5, $6)', ['acme', P, id(), id(), 'Lost', 'x'])
      && await refused('INSERT INTO folders (org_id, project_id, id, parent_id, name, created_by) VALUES ($1, $2, $3, NULL, $4, $5)', ['acme', P, id(), '', 'x'])
      && await refused('INSERT INTO folders (org_id, project_id, id, parent_id, name, created_by) VALUES ($1, $2, $2, NULL, $3, $4)', ['acme', P, 'Self', 'x'])
      && await refused('INSERT INTO folder_grants (org_id, project_id, folder_id, team_id, level) VALUES ($1, $2, $3, $4, $5)', ['acme', P, HR, T.ops, 'manage'])
      && await refused('INSERT INTO folder_items (org_id, project_id, kind, item_id, folder_id, moved_by) VALUES ($1, $2, $3, $4, $5, $6)', ['acme', P, 'dataset', id().toUpperCase(), OPS, 'x']));
    await q('DELETE FROM teams WHERE id = $1', [T.fin]);
    ok('db: a deleted team takes its folder grants with it', (await q('SELECT count(*)::int AS n FROM folder_grants WHERE team_id = $1', [T.fin])).rows[0].n === 0);
  } finally {
    inOrgMod.useOrgDb(null);
    caller.register(() => null);
    await plain?.end().catch(() => undefined);
    await sup.end().catch(() => undefined);
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`).catch(() => undefined);
    await root.query(`DROP ROLE IF EXISTS ${role}`).catch(() => undefined);
    await root.end().catch(() => undefined);
  }
}

(async () => {
  await pure();
  await db();
})()
  .catch((err) => ok('suite ran to completion', false, err instanceof Error ? err.stack : err))
  .finally(() => {
    fs.rmSync(DATA, { recursive: true, force: true });
    finish();
  });
