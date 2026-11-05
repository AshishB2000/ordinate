// Two cells of the Data model's metrics table: the date a metric counts by (semantic D9, with its snapshot,
// D8) and whether it can be added up (D7). Both say what the server sent: `additivity` is the server's rule
// (`metric:table`), absent from an older pod and null when unknown, and both of those read "—".

import { Badge } from '../../../ui/Badge';
import { isPeriod, type MetricSummary } from '../../analyses/metrics/api';
import s from '../Model.module.css';

export interface Additivity {
  categories: boolean;
  time: boolean;
}

/** `list`: the table's metrics, where a period metric's base (part 5, D8) is found: it counts by the base's date. */
export function CountsBy({ m, list = [] }: { m: MetricSummary; list?: MetricSummary[] }) {
  const def = m.definition as MetricSummary['definition'] | undefined; // a summary without one draws no snapshot, never a crash
  const snap = def && 'column' in def ? def.snapshot : null;
  const base = def && isPeriod(def) ? list.find((b) => b.id === def.base) : undefined;
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

export function AddsUp({ a }: { a: Additivity | null | undefined }) {
  if (!a) return <span className={s.muted}>—</span>;
  if (a.categories && a.time) return <Badge tone="ok">Yes</Badge>;
  const [word, why] = a.categories
    ? ['Not over time', 'A snapshot: it adds up across categories, not across dates.']
    : ['No', "It can't be added up, so a total of it would be wrong."];
  return (
    <span title={why}>
      <Badge tone="warn">{word}</Badge>
      <span className={s.srOnly}>{why}</span>
    </span>
  );
}
