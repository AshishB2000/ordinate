// The Assistant and MCP never see a hidden column (semantic layer part 4, D21), over the real RPC route, as real
// users in a scratch Postgres (scripts/columnAccessHarness.ts: *Staff* hides `salary`, `ssn` and `bonus` from `east`).
// The model is stubbed at its own boundary (`analyze.askCopilot`, as scripts/test-askDidYouMean.ts does) and every
// prompt it is sent is kept: the facts and the question, for the dataset, visual, dashboard and project contexts, and
// the narration of the answer chart it asks for.
//
// - No prompt sent for east carries an ssn value, a salary figure (the total, the mean, the largest), the salary
//   example or a hidden column's value label; the dataset facts do not name salary, and still hold dept.
//   NEGATIVE CONTROL: hr's dataset prompt carries the canary and the salary total.
// - MCP as east: list_metrics and the terms leave out what reads salary; aggregate over salary and query_sql over
//   Staff are refused. NEGATIVE CONTROL: hr's list_metrics names Payroll and its aggregate answers.
//
//   npm run build:ts && DATABASE_URL=… node scripts/test-columnFacts.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import * as C from './columnAccessHarness';
import * as H from './rowPolicyHarness';

const automation: typeof import('../src/automation/handlers') = require('../src/automation/handlers');
const fakeMod: typeof import('./liveFakeConnector') = require('./liveFakeConnector');
const connections: typeof import('../src/connectors/connections') = require('../src/connectors/connections');
const liveRecord: typeof import('../src/data/liveRecord') = require('../src/data/liveRecord');
const { SALARY_FIGURES, leaksHidden, stubModel, factsWorld } = C;

const BY_DEPT_SPEC = { dataset: 'Staff', category: 'dept', measures: [{ column: 'employee_id', aggregation: 'count' }] };

(async () => {
  const W = await C.columnWorld('column facts');
  if (!W) return finish();
  try {
    const { P, staff } = W;
    const { SALARY_V, DEPT_V, BOARD } = await factsWorld(W);
    // The table's key is a hidden column: the table notes name it, and say whether its values repeat.
    const keyed = await W.call('boss', 'catalog:setTable', { projectId: P, datasetId: staff, patch: { role: 'fact', key: 'ssn', guide: 'One row per person.' } });
    ok('setup: Staff\'s key is ssn', keyed.body?.ok === true, keyed.text.slice(0, 200));
    // A Live Staff, profiled from a sample: its facts are the profile's.
    fakeMod.registerLiveFake();
    const liveStaff = await W.as('boss', async () => {
      await fakeMod.loadWarehouseTable('cf_staff', C.STAFF_COLUMNS, C.STAFF_ROWS);
      const conn = await connections.saveConnection(P, { name: 'Fake', connectorId: fakeMod.LIVE_FAKE_ID, values: {} });
      return (await liveRecord.saveLiveRecord(P, { name: 'Staff (live)', columns: C.STAFF_COLUMNS, origin: { kind: 'connection', connId: conn!.id, table: 'cf_staff' } }))!.id;
    });
    await W.plant(liveStaff);
    ok('setup: the Live Staff is profiled', (await W.call('boss', 'dataset:syncLiveSchema', { projectId: P, datasetId: liveStaff })).body?.ok === true);
    const promptsAs = async (who: string, contexts: object[], spec: unknown = BY_DEPT_SPEC): Promise<{ prompts: string[]; replies: H.Reply[] }> => {
      const prompts: string[] = [];
      stubModel(prompts, spec);
      const replies: H.Reply[] = [];
      for (const context of contexts) replies.push(await W.call(who, 'copilot:ask', { projectId: P, context, question: 'tell me about pay' }));
      return { prompts, replies };
    };
    // The insights are computed over every column (a planted finding stands in for one about salary): never read for east.
    const insightsMod: typeof import('../src/ipc/insights') = require('../src/ipc/insights');
    const realInsights = insightsMod.listInsights;
    (insightsMod as { listInsights: unknown }).listInsights = async () => [{ id: 'planted', kind: 'outlier', severity: 'info', title: 'Planted', detail: `${C.SSN_CANARY}_9 stands out`, column: 'dept' }];
    const CONTEXTS = [{ kind: 'dataset', id: staff }, { kind: 'visual', id: SALARY_V }, { kind: 'visual', id: DEPT_V }, { kind: 'analysis', id: BOARD }, { kind: '' }, { kind: 'dataset', id: liveStaff }];
    const east = await promptsAs('east', CONTEXTS);
    ok('setup: east is answered in every context, with a chart narrated', east.replies.every((r) => r.body?.ok === true) && east.prompts.length === 2 * CONTEXTS.length, east.replies.map((r) => r.text.slice(0, 120)).join(' | '));
    const promptLeak = (p: string): string | null => leaksHidden(p) ?? (p.includes(C.NOTE) ? C.NOTE : null);
    const leak = east.prompts.map(promptLeak).find((x) => x !== null);
    ok('no prompt sent for east carries a hidden value, a figure made from one, its example, its note or its labels', !leak, `${leak} in ${east.prompts.find((p) => promptLeak(p))?.slice(0, 400)}`);
    ok('…nor names a hidden column in the dataset facts or the project inventory', ![east.prompts[0], east.prompts[8]].some((p) => /salary|ssn|bonus/i.test(p)), `${east.prompts[0].slice(0, 400)} || ${east.prompts[8]?.slice(0, 600)}`);
    ok('…nor the Live dataset\'s facts, which still hold its dept', !/salary|ssn|bonus/i.test(east.prompts[10]) && east.prompts[10]?.includes('dept'), east.prompts[10]?.slice(0, 600));
    ok('…which still lists Staff\'s other columns', /Staff: dept \(text/.test(east.prompts[8]) && east.prompts[8].includes('employee_id'), east.prompts[8]?.slice(0, 600));
    ok('the dataset facts for east still hold dept and the row count', east.prompts[0].includes('dept') && east.prompts[0].includes('12 rows'), east.prompts[0].slice(0, 300));
    ok('…and the Headcount metric, but not Payroll or the term on salary', east.prompts[0].includes('Headcount') && !east.prompts[0].includes('Payroll') && !east.prompts[0].includes('High earners'));
    ok('nothing east is answered carries a hidden value either', east.replies.every((r) => !leaksHidden(r.text)), east.replies.map((r) => leaksHidden(r.text)).join());
    const hr = await promptsAs('hr', [{ kind: 'dataset', id: staff }, { kind: 'dataset', id: liveStaff }]);
    ok('NEGATIVE CONTROL: hr\'s facts name the key, and the Live facts name salary and ssn (the detector withholds ssn\'s values from everyone)', /ssn/.test(hr.prompts[0]) && /- salary \(number/.test(hr.prompts[2] ?? '') && /- ssn \(text/.test(hr.prompts[2] ?? ''), hr.prompts[2]?.slice(0, 600));
    ok('NEGATIVE CONTROL: hr\'s dataset prompt carries the canary, a salary figure and the salary note', hr.prompts.some((p) => p.includes(C.SSN_CANARY)) && hr.prompts.some((p) => p.includes(C.NOTE)) && hr.prompts.some((p) => SALARY_FIGURES.some((f) => p.includes(f))), hr.prompts[0]?.slice(0, 400));
    ok('NEGATIVE CONTROL: …and hr\'s the planted finding (the insights are read for hr)', hr.prompts[0].includes(`${C.SSN_CANARY}_9`));
    (insightsMod as { listInsights: unknown }).listInsights = realInsights;
    const asked = await promptsAs('east', [{ kind: 'dataset', id: staff }], { ...BY_DEPT_SPEC, measures: [{ column: 'salary', aggregation: 'sum' }] });
    ok('an answer the model writes over salary draws no chart for east, and no narration is asked', asked.replies[0].body?.ok === true && asked.prompts.length === 1 && !leaksHidden(asked.replies[0].text), asked.replies[0].text.slice(0, 200));

    // ── MCP, as the token's user ─────────────────────────────────────────────
    const mcpCtx = { projectId: P, transport: 'http' as const, cwd: '/', headless: false, progress: () => undefined };
    const names = async (who: string, fn: (ctx: typeof mcpCtx) => Promise<unknown>): Promise<string[]> => ((await W.as(who, () => fn(mcpCtx))) as { name: string }[]).map((m) => m.name);
    ok('MCP as east: list_metrics leaves Payroll out and keeps Headcount', ((n) => !n.includes('Payroll') && n.includes('Headcount'))(await names('east', automation.metricsList)));
    ok('NEGATIVE CONTROL: hr\'s list_metrics names Payroll', (await names('hr', automation.metricsList)).includes('Payroll'));
    ok('MCP as east: the terms leave High earners out', !(await names('east', automation.termsList)).includes('High earners'));
    ok('NEGATIVE CONTROL: hr\'s terms name it', (await names('hr', automation.termsList)).includes('High earners'));
    const settle = (who: string, fn: () => Promise<unknown>) => W.as(who, fn).then((v) => ({ ok: true, text: JSON.stringify(v) }), (e: unknown) => ({ ok: false, text: String((e as Error)?.message ?? e) }));
    const aggregate = (who: string) => settle(who, () => automation.aggregate(mcpCtx, { dataset: 'Staff', encoding: { category: 'dept', values: [{ column: 'salary', aggregation: 'sum' }] } }));
    const agg = await aggregate('east');
    ok('MCP as east: aggregate over salary is refused', !agg.ok && !leaksHidden(agg.text), agg.text.slice(0, 200));
    ok('NEGATIVE CONTROL: hr\'s aggregate over salary answers', (await aggregate('hr')).ok);
    const sql = await settle('east', () => automation.query(mcpCtx, 'SELECT * FROM "Staff"', 50));
    ok('MCP as east: query_sql over Staff is refused', !sql.ok && !leaksHidden(sql.text), sql.text.slice(0, 200));
    ok('NEGATIVE CONTROL: hr\'s query_sql reads it', (await settle('hr', () => automation.query(mcpCtx, 'SELECT * FROM "Staff"', 50))).text.includes(C.SSN_CANARY));
  } finally {
    await W.close();
  }
  finish();
})().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
