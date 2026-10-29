// The editing screen's Ready switch — a STOPGAP over Publish (src/analysis/publishedCopy.ts) until the editor's
// Preview / Publish header replaces it: on publishes the dashboard as it stands (viewers see that copy, the
// Dashboards page lists it), off unpublishes it. Not an edit — no undo step and no autosave; Publish leaves
// `updatedAt` and the edit-conflict tag alone. An editor's only (the header draws it for them alone; the channels are `write`).

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Switch } from '../../ui/Choice';
import { toast } from '../../ui/Toast';
import { failure, openKey, useDraftActions, type OpenReply } from '../analyses/api';
import { useEditor } from '../analyses/editor/context';
import s from './ReadySwitch.module.css';

export function ReadySwitch() {
  const ed = useEditor();
  const client = useQueryClient();
  const acts = useDraftActions(ed.projectId, ed.analysisId);
  // The record the page opened with; kept current by useDraftActions, so the switch reads right after Present remounts the header.
  const [on, setOn] = useState(() => {
    const o = client.getQueryData<OpenReply>(openKey(ed.projectId, ed.analysisId));
    return !!(o?.ok && o.status !== 'draft');
  });
  const busy = acts.publish.isPending || acts.unpublish.isPending;
  const flip = async (next: boolean) => {
    setOn(next);
    try {
      await (next ? acts.publish.mutateAsync(undefined) : acts.unpublish.mutateAsync());
    } catch (err) {
      setOn(!next);
      return void toast(failure(err, 'Ready could not be changed.'), { kind: 'error' });
    }
    toast(next ? 'Ready: it is on the Dashboards page.' : 'Taken off the Dashboards page.', { kind: 'success' });
  };
  return (
    <Switch className={s.ready} label="Ready" title="Ready publishes this dashboard as it is now: viewers see that version until it is published again." checked={on} disabled={busy} onCheckedChange={(v) => void flip(v)} />
  );
}
