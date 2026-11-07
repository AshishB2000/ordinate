// Rename a relationship (plan 09). Its label names the join in charts ("Ship date"), so a chart can
// say which of two joins between the same two datasets it goes through. An empty label clears it.
// The server refuses a label another relationship between the same two datasets has; its sentence
// shows under the field and the dialog stays open.

import { useState } from 'react';
import { Button } from '../../ui/Button';
import { Dialog, DialogClose } from '../../ui/Dialog';
import { Input } from '../../ui/Field';
import { toast } from '../../ui/Toast';
import { useWrite, type Relationship } from './api';

export const LABEL_HINT = 'Names this join in charts, e.g. Ship date. Optional.';

export function RelationshipLabelDialog({ projectId, rel, onClose }: { projectId: string; rel: Relationship; onClose: () => void }) {
  const [label, setLabel] = useState(rel.label ?? '');
  const [error, setError] = useState('');
  const save = useWrite('relationship:save', ['relationship:list'], {
    quiet: true,
    onDone: (r: { ok?: boolean; error?: string }) => {
      if (!r.ok) return setError(r.error || 'Could not rename the relationship.');
      toast(label.trim() ? `Relationship renamed to ${label.trim()}.` : 'Relationship name removed.', { kind: 'success' });
      onClose();
    },
  });
  const submit = () => {
    setError('');
    // Always sent: an empty label is the user clearing it (a save without the key keeps the old one).
    save.mutate({ projectId, relationship: { id: rel.id, from: rel.from, to: rel.to, cardinality: rel.cardinality, label: label.trim() } });
  };
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="Rename relationship"
      description={`${rel.from.column} → ${rel.to.column}. Charts that pick this join show its name.`}
      footer={
        <>
          <DialogClose asChild>
            <Button>Cancel</Button>
          </DialogClose>
          <Button variant="primary" loading={save.isPending} onClick={submit}>
            Save
          </Button>
        </>
      }
    >
      <form onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <Input
          label="Label"
          hint={LABEL_HINT}
          error={error || undefined}
          value={label}
          maxLength={60}
          autoFocus
          onChange={(e) => { setLabel(e.target.value); setError(''); }}
        />
      </form>
    </Dialog>
  );
}
