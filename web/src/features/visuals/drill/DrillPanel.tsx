// The drill-down panel (drill.ts) — "show me the rows behind this number". A
// READ: it writes no filter and touches no visual. The SERVER composes the
// filters behind the figure (or one clicked mark) and pages, searches and sorts
// them in SQL (`visual:rows`); the panel draws what it is given in the DataGrid.
// When the rows cannot be identified exactly the server says why and the panel
// shows that sentence — never an approximate set. "Export these rows (CSV)" is
// the same set as a download, shaped by the project's Share policy.

import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { rpc } from '../../../api/client';
import { startDownload } from '../../../api/files';
import type { Cx } from '../../../charts/types';
import { Button } from '../../../ui/Button';
import { DataGrid, type GridColumn } from '../../../ui/DataGrid/DataGrid';
import { Drawer } from '../../../ui/Dialog';
import { Input } from '../../../ui/Field';
import { Select } from '../../../ui/Select';
import { SkeletonTable } from '../../../ui/Skeleton';
import { ErrorState } from '../../../ui/States';
import { toast } from '../../../ui/Toast';
import type { Encoding, FilterStep } from '../api';
import { OP_LABELS } from '../filters/filterText';
import s from './Drill.module.css';

export interface DrillTarget {
  name: string;
  projectId: string;
  datasetId: string;
  encoding: Encoding;
  /** The SAME filters that produced the figure (plus a facet panel's own steps). */
  filters: FilterStep[];
  /** The clicked mark, or null for the rows behind the whole visual. */
  mark: { category?: string | number; series?: string | number } | null;
}

type Head = { ok: true; available: true; columns: GridColumn[]; filters: FilterStep[]; total: number } | { ok: true; available: false; reason: string } | { ok: false; error: string };

const fmt = new Intl.NumberFormat();

/** A filter step as a chip: `region in (North, South)`. */
function chip(f: FilterStep): string {
  const op = String(f.op);
  if (op === 'period') return `${f.column}: a relative period`;
  if (op === 'is_empty' || op === 'not_empty') return `${f.column} ${OP_LABELS[op]}`;
  if (op === 'in' || op === 'not in') {
    const vals = Array.isArray(f.values) ? f.values.map((v) => (v == null ? '' : String(v))) : [];
    return `${f.column} ${op} (${vals.slice(0, 3).join(', ')}${vals.length > 3 ? ` +${vals.length - 3}` : ''})`;
  }
  return `${f.column} ${op} ${f.value == null ? '' : String(f.value)}`;
}

export function DrillPanel({ target, onClose }: { target: DrillTarget; onClose: () => void }) {
  const [typed, setTyped] = useState('');
  const [search, setSearch] = useState('');
  const [sortColumn, setSortColumn] = useState('');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  const [exporting, setExporting] = useState(false);
  useEffect(() => {
    const t = window.setTimeout(() => setSearch(typed.trim()), 250);
    return () => window.clearTimeout(t);
  }, [typed]);

  const base = { projectId: target.projectId, datasetId: target.datasetId, encoding: target.encoding, filters: target.filters, mark: target.mark };
  const page = { ...(search ? { search } : {}), ...(sortColumn ? { sortColumn, sortDir } : {}) };
  const head = useQuery({
    queryKey: ['visual:rows', base, page, 'head'],
    queryFn: async () => (await rpc('visual:rows', { ...base, page: { ...page, offset: 0, limit: 1 } })) as Head,
    placeholderData: (prev) => prev,
  });
  // A new source is a new query (the grid drops its rows), so it changes only when what is asked does.
  const asked = JSON.stringify({ base, page });
  const source = useMemo(() => {
    const q = JSON.parse(asked) as { base: typeof base; page: typeof page };
    return async (offset: number, limit: number) => {
      const r = (await rpc('visual:rows', { ...q.base, page: { ...q.page, offset, limit } })) as {
        ok: boolean;
        available?: boolean;
        rows?: (string | number | null)[][];
        total?: number;
        error?: string;
        reason?: string;
      };
      if (!r.ok || r.available === false) throw new Error(r.error || r.reason || 'Could not read the underlying rows.');
      return { rows: r.rows ?? [], total: r.total ?? 0 };
    };
  }, [asked]);

  const h = head.data;
  const ready = h && h.ok && h.available ? h : null;
  const reason = h && h.ok && !h.available ? h.reason : h && !h.ok ? h.error : '';

  const exportRows = async () => {
    setExporting(true);
    try {
      const r = (await rpc('visual:rowsDownload', { ...base, page, name: target.name })) as { ok: true; downloadToken: string; rows: number } | { ok: false; error: string };
      if (!r.ok) throw new Error(r.error);
      startDownload(r.downloadToken);
      toast(`Exported ${fmt.format(r.rows)} rows.`, { kind: 'success' });
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not export these rows.', { kind: 'error' });
    } finally {
      setExporting(false);
    }
  };

  return (
    <Drawer
      open
      wide
      onOpenChange={(o) => !o && onClose()}
      title={target.name || 'Underlying rows'}
      description={target.mark ? 'The rows behind the selected mark' : 'The rows behind this visual'}
      footer={
        <Button icon="download" loading={exporting} disabled={!ready || ready.total === 0} onClick={() => void exportRows()}>
          Export these rows (CSV)
        </Button>
      }
    >
      <div className={s.panel}>
        {ready && ready.filters.length > 0 && (
          <div className={s.chips} aria-label="The filters that define these rows">
            {ready.filters.map((f: FilterStep, i: number) => (
              <span key={i} className={s.chip}>
                {chip(f)}
              </span>
            ))}
          </div>
        )}
        {head.isPending ? (
          <SkeletonTable rows={8} cols={5} label="Reading the rows" />
        ) : head.isError ? (
          <ErrorState compact heading={3} title="Could not read the underlying rows" message={head.error.message} onRetry={() => void head.refetch()} />
        ) : !ready ? (
          <p className={s.reason} role="note">
            {reason || 'These rows cannot be identified exactly.'}
          </p>
        ) : (
          <>
            <div className={s.tools}>
              <Input aria-label="Search these rows" icon="search" placeholder="Search these rows…" value={typed} onChange={(e) => setTyped(e.target.value)} />
              <Select
                aria-label="Sort by"
                size="sm"
                value={sortColumn}
                options={[{ value: '', label: 'Data order' }, ...ready.columns.map((c: Cx) => ({ value: String(c.name), label: `Sort by ${c.name}` }))]}
                onValueChange={setSortColumn}
              />
              <Button size="sm" variant="ghost" icon={sortDir === 'asc' ? 'arrow-up' : 'arrow-down'} disabled={!sortColumn} onClick={() => setSortDir(sortDir === 'asc' ? 'desc' : 'asc')}>
                {sortDir === 'asc' ? 'Ascending' : 'Descending'}
              </Button>
              <span className={s.count} aria-live="polite">
                {ready.total === 1 ? '1 row' : `${fmt.format(ready.total)} rows`}
              </span>
            </div>
            <div className={s.grid}>
              <DataGrid
                key={JSON.stringify(page)}
                columns={ready.columns}
                source={source}
                label="Underlying rows"
                emptyTitle={search ? 'No rows match that search' : 'No rows'}
                emptyBody={search ? 'Try a shorter search.' : 'Nothing in the data is behind this figure.'}
              />
            </div>
          </>
        )}
      </div>
    </Drawer>
  );
}
