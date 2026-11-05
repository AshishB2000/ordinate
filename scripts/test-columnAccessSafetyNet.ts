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

const show = (r: H.Reply): string => `${r.status} ${r.text.slice(0, 200)}`;

(async () => {
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
  } finally {
    await W.close();
  }
  finish();
})().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
