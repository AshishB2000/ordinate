// A one-field naming dialog: a sheet, the dashboard, a saved view. Save trims;
// an empty name saves nothing. Its own file so the editor's head and the views
// menu (dashboards/views) can both use it without importing each other.

import { useState } from 'react';
import { Button } from '../../../ui/Button';
import { Dialog, DialogClose } from '../../../ui/Dialog';
import { Input } from '../../../ui/Field';

export function NameDialog({ title, initial, onSave, onClose, maxLength = 200, saveLabel = 'Save' }: { title: string; initial: string; onSave: (v: string) => void; onClose: () => void; maxLength?: number; saveLabel?: string }) {
  const [v, setV] = useState(initial);
  const save = () => {
    if (v.trim()) onSave(v.trim());
    onClose();
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
            <Button variant="ghost">Cancel</Button>
          </DialogClose>
          <Button variant="primary" onClick={save}>
            {saveLabel}
          </Button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <Input label="Name" value={v} onChange={(e) => setV(e.target.value)} autoFocus maxLength={maxLength} />
      </form>
    </Dialog>
  );
}
