// The embedded Assistant's setup channels on Postgres (docs/embedded-assistant, phase 4; src/api/embedAssistant.ts): every channel is an
// org admin's and nobody else's (403 before the handler runs), a marking is checked as the ask checks it (text lock column, no row rules,
// no cross-row steps, the agent and datasets in the project) and pins the writers of the lock column, the screen sees a step added
// since, the caps are validated, and nothing a reply carries is a secret.
//
//   npm run build:ts && DATABASE_URL=… node scripts/test-embedAssistantAdmin.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import { randomBytes } from 'crypto';
import { Client, Pool } from 'pg';
import * as B from './subscriptionHarness';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');
const appMod: typeof import('../src/server/app') = require('../src/server/app');
const envMod: typeof import('../src/server/env') = require('../src/server/env');
const rpc: typeof import('../src/server/rpc') = require('../src/server/rpc');
const api: typeof import('../src/api/index') = require('../src/api/index');
const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
const agents: typeof import('../src/ai/agents') = require('../src/ai/agents');
const assistants: typeof import('../src/server/embed/assistants') = require('../src/server/embed/assistants');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-embed-admin-'));
const CHANNELS = Object.keys(api.contracts).filter((c) => c.startsWith('embedAssistant:'));

async function suite(adminUrl: string): Promise<void> {
  const dbName = `ordinate_embedadm_${process.pid}_${Date.now()}`;
  const scratch = new URL(adminUrl);
  scratch.pathname = '/' + dbName;
  const root = new Client({ connectionString: adminUrl });
  await root.connect();
  await root.query(`CREATE DATABASE ${dbName}`);
  const pool = new Pool({ connectionString: scratch.toString(), max: 3 });
  pool.on('error', () => undefined);
  const cfg = envMod.parseEnv({
    LOG_LEVEL: 'silent', DATA_DIR: DATA, DATABASE_URL: scratch.toString(), AUTH_MODE: 'header', ORDINATE_MASTER_KEY: randomBytes(32).toString('base64'),
    TRUSTED_PROXY_CIDRS: '127.0.0.1/32', ORDINATE_ORG: 'acme', ORDINATE_ADMIN_EMAIL: 'boss@acme.test',
  });
  const app = appMod.buildApp(cfg);
  try {
    const base = await B.listen(app);
    const replies: string[] = [];
    const as = (who: string) => B.client(base, { 'x-forwarded-email': `${who}@acme.test` }, replies);
    for (const p of ['boss', 'alice', 'bob']) await as(p).call('projects:list');
    const uid = async (who: string) => (await pool.query<{ id: string }>('SELECT id FROM users WHERE email = $1', [`${who}@acme.test`])).rows[0].id;
    const boss = as('boss');
    const pid: string = (await boss.call('projects:create', { name: 'Portal' })).body.id;
    for (const [who, role] of [['alice', 'viewer'], ['bob', 'editor']]) await boss.call('project:share', { projectId: pid, member: { userId: await uid(who) }, role });
    const BOSS: B.Identity = { user: { email: 'boss@acme.test', role: 'admin' }, org: { id: 'acme' } };
    const inBoss = <T>(fn: () => Promise<T>) => B.context.runInContext(BOSS, 'setup', fn);
    const COLS = [{ name: 'customer_id', type: 'text' as const }, { name: 'city', type: 'text' as const }, { name: 'qty', type: 'number' as const }];
    const rows = [['c1', 'Austin', 1], ['c2', 'Boston', 2]];
    const ship = (await inBoss(() => datasets.saveDataset(pid, { name: 'Shipments', sourceKind: 'csv', columns: COLS, rows })))!.id;
    const ruled = (await inBoss(() => datasets.saveDataset(pid, { name: 'Ruled', sourceKind: 'csv', columns: COLS, rows })))!.id;
    const crossed = (await inBoss(() => datasets.saveDataset(pid, { name: 'Crossed', sourceKind: 'csv', columns: COLS, rows })))!.id;
    const agent = await inBoss(async () => (await agents.saveAgent(pid, { name: 'Helper', teamIds: [] }))!);
    const rule = await boss.call('dataset:setRowPolicy', { projectId: pid, datasetId: ruled, policy: { column: 'customer_id', rules: [{ userId: await uid('alice'), values: ['c1'] }] } });
    ok('setup: row access rules on one dataset', rule.body?.ok === true, JSON.stringify(rule.body).slice(0, 200));
    const set = await boss.call('dataset:setSteps', { projectId: pid, datasetId: crossed, steps: [{ type: 'dedupe', columns: ['city'] }] });
    ok('setup: a cross-row step (a dedupe not keyed by the lock column) on another', set.status === 200, JSON.stringify(set.body).slice(0, 200));
    const D = (id: string, column = 'customer_id') => ({ id, column });
    const save = (over: Record<string, unknown> = {}) => boss.call('embedAssistant:save', { projectId: pid, agentId: agent.id, enabled: true, datasets: [D(ship)], ...over });

    // Roles: an org admin's, and nobody else's; a refused call never reaches its handler.
    const calls = new Map<string, number>();
    for (const ch of CHANNELS) {
      const real = rpc.handlers.get(ch);
      if (!real) continue;
      rpc.registry.removeHandler(ch);
      rpc.registry.handle(ch, (e, ...args) => { calls.set(ch, (calls.get(ch) ?? 0) + 1); return real(e, ...args); });
    }
    ok('contracts: five channels, every one admin and org-scoped', CHANNELS.length === 5 && CHANNELS.every((c) => (api.contracts as Record<string, { access: string; org?: boolean }>)[c].access === 'admin' && (api.contracts as Record<string, { org?: boolean }>)[c].org === true), CHANNELS.join());
    const inputs: Record<string, unknown> = {
      'embedAssistant:settings': undefined, 'embedAssistant:options': { projectId: pid }, 'embedAssistant:save': { projectId: pid, agentId: agent.id, enabled: true, datasets: [D(ship)] },
      'embedAssistant:remove': { agentId: agent.id }, 'embedAssistant:setLimits': { daily: 500, perMinute: 5 },
    };
    for (const ch of CHANNELS) {
      for (const who of ['alice', 'bob', 'boss']) {
        const before = calls.get(ch) ?? 0;
        const r = await as(who).call(ch, inputs[ch]);
        const want = who === 'boss';
        ok(`roles: ${ch} as ${who} → ${want ? 'allowed' : '403, handler never ran'}`, want ? r.status === 200 : r.status === 403 && (calls.get(ch) ?? 0) === before, `${r.status}`);
      }
    }

    // Marking: checked as the ask checks it.
    const bad = async (label: string, over: Record<string, unknown>, re: RegExp) => {
      const r = await save(over);
      ok(`save refuses ${label}`, r.body?.ok === false && re.test(r.body.error), JSON.stringify(r.body));
    };
    await bad('a dataset with no datasets while on', { datasets: [] }, /at least one dataset/i);
    await bad('an agent that is not in the project', { agentId: ship }, /no longer in the project/);
    await bad('a dataset that is not in the project', { datasets: [D(agent.id)] }, /no longer in the project/);
    await bad('a column that is not a text column', { datasets: [D(ship, 'qty')] }, /text column/);
    await bad('a column that does not exist', { datasets: [D(ship, 'nope')] }, /text column/);
    await bad('a dataset with row access rules', { datasets: [D(ruled)] }, /row access rules/);
    await bad('a dataset whose steps compute across rows', { datasets: [D(crossed)] }, /across rows/);
    ok('save refuses 13 datasets (the contract: at most 12)', (await save({ datasets: Array.from({ length: 13 }, () => D(ship)) })).status !== 200);
    ok('NEGATIVE CONTROL: the same save with a good dataset succeeds', (await save()).body?.ok === true);

    // The pin, and what the screen sees afterwards.
    const stored = (await pool.query<{ datasets: Array<{ id: string; column: string; writers: string }>; enabled: boolean }>(`SELECT datasets, enabled FROM embed_agents WHERE agent_id = $1`, [agent.id])).rows[0];
    ok('the marking stores the dataset, its column and a writers\' pin', stored.datasets.length === 1 && stored.datasets[0].id === ship && stored.datasets[0].column === 'customer_id' && /^[0-9a-f]{16,}$/.test(stored.datasets[0].writers), JSON.stringify(stored));
    const view = async () => (await boss.call('embedAssistant:settings')).body;
    const v0 = await view();
    ok('settings: the marked agent with its dataset name and a locked state', v0.agents.length === 1 && v0.agents[0].agentName === 'Helper' && v0.agents[0].projectName === 'Portal' && v0.agents[0].datasets[0].name === 'Shipments' && v0.agents[0].datasets[0].state === 'ok');
    ok('settings: nothing but names, ids, columns and counts (no secret, no row)', !JSON.stringify(v0).includes('ord_embed_') && !JSON.stringify(v0).includes('Austin') && v0.canStore === true && v0.caps.daily === 500 && v0.caps.perMinute === 5 && v0.org === 'acme', JSON.stringify(v0).slice(0, 400));
    const w = await boss.call('dataset:setSteps', { projectId: pid, datasetId: ship, steps: [{ type: 'replace_values', column: 'customer_id', mode: 'exact', rules: [{ from: 'c2', to: 'c1' }] }] });
    await pool.query('SELECT 1');
    ok('setup: a find/replace on the lock column (what would hand c1 the rows of c2)', w.status === 200, JSON.stringify(w.body).slice(0, 200));
    const v1 = await view();
    ok('settings: the screen sees the change — "changed" (or the column no longer text), never "ok"', v1.agents[0].datasets[0].state !== 'ok', JSON.stringify(v1.agents[0].datasets));
    const options = await boss.call('embedAssistant:options', { projectId: pid });
    ok('options: the project\'s agents and datasets with their text columns', options.body.ok === true && options.body.agents.some((a: { id: string }) => a.id === agent.id) && options.body.datasets.find((d: { id: string }) => d.id === ship).textColumns.includes('customer_id'));
    ok('options: a project that does not exist is a sentence', (await boss.call('embedAssistant:options', { projectId: agent.id })).body.ok === false);

    // Switch off, caps, remove.
    // (the find/replace above changed the lock column's steps: re-marking pins the new ones, and the agent can be switched off)
    const off = await save({ enabled: false, datasets: [D(ship)] });
    ok('save can switch an agent off (re-pinning its steps)', off.body?.ok === true && (await view()).agents[0].enabled === false && (await view()).agents[0].datasets[0].state === 'ok', JSON.stringify(off.body));
    const lim = async (daily: number, perMinute: number) => (await boss.call('embedAssistant:setLimits', { daily, perMinute })).body;
    ok('caps: saved and read back', (await lim(500, 5)).ok === true && (await view()).caps.daily === 500 && (await view()).caps.perMinute === 5);
    ok('caps: the contract refuses 0, 601 a minute, 1,000,001 a day and a fraction', (await boss.call('embedAssistant:setLimits', { daily: 0, perMinute: 5 })).status !== 200 && (await boss.call('embedAssistant:setLimits', { daily: 5, perMinute: 601 })).status !== 200
      && (await boss.call('embedAssistant:setLimits', { daily: 1_000_001, perMinute: 5 })).status !== 200 && (await boss.call('embedAssistant:setLimits', { daily: 5.5, perMinute: 5 })).status !== 200);
    ok('caps: the store is what the route reads', (await assistants.getCaps('acme')).daily === 500);
    const rm = await boss.call('embedAssistant:remove', { agentId: agent.id });
    ok('remove: the marking is gone, so every token for it is refused', rm.body.ok === true && (await assistants.getEmbedAgent('acme', agent.id)) === null && (await view()).agents.length === 0);
    ok('remove: an agent that is not marked is a sentence', (await boss.call('embedAssistant:remove', { agentId: agent.id })).body.ok === false);
    ok('no reply of any channel carries a signing secret', !replies.join('').includes('ord_embed_'));
  } finally {
    await app.close();
    await pool.end();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  }
}

(async () => {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.log('skip embed assistant admin DB suite: DATABASE_URL is unset (set it to a Postgres this suite may CREATE DATABASE on)');
    return finish();
  }
  B.context.enterServerMode(DATA);
  appMod.registerHandlers();
  try {
    await suite(url);
  } finally {
    fs.rmSync(DATA, { recursive: true, force: true });
  }
  finish();
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
