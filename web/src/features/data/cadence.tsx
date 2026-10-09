// Refresh schedules on screen (L0.3): the fast options a dataset without
// incremental refresh cannot take, and the "Behind schedule" badge. Shared by
// the Data list and page, the connection workbench's rail and the Pipelines
// step panel. Whether a dataset is behind is the server's answer
// (src/data/refreshCadence.ts); this only draws it.

import { Badge } from '../../ui/Badge';
import type { SelectOption } from '../../ui/Select';

/** Only an incremental refresh may run this often; the server refuses it otherwise. */
const FAST: ReadonlySet<string> = new Set(['5min', '15min']);

/** Why a fast option is greyed out, in its own label (a disabled option has no tooltip). */
export const NEEDS_INCREMENTAL = 'needs incremental refresh';

/**
 * A schedule picker's options for one dataset: every 5 or 15 minutes is
 * offered only when its incremental refresh is on, and otherwise shown
 * disabled, saying why.
 */
export function cadenceOptions(options: readonly SelectOption[], incrementalOn: boolean): SelectOption[] {
  return options.map((o) => (FAST.has(o.value) && !incrementalOn ? { ...o, label: `${o.label} — ${NEEDS_INCREMENTAL}`, disabled: true } : o));
}

const BEHIND_TITLE = 'The last scheduled refresh took longer than the schedule allows, so this data is older than the schedule promises.';

/** "Behind schedule", when the server says the last scheduled refresh ran past its interval. */
export function BehindBadge({ behind }: { behind: boolean | undefined }) {
  if (!behind) return null;
  return (
    <span title={BEHIND_TITLE}>
      <Badge tone="warn" icon="history">
        Behind schedule
      </Badge>
    </span>
  );
}
