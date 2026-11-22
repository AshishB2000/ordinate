// One Autopilot run of one project (docs/autopilot/00-design.md, phases 2 and 3): check the admin it acts as, read the project, plan
// (./plan.ts, pure), do the two safe things (a Trash move, an exact rename repair) and list the rest. Every action is a row with what
// Undo needs. No model.

import * as trash from '../../app/trash';
import * as versions from '../../app/versions';
import * as visuals from '../../analysis/visuals';
import { logger } from '../../app/logger';
import { ctx } from '../context';
import { asMember } from '../requests/where';
import { readProject } from './read';
import { planRun, type Plan } from './plan';
import { repairedDefinition } from './repair';
import * as store from './store';

/** How long Autopilot's Trash items stay (the owner's Q2); a person's own delete keeps 30. */
export const KEEP_DAYS = 90;

export interface Outcome { state: 'done' | 'paused'; counts: Record<string, number>; ranAs: string }

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** The chart's two definition fields, as the store holds them. */
const definitionOf = (v: { encoding: unknown; filters: unknown }): { encoding: unknown; filters: unknown } => ({ encoding: v.encoding, filters: v.filters });

/** Do the plan's actions as the acting admin (the caller's context) and write each row. Idempotent for a retaken run. */
async function act(runId: string, projectId: string, plan: Plan, s: store.Settings, names: ReadonlyMap<string, string>): Promise<Record<string, number>> {
  const by = ctx().user.email;
  const done = await store.handledIn(runId);
  const counts = { trashed: 0, repaired: 0, broken: 0, slow: 0, failed: 0, wouldTrash: 0 };
  const add = (it: store.NewItem): Promise<number> => store.addItem(runId, projectId, it);

  for (const t of plan.trash) {
    if (done.has(`trashed:${t.visualId}`)) continue;
    if (!s.trashUnused) {
      await add({ kind: 'trashed', visualId: t.visualId, name: t.name, state: 'listed', detail: { days: s.windowDays }, undo: null });
      counts.wouldTrash += 1;
      continue;
    }
    const r = await trash.trashRecord(projectId, 'visual', t.visualId, { keepDays: KEEP_DAYS, reason: { kind: 'autopilot', days: s.windowDays, by } });
    if (r.ok) counts.trashed += 1;
    else counts.failed += 1;
    await add({ kind: 'trashed', visualId: t.visualId, name: t.name, state: r.ok ? 'applied' : 'failed', detail: { days: s.windowDays, ...(r.ok ? {} : { why: 'refused' }) }, undo: null });
  }

  for (const r of plan.repair) {
    if (done.has(`repaired:${r.visualId}`)) continue;
    const before = await visuals.getVisual(projectId, r.visualId);
    const detail = { fixes: r.fixes, datasetId: r.datasetId, datasetName: names.get(r.datasetId) ?? '' };
    if (!before) { counts.failed += 1; await add({ kind: 'repaired', visualId: r.visualId, name: r.name, state: 'failed', detail: { ...detail, why: 'gone' }, undo: null }); continue; }
    const next = repairedDefinition(before, new Map(r.fixes.map((f) => [f.from, f.to])));
    const updated = same(next, definitionOf(before)) ? null : await visuals.updateVisual(projectId, r.visualId, next);
    if (!updated) { counts.failed += 1; await add({ kind: 'repaired', visualId: r.visualId, name: r.name, state: 'failed', detail: { ...detail, why: 'not_saved' }, undo: null }); continue; }
    await versions.record(projectId, 'visual', updated, { before, by: `Autopilot (as ${by})` }); // the old version stays in its history
    counts.repaired += 1;
    await add({ kind: 'repaired', visualId: r.visualId, name: r.name, state: 'applied', detail, undo: { before: definitionOf(before), after: definitionOf(updated) } });
  }

  for (const b of plan.broken) {
    if (done.has(`broken:${b.visualId}`)) continue;
    counts.broken += 1;
    await add({ kind: 'broken', visualId: b.visualId, name: b.name, state: 'listed', detail: { gone: b.gone, datasetId: b.datasetId, datasetName: names.get(b.datasetId) ?? '' }, undo: null });
  }
  for (const w of plan.slow) {
    if (done.has(`slow:${w.visualId}`)) continue;
    counts.slow += 1;
    await add({ kind: 'slow', visualId: w.visualId, name: w.name, state: 'listed', detail: { avgMs: w.avgMs, maxMs: w.maxMs, computes: w.computes, datasetId: w.datasetId, datasetName: names.get(w.datasetId) ?? '' }, undo: null });
  }
  return counts;
}

/**
 * Run `runId` (already claimed) for the project, in the caller's org context. The admin it acts as is checked first: an account that is
 * gone, disabled or no longer an admin pauses it, changing nothing. Never throws for a project problem: the run is `failed`.
 */
export async function runProject(runId: string, s: store.Settings, today: string): Promise<Outcome | { state: 'failed' }> {
  const who = s.runAs;
  try {
    const out = who ? await asMember(who, async () => (ctx().user.role === 'admin' ? ranAs(runId, s, today) : null)) : null;
    if (!out) {
      await store.pause(s.projectId, 'lost_admin');
      await store.finishRun(runId, 'paused', { ranAs: who, coveredFrom: null, counts: {} });
      return { state: 'paused', counts: {}, ranAs: who ?? '' };
    }
    return out;
  } catch (err) {
    logger.warn(`[autopilot] a run failed (${String((err as { code?: unknown })?.code ?? (err as Error)?.message ?? 'error').slice(0, 120)})`);
    await store.finishRun(runId, 'failed', { ranAs: who, coveredFrom: null, counts: {} }).catch(() => undefined);
    return { state: 'failed' };
  }
}

async function ranAs(runId: string, s: store.Settings, today: string): Promise<Outcome> {
  const input = await readProject(s.projectId, s, today);
  const plan = planRun(input);
  const names = new Map([...input.datasets].map(([id, d]) => [id, d.name]));
  const counts = await act(runId, s.projectId, plan, s, names);
  await store.finishRun(runId, 'done', { ranAs: ctx().user.email, coveredFrom: plan.coveredFrom, counts });
  return { state: 'done', counts, ranAs: ctx().user.email };
}
