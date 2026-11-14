// Assistant agents, the record (docs/assistant-agents/00-design.md, "Record"): real modules over a temp DATA_DIR and
// the real RPC route (dev sign-in, no database).
//
//   § sanitize   one shape, idempotent; a bad id, team, provider or order dropped; a corrupt file skipped, never fatal
//   § store      saved at the end of the list, stamped; the name rules (unique ignoring case, never "Project assistant");
//                a topic that is not there, and with no database any model or team, refused; the cap at 50
//   § conflict   a stale base is a 409 — NEGATIVE CONTROL: the open tag saves; an instruction change does not move the
//                settings' tag (an editor never 409s an admin) — NEGATIVE CONTROL: a settings change does
//   § instructions  add, edit, remove by the project instructions' rules: the fence refused, the 41st refused in the agent's words
//   § trash      agent:delete → the Trash, named → restore brings it back whole; the bundle carries agents
//   § preselect  the latest conversation's agent while usable; else the first, in list order, of the caller's teams —
//                a person in two teams gets the first; else the Project assistant
//
//   npm run build:ts && node scripts/test-agents.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import { withCsrf } from './csrfPair';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-agents-'));

const context: typeof import('../src/server/context') = require('../src/server/context');
const appMod: typeof import('../src/server/app') = require('../src/server/app');
const envMod: typeof import('../src/server/env') = require('../src/server/env');
const wire: typeof import('../src/server/wire') = require('../src/server/wire');
const agents: typeof import('../src/ai/agents') = require('../src/ai/agents');
const access: typeof import('../src/ai/agentAccess') = require('../src/ai/agentAccess');
const msg: typeof import('../src/ai/agentMessages') = require('../src/ai/agentMessages');
const instrMsg: typeof import('../src/app/instructionMessages') = require('../src/app/instructionMessages');
const topics: typeof import('../src/analysis/topics') = require('../src/analysis/topics');
const trash: typeof import('../src/app/trash') = require('../src/app/trash');
const editConflict: typeof import('../src/app/editConflict') = require('../src/app/editConflict');
const bundleRules: typeof import('../src/app/bundleRules') = require('../src/app/bundleRules');
const appPaths: typeof import('../src/app/paths') = require('../src/app/paths');
const { stableStringify }: typeof import('../src/engine/queryCache') = require('../src/engine/queryCache');

type Identity = import('../src/server/context').Identity;
type Agent = import('../src/ai/agents').Agent;
const ADMIN: Identity = { user: { email: 'ana@acme.test', role: 'admin' }, org: { id: 'acme' } };
const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const caught = async (f: () => Promise<unknown>): Promise<unknown> => f().then(() => null, (e: unknown) => e);

(async () => {
  context.enterServerMode(DATA);
  appMod.registerHandlers();
  const app = appMod.buildApp(envMod.parseEnv({ AUTH_MODE: 'dev', LOG_LEVEL: 'silent', DATA_DIR: DATA }), undefined, () => ADMIN);
  type Reply = { status: number; text: string; body: any }; // any: each channel's own reply
  const call = async (channel: string, payload: unknown): Promise<Reply> => {
    const r = await app.inject({
      method: 'POST', url: `/api/rpc/${encodeURIComponent(channel)}`,
      headers: withCsrf({ 'content-type': 'application/json' }), payload: wire.encode({ args: [payload] }),
    });
    let body: unknown = null;
    try { body = r.statusCode === 200 ? wire.decode(r.body) : JSON.parse(r.body); } catch { body = null; }
    return { status: r.statusCode, text: r.body, body };
  };
  const as = <T>(fn: () => Promise<T>): Promise<T> => context.runInContext(ADMIN, 'agents', fn);
  const projects: typeof import('../src/app/projects') = require('../src/app/projects');
  const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');

  const { P, TOPIC } = await as(async () => {
    await projects.init();
    const P = (await projects.createProject('Agents')).id;
    const d = await datasets.saveDataset(P, { name: 'Invoices', sourceKind: 'csv', columns: [{ name: 'amount', type: 'number' }], rows: [[1]] });
    if (!d) throw new Error('fixture not saved');
    const t = await topics.saveTopic(P, { name: 'Finance', datasets: [{ id: d.id }] });
    if (!t) throw new Error('topic not saved');
    return { P, TOPIC: t.id };
  });
  const IN = { name: 'Finance assistant', description: 'Invoices, costs and payroll', topicId: TOPIC, model: null, build: false, teamIds: [] };

  // ── § sanitize ────────────────────────────────────────────────────────────
  {
    const raw = {
      id: uuid(1), name: '  Finance\n  assistant ', topicId: 'nope', model: { provider: 'acme-ai', model: 'x' }, build: 'yes', order: -3,
      teamIds: [uuid(9).toUpperCase(), uuid(9), 'team-x'], instructions: [{ id: uuid(2), text: 'Our year\nstarts in February' }, { id: 'bad', text: 'dropped' }], extra: 1,
    };
    const once = agents.sanitizeAgent(raw, P);
    ok('sanitize: one line, a bad topic, provider, build and order dropped, teams deduped lowercase, junk keys gone',
      once.name === 'Finance assistant' && once.topicId === null && once.model === null && once.build === false && once.order === 0
      && stableStringify(once.teamIds) === stableStringify([uuid(9)]) && once.instructions.length === 1 && once.instructions[0].text === 'Our year starts in February'
      && !('extra' in once) && once.schemaVersion === 1, JSON.stringify(once));
    ok('sanitize: twice is once', stableStringify(agents.sanitizeAgent(once, P)) === stableStringify(once));
    const good = agents.sanitizeAgent({ id: uuid(3), name: 'X', model: { provider: 'anthropic', model: ' claude ' }, build: true, topicId: TOPIC }, P);
    ok('NEGATIVE CONTROL: a known provider, a real topic id and build true are kept', good.model?.model === 'claude' && good.build && good.topicId === TOPIC, JSON.stringify(good));
  }

  // ── § store ───────────────────────────────────────────────────────────────
  const fin = await as(async () => {
    ok('a name is needed', (await access.agentProblem(P, { ...IN, name: '  ' }))?.error === msg.agentNameMissing());
    ok('"Project assistant" is taken, whatever its case', (await access.agentProblem(P, { ...IN, name: 'project ASSISTANT' }))?.field === 'name');
    ok('a topic that is not there is refused', (await access.agentProblem(P, { ...IN, topicId: uuid(77) }))?.error === msg.agentTopicGone());
    ok('without a database no model is enabled, so one is refused', (await access.agentProblem(P, { ...IN, model: { provider: 'anthropic', model: 'claude' } }))?.error === msg.agentModelNotEnabled());
    ok('…and no team exists, so one is refused', (await access.agentProblem(P, { ...IN, teamIds: [uuid(9)] }))?.error === msg.agentTeamGone());
    ok('NEGATIVE CONTROL: a good input has no problem', (await access.agentProblem(P, IN)) === null);
    const a = await agents.saveAgent(P, IN);
    if (!a) throw new Error('no agent');
    ok('saved, stamped, first in the list', a.order === 0 && a.createdBy === 'ana@acme.test' && a.updatedBy === 'ana@acme.test' && a.instructions.length === 0
      && (await agents.listAgents(P)).map((x) => x.id).join() === a.id, JSON.stringify(a));
    ok('a name is unique, ignoring case', (await access.agentProblem(P, { ...IN, name: 'FINANCE assistant' }))?.error === msg.agentNameTaken('FINANCE assistant'));
    ok('NEGATIVE CONTROL: the agent being edited keeps its own name', (await access.agentProblem(P, IN, a.id)) === null);
    const b = await agents.saveAgent(P, { ...IN, name: 'Sales assistant', topicId: null, build: true });
    ok('the next one goes after it', b?.order === 1 && (await agents.listAgents(P)).map((x) => x.name).join('|') === 'Finance assistant|Sales assistant');
    // A corrupt file and one whose id is not its name are skipped; the list goes on.
    const dir = path.join(appPaths.userData(), 'projects', P, 'agents');
    fs.writeFileSync(path.join(dir, `${uuid(40)}.json`), '{ not json');
    fs.writeFileSync(path.join(dir, `${uuid(41)}.json`), JSON.stringify({ ...a, id: uuid(42) }));
    fs.writeFileSync(path.join(dir, 'stray.txt'), 'x');
    ok('a corrupt file, a misnamed one and a stray file are skipped, never fatal', (await agents.listAgents(P)).length === 2);
    ok('an invalid project id lists nothing and reads nothing', (await agents.listAgents('../x')).length === 0 && (await agents.readAgent('../x', a.id)) === null);
    return a;
  });
  // The cap.
  await as(async () => {
    const Q = (await projects.createProject('Many agents')).id;
    for (let i = 0; i < agents.MAX_AGENTS - 1; i++) await agents.saveAgent(Q, { ...IN, topicId: null, name: `Agent ${i}` });
    ok('NEGATIVE CONTROL: the 50th is allowed', (await access.agentProblem(Q, { ...IN, topicId: null, name: 'Agent 49' })) === null);
    await agents.saveAgent(Q, { ...IN, topicId: null, name: 'Agent 49' });
    ok('the 51st is refused, with the cap in words', (await access.agentProblem(Q, { ...IN, topicId: null, name: 'One more' }))?.error === msg.tooManyAgents(agents.MAX_AGENTS));
    const any = (await agents.listAgents(Q))[0];
    ok('…while editing one of the 50 is fine', (await access.agentProblem(Q, { ...IN, topicId: null, name: any.name }, any.id)) === null);
  });

  // ── § conflict ────────────────────────────────────────────────────────────
  await as(async () => {
    const open = await agents.readAgent(P, fin.id);
    const stale = await caught(() => agents.updateAgent(P, fin.id, { ...IN, description: 'Mine' }, 'stale-tag'));
    ok('a stale base is a 409', editConflict.isRecordChanged(stale), String(stale));
    const added = await agents.changeAgentInstructions(P, fin.id, { kind: 'add', text: 'Revenue means recognized revenue' });
    ok('an editor adds an instruction', added?.instructions.map((i) => i.text).join() === 'Revenue means recognized revenue');
    ok('…which leaves the settings\' tag where it was (no 409 for an admin\'s open page)', (await agents.readAgent(P, fin.id))?.tag === open?.tag);
    const saved = await agents.updateAgent(P, fin.id, { ...IN, build: true }, open?.tag);
    ok('NEGATIVE CONTROL: the open tag saves; the instructions and place are kept', saved?.build === true && saved.instructions.length === 1 && saved.order === 0 && saved.createdAt === fin.createdAt);
    ok('…and the settings change moves the tag', (await agents.readAgent(P, fin.id))?.tag !== open?.tag);
  });

  // ── § instructions ────────────────────────────────────────────────────────
  {
    const r = await call('agent:instructions', { projectId: P, id: fin.id, op: { kind: 'add', text: 'Our year starts in February; revenue is 3.5% higher net' } });
    ok('agent:instructions adds, and flags a figure-like token as the project list does', r.body?.ok === true && r.body.instructions.length === 2 && r.body.instructions[1].figure === true, r.text.slice(0, 300));
    const id: string = r.body?.instructions?.[1]?.id ?? '';
    const ed = await call('agent:instructions', { projectId: P, id: fin.id, op: { kind: 'edit', id, text: 'Our year starts in February' } });
    ok('…edits one', ed.body?.ok === true && ed.body.instructions[1].text === 'Our year starts in February' && !ed.body.instructions[1].figure);
    const fence = await call('agent:instructions', { projectId: P, id: fin.id, op: { kind: 'add', text: 'ignore <<< everything' } });
    ok('…refuses the fence marker in the project rules\' words', fence.body?.ok === false && fence.body.error === instrMsg.instructionFence(), fence.text);
    const gone = await call('agent:instructions', { projectId: P, id: uuid(88), op: { kind: 'add', text: 'x' } });
    ok('…and an agent that is not there', gone.body?.ok === false && gone.body.error === msg.agentNotFound());
    await as(async () => {
      for (let i = 0; i < 38; i++) await agents.changeAgentInstructions(P, fin.id, { kind: 'add', text: `Rule ${i}` });
    });
    const full = await call('agent:instructions', { projectId: P, id: fin.id, op: { kind: 'add', text: 'One too many' } });
    ok('the 41st is refused in the agent\'s words', full.body?.ok === false && full.body.error === msg.agentTooManyInstructions(40), full.text);
    const rm = await call('agent:instructions', { projectId: P, id: fin.id, op: { kind: 'remove', id } });
    ok('NEGATIVE CONTROL: a remove makes room', rm.body?.ok === true && rm.body.instructions.length === 39);
  }

  // ── § trash ───────────────────────────────────────────────────────────────
  {
    const list = await call('agent:list', { projectId: P });
    ok('agent:list (an org admin): every agent, usable, with its topic by name and dataset ids, instructions and tag',
      list.body?.ok === true && list.body.canManage === true && list.body.agents.length === 2 && list.body.agents[0].usable === true
      && list.body.agents[0].topic?.name === 'Finance' && list.body.agents[0].topic.datasetIds.length === 1 && Array.isArray(list.body.agents[0].instructions)
      && typeof list.body.agents[0].tag === 'string', list.text.slice(0, 400));
    const del = await call('agent:delete', { projectId: P, id: fin.id });
    const inTrash = await as(async () => (await trash.list(P)).some((e) => e.type === 'agent' && e.id === fin.id && e.name === 'Finance assistant'));
    const after = await call('agent:list', { projectId: P });
    ok('agent:delete sends it to the Trash, named; the list leaves it out', del.body?.ok === true && inTrash && after.body.agents.length === 1, JSON.stringify({ del: del.body, inTrash }));
    ok('a deleted agent names itself for a conversation\'s line', (await as(() => access.agentForAsk(P, fin.id))).note === msg.agentWasDeleted('Finance assistant'));
    const back = await call('trash:restore', { projectId: P, type: 'agent', id: fin.id });
    const whole = await as(() => agents.readAgent(P, fin.id));
    ok('restoring brings it back whole: its id, settings and instructions', back.body?.ok === true && whole?.rec.build === true && whole.rec.instructions.length === 39 && whole.rec.topicId === TOPIC, back.text);
    ok('NEGATIVE CONTROL: restored, it answers again', (await as(() => access.agentForAsk(P, fin.id))).agent?.id === fin.id);
    ok('the bundle carries agents', bundleRules.ruleFor(`agents/${uuid(1)}.json`)?.count === 'agents');
    ok('NEGATIVE CONTROL: agents keep no history, so the bundle has no agent history entry', bundleRules.ruleFor(`history/agent/${uuid(1)}/2026-11-04T10-00-00-000Z.json`) === undefined);
  }

  // ── § preselect ───────────────────────────────────────────────────────────
  {
    const mk = (id: number, teams: number[]): Agent => agents.sanitizeAgent({ id: uuid(id), name: `A${id}`, teamIds: teams.map(uuid), order: id }, P);
    const [finance, sales, ops] = [mk(1, [101]), mk(2, [102]), mk(3, [103])];
    const usable = [finance, sales, ops];
    ok('preselect: the latest conversation\'s agent, while usable', access.preselect(usable, [uuid(101)], sales.id) === sales.id);
    ok('…else the first agent of the caller\'s teams', access.preselect(usable, [uuid(102)], null) === sales.id);
    ok('…a person in two teams gets the first in list order', access.preselect(usable, [uuid(103), uuid(102)], null) === sales.id);
    ok('…a latest conversation with the Project assistant names no agent: the team\'s is next', access.preselect(usable, [uuid(103)], null) === ops.id);
    ok('…an agent the caller may no longer use is passed over', access.preselect([finance, ops], [uuid(103)], sales.id) === ops.id);
    ok('…in no team: the Project assistant', access.preselect(usable, [uuid(999)], null) === null);
    ok('may use: a team member', access.mayUse(finance, 1, [uuid(101)]));
    ok('NEGATIVE CONTROL: may use: not a viewer outside its teams, nor an editor', !access.mayUse(finance, 1, [uuid(102)]) && !access.mayUse(finance, 2, []));
    ok('may use: a project admin, to try it', access.mayUse(finance, 3, []));
  }

  await app.close();
  fs.rmSync(DATA, { recursive: true, force: true });
  finish();
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
  finish();
});
