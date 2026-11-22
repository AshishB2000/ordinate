// Auto in Slack (docs/agent-router/00-design.md, phase 2), through the real worker and `directTarget`: a direct message asked
// by someone who may use two or more agents is answered by the agent its words match, with the reason handed to the handler
// (server-only `context.routed`); a channel's linked agent answers there whatever the words match. The `copilot:ask` handler is
// the suite's fake, which keeps what it was sent.
//
//   npm run build:ts && DATABASE_URL=… node scripts/test-agentRouteSlack.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import { slackWorld } from './slackHarness';

const store: typeof import('../src/server/slack/db') = require('../src/server/slack/db');

(async () => {
  const S = await slackWorld('slack route');
  if (!S) return;
  const { W, stub } = S;
  try {
    const mk = async (name: string, dataset: string): Promise<string> => {
      const t = await W.call('boss', 'topic:save', { projectId: W.P, topic: { name: `${name} topic`, datasets: [{ id: dataset }], metricIds: [], termIds: [] } });
      const topicId: string = t.body?.topic?.id ?? t.body?.id;
      const a = await W.call('boss', 'agent:save', { projectId: W.P, agent: { name, description: '', topicId, model: null, build: false, teamIds: [] } });
      if (a.body?.ok !== true) throw new Error('fixture: ' + a.text);
      return a.body.agent.id;
    };
    const plain = await mk('Plain agent', W.plain);
    const orders = await mk('Orders agent', W.orders);
    stub.channels.set('CTEAM', { id: 'CTEAM', members: [stub.team.botUser, 'U_BOSS'] });
    await store.setAgentChannels('acme', stub.team.id, W.P, orders, [{ id: 'CTEAM', name: 'team' }]);
    await S.link('boss');

    const dm = await S.deliver(S.dm('boss', 'plain figures please', { id: 'EvRoute1' }));
    const sent = S.asked.at(-1)?.payload;
    ok('Direct message: the agent its words match answers (the Plain agent), with the reason handed to the handler', dm?.status === 'done' && sent?.agentId === plain && /^Matched /.test(sent?.context?.routed ?? ''), JSON.stringify([dm?.status, sent]));
    const other = await S.deliver(S.dm('boss', 'orders by region', { id: 'EvRoute2' }));
    const sent2 = S.asked.at(-1)?.payload;
    ok('…and another question goes to the other agent', other?.status === 'done' && sent2?.agentId === orders, JSON.stringify(sent2));
    const ch = await S.deliver(S.mention('boss', 'plain figures please', { channel: 'CTEAM', ts: '1800000900.000100' }));
    const sent3 = S.asked.at(-1)?.payload;
    ok('Channel (negative control): the channel\'s linked agent answers whatever the words match, and no router reason rides along', ch?.status === 'done' && sent3?.agentId === orders && !sent3?.context?.routed, JSON.stringify(sent3));
  } finally {
    await S.close();
  }
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
}).finally(finish);
