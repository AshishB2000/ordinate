// Section 4's reach (docs/team-folders/00-design.md D9, D16, D17), E5's: a dataset closed to the caller but read by
// the published copy of a dashboard they open answers that dashboard's figures — never its rows, its grid, its profile
// or its list entry. Over ./folderHarness's world with its folders planted; run by ./folderNet after section 4's
// closed checks. Not a test file itself (no `test-` prefix).
//
// - finViewer (team Finance) reaches Orders (Ops) through the Finance board: the board's tiles, its chart, the rows
//   behind a mark, a control's values and the columns answer exactly as padmin's. NEGATIVE CONTROL: with reach off,
//   the board's tiles refuse `closed`.
// - every OPEN channel on Orders refuses finViewer `figures_only` (or `closed`, or answers as for an unknown id), and
//   dataset:list never names Orders to them; user SQL over Orders (sql:run, the Assistant's SQL answer even inside
//   Orders' figure scope) refuses `figures_only`. NEGATIVE CONTROL: with `figures_only` off, sql:run hands its rows.
// - HR shares no figures: the Everyone board's HR KPI refuses ed `closed`. NEGATIVE CONTROL: HR's switch on answers it
//   — and even then ed's grid on HR refuses `figures_only` and carries no canary row; with `figures_only` off, it does.
// - an older pod's write of the Finance board (its copy's `reads` without Orders: 0035's trigger) narrows reach on the
//   next request: the board's KPI refuses finViewer; republished, it answers again.
// - D16: ed publishing an Everyone board that newly reads HR refuses 409 `folder` / `publish`; padmin publishing it,
//   and ed republishing a board whose copy already read HR, do not.
// - a refresh of Orders reaches its reacher's stream (finViewer). NEGATIVE CONTROL: reach off, it does not.
// - cost: finViewer's tiles read dashboard_reads once per request (memoised), the rebuild once.

import { ok } from './selfcheck';
import * as H from './folderHarness';

const gate: typeof import('../src/server/authz/folderGate') = require('../src/server/authz/folderGate');
const sse: typeof import('../src/server/sse') = require('../src/server/sse');
const refreshEvents: typeof import('../src/data/refreshEvents') = require('../src/data/refreshEvents');
const reads: typeof import('../src/server/dashboardReads') = require('../src/server/dashboardReads');
type Person = H.Person;

const FIGURES_ONLY = (require('../src/server/authz/folders') as typeof import('../src/server/authz/folders')).folderRefusal('figures_only').error;
const short = (r: H.Reply): string => `${r.status} ${r.text.slice(0, 160)}`;
const email = (who: Person): string => `${who.toLowerCase()}@acme.test`;
async function seam<T>(set: (on: boolean) => void, fn: () => Promise<T>): Promise<T> {
  set(false);
  try {
    return await fn();
  } finally {
    set(true);
  }
}
async function until(cond: () => boolean, ms = 3000): Promise<boolean> {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 20))) if (cond()) return true;
  return cond();
}

/** `open`: the sweep's OPEN calls on HR; `toOps`, `unknown`: HR's ids → Ops's twins / random ids. */
export async function reachSection(W: H.World, open: Array<[string, string, unknown]>, toOps: Record<string, string>, unknown: Record<string, string>): Promise<void> {
  const { P, hr, ops } = W;
  const enc = { category: 'dept', values: [{ column: 'salary', aggregation: 'sum' }] };
  const tiles = { projectId: P, items: [{ kind: 'visual', datasetId: ops.ds, encoding: enc, chartType: 'bar' }, { kind: 'metric', datasetId: ops.ds, column: 'salary', aggregation: 'sum' }, { kind: 'metric', metricId: ops.metric, datasetId: ops.ds, column: 'salary', aggregation: 'sum' }] };
  const asks: Array<[string, string, unknown]> = [
    ['the board\'s tiles', 'analysis:tiles', tiles],
    ['its chart', 'visual:data', { projectId: P, datasetId: ops.ds, encoding: enc }],
    ['the rows behind a mark', 'visual:rows', { projectId: P, datasetId: ops.ds, encoding: enc, mark: { category: 'd1' } }],
    ['a control\'s values', 'dataset:distinct', { projectId: P, datasetId: ops.ds, column: 'dept' }],
    ['its columns', 'dataset:columns', { projectId: P, id: ops.ds }],
    ['its KPI', 'dashboard:metric', { projectId: P, datasetId: ops.ds, column: 'salary', aggregation: 'sum' }],
    ['a page of its charts', 'visual:dataBatch', { projectId: P, items: [{ datasetId: ops.ds, encoding: enc }] }],
    ['a drill into a mark', 'visual:drillDown', { projectId: P, datasetId: ops.ds, encoding: { ...enc, category: 'person' }, mark: { category: 'p_1' } }],
  ];
  const differ: string[] = [];
  for (const [label, ch, payload] of asks) {
    const [mine, theirs] = [await W.call('finViewer', ch, payload), await W.call('padmin', ch, payload)];
    if (H.refused(mine) || H.stable(mine) !== H.stable(theirs)) differ.push(`${label}: ${short(mine)} | ${short(theirs)}`);
  }
  ok(`reach: finViewer reaches Orders through the Finance board — each of ${asks.length} figure calls answers exactly as padmin's`, differ.length === 0, differ.join('\n'));
  const blocked = await seam(gate.setReachForTest, () => W.call('finViewer', 'analysis:tiles', tiles));
  ok('NEGATIVE CONTROL: with reach off, the Finance board\'s tiles refuse finViewer `closed`', H.refused(blocked), short(blocked));

  const backOps = Object.fromEntries(Object.entries(unknown).map(([h, r]) => [r, toOps[h] ?? h]));
  const leaked: string[] = [];
  let figuresOnly = 0;
  for (const [label, ch, payload] of open) {
    const mine = await W.call('finViewer', ch, H.swapped(payload, toOps));
    if (H.refused(mine, 'figures_only') || (mine.text.includes('"code":"folder"') && mine.text.includes(FIGURES_ONLY))) figuresOnly++;
    else if (!H.refused(mine)) {
      const missing = await W.call('finViewer', ch, H.swapped(payload, unknown));
      if (H.stable(mine) !== H.stable({ ...missing, body: H.swapped(missing.body, backOps) })) leaked.push(`${label}: ${short(mine)}`);
    }
  }
  ok(`reach: each of ${open.length} OPEN channels on Orders refuses finViewer \`figures_only\` (${figuresOnly}) or \`closed\`, or answers as for an unknown id`, open.length > 10 && figuresOnly > 0 && leaked.length === 0, leaked.join('\n'));
  // The SQL lane is OPEN-class: user SQL over Orders reads no row of it — the Query tab's statement, and the Assistant's
  // SQL answer (and a verified SQL question's, the same runner) even inside Orders' figure scope, where the net hands it through.
  const orders = 'SELECT person FROM "Orders"';
  const ROWS = /\bp_\d\b/;
  const sql = await W.call('finViewer', 'sql:run', { projectId: P, sql: orders });
  ok('reach: SQL over Orders (sql:run) refuses finViewer `figures_only`, with no row of it', sql.body?.ok !== true && sql.text.includes(FIGURES_ONLY) && !ROWS.test(sql.text), short(sql));
  const answerSql: typeof import('../src/ipc/answerSql') = require('../src/ipc/answerSql');
  const scoped = await W.as('finViewer', () => gate.inReach(P, ops.ds, () => answerSql.runAnswerSql(P, orders, null, 'Orders')));
  ok('reach: the Assistant\'s SQL answer over Orders refuses finViewer `figures_only` even inside Orders\' figure scope', !scoped.ok && scoped.reason === FIGURES_ONLY && !ROWS.test(JSON.stringify(scoped)), JSON.stringify(scoped).slice(0, 200));
  const leakedSql = await seam(gate.setFiguresOnlyForTest, () => W.call('finViewer', 'sql:run', { projectId: P, sql: orders }));
  ok('NEGATIVE CONTROL: with `figures_only` off, sql:run hands finViewer Orders\' rows', leakedSql.body?.ok === true && ROWS.test(leakedSql.text), short(leakedSql));
  const listed = async (who: Person) => (await W.call(who, 'dataset:list', { projectId: P })).text.includes(ops.ds);
  ok('reach: dataset:list never names Orders to finViewer (NEGATIVE CONTROL: opsViewer\'s does)', !(await listed('finViewer')) && (await listed('opsViewer')));

  // HR shares no figures: the Everyone board's KPI on it is closed to ed, an editor of Everyone.
  const hrKpi = { projectId: P, datasetId: hr.ds, column: 'salary', aggregation: 'sum' };
  const shut = await W.call('ed', 'dashboard:metric', hrKpi);
  ok('reach: the Everyone board\'s KPI on HR refuses ed `closed` — HR shares no figures', H.refused(shut) && !H.CANARY.test(shut.text), short(shut));
  const share = (on: boolean) => W.pool.query('UPDATE folders SET share_figures = $1 WHERE org_id = $2 AND id = $3', [on, 'acme', W.folders.hr]);
  await share(true);
  try {
    const shown = await W.call('ed', 'dashboard:metric', hrKpi);
    ok('NEGATIVE CONTROL: HR\'s switch on, the same KPI answers ed', shown.status === 200 && !H.refused(shown) && shown.body?.ok === true, short(shown));
    const grid = { projectId: P, datasetId: hr.ds, offset: 0, limit: 200 };
    const page = await W.call('ed', 'dataset:page', grid);
    ok('reach: even then ed\'s grid on HR refuses `figures_only`, no canary row in it', H.refused(page, 'figures_only') && !H.CANARY.test(page.text), short(page));
    const rows = await seam(gate.setFiguresOnlyForTest, () => W.call('ed', 'dataset:page', grid));
    ok('NEGATIVE CONTROL: with `figures_only` off, the grid hands ed HR\'s canary rows', /HRCANARY_\d/.test(rows.text), short(rows));
  } finally {
    await share(false);
  }
  ok('reach: HR\'s switch off again, the KPI refuses ed on the next request (nothing cached)', H.refused(await W.call('ed', 'dashboard:metric', hrKpi)));

  // An older pod's write (no `ordinate.folders`): the Finance board's copy without Orders in its reads.
  const kpi = { projectId: P, datasetId: ops.ds, column: 'salary', aggregation: 'sum' };
  const rel = `projects/${P}/analyses/${W.reach.finBoard}.json`;
  const body = JSON.parse((await W.pool.query<{ body: string }>('SELECT body FROM records WHERE org_id = $1 AND path = $2', ['acme', rel])).rows[0].body);
  ok('setup: the Finance board\'s copy recorded Orders in its reads', JSON.stringify(body.published?.reads) === JSON.stringify([ops.ds.toLowerCase()]), JSON.stringify(body.published?.reads));
  await W.pool.query('UPDATE records SET body = $1 WHERE org_id = $2 AND path = $3', [JSON.stringify({ ...body, published: { ...body.published, reads: [] } }), 'acme', rel]);
  const narrowed = await W.call('finViewer', 'dashboard:metric', kpi);
  ok('reach: an older pod\'s write of the board, its reads without Orders, refuses finViewer the KPI on the next request (the trigger dropped its rows)', H.refused(narrowed), short(narrowed));
  ok('setup: padmin republishes the Finance board', (await W.call('padmin', 'analysis:publish', { projectId: P, id: W.reach.finBoard })).body?.ok === true);
  const back = await W.call('finViewer', 'dashboard:metric', kpi);
  ok('reach: republished, the KPI answers finViewer again', !H.refused(back) && back.body?.ok === true, short(back));

  // D16: Publish may not start sharing a dataset the publisher cannot open.
  const card = { id: '4f1f0c3e-7a40-4a3a-9b5e-1d2c3b4a5f60', type: 'metric', layout: { x: 0, y: 0, w: 4, h: 3 }, metric: { datasetId: hr.ds, column: 'salary', aggregation: 'sum', label: 'New total' } };
  const made = await W.call('ed', 'analysis:create', { projectId: P, name: 'Ed board', sheets: [{ name: 'One', cards: [card] }] });
  const edBoard = String(made.body?.id ?? made.body?.analysis?.id ?? '');
  const refusedPublish = await W.call('ed', 'analysis:publish', { projectId: P, id: edBoard });
  ok('D16: ed publishing an Everyone board that newly reads HR refuses 409 `folder` / `publish`, naming nothing', H.refused(refusedPublish, 'publish') && !H.CANARY.test(refusedPublish.text), short(refusedPublish));
  ok('NEGATIVE CONTROL: padmin publishes the same board', (await W.call('padmin', 'analysis:publish', { projectId: P, id: edBoard })).body?.ok === true);
  const again = await W.call('ed', 'analysis:publish', { projectId: P, id: W.reach.everyoneBoard });
  ok('D16: ed republishing the Everyone board, whose copy already read HR, is not refused', again.body?.ok === true, short(again));
  await W.call('padmin', 'analysis:delete', { projectId: P, id: edBoard });

  // Pushes (E3's note): a refresh of Orders reaches its reachers too.
  const seen: Array<{ user: string; channel: string }> = [];
  sse.setFanOut((t, channel) => { if (t.user) seen.push({ user: t.user, channel }); });
  try {
    const refreshed = () => W.as('boss', async () => refreshEvents.announceRefreshed({ projectId: P, datasetId: ops.ds, name: 'Orders', rowsBefore: 1, rowsAfter: 2 }));
    const got = (who: Person) => seen.some((s) => s.user === email(who) && s.channel === 'hub:dataset-refreshed');
    await refreshed();
    await until(() => got('opsViewer') && got('finViewer'));
    ok('pushes: a refresh of Orders reaches its openers and its reacher finViewer, never ed', got('opsViewer') && got('finViewer') && !got('ed'), JSON.stringify(seen));
    seen.length = 0;
    await seam(gate.setReachForTest, async () => { await refreshed(); await until(() => got('opsViewer')); });
    ok('NEGATIVE CONTROL: with reach off, finViewer\'s stream does not get it', got('opsViewer') && !got('finViewer'), JSON.stringify(seen));
  } finally {
    sse.setFanOut(null);
  }

  // Cost: one dashboard_reads statement per request, the rebuild once.
  const builds = reads.rebuildCount();
  const { Client } = require('pg') as typeof import('pg');
  const proto = Client.prototype as unknown as { query: (...a: unknown[]) => unknown };
  const query = proto.query;
  let reachReads = 0;
  proto.query = function (this: unknown, ...a: unknown[]) {
    if (String(typeof a[0] === 'string' ? a[0] : (a[0] as { text?: unknown } | null)?.text ?? '').includes('FROM dashboard_reads r')) reachReads++;
    return query.apply(this, a);
  };
  try {
    await W.call('finViewer', 'analysis:tiles', tiles);
  } finally {
    proto.query = query;
  }
  ok(`cost: finViewer's three tiles on Orders read dashboard_reads once (${reachReads}), and nothing rebuilt it`, reachReads === 1 && reads.rebuildCount() === builds, `${reachReads} reads, ${reads.rebuildCount() - builds} rebuilds`);
}
