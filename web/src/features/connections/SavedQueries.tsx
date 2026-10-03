// A connection's saved queries (legacy connEditor.ts): chips that load one into
// the editor, rename and delete beside each, and the naming dialog a NEW save
// opens. A save of a loaded query updates it in place (its id is what a
// dataset's origin labels); a rename sends no SQL, so it can never overwrite
// the statement a dataset was built from. Every reply is the whole list.

import { useState, type FormEvent } from 'react';
import { Button, IconButton } from '../../ui/Button';
import { Dialog, DialogClose } from '../../ui/Dialog';
import { Input } from '../../ui/Field';
import { deleteQuery, saveQuery, type Connection, type SavedQuery } from './api';
import s from './Workbench.module.css';

export type QueryDialog =
  | null
  | { kind: 'create'; suggested: string }
  | { kind: 'rename'; q: SavedQuery }
  | { kind: 'delete'; q: SavedQuery };

export function SavedQueries({
  projectId,
  conn,
  sql,
  current,
  dialog,
  onDialog,
  onOpen,
  onCurrent,
  onChanged,
  onMessage,
}: {
  projectId: string;
  conn: Connection;
  sql: string;
  current: string;
  dialog: QueryDialog;
  onDialog: (d: QueryDialog) => void;
  onOpen: (q: SavedQuery) => void;
  onCurrent: (id: string) => void;
  onChanged: () => void;
  onMessage: (text: string, error: boolean) => void;
}) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [openFor, setOpenFor] = useState<QueryDialog>(null);
  // Seed the name box once per dialog opening.
  if (dialog !== openFor) {
    setOpenFor(dialog);
    setError('');
    setName(dialog?.kind === 'create' ? dialog.suggested : dialog?.kind === 'rename' ? dialog.q.name : '');
  }

  async function act(e?: FormEvent) {
    e?.preventDefault();
    if (!dialog) return;
    setBusy(true);
    setError('');
    try {
      if (dialog.kind === 'create') {
        const list = await saveQuery(projectId, conn.id, { name: name.trim() || dialog.suggested, sql: sql.trim() });
        // The new query is list[0] (newest first) and becomes the loaded one,
        // or the next save would make a second copy.
        if (list[0]) onCurrent(list[0].id);
        onMessage(`Saved as “${list[0]?.name ?? name}”.`, false);
      } else if (dialog.kind === 'rename') {
        if (!name.trim()) return setError('A name is required.');
        await saveQuery(projectId, conn.id, { id: dialog.q.id, name: name.trim() });
      } else {
        await deleteQuery(projectId, conn.id, dialog.q.id);
        if (current === dialog.q.id) onCurrent('');
      }
      onDialog(null);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That did not work.');
    } finally {
      setBusy(false);
    }
  }

  const title = dialog?.kind === 'create' ? 'Name this query' : dialog?.kind === 'rename' ? 'Rename this query' : 'Delete this query?';
  return (
    <>
      {conn.queries.length > 0 && (
        <ul className={s.chips} aria-label="Saved queries">
          {conn.queries.map((q) => (
            <li key={q.id} className={q.id === current ? `${s.chip} ${s.chipOn}` : s.chip}>
              <button type="button" className={s.chipOpen} title={q.sql} aria-pressed={q.id === current} onClick={() => onOpen(q)}>
                {q.name}
              </button>
              <IconButton size="sm" icon="pencil" label={`Rename ${q.name}`} onClick={() => onDialog({ kind: 'rename', q })} />
              <IconButton size="sm" icon="x" label={`Delete ${q.name}`} onClick={() => onDialog({ kind: 'delete', q })} />
            </li>
          ))}
        </ul>
      )}
      <Dialog
        open={dialog !== null}
        onOpenChange={(o) => !o && onDialog(null)}
        title={title}
        size="sm"
        description={dialog?.kind === 'delete' ? `“${dialog.q.name}” is removed. Datasets built from it keep refreshing — they carry the SQL, not the query.` : undefined}
        footer={
          <>
            <DialogClose asChild>
              <Button>Cancel</Button>
            </DialogClose>
            <Button variant={dialog?.kind === 'delete' ? 'danger' : 'primary'} loading={busy} onClick={() => void act()}>
              {dialog?.kind === 'create' ? 'Save' : dialog?.kind === 'rename' ? 'Rename' : 'Delete'}
            </Button>
          </>
        }
      >
        {dialog && dialog.kind !== 'delete' && (
          <form onSubmit={(e) => void act(e)}>
            <Input label="Query name" value={name} onChange={(e) => setName(e.target.value)} error={error || undefined} autoFocus />
          </form>
        )}
        {dialog?.kind === 'delete' && error && (
          <p className={s.msgError} role="alert">
            {error}
          </p>
        )}
      </Dialog>
    </>
  );
}
