// What ONE column contains (dsProfile.ts): type, how much of it is filled, how
// many distinct values, min / median / max for numbers, and the shape — a
// histogram for a number column, top values for text, rows by month for a
// date. EVERY figure and every bar length arrives computed (`dataset:profile`,
// src/data/profileView.ts); this panel only draws them.

import { Link } from 'react-router';
import { Button, buttonClass, IconButton } from '../../ui/Button';
import { Panel } from '../../ui/Panel';
import { SkeletonRows } from '../../ui/Skeleton';
import { ErrorState } from '../../ui/States';
import { toast } from '../../ui/Toast';
import { useProfile, type ColumnDoc, type Profile } from './api';
import { ColumnDetails } from './Details';
import { figure, formatNumber, rowsText } from './format';
import s from './Data.module.css';
import g from './Grid.module.css';

const HEADING = { distribution: 'Distribution', month: 'Rows by month', top: 'Top values' } as const;

function Chart({ d }: { d: NonNullable<Profile['distribution']> }) {
  if (d.kind === 'histogram') {
    return (
      <>
        <div className={g.hist} role="img" aria-label={`Histogram of ${d.bars.length} buckets`}>
          {d.bars.map((b, i) => (
            <span
              key={i}
              className={b.value === 0 ? `${g.histBar} ${g.histEmpty}` : g.histBar}
              style={b.value === 0 ? undefined : { height: `${b.pct}%` }}
              title={`${b.label || '—'} · ${rowsText(b.value)}`}
            />
          ))}
        </div>
        <div className={g.histAxis}>
          <span>{d.lo}</span>
          <span>{d.hi}</span>
        </div>
        <p className={s.note}>
          {d.bars.length} buckets · {rowsText(d.total ?? 0)}
        </p>
      </>
    );
  }
  return (
    <>
      {d.heading === 'top' && d.of > d.bars.length && (
        <p className={s.note}>
          Top {d.bars.length} of {formatNumber(d.of)} values shown
        </p>
      )}
      <div className={g.bars}>
        {d.bars.map((b) => (
          <div key={b.label} className={g.barRow}>
            <span className={g.barLabel} title={b.label}>
              {b.label}
            </span>
            <span className={g.barTrack}>
              <span className={g.barFill} style={{ width: `${b.pct}%` }} />
            </span>
            <span className={g.barN}>{formatNumber(b.value)}</span>
          </div>
        ))}
      </div>
    </>
  );
}

export function ProfilePanel({ projectId, datasetId, column, doc, onClose, onFilter, onRename }: {
  projectId: string;
  datasetId: string;
  column: string;
  doc: ColumnDoc;
  onClose: () => void;
  /** "Filter rows on this": the grid's own search, pointed at the most common value. */
  onFilter: (value: string) => void;
  onRename: () => void;
}) {
  const q = useProfile(projectId, datasetId, column);
  const p = q.data;
  const facts: [string, string][] = p
    ? [
        ['Filled', p.filled === null ? '—' : `${formatNumber(p.filled)} of ${formatNumber(p.rowCount)}${p.filledPct === null ? '' : ` (${p.filledPct}%)`}`],
        ['Empty', figure(p.empty)],
        ['Distinct', figure(p.distinct)],
        ...(p.type === 'number'
          ? ([
              ['Min', figure(p.min)],
              ['Median', figure(p.median)],
              ['Max', figure(p.max)],
            ] as [string, string][])
          : []),
      ]
    : [];
  return (
    <Panel
      title={column}
      sub={p ? `${p.type} column` : 'Column profile'}
      onClose={onClose}
      className={g.profile}
      footer={
        <div className={g.profileActions}>
          <Link className={buttonClass('secondary', 'sm')} to={`/visuals?project=${projectId}&datasetId=${datasetId}&column=${encodeURIComponent(column)}`}>
            Chart this column
          </Link>
          <Button
            size="sm"
            onClick={() => (p?.mostCommon ? onFilter(p.mostCommon) : toast('This column has no repeated value to filter on.'))}
          >
            Filter rows on this
          </Button>
          <Button size="sm" onClick={onRename}>
            Rename
          </Button>
          <ColumnDetails
            projectId={projectId}
            datasetId={datasetId}
            column={column}
            doc={doc}
            example={p?.mostCommon ?? undefined}
            trigger={<IconButton icon="info" size="sm" label="Column details — description, display name, sensitivity" />}
          />
        </div>
      }
    >
      {doc.description && <p className={g.profileDoc}>{doc.description}</p>}
      {q.isPending ? (
        <SkeletonRows rows={5} label={`Reading ${column}`} />
      ) : q.isError ? (
        <ErrorState compact heading={3} title="The column could not be profiled" message={q.error.message} onRetry={() => void q.refetch()} />
      ) : p ? (
        <>
          <dl className={g.facts}>
            {facts.map(([k, v]) => (
              <div key={k} className={g.fact}>
                <dt>{k}</dt>
                <dd>{v}</dd>
              </div>
            ))}
          </dl>
          <section aria-label={p.distribution ? HEADING[p.distribution.heading] : 'Distribution'}>
            <h3 className={g.chartHead}>{p.distribution ? HEADING[p.distribution.heading] : p.type === 'number' ? 'Distribution' : 'Top values'}</h3>
            {p.distribution ? <Chart d={p.distribution} /> : <p className={s.note}>No values to chart in this column.</p>}
          </section>
        </>
      ) : null}
    </Panel>
  );
}
