// The Dashboards page's dialogs for one card's ⋯: Rename, Unpublish (it comes off the page for viewers; the draft
// stays) and Delete (to the Trash). Each says what it does before it does it.

import { useState } from 'react';
import { rpc } from '../../../api/client';
import { Button } from '../../../ui/Button';
import { ConfirmDelete } from '../../../ui/ConfirmDelete';
import { Dialog, DialogClose } from '../../../ui/Dialog';
import { Input } from '../../../ui/Field';
import { toast } from '../../../ui/Toast';
import { failure, useDraftActions, type GalleryItem } from '../../analyses/api';
import { nameOf } from './DashboardCard';

export function RenameDialog({ projectId, item, onDone, onClose }: { projectId: string; item: GalleryItem; onDone: () => void; onClose: () => void }) {
  const [name, setName] = useState(item.name);
  const save = async () => {
    onClose();
    try {
      const r = (await rpc('analysis:rename', { projectId, id: item.id, name: name.trim() || item.name })) as { ok: boolean; error?: string };
      if (!r.ok) toast(failure(r, 'The dashboard could not be renamed.'), { kind: 'error' });
    } catch (err) {
      toast(failure(err, 'The dashboard could not be renamed.'), { kind: 'error' });
    }
    onDone();
  };
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      size="sm"
      title="Rename dashboard"
      footer={
        <>
          <DialogClose asChild>
            <Button variant="ghost">Cancel</Button>
          </DialogClose>
          <Button variant="primary" onClick={() => void save()}>
            Save
          </Button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <Input label="Name" value={name} onChange={(e) => setName(e.target.value)} autoFocus maxLength={200} />
      </form>
    </Dialog>
  );
}

export function UnpublishDialog({ projectId, item, onClose }: { projectId: string; item: GalleryItem; onClose: () => void }) {
  const { unpublish } = useDraftActions(projectId, item.id);
  return (
    <ConfirmDelete
      title={`Unpublish “${nameOf(item)}”?`}
      description="It comes off the Dashboards page, and viewers can no longer open it. The draft stays, and you can publish it again."
      confirm="Unpublish"
      busy={unpublish.isPending}
      onConfirm={() =>
        unpublish.mutate(undefined, {
          onSuccess: () => {
            onClose();
            toast(`“${nameOf(item)}” is a draft again.`, { kind: 'success' });
          },
          onError: (err) => toast(failure(err, 'The dashboard could not be unpublished.'), { kind: 'error' }),
        })
      }
      onClose={onClose}
    />
  );
}

export function DeleteDialog({ item, onConfirm, onClose }: { item: GalleryItem; onConfirm: () => void; onClose: () => void }) {
  return (
    <ConfirmDelete
      title={`Delete “${nameOf(item)}”?`}
      description="It moves to the Trash for 30 days. Restore it from there if you change your mind."
      onConfirm={onConfirm}
      onClose={onClose}
    />
  );
}
