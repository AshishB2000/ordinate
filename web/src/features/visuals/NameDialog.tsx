// Name (or rename) a visual — the desktop's promptModal: one field, the action
// disabled until there is a name, Enter submits, a failure stays in the dialog.

import { useState } from 'react';
import { Button } from '../../ui/Button';
import { Dialog, DialogClose } from '../../ui/Dialog';
import { Input } from '../../ui/Field';

export function NameDialog({
  name,
  title = 'Rename this visual',
  action = 'Rename',
  onClose,
  onRename,
}: {
  name: string;
  title?: string;
  action?: string;
  onClose: () => void;
  onRename: (name: string) => Promise<unknown>;
}) {
  const [value, setValue] = useState(name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submit = () => {
    if (!value.trim() || busy) return;
    setBusy(true);
    setError('');
    onRename(value.trim()).catch((e: Error) => {
      setError(e.message);
      setBusy(false);
    });
  };
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={title}
      size="sm"
      footer={
        <>
          <DialogClose asChild>
            <Button>Cancel</Button>
          </DialogClose>
          <Button variant="primary" loading={busy} disabled={!value.trim()} onClick={submit}>
            {action}
          </Button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <Input label="Name" value={value} maxLength={200} autoFocus error={error || undefined} onChange={(e) => setValue(e.target.value)} />
      </form>
    </Dialog>
  );
}
