// The workbench's results (legacy connWorkbench.ts cwShowResult + Save as
// dataset): the bounded preview in the app's one DataGrid — the rows checked
// here and the dataset saved from them look identical — and the save bar.
//
// "Save as dataset" re-runs WHAT produced the preview (the table, or the
// statement) at the editor's import limit, on the server; the 500 rows on
// screen are never what gets saved.

import { useMemo, useState } from 'react';
import { formatNumber } from '../../../../src/app/format.ts';
import { Button } from '../../ui/Button';
import { DataGrid } from '../../ui/DataGrid/DataGrid';
import { Input } from '../../ui/Field';
import { SkeletonTable } from '../../ui/Skeleton';
import { Select } from '../../ui/Select';
import { EmptyState, ErrorState } from '../../ui/States';
import type { Preview, SaveMode } from './api';
import s from './Workbench.module.css';

export interface Shown {
  preview: Preview;
  /** Exactly one of these is set: what the dataset's origin re-runs. */
  table: string;
  sql: string;
  name: string;
}

export type ResultState =
  | { kind: 'idle' }
  | { kind: 'loading'; what: string }
  | { kind: 'error'; message: string; retry?: () => void }
  | { kind: 'shown'; shown: Shown };

const cell = (v: unknown): string | number | null => (v === null || v === undefined ? null : typeof v === 'number' || typeof v === 'string' ? v : String(v));

/** "Add from connection" asks how (docs/live-data/00-plan.md L2.1): Live only where the connector offers it. */
const MODES = [
  { value: 'extract', label: 'Copy the data' },
  { value: 'live', label: 'Live' },
];

export function Results({ state, saving, live = false, onSave }: {
  state: ResultState;
  saving: boolean;
  /** The connector can answer a Live dataset itself. */
  live?: boolean;
  onSave: (name: string, mode: SaveMode) => void;
}) {
  const shown = state.kind === 'shown' ? state.shown : null;
  const [name, setName] = useState('');
  const [mode, setMode] = useState<SaveMode>('extract');
  const asLive = live && mode === 'live';
  const [nameFor, setNameFor] = useState<Shown | null>(null);
  // A new result seeds the name box; typing in it afterwards is kept.
  if (shown !== nameFor) {
    setNameFor(shown);
    setName(shown?.name ?? '');
  }
  const source = useMemo(() => {
    const rows = shown?.preview.rows ?? [];
    return async (offset: number, limit: number) => ({ rows: rows.slice(offset, offset + limit).map((r) => r.map(cell)), total: rows.length });
  }, [shown]);

  let body;
  if (state.kind === 'loading') body = <SkeletonTable rows={10} cols={5} label={state.what} />;
  else if (state.kind === 'error') body = <ErrorState compact heading={3} title="That could not be read" message={state.message} onRetry={state.retry} />;
  else if (!shown) {
    body = (
      <EmptyState compact heading={3} icon="table" title="No results yet">
        Pick a table on the left, or write a query and Run.
      </EmptyState>
    );
  } else if (shown.preview.columns.length === 0) {
    body = (
      <EmptyState compact heading={3} icon="table" title="Nothing came back">
        The statement ran but returned no columns.
      </EmptyState>
    );
  } else {
    body = (
      <div className={s.grid}>
        <DataGrid columns={shown.preview.columns} source={source} label={`Results of ${shown.name}`} emptyTitle="No rows" emptyBody="The statement returned columns but no rows." />
      </div>
    );
  }

  const p = shown?.preview;
  const warnings = p?.warnings ?? [];
  const note = p && p.columns.length
    ? `${formatNumber(p.rows.length)} of ${formatNumber(p.rowCount)} rows · ${p.columns.length === 1 ? '1 column' : `${formatNumber(p.columns.length)} columns`}${warnings.length ? ` · ${warnings[0]}` : ''}`
    : '';
  return (
    <section className={s.results} aria-label="Results">
      <div className={s.resultsHead}>
        <span className={s.note} title={warnings.join(' ')}>
          {note}
        </span>
        <Input size="sm" className={s.saveName} aria-label="Dataset name" placeholder="Dataset name" value={name} onChange={(e) => setName(e.target.value)} disabled={!shown} />
        {live && (
          <span title={asLive ? 'Keeps the columns only. Charts, KPI tiles and answers ask the warehouse each time, cached for 5 minutes.' : 'Copies the rows into Ordinate; refresh to bring in new ones.'}>
            <Select size="sm" aria-label="How to save" className={s.saveMode} value={mode} options={MODES} disabled={!shown} onValueChange={(v) => setMode(v === 'live' ? 'live' : 'extract')} />
          </span>
        )}
        <Button size="sm" variant="primary" icon={asLive ? 'zap' : 'download'} disabled={!p || p.columns.length === 0} loading={saving} onClick={() => onSave(name.trim(), asLive ? 'live' : 'extract')}>
          {saving ? (asLive ? 'Reading the columns…' : 'Fetching rows…') : asLive ? 'Save as Live dataset' : 'Save as dataset'}
        </Button>
      </div>
      {body}
    </section>
  );
}
