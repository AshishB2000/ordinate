// "Fresh on ask" (docs/live-data/00-plan.md L3.1) beside a dataset's refresh
// schedule — on the dataset page and in the connection workbench's rail. Off,
// or an age: a chart, KPI or answer that reads a copy older than that first
// pulls the rows added since (src/data/freshOnAsk.ts), waits a moment for
// them, and otherwise answers from the copy, "refreshing…".
//
// Only a dataset imported from a connection can have incremental refresh, so
// only it shows the control; without incremental refresh it is there but
// disabled, saying why (the server refuses it too, with the same reason). A
// Live dataset is asked at the warehouse every time and has no copy to keep
// fresh, so it never shows it. Whether the next refresh must be full is the
// server's answer (`freshOnAsk.fullDue`); this only draws it.

import { Badge } from '../../ui/Badge';
import { Select, type SelectOption } from '../../ui/Select';
import { NEEDS_INCREMENTAL } from './cadence';
import { useWrite } from './api';
import s from './FreshOnAsk.module.css';

/** What the control reads of a dataset (`dataset:list`'s summary). */
export interface FreshTarget {
  id: string;
  name: string;
  originKind?: string;
  mode?: 'live';
  incrementalOn?: true;
  freshOnAsk?: { maxStalenessSec: number; fullDue?: true };
}

/** The picker's ages, in seconds (src/data/freshOnAskRule.ts FRESH_ON_ASK_CHOICES). */
const CHOICES = [60, 300, 900, 3600];

/** "1 min", "15 min", "1 h", "90 s" — an age as the picker words it. */
export function ageWord(sec: number): string {
  if (sec % 3600 === 0) return `${sec / 3600} h`;
  if (sec % 60 === 0) return `${sec / 60} min`;
  return `${sec} s`;
}

/** Off and the four ages — plus a stored age set through the API that is not one of them, so the picker shows what is stored. */
export function freshOptions(stored: number | undefined): SelectOption[] {
  const ages = stored !== undefined && !CHOICES.includes(stored) ? [...CHOICES, stored].sort((a, b) => a - b) : CHOICES;
  return [{ value: 'off', label: 'Fresh on ask off' }, ...ages.map((a) => ({ value: String(a), label: `Fresh on ask · ${ageWord(a)}` }))];
}

const EXPLAIN = 'Fresh on ask: before a chart, KPI or answer reads this dataset, pull the rows added since the last refresh if the copy is older than this. It waits a few seconds for them, otherwise answers from the copy and updates when they land.';
const WHY_OFF = 'Fresh on ask pulls only the rows added since the last refresh, so it needs incremental refresh on this dataset. A full re-fetch on every question would overload the source.';
const FULL_DUE = 'This dataset\'s next refresh must be a full one (its first, every 7th, or one asked for). Fresh on ask only pulls new rows, so it waits until a scheduled refresh or Refresh now has run it.';

/** `wide`: the full width of a narrow column (the workbench rail), the reason under the picker rather than beside it. */
export function FreshOnAskPicker({ projectId, d, onChanged, wide }: { projectId: string; d: FreshTarget; onChanged?: () => void; wide?: boolean }) {
  const set = useWrite('dataset:update', ['dataset:list'], { onDone: () => onChanged?.() });
  if (d.originKind !== 'connection' || d.mode === 'live') return null;
  const on = !!d.incrementalOn;
  const stored = d.freshOnAsk?.maxStalenessSec;
  return (
    <span className={wide ? `${s.fresh} ${s.wide}` : s.fresh} title={on ? EXPLAIN : WHY_OFF}>
      <Select
        size="sm"
        aria-label={on ? `Fresh on ask for ${d.name}` : `Fresh on ask for ${d.name} — ${NEEDS_INCREMENTAL}`}
        className={s.select}
        value={on && stored !== undefined ? String(stored) : 'off'}
        options={freshOptions(stored)}
        disabled={!on || set.isPending}
        onValueChange={(v) => set.mutate({ projectId, datasetId: d.id, freshOnAsk: v === 'off' ? null : { maxStalenessSec: Number(v) } })}
      />
      {!on && <span className={s.note}>{NEEDS_INCREMENTAL}</span>}
      {on && stored !== undefined && d.freshOnAsk?.fullDue && (
        <span title={FULL_DUE}>
          <Badge tone="warn" icon="history">
            Waits for a full refresh
          </Badge>
        </span>
      )}
    </span>
  );
}
