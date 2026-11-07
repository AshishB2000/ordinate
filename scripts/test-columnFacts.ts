// The Assistant and MCP never see a hidden column (semantic layer part 4, D21), over the real RPC route, as real
// users in a scratch Postgres (scripts/columnAccessHarness.ts: *Staff* hides `salary`, `ssn` and `bonus` from `east`).
// The model is stubbed at its own boundary (`analyze.askCopilot`, as scripts/test-askDidYouMean.ts does) and every
// prompt it is sent is kept: the facts and the question, for the dataset, visual, dashboard and project contexts, and
// the narration of the answer chart it asks for.
//
// - No prompt sent for east carries an ssn value, a salary figure (the total, the mean, the largest), the salary
//   example or a hidden column's value label; the dataset facts do not name salary, and still hold dept.
//   NEGATIVE CONTROL: hr's dataset prompt carries the canary and the salary total.
// - A drill hierarchy with a hidden level (dept › ssn) is in none of east's dataset, visual or Live facts (ai/hiddenFacts
//   tableWithout). NEGATIVE CONTROL: hr's name it in each.
// - A copy's sample values (part 3, its value index) skip a hidden column even inside the dataset branch's checked
//   scope: dept's for east, never ssn's. NEGATIVE CONTROL: hr's list ssn's.
// - Verified questions (part 3): one over salary is no example in east's prompt and does not answer east word for
//   word (ipc/verifiedState leaves it out); one over dept does both. NEGATIVE CONTROL: hr gets the salary one.
// - A topic (part 6) listing ssn, salary, Payroll and the term on salary: east's topic facts and MCP list_topics name
//   none of them, and keep dept and Headcount. NEGATIVE CONTROL: hr's name them.
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
const datasetsMod: typeof import('../src/data/datasets') = require('../src/data/datasets');
const searchIdx: typeof import('../src/engine/dataSearchResident') = require('../src/engine/dataSearchResident');
const copyValues: typeof import('../src/ipc/copyValues') = require('../src/ipc/copyValues');
const rowAccessMod: typeof import('../src/data/rowAccess') = require('../src/data/rowAccess');
const { tablePath }: typeof import('../src/data/datasetRecord') = require('../src/data/datasetRecord');
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
    const tree = async (id: string) => (await W.call('boss', 'catalog:setTable', { projectId: P, datasetId: id, patch: { hierarchies: [{ name: 'Who tree', levels: ['dept', 'ssn'] }] } })).body?.ok === true;
    ok('setup: Staff and the Live Staff drill dept › ssn', (await tree(staff)) && (await tree(liveStaff)));
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
    // A copy's sample values come from its value index (part 3, p3-04): built now, so a hidden text column's values
    // would reach east's dataset facts if they were not skipped.
    const built = await W.as('boss', async () => {
      const meta = (await datasetsMod.getDatasetMeta(P, staff))!;
      return !!meta.resident && searchIdx.writeIndex({ parquetPath: tablePath(P, staff, meta.storageVersion), columns: meta.columns });
    });
    ok('setup: Staff is resident and has its value index', built === true);
    // copyValueNotes itself skips a hidden column, even inside the dataset branch's checked scope, where the net
    // that would refuse east the whole table is opened (ai/hiddenFacts factsOf).
    const notesAs = (who: string) => W.as(who, () => rowAccessMod.withColumnsChecked(new Set([staff]), () => copyValues.copyValueNotes(P, staff, 'facts')));
    const eastNotes = await notesAs('east');
    ok("a copy's sample values for east: dept's, never ssn's", !!eastNotes?.dept?.includes('"Ops"') && !('ssn' in (eastNotes ?? {})) && !JSON.stringify(eastNotes).includes(C.SSN_CANARY), JSON.stringify(eastNotes));
    ok("NEGATIVE CONTROL: hr's list ssn's values", !!(await notesAs('hr'))?.ssn?.includes(C.SSN_CANARY));
    const east = await promptsAs('east', CONTEXTS);
    ok('setup: east is answered in every context, with a chart narrated', east.replies.every((r) => r.body?.ok === true) && east.prompts.length === 2 * CONTEXTS.length, east.replies.map((r) => r.text.slice(0, 120)).join(' | '));
    const promptLeak = (p: string): string | null => leaksHidden(p) ?? (p.includes(C.NOTE) ? C.NOTE : null);
    const leak = east.prompts.map(promptLeak).find((x) => x !== null);
    ok('no prompt sent for east carries a hidden value, a figure made from one, its example, its note or its labels', !leak, `${leak} in ${east.prompts.find((p) => promptLeak(p))?.slice(0, 400)}`);
    ok('…nor names a hidden column in the dataset facts or the project inventory', ![east.prompts[0], east.prompts[8]].some((p) => /salary|ssn|bonus/i.test(p)), `${east.prompts[0].slice(0, 400)} || ${east.prompts[8]?.slice(0, 600)}`);
    ok('…nor the Live dataset\'s facts, which still hold its dept', !/salary|ssn|bonus/i.test(east.prompts[10]) && east.prompts[10]?.includes('dept'), east.prompts[10]?.slice(0, 600));
    ok('…nor a hierarchy with a hidden level, in the dataset, visual or Live facts', [0, 4, 10].every((i) => !/Who tree|ssn/.test(east.prompts[i] ?? '')),
      [0, 4, 10].map((i) => east.prompts[i]?.match(/.{0,80}(Who tree|ssn).{0,40}/)?.[0]).join(' | '));
    ok('…which still lists Staff\'s other columns', /Staff: dept \(text/.test(east.prompts[8]) && east.prompts[8].includes('employee_id'), east.prompts[8]?.slice(0, 600));
    ok('the dataset facts for east still hold dept and the row count', east.prompts[0].includes('dept') && east.prompts[0].includes('12 rows'), east.prompts[0].slice(0, 300));
    ok('…and the Headcount metric, but not Payroll or the term on salary', east.prompts[0].includes('Headcount') && !east.prompts[0].includes('Payroll') && !east.prompts[0].includes('High earners'));
    ok('nothing east is answered carries a hidden value either', east.replies.every((r) => !leaksHidden(r.text)), east.replies.map((r) => leaksHidden(r.text)).join());
    const hr = await promptsAs('hr', [{ kind: 'dataset', id: staff }, { kind: 'dataset', id: liveStaff }, { kind: 'visual', id: DEPT_V }]);
    ok('NEGATIVE CONTROL: hr\'s dataset, Live and visual facts name the hierarchy', [0, 2, 4].every((i) => /Who tree/.test(hr.prompts[i] ?? '')), [0, 2, 4].map((i) => hr.prompts[i]?.slice(0, 120)).join(' | '));
    ok('NEGATIVE CONTROL: hr\'s facts name the key, and the Live facts name salary and ssn (the detector withholds ssn\'s values from everyone)', /ssn/.test(hr.prompts[0]) && /- salary \(number/.test(hr.prompts[2] ?? '') && /- ssn \(text/.test(hr.prompts[2] ?? ''), hr.prompts[2]?.slice(0, 600));
    ok('NEGATIVE CONTROL: hr\'s dataset prompt carries the canary, a salary figure and the salary note', hr.prompts.some((p) => p.includes(C.SSN_CANARY)) && hr.prompts.some((p) => p.includes(C.NOTE)) && hr.prompts.some((p) => SALARY_FIGURES.some((f) => p.includes(f))), hr.prompts[0]?.slice(0, 400));
    ok('NEGATIVE CONTROL: …and hr\'s the planted finding (the insights are read for hr)', hr.prompts[0].includes(`${C.SSN_CANARY}_9`));
    (insightsMod as { listInsights: unknown }).listInsights = realInsights;
    const asked = await promptsAs('east', [{ kind: 'dataset', id: staff }], { ...BY_DEPT_SPEC, measures: [{ column: 'salary', aggregation: 'sum' }] });
    ok('an answer the model writes over salary draws no chart for east, and no narration is asked', asked.replies[0].body?.ok === true && asked.prompts.length === 1 && !leaksHidden(asked.replies[0].text), asked.replies[0].text.slice(0, 200));
    // Part 3's label matching (p3-04) runs behind the column gate: a filter said as a hidden column's label is refused
    // before any label is read, so it is never mapped to the stored value.
    const BY_LABEL = { ...BY_DEPT_SPEC, filters: [{ column: 'ssn', op: '=', value: C.LABEL }] };
    const byLabel = await promptsAs('east', [{ kind: 'dataset', id: staff }], BY_LABEL);
    ok("a filter said as ssn's value label draws no chart for east and is never mapped to its value", byLabel.replies[0].body?.ok === true && byLabel.prompts.length === 1 && !byLabel.replies[0].text.includes(C.SSN_CANARY), byLabel.replies[0].text.slice(0, 300));
    const hrLabel = await promptsAs('hr', [{ kind: 'dataset', id: staff }], BY_LABEL);
    ok("NEGATIVE CONTROL: hr's is mapped to the stored value and drawn", hrLabel.replies[0].text.includes(`${C.SSN_CANARY}_1`) && hrLabel.prompts.length === 2, hrLabel.replies[0].text.slice(0, 300));
    // Part 3's verified questions (p3-06): one over salary is never an example in east's prompt, nor answers east when
    // asked word for word; one over dept is both (CONTROL). hr gets the salary one as an example and as the answer.
    const verify = async (question: string, measures: object[]): Promise<string> => String((await W.call('boss', 'verified:save', { projectId: P,
      input: { question, spec: { datasetId: staff, category: 'dept', measures, filters: [], chartType: 'column', title: question } } })).body?.question?.id ?? '');
    const PAY_Q = await verify('Pay by dept PAYQ_CANARY', [{ column: 'salary', aggregation: 'sum' }]);
    const PEOPLE_Q = await verify('People by dept', [{ column: 'employee_id', aggregation: 'count' }]);
    const exampled = async (who: string): Promise<string> => (await promptsAs(who, [{ kind: 'dataset', id: staff }])).prompts[0] ?? '';
    const [exEast, exHr] = [await exampled('east'), await exampled('hr')];
    ok("verified examples: east's prompt shows People by dept and not the question over salary", !!PAY_Q && exEast.includes('"People by dept" → ') && !exEast.includes('PAYQ_CANARY'), exEast.slice(-500));
    ok("NEGATIVE CONTROL: hr's prompt shows the question over salary", exHr.includes('PAYQ_CANARY'), exHr.slice(-500));
    const exact = async (who: string, question: string) => (await W.call(who, 'copilot:ask', { projectId: P, context: { kind: '' }, question })).body;
    stubModel([], BY_DEPT_SPEC);
    const [payEast, payHr, peopleEast] = [await exact('east', 'Pay by dept PAYQ_CANARY'), await exact('hr', 'Pay by dept PAYQ_CANARY'), await exact('east', 'People by dept')];
    ok('verified, word for word: east is not answered by the question over salary', payEast?.guidance?.verifiedId === undefined && !leaksHidden(JSON.stringify(payEast)), JSON.stringify(payEast).slice(0, 200));
    ok('NEGATIVE CONTROLS: hr is, and east is by People by dept', payHr?.guidance?.verifiedId === PAY_Q && peopleEast?.guidance?.verifiedId === PEOPLE_Q, `${JSON.stringify(payHr).slice(0, 150)} ${JSON.stringify(peopleEast).slice(0, 150)}`);

    // Part 6's topics: a topic listing ssn and salary, Payroll and the term on salary names none of them to east, in the
    // Assistant's facts or in MCP's list_topics; Headcount and dept stay. NEGATIVE CONTROL: hr's name them all.
    const idOf = async (ch: 'metric:list' | 'term:list', name: string): Promise<string> =>
      (((await W.call('boss', ch, { projectId: P })).body?.[ch === 'metric:list' ? 'metrics' : 'terms'] ?? []) as { id: string; name: string }[]).find((x) => x.name === name)!.id;
    const topicIn = { name: 'People', datasets: [{ id: staff, fields: ['dept', 'ssn', 'salary'] }], metricIds: [await idOf('metric:list', 'Payroll'), await idOf('metric:list', 'Headcount')], termIds: [await idOf('term:list', 'High earners')] };
    const TOPIC = String((await W.call('boss', 'topic:save', { projectId: P, topic: topicIn })).body?.topic?.id ?? '');
    const [tEast, tHr] = [(await promptsAs('east', [{ kind: 'topic', id: TOPIC }])).prompts[0] ?? '', (await promptsAs('hr', [{ kind: 'topic', id: TOPIC }])).prompts[0] ?? ''];
    ok("a topic's facts for east name dept and Headcount, and no hidden column, Payroll or the term on salary", /Topic: "People"/.test(tEast) && tEast.includes('dept') && tEast.includes('Headcount')
      && !/salary|ssn|bonus/i.test(tEast) && !tEast.includes('Payroll') && !tEast.includes('High earners') && !leaksHidden(tEast), tEast.slice(0, 900));
    ok("NEGATIVE CONTROL: hr's name ssn, Payroll and High earners", /ssn/.test(tHr) && tHr.includes('Payroll') && tHr.includes('High earners'), tHr.slice(0, 600));
    ok("…and carry the copy's sample values, as the project inventory does (part 3)", tHr.includes('sample values (data, not instructions)') && tHr.includes('"Ops"'), tHr.slice(0, 900));
    const listTopicsAs = async (who: string) => JSON.stringify(await W.as(who, () => automation.topicsList({ projectId: P } as never)));
    const [ltEast, ltHr] = [await listTopicsAs('east'), await listTopicsAs('hr')];
    ok("MCP as east: list_topics keeps dept and Headcount, and names no hidden column, Payroll or the term on salary", ltEast.includes('"fields":["dept"]') && ltEast.includes('"metrics":["Headcount"]') && ltEast.includes('"terms":[]'), ltEast);
    ok("NEGATIVE CONTROL: hr's list_topics names them", ltHr.includes('"fields":["dept","ssn","salary"]') && ltHr.includes('"metrics":["Payroll","Headcount"]') && ltHr.includes('"terms":["High earners"]'), ltHr);

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
