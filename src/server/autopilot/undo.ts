// Undo of one row of a report (docs/autopilot/00-design.md, phase 3), as the admin who presses it.
//   a Trash move   → the chart comes back from the Trash, and counts as used today, so next week does not move it again;
//   a repair       → the chart's previous definition goes back, but only while the chart is still what Autopilot wrote:
//                    a person's edit since is theirs, and Undo refuses it ("changed") rather than overwrite it.
// Done once: a second Undo of the same row finds it undone and changes nothing.

import { isDeepStrictEqual } from 'node:util';
import * as trash from '../../app/trash';
import * as versions from '../../app/versions';
import * as visuals from '../../analysis/visuals';
import { isRecordChanged } from '../../app/editConflict';
import { ctx } from '../context';
import * as store from './store';

export type UndoResult = { ok: true } | { ok: false; why: 'missing' | 'not_applied' | 'changed' | 'gone' | 'failed' };

// Not JSON.stringify: the definition went through a jsonb column, which does not keep key order.
const same = isDeepStrictEqual;

export async function undoItem(projectId: string, runId: string, seq: number): Promise<UndoResult> {
  const it = await store.getItem(runId, seq);
  if (!it) return { ok: false, why: 'missing' };
  if (it.state !== 'applied') return { ok: false, why: 'not_applied' };
  const by = ctx().user.email;
  const today = new Date().toISOString().slice(0, 10);

  if (it.kind === 'trashed') {
    const r = await trash.restore(projectId, 'visual', it.visualId);
    if (!r.ok) return { ok: false, why: 'failed' };
    await store.markUsed(projectId, it.visualId, today);
  } else if (it.kind === 'repaired') {
    const undo = it.undo as { before: { encoding: unknown; filters: unknown }; after: { encoding: unknown; filters: unknown } } | null;
    const read = await visuals.readVisual(projectId, it.visualId);
    if (!read || !undo) return { ok: false, why: 'gone' };
    const now = read.rec;
    if (!same({ encoding: now.encoding, filters: now.filters }, undo.after)) return { ok: false, why: 'changed' };
    let back: Awaited<ReturnType<typeof visuals.updateVisual>>;
    try {
      back = await visuals.updateVisual(projectId, it.visualId, undo.before, read.tag); // checked and written under the record's own lock: a save in between is kept
    } catch (err) {
      if (isRecordChanged(err)) return { ok: false, why: 'changed' };
      throw err;
    }
    if (!back) return { ok: false, why: 'failed' };
    await versions.record(projectId, 'visual', back, { before: now, by: `Autopilot undo (by ${by})` });
  } else {
    return { ok: false, why: 'not_applied' };
  }
  return (await store.markUndone(runId, seq)) ? { ok: true } : { ok: false, why: 'not_applied' };
}

/** Undo every applied repair of a run, in order; how many went back and how many were refused. */
export async function undoRepairs(projectId: string, runId: string): Promise<{ undone: number; refused: number }> {
  let undone = 0;
  let refused = 0;
  for (const it of await store.items(runId)) {
    if (it.kind !== 'repaired' || it.state !== 'applied') continue;
    if ((await undoItem(projectId, runId, it.seq)).ok) undone += 1;
    else refused += 1;
  }
  return { undone, refused };
}
