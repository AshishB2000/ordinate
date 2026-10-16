// "Figures that moved" in a version compare (docs/version-diff): each KPI card's
// figure under each version's spec, computed NOW by the server on current data
// (`versions:figures`). The display strings are the server's formatter's; whether
// a figure moved is the server's verdict. A Live failure is the server's sentence,
// shown in the open — never a retry, never a stored figure.

import { LiveRefusalLine } from '../live/LiveOff';
import { Icon } from '../../ui/icons/Icon';
import { Skeleton } from '../../ui/Skeleton';
import { ErrorState } from '../../ui/States';
import { useVersionFigures, type FigureSide, type VersionType } from './api';
import s from './VersionCompare.module.css';

function Side({ side, missing }: { side: FigureSide | null; missing: string }) {
  if (!side) return <span className={s.figNone}>{missing}</span>;
  if (side.ok) return <span className={s.figValue}>{side.display}</span>;
  if (side.code && side.code.startsWith('live_')) return <LiveRefusalLine message={side.error} />;
  return (
    <span className={s.figError}>
      <Icon name="alert" size={12} />
      {side.error}
    </span>
  );
}

export function VersionFigures({ projectId, type, id, from, to, rows, fromLabel, toLabel }: {
  projectId: string;
  type: VersionType;
  id: string;
  from: string;
  to: string;
  /** How many rows the diff said to expect: the skeleton's size. */
  rows: number;
  fromLabel: string;
  toLabel: string;
}) {
  const q = useVersionFigures(projectId, type, id, from, to, rows > 0);
  let body;
  if (q.isPending) {
    body = (
      <div className={s.figRows} role="status" aria-busy="true" aria-label="Working out the figures">
        {Array.from({ length: Math.min(rows, 6) }, (_, i) => (
          <div key={i} className={s.figRow}>
            <Skeleton className={s.skCell} />
            <Skeleton className={s.skCell} />
            <span />
            <Skeleton className={s.skCell} />
          </div>
        ))}
      </div>
    );
  } else if (q.isError) {
    body = <ErrorState compact heading={4} title="The figures could not be worked out" message={q.error.message} onRetry={() => void q.refetch()} />;
  } else {
    body = (
      <table className={s.figTable}>
        <colgroup>
          <col />
          <col />
          <col />
          <col />
        </colgroup>
        <thead>
          <tr>
            <th scope="col">Card</th>
            <th scope="col">{fromLabel}</th>
            <th scope="col" aria-label="becomes" />
            <th scope="col">{toLabel}</th>
          </tr>
        </thead>
        <tbody>
          {q.data.map((f) => (
            <tr key={f.cardId} className={f.moved ? '' : s.figSame}>
              <th scope="row">
                <span className={s.figTitle}>{f.title}</span>
                <span className={s.figReason}>{f.moved ? f.reason : `${f.reason} · same figure`}</span>
              </th>
              <td>
                <Side side={f.before} missing={`Not in ${fromLabel}`} />
              </td>
              <td className={s.figArrow} aria-hidden="true">
                <Icon name="arrow-right" size={12} />
              </td>
              <td>
                <Side side={f.after} missing={`Not in ${toLabel}`} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    );
  }
  return (
    <section className={s.section} aria-label="Figures that moved">
      <div className={s.sectionHead}>
        <h3>Figures that moved</h3>
        <span className={s.sectionNote}>Each version’s spec, computed now on current data</span>
      </div>
      {body}
    </section>
  );
}
