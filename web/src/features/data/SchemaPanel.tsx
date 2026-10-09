// A Live dataset's Schema tab (docs/live-data/00-plan.md L2.5, L2.6): what the
// last "Sync schema" read from the warehouse — when, from how big a sample,
// each column's filled share, distinct count and sample values — and the
// columns gone from the warehouse with what still names them. "Sync schema"
// re-reads it now (one cost-guarded query). Every figure is the server's
// (`dataset:liveSchema`), and each says it comes from a sample.

import { useState } from 'react';
import { Button } from '../../ui/Button';
import { Icon } from '../../ui/icons/Icon';
import { SkeletonTable } from '../../ui/Skeleton';
import { EmptyState, ErrorState } from '../../ui/States';
import { useCan } from '../projects/api';
import { figure, formatNumber, pctText, rowsText, stamp } from './format';
import { useLiveSchema, useSyncSchema, type LiveSchema, type MissingColumn, type SyncReply } from './liveApi';
import s from './Data.module.css';
import l from './LiveData.module.css';

const USE_WORD: Record<MissingColumn['usedBy'][number]['kind'], string> = { visual: 'visual', metric: 'metric', kpi: 'KPI tile', control: 'dashboard control', alert: 'alert' };

/** "Profiled from a sample of 240 rows · 7:12 PM" — or why there is no sample yet. */
export function sampleLine(v: Pick<LiveSchema, 'sampledAt' | 'sampleRows' | 'method'>): string {
  if (!v.sampledAt || v.sampleRows === null) return 'Not profiled yet — Sync schema reads the columns and a sample of the rows.';
  const how = v.method === 'limit' ? ' (the first rows — this table could not be sampled at random)' : '';
  return `Profiled from a sample of ${rowsText(v.sampleRows)}${how} · ${stamp(v.sampledAt)}`;
}

/** What a sync found, in one line. */
export function syncWords(r: SyncReply): { text: string; error?: boolean } {
  if (!r.ok) return { text: r.error || 'The schema could not be synced.', error: true };
  if (r.status === 'already_running') return { text: r.message };
  const changes = [
    r.added.length ? `added ${r.added.join(', ')}` : '',
    r.removed.length ? `gone ${r.removed.join(', ')}` : '',
    r.retyped.length ? `retyped ${r.retyped.join(', ')}` : '',
  ].filter(Boolean);
  const sample = r.sample.ok ? `profiled from ${rowsText(r.sample.rows)}` : r.sample.error;
  return { text: `Synced ${formatNumber(r.columns)} ${r.columns === 1 ? 'column' : 'columns'}${changes.length ? ` — ${changes.join('; ')}` : ''}. ${sample.charAt(0).toUpperCase()}${sample.slice(1)}${/[.!?]$/.test(sample) ? '' : '.'}`, error: !r.sample.ok };
}

function Missing({ missing }: { missing: MissingColumn[] }) {
  return (
    <div className={l.missing} role="alert">
      <Icon name="alert" size={16} />
      <div>
        <p className={l.missingHead}>{missing.length === 1 ? 'A column is gone from the warehouse' : `${formatNumber(missing.length)} columns are gone from the warehouse`}</p>
        <ul>
          {missing.map((m) => (
            <li key={m.column}>
              <strong>{m.column}</strong>
              {m.usedBy.length > 0 && ` — used by ${m.usedBy.map((u) => `the ${USE_WORD[u.kind]} “${u.name}”`).join(', ')}`}
            </li>
          ))}
        </ul>
        <p className={s.note}>Figures that name it say “column missing” until it is back or they stop naming it.</p>
      </div>
    </div>
  );
}

export function SchemaPanel({ projectId, datasetId }: { projectId: string; datasetId: string }) {
  const q = useLiveSchema(projectId, datasetId);
  const sync = useSyncSchema(projectId, datasetId);
  const can = useCan(projectId);
  const [said, setSaid] = useState<{ text: string; error?: boolean } | null>(null);
  const run = () =>
    sync.mutate(undefined, {
      onSuccess: (r) => setSaid(syncWords(r)),
      onError: (err) => setSaid({ text: `The schema could not be synced: ${err.message}`, error: true }),
    });
  if (q.isPending) return <SkeletonTable cols={5} rows={6} label="Loading the schema" />;
  if (q.isError) return <ErrorState heading={3} title="The schema could not be loaded" message={q.error.message} onRetry={() => void q.refetch()} />;
  const v = q.data;
  const busy = sync.isPending || v.syncing;
  return (
    <section className={s.section} aria-label="Schema">
      <div className={l.schemaHead}>
        <div className={l.schemaFacts}>
          <p className={l.schemaSynced}>{`Columns synced from the warehouse ${stamp(v.schemaSyncedAt)}`}</p>
          <p className={s.note}>{sampleLine(v)}</p>
          {v.note && <p className={l.warnNote}>{v.note}</p>}
        </div>
        <Button
          icon="refresh"
          size="sm"
          loading={busy}
          disabled={!can('editor')}
          title="Re-read the columns and profile a sample of the rows — one query, cost-guarded"
          onClick={run}
        >
          {v.syncing && !sync.isPending ? 'Syncing…' : 'Sync schema'}
        </Button>
      </div>
      {said && (
        <p className={said.error ? s.rowError : s.rowNote} role="status">
          {said.text}
        </p>
      )}
      {v.missing.length > 0 && <Missing missing={v.missing} />}
      {v.columns.length === 0 ? (
        <EmptyState icon="columns" heading={3} title="No columns">
          The warehouse described no columns for this selection. Sync the schema to read it again.
        </EmptyState>
      ) : (
        <div className={s.card}>
          <table className={`${s.table} ${l.schemaTable}`}>
            <thead>
              <tr>
                <th scope="col">Column</th>
                <th scope="col">Type</th>
                <th scope="col" className={s.num}>
                  Filled
                </th>
                <th scope="col" className={s.num}>
                  Distinct
                </th>
                <th scope="col">Values in the sample</th>
              </tr>
            </thead>
            <tbody>
              {v.columns.map((c) => (
                <tr key={c.name} data-column={c.name}>
                  <td className={s.strong}>
                    {c.name}
                    {c.withheld && (
                      <span className={l.withheld} title="Its values are never shown to the Assistant (marked personal or financial, or flagged)">
                        <Icon name="lock" size={12} />
                        <span className={l.srOnly}>Values withheld from the Assistant</span>
                      </span>
                    )}
                  </td>
                  <td>
                    <span className={s.typeChip}>{c.type}</span>
                  </td>
                  <td className={s.num}>{c.filledPct === null ? '—' : pctText(c.filledPct)}</td>
                  <td className={s.num}>{figure(c.distinct)}</td>
                  <td>
                    {c.values.length === 0 ? (
                      <span className={s.muted}>{c.type === 'text' && c.distinct !== null ? 'Too many distinct values to list' : '—'}</span>
                    ) : (
                      <span className={l.values}>
                        {c.values.map((x) => (
                          <span key={x} className={l.value} title={x}>
                            {x === '' ? '(empty)' : x}
                          </span>
                        ))}
                        {c.more > 0 && <span className={s.muted}>{`+${formatNumber(c.more)} more`}</span>}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
