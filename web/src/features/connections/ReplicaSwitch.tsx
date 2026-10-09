// The rail's Live opt-in (docs/live-data/00-plan.md L3.2, D8). An OLTP source —
// PostgreSQL — is offered Live only on a connection marked "This is a read
// replica or a warehouse": the new-connection form asks it as a checkbox, and
// here it can be changed later. It takes effect at once, so it is a Switch,
// as every setting that applies without a Save. The server refuses to turn it
// off while Live datasets ask the connection; that refusal (how many, and what
// to do) is shown in place, and the switch stays on.

import { useState } from 'react';
import { Switch } from '../../ui/Choice';
import { toast } from '../../ui/Toast';
import { setLiveOptIn, type CatalogField, type Connection } from './api';
import s from './Workbench.module.css';

export function ReplicaSwitch({ f, conn, projectId, onChanged }: { f: CatalogField; conn: Connection; projectId: string; onChanged: () => void }) {
  // What the server last confirmed, until the refetched connection says the same.
  const [confirmed, setConfirmed] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const on = confirmed ?? conn.values[f.key] === true;
  async function change(next: boolean) {
    setBusy(true);
    setError('');
    try {
      setConfirmed(await setLiveOptIn(projectId, conn.id, next));
      toast(next ? 'Live is now offered for datasets from this connection.' : 'Live is off for this connection.', { kind: 'success' });
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not change it.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className={s.optIn}>
      <Switch label={f.label} hint={f.help} checked={on} disabled={busy} aria-busy={busy || undefined} onCheckedChange={(v) => void change(v)} />
      {error && (
        <p className={s.testError} role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
