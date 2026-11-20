// Ordinate in Slack, phase 2 (docs/slack/00-design.md, "Tests"): channels tied to agents, the unmapped reply, thread
// ownership, and THE CHECK — case A posts, case B needs every member linked, able to read, and seeing it exactly as the
// asker does; outsiders never get figures; a failed check leaks nothing; Share to channel repeats it. Against a local
// stub of Slack over a scratch Postgres (skips without DATABASE_URL).
//
//   npm run build:ts && DATABASE_URL=… node scripts/test-slackCheck.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import { slackWorld, sleep, until } from './slackHarness';

const store: typeof import('../src/server/slack/db') = require('../src/server/slack/db');
const say: typeof import('../src/server/slackMessages') = require('../src/server/slackMessages');

/** A message without its links and its own timestamp: the Open in Ordinate URL carries a question id, which has digits. */
const noUrl = (m: unknown): string => JSON.stringify(m).replace(/https?:\/\/[^"]+/g, '').replace(/"ts":"[^"]*"/g, '');

(async () => {
  const S = await slackWorld('slack check');
  if (!S) return;
  const { W, stub } = S;
  const base = `http://127.0.0.1:${(W.app.server.address() as import('net').AddressInfo).port}`;
  const TEAM = stub.team.id;
  try {
    // ── world: an agent, channels, people ─────────────────────────────────────
    const saved = await W.call('boss', 'agent:save', { projectId: W.P, agent: { name: 'Sales agent', topicId: null, model: null, build: false, teamIds: [W.team] } });
    const agent: string = saved.body.agent.id;
    const everyone = Object.values(S.slackId);
    const channel = (id: string, members: string[], o: object = {}) => { stub.channels.set(id, { id, name: id.toLowerCase(), members: [stub.team.botUser, ...members], ...o }); if (!stub.botChannels.includes(id)) stub.botChannels.push(id); };
    channel('CTEAM', everyone);
    channel('CEXT', ['U_BOSS'], { is_ext_shared: true });
    channel('CBOSS', ['U_BOSS']);
    channel('CBOSSEAST', ['U_BOSS', 'U_EAST']);
    channel('CEASTBOSS', ['U_BOSS', 'U_EAST']);
    stub.channels.set('CNOPE', { id: 'CNOPE', members: ['U_BOSS'] });
    // Two people with the SAME view of Orders (team East), and a guest and a stranger for the member checks.
    await W.call('east2', 'projects:list');
    await W.pool.query(`INSERT INTO team_members (team_id, user_id) SELECT $1, id FROM users WHERE email = 'east2@acme.test'`, [W.team]);
    stub.users.set('U_EAST2', { id: 'U_EAST2', team_id: TEAM });
    S.slackId.east2 = 'U_EAST2';
    stub.users.set('U_GUEST', { id: 'U_GUEST', team_id: TEAM, is_restricted: true });
    stub.users.set('U_STRANGER', { id: 'U_STRANGER', team_id: 'T_OTHER', is_stranger: true });
    for (const p of ['boss', 'east', 'east2']) await S.link(p);

    // ── the picker and the agent's channels ───────────────────────────────────
    const picked = await W.call('boss', 'agent:slackChannels', { projectId: W.P, agentId: agent, channels: [{ id: 'CTEAM' }, { id: 'CEXT' }, { id: 'CBOSS' }, { id: 'CBOSSEAST' }, { id: 'CEASTBOSS' }] });
    ok('Picker: channels the bot is in are tied to the agent', picked.body.ok && picked.body.channels.length === 5, picked.text);
    ok('Picker: a channel the bot is not in is refused (invite it first)', (await W.call('boss', 'agent:slackChannels', { projectId: W.P, agentId: agent, channels: [{ id: 'CNOPE' }] })).body.ok === false);
    ok('Picker: a viewer may not change an agent\'s channels', (await W.call('east', 'agent:slackChannels', { projectId: W.P, agentId: agent, channels: [] })).status === 403);
    const list = await W.call('boss', 'slack:channels', { projectId: W.P });
    ok('Picker: slack:channels lists the channels with the agent holding each', list.body.channels.find((c: { id: string }) => c.id === 'CTEAM')?.agentId === agent, list.text);

    // ── an unmapped channel ───────────────────────────────────────────────────
    const seen = S.asked.length;
    const unmapped = await S.deliver(S.mention('boss', 'orders?', { channel: 'CNOPE', ts: '1800000100.000100' }));
    const note = S.posted().at(-1);
    ok('Unmapped: a channel with no agent is told it is not connected yet, in its thread, and no project is guessed',
      unmapped?.status === 'done' && unmapped.outcome === 'unmapped' && note?.text === say.notConnected() && note?.thread_ts === '1800000100.000100' && S.asked.length === seen, JSON.stringify(unmapped));

    // ── case A: no restricted data → posted in the thread ─────────────────────
    S.answer = { text: 'Revenue was 4711 across 9 regions.', datasets: [W.plain] };
    const a1 = await S.deliver(S.mention('boss', 'revenue?', { channel: 'CTEAM', ts: '1800000200.000100' }));
    const posted = S.updated().at(-1);
    ok('Case A: an answer from unrestricted data is posted in the channel thread even with unlinked members present', a1?.outcome === 'posted:A' && /4711/.test(posted?.text ?? '') && stub.callsOf('conversations.open').length === 0, JSON.stringify(a1));
    ok('Case A: the answer was asked with the channel\'s agent and project', S.asked.at(-1)?.payload.agentId === agent && S.asked.at(-1)?.payload.projectId === W.P);
    ok('Case A: the first question in a thread creates its conversation, owned by the asker', (await store.threadOf(TEAM, 'CTEAM', '1800000200.000100'))?.askerEmail === 'boss@acme.test');

    // ── thread ownership ──────────────────────────────────────────────────────
    const t1 = await store.threadOf(TEAM, 'CTEAM', '1800000200.000100');
    await S.deliver(S.mention('boss', 'and last year?', { channel: 'CTEAM', ts: '1800000201.000100', thread_ts: '1800000200.000100' }));
    ok('Thread: the first asker\'s follow-up continues their conversation', S.asked.at(-1)?.payload.threadId === t1?.threadId, JSON.stringify(S.asked.at(-1)));
    await S.link('east');
    await S.deliver(S.mention('east', 'and the east?', { channel: 'CTEAM', ts: '1800000202.000100', thread_ts: '1800000200.000100' }));
    ok('Thread: another member\'s question in it is their own conversation, run as them', S.asked.at(-1)?.email === 'east@acme.test' && !!S.asked.at(-1)?.payload.threadId && S.asked.at(-1)?.payload.threadId !== t1?.threadId, JSON.stringify(S.asked.at(-1)));

    // ── outsiders: an externally shared channel never gets figures ────────────
    S.answer = { text: 'Revenue was 4711 across 9 regions.', datasets: [W.plain] };
    const nDm = stub.callsOf('conversations.open').length;
    const ext = await S.deliver(S.mention('boss', 'revenue?', { channel: 'CEXT', ts: '1800000300.000100' }));
    const extChan = S.updated().at(-1);
    ok('Outsiders: an is_ext_shared channel never gets figures, even from unrestricted data (case A)', ext?.outcome === 'private:external' && !/\d/.test(noUrl(extChan)) && !/Revenue/.test(JSON.stringify(extChan)), JSON.stringify(extChan));
    ok('Outsiders: the asker gets the full answer by direct message (never ephemeral), without a Share button',
      stub.callsOf('conversations.open').length === nDm + 1 && /4711/.test(JSON.stringify(S.posted().at(-1))) && !JSON.stringify(S.posted().at(-1)).includes('ord_share'));
    ok('Leaks: the channel note is the fixed sentence with an Open in Ordinate link, no model text and no figure', extChan?.text === say.sentPrivately() && /assistant\?slack=/.test(JSON.stringify(extChan)));
    ok('Outsiders: the full answer was not posted into the channel', !S.posted().some((p) => p.channel === 'CEXT' && /4711/.test(JSON.stringify(p))));

    // ── case B: row rules → every member must be linked and see it alike ──────
    S.answer = { text: 'Orders by region: East 41, West 38.', datasets: [W.orders] };
    const b = async (person: string, ch: string, ts: string) => S.deliver(S.mention(person, 'orders by region?', { channel: ch, ts }));
    const unl = await b('boss', 'CTEAM', '1800000400.000100');
    ok('Case B: an unlinked member makes it private (west, nobody and ed have not linked)', unl?.outcome === 'private:unlinked', JSON.stringify(unl));
    ok('Leaks: after a failed check the channel post contains no digit from the answer and no model text', !/\d|Orders by region/.test(noUrl(S.updated().at(-1))), JSON.stringify(S.updated().at(-1)));
    const adminAsks = await b('boss', 'CBOSSEAST', '1800000401.000100');
    ok('Case B: an admin asking with a restricted viewer present is private (the viewer would see less than the admin)', adminAsks?.outcome === 'private:different_view', JSON.stringify(adminAsks));
    const viewerAsks = await b('east', 'CEASTBOSS', '1800000402.000100');
    ok('Case B: a restricted viewer asking with an admin present is private (the admin would see partial figures that look like totals)', viewerAsks?.outcome === 'private:different_view', JSON.stringify(viewerAsks));
    const only = await b('boss', 'CBOSS', '1800000403.000100');
    ok('Case B: the asker alone in a channel passes', only?.outcome === 'posted:B', JSON.stringify(only));
    channel('CEAST2', ['U_EAST', 'U_EAST2']);
    await W.call('boss', 'agent:slackChannels', { projectId: W.P, agentId: agent, channels: ['CTEAM', 'CEXT', 'CBOSS', 'CBOSSEAST', 'CEASTBOSS', 'CEAST2'].map((id) => ({ id })) });
    const same = await b('east', 'CEAST2', '1800000404.000100');
    ok('Case B: passes when every member is linked, may read it, and every print is equal', same?.outcome === 'posted:B', JSON.stringify(same));
    channel('CBIG', Array.from({ length: 501 }, (_, i) => `U_X${i}`));
    await store.setAgentChannels('acme', TEAM, W.P, agent, [...(await store.channelsOfAgent('acme', W.P, agent)).map((c) => ({ id: c.channelId, name: c.channelName })), { id: 'CBIG', name: 'big' }]);
    const big = await b('boss', 'CBIG', '1800000405.000100');
    ok('Case B: more than 500 members is private', big?.outcome === 'private:too_many', JSON.stringify(big));
    channel('CSTR', ['U_BOSS', 'U_STRANGER']);
    channel('CGST', ['U_BOSS', 'U_GUEST']);
    const more = [...(await store.channelsOfAgent('acme', W.P, agent)).map((c) => ({ id: c.channelId, name: c.channelName })), { id: 'CSTR', name: 'str' }, { id: 'CGST', name: 'gst' }];
    await store.setAgentChannels('acme', TEAM, W.P, agent, more);
    ok('Case B: a person from another Slack organization in the channel makes it private', (await b('boss', 'CSTR', '1800000406.000100'))?.outcome === 'private:stranger');
    ok('Case B: a guest makes it private unless the org allows guests', (await b('boss', 'CGST', '1800000407.000100'))?.outcome === 'private:guest');
    await store.setSettings('acme', { allowGuests: true });
    ok('Case B (negative control): with guests allowed the same channel goes on to the next checks (an unlinked guest is still private)', (await b('boss', 'CGST', '1800000408.000100'))?.outcome === 'private:unlinked');
    await store.setSettings('acme', { allowGuests: false });

    // ── a direct message always passes ────────────────────────────────────────
    const dm = await S.deliver(S.dm('east', 'orders?', { id: 'EvDmB' }));
    ok('A direct message always passes, even from restricted data', dm?.outcome === 'posted:direct', JSON.stringify(dm));

    // ── a dashboard the question was read off makes it case B ─────────────────
    S.answer = { text: 'This dashboard says 12.', datasets: [W.plain], dashboards: ['11111111-1111-4111-8111-111111111111'] };
    ok('Dashboards: any dashboardsFrom is restricted data (an unlinked member makes it private)', (await S.deliver(S.mention('boss', 'dash?', { channel: 'CTEAM', ts: '1800000500.000100' })))?.outcome === 'private:unlinked');

    // ── Share to channel ──────────────────────────────────────────────────────
    S.answer = { text: 'Orders by region: East 41, West 38.', datasets: [W.orders] };
    const asked = await S.deliver(S.mention('boss', 'orders by region?', { channel: 'CTEAM', ts: '1800000600.000100' }));
    const press = (action: string, value: string, user = 'U_BOSS') => stub.send(base, '/api/slack/interactions', { type: 'block_actions', team: { id: TEAM }, user: { id: user }, channel: { id: 'D' + user }, actions: [{ action_id: action, value }] }, { form: true });
    ok('Share: the private answer offers Share to channel', /ord_share/.test(JSON.stringify(S.posted().at(-1))) && asked?.outcome === 'private:unlinked');
    await press('ord_share', `${asked?.id}:share`, 'U_EAST');
    await sleep(500);
    ok('Share: only the asker\'s own press counts', !(await S.questions()).some((q) => q.kind === 'share'));
    await press('ord_share', `${asked?.id}:share`);
    await until(async () => (await S.questions()).some((q) => q.kind === 'share' && q.status === 'done'));
    ok('Share: it repeats the check against the channel\'s current members — still unlinked, so refused', (await S.questions()).find((q) => q.kind === 'share')?.outcome === 'share_refused' && JSON.stringify(S.posted().at(-1)).includes(say.shareRefused()));
    ok('Share: a double press is one share', (await press('ord_share', `${asked?.id}:share`)).status === 200 && (await S.questions()).filter((q) => q.kind === 'share').length === 1);
    await store.setSettings('acme', { allowShareOverride: true });
    await W.pool.query(`DELETE FROM slack_questions WHERE kind = 'share'`);
    await press('ord_share', `${asked?.id}:share`);
    await until(async () => (await S.questions()).some((q) => q.kind === 'share' && q.status === 'done'));
    ok('Share: with the org\'s override on, the asker may post past the failed check', (await S.questions()).find((q) => q.kind === 'share')?.outcome === 'shared' && /East 41/.test(JSON.stringify(S.updated().at(-1))), JSON.stringify(S.updated().at(-1)));
    const extQ = (await S.questions()).find((q) => q.channel_id === 'CEXT');
    await W.pool.query(`DELETE FROM slack_questions WHERE kind = 'share'`);
    await press('ord_share', `${extQ?.id}:share`);
    await sleep(800);
    ok('Share (negative control): the override never applies to a channel shared with another company', !(await S.questions()).some((q) => q.kind === 'share' && q.outcome === 'shared'));
    await store.setSettings('acme', { allowShareOverride: false });

    // ── Share posts only while the asker's access is what it was ─────────────
    await W.call('east', 'projects:list');
    const eastAsked = await b('east', 'CTEAM', '1800000650.000100');
    ok('Share (setup): east\'s restricted answer went private (others unlinked)', eastAsked?.outcome === 'private:unlinked', JSON.stringify(eastAsked));
    await store.setSettings('acme', { allowShareOverride: true });
    await W.pool.query(`DELETE FROM slack_questions WHERE kind = 'share'`);
    const rules = (values: string[]) => W.call('boss', 'dataset:setRowPolicy', { projectId: W.P, datasetId: W.orders, policy: { column: 'region', rules: [{ teamId: W.team, values }, { userId: W.uid.west, values: ['West'] }] } });
    const narrowed = await rules(['North']); // east's rows change after the ask
    ok('Share (setup): the row rule changed', narrowed.body?.ok === true, narrowed.text);
    await press('ord_share', `${eastAsked?.id}:share`, 'U_EAST');
    await until(async () => (await S.questions()).some((q) => q.kind === 'share' && q.status === 'done'));
    ok('Share: an answer computed under access that has since narrowed is not posted, even with the override on', (await S.questions()).find((q) => q.kind === 'share')?.outcome === 'share_refused', JSON.stringify((await S.questions()).find((q) => q.kind === 'share')));
    await rules(['East']);
    await W.pool.query(`DELETE FROM slack_questions WHERE kind = 'share'`);
    await press('ord_share', `${eastAsked?.id}:share`, 'U_EAST');
    await until(async () => (await S.questions()).some((q) => q.kind === 'share' && q.status === 'done'));
    ok('Share (negative control): with the access unchanged the same press posts', (await S.questions()).find((q) => q.kind === 'share')?.outcome === 'shared');
    await store.setSettings('acme', { allowShareOverride: false });

    // ── feedback is stored with the answer ────────────────────────────────────
    await press('ord_feedback', `${asked?.id}:helpful`);
    await sleep(400);
    ok('Feedback: Helpful is stored with the answer', (await S.questions()).find((q) => q.id === asked?.id)?.feedback === 'helpful');
    await press('ord_feedback_no', `${asked?.id}:not_helpful`, 'U_EAST');
    await sleep(400);
    ok('Feedback: someone else\'s press is ignored', (await S.questions()).find((q) => q.id === asked?.id)?.feedback === 'helpful');
  } finally {
    await S.close();
  }
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
}).finally(finish);
