// The agent router over the real index and the real access (docs/agent-router/00-design.md), on a scratch database
// (scripts/notifyHarness.ts: header sign-in, RPC over HTTP). Without DATABASE_URL: one skip line.
//
//   (a) who is routed among: Gus (in both agents' teams) is routed by the question; Fay (in one) has nothing to choose
//       between, so Auto does not apply and the other agent is never scored, named or offered; Vic (none) likewise —
//       NEGATIVE CONTROL: the same question, asked by Gus, does name that agent
//   (b) an editor and a project admin may use every agent, so they are routed among all
//   (c) a close call between the agents Gus may use offers exactly those, and an agent he may not use is not among them
//
//   npm run build:ts && DATABASE_URL=… node scripts/test-agentRouteAccess.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import { BOSS, ORG, show, withServer, type Identity } from './notifyHarness';

const projects: typeof import('../src/app/projects') = require('../src/app/projects');
const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
const topics: typeof import('../src/analysis/topics') = require('../src/analysis/topics');
const router: typeof import('../src/ipc/agentRoute') = require('../src/ipc/agentRoute');

const who = (local: string, role: Identity['user']['role'] = 'viewer'): Identity => ({ user: { email: `${local}@acme.test`, role }, org: { id: ORG } });

withServer('agent-route-access', {}, async (b) => {
  const must = async (as: string, channel: string, payload: unknown): Promise<any> => { // any: each channel's own reply
    const r = await b.as(as).call(channel, payload);
    if (r.status !== 200) throw new Error(`${channel} as ${as}: ${r.status} ${r.text.slice(0, 200)}`);
    return r.body;
  };
  const { P, INV, ORD } = await b.run(BOSS, async () => {
    const P = (await projects.createProject('Router access')).id;
    const inv = await datasets.saveDataset(P, { name: 'Invoices', sourceKind: 'csv', columns: [{ name: 'vendor', type: 'text' }, { name: 'amount', type: 'number' }], rows: [['Acme', 1]] });
    const ord = await datasets.saveDataset(P, { name: 'Orders', sourceKind: 'csv', columns: [{ name: 'region', type: 'text' }, { name: 'revenue', type: 'number' }], rows: [['West', 1]] });
    if (!inv || !ord) throw new Error('fixture not saved');
    return { P, INV: inv.id, ORD: ord.id };
  });
  const tFin = await b.run(BOSS, () => topics.saveTopic(P, { name: 'Finance', datasets: [{ id: INV }] }));
  const tSales = await b.run(BOSS, () => topics.saveTopic(P, { name: 'Sales', datasets: [{ id: ORD }] }));
  await b.provision('gus', 'fay', 'vic', 'ed', 'pam');
  const fin: string = (await must('boss', 'admin:createTeam', { name: 'Finance' })).id;
  const sal: string = (await must('boss', 'admin:createTeam', { name: 'Sales' })).id;
  for (const [team, who] of [[fin, 'gus'], [sal, 'gus'], [fin, 'fay']] as const) await must('boss', 'admin:teamMember', { teamId: team, userId: await b.uid(who), member: true });
  for (const v of ['gus', 'fay', 'vic']) await b.share(P, v, 'viewer');
  await b.share(P, 'ed', 'editor');
  await b.share(P, 'pam', 'admin');
  const save = async (name: string, description: string, topicId: string, teamId: string): Promise<string> => {
    const r = await must('boss', 'agent:save', { projectId: P, agent: { name, description, topicId, model: null, build: false, teamIds: [teamId] } });
    if (!r.ok) throw new Error(show(r));
    return r.agent.id;
  };
  const A = await save('Finance agent', 'Invoices and costs', tFin!.id, fin);
  const S = await save('Sales agent', 'Deals', tSales!.id, sal);
  const route = (local: string, role: Identity['user']['role'], question: string) => b.run(who(local, role), () => router.autoRoute(P, question, null, false));

  // ── (a) who is routed among ───────────────────────────────────────────────
  const gusRev = await route('gus', 'viewer', 'revenue by region');
  ok('Gus, in both teams: the question picks the Sales agent, with a reason', !!gusRev && 'agentId' in gusRev && gusRev.agentId === S && /^Matched /.test(gusRev.why ?? ''), show(gusRev));
  const gusInv = await route('gus', 'viewer', 'invoice amount by vendor');
  ok('…and another question picks the Finance agent', !!gusInv && 'agentId' in gusInv && gusInv.agentId === A, show(gusInv));
  const fayRev = await route('fay', 'viewer', 'revenue by region');
  ok('Fay, in one team: one agent to choose from, so Auto does not apply — and the Sales agent is never scored or named', fayRev === null, show(fayRev));
  const vicRev = await route('vic', 'viewer', 'revenue by region');
  ok('Vic, in none: nothing to choose from either', vicRev === null, show(vicRev));
  ok('NEGATIVE CONTROL: the same question, asked by Gus, does name that agent', JSON.stringify(gusRev).includes(S) === true && JSON.stringify(fayRev).includes(S) === false);

  // ── (b) an editor and a project admin ─────────────────────────────────────
  const edRev = await route('ed', 'editor', 'revenue by region');
  const pamInv = await route('pam', 'viewer', 'invoice amount by vendor');
  ok('an editor may use every agent, so is routed among them', !!edRev && 'agentId' in edRev && edRev.agentId === S, show(edRev));
  ok('…and so is a project admin', !!pamInv && 'agentId' in pamInv && pamInv.agentId === A, show(pamInv));

  // ── (c) a close call offers only agents the person may use ───────────────
  const close = await route('gus', 'viewer', 'invoices orders');
  ok('a close call: the agents Gus may use are offered, as buttons', !!close && 'choose' in close && close.choose.map((o) => o.id).sort().join() === [A, S].sort().join(), show(close));
  const none = await route('fay', 'viewer', 'invoices orders');
  ok('NEGATIVE CONTROL: Fay is offered nothing, and the Sales agent is not named', none === null && !JSON.stringify(none).includes('Sales agent'), show(none));
}).then(finish, (err) => {
  console.error(err);
  process.exitCode = 1;
  finish();
});
