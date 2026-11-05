// The column access safety net (semantic layer part 4, docs/semantic-layer/04-governance.md, Tests), over the real
// RPC route, as real users in a scratch Postgres. The world is scripts/columnAccessHarness.ts: *Staff* hides
// `salary`, `ssn` and the carrier `bonus` from `east`; `hr` (a viewer in HR) and `ed` (an editor) see them.
//
// FAN-OUT (D17): a publish, an embed, a subscription and an alert are gated as their least-entitled audience, so
// one that READS a hidden column refuses and one that does not goes out (NEGATIVE CONTROLS). A /p/ site built
// before its datasets hid a column stops being served until it is republished; an embed page cached before them
// is refused on its next hit; an older site that recorded no datasets stops while its project has rules newer than
// it. A push keeps its figures unless it names a hidden column. `policyClosed` stays rows-only (NEGATIVE CONTROL).
//
// COVERAGE (no database needed): every `read` contract has a COLUMN_TREATMENT (scripts/columnAccessReaders.ts),
// the table names no channel that is gone, and NEGATIVE CONTROL: a planted contract is reported.
//
// CANARIES: an ssn value (SSN_CANARY_<i>) in every hidden cell, and the salary figures, the salary example and an
// ssn value label, grepped in everything east is given: one payload for EVERY read contract (records on Staff
// naming hidden columns: a visual on ssn with a custom order of its values, metrics and terms on salary and ssn,
// colours, a quality rule's args, an alert's sentence, a failed run's errors), every MCP tool, every push of a
// quality check, and every prompt sent to the (stubbed) model. NEGATIVE CONTROL: hr's and the editor's carry them.
// Every GATE channel refuses east a question that names ssn, and answers one that does not Object.is-equal to
// the editor's (NEGATIVE CONTROL: the editor is answered the first).
//
//   npm run build:ts && DATABASE_URL=… node scripts/test-columnAccessSafetyNet.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import * as C from './columnAccessHarness';
import * as H from './rowPolicyHarness';

const rowAccess: typeof import('../src/data/rowAccess') = require('../src/data/rowAccess');
const hosted: typeof import('../src/publish/hosted') = require('../src/publish/hosted');
const embedPage: typeof import('../src/publish/embedPage') = require('../src/publish/embedPage');
const alertStore: typeof import('../src/analysis/alertStore') = require('../src/analysis/alertStore');
const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');

const api: typeof import('../src/api/index') = require('../src/api/index');
const sse: typeof import('../src/server/sse') = require('../src/server/sse');
const pipeStore: typeof import('../src/app/pipelineStore') = require('../src/app/pipelineStore');
const automation: typeof import('../src/automation/handlers') = require('../src/automation/handlers');
import { COLUMN_TREATMENT } from './columnAccessReaders';

const show = (r: H.Reply): string => `${r.status} ${r.text.slice(0, 200)}`;

/** Read contracts with no column class — the ratchet, as a function so its negative control can run it. */
const unclassifiedColumns = (contracts: Record<string, { access: string }>): string[] =>
  Object.entries(contracts).filter(([, c]) => c.access === 'read').map(([ch]) => ch).filter((ch) => !Object.prototype.hasOwnProperty.call(COLUMN_TREATMENT, ch));

(async () => {
  // ── Coverage ─────────────────────────────────────────────────────────────
  const contracts = api.contracts as unknown as Record<string, { access: string }>;
  const missing = unclassifiedColumns(contracts);
  ok('coverage: every read contract has a COLUMN_TREATMENT (scripts/columnAccessReaders.ts)', missing.length === 0, missing.join(', '));
  const stale = Object.keys(COLUMN_TREATMENT).filter((ch) => !(ch in contracts) || contracts[ch].access !== 'read');
  ok('coverage: the table names no channel that is gone or no longer read', stale.length === 0, stale.join(', '));
  ok('NEGATIVE CONTROL: a planted read contract is reported', JSON.stringify(unclassifiedColumns({ ...contracts, 'columns:planted': { access: 'read' } })) === '["columns:planted"]');

  const W = await C.columnWorld('column access safety net');
  if (!W) return finish();
  try {
    const { P, staff } = W;
    // ── Fan-out ──────────────────────────────────────────────────────────────
    const COUNT = { column: 'employee_id', aggregation: 'count' };
    const SUM_SALARY = { column: 'salary', aggregation: 'sum' };
    const dashOn = async (measure: object): Promise<string> => {
      const v = await W.call('boss', 'visual:save', { projectId: P, datasetId: staff, name: 'People', chartType: 'bar', encoding: { category: 'dept', values: [measure] } });
      const a = await W.call('boss', 'analysis:create', { projectId: P, name: 'Board', sheets: [{ name: 'One', cards: [
        { id: crypto.randomUUID(), type: 'visual', layout: { x: 0, y: 0, w: 6, h: 4 }, visualId: String(v.body?.visual?.id ?? v.body?.id) },
        { id: crypto.randomUUID(), type: 'metric', layout: { x: 6, y: 0, w: 3, h: 4 }, metric: { datasetId: staff, ...measure, label: 'Figure' } },
      ] }] });
      return String(a.body?.id ?? a.body?.analysis?.id);
    };
    const target = (dash: string, id?: string) => ({ projectId: P, dashboardIds: [dash], storyIds: [], scorecardIds: [], options: { title: 'Site' }, ...(id ? { id } : {}) });
    const PAY_BOARD = await dashOn(SUM_SALARY);
    const HEADCOUNT_BOARD = await dashOn(COUNT);
    await W.setRaw(staff, undefined); // before the rules
    const before = await W.call('boss', 'publish:run', target(HEADCOUNT_BOARD));
    const siteId = String(before.body?.site?.id ?? '');
    ok('setup: before the rules, the headcount board publishes', before.body?.ok === true, show(before));
    const get = (url: string) => W.app.inject({ method: 'GET', url, headers: { 'x-forwarded-email': 'boss@acme.test' }, remoteAddress: '127.0.0.1' });
    const page = async (): Promise<number> => {
      const first = await get(`/p/${siteId}/`);
      const to = String(first.headers.location ?? '');
      return first.statusCode === 302 && to.startsWith(`/p/${siteId}/`) ? (await get(to)).statusCode : first.statusCode;
    };
    ok('setup: …and its page is served', (await page()) === 200);
    const claims = { pub: siteId, exp: Math.floor(Date.now() / 1000) + 600, params: {}, hide: [] };
    const embed = () => H.context.runAsPublished({ user: { email: 'embed', role: 'viewer' }, org: { id: 'acme' } }, 'embed', async () =>
      embedPage.embedHtml((await hosted.getSite(siteId))!, HEADCOUNT_BOARD, claims as never).then((x) => ('html' in x ? 'html' : x.missing), (err: unknown) => (rowAccess.isRowPolicyError(err) ? 'refused' : String(err))));
    ok('setup: …and its embed builds (and is cached)', (await embed()) === 'html');
    await W.plant(staff); // the rules, set after: stamped now

    const plan = await W.call('boss', 'publish:plan', target(PAY_BOARD));
    ok('a publish reading salary refuses, for an admin too', H.refused(plan), show(plan));
    ok('…and so does running it', H.refused(await W.call('boss', 'publish:run', target(PAY_BOARD))));
    const headcount = await W.call('boss', 'publish:run', target(HEADCOUNT_BOARD));
    ok('NEGATIVE CONTROL: a publish of headcount by dept publishes', headcount.body?.ok === true && (headcount.body.site?.datasetIds ?? []).includes(staff), show(headcount));
    ok('a site published before the rules is no longer served', (await page()) === 404);
    ok('an embed page cached before the rules is refused on its next hit', (await embed()) === 'refused');
    const again = await W.call('boss', 'publish:run', target(HEADCOUNT_BOARD, siteId));
    ok('…and the site is served again once republished (it reads no hidden column)', again.body?.ok === true && (await page()) === 200, show(again));
    ok('…and so is its embed, built afresh under the rules', (await embed()) === 'html');
    // Rules saved WHILE a page builds: the build read none, but it may hold what they hide — refused.
    const publishMod: typeof import('../src/publish/publish') = require('../src/publish/publish');
    const realBuild = publishMod.buildPages;
    const midBuild = async (plant: boolean): Promise<H.Reply> => {
      await W.setRaw(staff, undefined);
      (publishMod as { buildPages: unknown }).buildPages = async (...a: Parameters<typeof realBuild>) => {
        const out = await realBuild(...a);
        if (plant) await W.plant(staff);
        return out;
      };
      try {
        return await W.call('boss', 'publish:run', target(PAY_BOARD));
      } finally {
        (publishMod as { buildPages: unknown }).buildPages = realBuild;
        await W.plant(staff);
      }
    };
    ok('a publish whose datasets gained column rules while it was built is refused', H.refused(await midBuild(true), 'fanout'));
    ok('NEGATIVE CONTROL: …the same publish with no rules saved meanwhile goes out', (await midBuild(false)).body?.ok === true);

    // An older site that recorded no datasets (a story): stopped while its project has column rules newer than it.
    const P2: string = (await W.call('boss', 'projects:create', { name: 'Second' })).body.id;
    const lone = await W.as('boss', async () => (await datasets.saveDataset(P2, { name: 'Lone', sourceKind: 'csv', columns: C.STAFF_COLUMNS, rows: C.STAFF_ROWS }))!.id);
    const site = (await W.as('boss', () => hosted.getSite(siteId)))!;
    const story = (publishedAt: string) => ({ ...site, projectId: P2, publishedAt, datasetIds: undefined, config: { ...site.config, storyIds: [crypto.randomUUID()] } });
    const servable = (s: ReturnType<typeof story>) => W.as('boss', () => hosted.servable(s));
    const old = new Date(Date.now() - 60_000).toISOString();
    ok('NEGATIVE CONTROL: legacy: an older site is served in a project with no rules', (await servable(story(old))) === true);
    await W.as('boss', async () => {
      const rec: typeof import('../src/data/datasetRecord') = require('../src/data/datasetRecord');
      const access: typeof import('../src/data/columnAccess') = require('../src/data/columnAccess');
      await rec.serialized(rec.datasetFilePath(P2, lone), (raw) => { raw.columnAccess = access.buildColumnAccess(raw, W.rules, 'boss@acme.test', new Date().toISOString()); return true; });
      rowAccess.rulesChanged(P2); // as a save of rules does: this pod forgets what it remembered of the project
    });
    ok('legacy: …and not once its project has column rules newer than it', (await servable(story(old))) === false);
    ok('NEGATIVE CONTROL: legacy: one published after those rules is served', (await servable(story(new Date(Date.now() + 1000).toISOString()))) === true);

    // Subscriptions and alerts.
    const channelsMod: typeof import('../src/app/channels') = require('../src/app/channels');
    const chan = await W.as('boss', () => channelsMod.saveChannel({ name: 'Ops list', kind: 'email', to: { userIds: [W.uid.ed], teamIds: [] } }, 'boss@acme.test'));
    const chanId = 'channel' in chan ? chan.channel.id : '';
    const draft = (analysisId: string) => ({ name: 'Send', analysisId, content: { mode: 'all', cardIds: [] }, schedule: { cadence: 'daily', at: '08:00' }, timezone: 'UTC', channelIds: [chanId], message: { title: '', note: '', includeLink: false }, conditions: { skipUnchanged: false, onlyWhenRefreshed: false } });
    const prevPay = await W.call('boss', 'subscription:preview', { projectId: P, draft: draft(PAY_BOARD) });
    ok('a subscription preview over salary refuses: no message, the refusal said', prevPay.body?.ok === true && prevPay.body.slack === null && prevPay.body.email === null && typeof prevPay.body.empty === 'string' && !C.leaksHidden(prevPay.text), show(prevPay));
    const prevHead = await W.call('boss', 'subscription:preview', { projectId: P, draft: draft(HEADCOUNT_BOARD) });
    ok('NEGATIVE CONTROL: …over headcount it previews', prevHead.body?.ok === true && !!prevHead.body.slack && prevHead.body.code !== 'row_policy', show(prevHead));
    const subs: typeof import('../src/analysis/subscriptions') = require('../src/analysis/subscriptions');
    const runMod: typeof import('../src/server/subscriptions/run') = require('../src/server/subscriptions/run');
    const JOBS = { user: { email: 'jobs@system', role: 'admin' as const }, org: { id: 'acme' } };
    const runOver = async (analysisId: string) => {
      const sub = await W.as('boss', () => subs.createSubscription(P, draft(analysisId), 'boss@acme.test'));
      return H.context.runInContext(JOBS, 'job:subscriptions:acme', () => runMod.runSubscription(P, sub!.id, Date.now() - 60_000));
    };
    const runPay = await runOver(PAY_BOARD);
    ok('a scheduled run over salary is skipped as row_policy: nothing built, nothing sent', runPay?.outcome === 'skipped' && runPay.code === 'row_policy', JSON.stringify(runPay));
    const runHead = await runOver(HEADCOUNT_BOARD);
    ok('NEGATIVE CONTROL: …a run over headcount is built (and fails only at its channel: no mail here)', runHead !== null && runHead.code !== 'row_policy' && runHead.code !== 'compute_failed', JSON.stringify(runHead));
    const rule = (metric: object) => ({ id: crypto.randomUUID(), name: 'Watch', datasetId: staff, metric, compare: 'threshold', threshold: { op: '>', value: 1 }, enabled: true });
    const alertPay = await W.call('boss', 'alerts:save', { projectId: P, rule: rule(SUM_SALARY) });
    ok('an alert save over salary refuses', H.refused(alertPay), show(alertPay));
    const alertHead = await W.call('boss', 'alerts:save', { projectId: P, rule: rule(COUNT) });
    ok('NEGATIVE CONTROL: …over headcount it saves', alertHead.status === 200 && !H.refused(alertHead) && alertHead.body?.ok !== false, show(alertHead));
    ok('NEGATIVE CONTROL: policyClosed(Staff) is false (rows only), so assertFanOutAllowed lets headcount sends through', !(await W.as('boss', () => rowAccess.policyClosed(P, staff))));

    // A push goes to every reader alike: its figures stay unless it names a hidden column.
    const event = (datasetId: string, message: string) => ({ id: crypto.randomUUID(), ruleId: crypto.randomUUID(), ruleName: 'Data quality', datasetId, at: new Date().toISOString(),
      value: 3, previous: 1, delta: null, deltaPct: null, message, seen: false });
    const pushed = await W.as('boss', () => alertStore.pushableEvents(P, [event(staff, 'Data quality: "salary is not empty" failing on 3 rows in Staff'), event(staff, 'Data quality: "dept is not empty" failing on 3 rows in Staff'), event(W.plain, 'Plain: 3 rows')]));
    ok('push: an event on Staff naming salary loses its figures and sentence', pushed[0].value === null && pushed[0].message === '', JSON.stringify(pushed[0]));
    ok('NEGATIVE CONTROL: push: one on Staff naming only dept keeps them, and one on Plain', pushed[1].value === 3 && pushed[1].message.includes('dept') && pushed[2].value === 3, JSON.stringify(pushed.slice(1)));

    // ── Canaries: everything east is given ───────────────────────────────────
    const { SALARY_V, DEPT_V, BOARD, PAYROLL } = await C.factsWorld(W);
    const must = (what: string, r: H.Reply): H.Reply => { if (r.status !== 200 || r.body?.ok === false) throw new Error(`${what}: ${r.text.slice(0, 200)}`); return r; };
    const idOf = (r: H.Reply): string => String(r.body?.visual?.id ?? r.body?.metric?.id ?? r.body?.term?.id ?? r.body?.story?.id ?? r.body?.scorecard?.id ?? r.body?.id ?? '');
    const canary = (i: number): string => `${C.SSN_CANARY}_${i}`;
    // Records on Staff that name a hidden column, and carry its values where a record can.
    const SSN_V = idOf(must('ssn visual', await W.call('boss', 'visual:save', { projectId: P, datasetId: staff, name: 'By person', chartType: 'bar', encoding: { category: 'ssn', values: [COUNT] },
      overrides: { sort: 'custom', sortOrder: [canary(1), canary(2)], seriesColors: { [canary(3)]: 'chart-2' } }, filters: [{ type: 'filter', column: 'ssn', op: 'in', values: [canary(1), canary(2)] }] })));
    must('ssn visual v2', await W.call('boss', 'visual:update', { projectId: P, id: SSN_V, overrides: { sort: 'custom', sortOrder: [canary(2), canary(1)] } }));
    const keysOf = async (id: string): Promise<string[]> => ((await W.call('boss', 'versions:list', { projectId: P, type: 'visual', id })).body as { key: string }[]).map((x) => x.key);
    const nvKeys = await keysOf(SSN_V);
    const SSN_METRIC = idOf(must('ssn metric', await W.call('boss', 'metric:save', { projectId: P, input: { name: 'People with an ssn', datasetId: staff, definition: { column: 'ssn', aggregation: 'count' } } })));
    const HEADCOUNT = String(((await W.call('boss', 'metric:list', { projectId: P })).body?.metrics as { id: string; name: string }[] | undefined ?? []).find((m) => m.name === 'Headcount')?.id);
    const SSN_TERM = idOf(must('ssn term', await W.call('boss', 'term:save', { projectId: P, input: { name: 'Known people', aliases: [], description: '', datasetId: staff, filters: [{ type: 'filter', column: 'ssn', op: 'in', values: [canary(4)] }] } })));
    must('colours', await W.call('boss', 'format:colors:assign', { projectId: P, column: 'ssn', values: [canary(5)] }));
    const STORY = idOf(must('story', await W.call('boss', 'story:create', { projectId: P, name: 'Pay story', blocks: [{ id: 'b1', kind: 'visual', visualId: SALARY_V }, { id: 'b2', kind: 'visual', visualId: SSN_V }] })));
    const scorecardOf = async (metricId: string): Promise<string> => idOf(must('scorecard', await W.call('boss', 'scorecard:create', { projectId: P, name: 'Card', rows: [{ metricId }] })));
    const [SSN_CARD, HEAD_CARD] = [await scorecardOf(SSN_METRIC), await scorecardOf(HEADCOUNT)];
    // A quality rule whose args and failing rows name ssn values, and one on dept: their check pushes to every reader.
    const pushes: string[] = [];
    sse.setFanOut((tg, channel, data) => { if (tg.user === undefined || tg.user === 'east@acme.test') pushes.push(`${channel} ${data}`); });
    const quality = await W.call('boss', 'quality:save', { projectId: P, datasetId: staff, rule: { kind: 'in_set', column: 'ssn', args: { values: [canary(0)] }, severity: 'fail' } });
    await W.call('boss', 'quality:save', { projectId: P, datasetId: staff, rule: { kind: 'in_set', column: 'dept', args: { values: ['Ops'] }, severity: 'fail' } });
    const QRULE = String((quality.body?.quality?.rules ?? quality.body?.rules ?? [])[0]?.id ?? crypto.randomUUID());
    await W.as('boss', () => alertStore.recordEvents(P, [{ id: crypto.randomUUID(), ruleId: crypto.randomUUID(), ruleName: 'Watch', datasetId: staff, at: new Date().toISOString(),
      value: 14442, previous: 14000, delta: 442, deltaPct: 3, message: `Pay rose on ${canary(6)}`, seen: false, analysisId: BOARD }]));
    const at = new Date().toISOString();
    await W.as('boss', () => pipeStore.appendRuns(P, [{ nodeId: `dataset:${staff}`, id: crypto.randomUUID(), runId: crypto.randomUUID(), trigger: 'manual' as const, status: 'failed' as const,
      startedAt: at, finishedAt: at, durationMs: 1, attempts: 1, warnings: [`${canary(7)} looks odd`], errors: [`no row for ${canary(8)}`] }]));

    const SUB = String(((await W.call('boss', 'subscription:list', { projectId: P })).body?.subscriptions as { id: string }[] | undefined)?.[0]?.id);
    const COUNT_BY = (category: string) => ({ category, values: [COUNT] });
    const viz = (encoding: object) => ({ projectId: P, datasetId: staff, encoding });
    const cols = { projectId: P, datasetId: staff };
    const spec = (category: string) => ({ datasetId: staff, category, measures: [COUNT], filters: [] });
    const step = (type: string) => ({ projectId: P, datasetId: staff, index: -1, step: { type, column: 'ssn' } });
    /** One payload for each read contract that needs more than its project (and Staff, and a column) — the rest get those. */
    const EXPLICIT: Record<string, unknown> = {
      'projects:open': { id: P }, 'dataset:page': { ...cols, offset: 0, limit: 200 }, 'dataset:columns': { projectId: P, id: staff }, 'dataset:source': { projectId: P, id: staff },
      'dataSearch:query': { projectId: P, term: 'SSN' }, 'search:query': { projectId: P, query: 'SSN' }, 'comment:mentionable': { projectId: P, q: 'e' },
      'dataset:composePreview': { projectId: P, base: { datasetId: staff }, joins: [], offset: 0, limit: 50 },
      'quality:preview': { ...cols, rule: { kind: 'not_null', column: 'ssn', severity: 'fail' } }, 'quality:failingRows': { ...cols, ruleId: QRULE, offset: 0, limit: 50 },
      'visual:data': viz(COUNT_BY('dept')), 'visual:preview': viz(COUNT_BY('dept')), 'visual:dataBatch': { projectId: P, items: [{ datasetId: staff, encoding: COUNT_BY('dept') }] },
      'visual:get': { projectId: P, id: SSN_V }, 'visual:thumbs': { projectId: P, ids: [SSN_V, SALARY_V, DEPT_V] },
      'visual:rows': { ...viz(COUNT_BY('dept')), mark: { category: 'Ops' } }, 'visual:rowsDownload': { ...viz(COUNT_BY('dept')), mark: { category: 'Ops' }, name: 'Ops' },
      'answer:card': { projectId: P, spec: spec('dept') }, 'answer:rerun': { projectId: P, spec: spec('dept') }, 'answer:explain': { projectId: P, visualId: SALARY_V },
      'copilot:ask': { projectId: P, context: { kind: 'dataset', id: staff }, question: 'tell me about pay' },
      'versions:list': { projectId: P, type: 'visual', id: SSN_V }, 'versions:get': { projectId: P, type: 'visual', id: SSN_V, key: nvKeys[nvKeys.length - 1] },
      'versions:diff': { projectId: P, type: 'visual', id: SSN_V, from: nvKeys[nvKeys.length - 1], to: nvKeys[0] }, 'versions:figures': { projectId: P, type: 'visual', id: SSN_V, from: nvKeys[nvKeys.length - 1], to: nvKeys[0] },
      'catalog:get': { projectId: P, ref: `dataset:${staff}` }, 'lineage:get': { projectId: P, type: 'dataset', id: staff }, 'input:load': { projectId: P, id: staff },
      'relationship:suggest': { projectId: P, fromId: W.plain, toId: staff }, 'formula:check': { ...cols, expression: '[ssn]' },
      'prepare:stepPreview': step('trim'), 'text:preview': step('trim'), 'geo:spatialPreview': step('trim'), 'prepare:similarValues': { ...cols, index: -1, column: 'ssn' },
      'stats:run': { projectId: P, spec: { kind: 'distribution', datasetId: staff, columns: ['salary'] } },
      'stats:pair': { projectId: P, spec: { kind: 'distribution', datasetId: staff, columns: ['salary'] }, x: 'salary', y: 'bonus' },
      'drivers:explain': { projectId: P, request: { datasetId: staff, metric: { column: 'salary', aggregation: 'sum' }, compare: { mode: 'latest', column: 'dept' }, dimension: 'ssn' } },
      'drivers:explainPoint': { ...viz({ category: 'dept', values: [{ column: 'salary', aggregation: 'sum' }] }), point: { bucket: 'Ops' } },
      'drivers:explainAlert': { projectId: P, ruleId: String(alertHead.body?.rule?.id) }, 'embed:columns': { projectId: P, siteId, dashboardId: HEADCOUNT_BOARD },
      'subscription:get': { projectId: P, id: SUB }, 'subscription:history': { projectId: P, id: SUB },
      'segments:fit': { ...cols, features: ['salary', 'bonus'] }, 'segments:rfm': { ...cols, spec: { id: 'ssn', date: 'dept', amount: 'salary' } },
      'privacy:summary': { projectId: P, path: 'export', datasetIds: [staff] }, 'template:plan': { ...cols, templateId: 'x', mapping: {} },
      'dashboard:metric': { ...cols, column: 'employee_id', aggregation: 'count' }, 'analysis:open': { projectId: P, id: BOARD },
      'analysis:tiles': { projectId: P, items: [{ kind: 'visual', datasetId: staff, encoding: COUNT_BY('dept') }, { kind: 'metric', datasetId: staff, column: 'employee_id', aggregation: 'count' }] },
      'metric:get': { projectId: P, id: PAYROLL }, 'metric:preview': { ...cols, definition: COUNT }, 'metric:check': { ...cols, expression: 'count(employee_id)' },
      'metric:values': { projectId: P, ids: [PAYROLL, HEADCOUNT, SSN_METRIC] }, 'metricTree:compute': { projectId: P, id: PAYROLL }, 'metricTree:suggest': { projectId: P, id: PAYROLL },
      'story:get': { projectId: P, id: STORY }, 'story:export': { projectId: P, id: STORY },
      'story:figures': { projectId: P, blocks: [{ id: 'b1', kind: 'visual', visualId: SALARY_V }, { id: 'b2', kind: 'visual', visualId: DEPT_V }, { id: 'b3', kind: 'metric', metricId: PAYROLL }] },
      'scorecard:get': { projectId: P, id: SSN_CARD }, 'scorecard:compute': { projectId: P, id: SSN_CARD }, 'scorecard:detail': { projectId: P, id: SSN_CARD, metricId: SSN_METRIC },
      'snapshots:diff': { ...cols, stamp: '2024-01-01T00-00-00-000Z' }, 'snapshots:stamps': { projectId: P, datasetIds: [staff], metricIds: [PAYROLL] },
      'dashboard:asOfStamps': { projectId: P, datasetIds: [staff], metricIds: [PAYROLL] },
      'sql:run': { projectId: P, sql: 'SELECT * FROM "Staff"' }, 'sql:explain': { projectId: P, sql: 'SELECT * FROM "Staff"' },
      'publish:plan': { projectId: P, dashboardIds: [BOARD], storyIds: [STORY], scorecardIds: [], options: { title: 'Site' } },
      'dashboard:exportHtml': { projectId: P, id: BOARD }, 'summary:compute': { projectId: P, analysisId: BOARD, pages: [] }, 'summary:rewrite': { projectId: P, analysisId: BOARD, pages: [] },
      'alerts:test': { projectId: P, rule: rule(SUM_SALARY) }, 'subscription:preview': { projectId: P, draft: draft(BOARD) },
      'term:get': { projectId: P, id: SSN_TERM }, 'catalog:columns': cols, 'catalog:getTable': cols,
    };
    const readContracts = Object.entries(contracts).filter(([, c]) => c.access === 'read').map(([ch]) => ch);
    const keysOfContract = (ch: string): string[] => {
      const input = (api.contracts as unknown as Record<string, { input?: { shape?: Record<string, unknown> } }>)[ch]?.input;
      return Object.keys(input?.shape ?? {});
    };
    const payloadOf = (ch: string): unknown => {
      if (ch in EXPLICIT) return EXPLICIT[ch];
      const keys = keysOfContract(ch);
      if (!keys.length) return undefined; // a channel that takes nothing
      return Object.fromEntries([['projectId', P], ['datasetId', staff], ['column', 'ssn']].filter(([k]) => keys.includes(k as string)));
    };
    // A verified question over salary (part 3): its answer would carry the salary figures.
    const payQ = await W.call('boss', 'verified:save', { projectId: P, input: { question: 'Pay by dept', spec: { datasetId: staff, category: 'dept', measures: [SUM_SALARY], filters: [], chartType: 'column', title: 'Pay by dept' } } });
    ok('setup: a verified question over salary', payQ.body?.ok === true, payQ.text.slice(0, 200));
    const prompts: string[] = [];
    const sweep = async (who: string): Promise<string[]> => {
      C.stubModel(prompts, { dataset: 'Staff', category: 'dept', measures: [COUNT] });
      const texts: string[] = [];
      for (const ch of readContracts) {
        const r = await W.call(who, ch, payloadOf(ch));
        texts.push(`${ch} ${r.text}`);
        const token = r.body?.downloadToken;
        if (typeof token === 'string') texts.push(`${ch} file ${(await W.app.inject({ method: 'GET', url: `/api/files/${token}`, headers: { 'x-forwarded-email': `${who}@acme.test` }, remoteAddress: '127.0.0.1' })).body}`);
      }
      return texts;
    };
    // MCP, as the token's user: every tool that reads Staff.
    const mcpCtx = { projectId: P, transport: 'http' as const, cwd: '/', headless: false, progress: () => undefined };
    const mcpTextsAs = async (who: string): Promise<string[]> => {
      const tools: Array<[string, () => Promise<unknown>]> = [
        ['list_datasets', () => automation.datasetsList(mcpCtx)], ['describe_dataset', () => automation.datasetsDescribe(mcpCtx, 'Staff')],
        ['list_metrics', () => automation.metricsList(mcpCtx)], ['list_terms', () => automation.termsList(mcpCtx)],
        ['metric_value Payroll', () => automation.metricValue(mcpCtx, 'Payroll')], ['metric_value Headcount', () => automation.metricValue(mcpCtx, 'Headcount')],
        ['aggregate salary', () => automation.aggregate(mcpCtx, { dataset: 'Staff', encoding: { category: 'dept', values: [SUM_SALARY] } })],
        ['aggregate ssn', () => automation.aggregate(mcpCtx, { dataset: 'Staff', encoding: COUNT_BY('ssn') })],
        ['aggregate dept', () => automation.aggregate(mcpCtx, { dataset: 'Staff', encoding: COUNT_BY('dept') })],
        ['query_sql', () => automation.query(mcpCtx, 'SELECT * FROM "Staff"', 50)], ['insights', () => automation.insights(mcpCtx, 'Staff')],
        ['list_verified_questions', () => automation.listVerifiedQuestions(mcpCtx)], ['get_instructions', () => automation.getInstructions(mcpCtx)],
        ['answer_verified_question Pay by dept', () => automation.answerVerifiedQuestion(mcpCtx, 'Pay by dept')],
      ];
      const out: string[] = [];
      for (const [name, run] of tools) out.push(`${name} ${await W.as(who, run).then((v) => JSON.stringify(v), (e: unknown) => `refused ${String((e as Error)?.message ?? e)}`)}`);
      return out;
    };
    const eastTexts = [...(await sweep('east')), ...(await mcpTextsAs('east'))];
    const eastPrompts = prompts.splice(0);
    const hasCanary = (t: string): boolean => C.leaksHidden(t) !== null;
    const firstLeak = (texts: string[]): string => { const t = texts.find(hasCanary); return t ? `${C.leaksHidden(t)} in ${t.slice(0, 300)}` : ''; };
    ok(`setup: east called each of the ${readContracts.length} read contracts, and ${eastTexts.length - readContracts.length} more (files, MCP tools)`, eastTexts.length > readContracts.length);
    ok('canaries: nothing east is given carries a hidden value, a salary figure, the example or a label', !eastTexts.some(hasCanary), firstLeak(eastTexts));
    ok('canaries: …nor any prompt sent for east', eastPrompts.length > 0 && !eastPrompts.some(hasCanary), firstLeak(eastPrompts));
    sse.setFanOut(null);
    ok('canaries: …nor any push the quality check sent', pushes.length > 0 && !pushes.some(hasCanary), firstLeak(pushes) || `${pushes.length} pushes`);
    ok('NEGATIVE CONTROL: …a push on Staff that names only dept keeps its figures', pushes.some((p) => p.includes('alerts:fired') && /in_set\(dept\)/.test(p) && /"value":\d/.test(p)), pushes.join(' | ').slice(0, 400));
    const hrTexts = [...(await sweep('hr')), ...(await mcpTextsAs('hr'))];
    const edTexts = [...(await sweep('ed')), ...(await mcpTextsAs('ed'))];
    ok('NEGATIVE CONTROL: hr\'s and the editor\'s replies carry them', hrTexts.some((t) => t.includes(C.SSN_CANARY)) && edTexts.some((t) => t.includes(C.SSN_CANARY)) && edTexts.some((t) => C.SALARY_FIGURES.some((f) => t.includes(f))));
    ok('NEGATIVE CONTROL: …and so do hr\'s prompts', prompts.some((p) => p.includes(C.SSN_CANARY)));
    const answered = (texts: string[]): string => texts.find((t) => t.startsWith('answer_verified_question ')) ?? '';
    ok('NEGATIVE CONTROL: hr\'s answer_verified_question over salary carries its figures; east\'s does not', C.SALARY_FIGURES.some((f) => answered(hrTexts).includes(f))
      && !hasCanary(answered(eastTexts)), `${answered(hrTexts).slice(0, 200)} | ${answered(eastTexts).slice(0, 200)}`);

    // ── Every GATE channel ───────────────────────────────────────────────────
    // A metric's versions (its figure, then and now) and its tree need a second version and a date: a pay log hides salary and ssn too.
    for (const [id, column] of [[SSN_METRIC, 'ssn'], [HEADCOUNT, 'dept']]) {
      must('metric v2', await W.call('boss', 'metric:update', { projectId: P, id, patch: { filters: [{ type: 'filter', column, op: 'not_empty' }] } }));
    }
    const metricKeys = async (id: string): Promise<string[]> => ((await W.call('boss', 'versions:list', { projectId: P, type: 'metric', id })).body as { key: string }[]).map((x) => x.key);
    const [smKeys, hmKeys] = [await metricKeys(SSN_METRIC), await metricKeys(HEADCOUNT)];
    const LOG_COLUMNS = [{ name: 'day', type: 'date' as const }, ...C.STAFF_COLUMNS];
    const payLog = await W.as('boss', async () => (await datasets.saveDataset(P, { name: 'Pay log', sourceKind: 'csv', columns: LOG_COLUMNS, rows: C.STAFF_ROWS.map((r, i) => [`2024-${String(1 + (i % 6)).padStart(2, '0')}-15`, ...r]) }))!.id);
    await W.plant(payLog);
    const logMetric = async (name: string, column: string): Promise<string> => idOf(must(name, await W.call('boss', 'metric:save', { projectId: P, input: { name, datasetId: payLog, timeColumn: 'day', definition: { column, aggregation: 'count' } } })));
    const [LOG_SSN, LOG_DEPT] = [await logMetric('Logged people', 'ssn'), await logMetric('Logged rows', 'dept')];
    const tree = (id: string) => ({ projectId: P, id, period: { key: 'custom', from: '2024-04-01', to: '2024-06-30' }, compare: { mode: 'previous_period' } });
    /** Each GATE channel: a question naming ssn, and the same question on dept. */
    const PAIRS: Record<string, [unknown, unknown]> = {
      'visual:data': [viz(COUNT_BY('ssn')), viz(COUNT_BY('dept'))],
      'visual:preview': [viz(COUNT_BY('ssn')), viz(COUNT_BY('dept'))],
      'visual:dataBatch': [{ projectId: P, items: [{ datasetId: staff, encoding: COUNT_BY('ssn') }] }, { projectId: P, items: [{ datasetId: staff, encoding: COUNT_BY('dept') }] }],
      'visual:thumbs': [{ projectId: P, ids: [SSN_V] }, { projectId: P, ids: [DEPT_V] }],
      'analysis:tiles': [{ projectId: P, items: [{ kind: 'visual', datasetId: staff, encoding: COUNT_BY('ssn') }] }, { projectId: P, items: [{ kind: 'visual', datasetId: staff, encoding: COUNT_BY('dept') }] }],
      'dashboard:metric': [{ ...cols, column: 'ssn', aggregation: 'count' }, { ...cols, column: 'dept', aggregation: 'count' }],
      'metric:preview': [{ ...cols, definition: { column: 'ssn', aggregation: 'count' } }, { ...cols, definition: { column: 'dept', aggregation: 'count' } }],
      'metric:check': [{ ...cols, expression: 'count(ssn)' }, { ...cols, expression: 'count(dept)' }],
      'metric:values': [{ projectId: P, ids: [SSN_METRIC] }, { projectId: P, ids: [HEADCOUNT] }],
      'metricTree:compute': [tree(LOG_SSN), tree(LOG_DEPT)],
      'scorecard:compute': [{ projectId: P, id: SSN_CARD }, { projectId: P, id: HEAD_CARD }],
      'scorecard:detail': [{ projectId: P, id: SSN_CARD, metricId: SSN_METRIC }, { projectId: P, id: HEAD_CARD, metricId: HEADCOUNT }],
      'story:figures': [{ projectId: P, blocks: [{ id: 'b1', kind: 'visual', visualId: SSN_V }] }, { projectId: P, blocks: [{ id: 'b1', kind: 'visual', visualId: DEPT_V }] }],
      'answer:card': [{ projectId: P, spec: spec('ssn') }, { projectId: P, spec: spec('dept') }],
      'answer:rerun': [{ projectId: P, spec: spec('ssn') }, { projectId: P, spec: spec('dept') }],
      'answer:explain': [{ projectId: P, visualId: SSN_V }, { projectId: P, visualId: DEPT_V }],
      'dataset:distinct': [{ ...cols, column: 'ssn' }, { ...cols, column: 'dept' }],
      'dataset:profile': [{ ...cols, column: 'ssn' }, { ...cols, column: 'dept' }],
      'versions:figures': [{ projectId: P, type: 'metric', id: SSN_METRIC, from: smKeys[smKeys.length - 1], to: smKeys[0] }, { projectId: P, type: 'metric', id: HEADCOUNT, from: hmKeys[hmKeys.length - 1], to: hmKeys[0] }],
    };
    // Every metric of the project at once: Payroll's and the ssn metric's figures would show in the canary sweep above.
    const PROJECT_WIDE = new Set(['home:overview', 'numbers:get', 'metric:table']);
    const gates = Object.entries(COLUMN_TREATMENT).filter(([, c]) => c === 'GATE').map(([ch]) => ch);
    const unproven = gates.filter((ch) => !(ch in PAIRS) && !PROJECT_WIDE.has(ch));
    ok('every GATE channel has a question naming ssn here, or is project-wide (proven by the canaries)', unproven.length === 0, unproven.join(', '));
    const rowMessages: typeof import('../src/data/rowAccessMessages') = require('../src/data/rowAccessMessages');
    /** No figure for the question: refused (409 or a typed reply, per item too), or the channel's own empty answer — never a number. */
    const EMPTY: Record<string, (b: any) => boolean> = { // any: each channel's own reply
      'metric:values': (b) => Array.isArray(b) && b.length > 0 && b.every((x: { ok?: unknown }) => x.ok === false && !('value' in x)),
      'scorecard:detail': (b) => b?.value === null && b.breakdown === null,
      'scorecard:compute': (b) => Array.isArray(b?.rows) && b.rows.every((x: { value?: unknown }) => x.value === null),
      'versions:figures': (b) => Array.isArray(b?.figures) && b.figures.length > 0 && b.figures.every((f: { before?: { ok?: unknown }; after?: { ok?: unknown } }) => f.before?.ok !== true && f.after?.ok !== true),
      'story:figures': (b) => Object.values(b?.blocks ?? {}).every((x) => ((x as { chart?: { data?: { labels?: unknown[] } } }).chart?.data?.labels ?? []).length === 0),
    };
    const noFigure = (r: H.Reply, ch = ''): boolean => r.status === 409 || r.text.includes('row_policy') || r.text.includes(rowMessages.rowHiddenMessage()) || (r.status === 200 && !!EMPTY[ch]?.(r.body));
    /** What two callers' answers are compared on: an answer card's chips offer no hidden column by design; a re-run's thread is the caller's own. */
    const FIGURE: Record<string, (b: any) => unknown> = { 'answer:card': (b) => b?.data, 'answer:rerun': (b) => b?.turns?.slice(-1) }; // any: as above
    for (const [ch, [naming, other]] of Object.entries(PAIRS)) {
      const refused = await W.call('east', ch, naming);
      ok(`gate: ${ch} refuses east a question naming ssn`, noFigure(refused, ch) && !hasCanary(refused.text), show(refused));
      const edNaming = await W.call('ed', ch, naming);
      ok(`NEGATIVE CONTROL: gate: ${ch} answers the editor the same question`, edNaming.status === 200 && !noFigure(edNaming, ch), show(edNaming));
      const [mine, theirs] = [await W.call('east', ch, other), await W.call('ed', ch, other)];
      const pick = FIGURE[ch] ?? ((b: unknown) => b);
      const d = H.diff(pick(mine.body), pick(theirs.body), {});
      ok(`gate: ${ch} answers east the question on dept, Object.is-equal to the editor's`, mine.status === 200 && !noFigure(mine, ch) && d === '', `${d} | ${show(mine)}`);
    }
  } finally {
    await W.close();
  }
  finish();
})().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
