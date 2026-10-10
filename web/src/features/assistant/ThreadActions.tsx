// Rename and delete, for one of the caller's own conversations — one dialog the
// header's ⋯ menu and History's rows both open. The server acts only on the
// caller's threads and cleans the title (src/ai/copilot.ts); a delete takes the
// conversation's turns with it and is not undone, so it asks first.

import { useId, useState, type FormEvent } from 'react';
import { Button } from '../../ui/Button';
import { Dialog, DialogClose } from '../../ui/Dialog';
import { Input } from '../../ui/Field';
import { toast } from '../../ui/Toast';
import { deleteThread, renameThread } from './api';

export interface ThreadRef {
  id: string;
  title: string;
}
export interface ThreadAct {
  kind: 'rename' | 'delete';
  thread: ThreadRef;
}

export interface ThreadActionDialogProps {
  projectId: string;
  act: ThreadAct;
  onClose: () => void;
  /** The server did it: the lists and the open conversation are stale now. */
  onDone: (act: ThreadAct) => void;
}

/** Mounted per action (key it by the action), so each opens on that conversation's own title. */
export function ThreadActionDialog({ projectId, act, onClose, onDone }: ThreadActionDialogProps) {
  const formId = useId();
  const [title, setTitle] = useState(act.thread.title);
  const [busy, setBusy] = useState(false);
  const renaming = act.kind === 'rename';
  const named = title.trim();

  async function run(e?: FormEvent): Promise<void> {
    e?.preventDefault();
    if (busy || (renaming && !named)) return;
    setBusy(true);
    const ok = await (renaming ? renameThread(projectId, act.thread.id, named) : deleteThread(projectId, act.thread.id)).catch(() => false);
    setBusy(false);
    if (!ok) {
      toast(renaming ? 'Could not rename that conversation. It may have been deleted.' : 'Could not delete that conversation. It may already be gone.', { kind: 'error' });
      return;
    }
    if (!renaming) toast('Conversation deleted.', { kind: 'success' });
    onDone(act);
    onClose();
  }

  return (
    <Dialog
      open
      size="sm"
      onOpenChange={(o) => !o && onClose()}
      title={renaming ? 'Rename conversation' : 'Delete this conversation?'}
      description={renaming ? undefined : `“${act.thread.title}” and everything in it will be removed. This can’t be undone.`}
      footer={
        <>
          <DialogClose asChild>
            <Button>Cancel</Button>
          </DialogClose>
          {renaming ? (
            <Button variant="primary" type="submit" form={formId} loading={busy} disabled={!named || named === act.thread.title}>
              Rename
            </Button>
          ) : (
            <Button variant="danger" loading={busy} onClick={() => void run()}>
              Delete
            </Button>
          )}
        </>
      }
    >
      {renaming && (
        <form id={formId} onSubmit={(e) => void run(e)}>
          <Input label="Name" value={title} maxLength={60} autoFocus onFocus={(e) => e.target.select()} onChange={(e) => setTitle(e.target.value)} />
        </form>
      )}
    </Dialog>
  );
}
