// A dashboard's saved views, and the one door every edit to them takes
// (docs/dashboard-filters/00-design.md). `run` writes any pending document
// edit first, then — in the same queue the autosave writes in — sends the op
// with the state on screen to `analysis:view`, which re-sanitizes it against
// the record. A refusal is the server's sentence in a toast; nothing is
// changed here until the server has answered.

import { useQueryClient } from '@tanstack/react-query';
import { rpc } from '../../../api/client';
import { toast } from '../../../ui/Toast';
import type { ViewOp, ViewOpReply } from '../../analyses/api';
import { useEditor } from '../../analyses/editor/context';

export function useSavedViews() {
  const ed = useEditor();
  const client = useQueryClient();
  const run = async (op: ViewOp): Promise<boolean> => {
    await ed.save.flush();
    const sent = op.op === 'create' || op.op === 'update' ? { ...op, state: ed.views.gather() } : op;
    let r: ViewOpReply;
    try {
      r = (await ed.save.queue(() => rpc('analysis:view', { projectId: ed.projectId, id: ed.analysisId, op: sent }))) as ViewOpReply;
    } catch (err) {
      toast(`The view could not be saved: ${(err as Error).message}`, { kind: 'error' });
      return false;
    }
    if (!r.ok) {
      toast(r.error, { kind: 'error' });
      return false;
    }
    // A new view is the one on screen; deleting the one on screen leaves none named.
    const gone = op.op === 'delete' && op.viewId.toLowerCase() === ed.views.applied.toLowerCase();
    ed.views.settle(r.views, r.defaultViewId, op.op === 'create' ? r.viewId : gone ? '' : ed.views.applied);
    // Where views are listed: ⌘K's rows, the Subscribe dialog's picker, the dashboards list.
    for (const key of ['search:query', 'subscription:preview', 'analysis:gallery']) void client.invalidateQueries({ queryKey: [key, ed.projectId] });
    return true;
  };
  return { ...ed.views, run };
}
