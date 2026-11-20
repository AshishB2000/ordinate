// The world the Slack suites share: the row-access world (scripts/rowPolicyHarness.ts: a scratch Postgres, header
// sign-in, boss the org admin, east / west viewers whose row rules differ, ed an editor, nobody a viewer, one project
// with datasets Orders / Plain), a local stub of Slack (./slackStub.ts), the Slack install saved through the real
// `slack:install` channel, and a FAKE `copilot:ask` handler: no model is configured in a self-check, so it writes the
// turns the real handler would (through `copilot.appendTurn`, as the asker) and the suite chooses what it answered.
//
// Not a test file (no `test-` prefix).

import { createSecretKey, randomBytes } from 'crypto';
import * as H from './rowPolicyHarness';
import { startSlackStub, type Stub } from './slackStub';

const slackDb: typeof import('../src/server/slack/db') = require('../src/server/slack/db');
const secretsMod: typeof import('../src/server/secrets/store') = require('../src/server/secrets/store');
const rpc: typeof import('../src/server/rpc') = require('../src/server/rpc');
const context: typeof import('../src/server/context') = require('../src/server/context');
const copilot: typeof import('../src/ai/copilot') = require('../src/ai/copilot');
const worker: typeof import('../src/server/slack/worker') = require('../src/server/slack/worker');

export const SIGNING = 'c4nary-signing-secret';
export const APP_TOKEN = 'xapp-c4nary-app-token-0001';
export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
export async function until(fn: () => Promise<boolean>, ms = 20_000): Promise<boolean> {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(50)) if (await fn()) return true;
  return false;
}

export interface Answer { text: string; datasets: string[]; dashboards?: string[]; card?: Record<string, unknown> | null }
export interface AskSeen { email: string; payload: Record<string, any> } // any: the contract's input

export interface SlackWorld {
  W: H.World;
  stub: Stub;
  /** Slack user ids by person. */
  slackId: Record<string, string>;
  /** What the fake `copilot:ask` answers next (a function for per-question answers). */
  answer: Answer | ((p: Record<string, any>, email: string) => Answer);
  asked: AskSeen[];
  /** Links a person's Slack account (what the Connect flow ends in). */
  link(person: string): Promise<void>;
  /** A Slack `event_callback` for a message. */
  mention(person: string, text: string, o?: { channel?: string; ts?: string; thread_ts?: string; id?: string }): unknown;
  dm(person: string, text: string, o?: { ts?: string; id?: string }): unknown;
  /** Delivers an event signed like Slack, then waits for its question to leave the queue. Returns the question row. */
  deliver(payload: unknown): Promise<Record<string, any> | null>; // any: a slack_questions row
  questions(): Promise<Array<Record<string, any>>>; // any: slack_questions rows
  /** Messages the stub saw, by method. */
  posted(): Array<{ channel: string; text: string; thread_ts?: string; blocks?: any[] }>; // any: Slack's blocks
  updated(): Array<{ channel: string; ts: string; text: string; blocks?: any[] }>; // any: Slack's blocks
  close(): Promise<void>;
}

/** `realAsk`: keep the REAL `copilot:ask` handler (a verified question answers with no model) instead of the fake. */
export async function slackWorld(label: string, o: { realAsk?: boolean } = {}): Promise<SlackWorld | null> {
  const W = await H.world(label);
  if (!W) return null;
  const stub = await startSlackStub();
  process.env.SSRF_ALLOW = [process.env.SSRF_ALLOW, '127.0.0.1/32'].filter(Boolean).join(',');
  process.env.ORDINATE_TEST_SLACK_BASE = stub.origin;
  process.env.ORDINATE_PUBLIC_URL = 'http://ordinate.test';
  slackDb.useSlackDb(W.pool, secretsMod.createSecretStore(W.pool, createSecretKey(randomBytes(32))));
  const slackId: Record<string, string> = { boss: 'U_BOSS', ed: 'U_ED', east: 'U_EAST', west: 'U_WEST', nobody: 'U_NOBODY' };
  for (const id of Object.values(slackId)) stub.users.set(id, { id, team_id: stub.team.id });
  stub.oauth.signInAs = { userId: 'U_EAST', teamId: stub.team.id };

  const state: SlackWorld = {
    W, stub, slackId, asked: [], answer: { text: 'There were 42 orders.', datasets: [W.plain] },
    async link(person) { await slackDb.saveLink('acme', stub.team.id, slackId[person], `${person}@acme.test`); },
    mention: (person, text, o = {}) => ({
      type: 'event_callback', team_id: stub.team.id, event_id: o.id ?? `Ev${Math.random().toString(36).slice(2)}`,
      event: { type: 'app_mention', user: slackId[person], text: `<@${stub.team.botUser}> ${text}`, channel: o.channel ?? 'CTEAM', ts: o.ts ?? `${1800000000 + Math.floor(Math.random() * 1e6)}.000100`, ...(o.thread_ts ? { thread_ts: o.thread_ts } : {}) },
    }),
    dm: (person, text, o = {}) => ({
      type: 'event_callback', team_id: stub.team.id, event_id: o.id ?? `Ev${Math.random().toString(36).slice(2)}`,
      event: { type: 'message', channel_type: 'im', user: slackId[person], text, channel: `D${slackId[person]}`, ts: o.ts ?? `${1800000000 + Math.floor(Math.random() * 1e6)}.000200` },
    }),
    async deliver(payload) {
      const before = (await state.questions()).length;
      const res = await stub.send(`http://127.0.0.1:${port}`, '/api/slack/events', payload);
      if (res.status !== 200) return null;
      await until(async () => (await state.questions()).length > before || res.status !== 200, 2000);
      const all = await state.questions();
      const q = all[all.length - 1];
      if (!q || all.length === before) return null;
      await until(async () => ['done', 'failed', 'awaiting_link', 'dropped'].includes((await state.questions()).find((x) => x.id === q.id)?.status));
      return (await state.questions()).find((x) => x.id === q.id) ?? null;
    },
    async questions() {
      return (await W.pool.query('SELECT * FROM slack_questions ORDER BY created_at, id')).rows;
    },
    posted: () => stub.callsOf('chat.postMessage').map((c) => c.params as any),
    updated: () => stub.callsOf('chat.update').map((c) => c.params as any),
    async close() {
      await stub.close();
      slackDb.useSlackDb(null, null);
      await W.close();
    },
  };

  // The events route needs a listening app: the stub's `send` is a real fetch.
  await W.app.listen({ port: 0, host: '127.0.0.1' });
  const port = (W.app.server.address() as import('net').AddressInfo).port;

  if (!o.realAsk) rpc.registry.removeHandler('copilot:ask');
  if (!o.realAsk) rpc.registry.handle('copilot:ask', async (_e: unknown, p: Record<string, any>) => { // any: the contract's input
    const email = context.ctx().user.email;
    state.asked.push({ email, payload: p });
    const a = typeof state.answer === 'function' ? state.answer(p, email) : state.answer;
    const tid = p.threadId ?? (await copilot.createThread(p.projectId, p.agentId ?? null))?.id;
    await copilot.appendTurn(p.projectId, { role: 'user', text: p.question }, tid);
    await copilot.appendTurn(p.projectId, { role: 'assistant', text: a.text, factsFrom: a.datasets, ...(a.dashboards ? { dashboardsFrom: a.dashboards } : {}) }, tid);
    return { ok: true, threadId: tid, turns: [{ role: 'assistant', text: a.text, ...(a.card ? { card: a.card } : {}) }], agent: p.agentId ? { id: p.agentId, name: 'Sales agent' } : null };
  });

  const installed = await W.call('boss', 'slack:install', {
    botToken: stub.team.botToken, signingSecret: SIGNING, clientId: stub.oauth.clientId, clientSecret: stub.oauth.clientSecret, appToken: APP_TOKEN, mode: 'events',
  });
  if (installed.body?.ok !== true) throw new Error(`slack:install failed: ${installed.text}`);
  void worker;
  return state;
}
