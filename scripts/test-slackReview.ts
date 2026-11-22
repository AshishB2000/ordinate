// Ordinate in Slack: the independent review's findings, each a test that FAILED on the code that was reviewed (its negative
// control) and passes now. Items are numbered as the review numbered them. Against a local stub of Slack over a scratch
// Postgres (skips without DATABASE_URL). The real `copilot:ask` runs in item 1 (the model stubbed, the prompt captured);
// every other item uses the harness's fake handler, which stores turns and snapshots as the real one does.
//
//   npm run build:ts && DATABASE_URL=… node scripts/test-slackReview.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import { slackWorld, sleep, until } from './slackHarness';
import * as fakeMod from './liveFakeConnector';

const store: typeof import('../src/server/slack/db') = require('../src/server/slack/db');
const say: typeof import('../src/server/slackMessages') = require('../src/server/slackMessages');
const rpc: typeof import('../src/server/rpc') = require('../src/server/rpc');
const answerMod: typeof import('../src/server/slack/answer') = require('../src/server/slack/answer');
const workerMod: typeof import('../src/server/slack/worker') = require('../src/server/slack/worker');
const appMod: typeof import('../src/server/app') = require('../src/server/app');
const analyze: typeof import('../src/ai/analyze') = require('../src/ai/analyze');
const execConfig: typeof import('../src/app/execConfig') = require('../src/app/execConfig');
const connections: typeof import('../src/connectors/connections') = require('../src/connectors/connections');
const sourceTables: typeof import('../src/app/sourceTables') = require('../src/app/sourceTables');
const datasetsMod: typeof import('../src/data/datasets') = require('../src/data/datasets');

const noUrl = (m: unknown): string => JSON.stringify(m).replace(/https?:\/\/[^"]+/g, '').replace(/"ts":"[^"]*"/g, '');

(async () => {
  const S = await slackWorld('slack review');
  if (!S) return;
  const { W, stub } = S;
  const TEAM = stub.team.id;
  const base = `http://127.0.0.1:${(W.app.server.address() as import('net').AddressInfo).port}`;
  const connectUrlOf = (): string => String((stub.callsOf('chat.postEphemeral').slice(-1)[0] ?? { params: { blocks: [0, { elements: [{ url: '' }] }] } }).params.blocks[1].elements[0].url);
  const pool = appMod.appPool() as import('pg').Pool;
  try {
    // ── world ─────────────────────────────────────────────────────────────────
    const agent: string = (await W.call('boss', 'agent:save', { projectId: W.P, agent: { name: 'Sales agent', topicId: null, model: null, build: false, teamIds: [W.team] } })).body.agent.id;
    const channel = (id: string, members: string[], o: object = {}) => { stub.channels.set(id, { id, name: id.toLowerCase(), members: [stub.team.botUser, ...members], ...o }); if (!stub.botChannels.includes(id)) stub.botChannels.push(id); };
    channel('CTEAM', Object.values(S.slackId));
    channel('CSOLO', ['U_BOSS']);
    channel('CMIX', ['U_BOSS', 'U_EAST', 'U_EAST2', 'U_WEST']);
    await W.call('east2', 'projects:list');
    await W.pool.query(`INSERT INTO team_members (team_id, user_id) SELECT $1, id FROM users WHERE email = 'east2@acme.test'`, [W.team]);
    stub.users.set('U_EAST2', { id: 'U_EAST2', team_id: TEAM });
    S.slackId.east2 = 'U_EAST2';
    await store.setAgentChannels('acme', TEAM, W.P, agent, ['CTEAM', 'CSOLO', 'CMIX'].map((id) => ({ id, name: id.toLowerCase() })));
    for (const p of ['boss', 'east', 'east2']) await S.link(p);
    const ask = (person: string, ch: string, text: string, o: { thread_ts?: string } = {}) => S.deliver(S.mention(person, text, { channel: ch, ts: `18001${Math.floor(Math.random() * 1e5)}.000100`, ...o }));
    const lastUpdate = () => JSON.stringify(S.updated().at(-1) ?? {});
    // A dataset with two marked columns, for the SQL aliasing and the title.
    const people = (await W.as('boss', () => datasetsMod.saveDataset(W.P, {
      name: 'People', sourceKind: 'csv', columns: [{ name: 'email', type: 'text' }, { name: 'phone', type: 'text' }, { name: 'n', type: 'number' }],
      rows: [['ann@x.test', '555-0101', 1], ['bob@x.test', '555-0102', 2]],
    })))!.id;
    for (const column of ['email', 'phone']) await W.call('boss', 'privacy:decide', { projectId: W.P, datasetId: people, column, level: 'personal' });
    await W.call('boss', 'privacy:decide', { projectId: W.P, datasetId: W.plain, column: 'customer', level: 'personal' });

    // ── 1. source-table answers never go to a channel, and Slack is never offered the tables ─────────────────
    // (a) the real handler, the model stubbed: the prompt of a Slack question carries no SOURCE TABLES; the same call without the flag does.
    fakeMod.registerLiveFake();
    await W.as('boss', () => fakeMod.loadWarehouseTable('review_returns', [{ name: 'reason', type: 'text' }, { name: 'amount', type: 'number' }], [['Late', 7]] as never));
    const conn = (await W.as('boss', () => connections.saveConnection(W.P, { name: 'Warehouse', connectorId: fakeMod.LIVE_FAKE_ID, values: {} })))!;
    await W.as('boss', async () => {
      const made = await sourceTables.createSourceDoc(W.P, conn.id, 'review_returns', {});
      if (!made.ok) throw new Error('fixture: a source doc');
      await sourceTables.updateSourceDoc(W.P, conn.id, made.docId, (d) => ({ ...d, facts: { columns: [{ name: 'reason', type: 'VARCHAR' }, { name: 'amount', type: 'DOUBLE' }], rowEstimate: 1, readAt: new Date().toISOString(), readBy: 'boss@acme.test' } }));
    });
    let prompt = '';
    (execConfig as { executionReady: unknown }).executionReady = async () => true;
    (execConfig as { assistantOn: unknown }).assistantOn = () => true;
    (analyze as { askCopilot: unknown }).askCopilot = async (_p: unknown, facts: string) => { prompt = facts; return { ok: true, text: 'Here it is.', suggestedAction: { kind: 'none', intent: '' } }; };
    rpc.registry.removeHandler('copilot:ask'); // the world's fake is replaced by the REAL handler for this block
    rpc.registry.handle('copilot:ask', S.realAsk);
    const handler = rpc.handlers.get('copilot:ask') as (e: unknown, p: unknown) => Promise<any>; // any: the handler's reply
    const asBoss = <T>(fn: () => Promise<T>): Promise<T> => W.as('boss', fn);
    const copilotMod: typeof import('../src/ai/copilot') = require('../src/ai/copilot');
    const thread = (await asBoss(() => copilotMod.createThread(W.P)))!.id;
    prompt = '';
    await asBoss(() => handler({}, { projectId: W.P, context: { kind: '' }, question: 'returns amount by reason', threadId: thread }));
    ok('1. (control) without the flag, an editor\'s Home question is offered the SOURCE TABLES block', prompt.includes('SOURCE TABLES') && prompt.includes('review_returns'), prompt.slice(0, 200));
    prompt = '';
    await asBoss(() => handler({}, { projectId: W.P, context: { kind: '', noSources: true }, question: 'returns amount by reason', threadId: thread }));
    ok('1. with the server-only flag the SOURCE TABLES block is left out', !prompt.includes('SOURCE TABLES') && !prompt.includes('review_returns'), prompt.slice(0, 200));
    const viaRpc = await W.call('boss', 'copilot:ask', { projectId: W.P, context: { kind: '', noSources: true }, question: 'x', threadId: thread });
    ok('1. an RPC caller cannot set the flag: the contract refuses it (it is not in the input)', viaRpc.status === 400 || viaRpc.status === 422 || /invalid/i.test(viaRpc.text), `${viaRpc.status} ${viaRpc.text.slice(0, 120)}`);
    // …and a Slack question goes through that same call: its prompt has none.
    prompt = '';
    await S.deliver(S.dm('boss', 'returns amount by reason', { id: 'EvSrc1' }));
    ok('1. a Slack question asked through ask.ts carries no SOURCE TABLES', !prompt.includes('SOURCE TABLES') && prompt.length > 0, prompt.slice(0, 200));
    rpc.registry.removeHandler('copilot:ask'); // back to the harness's fake for the rest
    rpc.registry.handle('copilot:ask', S.fakeAsk);
    // (b) belt and braces: an answer from a table is never posted in a channel, whatever the members may see.
    S.answer = { text: 'From a table: 7.', datasets: [W.plain], table: true, card: { ok: true, kind: 'sql', title: 'T', columns: [{ name: 'n', type: 'number' }], rows: [[7]], rowCount: 1, truncated: false, caption: '', bullets: [], datasets: ['Plain'], sql: 'SELECT n FROM t' } };
    const tbl = await ask('boss', 'CSOLO', 'from a table?');
    ok('1. (b) an answer from a source table is private even alone in the channel with open data', tbl?.outcome === 'private:source_table' && !/\b7\b/.test(noUrl(S.updated().at(-1))), JSON.stringify(tbl));

    // ── 2. replayed earlier turns are checked too ─────────────────────────────
    S.answer = { text: 'Orders by region: East 41.', datasets: [W.orders] };
    const q1 = await ask('boss', 'CTEAM', 'orders by region?');
    ok('2. (setup) Q1 on row-ruled data goes private', q1?.outcome === 'private:unlinked', JSON.stringify(q1));
    const root = q1?.thread_ts as string;
    S.answer = { text: 'There were 42 plain orders.', datasets: [W.plain] };
    const q2 = await ask('boss', 'CTEAM', 'and the plain ones?', { thread_ts: root });
    ok('2. Q2 on open data in the SAME thread is private: the model was replayed Q1\'s words', q2?.outcome === 'private:unlinked', JSON.stringify(q2));
    const q3 = await ask('boss', 'CTEAM', 'plain orders in a fresh thread?');
    ok('2. (control) the same open-data question in a NEW thread (nothing replayed) is posted', q3?.outcome === 'posted:A', JSON.stringify(q3));

    // ── 3. SQL: every renamed marked column is withheld ───────────────────────
    const sqlCard = (columns: string[], rows: unknown[][], sql: string) => ({ ok: true, kind: 'sql', title: 'People', columns: columns.map((name) => ({ name, type: 'text' })), rows, rowCount: rows.length, truncated: false, caption: '', bullets: [], datasets: ['People'], sql });
    S.answer = { text: 'Contacts.', datasets: [people], card: sqlCard(['email', 'contact'], [['ann@x.test', '555-0101']], 'SELECT email, phone AS contact FROM People') };
    await S.deliver(S.dm('boss', 'contacts?', { id: 'EvSql1' }));
    const alias = lastUpdate();
    ok('3. `SELECT email, phone AS contact`: a marked column named in the result must not hide the renamed one — nothing of either is posted', !/ann@x|555-01|bob@x/.test(alias), alias.slice(0, 300));

    // ── 4. a masked card's title is not the model's ───────────────────────────
    const chartCard = (title: string, category: string, labels: string[]) => ({
      ok: true, title, chartType: 'column', caption: '', headline: [], bullets: [], spec: { datasetId: W.plain, category, measures: [{ column: 'sales', aggregation: 'sum' }] }, data: { labels, series: [{ name: 'Sum of sales', values: [5, 9] }] },
    });
    S.answer = { text: 'Sales by customer.', datasets: [W.plain], card: chartCard('Sales for customer c1', 'customer', ['c1', 'c2']) };
    await S.deliver(S.dm('boss', 'sales by customer?', { id: 'EvTitle1' }));
    ok('4. when the share policy masked the card, the model\'s title (which quoted c1) is a fixed one', !/Sales for customer/.test(lastUpdate()) && lastUpdate().includes(`*${say.maskedTitle()}*`), lastUpdate().slice(0, 300));

    // ── 9. the sentence can cite a marked column's values ─────────────────────
    S.answer = { text: 'Customer c1 bought the most.', datasets: [W.plain], card: chartCard('Sales by region', 'region', ['East', 'West']) };
    await S.deliver(S.dm('boss', 'who bought most?', { id: 'EvSent1' }));
    ok('9. a dataset with a marked column and an acting policy: the model\'s sentence is replaced by the fixed caption, the card (untouched) stays', !/Customer c1|bought the most/.test(lastUpdate()) && lastUpdate().includes('hidden by the project') && /"data_visualization"/.test(lastUpdate()), lastUpdate().slice(0, 300));
    await W.call('boss', 'privacy:setPolicy', { projectId: W.P, policy: { slack: 'include' } });
    await S.deliver(S.dm('boss', 'who bought most again?', { id: 'EvSent2' }));
    ok('9. (control) with the policy on `include` the sentence is posted', /bought the most/.test(lastUpdate()), lastUpdate().slice(0, 200));
    await W.call('boss', 'privacy:setPolicy', { projectId: W.P, policy: { slack: 'mask' } });

    // ── 10. no copy of the card is kept ───────────────────────────────────────
    // Ids and hashes are random hex: a figure like 1784 can sit inside one by chance (a ~1% flake), so they are stripped before the scan.
    const kept = JSON.stringify((await W.pool.query(`SELECT answer FROM slack_questions WHERE answer IS NOT NULL`)).rows).replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{64}/gi, 'ID');
    ok('10. slack_questions keeps ids and names only: no card, no figure, no category label', !/series|labels|values|East|West|1784|"rows"|"card"/.test(kept) && kept.includes('turnId'), kept.slice(0, 300));
    S.answer = { text: 'Orders by region: East 41.', datasets: [W.orders], card: chartCard('Orders', 'region', ['East', 'West']) };
    const toShare = await ask('boss', 'CMIX', 'orders?');
    await store.setSettings('acme', { allowShareOverride: true });
    await W.pool.query(`DELETE FROM slack_questions WHERE kind = 'share'`);
    await stub.send(base, '/api/slack/interactions', { type: 'block_actions', team: { id: TEAM }, user: { id: 'U_BOSS' }, channel: { id: 'DU_BOSS' }, actions: [{ action_id: 'ord_share', value: `${toShare?.id}:share` }] }, { form: true });
    await until(async () => (await S.questions()).some((x) => x.kind === 'share' && x.status === 'done'));
    ok('10. Share to channel re-reads the stored turn and its snapshot (no kept card): the shared message has the chart', (await S.questions()).find((x) => x.kind === 'share')?.outcome === 'shared' && /"data_visualization"/.test(lastUpdate()), lastUpdate().slice(0, 200));
    await store.setSettings('acme', { allowShareOverride: false });

    // ── 12. an out-of-scope reply is never posted in a channel ────────────────
    S.answer = { text: 'That is outside this assistant; try Orders.', datasets: [W.plain], outside: true };
    const out = await ask('boss', 'CSOLO', 'something else?');
    ok('12. an `outside` turn goes private even alone in the channel; its words are not in the channel', out?.outcome === 'private:outside' && !/outside this assistant/.test(noUrl(S.updated().at(-1))), JSON.stringify(out));

    // ── 5. tokens_revoked: only the BOT token switches the install off ────────
    const revoke = (tokens: object) => stub.send(base, '/api/slack/events', { type: 'event_callback', team_id: TEAM, event_id: `EvRev${Math.random()}`, event: { type: 'tokens_revoked', tokens } });
    await revoke({ oauth: ['U_EAST'] });
    await sleep(300);
    ok('5. a person\'s user token revoked leaves the install on (negative control for the bot case below)', (await store.installByOrg('acme'))?.enabled === true);
    ok('5. …and drops only that person\'s link', !(await store.linkedEmail('acme', TEAM, 'U_EAST')) && !!(await store.linkedEmail('acme', TEAM, 'U_BOSS')));
    await S.link('east');
    await revoke({ bot: ['UOTHERBOT'], oauth: [] });
    await sleep(300);
    ok('5. a revoked bot token of ANOTHER app does not switch it off', (await store.installByOrg('acme'))?.enabled === true);
    await revoke({ bot: [stub.team.botUser] });
    await until(async () => (await store.installByOrg('acme'))?.enabled === false, 5000);
    ok('5. the install\'s own bot token revoked switches it off', (await store.installByOrg('acme'))?.enabled === false);
    await store.setSettings('acme', { enabled: true });

    // ── 6. a channel another project holds ────────────────────────────────────
    const P2: string = (await W.call('boss', 'projects:create', { name: 'Finance' })).body.id;
    const agent2: string = (await W.call('boss', 'agent:save', { projectId: P2, agent: { name: 'Finance agent', topicId: null, model: null, build: false, teamIds: [] } })).body.agent.id;
    channel('CFIN', ['U_BOSS']);
    await store.setAgentChannels('acme', TEAM, P2, agent2, [{ id: 'CFIN', name: 'finance' }]);
    await W.call('pa', 'projects:list');
    const paId = (await W.pool.query<{ id: string }>(`SELECT id::text FROM users WHERE email = 'pa@acme.test'`)).rows[0].id;
    await W.call('boss', 'project:share', { projectId: W.P, member: { userId: paId }, role: 'admin' });
    const steal = await W.call('pa', 'agent:slackChannels', { projectId: W.P, agentId: agent, channels: [{ id: 'CFIN' }] });
    ok('6. an admin of project 1 cannot take #finance from project 2\'s agent', steal.body?.ok === false && (await store.channelAgent(TEAM, 'CFIN'))?.projectId === P2, JSON.stringify(steal.body));
    const seen = await W.call('pa', 'slack:channels', { projectId: W.P });
    const row = seen.body.channels.find((c: { id: string }) => c.id === 'CFIN');
    ok('6. the picker shows only "used by another project", never that project\'s or its agent\'s id', row?.usedElsewhere === true && !JSON.stringify(seen.body).includes(P2) && !JSON.stringify(seen.body).includes(agent2), JSON.stringify(row));
    const moved = await W.call('boss', 'agent:slackChannels', { projectId: W.P, agentId: agent, channels: [{ id: 'CFIN' }] });
    ok('6. (control) an org admin may move it', moved.body?.ok === true && (await store.channelAgent(TEAM, 'CFIN'))?.projectId === W.P, JSON.stringify(moved.body));

    await store.setAgentChannels('acme', TEAM, W.P, agent, ['CTEAM', 'CSOLO', 'CMIX'].map((id) => ({ id, name: id.toLowerCase() }))); // (the control replaced the agent's set)

    // ── 7. a retaken question does not ask twice, deliver twice, or DM twice ──
    workerMod.pauseForTest(true);
    S.answer = { text: 'Orders by region: East 41.', datasets: [W.orders] };
    const enqueue = async (id: string, text: string) => {
      await stub.send(base, '/api/slack/events', S.mention('boss', text, { channel: 'CTEAM', ts: `18002${id}.000100`, id: `EvRetake${id}` }));
      await until(async () => (await S.questions()).some((x) => x.text === text));
      return (await S.questions()).find((x) => x.text === text) as Record<string, any>; // any: a row
    };
    const lapse = (id: string) => W.pool.query(`UPDATE slack_questions SET lease_until = now() - interval '1 second' WHERE id = $1`, [id]);
    const run = async (owner: string, signal = new AbortController().signal) => { const c = await store.claim(owner, 60_000); if (c) await answerMod.processQuestion(pool, c, owner, signal); return c; };
    // (i) dies after the ask, before anything is posted
    const a = await enqueue('01', 'crash after the ask');
    const askedBefore = S.asked.length;
    stub.fail = { method: 'chat.update', times: 1 };
    await run('pod-a').catch(() => undefined); // the ask ran and was stored; the first update failed
    await lapse(a.id);
    const dmsBefore = stub.callsOf('conversations.open').length;
    await run('pod-b');
    ok('7. after a crash that followed the ask, the retake does NOT ask again (one model call, one turn) and delivers', S.asked.length === askedBefore + 1 && (await S.questions()).find((x) => x.id === a.id)?.status === 'done', JSON.stringify({ asked: S.asked.length - askedBefore }));
    ok('7. …and the private answer is sent once', stub.callsOf('conversations.open').length === dmsBefore + 1);
    // (ii) dies after everything was delivered, before it was marked finished
    const b = await enqueue('02', 'crash after delivery');
    await run('pod-c');
    const dmsDone = stub.callsOf('conversations.open').length;
    const postsDone = S.posted().length;
    const askedDone = S.asked.length;
    await W.pool.query(`UPDATE slack_questions SET status = 'running', lease_owner = 'pod-c', lease_until = now() - interval '1 second', finished_at = NULL WHERE id = $1`, [b.id]);
    await run('pod-d');
    ok('7. after a crash that followed the delivery, the retake only finishes: no second ask, no second post, no second direct message',
      S.asked.length === askedDone && stub.callsOf('conversations.open').length === dmsDone && S.posted().length === postsDone && (await S.questions()).find((x) => x.id === b.id)?.status === 'done');
    // (iii) the lease is lost: work stops
    const c = await enqueue('03', 'lease lost');
    const ac = new AbortController();
    ac.abort(new answerMod.LeaseLost());
    const claimed = await store.claim('pod-e', 60_000);
    const stopped = await answerMod.processQuestion(pool, claimed as never, 'pod-e', ac.signal).then(() => false, (e) => e instanceof answerMod.LeaseLost);
    ok('7. a lost lease stops the work before any post', stopped && !S.posted().some((p) => /lease lost/.test(JSON.stringify(p))) && claimed?.id === c.id);
    ok('7. the heartbeat reports a lease that is not this owner\'s as lost', (await store.heartbeat(c.id, 'someone-else')) === false);
    await W.pool.query(`DELETE FROM slack_questions WHERE id = $1`, [c.id]);
    workerMod.pauseForTest(false);

    // ── 8. a time limit and the per-user budget ───────────────────────────────
    S.setLimits({ timeoutMs: 300, perMinute: 1200 });
    const askedSlow = S.asked.length;
    rpc.registry.removeHandler('copilot:ask');
    rpc.registry.handle('copilot:ask', async () => { await sleep(3000); return { ok: false }; });
    const slow = await S.deliver(S.dm('boss', 'a slow one', { id: 'EvSlow' }));
    ok('8. a Slack ask runs under the RPC time limit: past it, a fixed sentence', slow?.outcome === 'timeout' && S.updated().at(-1)?.text === say.timedOut(), JSON.stringify(slow));
    rpc.registry.removeHandler('copilot:ask');
    rpc.registry.handle('copilot:ask', S.fakeAsk);
    S.setLimits({ timeoutMs: 120_000, perMinute: 2 });
    S.answer = { text: 'ok 1', datasets: [W.orders] };
    const calls = S.asked.length;
    for (let i = 0; i < 4; i++) await S.deliver(S.dm('east2', `budget ${i}`, { id: `EvBud${i}` }));
    ok('8. the per-user budget (RPC\'s) holds Slack too: over it, a fixed sentence and the handler is not called', S.asked.length - calls === 2 && S.updated().at(-1)?.text === say.tooBusy(), `${S.asked.length - calls} ${S.updated().at(-1)?.text}`);
    S.setLimits({ timeoutMs: 120_000, perMinute: 1200 });
    void askedSlow;

    // ── nits ──────────────────────────────────────────────────────────────────
    S.answer = { text: 'fine', datasets: [W.orders] };
    // the same agent for a viewer outside its teams: refused as copilot:newThread refuses it
    await S.link('west');
    const refusedAgent = await ask('west', 'CTEAM', 'a viewer outside the agent\'s teams');
    ok('nit: a Slack ask with an agent the asker may not use is refused like copilot:newThread (a fixed sentence, no handler call)', refusedAgent?.outcome === 'agent' && S.updated().at(-1)?.text === say.agentNotYours(), JSON.stringify(refusedAgent));
    // a temporary password
    await W.pool.query(`UPDATE users SET must_change_password = true WHERE email = 'east@acme.test'`);
    const askedPw = S.asked.length;
    const pw = await S.deliver(S.dm('east', 'with a temporary password', { id: 'EvPw' }));
    ok('nit: a person who must change their password gets a fixed sentence and no answer', pw?.outcome === 'change_password' && S.asked.length === askedPw, JSON.stringify(pw));
    await W.pool.query(`UPDATE users SET must_change_password = false WHERE email = 'east@acme.test'`);
    // member checks: an unlinked member is found before users.info is asked of each linked one
    S.answer = { text: 'Orders East 41.', datasets: [W.orders] };
    await store.deleteLinkOf(TEAM, 'U_WEST');
    stub.calls.length = 0;
    const fast = await ask('boss', 'CMIX', 'orders for the mix?');
    ok('nit: the links are read first: the unlinked member fails the check after ONE users.info call, not one per member', fast?.outcome === 'private:unlinked' && stub.callsOf('users.info').length === 1, String(stub.callsOf('users.info').length));
    // a project that is archived stops answering its channels
    await W.call('boss', 'projects:archive', { id: P2, archived: true });
    await store.setAgentChannels('acme', TEAM, P2, agent2, [{ id: 'CFIN', name: 'finance' }]);
    const gone = await ask('boss', 'CFIN', 'to an archived project');
    ok('nit: a channel tied to an archived project is "not connected yet", and its mapping is dropped', gone?.outcome === 'unmapped' && !(await store.channelAgent(TEAM, 'CFIN')), JSON.stringify(gone));
    // an unpressed Connect button: the parked question is dropped with its words when the state expires
    await store.setSettings('acme', { enabled: true });
    stub.users.set('U_NEW', { id: 'U_NEW', team_id: TEAM });
    const parked = await S.deliver({ type: 'event_callback', team_id: TEAM, event_id: 'EvPark', event: { type: 'message', channel_type: 'im', user: 'U_NEW', text: 'a secret question', channel: 'DU_NEW', ts: '1800000999.000200' } });
    ok('nit: (setup) an unknown person\'s question is parked', parked?.status === 'awaiting_link');
    await W.pool.query(`UPDATE slack_link_states SET expires_at = now() - interval '1 minute' WHERE question_id = $1`, [parked?.id]);
    await store.sweep('acme');
    const parkedNow = (await S.questions()).find((x) => x.id === parked?.id);
    ok('nit: when its Connect state expires the parked question is dropped and its text is not kept', parkedNow?.status === 'dropped' && parkedNow.text === '', JSON.stringify(parkedNow));
    // Connect tokens are stored as hashes only
    const tok = new URL(connectUrlOf()).searchParams.get('s') as string;
    ok('nit: only the sha256 of a Connect token is stored (the raw token finds no row)', (await W.pool.query(`SELECT 1 FROM slack_link_states WHERE token_hash = $1`, [tok])).rowCount === 0 && (await W.pool.query(`SELECT 1 FROM slack_link_states WHERE token_hash = $1`, [store.stateHash(tok)])).rowCount === 1);
    // the id_token's signature is verified against Slack's keys
    await S.deliver({ type: 'event_callback', team_id: TEAM, event_id: 'EvSig', event: { type: 'message', channel_type: 'im', user: 'U_NEW', text: 'sig', channel: 'DU_NEW', ts: '1800000998.000200' } });
    const tok2 = new URL(connectUrlOf()).searchParams.get('s') as string;
    await W.call('boss', 'projects:list');
    const go = await W.app.inject({ method: 'GET', url: `/api/slack/connect?s=${tok2}`, headers: { 'x-forwarded-email': 'boss@acme.test' }, remoteAddress: '127.0.0.1' });
    stub.oauth.signInAs = { userId: 'U_NEW', teamId: TEAM };
    stub.badSignature = true;
    const back = new URL((await fetch(String(go.headers.location), { redirect: 'manual' })).headers.get('location') as string);
    const forged = await W.app.inject({ method: 'GET', url: back.pathname + back.search });
    ok('nit: an id_token signed by a key Slack\'s JWKS does not list is refused, and nothing is linked', /slack=slack/.test(String(forged.headers.location)) && !(await store.linkedEmail('acme', TEAM, 'U_NEW')), String(forged.headers.location));
    stub.badSignature = false;
    // the worker idles while no workspace is on
    await store.setSettings('acme', { enabled: false });
    await W.pool.query(`INSERT INTO slack_questions (id, org_id, team_id, channel_id, channel_type, slack_user_id, text) VALUES (gen_random_uuid(), 'acme', $1, 'DU_BOSS', 'im', 'U_BOSS', 'idle')`, [TEAM]);
    workerMod.pauseForTest(false);
    const w = workerMod.latestForTest() as import('../src/server/slack/worker').SlackWorker;
    await w.tick();
    await w.tick();
    ok('nit: with no workspace switched on the worker claims nothing', (await W.pool.query(`SELECT attempts, status FROM slack_questions WHERE text = 'idle'`)).rows[0].attempts === 0);
    await store.setSettings('acme', { enabled: true });
    await W.pool.query(`DELETE FROM slack_questions WHERE text = 'idle'`);
  } finally {
    await S.close();
  }
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
}).finally(finish);
