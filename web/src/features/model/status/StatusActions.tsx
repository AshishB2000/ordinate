// Certify, Retire and Clear: a project admin's, and nobody else's (the server enforces it; this follows). Dialogs are
// lazy, so the review's diff view costs the initial bundle nothing.

import { lazy, Suspense, useState } from 'react';
import { Button, IconButton } from '../../../ui/Button';
import type { IconName } from '../../../ui/icons/Icon';
import { Menu } from '../../../ui/Menu';
import { toast } from '../../../ui/Toast';
import { useCan } from '../../projects/api';
import { refOf, useStatusActions } from './api';
import type { StatusKind, StatusView } from './status';

const ReviewDialog = lazy(() => import('./ReviewDialog').then((m) => ({ default: m.ReviewDialog })));
const RetireDialog = lazy(() => import('./RetireDialog').then((m) => ({ default: m.RetireDialog })));

export function StatusActions({ projectId, kind, id, name, status, compact }: { projectId: string; kind: StatusKind; id: string; name: string; status?: StatusView; compact?: boolean }) {
  const admin = useCan(projectId)('admin');
  const { clear } = useStatusActions(projectId);
  const [open, setOpen] = useState<'review' | 'retire' | null>(null);
  if (!admin) return null;
  const retired = status?.state === 'retired';
  const doClear = () =>
    clear.mutate({ ref: refOf(kind, id) }, { onSuccess: (r) => toast(r.ok ? `${name} has no status now.` : r.error, { kind: r.ok ? 'success' : 'error' }) });
  const entries: { label: string; icon: IconName; onSelect: () => void }[] = [
    ...(retired ? [] : [{ label: status?.state === 'needs_review' ? 'Review and certify…' : 'Certify…', icon: 'circle-check' as const, onSelect: () => setOpen('review') }]),
    ...(retired ? [] : [{ label: 'Retire…', icon: 'archive' as const, onSelect: () => setOpen('retire') }]),
    ...(status ? [{ label: 'Clear status', icon: 'x' as const, onSelect: doClear }] : []),
  ];
  if (!entries.length) return null;
  const dialogs = (
    <Suspense fallback={null}>
      {open === 'review' && <ReviewDialog projectId={projectId} kind={kind} id={id} name={name} onClose={() => setOpen(null)} />}
      {open === 'retire' && <RetireDialog projectId={projectId} kind={kind} id={id} name={name} onClose={() => setOpen(null)} />}
    </Suspense>
  );
  if (compact) {
    return (
      <>
        <Menu label={`Status of ${name}`} align="end" trigger={<IconButton icon="shield" size="sm" label={`Status of ${name}`} />} items={entries} />
        {dialogs}
      </>
    );
  }
  return (
    <>
      {entries.map((e) => (
        <Button key={e.label} size="sm" icon={e.icon} onClick={e.onSelect}>
          {e.label}
        </Button>
      ))}
      {dialogs}
    </>
  );
}
