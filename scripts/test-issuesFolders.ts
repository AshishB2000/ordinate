// The issues board in the team-folders world (docs/issues-board/00-design.md, "Privacy"): the example questions follow #5's inbox rule, and an
// issue with ANY signal on a dataset or dashboard closed to the caller is not theirs to see, since its title and fix were written from every
// question of the group. An admin opens everything. Over scripts/folderHarness.ts.
//
//   npm run build:ts && DATABASE_URL=… node scripts/test-issuesFolders.js

export {}; // module scope — sibling test scripts share top-level names
import { randomUUID } from 'crypto';
import { ok, finish } from './selfcheck';
import * as F from './folderHarness';

const gate: typeof import('../src/server/authz/folderGate') = require('../src/server/authz/folderGate');
const store: typeof import('../src/server/issues/db') = require('../src/server/issues/db');
const weekly: typeof import('../src/server/issues/weekly') = require('../src/server/issues/weekly');

(async () => {
  const W = await F.world('issues folders');
  if (!W) return;
  try {
    if (!(await W.pool.query('SELECT 1 FROM folders LIMIT 1')).rowCount) await W.plantFolders();
    const P = W.P;
    const make = async (key: string, title: string, signals: Array<{ q: string; datasets?: string[]; dashboards?: string[]; ageDays?: number }>, namedFrom: { datasets?: string[]; dashboards?: string[] } = {}): Promise<string> => {
      const id = randomUUID();
      await W.pool.query(`INSERT INTO issues (org_id, id, project_id, key, kind, title, fix, named, name_dataset_ids, name_dashboard_ids) VALUES ('acme', $1, $2, $3, 'thumbs_down', $4, 'Fix it.', true, $5::jsonb, $6::jsonb)`,
        [id, P, key, title, JSON.stringify(namedFrom.datasets ?? []), JSON.stringify(namedFrom.dashboards ?? [])]);
      let n = 0;
      for (const s of signals) {
        await W.pool.query(`INSERT INTO issue_signals (org_id, project_id, turn_id, kind, issue_id, question, owner, dataset_ids, dashboard_ids, at) VALUES ('acme', $1, $2, 'thumbs_down', $3, $4, $5, $6::jsonb, $7::jsonb, now() - $8 * interval '1 day')`,
          [P, `t-${key}-${n++}`, id, s.q, `u${n}@acme.test`, JSON.stringify(s.datasets ?? []), JSON.stringify(s.dashboards ?? []), s.ageDays ?? 0]);
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

    // ── the wording outlives its signals ────────────────────────────────────────────────────────────────────────────────────
    // A title written from HR questions: the HR signal is gone (swept) but the ids the name was written from stay, so it is still hidden.
    const worded = await make('words:worded', 'HRCANARY wording', [{ q: 'Ops a?', datasets: [W.ops.ds] }, { q: 'Ops b?', datasets: [W.ops.ds] }, { q: 'Ops c?', datasets: [W.ops.ds] }], { datasets: [W.hr.ds, W.ops.ds] });
    const l1 = await list('opsLead');
    ok('NEGATIVE CONTROL: a title written from HR questions stays hidden from an editor closed to HR after those signals are gone (the ids it was written from count)', !ids(l1).includes(worded) && !l1.text.includes('HRCANARY wording'));
    ok('…and the project admin sees it', ids(await list('padmin')).includes(worded));
    const control = await make('words:worded-ok', 'Ops wording', [{ q: 'Ops a?', datasets: [W.ops.ds] }, { q: 'Ops b?', datasets: [W.ops.ds] }, { q: 'Ops c?', datasets: [W.ops.ds] }], { datasets: [W.ops.ds] });
    ok('control: the same shape named only from Ops is visible to that editor', ids(await list('opsLead')).includes(control));

    // The sweep: the oldest signal (HR) is past 90 days. The issue forgets its wording, is renamed from what is left, and is then open to them.
    const old = await make('words:swept', 'HRCANARY swept wording', [
      { q: 'HR bonus long ago?', datasets: [W.hr.ds], ageDays: 120 }, { q: 'Ops sweep a?', datasets: [W.ops.ds] }, { q: 'Ops sweep b?', datasets: [W.ops.ds] }, { q: 'Ops sweep c?', datasets: [W.ops.ds] },
    ], { datasets: [W.hr.ds, W.ops.ds] });
    ok('before the sweep it is hidden from the editor closed to HR', !ids(await list('opsLead')).includes(old));
    const swept = await W.as('padmin', () => weekly.checkProject(P, new Date()));
    ok('the sweep deleted the old signal', swept.swept === 1, JSON.stringify(swept));
    const after = (await W.pool.query(`SELECT title, fix, named, name_dataset_ids AS names FROM issues WHERE id = $1`, [old])).rows[0];
    ok('the issue that lost a signal forgot HR\'s wording, and was renamed from the signals that are left (the app\'s own words, no model here)', !after.title.includes('HRCANARY') && after.title !== '' && !JSON.stringify(after).includes(W.hr.ds) && after.names.length > 0 && !after.names.includes(W.hr.ds), JSON.stringify(after));
    const l2 = await list('opsLead');
    ok('and it is now open to the Ops editor, with no trace of HR', ids(l2).includes(old) && !l2.text.includes('HRCANARY') && !l2.text.includes('HR bonus'));
    ok('NEGATIVE CONTROL: an issue whose signals are all within 90 days keeps its title through a sweep', (await W.pool.query(`SELECT title FROM issues WHERE id = $1`, [control])).rows[0].title === 'Ops wording');
    await store.sweep('acme', P);
    ok('a sweep that deletes nothing resets nothing', (await W.pool.query(`SELECT named FROM issues WHERE id = $1`, [control])).rows[0].named === true);

    // A deleted dataset leaves no folder placement, which reads as open: with a folder in force it must read as closed.
    const gone = randomUUID();
    const ghost = await make('words:ghost', 'Ghost dataset questions', [{ q: 'Ghost a?', datasets: [gone] }, { q: 'Ghost b?', datasets: [W.ops.ds] }, { q: 'Ghost c?', datasets: [W.ops.ds] }]);
    ok('an issue with a signal on a dataset that no longer exists is hidden from a restricted editor (fail closed), not opened', !ids(await list('opsLead')).includes(ghost));
    ok('…and a gone dashboard likewise', !ids(await list('opsLead')).includes(await make('words:ghostboard', 'Ghost board questions', [{ q: 'gb a?', dashboards: [randomUUID()] }, { q: 'gb b?' }, { q: 'gb c?' }])));
    ok('control: the project admin, whom no folder restricts, still sees it', ids(await list('padmin')).includes(ghost));
    ok('control: an issue on an existing open dataset is visible (existence is not the only test)', ids(await list('opsLead')).includes(opsOnly));

    // ── one lookup per kind, however many issues ─────────────────────────────────────────────────────────────────────────────
    const lookups = async (): Promise<number> => {
      let n = 0;
      const real = gate.levelsOf;
      (gate as { levelsOf: unknown }).levelsOf = (...a: Parameters<typeof real>) => { n += 1; return real(...a); };
      try { await list('opsLead'); } finally { (gate as { levelsOf: unknown }).levelsOf = real; }
      return n;
    };
    const few = await lookups();
    for (let i = 0; i < 15; i += 1) await make(`words:bulk${i}`, `Bulk ${i}`, [{ q: `Bulk ${i} a?`, datasets: [W.ops.ds] }, { q: `Bulk ${i} b?`, datasets: [W.ops.ds] }, { q: `Bulk ${i} c?`, datasets: [W.ops.ds] }]);
    const many = await lookups();
    ok('the folder lookups per board load do not grow with the number of issues', few > 0 && many === few && many <= 4, `${few} → ${many}`);
    const bulk = (await list('opsLead')).body.issues as Array<{ id: string; examples: Array<{ question: string }> }>;
    ok('the board shows all 17 issues the editor may open', bulk.length >= 17, `${bulk.length}`);
    let same = true;
    for (const i of bulk.slice(0, 6)) {
      const one = (await store.examplesFor('acme', P, [i.id], 5)).map((e) => e.question);
      if (JSON.stringify(one) !== JSON.stringify(i.examples.map((e) => e.question))) same = false;
    }
    ok('the examples of the batched read are the same as one issue read alone, in the same order', same);
    ok('a viewer is refused', (await list('opsViewer')).status === 403);
  } finally {
    await W.close();
  }
  finish();
})().catch((e) => { console.error(e); process.exit(1); });
