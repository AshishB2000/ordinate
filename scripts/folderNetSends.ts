// Sections 9 and 10 of the folder safety net (docs/team-folders/00-design.md), E3's: what Ordinate sends or tells
// other people, and what an agent or a model is handed. Over ./folderHarness's world with its folders planted; run by
// ./folderNet after section 7. Not a test file itself (no `test-` prefix).
//
// 9. PUSHES, SENDS, MENTIONS AND COUNTS: a fired HR alert, an HR refresh and a save of an HR chart reach only HR's
//    openers' streams (an Ops event, Ops's); a mention of someone who cannot open the target is refused as a
//    non-reader's, the picker leaves them out, and a notice goes to an opener alone; HR's subscription and alert
//    emails resolve to no Ops address; Home's and the switcher's counts and "Your numbers" are of what the caller opens.
//    NEGATIVE CONTROLS: padmin's stream gets them; with the folder checks off, opsViewer's stream, HR's email audience,
//    the mention and the counts all take HR in.
// 10. MCP AND MODEL PROMPTS: every MCP tool as opsViewer (a personal token), and every prompt the stubbed model is
//    sent for opsViewer's asks: no canary. NEGATIVE CONTROL: padmin's tools and prompts carry them.

import { randomUUID } from 'crypto';
import { ok } from './selfcheck';
import * as H from './folderHarness';

const sse: typeof import('../src/server/sse') = require('../src/server/sse');
const gate: typeof import('../src/server/authz/folderGate') = require('../src/server/authz/folderGate');
const schedules: typeof import('../src/server/jobs/schedules') = require('../src/server/jobs/schedules');
const refreshEvents: typeof import('../src/data/refreshEvents') = require('../src/data/refreshEvents');
const emailChannel: typeof import('../src/server/mail/emailChannel') = require('../src/server/mail/emailChannel');
const notify: typeof import('../src/server/mentions/notify') = require('../src/server/mentions/notify');
const analyze: typeof import('../src/ai/analyze') = require('../src/ai/analyze');
const execConfig: typeof import('../src/app/execConfig') = require('../src/app/execConfig');
const registry: typeof import('../src/automation/serverMcp') = require('../src/automation/serverMcp');
type Person = H.Person;
type AlertEvent = import('../src/analysis/alerts').AlertEvent;

const email = (who: Person): string => `${who.toLowerCase()}@acme.test`;
/** Without the folder checks (src/server/authz/folderGate's seam): what E3 narrows, unnarrowed. */
async function unchecked<T>(fn: () => Promise<T>): Promise<T> {
  gate.setFolderChecksForTest(false);
  try {
    return await fn();
  } finally {
    gate.setFolderChecksForTest(true);
  }
}
async function until(cond: () => boolean, ms = 3000): Promise<boolean> {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 20))) if (cond()) return true;
  return cond();
}

export async function sendSections(W: H.World): Promise<void> {
  const { P, hr, ops } = W;
  // ── 9. Pushes, sends, mentions, counts ───────────────────────────────
  const seen: Array<{ user: string; channel: string; data: string }> = [];
  sse.setFanOut((t, channel, data) => { if (t.user) seen.push({ user: t.user, channel, data }); });
  const got = (who: Person, channel: string, re: RegExp = H.CANARY): boolean => seen.some((s) => s.user === email(who) && s.channel === channel && re.test(s.data));
  const pushed = (channel: string): string[] => [...new Set(seen.filter((s) => s.channel === channel).map((s) => s.user))].sort();
  try {
    const event = (it: H.Items, word: string): AlertEvent => ({ id: randomUUID(), ruleId: it.rule, ruleName: `${word} alert`, datasetId: it.ds, at: new Date().toISOString(), value: 2, previous: 1, delta: 1, deltaPct: 100, message: `${word} rose`, seen: false });
    const fire = () => W.as('boss', () => schedules.pushFired(P, [event(hr, 'HRCANARY'), event(ops, 'OPSFIRED')]));
    await fire();
    ok('pushes: an HR alert firing reaches HR\'s openers only (boss, padmin); Ops\'s reaches Ops\'s, alone in their push', got('padmin', 'alerts:fired') && got('boss', 'alerts:fired') && got('opsViewer', 'alerts:fired', /OPSFIRED/)
      && !['opsViewer', 'opsLead', 'opsEditorView', 'finViewer', 'ed'].some((p) => got(p as Person, 'alerts:fired')) && !pushed('alerts:fired').includes(email('finViewer')), JSON.stringify(pushed('alerts:fired')));
    seen.length = 0;
    await unchecked(fire);
    ok('NEGATIVE CONTROL: with the folder checks off, opsViewer\'s stream gets the HR alert', got('opsViewer', 'alerts:fired'));

    seen.length = 0;
    const refreshed = () => W.as('boss', async () => refreshEvents.announceRefreshed({ projectId: P, datasetId: hr.ds, name: 'HRCANARY Salaries', rowsBefore: 1, rowsAfter: 2 }));
    await refreshed();
    await until(() => got('padmin', 'hub:dataset-refreshed'));
    ok('pushes: an HR refresh reaches HR\'s openers only', got('padmin', 'hub:dataset-refreshed') && JSON.stringify(pushed('hub:dataset-refreshed')) === JSON.stringify([email('boss'), email('padmin')]), JSON.stringify(pushed('hub:dataset-refreshed')));
    seen.length = 0;
    await unchecked(refreshed);
    ok('NEGATIVE CONTROL: with the folder checks off, opsViewer\'s stream gets the HR refresh', await until(() => got('opsViewer', 'hub:dataset-refreshed')));

    seen.length = 0;
    const tagOf = async (who: Person, id: string): Promise<string> => String((await W.call(who, 'visual:get', { projectId: P, id })).body?.tag ?? '');
    await W.call('boss', 'visual:update', { projectId: P, id: hr.visual, base: await tagOf('boss', hr.visual), name: 'HRCANARY chart, renamed' });
    await W.call('opsLead', 'visual:update', { projectId: P, id: ops.visual, base: await tagOf('opsLead', ops.visual), name: 'Ops chart, renamed' });
    await until(() => pushed('hub:record-saved').includes(email('opsLead')));
    const saves = (id: string) => [...new Set(seen.filter((s) => s.channel === 'hub:record-saved' && s.data.includes(id)).map((s) => s.user))].sort();
    ok('pushes: a save of HR\'s chart tells HR\'s editors only; of Ops\'s, Ops\'s Edit-level openers (not Can view, not ed)', JSON.stringify(saves(hr.visual)) === JSON.stringify([email('boss'), email('padmin')])
      && JSON.stringify(saves(ops.visual)) === JSON.stringify([email('boss'), email('opsLead'), email('padmin')]), `${saves(hr.visual)} | ${saves(ops.visual)}`);

    // Mentions: refused as a non-reader's, the picker, the notice.
    const say = (who: Person, ds: string, body: string) => W.call(who, 'comment:add', { projectId: P, target: { kind: 'dataset', id: ds }, body });
    const refusedWords = (await say('padmin', hr.ds, 'Hi @(nobodyatall@acme.test)')).body?.error;
    const toOps = await say('padmin', hr.ds, 'HRCANARY ping @(opsviewer@acme.test)');
    const toFin = await say('opsLead', ops.ds, 'Ops ping @(finviewer@acme.test)');
    ok('mentions: someone who cannot open the target is refused with a non-reader\'s words (opsViewer on HR, finViewer on Ops)', toOps.body?.ok === false && toOps.body.error === refusedWords && toFin.body?.ok === false && toFin.body.error === refusedWords, `${toOps.text.slice(0, 120)} | ${toFin.text.slice(0, 120)}`);
    const picker = async (who: Person, target?: { kind: string; id: string }) => ((await W.call(who, 'comment:mentionable', { projectId: P, q: '', ...(target ? { target } : {}) })).body?.people ?? []).map((p: { email: string }) => p.email);
    const [onHr, onOps, anywhere] = [await picker('padmin', { kind: 'dataset', id: hr.ds }), await picker('padmin', { kind: 'dataset', id: ops.ds }), await picker('padmin')];
    ok('mentions: the picker on HR offers no Ops member; on Ops it offers opsViewer; with no target, the project\'s readers', !onHr.includes(email('opsViewer')) && onOps.includes(email('opsViewer')) && anywhere.includes(email('opsViewer')), `${onHr} | ${onOps}`);
    seen.length = 0;
    const toBoss = await say('padmin', hr.ds, 'HRCANARY for @(boss@acme.test)');
    await notify.mentionsSettled();
    ok('mentions: a mention of an opener on HR is stored, and only they are told', toBoss.body?.ok === true && JSON.stringify(pushed('mentions:new')) === JSON.stringify([email('boss')]), JSON.stringify(pushed('mentions:new')));
    const sneaked = await unchecked(() => say('padmin', hr.ds, 'HRCANARY ping @(opsviewer@acme.test)'));
    ok('NEGATIVE CONTROL: with the folder checks off, the mention of opsViewer on HR is accepted', sneaked.body?.ok === true, sneaked.text.slice(0, 160));
    await notify.mentionsSettled();
    for (const c of (sneaked.body?.comments ?? []) as Array<{ id: string; body: string }>) if (c.body === 'HRCANARY ping @(opsviewer@acme.test)') await W.call('padmin', 'comment:delete', { projectId: P, id: c.id });

    // Recipients, resolved at send time.
    const to = { userIds: [W.uid.padmin, W.uid.opsViewer], teamIds: [W.teams.ops] };
    const message = { title: 'x', subtitle: [], note: '', kpis: [], visuals: [], link: null, footer: '' } as never;
    const audience = (d: Parameters<typeof emailChannel.audience>[1]) => W.as('boss', () => emailChannel.audience(to, d));
    const hrSub = await audience({ kind: 'dashboard', projectId: P, analysisId: hr.board, message });
    const hrAlert = await audience({ kind: 'alert', projectId: P, ruleId: hr.rule, message, anchor: { kind: 'dataset', id: hr.ds } });
    const opsSub = await audience({ kind: 'dashboard', projectId: P, analysisId: ops.board, message });
    ok('recipients: HR\'s subscription and alert emails resolve to no Ops address (padmin alone); Ops\'s reach Ops', JSON.stringify(hrSub) === JSON.stringify([email('padmin')]) && JSON.stringify(hrAlert) === JSON.stringify([email('padmin')])
      && opsSub.includes(email('opsViewer')) && opsSub.includes(email('opsEditorView')), `${hrSub} | ${hrAlert} | ${opsSub}`);
    const open = await unchecked(() => audience({ kind: 'dashboard', projectId: P, analysisId: hr.board, message }));
    ok('NEGATIVE CONTROL: with the folder checks off, HR\'s subscription email reaches Ops addresses', open.includes(email('opsViewer')), JSON.stringify(open));

    // Counts and "Your numbers": of what the caller opens.
    const counts = async (who: Person) => {
      const home = (await W.call(who, 'home:overview', { projectId: P })).body?.counts;
      const row = ((await W.call(who, 'projects:overview')).body as Array<{ id: string; datasets: number; dashboards: number }>).find((p) => p.id === P);
      return JSON.stringify([home?.datasets, home?.dashboards, home?.visuals, row?.datasets, row?.dashboards]);
    };
    const [mine, theirs, off] = [await counts('opsViewer'), await counts('padmin'), await unchecked(() => counts('opsViewer'))];
    ok('counts: Home and the switcher count what opsViewer opens (Orders and Plain; Ops and Everyone boards; Ops\'s two charts), padmin everything', mine === '[2,2,2,2,2]' && theirs === '[4,4,3,4,4]', `${mine} | ${theirs}`);
    ok('NEGATIVE CONTROL: with the folder checks off, opsViewer\'s counts take HR in', off !== mine && off === '[4,4,3,4,4]', off);
    const numbers = async () => (await W.call('opsViewer', 'numbers:get', { projectId: P })).text;
    const followed = await numbers();
    ok('"Your numbers": the HR metric and scorecard opsViewer followed show nowhere, not even as a choice', !H.CANARY.test(followed), followed.slice(0, 200));
    ok('NEGATIVE CONTROL: with the folder checks off, they are opsViewer\'s tiles again', H.CANARY.test(await unchecked(numbers)));
  } finally {
    sse.setFanOut(null);
  }

  // ── 10. MCP and the model's prompts ──────────────────────────────────
  const tokenOf = async (who: Person): Promise<string> => String((await W.call(who, 'tokens:create', { name: 'net', expiresInDays: 1 })).body?.token ?? '');
  const values: Record<string, unknown> = { project: P, dataset: hr.ds, metric: hr.metric, question: hr.verified, dashboard: hr.board, topic: W.topic, term: hr.term, sql: 'SELECT 1 AS one', limit: 10, encoding: { category: 'dept', values: [{ column: 'salary', aggregation: 'sum' }] }, name: 'net', format: 'html' };
  const toolCalls = registry.SERVER_COMMANDS.filter((c) => c.readOnly).map((c) => ({ name: String(c.tool), args: Object.fromEntries(Object.keys(c.args).filter((k) => k in values).map((k) => [k, values[k]])) }));
  const mcp = (token: string, name: string, args: object): Promise<string> => W.mcp(token, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  const [viewer, admin] = [await tokenOf('opsViewer'), await tokenOf('padmin')];
  const leaks: string[] = [];
  const carried: string[] = [];
  for (const t of toolCalls) {
    if (H.CANARY.test(await mcp(viewer, t.name, t.args))) leaks.push(t.name);
    if (H.CANARY.test(await mcp(admin, t.name, t.args))) carried.push(t.name);
  }
  ok(`MCP: none of ${toolCalls.length} read-only tools answers opsViewer's token with an HR canary`, toolCalls.length > 10 && leaks.length === 0, leaks.join(', '));
  ok('NEGATIVE CONTROL: padmin\'s token reads HR through the list and describe tools', ['list_datasets', 'describe_dataset', 'list_metrics', 'list_dashboards'].every((n) => carried.includes(n)), carried.join(', '));

  const prompts: string[] = [];
  const real = { ask: analyze.askCopilot, ready: execConfig.executionReady };
  (analyze as { askCopilot: unknown }).askCopilot = async (_prior: unknown, sent: string) => { prompts.push(sent); return { ok: true, text: 'Fine.', suggestedAction: { kind: 'none', intent: '' } }; };
  (execConfig as { executionReady: unknown }).executionReady = async () => true;
  try {
    const ask = async (who: Person, context: object): Promise<string> => {
      prompts.length = 0;
      const thread = (await W.call(who, 'copilot:newThread', { projectId: P })).body?.thread?.id;
      await W.call(who, 'copilot:ask', { projectId: P, threadId: thread, context, question: 'salaries by dept' });
      return prompts.join('\n');
    };
    const contexts: Array<[string, object]> = [['Home', { kind: '' }], ['Orders open', { kind: 'dataset', id: ops.ds }], ['Ops board open', { kind: 'analysis', id: ops.board }], ['HR\'s dataset by id', { kind: 'dataset', id: hr.ds }], ['the mixed topic', { kind: 'topic', id: W.topic }]];
    const sent: string[] = [];
    for (const [label, c] of contexts) if (H.CANARY.test(await ask('opsViewer', c))) sent.push(label);
    ok(`model prompts: none of opsViewer's ${contexts.length} asks sends the model an HR canary`, sent.length === 0, sent.join(', '));
    ok('NEGATIVE CONTROL: padmin\'s ask with HR\'s dataset open sends them', H.CANARY.test(await ask('padmin', { kind: 'dataset', id: hr.ds })));
  } finally {
    (analyze as { askCopilot: unknown }).askCopilot = real.ask;
    (execConfig as { executionReady: unknown }).executionReady = real.ready;
  }
}
