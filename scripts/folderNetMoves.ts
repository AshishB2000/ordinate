// Section 11 of the folder safety net (docs/team-folders/00-design.md, E7): the folder channels themselves, over the
// real route in the net's world (./folderHarness). Not a test file itself: ./folderNet runs it last.
//
//   - a non-admin cannot make a top-level folder, and a viewer (or an editor) cannot grant one;
//     NEGATIVE CONTROLS: the project admin can;
//   - moving Orders to HR: the warning lists Ops and Ops leads as losing it, and the Finance board's reach as stopping
//     (HR shares no figures); a move with the warning's hash after a grant changed refuses `move_changed`, nothing moved;
//   - the move's reach change is EXACTLY what the warning said: per person, who could open Orders before and after (by
//     folder:of over the route, on the next request — no cache to clear) differs by the warning's people, and finViewer's
//     reach goes as it said; NEGATIVE CONTROL: moving it back reopens it to the same people.

import { randomUUID } from 'crypto';
import { ok } from './selfcheck';
import * as H from './folderHarness';

const gate: typeof import('../src/server/authz/folderGate') = require('../src/server/authz/folderGate');
const move: typeof import('../src/server/authz/folderMove') = require('../src/server/authz/folderMove');

const short = (r: H.Reply): string => `${r.status} ${r.text.slice(0, 200)}`;
const okReply = (r: H.Reply): boolean => r.status === 200 && r.body?.ok === true;
const email = (who: H.Person): string => `${who.toLowerCase()}@acme.test`;

export async function moveSection(W: H.World): Promise<void> {
  const { P, call } = W;
  const F = W.folders;
  const orders = W.ops.ds;

  const top = await call('opsLead', 'folder:create', { projectId: P, parentId: null, name: `Leads ${randomUUID().slice(0, 6)}` });
  ok('11. a project editor cannot make a top-level folder', top.status === 200 && top.body?.ok === false, short(top));
  const made = await call('padmin', 'folder:create', { projectId: P, parentId: null, name: `Net ${randomUUID().slice(0, 6)}` });
  ok('NEGATIVE CONTROL: the project admin can', okReply(made), short(made));
  const grant = (who: H.Person, level: 'view' | null) => call(who, 'folder:grant', { projectId: P, folderId: String(made.body?.folder?.id), teamId: W.teams.ops, level });
  ok('11. a viewer and an editor cannot grant a folder (403)', (await grant('opsViewer', 'view')).status === 403 && (await grant('opsLead', 'view')).status === 403);
  ok('NEGATIVE CONTROL: the project admin can, and take it back', okReply(await grant('padmin', 'view')) && okReply(await grant('padmin', null)));
  await call('padmin', 'folder:delete', { projectId: P, folderId: String(made.body?.folder?.id) });

  // Who opens Orders, person by person, over the route: folder:of is `closed` for an item that exists where they can't.
  const opensOrders = async (): Promise<Set<string>> => {
    const out = new Set<string>();
    for (const who of H.PEOPLE) if ((await call(who, 'folder:of', { projectId: P, kind: 'dataset', id: orders })).body?.ok === true) out.add(email(who));
    return out;
  };
  const finReaches = () => W.as('finViewer', () => gate.reaches(P, orders));
  const items = [{ kind: 'dataset' as const, id: orders }];

  const before = await opensOrders();
  const reachedBefore = await finReaches();
  const warning = await call('padmin', 'folder:moveImpact', { projectId: P, items, to: F.hr });
  const teams = (warning.body?.lose ?? []).map((g: { team: string | null }) => g.team).sort();
  ok('11. the warning for Orders → HR lists Ops and Ops leads as losing it, and names no address', JSON.stringify(teams) === '["Ops","Ops leads"]' && !warning.text.includes('@'), short(warning));
  ok('11. …and says the Finance board showing Orders stops showing it (HR shares no figures)', warning.body?.reachers?.dashboards >= 1 && warning.body.reachers.keeps === false, JSON.stringify(warning.body?.reachers));
  const said = await W.as('padmin', () => move.impactOf(P, { items, to: F.hr }));
  if (!said.ok) throw new Error(`impact: ${said.error}`);

  await call('padmin', 'folder:grant', { projectId: P, folderId: F.hr, teamId: W.teams.fin, level: 'view' });
  const stale = await call('padmin', 'folder:move', { projectId: P, items, to: F.hr, hash: warning.body.hash });
  ok('11. after a grant changed who opens HR, the warning\'s hash refuses `move_changed`', H.refused(stale, 'move_changed'), short(stale));
  ok('11. …and nothing moved', JSON.stringify([...(await opensOrders())].sort()) === JSON.stringify([...before].sort()));
  await call('padmin', 'folder:grant', { projectId: P, folderId: F.hr, teamId: W.teams.fin, level: null });

  const moved = await call('padmin', 'folder:move', { projectId: P, items, to: F.hr, hash: warning.body.hash }); // access is back as warned
  ok('11. with access as it was warned, the same hash moves it', okReply(moved) && moved.body.moved === 1, short(moved));
  const after = await opensOrders();
  const lost = [...before].filter((e) => !after.has(e)).sort();
  const gained = [...after].filter((e) => !before.has(e)).sort();
  const detail = said.detail[0];
  ok('11. who lost Orders is exactly who the warning said, on the next request', JSON.stringify(lost) === JSON.stringify([...detail.lose].sort()) && lost.includes(email('opsViewer')), `${lost.join(',')} vs ${detail.lose.join(',')}`);
  ok('11. who gained it is exactly who the warning said (nobody)', JSON.stringify(gained) === JSON.stringify([...detail.gain].sort()), gained.join(','));
  ok('11. the warning\'s head counts add up to those people (no one is in both teams with a project role)', said.impact.lose.reduce((n, g) => n + g.people, 0) === lost.length, JSON.stringify(said.impact.lose));
  const reachedAfter = await finReaches();
  ok('11. finViewer\'s reach of Orders through the Finance board goes, as the warning said', reachedBefore === true && reachedAfter === false);
  const listed = async () => ((await call('opsViewer', 'dataset:list', { projectId: P })).body as Array<{ id: string }>).some((d) => d.id === orders);
  ok('11. opsViewer\'s data list no longer has Orders', !(await listed()));

  const home = await call('padmin', 'folder:moveImpact', { projectId: P, items, to: F.ops });
  const back = await call('padmin', 'folder:move', { projectId: P, items, to: F.ops, hash: home.body?.hash });
  const reopened = await opensOrders();
  ok('NEGATIVE CONTROL: moving it back reopens it to exactly the people it had, in their lists too', okReply(back) && JSON.stringify([...reopened].sort()) === JSON.stringify([...before].sort()) && (await finReaches()) === true && (await listed()), short(back));
}
