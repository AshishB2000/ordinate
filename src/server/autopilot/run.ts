// One Autopilot run of one project (docs/autopilot/00-design.md, phases 2 and 3): check the admin it acts as, read the project, plan
// (./plan.ts, pure), do the two safe things (a Trash move, an exact rename repair) and list the rest. Every action is a row with what
// Undo needs. No model.

import * as trash from '../../app/trash';
import * as versions from '../../app/versions';
import * as visuals from '../../analysis/visuals';
import { isRecordChanged } from '../../app/editConflict';
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
async function act(runId: string, projectId: string, plan: Plan, s: store.Settings, names: ReadonlyMap<string, string>): Promise<void> {
  const by = ctx().user.email;
  const done = await store.handledIn(runId);
  const add = (it: store.NewItem): Promise<number> => store.addItem(runId, projectId, it);

  for (const t of plan.trash) {
    if (done.has(`trashed:${t.visualId}`)) continue;
    if (!s.trashUnused) {
      await add({ kind: 'trashed', visualId: t.visualId, name: t.name, state: 'listed', detail: { days: s.windowDays }, undo: null });
      continue;
    }
    const r = await trash.trashRecord(projectId, 'visual', t.visualId, { keepDays: KEEP_DAYS, reason: { kind: 'autopilot', days: s.windowDays, by } });
    await add({ kind: 'trashed', visualId: t.visualId, name: t.name, state: r.ok ? 'applied' : 'failed', detail: { days: s.windowDays, ...(r.ok ? {} : { why: 'refused' }) }, undo: null });
  }

  for (const r of plan.repair) {
    if (done.has(`repaired:${r.visualId}`)) continue;
    const read = await visuals.readVisual(projectId, r.visualId);
    const detail = { fixes: r.fixes, datasetId: r.datasetId, datasetName: names.get(r.datasetId) ?? '' };
    const fail = (why: string) => add({ kind: 'repaired', visualId: r.visualId, name: r.name, state: 'failed', detail: { ...detail, why }, undo: null });
    if (!read) { await fail('gone'); continue; }
    const before = read.rec;
    const next = repairedDefinition(before, new Map(r.fixes.map((f) => [f.from, f.to])));
    if (same(next, definitionOf(before))) { await fail('not_saved'); continue; }
    let updated: Awaited<ReturnType<typeof visuals.updateVisual>>;
    try {
      updated = await visuals.updateVisual(projectId, r.visualId, next, read.tag); // the version this run read: a save made since is a person's, never overwritten
    } catch (err) {
      if (!isRecordChanged(err)) throw err;
      await fail('changed');
      continue;
    }
    if (!updated) { await fail('not_saved'); continue; }
    await versions.record(projectId, 'visual', updated, { before, by: `Autopilot (as ${by})` }); // the old version stays in its history
    await add({ kind: 'repaired', visualId: r.visualId, name: r.name, state: 'applied', detail, undo: { before: definitionOf(before), after: definitionOf(updated) } });
  }

  for (const b of plan.broken) {
    if (done.has(`broken:${b.visualId}`)) continue;
    await add({ kind: 'broken', visualId: b.visualId, name: b.name, state: 'listed', detail: { gone: b.gone, datasetId: b.datasetId, datasetName: names.get(b.datasetId) ?? '' }, undo: null });
  }
  for (const w of plan.slow) {
    if (done.has(`slow:${w.visualId}`)) continue;
    await add({ kind: 'slow', visualId: w.visualId, name: w.name, state: 'listed', detail: { avgMs: w.avgMs, maxMs: w.maxMs, computes: w.computes, datasetId: w.datasetId, datasetName: names.get(w.datasetId) ?? '' }, undo: null });
  }
}

/** The run's counts, from ALL its rows: a run retaken after a crash counts what the first attempt did too. */
export function countsOf(rows: readonly store.Item[]): Record<string, number> {
  const n = (k: store.ItemKind, st: store.ItemState): number => rows.filter((i) => i.kind === k && i.state === st).length;
  return { trashed: n('trashed', 'applied'), repaired: n('repaired', 'applied'), broken: n('broken', 'listed'), slow: n('slow', 'listed'), wouldTrash: n('trashed', 'listed'), failed: rows.filter((i) => i.state === 'failed').length };
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
  await act(runId, s.projectId, plan, s, names);
  const counts = countsOf(await store.items(runId));
  await store.finishRun(runId, 'done', { ranAs: ctx().user.email, coveredFrom: plan.coveredFrom, counts });
  return { state: 'done', counts, ranAs: ctx().user.email };
}
