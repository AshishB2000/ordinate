// Seeds for the issues board's suites: conversations and thumbs-down rows written straight into the tables the weekly check reads, so a
// test controls every turn's body (the real ask path is covered by the Assistant's own suites). Not a test file.

import { randomUUID } from 'crypto';
import type { World } from './rowPolicyHarness';

export const FIG = '8675309';
export const ROW = 'ROWVALUE_CANARY_3141';
export const DAY = 86_400_000;

export function seeds(W: World) {
  const P = W.P;
    let n = 0;
    /** One conversation: `[question, answerBody, answerText?]` pairs, seconds apart. */
    const seed = async (owner: string, pairs: Array<[string, Record<string, unknown>, string?]>, o: { hidden?: boolean; ageMs?: number } = {}) => {
      const thread = randomUUID();
      const t0 = Date.now() - (o.ageMs ?? 2 * DAY);
      await W.pool.query(`INSERT INTO assistant_threads (org_id, project_id, id, owner, title, created_at, updated_at, hidden) VALUES ('acme', $1, $2, $3, 'T', $4, $4, $5)`, [P, thread, owner, new Date(t0), !!o.hidden]);
      let seq = 0;
      const ids: string[] = [];
      for (const [q, body, text] of pairs) {
        const at = new Date(t0 + seq * 300_000);
        await W.pool.query(`INSERT INTO assistant_turns (org_id, project_id, thread_id, id, seq, role, text, created_at, body) VALUES ('acme', $1, $2, $3, $4, 'user', $5, $6, '{}')`, [P, thread, randomUUID(), seq++, q, at]);
        const id = randomUUID();
        ids.push(id);
        await W.pool.query(`INSERT INTO assistant_turns (org_id, project_id, thread_id, id, seq, role, text, created_at, body) VALUES ('acme', $1, $2, $3, $4, 'assistant', $5, $6, $7)`, [P, thread, id, seq++, text ?? `I could not chart that. ${FIG} ${ROW}`, new Date(at.getTime() + 1000), JSON.stringify({ factsFrom: [W.plain], ...body })]);
      }
      return ids;
    };
    const thumb = (owner: string, question: string, reason = 'wrong_number') => W.pool.query(
      `INSERT INTO assistant_feedback (org_id, project_id, turn_id, thread_id, owner, value, reason, question, dataset_ids, created_at, updated_at) VALUES ('acme', $1, $2, $3, $4, 'down', $5, $6, $7::jsonb, now() - interval '1 day', now() - interval '1 day')`,
      [P, `th${++n}`, randomUUID(), owner, reason, question, JSON.stringify([W.plain])]);
    const option = { label: 'Customer', spec: { datasetId: W.plain, category: 'region', measures: [{ column: 'sales', aggregation: 'sum' }] } };
    const define = (said: string) => ({ define: true, suggest: { part: 'filter', said, options: [option] }, snapshot: { card: { rows: [[ROW, FIG]] } }, ledger: [{ value: Number(FIG) }] });
  return { seed, thumb, define, option };
}
