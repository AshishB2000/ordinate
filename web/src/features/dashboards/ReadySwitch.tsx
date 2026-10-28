// The editing screen's Ready switch: on lists the dashboard on the Dashboards page, off takes it off. Not an edit — no
// undo step and no autosave; `analysis:setReady` leaves `updatedAt` and the edit-conflict tag alone, so it never clashes
// with the sheets being edited. An editor's only (the header draws it for them alone; the channel is `write`).

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { rpc } from '../../api/client';
import { Switch } from '../../ui/Choice';
import { toast } from '../../ui/Toast';
import { failure, type OpenReply } from '../analyses/api';
import { useEditor } from '../analyses/editor/context';
import s from './ReadySwitch.module.css';

export function ReadySwitch() {
  const ed = useEditor();
  const client = useQueryClient();
  const key = ['analysis:open', ed.projectId, ed.analysisId];
  // The record the page opened with; kept current below, so the switch reads right after Present remounts the header.
  const [on, setOn] = useState(() => {
    const o = client.getQueryData<OpenReply>(key);
    return !!(o?.ok && o.analysis.ready);
  });
  const [busy, setBusy] = useState(false);
  const flip = async (next: boolean) => {
    setOn(next);
    setBusy(true);
    const r = (await rpc('analysis:setReady', { projectId: ed.projectId, id: ed.analysisId, ready: next }).catch((err: unknown) => ({ ok: false, error: failure(err, '') }))) as {
      ok: boolean;
      error?: string;
    };
    setBusy(false);
    if (!r.ok) {
      setOn(!next);
      return void toast(failure(r, 'Ready could not be changed.'), { kind: 'error' });
    }
    client.setQueryData<OpenReply>(key, (o) => (o?.ok ? { ...o, analysis: { ...o.analysis, ready: next || undefined } } : o));
    void client.invalidateQueries({ queryKey: ['analysis:gallery', ed.projectId] });
    toast(next ? 'Ready: it is on the Dashboards page.' : 'Taken off the Dashboards page.', { kind: 'success' });
  };
  return (
    <Switch className={s.ready} label="Ready" title="Ready dashboards are listed on the Dashboards page. Nothing else changes." checked={on} disabled={busy} onCheckedChange={(v) => void flip(v)} />
  );
}
