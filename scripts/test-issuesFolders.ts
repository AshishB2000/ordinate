// The issues board in the team-folders world (docs/issues-board/00-design.md, "Privacy"): the example questions follow #5's inbox rule, and an
// issue with ANY signal on a dataset or dashboard closed to the caller is not theirs to see, since its title and fix were written from every
// question of the group. An admin opens everything. Over scripts/folderHarness.ts.
//
//   npm run build:ts && DATABASE_URL=… node scripts/test-issuesFolders.js

export {}; // module scope — sibling test scripts share top-level names
import { randomUUID } from 'crypto';
import { ok, finish } from './selfcheck';
import * as F from './folderHarness';

(async () => {
  const W = await F.world('issues folders');
  if (!W) return;
  try {
    if (!(await W.pool.query('SELECT 1 FROM folders LIMIT 1')).rowCount) await W.plantFolders();
    const P = W.P;
    const make = async (key: string, title: string, signals: Array<{ q: string; datasets?: string[]; dashboards?: string[] }>): Promise<string> => {
      const id = randomUUID();
      await W.pool.query(`INSERT INTO issues (org_id, id, project_id, key, kind, title, fix, named) VALUES ('acme', $1, $2, $3, 'thumbs_down', $4, 'Fix it.', true)`, [id, P, key, title]);
      let n = 0;
      for (const s of signals) {
        await W.pool.query(`INSERT INTO issue_signals (org_id, project_id, turn_id, kind, issue_id, question, owner, dataset_ids, dashboard_ids, at) VALUES ('acme', $1, $2, 'thumbs_down', $3, $4, $5, $6::jsonb, $7::jsonb, now())`,
          [P, `t-${key}-${n++}`, id, s.q, `u${n}@acme.test`, JSON.stringify(s.datasets ?? []), JSON.stringify(s.dashboards ?? [])]);
      }
      return id;
    };
    const opsOnly = await make('words:ops', 'Ops numbers struggle', [{ q: 'Ops one?', datasets: [W.ops.ds] }, { q: 'Ops two?', datasets: [W.ops.ds] }, { q: 'Ops three?', datasets: [W.plain] }]);
    const mixed = await make('words:mixed', 'HRCANARY bonus questions', [{ q: 'HRCANARY bonus of Jo?', datasets: [W.hr.ds] }, { q: 'Ops again?', datasets: [W.ops.ds] }, { q: 'Plain again?', datasets: [] }]);
    const board = await make('words:board', 'HR board questions', [{ q: 'On the HR board?', dashboards: [W.hr.board] }, { q: 'x?', datasets: [] }, { q: 'y?', datasets: [] }]);
    const list = async (who: F.Person) => (await W.call(who, 'issues:list', { projectId: P }));
    const ids = (r: F.Reply) => (r.body.issues as Array<{ id: string }>).map((i) => i.id).sort().join();
    const padmin = await list('padmin');
    ok('the project admin opens every folder: all three issues, all their examples', padmin.body.ok && ids(padmin) === [opsOnly, mixed, board].sort().join() && padmin.body.issues.find((i: { id: string }) => i.id === mixed).examples.length === 3, padmin.text.slice(0, 300));
    const lead = await list('opsLead');
    ok('NEGATIVE CONTROL: an editor closed to HR sees the Ops issue only: the one that touches HR\'s dataset and the one on HR\'s board are gone', ids(lead) === opsOnly, ids(lead));
    ok('nothing of the HR issues reaches that editor: no title, no question, no count', !lead.text.includes('HRCANARY') && !lead.text.includes('HR board') && !lead.text.includes('bonus of Jo'));
    ok('the Ops issue\'s examples are all open to them', lead.body.issues[0].examples.length === 3);
    for (const id of [mixed, board]) {
      const r = await Promise.all([W.call('opsLead', 'issues:setStatus', { projectId: P, id, status: 'ignored' }), W.call('opsLead', 'issues:propose', { projectId: P, id }), W.call('opsLead', 'issues:send', { projectId: P, id, provider: 'linear' })]);
      ok('an issue closed to them is "not found" for status, propose and send, as if it did not exist', r.every((x) => x.body?.ok === false && x.body.error === (r[0].body.error as string)), JSON.stringify(r.map((x) => x.body)));
    }
    ok('…and it was not changed', (await W.pool.query(`SELECT count(*)::int AS n FROM issues WHERE status <> 'open'`)).rows[0].n === 0);
    ok('the editor may work the Ops issue', (await W.call('opsLead', 'issues:setStatus', { projectId: P, id: opsOnly, status: 'resolved' })).body?.ok === true);
    ok('a viewer is refused', (await list('opsViewer')).status === 403);
  } finally {
    await W.close();
  }
  finish();
})().catch((e) => { console.error(e); process.exit(1); });
