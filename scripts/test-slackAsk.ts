// Ordinate in Slack through the REAL `copilot:ask` handler (no fake): a verified question asked word for word is answered by
// the app with no model, so a Slack question can run the whole path — authorize, the handler, the stored turn, the share
// policy, the check, the chart block. Proves what the fake cannot: the conversation is a NEW one for the asker with the
// channel's agent (never their latest web conversation), the stored turn names the datasets it showed, and the real card
// (its chartType and spec) draws as a Slack chart.
//
//   npm run build:ts && DATABASE_URL=… node scripts/test-slackAsk.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import { slackWorld } from './slackHarness';

const store: typeof import('../src/server/slack/db') = require('../src/server/slack/db');
const copilot: typeof import('../src/ai/copilot') = require('../src/ai/copilot');
const verified: typeof import('../src/ipc/verified') = require('../src/ipc/verified');
const { shows }: typeof import('../src/ipc/turnsOpen') = require('../src/ipc/turnsOpen');

(async () => {
  const S = await slackWorld('slack ask', { realAsk: true });
  if (!S) return;
  const { W, stub } = S;
  try {
    const spec = { datasetId: W.plain, category: 'qty', measures: [{ column: 'sales', aggregation: 'sum' as const }], filters: [], chartType: 'column', title: 'Sales by region' };
    const saved = await W.as('boss', () => verified.saveVerifiedQuestion(W.P, { question: 'Sales by region', spec }));
    if (!saved.ok) throw new Error('fixture: ' + JSON.stringify(saved));
    const agent: string = (await W.call('boss', 'agent:save', { projectId: W.P, agent: { name: 'Sales agent', topicId: null, model: null, build: false, teamIds: [] } })).body.agent.id;
    stub.channels.set('CTEAM', { id: 'CTEAM', members: [stub.team.botUser, 'U_BOSS'] });
    await store.setAgentChannels('acme', stub.team.id, W.P, agent, [{ id: 'CTEAM', name: 'team' }]);
    await S.link('boss');

    // The asker's own latest conversation in the app (no agent): Slack must not write into it.
    const web = (await W.as('boss', async () => {
      const t = await copilot.createThread(W.P);
      await copilot.appendTurn(W.P, { role: 'user', text: 'an earlier question in the app' }, t!.id);
      return t;
    }))!;

    const hist = (tid: string) => W.as('boss', () => copilot.loadHistory(W.P, tid));
    const agentOf = (tid: string) => W.as('boss', async () => (await copilot.threadFor(W.P, tid))?.agentId);

    const ch = await S.deliver(S.mention('boss', 'Sales by region', { channel: 'CTEAM', ts: '1800000700.000100' }));
    ok('Real handler: a verified question word for word is answered through Slack (no model) and posted', ch?.status === 'done' && ch.outcome === 'posted:A', JSON.stringify(ch));
    const tid: string = ch?.thread_id;
    ok('Conversation: a NEW one for the asker, not their latest web conversation', !!tid && tid !== web.id && (await hist(web.id)).length === 1);
    ok('Conversation: it carries the channel\'s agent (one agent per channel)', (await agentOf(tid)) === agent, String(await agentOf(tid)));
    const turn = [...(await hist(tid))].reverse().find((t) => t.role === 'assistant');
    ok('Stored turn: it names the dataset the answer showed (shows() is what the check reads)', !!turn && shows(turn).includes(W.plain), JSON.stringify(turn && shows(turn)));
    const posted = JSON.stringify(S.updated().at(-1));
    ok('Real card: its chartType and spec draw as a Slack chart block, and the title is the verified question\'s', /"data_visualization"/.test(posted) && /Sales by region/.test(posted) && /"type":"column"|"type":"bar"/.test(posted), posted.slice(0, 400));
    ok('Real card: the posted message carries no SQL text or path', !/SELECT|\.parquet|\/orgs\//i.test(posted));

    // The same data by a column with an EMPTY category (missing regions): Slack needs a label for every point, so it is a table, not a chart.
    const empty = await W.as('boss', () => verified.saveVerifiedQuestion(W.P, { question: 'Sales by missing region', spec: { ...spec, category: 'region', title: 'Sales by missing region' } }));
    if (!empty.ok) throw new Error('fixture: ' + JSON.stringify(empty));
    await S.deliver(S.mention('boss', 'Sales by missing region', { channel: 'CTEAM', ts: '1800000701.000100' }));
    const tbl = JSON.stringify(S.updated().at(-1));
    ok('Real card (negative control): a category with an empty label falls back to the table', /"type":"table"/.test(tbl) && !/"data_visualization"/.test(tbl), tbl.slice(0, 300));

    const dm = await S.deliver(S.dm('boss', 'Sales by region', { id: 'EvAsk2' }));
    const dmThread: string = dm?.thread_id;
    ok('Direct message: also a new conversation, and the app\'s own is untouched', dm?.outcome === 'posted:direct' && !!dmThread && dmThread !== web.id && dmThread !== tid && (await hist(web.id)).length === 1, JSON.stringify(dm));
    const mine = await W.as('boss', async () => (await copilot.threadFor(W.P, tid))?.id);
    ok('Conversation: the Slack conversation is the asker\'s own (readable as them)', mine === tid);
  } finally {
    await S.close();
  }
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
}).finally(finish);
