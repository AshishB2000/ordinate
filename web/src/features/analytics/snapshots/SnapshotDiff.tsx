// Compare a snapshot with now (snapshotDiffView.ts) — the panel under the
// Snapshots list. Every count and cell is the server's (src/engine/
// snapshotDiff.ts, DuckDB over the two Parquet files); this lays them out and
// formats nothing but thousands separators.

import { useState, type ReactNode } from 'react';
import { formatNumber } from '../../../../../src/app/format.ts';
import { IconButton } from '../../../ui/Button';
import { Select } from '../../../ui/Select';
import { SkeletonTable } from '../../../ui/Skeleton';
import { ErrorState } from '../../../ui/States';
import { useDiff, when, type Cell, type Diff, type SnapshotItem, type SnapshotList } from './api';
import s from './Snapshots.module.css';

function V({ v }: { v: Cell }) {
  return v === null ? <span className={s.null}>(empty)</span> : <span>{v}</span>;
}

function Section({ title, n, shown, children }: { title: string; n: number; shown: number; children: ReactNode }) {
  return (
    <section className={s.sec}>
      <h4 className={s.secH}>{`${title} · ${formatNumber(n)}`}</h4>
      <div className={s.scroll}>{children}</div>
      {n > shown && <p className={s.more}>{`Showing the first ${formatNumber(shown)} of ${formatNumber(n)}.`}</p>}
    </section>
  );
}

function RowsTable({ columns, rows, label }: { columns: string[]; rows: Diff['added']; label: string }) {
  return (
    <table className={s.grid}>
      <caption className={s.sr}>{label}</caption>
      <thead>
        <tr>
          {columns.map((c) => (
            <th key={c} scope="col">
              {c}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i}>
            {r.values.map((v, j) => (
              <td key={j}>
                <V v={v} />
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Result({ diff }: { diff: Diff }) {
  const notes: string[] = [];
  if (diff.mode === 'row') notes.push('Matched on the whole row: a row with any cell different reads as one removed and one added.');
  if (diff.duplicates.old || diff.duplicates.new) {
    notes.push(`${formatNumber(diff.duplicates.old + diff.duplicates.new)} row(s) repeat an earlier ${diff.key} (${diff.duplicates.old} then, ${diff.duplicates.new} now) — only the first row of each is compared.`);
  }
  if (diff.addedColumns.length) notes.push(`New columns, not compared: ${diff.addedColumns.join(', ')}.`);
  if (diff.removedColumns.length) notes.push(`Columns since removed, not compared: ${diff.removedColumns.join(', ')}.`);
  const total = diff.counts.added + diff.counts.removed + diff.counts.changed;
  const chip = (kind: string, n: number, word: string) => (
    <span className={`${s.chip} ${s[`chip_${kind}`]}`}>
      <b>{formatNumber(n)}</b> {word}
    </span>
  );
  return (
    <div className={s.out}>
      <div className={s.sum}>
        {chip('added', diff.counts.added, 'added')}
        {chip('removed', diff.counts.removed, 'removed')}
        {diff.mode === 'key' && chip('changed', diff.counts.changed, 'changed')}
        {chip('same', diff.counts.unchanged, 'unchanged')}
      </div>
      {notes.map((n) => (
        <p key={n} className={s.note}>
          {n}
        </p>
      ))}
      {total === 0 ? (
        <p className={s.same}>No differences — the compared columns hold the same rows.</p>
      ) : (
        <>
          {diff.counts.changed > 0 && (
            <Section title="Changed" n={diff.counts.changed} shown={diff.changed.length}>
              <table className={s.grid}>
                <caption className={s.sr}>Changed cells</caption>
                <thead>
                  <tr>
                    <th scope="col">{diff.key || 'Row'}</th>
                    <th scope="col">Column</th>
                    <th scope="col">Before</th>
                    <th scope="col">After</th>
                  </tr>
                </thead>
                <tbody>
                  {diff.changed.flatMap((r, ri) =>
                    r.cells.map((c, i) => (
                      <tr key={`${ri}:${i}`}>
                        {i === 0 && (
                          <th scope="row" rowSpan={r.cells.length} className={s.key}>
                            <V v={r.key} />
                          </th>
                        )}
                        <td>{c.column}</td>
                        <td className={s.before}>
                          <V v={c.old} />
                        </td>
                        <td className={s.after}>
                          <V v={c.new} />
                        </td>
                      </tr>
                    )),
                  )}
                </tbody>
              </table>
            </Section>
          )}
          {diff.counts.added > 0 && (
            <Section title="Added since" n={diff.counts.added} shown={diff.added.length}>
              <RowsTable columns={diff.columns} rows={diff.added} label="Rows added since the snapshot" />
            </Section>
          )}
          {diff.counts.removed > 0 && (
            <Section title="Removed since" n={diff.counts.removed} shown={diff.removed.length}>
              <RowsTable columns={diff.columns} rows={diff.removed} label="Rows removed since the snapshot" />
            </Section>
          )}
        </>
      )}
    </div>
  );
}

export function SnapshotDiff({ projectId, datasetId, item, current, onClose }: { projectId: string; datasetId: string; item: SnapshotItem; current: SnapshotList['current']; onClose: () => void }) {
  const [key, setKey] = useState<string | null>(null);
  const q = useDiff(projectId, datasetId, item.stamp, key);
  const shared = current.columns.filter((c) => item.columns.includes(c));
  return (
    <section className={s.diff} aria-label="Comparison">
      <div className={s.diffHead}>
        <h3 className={s.diffH}>{`${when(item.at)} compared with now`}</h3>
        <div className={s.diffTools}>
          <div className={s.keyPick}>
            <Select
              label="Match rows by"
              size="sm"
              value={key ?? ''}
              options={[{ value: '', label: 'the whole row' }, ...shared.map((c) => ({ value: c, label: c }))]}
              onValueChange={(v) => setKey(v || null)}
            />
          </div>
          <IconButton icon="x" size="sm" label="Close the comparison" onClick={onClose} />
        </div>
      </div>
      {q.isPending ? (
        <SkeletonTable rows={4} cols={4} label="Comparing…" />
      ) : q.isError ? (
        <ErrorState compact heading={4} title="Could not compare the snapshot" message={q.error.message} onRetry={() => void q.refetch()} />
      ) : (
        <Result diff={q.data} />
      )}
    </section>
  );
}
