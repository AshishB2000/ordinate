// The ask before removing what something reads: a Prepare step that makes a column, or a Live calculated
// field. It says what the field feeds, in the server's counts (lineage:fields). Undoable, so no typing back.

import { ConfirmDelete } from '../../ui/ConfirmDelete';
import { countParts, type UsedCounts } from '../model/api';

/** "1 metric, 3 charts" (a visual is a chart here); '' when nothing is fed. */
export const feedsText = (usedIn: UsedCounts): string => countParts(usedIn, { visual: 'chart' }).join(', ');

export function RemoveStepConfirm({ name, usedIn, busy, onConfirm, onClose }: { name: string; usedIn: UsedCounts; busy?: boolean; onConfirm: () => void; onClose: () => void }) {
  return (
    <ConfirmDelete
      title={`Delete “${name}”?`}
      description={`It feeds ${feedsText(usedIn)}. They will show an error until it is put back or they are changed.`}
      confirm="Delete"
      busy={busy}
      onConfirm={onConfirm}
      onClose={onClose}
    />
  );
}
