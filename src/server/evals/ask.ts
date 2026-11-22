// One case's question, asked the way the app asks it (docs/eval-suites/00-design.md, "The batch run"): the SAME registered `copilot:ask`
// handler, as the person who pressed Run, with the chosen agent, in a hidden conversation that is deleted afterwards. Calling the handler
// skips the RPC layer, so this does what the layer does first (src/server/slack/ask.ts, which it follows): `authorize()` on the
// contract and the project, the agent check, the time limit joined to the lease. `context.noSources` is set after the input parsed, as for
// Slack and research: a test never reads the project's source tables. The reply it keeps is what the checks need and nothing else.

import type { Pool } from 'pg';
import { contractFor } from '../../api/index';
import { runInContext, type Identity } from '../context';
import { handlers } from '../rpc';
import { untilAborted } from '../limits';
import * as copilot from '../../ai/copilot';
import { askScope } from '../../ipc/agentAsk';
import { shows } from '../../ipc/turnsOpen';
import { mayAsk } from '../slack/ask';
import { slackLimits } from '../slack/db';
import { createHidden, dropHidden } from './thread';
import type { Answered } from '../../ai/evalChecks';

export type Asked =
  | { ok: true; text: string; got: Answered; calls: number; datasetIds: string[] }
  | { ok: false; code: 'denied' | 'agent' | 'not_ready' | 'failed' | 'timeout' };

interface Reply { ok?: boolean; notReady?: boolean; refused?: boolean; numberAudit?: { ok?: boolean } | null; guidance?: { verifiedId?: string } | null }

/** Asks `question` as `who`. `signal`: the run's lease; it aborts the ask when lost (and the caller stops). */
export async function askCase(pool: Pool, who: Identity, requestId: string, p: { projectId: string; agentId: string | null; question: string }, signal?: AbortSignal): Promise<Asked> {
  const contract = contractFor('copilot:ask');
  const handler = handlers.get('copilot:ask');
  if (!contract || !handler) return { ok: false, code: 'failed' };
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error('evaluation ask time limit')), slackLimits().timeoutMs);
  const onLost = () => ac.abort(signal?.reason);
  signal?.addEventListener('abort', onLost, { once: true });
  const work = runInContext(who, requestId, async (): Promise<Asked> => {
    if (!(await mayAsk(pool, who, p.projectId))) return { ok: false, code: 'denied' };
    // The handler falls back to the Project assistant, silently, for an agent this person may not use or one that is gone: a test of
    // the agent must not quietly test another.
    if (p.agentId && (await askScope(p.projectId, p.agentId)).agent?.id !== p.agentId) return { ok: false, code: 'agent' };
    const threadId = await createHidden(p.projectId, p.agentId);
    if (!threadId) return { ok: false, code: 'failed' };
    try {
      const parsed = contract.input.safeParse({ projectId: p.projectId, context: { kind: '' }, question: p.question, threadId, ...(p.agentId ? { agentId: p.agentId } : {}) });
      if (!parsed.success) return { ok: false, code: 'failed' };
      const data = parsed.data as { context: object };
      const res = (await handler({}, { ...data, context: { ...data.context, noSources: true } })) as Reply | undefined;
      if (!res || res.ok !== true) return { ok: false, code: res?.notReady ? 'not_ready' : 'failed' };
      const turn = [...(await copilot.loadHistory(p.projectId, threadId))].reverse().find((t) => t.role === 'assistant');
      if (!turn) return { ok: false, code: 'failed' };
      const computed = turn.answer ? ({ kind: 'chart', spec: turn.answer } as const) : turn.sql ? ({ kind: 'sql' } as const) : null;
      const refused = !computed && (res.refused === true || !!turn.needs || !!turn.outside || !!turn.suggest || !!turn.link);
      return {
        ok: true, text: turn.text, datasetIds: [...new Set(shows(turn))],
        got: { computed, refused, auditOk: res.numberAudit?.ok !== false },
        calls: res.guidance?.verifiedId ? 0 : turn.sql ? 2 : 1, // a verified question answers with no model; an SQL answer writes its statement with a second call
      };
    } finally {
      await dropHidden(p.projectId, threadId).catch(() => undefined); // the sweep deletes one this misses
    }
  }, undefined, ac.signal);
  try {
    return await untilAborted(work, ac.signal);
  } catch (err) {
    if (signal?.aborted) throw err; // the lease was lost: the caller stops
    return { ok: false, code: 'timeout' };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onLost);
  }
}
