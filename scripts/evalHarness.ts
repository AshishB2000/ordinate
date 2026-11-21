// The world the evaluation-suite suites share: the row-access world (scripts/rowPolicyHarness.ts: a scratch Postgres, header sign-in, boss
// the org admin, ed an editor on the project, east / west / nobody viewers, datasets Orders (row rules) and Plain), and a SCRIPTED model:
// no model is configured in a self-check, so `analyze.askCopilot` (the Assistant's narration, which the REAL `copilot:ask` handler calls)
// and `analyze.dispatch` (the judge) are replaced by a stub that answers from a script and counts its calls. The REAL ask path runs: the
// facts, the guard, the stored turn, the hidden conversation. The evaluation worker is paused: a test ticks it by hand.
//
// Not a test file (no `test-` prefix).

import { randomBytes } from 'crypto';
import { Pool } from 'pg';
import * as H from './rowPolicyHarness';

const analyze: any = require('../src/ai/analyze'); // any: the stub replaces its exports
const execConfig: any = require('../src/app/execConfig'); // any: the stub replaces its exports
const worker: typeof import('../src/server/evals/worker') = require('../src/server/evals/worker');
const store: typeof import('../src/server/evals/db') = require('../src/server/evals/db');
const judgeMod: typeof import('../src/ai/evalJudge') = require('../src/ai/evalJudge');
const context: typeof import('../src/server/context') = require('../src/server/context');

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
export async function until(fn: () => Promise<boolean>, ms = 20_000): Promise<boolean> {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(50)) if (await fn()) return true;
  return false;
}

/** What the scripted Assistant says to one question: words, and the one action it proposes (an answer spec as the model names it). */
export interface Say { text: string; action?: Record<string, unknown>; fail?: boolean }
export interface Stub {
  /** By question text; a question not in it is answered with `fallback`. */
  asks: Record<string, Say | ((q: string) => Say | Promise<Say>)>;
  fallback: Say;
  /** The judge's replies in order (the last repeats); a function sees the user message. */
  judge: Array<string | ((user: string) => string)>;
  calls: { ask: number; judge: number };
  seen: { questions: string[]; judgeUser: string[]; threads: string[] };
  /** While set, every ask waits for it (a hold). */
  hold: Promise<void> | null;
  reset(): void;
}

export const answerAction = (spec: Record<string, unknown>, intent = 'sales by region'): Record<string, unknown> => ({ kind: 'answer', intent, spec });

export interface EvalWorld {
  W: H.World;
  stub: Stub;
  /** An ordinary (non-superuser) role with a password: RLS applies to it. */
  ordinary(): Promise<Pool>;
  run(id: string): Promise<import('../src/server/evals/db').Run | null>;
  /** Polls this pod's worker until `id` is no longer active. */
  drive(id: string, ms?: number): Promise<import('../src/server/evals/db').Run | null>;
  /** An Assistant agent made by boss. */
  agent(name: string): Promise<string>;
  /** A suite of `ed`'s with these cases (typed shapes), or from a spec. */
  suite(who: string, name: string, agentId?: string | null): Promise<string>;
  close(): Promise<void>;
}

export async function evalWorld(label: string): Promise<EvalWorld | null> {
  const W = await H.world(label);
  if (!W) return null;
  worker.pauseForTest(true);
  worker.tuneForTest({ pollMs: 100 });
  const stub: Stub = {
    asks: {}, fallback: { text: 'I am not sure.' }, judge: ['{"score":5,"why":"says it"}'], calls: { ask: 0, judge: 0 }, seen: { questions: [], judgeUser: [], threads: [] }, hold: null,
    reset() { this.asks = {}; this.fallback = { text: 'I am not sure.' }; this.judge = ['{"score":5,"why":"says it"}']; this.calls = { ask: 0, judge: 0 }; this.seen = { questions: [], judgeUser: [], threads: [] }; this.hold = null; },
  };
  const real = { ask: analyze.askCopilot, dispatch: analyze.dispatch, ready: execConfig.executionReady, on: execConfig.assistantOn };
  analyze.askCopilot = async (_prior: unknown, _facts: string, question: string) => {
    stub.calls.ask += 1;
    stub.seen.questions.push(question);
    if (stub.hold) await stub.hold;
    const s = stub.asks[question];
    const say = typeof s === 'function' ? await s(question) : s ?? stub.fallback;
    if (say.fail) return { ok: false, errorType: 'provider', message: 'provider error' };
    return { ok: true, text: say.text, suggestedAction: say.action ?? { kind: 'none', intent: '' } };
  };
  analyze.dispatch = async (system: string, messages: Array<{ text: string }>) => {
    if (system === judgeMod.JUDGE_SYSTEM) {
      const user = messages[messages.length - 1]?.text ?? '';
      const n = stub.calls.judge;
      stub.calls.judge += 1;
      stub.seen.judgeUser.push(user);
      const r = stub.judge[Math.min(n, stub.judge.length - 1)];
      return { rawText: typeof r === 'function' ? r(user) : r };
    }
    return { error: { ok: false, errorType: 'provider', message: 'provider error' } };
  };
  execConfig.executionReady = async () => { context.ctx(); return true; }; // like the real one: it reads the org's config, so it throws outside a request context
  execConfig.assistantOn = () => true;
  const roles: string[] = [];
  const pools: Pool[] = [];
  const state: EvalWorld = {
    W, stub,
    async ordinary() {
      const role = `eval_role_${process.pid}_${roles.length}`;
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
    async agent(name) {
      const r = await W.call('boss', 'agent:save', { projectId: W.P, agent: { name, topicId: null, model: null, build: false, teamIds: [] } });
      if (!r.body?.ok) throw new Error('agent:save failed: ' + r.text);
      return r.body.agent.id as string;
    },
    async suite(who, name, agentId = null) {
      const r = await W.call(who, 'eval:suiteSave', { projectId: W.P, name, agentId });
      if (!r.body?.ok) throw new Error('eval:suiteSave failed: ' + r.text);
      return r.body.id as string;
    },
    async close() {
      analyze.askCopilot = real.ask;
      analyze.dispatch = real.dispatch;
      execConfig.executionReady = real.ready;
      execConfig.assistantOn = real.on;
      for (const p of pools) await p.end().catch(() => undefined);
      store.useEvalsDb(W.pool);
      await W.close();
    },
  };
  return state;
}
