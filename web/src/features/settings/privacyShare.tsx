// The Share policy at every door data leaves by — privacyShare.ts, ported, for
// the export, report and publish screens to use (T2.9, T2.13), not to copy:
//
//   <ShareNote …/>    the line an export dialog shows: "2 sensitive columns
//                     will be masked · Change". Nothing when no column on the
//                     way out is marked.
//   useShareGate()    may this export run? Under 'include' only after an
//                     explicit confirmation naming the columns; under mask or
//                     drop it always may (the server shapes the data).
//
// The masking itself is the server's (src/app/sharePolicy.ts): the key never
// reaches a browser.

import { useCallback, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { rpc } from '../../api/client';
import { Button } from '../../ui/Button';
import { Dialog } from '../../ui/Dialog';
import { Icon } from '../../ui/icons/Icon';
import type { SharePath, ShareSummary } from './api';
import s from './Settings.module.css';

const POLICY = '/settings?tab=privacy';

async function summary(projectId: string, path: SharePath, datasetIds: string[] | null): Promise<ShareSummary | null> {
  const r = (await rpc('privacy:summary', { projectId, path, datasetIds })) as ShareSummary;
  return r && r.ok ? r : null;
}

/** "email (Customers), card_number (Customers)" — the columns a line is about. */
export function columnList(sum: Pick<ShareSummary, 'columns'>, max = 6): string {
  const names = sum.columns.slice(0, max).map((c) => (c.datasetName ? `${c.column} (${c.datasetName})` : c.column));
  return names.join(', ') + (sum.columns.length > max ? ` and ${sum.columns.length - max} more` : '');
}

export function ShareNote({ projectId, path, datasetIds }: { projectId: string; path: SharePath; datasetIds: string[] | null }) {
  const q = useQuery({ queryKey: ['privacy:summary', projectId, path, datasetIds], queryFn: () => summary(projectId, path, datasetIds) });
  if (!q.data || !q.data.count) return null;
  return (
    <div className={s.note} role="status" title={columnList(q.data, 20)}>
      <Icon name="shield" /> {q.data.line} · <Link to={POLICY}>Change</Link>
    </div>
  );
}

/** `gate(...)` resolves true when the export may run; render `dialog` once in the caller. */
export function useShareGate(): { gate: (projectId: string, path: SharePath, datasetIds: string[] | null) => Promise<boolean>; dialog: ReactNode } {
  const navigate = useNavigate();
  const [ask, setAsk] = useState<ShareSummary | null>(null);
  const answer = useRef<(v: boolean) => void>(() => {});
  const gate = useCallback(async (projectId: string, path: SharePath, datasetIds: string[] | null) => {
    const sum = await summary(projectId, path, datasetIds);
    if (!sum || !sum.count || sum.action !== 'include') return true;
    return new Promise<boolean>((resolve) => {
      answer.current = resolve;
      setAsk(sum);
    });
  }, []);
  const close = (v: boolean) => {
    setAsk(null);
    answer.current(v);
  };
  const dialog = (
    <Dialog
      open={!!ask}
      onOpenChange={(o) => !o && close(false)}
      title="Include sensitive data?"
      description={ask ? `Anyone who receives this will see ${columnList(ask)} as they are. ${ask.line}.` : undefined}
      footer={
        <>
          <Button
            onClick={() => {
              close(false);
              void navigate(POLICY);
            }}
          >
            Change policy
          </Button>
          <Button onClick={() => close(false)}>Cancel</Button>
          <Button variant="primary" onClick={() => close(true)}>
            Include and export
          </Button>
        </>
      }
    >
      <p className={s.lead}>The Share policy for this project says to include them, and to ask first.</p>
    </Dialog>
  );
  return { gate, dialog };
}
