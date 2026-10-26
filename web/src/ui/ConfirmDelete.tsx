// The one "are you sure?" before a delete. A delete that goes to the Trash
// asks once; one nothing brings back (a project, a connection) passes
// `typeToConfirm` and arms only when that name is typed back.

import { useState, type ReactNode } from 'react';
import { Button } from './Button';
import { Dialog, DialogClose } from './Dialog';
import { Input } from './Field';

export function ConfirmDelete({
  title,
  description,
  confirm = 'Delete',
  typeToConfirm,
  busy,
  onConfirm,
  onClose,
}: {
  title: string;
  description: ReactNode;
  confirm?: string;
  /** The name to type back before the button arms: only for a delete with no Trash. */
  typeToConfirm?: string;
  busy?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const [typed, setTyped] = useState('');
  const armed = typeToConfirm === undefined || typed.trim() === typeToConfirm.trim();
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      size="sm"
      title={title}
      description={description}
      footer={
        <>
          <DialogClose asChild>
            <Button>Keep it</Button>
          </DialogClose>
          <Button variant="danger" loading={busy} disabled={!armed} onClick={onConfirm}>
            {confirm}
          </Button>
        </>
      }
    >
      {typeToConfirm !== undefined && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (armed && !busy) onConfirm();
          }}
        >
          <Input label={`Type “${typeToConfirm}” to confirm`} value={typed} onChange={(e) => setTyped(e.target.value)} autoFocus autoComplete="off" />
        </form>
      )}
    </Dialog>
  );
}
