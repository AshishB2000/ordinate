// A Live dataset's source table facts in the Assistant's prompt, and kept current without a click
// (docs/assistant/00-design.md, step 3 "Table facts"; src/ai/tableFactsBlock.ts, src/ipc/askTableFacts.ts,
// src/ipc/sourceFactsRefresh.ts).
//
// 1. block (pure): the entry an editor reads (the table's name) and a viewer reads (the dataset's name, and no note
//    that holds the table's name); hidden columns left out (a key or partition with one hidden goes whole); no size for a
//    caller row access restricts; the line cap per table and the block's cap; nothing to say → no block, no ledger;
//    the figures are in the ledger.
// 2. prompt: through the real `copilot:ask` (the model stubbed, the whole prompt captured), from Home and with the Live
//    dataset open, the block is there for an editor with the table's name. A Live dataset whose doc has no facts, and
//    an extract, get none.
//    With DATABASE_URL, real roles (./rowPolicyHarness): the project viewer's prompt carries the structured facts under
//    the dataset's name and NEVER the table's name nor any editor-written text (planted notes naming the table by a bare
//    short name and by its schema), anywhere in it. NEGATIVE CONTROL: the editor's prompt has them all.
// 3. refresh: a SCHEDULED schema sync re-reads a stale doc's facts and not a fresh one's; a sync on demand reads none
//    (NEGATIVE CONTROL); a failing read keeps the stored facts and the job still succeeds; one sync reads at most
//    FACTS_PER_SYNC docs, stalest first.
//
// Without DATABASE_URL on the server-mode bench (./liveRouteHarness, signed in as an org admin); with it, on the
// row access world.
//
//   npm run build:ts && [DATABASE_URL=…] node scripts/test-tableFactsPrompt.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import * as RP from './rowPolicyHarness';
import type { TableFacts } from '../src/connectors/tableFacts';

const block: typeof import('../src/ai/tableFactsBlock') = require('../src/ai/tableFactsBlock');
const fakeMod: typeof import('./liveFakeConnector') = require('./liveFakeConnector');
const connections: typeof import('../src/connectors/connections') = require('../src/connectors/connections');
const liveRecord: typeof import('../src/data/liveRecord') = require('../src/data/liveRecord');
const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
const store: typeof import('../src/app/sourceTables') = require('../src/app/sourceTables');
const analyze: typeof import('../src/ai/analyze') = require('../src/ai/analyze');
const execConfig: typeof import('../src/app/execConfig') = require('../src/app/execConfig');
const syncJob: typeof import('../src/engine/live/schemaSyncJob') = require('../src/engine/live/schemaSyncJob');
const jobs: typeof import('../src/app/jobs') = require('../src/app/jobs');
const refresh: typeof import('../src/ipc/sourceFactsRefresh') = require('../src/ipc/sourceFactsRefresh');

const HOUR = 3_600_000;
const iso = (ms: number): string => new Date(ms).toISOString();
const TABLE = 'canary_sales_9f3';
const BARE = 'canary_returns_9f3';
const FRESH = 'canary_fresh_9f3';
const NOTE = 'Use order_date, not ship_date, for sales figures';
/** Editor text that names the table loosely: a bare short name, and a schema. No viewer may read either. */
const BARE_NOTE = 'Same rows as SALES9F3 in the old mart';
const SCHEMA_NOTE = 'Keep WH_MART_9F3 rows to two years';
const COLUMNS = [{ name: 'region', type: 'text' as const }, { name: 'order_date', type: 'date' as const }, { name: 'amount', type: 'number' as const }];
const ROWS = [['West', '2026-01-02', 5], ['East', '2026-02-03', 7]];
const FACTS = (rowEstimate: number): TableFacts => ({
  columns: COLUMNS.map((c) => ({ name: c.name, type: c.type })), primaryKey: { columns: ['region', 'order_date'], enforced: false },
  partition: { columns: ['order_date'], required: true }, clusterBy: ['region'], rowEstimate, lastModified: iso(Date.now() - 2.5 * HOUR),
});

// ── 1. The block ─────────────────────────────────────────────────────────────

function pure(): void {
  const now = Date.parse('2026-11-15T12:00:00Z');
  const facts: TableFacts = {
    columns: [], primaryKey: { columns: ['order_id'], enforced: true }, partition: { columns: ['order_date'], required: true },
    clusterBy: ['region', 'cost'], sortKey: ['order_date'], rowEstimate: 48_200_000, lastModified: '2026-11-15T09:30:00Z',
  };
  const entry: import('../src/ai/tableFactsBlock').TableFactsEntry = {
    table: 'ANALYTICS.SALES', dataset: 'Sales', nth: 1, of: 1, names: true, facts, hidden: new Set(), rows: true,
    notes: { requiredFilters: 'Keep ANALYTICS.SALES to the last two years', guide: NOTE, refresh: '' },
  };
  const ed = block.tableFactsBlock([entry], now);
  const lines = ed.text.split('\n').slice(3);
  ok('block: the editor reads the table, its size and age, key, partition, cluster, sort and notes', lines.join('\n') === [
    '- ANALYTICS.SALES (source table of "Sales" · ~48.2M rows · updated 2 h ago)',
    '    one row per order_id (the table\'s key)',
    '    partitioned by order_date (a filter on it is required)',
    '    clustered by region, cost',
    '    sorted by order_date',
    '    required filters (editor): "Keep ANALYTICS.SALES to the last two years"',
    '    editor note: "Use order_date, not ship_date, for sales figures"',
  ].join('\n'), ed.text);
  ok('block: its figures are in the ledger (the row estimate, the hours)', ed.ledger.some((e) => e.value === 48_200_000) && ed.ledger.some((e) => e.value === 2), JSON.stringify(ed.ledger));
  const viewer = block.tableFactsBlock([{ ...entry, names: false }], now).text;
  ok('block: a viewer reads the dataset\'s name for the table, and the same structured facts', viewer.includes('- "Sales", its source table (~48.2M rows · updated 2 h ago)') && viewer.includes('partitioned by order_date (a filter on it is required)') && viewer.includes('clustered by region, cost'), viewer);
  ok('NEGATIVE CONTROL: the viewer\'s block never names the table and carries no editor-written text', !/analytics\.sales/i.test(viewer) && !viewer.includes('(editor)') && !viewer.includes('editor note') && !viewer.includes(NOTE), viewer);
  ok('block: a viewer\'s second table of one dataset is told apart', block.tableFactsBlock([{ ...entry, names: false, nth: 2, of: 3 }], now).text.includes('- "Sales", source table 2 ('));
  const hidden = block.tableFactsBlock([{ ...entry, hidden: new Set(['order_id', 'cost', 'order_date']) }], now).text;
  ok('block: hidden columns: the key and partition they are part of go whole, a list loses only them, a note naming one goes', !/order_id|order_date|cost/.test(hidden) && !hidden.includes('partitioned') && hidden.includes('    clustered by region\n') && hidden.includes('required filters (editor)'), hidden);
  const closed = block.tableFactsBlock([{ ...entry, rows: false }], now).text;
  ok('block: no size for a caller row access rules restrict', !closed.includes('rows') && closed.includes('(source table of "Sales" · updated 2 h ago)'), closed);
  const many = block.tableFactsBlock([{ ...entry, notes: { ...entry.notes, refresh: 'Hourly' } }], now).text;
  ok(`block: at most ${block.TABLE_LINES} lines under a table`, many.split('\n').filter((l) => l.startsWith('    ')).length === block.TABLE_LINES && !many.includes('Hourly'), many);
  const long = block.tableFactsBlock([{ ...entry, notes: { requiredFilters: '', guide: 'x'.repeat(5000), refresh: '' } }], now).text;
  ok(`block: a note is cut to ${block.NOTE_MAX} characters, on one line`, long.includes(`"${'x'.repeat(block.NOTE_MAX)}…"`) && !long.includes('x'.repeat(block.NOTE_MAX + 1)));
  const twenty = block.tableFactsBlock(Array.from({ length: 20 }, (_, i) => ({ ...entry, table: `T${i}`, notes: { ...entry.notes, guide: 'y'.repeat(250) } })), now).text;
  const shownN = twenty.split('\n').filter((l) => l.startsWith('- T')).length;
  ok(`block: at most ${block.TABLE_FACTS_MAX} characters of tables, then "(more not shown)"`, shownN > 0 && shownN < 20 && twenty.endsWith('- (more source tables not shown)') && twenty.length < block.TABLE_FACTS_MAX + 600, `${shownN} shown, ${twenty.length} chars`);
  const empty = block.tableFactsBlock([{ ...entry, facts: { columns: [] }, notes: { requiredFilters: '', guide: '', refresh: '' } }], now);
  ok('block: a table with nothing to say: no block, no ledger', empty.text === '' && empty.ledger.length === 0 && block.tableFactsBlock([], now).text === '');
  ok('block: ages', block.ago(iso(now - 10 * 60_000), now) === 'under an hour ago' && block.ago(iso(now - 47 * HOUR), now) === '47 h ago' && block.ago(iso(now - 72 * HOUR), now) === '3 days ago' && block.ago('soon', now) === '');
}

// ── The bench both modes share ───────────────────────────────────────────────

interface Bench {
  P: string;
  /** Runs `fn` as an editor of the project (an org admin without a database). */
  as<T>(fn: () => Promise<T>): Promise<T>;
  /** `copilot:ask` as `who`; the whole prompt the model was handed. */
  ask(who: string, payload: object): Promise<{ reply: any; prompt: string }>;
}

let lastPrompt = '';
function stubModel(): void {
  (execConfig as { executionReady: unknown }).executionReady = async () => true;
  (analyze as { askCopilot: unknown }).askCopilot = async (prior: unknown, facts: string, q: string) => {
    lastPrompt = `${JSON.stringify(prior)}\n${facts}\n${q}`;
    return { ok: true, text: 'Fine.', suggestedAction: { kind: 'none', intent: '' } };
  };
}

interface Seeded { connId: string; sales: string; returns: string; fresh: string; salesDoc: string; freshDoc: string }

async function seed(b: Bench): Promise<Seeded> {
  return b.as(async () => {
    fakeMod.registerLiveFake();
    for (const t of [TABLE, BARE, FRESH]) await fakeMod.loadWarehouseTable(t, COLUMNS, ROWS as never);
    const conn = (await connections.saveConnection(b.P, { name: 'Warehouse', connectorId: fakeMod.LIVE_FAKE_ID, values: {} }))!;
    const live = async (name: string, table: string) => (await liveRecord.saveLiveRecord(b.P, { name, columns: COLUMNS, origin: { kind: 'connection', connId: conn.id, table } }))!.id;
    const [sales, returns, fresh] = [await live('Sales', TABLE), await live('Returns', BARE), await live('Fresh', FRESH)];
    const doc = async (table: string, patch: import('../src/app/sourceTables').SourcePatch) => {
      const made = await store.createSourceDoc(b.P, conn.id, table, patch);
      if (!made.ok) throw new Error('fixture: a source doc');
      return made.docId;
    };
    const salesDoc = await doc(TABLE, { guide: `${NOTE}. ${BARE_NOTE}`, requiredFilters: `${SCHEMA_NOTE}; filter ${TABLE}.order_date`, refresh: 'Hourly at :15' });
    await doc(BARE, { guide: 'Returns land nightly' }); // a doc never read: no facts
    const freshDoc = await doc(FRESH, {});
    await setFacts(b, conn.id, salesDoc, FACTS(48_200_000), Date.now());
    return { connId: conn.id, sales, returns, fresh, salesDoc, freshDoc };
  });
}

function setFacts(b: Bench, connId: string, docId: string, facts: TableFacts, readAt: number): Promise<unknown> {
  return b.as(() => store.updateSourceDoc(b.P, connId, docId, (d) => ({ ...d, facts: { ...facts, readAt: iso(readAt), readBy: 'ed@acme.test' } })));
}
const factsOf = (b: Bench, s: Seeded, docId: string) => b.as(async () => (await store.readSourceDoc(b.P, s.connId, docId))?.rec.facts);

// ── 2. The prompt ────────────────────────────────────────────────────────────

const HEAD = 'SOURCE TABLE FACTS';
const EDITOR_LINE = `- ${TABLE} (source table of "Sales" · ~48.2M rows · updated 2 h ago)`;

async function editorPrompt(b: Bench, s: Seeded, editor: string): Promise<string> {
  const home = await b.ask(editor, { context: { kind: '' }, question: 'sales by region' });
  ok('prompt: an editor\'s ask from Home answers', home.reply?.ok === true, JSON.stringify(home.reply).slice(0, 300));
  ok('prompt: from Home, the block names the table for an editor', home.prompt.includes(HEAD) && home.prompt.includes(EDITOR_LINE)
    && home.prompt.includes('    one row per region, order_date (the table\'s key, declared but not enforced)')
    && home.prompt.includes('    partitioned by order_date (a filter on it is required)')
    && home.prompt.includes(`    required filters (editor): "${SCHEMA_NOTE}; filter ${TABLE}.order_date"`)
    && home.prompt.includes(`    editor note: "${NOTE}. ${BARE_NOTE}"`)
    && home.prompt.includes('    refreshed (editor): "Hourly at :15"'), home.prompt.slice(home.prompt.indexOf(HEAD) - 10, home.prompt.indexOf(HEAD) + 900));
  ok('prompt: …once, and not for the Live dataset whose doc has no facts', home.prompt.split(EDITOR_LINE).length === 2 && !home.prompt.includes(BARE) && !home.prompt.includes('Returns land nightly'));
  const open = await b.ask(editor, { context: { kind: 'dataset', id: s.sales }, question: 'amount by region' });
  ok('prompt: with the Live dataset open, the block is there', open.reply?.ok === true && open.prompt.includes(EDITOR_LINE), open.prompt.slice(0, 400));
  const none = await b.ask(editor, { context: { kind: 'dataset', id: s.returns }, question: 'amount by region' });
  ok('prompt: a Live dataset whose doc has no facts: no block', none.reply?.ok === true && !none.prompt.includes(HEAD));
  return home.prompt;
}

// ── 3. The refresh ───────────────────────────────────────────────────────────

async function refreshes(b: Bench, s: Seeded): Promise<void> {
  const asked: string[] = [];
  fakeMod.fake.factsHook = async (_ctx, table) => {
    asked.push(table);
    return { ok: true, ...FACTS(777) };
  };
  const sync = async (id: string, scheduled: boolean) => {
    const st = await b.as(() => syncJob.startSchemaSync(b.P, id, scheduled ? { scheduled: true } : {}));
    if (st?.status !== 'queued') throw new Error(`fixture: a sync of ${id}: ${JSON.stringify(st)}`);
    const reply = await st.done;
    return { reply, job: jobs.snapshot().recent.find((j) => j.id === st.jobId) };
  };
  const t0 = Date.now();
  await setFacts(b, s.connId, s.salesDoc, FACTS(1), t0 - 13 * HOUR);
  await setFacts(b, s.connId, s.freshDoc, FACTS(2), t0 - HOUR);
  const onDemand = await sync(s.sales, false);
  ok('NEGATIVE CONTROL: a sync on demand reads no facts', onDemand.reply.ok === true && asked.length === 0 && (await factsOf(b, s, s.salesDoc))?.rowEstimate === 1, JSON.stringify(onDemand.reply).slice(0, 200));
  const stale = await sync(s.sales, true);
  const after = await factsOf(b, s, s.salesDoc);
  ok('refresh: the scheduled sync re-reads a stale doc\'s facts and stores them, stamped now', stale.reply.ok === true && asked.join() === TABLE && after?.rowEstimate === 777 && Date.parse(after.readAt) >= t0, JSON.stringify({ asked, after: after && { rows: after.rowEstimate, at: after.readAt } }));
  const fresh = await sync(s.fresh, true);
  const kept = await factsOf(b, s, s.freshDoc);
  ok('refresh: a doc read within the last 12 h is not read again', fresh.reply.ok === true && asked.join() === TABLE && kept?.rowEstimate === 2 && kept.readAt === iso(t0 - HOUR));

  fakeMod.fake.factsHook = async (_ctx, table) => {
    asked.push(table);
    return { ok: false, error: 'the warehouse is down' };
  };
  await setFacts(b, s.connId, s.salesDoc, FACTS(1), t0 - 30 * HOUR);
  const failing = await sync(s.sales, true);
  const old = await factsOf(b, s, s.salesDoc);
  ok('refresh: a failing read keeps the stored facts, and the job still succeeds', asked.length === 2 && failing.reply.ok === true && failing.job?.state === 'done' && old?.rowEstimate === 1 && old.readAt === iso(t0 - 30 * HOUR), JSON.stringify({ job: failing.job?.state, old: old?.readAt }));

  // One sync's bound, through the function the job calls: a Live dataset over a query that links eight documented tables.
  const linked = Array.from({ length: 8 }, (_, i) => `canary_link_${i}`);
  const many = await b.as(async () => {
    const id = (await liveRecord.saveLiveRecord(b.P, { name: 'Linked', columns: COLUMNS, origin: { kind: 'connection', connId: s.connId, sql: `SELECT * FROM ${TABLE}`, readsTables: linked } }))!.id;
    for (const [i, t] of linked.entries()) {
      const made = await store.createSourceDoc(b.P, s.connId, t, {});
      if (made.ok && i % 2 === 0) await store.updateSourceDoc(b.P, s.connId, made.docId, (d) => ({ ...d, facts: { ...FACTS(1), readAt: iso(t0 - (20 + i) * HOUR), readBy: 'x' } }));
    }
    return id;
  });
  asked.length = 0;
  fakeMod.fake.factsHook = async (_ctx, table) => {
    asked.push(table);
    return { ok: true, ...FACTS(5) };
  };
  const read = await b.as(() => refresh.refreshSourceFacts(b.P, many));
  ok(`refresh: one sync reads at most ${refresh.FACTS_PER_SYNC} docs, never-read first, then the stalest`, read === refresh.FACTS_PER_SYNC
    && asked.join() === ['canary_link_1', 'canary_link_3', 'canary_link_5', 'canary_link_7'].join(), asked.join());
  fakeMod.fake.factsHook = null;
}

// ── The two benches ──────────────────────────────────────────────────────────

async function withoutDatabase(): Promise<void> {
  const R: typeof import('./liveRouteHarness') = require('./liveRouteHarness');
  try {
    const P = await R.H.as(R.H.ORG_A, async () => {
      await R.H.projects.init();
      const pid = (await R.H.projects.createProject('Table facts')).id;
      await datasets.saveDataset(pid, { name: 'Orders copy', sourceKind: 'csv', columns: COLUMNS, rows: ROWS as never });
      return pid;
    });
    const b: Bench = {
      P,
      as: (fn) => R.H.as(R.H.ORG_A, fn),
      ask: async (_who, payload) => {
        lastPrompt = '';
        const r = await R.post('copilot:ask', { projectId: P, ...payload });
        return { reply: r.value, prompt: lastPrompt };
      },
    };
    const s = await seed(b);
    await editorPrompt(b, s, 'admin');
    await refreshes(b, s);
  } finally {
    await R.close();
  }
}

async function withDatabase(W: RP.World): Promise<void> {
  const b: Bench = {
    P: W.P,
    as: (fn) => W.as('boss', fn),
    ask: async (who, payload) => {
      lastPrompt = '';
      const r = await W.call(who, 'copilot:ask', { projectId: W.P, ...payload });
      return { reply: r.body, prompt: lastPrompt };
    },
  };
  const s = await seed(b);
  const edPrompt = await editorPrompt(b, s, 'ed');
  const viewer = await b.ask('nobody', { context: { kind: '' }, question: 'sales by region' });
  ok('prompt: the viewer\'s ask from Home answers, with the facts under the dataset\'s name', viewer.reply?.ok === true && viewer.prompt.includes('- "Sales", its source table (~48.2M rows · updated 2 h ago)')
    && viewer.prompt.includes('    partitioned by order_date (a filter on it is required)') && viewer.prompt.includes('    clustered by region'), viewer.prompt.slice(viewer.prompt.indexOf(HEAD), viewer.prompt.indexOf(HEAD) + 700));
  const open = await b.ask('nobody', { context: { kind: 'dataset', id: s.sales }, question: 'amount by region' });
  const leaks = (p: string): boolean => p.toLowerCase().includes(TABLE);
  // Every planted editor text, by a word only it holds (any case).
  const planted = ['sales9f3', 'wh_mart_9f3', 'ship_date', 'hourly at :15'];
  const notes = (p: string): string[] => planted.filter((w) => p.toLowerCase().includes(w));
  ok('NEGATIVE CONTROL: the viewer\'s whole prompt never names the table, nor holds any editor-written text (from Home, and with it open)', viewer.prompt.length > 0 && open.prompt.includes('"Sales", its source table')
    && !leaks(viewer.prompt) && !leaks(open.prompt) && notes(viewer.prompt).length === 0 && notes(open.prompt).length === 0, [...notes(viewer.prompt), ...notes(open.prompt)].join());
  ok('NEGATIVE CONTROL: the editor\'s prompt names the table and has every planted note', leaks(edPrompt) && notes(edPrompt).length === planted.length, notes(edPrompt).join());
  await refreshes(b, s);
}

(async () => {
  pure();
  stubModel();
  if (!process.env.DATABASE_URL) {
    await withoutDatabase();
    console.log('skip the viewer\'s prompt: DATABASE_URL is unset (roles need Postgres)');
    return;
  }
  const W = await RP.world('table facts in the prompt');
  if (!W) return;
  try {
    await withDatabase(W);
  } finally {
    await W.close();
  }
})()
  .catch((e) => ok('table facts suite ran to the end', false, e && e.stack ? e.stack : String(e)))
  .finally(finish);
