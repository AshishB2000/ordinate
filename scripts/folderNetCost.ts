// The switcher's cost under shared folders (docs/team-folders/00-design.md, "The resolver"): `projects:overview` for a
// non-admin over many projects is inert in cost — ONE round trip says which projects have a folder besides Everyone
// (src/server/authz/folders.ts `foldersRestrict`), and only those run the resolver. Counted as scripts/test-askBudget.ts
// counts: every pg Client query while the call runs, each the least of three runs (a settings read once a second, say).
// Run by ./folderNet: `bare` in section 0 (no folder anywhere), `foldered` in section 9 (folders on P and one more).
// And ⌘K (E4): `bareSearch` in section 0 — `search:query` makes exactly the statements it makes with no folder code, as
// whether the project has a folder is read in the index's own marker statement (src/server/searchIndex.ts `unbuilt`);
// `folderedSearch` in section 6 — then it reads P's tree once. And reach (E5): `figuresBare` in section 0 — a dashboard's
// figure calls read nothing of dashboard_reads with no folder. Not a test file itself (no `test-` prefix).

import { Client } from 'pg';
import { ok } from './selfcheck';
import type * as H from './folderHarness';

const gate: typeof import('../src/server/authz/folderGate') = require('../src/server/authz/folderGate');
const folders: typeof import('../src/server/authz/folders') = require('../src/server/authz/folders');
const searchIndex: typeof import('../src/server/searchIndex') = require('../src/server/searchIndex');

const WHO: H.Person[] = ['opsLead', 'opsViewer'];
type Cost = { statements: number; trees: number; reach: number };
type Calls = Array<[string, unknown]>;

/** The least cost of three calls (`projects:overview` unless named) by `who`: statements, how many read a folder tree, how many dashboard_reads (reach, E5). */
async function cost(W: H.World, who: H.Person, call: () => Promise<unknown> = () => W.call(who, 'projects:overview')): Promise<Cost> {
  const proto = Client.prototype as unknown as { query: (...a: unknown[]) => unknown };
  const query = proto.query;
  let best: Cost | null = null;
  for (let i = 0; i < 3; i++) {
    const c: Cost = { statements: 0, trees: 0, reach: 0 };
    proto.query = function (this: unknown, ...a: unknown[]) {
      c.statements++;
      const text = String(typeof a[0] === 'string' ? a[0] : (a[0] as { text?: unknown } | null)?.text ?? '');
      if (text.includes('LEFT JOIN folder_grants')) c.trees++;
      if (text.includes('dashboard_reads')) c.reach++;
      return query.apply(this, a);
    };
    try {
      await call();
    } finally {
      proto.query = query;
    }
    if (!best || c.statements < best.statements) best = c;
  }
  return best!;
}

/** With the folder checks off: no folder code runs at all, the E2 tree's cost for an editor (less for a viewer). */
async function baseline(W: H.World, who: H.Person, call?: () => Promise<unknown>): Promise<Cost> {
  gate.setFolderChecksForTest(false);
  try {
    return await cost(W, who, call);
  } finally {
    gate.setFolderChecksForTest(true);
  }
}

/**
 * Section 0, E5: a dashboard's figure calls with no folder anywhere read no dashboard_reads (reach is asked only of a
 * dataset a folder closes) and cost what E2's checks cost — the one tree read per request — over no folder code.
 */
export async function figuresBare(W: H.World, calls: Calls): Promise<void> {
  const who: H.Person = 'opsViewer';
  const run = async (): Promise<void> => {
    for (const [ch, payload] of calls) await W.call(who, ch, payload);
  };
  const [on, off] = [await cost(W, who, run), await baseline(W, who, run)];
  ok(`inert in cost: ${calls.length} figure calls by ${who} with no folder read dashboard_reads ${on.reach} times; ${on.statements} statements ≤ ${off.statements} (no folder code) + one tree read (3) per call`,
    on.reach === 0 && on.trees <= calls.length && on.statements <= off.statements + 3 * calls.length, JSON.stringify({ on, off }));
}

/** Each project resolved on its own, as before the batch: the negative control's cost. */
async function perProject(W: H.World, who: H.Person): Promise<Cost> {
  folders.setFolderBatchForTest(false);
  try {
    return await cost(W, who);
  } finally {
    folders.setFolderBatchForTest(true);
  }
}

/** `n` projects beside P, each shared with opsLead (editor) and opsViewer (viewer): their ids. */
export async function moreProjects(W: H.World, n: number): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const id = String((await W.call('boss', 'projects:create', { name: `Spare ${i}` })).body?.id ?? '');
    for (const [who, role] of [['opsLead', 'editor'], ['opsViewer', 'viewer']] as const) await W.call('boss', 'project:share', { projectId: id, member: { userId: W.uid[who] }, role });
    ids.push(id);
  }
  return ids;
}

/** Section 0: no folder anywhere — at most one statement more than no folder code, and no tree read. */
export async function bare(W: H.World, projects: number): Promise<void> {
  for (const who of WHO) {
    const [on, off, each] = [await cost(W, who), await baseline(W, who), await perProject(W, who)];
    ok(`inert in cost: projects:overview over ${projects} projects with no folder, for ${who}: ${on.statements} statements ≤ ${off.statements} (no folder code) + 1, no tree read`, on.statements <= off.statements + 1 && on.trees === 0, JSON.stringify({ on, off }));
    ok(`NEGATIVE CONTROL: each project resolved on its own (no batch), ${who}'s is over that ceiling (${each.statements}, ${each.trees} tree reads)`, each.statements > off.statements + 1 && each.trees === projects, JSON.stringify(each));
  }
}

/** Section 9: folders on P and on one more project — the resolver reads only those two trees. */
export async function foldered(W: H.World, extra: string[]): Promise<void> {
  await W.pool.query("INSERT INTO folders (org_id, project_id, id, parent_id, name, created_by) VALUES ('acme', $1, gen_random_uuid(), NULL, 'Spare folder', 'boss@acme.test')", [extra[0]]);
  for (const who of WHO) {
    const [on, each] = [await cost(W, who), await perProject(W, who)];
    ok(`cost: with folders on 2 of ${extra.length + 1} projects, ${who}'s projects:overview reads 2 trees (${on.statements} statements)`, on.trees === 2, JSON.stringify(on));
    ok(`NEGATIVE CONTROL: without the batch it reads every project's (${each.trees}, ${each.statements} statements)`, each.trees === extra.length + 1 && each.statements > on.statements, JSON.stringify(each));
  }
}

const palette = (W: H.World, who: H.Person) => () => W.call(who, 'search:query', { projectId: W.P, query: 'ops' });

/** Section 0: ⌘K with no folder — exactly the statements with no folder code, no tree read. */
export async function bareSearch(W: H.World): Promise<void> {
  for (const who of WHO) {
    const [on, off] = [await cost(W, who, palette(W, who)), await baseline(W, who, palette(W, who))];
    ok(`inert in cost: ⌘K with no folder, for ${who}: ${on.statements} statements = ${off.statements} with no folder code, no tree read`, on.statements === off.statements && on.trees === 0, JSON.stringify({ on, off }));
  }
  const real = searchIndex.unbuilt;
  (searchIndex as { unbuilt: unknown }).unbuilt = async (p: string) => { const u = await real(p); return u && { ...u, foldered: true }; };
  try {
    const each = await cost(W, 'opsViewer', palette(W, 'opsViewer'));
    const off = await baseline(W, 'opsViewer', palette(W, 'opsViewer'));
    ok(`NEGATIVE CONTROL: resolving the caller's folders without asking first, opsViewer's ⌘K reads a tree (${each.statements} statements)`, each.trees === 1 && each.statements > off.statements, JSON.stringify(each));
  } finally {
    (searchIndex as { unbuilt: unknown }).unbuilt = real;
  }
}

/** Section 6: with folders on P, ⌘K reads P's tree once for a caller they restrict. */
export async function folderedSearch(W: H.World): Promise<void> {
  for (const who of WHO) {
    const on = await cost(W, who, palette(W, who));
    ok(`cost: with folders on P, ${who}'s ⌘K reads P's tree once (${on.statements} statements)`, on.trees === 1, JSON.stringify(on));
  }
}
