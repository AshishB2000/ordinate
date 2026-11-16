// Move to… (docs/team-folders, "What you will see"): pick where it goes, read what changes, then Move or Cancel. The
// warning is the server's (`folder:moveImpact`), and the move carries its hash: when who can open these changed since,
// the server refuses `move_changed`, and the dialog shows the new warning to agree to instead.

import { useState } from 'react';
import { RpcError } from '../../api/client';
import { Button } from '../../ui/Button';
import { Dialog, DialogClose } from '../../ui/Dialog';
import { toast } from '../../ui/Toast';
import { EVERYONE, byId, folderOfItem, useFolderWrite, type FolderTree, type PlacedKind } from './api';
import { Destinations, ImpactPanel, useImpact } from './MoveParts';
import s from './Folders.module.css';

export interface Movable {
  kind: PlacedKind;
  id: string;
  name: string;
}

export function MoveDialog({ projectId, tree, items, to: preset, onClose }: {
  projectId: string;
  tree: FolderTree;
  items: readonly Movable[];
  /** A destination picked already (a drop onto the rail). */
  to?: string;
  onClose: () => void;
}) {
  const current = items.length ? folderOfItem(tree, projectId, items[0].kind, items[0].id) : undefined;
  const [to, setTo] = useState<string | null>(preset && preset !== current ? preset : null);
  const [changed, setChanged] = useState<string | null>(null);
  const impact = useImpact(projectId, items, to);
  const move = useFolderWrite('folder:move');
  const where = to === projectId ? EVERYONE : to ? byId(tree).get(to)?.name : undefined;
  const title = items.length === 1 ? `Move “${items[0].name}”` : `Move ${items.length} items`;
  const go = () => {
    if (!to || !impact.data?.ok) return;
    move.mutate({ projectId, items: items.map(({ kind, id }) => ({ kind, id })), to, hash: impact.data.hash }, {
      onSuccess: (r) => {
        if (!r.ok) return toast(r.error, { kind: 'error' });
        toast(`Moved to ${where ?? 'the folder'}.`, { kind: 'success' });
        onClose();
      },
      onError: (err) => {
        // Access changed since the warning: show the new one and let them agree to it (the edit-conflicts pattern).
        if (err instanceof RpcError && err.code === 'folder') setChanged(err.message);
        else toast(err.message, { kind: 'error' });
        void impact.refetch();
      },
    });
  };
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      size="lg"
      title={title}
      description="Who can open it follows the folder it is in. What follows it moves too: a dataset's charts, metrics and notes; a dashboard's views, subscriptions, alerts and comments."
      footer={
        <>
          <DialogClose asChild>
            <Button>Cancel</Button>
          </DialogClose>
          <Button variant="primary" icon="folder" loading={move.isPending} disabled={!to || !impact.data?.ok} onClick={go}>
            {where ? `Move to ${where}` : 'Move'}
          </Button>
        </>
      }
    >
      <div className={s.body}>
        <p className={s.label}>Move to</p>
        <Destinations
          projectId={projectId}
          tree={tree}
          value={to}
          current={current}
          onChange={(id) => {
            setChanged(null);
            setTo(id);
          }}
        />
        {changed && (
          <p className={s.changed} role="alert">
            {changed}
          </p>
        )}
        <ImpactPanel query={impact} picked={!!to} />
      </div>
    </Dialog>
  );
}
