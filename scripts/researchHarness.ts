// The world the deep-research suites share: the row-access world (scripts/rowPolicyHarness.ts: a scratch Postgres, header sign-in,
// boss the org admin, ed an editor on the project, east / west / nobody viewers, datasets Orders (row rules) and Plain), and a
// SCRIPTED model provider: no model is configured in a self-check, so `analyze.dispatch` and the AI readiness are replaced by a
// stub that answers the plan, each step and the write call from a script, counts the calls, and can hold them (a crash or a
// concurrency test). The research worker is paused: a test ticks it by hand.
//
// Not a test file (no `test-` prefix).

import { randomBytes } from 'crypto';
import { Pool } from 'pg';
import * as H from './rowPolicyHarness';

const analyze: any = require('../src/ai/analyze'); // any: the stub replaces its exports
const execConfig: any = require('../src/app/execConfig'); // any: the stub replaces its exports
const worker: typeof import('../src/server/research/worker') = require('../src/server/research/worker');
const store: typeof import('../src/server/research/db') = require('../src/server/research/db');
const prompts: typeof import('../src/ai/researchPrompts') = require('../src/ai/researchPrompts');
const answerSql: typeof import('../src/ai/answerSql') = require('../src/ai/answerSql');

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
export async function until(fn: () => Promise<boolean>, ms = 20_000): Promise<boolean> {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(50)) if (await fn()) return true;
  return false;
}

export type Reply = string | ((user: string) => string | Promise<string>);
export interface Stub {
  plan: Reply;
  /** Each step call takes the next entry (the last one repeats). */
  steps: Reply[];
  write: Reply;
  /** The SQL a second call writes. */
  sql: string;
  /** Model failures: the next call of this kind errors. */
  fail: { plan: number; step: number; write: number };
  calls: { plan: number; step: number; write: number; sql: number };
  /** What each kind of call was last sent (system, user). */
  seen: { plan: string; step: string; write: string };
  /** While set, every call waits for it (a hold). */
  hold: Promise<void> | null;
  reset(): void;
}

export const PLAN = JSON.stringify({ plan: ['How do sales split by region?', 'Which customers drive the most quantity?', 'Is there a trend over days?'] });
const DONE = '{"kind":"done"}';
export const answerStep = (spec: Record<string, unknown>, intent = 'sales by region'): string => JSON.stringify({ kind: 'answer', intent, spec });

export interface ResearchWorld {
  W: H.World;
  stub: Stub;
  /** An ordinary (non-superuser) role with a password: RLS applies to it. */
  ordinary(): Promise<Pool>;
  /** `research:start` as `who`. */
  start(who: string, question: string, o?: { threadId?: string; agentId?: string }): Promise<H.Reply>;
  run(id: string): Promise<import('../src/server/research/db').Run | null>;
  /** One poll of this pod's worker, then waits until `id` is no longer active. */
  drive(id: string, ms?: number): Promise<import('../src/server/research/db').Run | null>;
  close(): Promise<void>;
}

export async function researchWorld(label: string): Promise<ResearchWorld | null> {
  const W = await H.world(label);
  if (!W) return null;
  worker.pauseForTest(true);
  worker.tuneForTest({ pollMs: 100 });
  const stub: Stub = {
    plan: PLAN, steps: [DONE], write: '{}', sql: 'SELECT 1', fail: { plan: 0, step: 0, write: 0 }, calls: { plan: 0, step: 0, write: 0, sql: 0 }, seen: { plan: '', step: '', write: '' }, hold: null,
    reset() { this.plan = PLAN; this.steps = [DONE]; this.write = '{}'; this.fail = { plan: 0, step: 0, write: 0 }; this.calls = { plan: 0, step: 0, write: 0, sql: 0 }; this.seen = { plan: '', step: '', write: '' }; this.hold = null; },
  };
  const real = { dispatch: analyze.dispatch, ready: execConfig.executionReady, on: execConfig.assistantOn };
  const pick = async (r: Reply, user: string): Promise<string> => (typeof r === 'function' ? r(user) : r);
  analyze.dispatch = async (system: string, messages: Array<{ text: string }>) => {
    const user = messages[messages.length - 1]?.text ?? '';
    if (stub.hold) await stub.hold;
    const err = { error: { ok: false, errorType: 'provider', message: 'provider error' } };
    if (system === prompts.PLAN_SYSTEM) {
      stub.calls.plan += 1; stub.seen.plan = user;
      return stub.fail.plan-- > 0 ? err : { rawText: await pick(stub.plan, user) };
    }
    if (system === prompts.stepSystem()) {
      const n = stub.calls.step;
      stub.calls.step += 1; stub.seen.step = user;
      return stub.fail.step-- > 0 ? err : { rawText: await pick(stub.steps[Math.min(n, stub.steps.length - 1)], user) };
    }
    if (system === prompts.WRITE_SYSTEM) {
      stub.calls.write += 1; stub.seen.write = user;
      return stub.fail.write-- > 0 ? err : { rawText: await pick(stub.write, user) };
    }
    if (system === answerSql.SQL_SYSTEM_PROMPT) { stub.calls.sql += 1; return { rawText: stub.sql }; }
    return err;
  };
  execConfig.executionReady = async () => true;
  execConfig.assistantOn = () => true;
  const roles: string[] = [];
  const pools: Pool[] = [];
  const state: ResearchWorld = {
    W, stub,
    async ordinary() {
      const role = `research_role_${process.pid}_${roles.length}`;
      roles.push(role);
      const pw = randomBytes(12).toString('hex'); // CI's Postgres asks for a password over TCP (SCRAM): a passwordless role passes here and fails there
      await W.pool.query(`CREATE ROLE ${role} LOGIN PASSWORD '${pw}'`);
      await W.pool.query(`GRANT ALL ON ALL TABLES IN SCHEMA public TO ${role}`);
      await W.pool.query(`GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO ${role}`);
      const url = new URL((W.pool as unknown as { options: { connectionString: string } }).options.connectionString);
      url.username = role;
      url.password = pw;
      const p = new Pool({ connectionString: url.toString(), max: 4 });
      p.on('error', () => undefined);
      pools.push(p);
      return p;
    },
    start: (who, question, o = {}) => W.call(who, 'research:start', { projectId: W.P, question, ...o }),
    run: (id) => store.getRun('acme', id),
    async drive(id, ms = 30_000) {
      worker.pauseForTest(false);
      try {
        await until(async () => { await worker.latestForTest()?.tick(); const r = await store.getRun('acme', id); return !!r && !store.ACTIVE.includes(r.state); }, ms);
      } finally {
        worker.pauseForTest(true);
      }
      return store.getRun('acme', id);
    },
    async close() {
      analyze.dispatch = real.dispatch;
      execConfig.executionReady = real.ready;
      execConfig.assistantOn = real.on;
      for (const p of pools) await p.end().catch(() => undefined);
      store.useResearchDb(W.pool);
      await W.close();
    },
  };
  void roles;
  return state;
}
