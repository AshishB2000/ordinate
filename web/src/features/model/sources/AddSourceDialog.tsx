// + Add: any table of a connection, picked to start its notes (docs/semantic-layer/02-source-tables.md
// D4). It lists the connection's tables with `connection:listTables`, a warehouse call made only
// because it was opened (a click). Picking one creates its empty doc, idempotent by the exact name.

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Badge } from '../../../ui/Badge';
import { Dialog } from '../../../ui/Dialog';
import { Input } from '../../../ui/Field';
import { Icon } from '../../../ui/icons/Icon';
import { SkeletonRows } from '../../../ui/Skeleton';
import { EmptyState, ErrorState } from '../../../ui/States';
import { qualify, useTables } from '../../connections/api';
import { Alert } from './SourcePanel';
import { LIST, startNotes } from './api';
import x from './Sources.module.css';

/** Drawn at most: a warehouse can hold thousands; the search reaches the rest. */
const SHOWN = 200;

export function AddSourceDialog({ projectId, connId, connName, documented, onPicked, onClose }: {
  projectId: string;
  connId: string;
  /** Absent: a connection the tab lists nothing for yet. */
  connName?: string;
  /** The tables of this connection that already have notes, by exact name. */
  documented: ReadonlySet<string>;
  onPicked: (docId: string) => void;
  onClose: () => void;
}) {
  const client = useQueryClient();
  const tables = useTables(projectId, connId, true);
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState('');
  const [problem, setProblem] = useState('');
  const pick = async (table: string) => {
    setBusy(table);
    setProblem('');
    try {
      const docId = await startNotes(projectId, connId, table);
      await client.invalidateQueries({ queryKey: [LIST, projectId] });
      onPicked(docId);
    } catch (err) {
      setProblem(err instanceof Error && err.message ? err.message : 'The notes could not be started.');
      setBusy('');
    }
  };

  let body;
  if (tables.isPending) body = <SkeletonRows rows={6} label="Listing the tables" />;
  else if (tables.isError) body = <ErrorState compact heading={3} title="The tables could not be listed" message={tables.error.message || 'Try again.'} onRetry={() => void tables.refetch()} />;
  else if (!tables.data.length) {
    body = (
      <EmptyState compact heading={3} icon="table" title="No tables found">
        The connection lists no table its user can read.
      </EmptyState>
    );
  } else {
    const q = search.trim().toLowerCase();
    const names = tables.data.map(qualify).filter((n) => !q || n.toLowerCase().includes(q));
    body = !names.length ? (
      <EmptyState compact heading={3} icon="search" title="No table matches">
        Try another part of its name.
      </EmptyState>
    ) : (
      <>
        <ul className={x.pickList}>
          {names.slice(0, SHOWN).map((n) => (
            <li key={n}>
              <button type="button" className={x.pick} disabled={!!busy} aria-busy={busy === n || undefined} onClick={() => void pick(n)}>
                <Icon name="table" size={16} />
                <span className={x.mono}>{n}</span>
                {documented.has(n) && <Badge tone="ok">documented</Badge>}
              </button>
            </li>
          ))}
        </ul>
        {names.length > SHOWN && <p className={x.pickMore}>{`Showing the first ${SHOWN}. Search to find the others.`}</p>}
      </>
    );
  }
  return (
    <Dialog
      open
      size="md"
      onOpenChange={(o) => !o && onClose()}
      title="Add a source table"
      description={`${connName ? `Tables on ${connName}.` : 'Tables on this connection.'} Picking one starts its notes; a table with notes opens them.`}
    >
      <div className={x.form}>
        <Input icon="search" aria-label="Search tables" placeholder="Search tables" value={search} autoFocus onChange={(e) => setSearch(e.target.value)} />
        {problem && <Alert>{problem}</Alert>}
        {body}
      </div>
    </Dialog>
  );
}
