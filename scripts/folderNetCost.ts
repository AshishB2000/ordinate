// The switcher's cost under shared folders (docs/team-folders/00-design.md, "The resolver"): `projects:overview` for a
// non-admin over many projects is inert in cost — ONE round trip says which projects have a folder besides Everyone
// (src/server/authz/folders.ts `foldersRestrict`), and only those run the resolver. Counted as scripts/test-askBudget.ts
// counts: every pg Client query while the call runs, each the least of three runs (a settings read once a second, say).
// Run by ./folderNet: `bare` in section 0 (no folder anywhere), `foldered` in section 9 (folders on P and one more).
// Not a test file itself (no `test-` prefix).

import { Client } from 'pg';
import { ok } from './selfcheck';
import type * as H from './folderHarness';

const gate: typeof import('../src/server/authz/folderGate') = require('../src/server/authz/folderGate');
const folders: typeof import('../src/server/authz/folders') = require('../src/server/authz/folders');

const WHO: H.Person[] = ['opsLead', 'opsViewer'];
type Cost = { statements: number; trees: number };

/** The least cost of three `projects:overview` calls by `who`: statements, and how many read a project's folder tree. */
async function cost(W: H.World, who: H.Person): Promise<Cost> {
  const proto = Client.prototype as unknown as { query: (...a: unknown[]) => unknown };
  const query = proto.query;
  let best: Cost | null = null;
  for (let i = 0; i < 3; i++) {
    const c: Cost = { statements: 0, trees: 0 };
    proto.query = function (this: unknown, ...a: unknown[]) {
      c.statements++;
      if (String(typeof a[0] === 'string' ? a[0] : (a[0] as { text?: unknown } | null)?.text ?? '').includes('LEFT JOIN folder_grants')) c.trees++;
      return query.apply(this, a);
    };
    try {
      await W.call(who, 'projects:overview');
    } finally {
      proto.query = query;
    }
    if (!best || c.statements < best.statements) best = c;
  }
  return best!;
}

/** With the folder checks off: no folder code runs at all, the E2 tree's cost for an editor (less for a viewer). */
async function baseline(W: H.World, who: H.Person): Promise<Cost> {
  gate.setFolderChecksForTest(false);
  try {
    return await cost(W, who);
  } finally {
    gate.setFolderChecksForTest(true);
  }
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
