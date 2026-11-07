// Cells of the Data model's metrics table: the date a metric counts by (semantic D9, with its snapshot,
// D8) and whether it can be added up (D7). Both say what the server sent: `additivity` is the server's rule
// (`metric:table`), absent from an older pod and null when unknown, and both of those read "—". And the lock
// beside a metric or term the server marks hidden from the caller (part 4, D19), the Glossary's too.

import { Badge } from '../../../ui/Badge';
import { Icon } from '../../../ui/icons/Icon';
import { isFunnel, isPeriod, type MetricSummary } from '../../analyses/metrics/api';
import s from '../Model.module.css';
import d from '../../data/Data.module.css';

/** `why`: the server's refusal sentence, when it sent one (`metric:table`); else the app's words. */
export function HiddenLock({ why = 'Hidden from you: it uses a column limited to certain people.' }: { why?: string }) {
  return (
    <span className={d.lockedName} title={why}>
      <Icon name="lock" size={12} label={why} />
    </span>
  );
}

export interface Additivity {
  categories: boolean;
  time: boolean;
}

/** `list`: the table's metrics, where a period metric's base (part 5, D8) is found: it counts by the base's date. */
export function CountsBy({ m, list = [] }: { m: MetricSummary; list?: MetricSummary[] }) {
  const def = m.definition as MetricSummary['definition'] | undefined; // a summary without one draws no snapshot, never a crash
  const snap = def && 'column' in def ? def.snapshot : null;
  const base = def && isPeriod(def) ? list.find((b) => b.id === def.base) : undefined;
  if (def && isFunnel(def)) return <code className={s.formula}>{def.funnel.time}</code>; // part 5, D5: by its entries' time
  if (def && isPeriod(def)) {
    return base?.timeColumn ? (
      <span className={s.countsBy}>
        <code className={s.formula}>{base.timeColumn}</code>
        <span className={s.muted}>from {base.name}</span>
      </span>
    ) : (
      <span className={s.muted}>—</span>
    );
  }
  return (
    <span className={s.countsBy}>
      {m.timeColumn ? <code className={s.formula}>{m.timeColumn}</code> : <span className={s.muted}>Any date</span>}
      {snap && (
        <>
          <Badge>Snapshot</Badge>
          <span className={s.muted}>{`${snap.take} of ${snap.column}`}</span>
        </>
      )}
    </span>
  );
}

/** `period` / `funnel`: a period or funnel metric (part 5), which adds across categories for a different reason than a snapshot. */
export function AddsUp({ a, period = false, funnel = false }: { a: Additivity | null | undefined; period?: boolean; funnel?: boolean }) {
  if (!a) return <span className={s.muted}>—</span>;
  if (a.categories && a.time) return <Badge tone="ok">Yes</Badge>;
  const [word, why] = a.categories
    ? ['Not over time', period ? 'A running window: it adds up across categories, not across dates, since two of its windows overlap.'
      : funnel ? 'One entry per entity: it adds up across categories, not across dates, since an entity can enter in two of them.'
      : 'A snapshot: it adds up across categories, not across dates.']
    : ['No', "It can't be added up, so a total of it would be wrong."];
  return (
    <span title={why}>
      <Badge tone="warn">{word}</Badge>
      <span className={s.srOnly}>{why}</span>
    </span>
  );
}
