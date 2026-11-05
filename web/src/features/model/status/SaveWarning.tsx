// Before a figure-changing save to a certified item (semantic D5): who certified it and how many charts it moves.
// A hint; the truth is the server's (the badge turns to "Changed since certified" after the save).

import { Button } from '../../../ui/Button';
import { Dialog, DialogClose } from '../../../ui/Dialog';
import type { StatusView } from './status';

/** Does this save need the warning? Only a certified item whose edit moves the pin. */
export const needsWarning = (status: StatusView | undefined, moves: boolean): boolean => status?.state === 'certified' && moves;

export function SaveWarning({ name, status, used, onConfirm, onCancel }: { name: string; status: StatusView; used: string | undefined; onConfirm: () => void; onCancel: () => void }) {
  // `used`: the server's words for where it is used ("31 charts"); '' = nowhere yet; unknown reads as everything that uses it.
  const effect = used === '' ? 'Saving' : `Saving changes ${used ?? 'everything that uses it'} and`;
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onCancel()}
      size="sm"
      title="Change a certified definition?"
      description={`${name} is certified by ${status.by}. ${effect} needs a project admin to certify it again.`}
      footer={
        <>
          <DialogClose asChild>
            <Button variant="ghost">Cancel</Button>
          </DialogClose>
          <Button variant="primary" onClick={onConfirm}>
            Save anyway
          </Button>
        </>
      }
    />
  );
}
