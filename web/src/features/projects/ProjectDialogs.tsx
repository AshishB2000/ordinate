// The switcher's small dialogs: a name (New project, Rename — the legacy
// promptModal) and Delete, which asks for the project's name typed back
// because nothing brings a deleted project back (no Trash for a whole one).

import { useState, type FormEvent } from 'react';
import { rpc } from '../../api/client';
import { Button } from '../../ui/Button';
import { Dialog, DialogClose } from '../../ui/Dialog';
import { Input } from '../../ui/Field';
import { toast } from '../../ui/Toast';
import type { ProjectRow } from './api';
import s from './Projects.module.css';

export function NameDialog({
  title,
  confirm,
  initial,
  run,
  onClose,
}: {
  title: string;
  confirm: string;
  initial: string;
  /** Does the work with the trimmed name; a throw keeps the dialog open with a toast. */
  run: (name: string) => Promise<void>;
  onClose: () => void;
}) {
  const [name, setName] = useState(initial);
  const [busy, setBusy] = useState(false);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    run(name.trim()).then(onClose, (err: unknown) => {
      setBusy(false);
      toast(`${title} did not go through: ${err instanceof Error ? err.message : String(err)}.`, { kind: 'error' });
    });
  };
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      size="sm"
      title={title}
      footer={
        <>
          <DialogClose asChild>
            <Button>Cancel</Button>
          </DialogClose>
          <Button variant="primary" type="submit" form="project-name-form" loading={busy}>
            {confirm}
          </Button>
        </>
      }
    >
      <form id="project-name-form" className={s.dialogBody} onSubmit={submit}>
        <Input
          label="Project name"
          placeholder="Untitled project"
          maxLength={200}
          value={name}
          onChange={(e) => setName(e.target.value)}
          autoFocus
          onFocus={(e) => e.currentTarget.select()}
        />
      </form>
    </Dialog>
  );
}

export function DeleteDialog({ project, onClose, onDeleted }: { project: ProjectRow; onClose: () => void; onDeleted: () => void }) {
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const matches = typed.trim() === project.name.trim();
  const del = () => {
    setBusy(true);
    rpc('projects:delete', { id: project.id }).then(
      (r) => {
        if ((r as { ok?: boolean } | null)?.ok) {
          onDeleted();
          onClose();
        } else {
          setBusy(false);
          toast('The project could not be deleted.', { kind: 'error' });
        }
      },
      (err: unknown) => {
        setBusy(false);
        toast(`The project could not be deleted: ${err instanceof Error ? err.message : String(err)}.`, { kind: 'error' });
      },
    );
  };
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      size="sm"
      title={`Delete ${project.name}?`}
      description="Every dataset, visual, dashboard and report in it is deleted for good, with its history. This cannot be undone — to hide it instead, archive it."
      footer={
        <>
          <DialogClose asChild>
            <Button>Keep it</Button>
          </DialogClose>
          <Button variant="danger" loading={busy} disabled={!matches} onClick={del}>
            Delete project
          </Button>
        </>
      }
    >
      <form
        className={s.dialogBody}
        onSubmit={(e) => {
          e.preventDefault();
          if (matches && !busy) del();
        }}
      >
        <Input label={`Type “${project.name}” to confirm`} value={typed} onChange={(e) => setTyped(e.target.value)} autoFocus autoComplete="off" />
      </form>
    </Dialog>
  );
}
