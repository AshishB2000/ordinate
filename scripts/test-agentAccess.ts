// Who may do what with an Assistant agent (docs/assistant-agents/00-design.md rules 3, 5, 7, 11, 12), on the real app
// over a scratch database (scripts/notifyHarness.ts: header sign-in, RPC over HTTP). Without DATABASE_URL: one skip line.
//
//   (a) use: Fay, in its team, lists it, has it preselected, starts a conversation with it, and the ask resolves it;
//       Vic, a viewer outside its teams, sees none, and the server refuses it — newThread over RPC and the ask's own
//       resolution (the Project assistant, with the line) — NEGATIVE CONTROL: the same calls as Fay succeed;
//       a project admin outside its teams may use it, to try it
//   (b) roles: a viewer (in its team or not) cannot save or delete one (403); an editor changes its instructions but
//       cannot save its teams, topic, model or build (403) nor restore it from the Trash — NEGATIVE CONTROL: the admin can
//   (c) a team or a model that is not the org's is refused; the agent's model answers while it is enabled in Admin → AI,
//       and the person's own once it is not
//   (d) conversations as rows: the agent is stored on the row (0024) and listed by name
//   (e) out of scope never names a dataset the caller cannot read (row rules give Vic none of it) — NEGATIVE CONTROL:
//       Fay, entitled, is offered it
//
//   npm run build:ts && DATABASE_URL=… node scripts/test-agentAccess.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import { BOSS, ORG, show, withServer, type Identity } from './notifyHarness';

const projects: typeof import('../src/app/projects') = require('../src/app/projects');
const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
const topics: typeof import('../src/analysis/topics') = require('../src/analysis/topics');
const access: typeof import('../src/ai/agentAccess') = require('../src/ai/agentAccess');
const msg: typeof import('../src/ai/agentMessages') = require('../src/ai/agentMessages');
const agentAsk: typeof import('../src/ipc/agentAsk') = require('../src/ipc/agentAsk');
const aiConfig: typeof import('../src/server/aiConfig') = require('../src/server/aiConfig');

const who = (local: string, role: Identity['user']['role'] = 'viewer'): Identity => ({ user: { email: `${local}@acme.test`, role }, org: { id: ORG } });

withServer('agent-access', {}, async (b) => {
  const must = async (as: string, channel: string, payload: unknown): Promise<any> => { // any: each channel's own reply
    const r = await b.as(as).call(channel, payload);
    if (r.status !== 200) throw new Error(`${channel} as ${as}: ${r.status} ${r.text.slice(0, 200)}`);
    return r.body;
  };
  const { P, INV, ORD } = await b.run(BOSS, async () => {
    const P = (await projects.createProject('Agents access')).id;
    const inv = await datasets.saveDataset(P, { name: 'Invoices', sourceKind: 'csv', columns: [{ name: 'vendor', type: 'text' }, { name: 'amount', type: 'number' }], rows: [['Acme', 1]] });
    const ord = await datasets.saveDataset(P, { name: 'Orders', sourceKind: 'csv', columns: [{ name: 'region', type: 'text' }, { name: 'revenue', type: 'number' }], rows: [['West', 1]] });
    if (!inv || !ord) throw new Error('fixture not saved');
    return { P, INV: inv.id, ORD: ord.id };
  });
  const topic = await b.run(BOSS, () => topics.saveTopic(P, { name: 'Finance', datasets: [{ id: INV }] }));
  await b.provision('fay', 'vic', 'ed', 'pam');
  const team: string = (await must('boss', 'admin:createTeam', { name: 'Finance' })).id;
  const other: string = (await must('boss', 'admin:createTeam', { name: 'Sales' })).id;
  await must('boss', 'admin:teamMember', { teamId: team, userId: await b.uid('fay'), member: true });
  await b.share(P, 'fay', 'viewer');
  await b.share(P, 'vic', 'viewer');
  await b.share(P, 'ed', 'editor');
  await b.share(P, 'pam', 'admin');

  const IN = { name: 'Finance assistant', description: 'Invoices and costs', topicId: topic!.id, model: null, build: false, teamIds: [team] };
  const saved = await must('boss', 'agent:save', { projectId: P, agent: IN });
  ok('the org admin saves an agent with a team', saved.ok === true, show(saved));
  const A: string = saved.agent?.id ?? '';

  // ── (a) use ───────────────────────────────────────────────────────────────
  const fayList = await must('fay', 'agent:list', { projectId: P });
  ok('Fay, in its team: listed, usable and preselected', fayList.ok && fayList.agents.length === 1 && fayList.agents[0].usable && fayList.preselected === A
    && fayList.agents[0].teams[0]?.name === 'Finance' && !fayList.canManage && !fayList.canInstruct && !('instructions' in fayList.agents[0]) && !('tag' in fayList.agents[0]), show(fayList));
  const fayThread = await must('fay', 'copilot:newThread', { projectId: P, agentId: A });
  ok('…starts a conversation with it', fayThread.ok && fayThread.thread.agentId === A, show(fayThread));
  const fayScope = await b.run(who('fay'), () => agentAsk.askScope(P, A));
  ok('…and the ask resolves it, narrowed to its topic', fayScope.agent?.id === A && fayScope.note === null && [...(fayScope.only ?? [])].join() === INV);
  const vicList = await must('vic', 'agent:list', { projectId: P });
  ok('Vic, a viewer outside its teams: none listed, none preselected', vicList.ok && vicList.agents.length === 0 && vicList.preselected === null, show(vicList));
  const vicThread = await must('vic', 'copilot:newThread', { projectId: P, agentId: A });
  ok('…a conversation with it is refused on the server', vicThread.ok === false && vicThread.error === msg.agentNotYours(), show(vicThread));
  const vicScope = await b.run(who('vic'), () => agentAsk.askScope(P, A));
  ok('…and an ask naming it is the Project assistant\'s, with the line (its topic, instructions and model never reach Vic)',
    vicScope.agent === null && vicScope.only === null && vicScope.note === msg.agentNotYours(), show(vicScope));
  const pamList = await must('pam', 'agent:list', { projectId: P });
  ok('a project admin outside its teams may use it, to try it — but nothing is preselected for her', pamList.agents[0]?.usable === true && pamList.canManage && pamList.preselected === null, show(pamList));
  const tokenScope = await b.run({ ...who('fay'), via: 'token' }, () => agentAsk.askScope(P, A));
  ok('a personal API token keeps the Project assistant (rule 13)', tokenScope.agent === null && tokenScope.note === null);

  // ── (b) roles ─────────────────────────────────────────────────────────────
  for (const v of ['vic', 'fay']) {
    const s = await b.as(v).call('agent:save', { projectId: P, id: A, agent: { ...IN, name: 'Mine now' } });
    const d = await b.as(v).call('agent:delete', { projectId: P, id: A });
    const i = await b.as(v).call('agent:instructions', { projectId: P, id: A, op: { kind: 'add', text: 'x' } });
    ok(`a viewer (${v}) cannot save, delete or instruct it (403)`, s.status === 403 && d.status === 403 && i.status === 403, `${s.status} ${d.status} ${i.status}`);
  }
  const edList = await must('ed', 'agent:list', { projectId: P });
  ok('an editor sees every agent with its instructions, not usable by him, and cannot manage', edList.agents.length === 1 && edList.agents[0].usable === false
    && Array.isArray(edList.agents[0].instructions) && !('tag' in edList.agents[0]) && edList.canInstruct && !edList.canManage, show(edList));
  const edI = await must('ed', 'agent:instructions', { projectId: P, id: A, op: { kind: 'add', text: 'Revenue means recognized revenue' } });
  ok('an editor changes its instructions', edI.ok === true && edI.instructions[0].text === 'Revenue means recognized revenue', show(edI));
  const edSaves = await Promise.all([
    b.as('ed').call('agent:save', { projectId: P, id: A, agent: { ...IN, teamIds: [team, other] } }),
    b.as('ed').call('agent:save', { projectId: P, id: A, agent: { ...IN, topicId: null } }),
    b.as('ed').call('agent:save', { projectId: P, id: A, agent: { ...IN, build: true } }),
    b.as('ed').call('agent:save', { projectId: P, agent: { ...IN, name: 'His own' } }),
    b.as('ed').call('agent:delete', { projectId: P, id: A }),
  ]);
  ok('…but not its teams, topic, build, a new agent or a delete (403)', edSaves.every((r) => r.status === 403), edSaves.map((r) => r.status).join());
  const pamSave = await must('pam', 'agent:save', { projectId: P, id: A, base: pamList.agents[0].tag, agent: { ...IN, build: true } });
  ok('NEGATIVE CONTROL: a project admin can', pamSave.ok === true, show(pamSave));
  await must('boss', 'agent:delete', { projectId: P, id: A });
  const edRestore = await must('ed', 'trash:restore', { projectId: P, type: 'agent', id: A });
  ok('an editor cannot bring it back from the Trash', edRestore.ok === false && edRestore.error === msg.agentRestoreAdminOnly(), show(edRestore));
  const pamRestore = await must('pam', 'trash:restore', { projectId: P, type: 'agent', id: A });
  ok('NEGATIVE CONTROL: a project admin can', pamRestore.ok === true && (await must('fay', 'agent:list', { projectId: P })).agents.length === 1, show(pamRestore));

  // ── (c) teams and models ──────────────────────────────────────────────────
  const strange = await must('boss', 'agent:save', { projectId: P, agent: { ...IN, name: 'Stray', teamIds: ['00000000-0000-4000-8000-000000000999'] } });
  ok('a team that is not the org\'s is refused', strange.ok === false && strange.field === 'teamIds', show(strange));
  await b.pool.query(`INSERT INTO org_ai_imports (org_id) VALUES ($1) ON CONFLICT DO NOTHING`, [ORG]);
  await b.pool.query(`INSERT INTO org_ai_providers (org_id, provider, base_url, verified_at) VALUES ($1, 'gateway', 'http://127.0.0.1:9', now())`, [ORG]);
  await b.pool.query(`INSERT INTO org_ai_models (org_id, provider, model, label, position, is_default) VALUES ($1, 'gateway', 'agent-model', 'Agent', 0, false), ($1, 'gateway', 'house-model', 'House', 1, true)`, [ORG]);
  const unknown = await must('boss', 'agent:save', { projectId: P, agent: { ...IN, name: 'Stray', model: { provider: 'gateway', model: 'not-enabled' } } });
  ok('a model not enabled in Admin → AI is refused', unknown.ok === false && unknown.field === 'model' && unknown.error === msg.agentModelNotEnabled(), show(unknown));
  const cur = (await must('boss', 'agent:list', { projectId: P })).agents[0];
  const withModel = await must('boss', 'agent:save', { projectId: P, id: A, base: cur.tag, agent: { ...IN, model: { provider: 'gateway', model: 'agent-model' } } });
  ok('NEGATIVE CONTROL: an enabled one is kept', withModel.ok === true, show(withModel));
  const used = await b.run(who('fay'), async () => {
    const scope = await agentAsk.askScope(P, A);
    return aiConfig.resolve(scope.agent?.model);
  });
  ok('the agent\'s model answers Fay while it is enabled', used.ok && used.model === 'agent-model', show(used));
  await b.pool.query(`DELETE FROM org_ai_models WHERE org_id = $1 AND model = 'agent-model'`, [ORG]);
  const fell = await b.run(who('fay'), async () => aiConfig.resolve((await agentAsk.askScope(P, A)).agent?.model));
  ok('…and once it is no longer enabled, the person\'s own (the default)', fell.ok && fell.model === 'house-model', show(fell));

  // ── (d) conversations as rows ─────────────────────────────────────────────
  const row = await b.pool.query<{ agent_id: string | null }>('SELECT agent_id::text FROM assistant_threads WHERE org_id = $1 AND id = $2', [ORG, fayThread.thread.id]);
  ok('the agent is stored on the conversation\'s row', row.rows[0]?.agent_id === A, show(row.rows));
  const threads = await must('fay', 'copilot:threads', { projectId: P });
  ok('…and listed by name', threads.ok && threads.threads.some((t: { id: string; agentId?: string; agentName?: string }) => t.id === fayThread.thread.id && t.agentId === A && t.agentName === 'Finance assistant'), show(threads));
  const pa = await must('fay', 'copilot:newThread', { projectId: P, agentId: null });
  const paRow = await b.pool.query<{ agent_id: string | null }>('SELECT agent_id::text FROM assistant_threads WHERE org_id = $1 AND id = $2', [ORG, pa.thread.id]);
  ok('NEGATIVE CONTROL: a Project assistant conversation stores none', paRow.rows[0]?.agent_id === null);
  ok('preselection follows the latest conversation: the Project assistant\'s names no agent, so the team\'s is next',
    (await must('fay', 'agent:list', { projectId: P })).preselected === A);

  // ── (e) out of scope never names what the caller cannot read ─────────────
  const rules = await must('boss', 'dataset:setRowPolicy', { projectId: P, datasetId: ORD, policy: { column: 'region', rules: [{ teamId: team, values: ['West'] }] } });
  ok('fixture: Orders has row rules giving the Finance team West', rules.ok !== false, show(rules));
  const only = new Set([INV]);
  const forVic = await b.run(who('vic'), () => agentAsk.matchOutside(P, 'revenue by region', only));
  const forFay = await b.run(who('fay'), () => agentAsk.matchOutside(P, 'revenue by region', only));
  ok('Vic, with no rows of Orders, is never offered it', forVic === null, show(forVic));
  ok('NEGATIVE CONTROL: Fay, entitled to some, is', forFay?.id === ORD, show(forFay));
  ok('…and Vic still never may use the agent at all', (await b.run(who('vic'), () => access.agentForAsk(P, A))).agent === null);
}).then(finish, (err) => {
  console.error(err);
  process.exitCode = 1;
  finish();
});
