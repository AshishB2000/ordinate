// Link tables: which warehouse tables a query dataset reads. A label for the notes and the lineage; it
// changes no refresh and no Live statement. The list is `dataset:sourceTableChoices`, a warehouse call
// made once, when this opens; the query's own words come first (the server sorts, never links).

import { useState } from 'react';
import { Button } from '../../../ui/Button';
import { Checkbox } from '../../../ui/Choice';
import { Dialog } from '../../../ui/Dialog';
import { Input } from '../../../ui/Field';
import { SkeletonRows } from '../../../ui/Skeleton';
import { EmptyState, ErrorState } from '../../../ui/States';
import { useSetSourceTables, useSourceChoices } from '../sources/linksApi';
import { Alert } from '../sources/SourcePanel';
import n from './SourceNotes.module.css';

const MAX = 16;
/** Drawn at most: a warehouse can hold thousands; the search reaches the rest. */
const SHOWN = 200;

function Picker({ choices, linked, projectId, datasetId, onClose }: { choices: string[]; linked: string[]; projectId: string; datasetId: string; onClose: () => void }) {
  const save = useSetSourceTables(projectId, datasetId);
  const [picked, setPicked] = useState<string[]>(linked);
  const [search, setSearch] = useState('');
  const q = search.trim().toLowerCase();
  // A linked table the warehouse no longer lists stays visible, so Save never drops it unseen.
  const all = [...choices, ...linked.filter((t) => !choices.includes(t))];
  const shown = all.filter((t) => !q || t.toLowerCase().includes(q));
  const full = picked.length >= MAX;
  const toggle = (t: string, on: boolean) => setPicked((p) => (on ? [...p, t] : p.filter((x) => x !== t)));
  return (
    <>
      <Input icon="search" aria-label="Search tables" placeholder="Search tables" value={search} autoFocus onChange={(e) => setSearch(e.target.value)} />
      {save.isError && <Alert>{save.error.message}</Alert>}
      {!shown.length ? (
        <EmptyState compact heading={3} icon="table" title={all.length ? 'No table matches' : 'No tables found'}>
          {all.length ? 'Try another part of its name.' : 'The connection lists no table its user can read.'}
        </EmptyState>
      ) : (
        <ul className={n.pickList}>
          {shown.slice(0, SHOWN).map((t) => (
            <li key={t}>
              <Checkbox label={t} checked={picked.includes(t)} disabled={full && !picked.includes(t)} onCheckedChange={(on) => toggle(t, on)} />
            </li>
          ))}
        </ul>
      )}
      <div className={n.dialogFoot}>
        <span className={n.count}>{full ? `${MAX} at most` : `${picked.length} of ${MAX} linked`}</span>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" loading={save.isPending} onClick={() => save.mutate(picked, { onSuccess: onClose })}>
          Save
        </Button>
      </div>
    </>
  );
}

export function LinkTablesDialog({ projectId, datasetId, onClose }: { projectId: string; datasetId: string; onClose: () => void }) {
  const q = useSourceChoices(projectId, datasetId);
  let body;
  if (q.isPending) body = <SkeletonRows rows={6} label="Listing the tables" />;
  else if (q.isError) body = <ErrorState compact heading={3} title="The tables could not be listed" message={q.error.message || 'Try again.'} onRetry={() => void q.refetch()} />;
  else body = <Picker choices={q.data.tables} linked={q.data.linked} projectId={projectId} datasetId={datasetId} onClose={onClose} />;
  return (
    <Dialog open size="md" onOpenChange={(o) => !o && onClose()} title="Link tables" description="The warehouse tables this query reads. Their notes show in this dataset's Guide; nothing about how it refreshes changes.">
      <div className={n.form}>{body}</div>
    </Dialog>
  );
}
