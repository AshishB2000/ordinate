// What the weekly check READS (docs/issues-board/00-design.md): the stored conversations of one project, every member's, and the
// thumbs-down rows. Rows only: no engine, no dataset, no model. Hidden conversations (a suite run's) and deep-research turns are skipped.
// This is the one place that reads other people's conversations, and it hands out signals (the asker's question words and ids), never
// an answer's words.

import { normalizeTurns, type CopilotTurn } from '../../ai/copilot';
import { fromThumb, signalsOfThread, type Signal } from '../../ai/issueSignals';
import { ASKED_AGAIN_MS } from '../../ai/issueSignals';
import { inOrg } from '../db/inOrg';

/** Turns read in one check: the newest. A project past it is read as far back as this reaches. */
export const MAX_TURNS = 5000;

interface Row { thread_id: string; owner: string; id: string; role: string; text: string; created_at: Date; body: string }

function turnOf(r: Row): CopilotTurn | undefined {
  let extra: object = {};
  try {
    const b: unknown = JSON.parse(r.body);
    if (b && typeof b === 'object' && !Array.isArray(b)) extra = b;
  } catch { /* a damaged body keeps the turn, without its other fields */ }
  return normalizeTurns([{ ...extra, id: r.id, role: r.role, text: r.text, createdAt: r.created_at.toISOString() }])[0];
}

/** The signals of every conversation touched since `since`, and every thumbs-down row since then. */
export async function read(org: string, projectId: string, since: Date): Promise<Signal[]> {
  return inOrg(async (c) => {
    // A little before `since`, so a pair of asks that straddles it is still seen as a pair.
    const from = new Date(since.getTime() - ASKED_AGAIN_MS - 1000);
    const turns = (await c.query<Row>(
      `SELECT t.thread_id::text, th.owner, t.id::text, t.role, t.text, t.created_at, t.body
         FROM assistant_turns t JOIN assistant_threads th ON th.org_id = t.org_id AND th.project_id = t.project_id AND th.id = t.thread_id
        WHERE t.org_id = $1 AND t.project_id = $2 AND NOT th.hidden AND th.owner IS NOT NULL AND t.created_at >= $3
        ORDER BY t.created_at DESC, t.thread_id, t.seq DESC LIMIT $4`, [org, projectId, from, MAX_TURNS])).rows;
    const byThread = new Map<string, { owner: string; turns: Row[] }>();
    for (const r of turns.reverse()) (byThread.get(r.thread_id) ?? (byThread.set(r.thread_id, { owner: r.owner, turns: [] }), byThread.get(r.thread_id)!)).turns.push(r);
    const out: Signal[] = [];
    for (const t of byThread.values()) {
      out.push(...signalsOfThread(t.owner, t.turns.map(turnOf).filter((x): x is CopilotTurn => x !== undefined)).filter((s) => Date.parse(s.at) >= since.getTime()));
    }
    const thumbs = (await c.query<{ turnId: string; owner: string; question: string; reason: string | null; datasetIds: string[]; dashboardIds: string[]; at: string }>(
      `SELECT turn_id AS "turnId", owner, question, reason, dataset_ids AS "datasetIds", dashboard_ids AS "dashboardIds", updated_at::text AS at FROM assistant_feedback
        WHERE org_id = $1 AND project_id = $2 AND value = 'down' AND question IS NOT NULL AND updated_at >= $3 ORDER BY updated_at DESC LIMIT 2000`, [org, projectId, since])).rows;
    out.push(...thumbs.map((r) => fromThumb({ ...r, at: new Date(r.at).toISOString() })));
    return out;
  }, org);
}
