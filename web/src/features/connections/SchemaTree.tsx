// The workbench's LEFT pane (legacy connWorkbench.ts tree): schemas → tables →
// columns. A browser, not a query: it shows what `listTables` returned and asks
// `connection:describe` for one table's columns only when that table is
// expanded or selected — never a row. The row figure is the optimiser's
// ESTIMATE, shown with a leading `~` so it never reads as a count.
//
// The caret shows columns (metadata); the row shows the DATA (a sample). Both
// rows and columns drag their quoted name into the editor (native DnD — a
// textarea already inserts dropped text at the drop point).

import { useState, type DragEvent, type KeyboardEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { formatCompact, formatNumber } from '../../../../src/app/format.ts';
import { Input } from '../../ui/Field';
import { Icon } from '../../ui/icons/Icon';
import { SkeletonRows } from '../../ui/Skeleton';
import { ErrorState } from '../../ui/States';
import { qualify, type ColumnDetail, type Table } from './api';
import { quoteIdent, quoteQualified, typeKind } from './sqlLex';
import s from './Workbench.module.css';

export type Describe = (table: string) => Promise<{ columns: ColumnDetail[]; rowEstimate?: number } | null>;

export const describeKey = (projectId: string, connId: string, table: string) => ['connection:describe', projectId, connId, table] as const;

function drag(e: DragEvent, text: string) {
  e.dataTransfer.setData('text/plain', text);
  e.dataTransfer.effectAllowed = 'copy';
}

function TableNode({
  t,
  family,
  selected,
  keyOf,
  describe,
  onSelect,
}: {
  t: Table;
  family: string;
  selected: boolean;
  keyOf: (table: string) => readonly unknown[];
  describe: Describe;
  onSelect: (table: string) => void;
}) {
  const q = qualify(t);
  const [open, setOpen] = useState(false);
  // Shares the page's cache: a describe run for a SELECT shows its estimate here too.
  const d = useQuery({ queryKey: keyOf(q), queryFn: () => describe(q), enabled: open, staleTime: Infinity, retry: false });
  const est = d.data?.rowEstimate;

  function onKey(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onSelect(q);
    } else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      setOpen(e.key === 'ArrowRight');
    }
  }
  return (
    <div className={s.node}>
      <div
        role="treeitem"
        tabIndex={0}
        aria-expanded={open}
        aria-selected={selected}
        className={selected ? `${s.row} ${s.rowOn}` : s.row}
        draggable
        onDragStart={(e) => drag(e, quoteQualified(family, q))}
        onClick={() => onSelect(q)}
        onKeyDown={onKey}
      >
        <button
          type="button"
          tabIndex={-1}
          className={open ? `${s.caret} ${s.caretOpen}` : s.caret}
          aria-label={`${open ? 'Hide' : 'Show'} columns of ${q}`}
          onClick={(e) => {
            e.stopPropagation();
            setOpen(!open);
          }}
        >
          <Icon name="chevron-right" size={12} />
        </button>
        <span className={s.rowName} title={q}>
          {t.name}
        </span>
        {typeof est === 'number' && (
          <span className={s.num} title={`${formatNumber(est)} rows (estimated)`}>
            ~{formatCompact(est)}
          </span>
        )}
      </div>
      {open && (
        <div role="group" className={s.cols}>
          {d.isPending ? (
            <div className={s.loading}>Loading columns…</div>
          ) : d.isError || !d.data ? (
            <div className={s.loading}>Columns unavailable</div>
          ) : (
            d.data.columns.map((c) => {
              const kind = typeKind(c.type);
              return (
                <div key={c.name} className={`${s.row} ${s.colRow}`} draggable onDragStart={(e) => drag(e, quoteIdent(family, c.name))}>
                  <span className={kind === 'number' ? `${s.glyph} ${s.glyphNum}` : s.glyph}>
                    <Icon name={kind === 'number' ? 'type-number' : kind === 'date' ? 'type-date' : 'type-text'} size={12} />
                  </span>
                  <span className={s.rowName}>{c.name}</span>
                  <span className={s.colType} title={c.type}>
                    {c.nullable === false ? `${c.type} not null` : c.type}
                  </span>
                </div>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}

export function SchemaTree({
  tables,
  family,
  selected,
  keyOf,
  describe,
  onSelect,
}: {
  tables: { isPending: boolean; isError: boolean; error: Error | null; data?: Table[]; refetch: () => unknown };
  family: string;
  selected: string;
  keyOf: (table: string) => readonly unknown[];
  describe: Describe;
  onSelect: (table: string) => void;
}) {
  const [search, setSearch] = useState('');
  const q = search.trim().toLowerCase();
  const all = tables.data ?? [];
  const shown = all.filter((t) => !q || qualify(t).toLowerCase().includes(q));
  const groups = new Map<string, Table[]>();
  for (const t of shown) groups.set(t.schema ?? '', [...(groups.get(t.schema ?? '') ?? []), t]);

  return (
    <div className={`${s.pane} ${s.treePane}`}>
      <Input size="sm" icon="search" aria-label="Search tables" placeholder="Search tables…" value={search} onChange={(e) => setSearch(e.target.value)} spellCheck={false} />
      {tables.isPending ? (
        <SkeletonRows rows={8} label="Loading tables" />
      ) : tables.isError ? (
        <ErrorState compact heading={3} title="Could not list tables" message={tables.error?.message ?? ''} onRetry={() => void tables.refetch()} />
      ) : all.length === 0 ? (
        <p className={s.msg}>This source reported no tables.</p>
      ) : shown.length === 0 ? (
        <p className={s.msg}>No tables match that search.</p>
      ) : (
        <div className={s.tree} role="tree" aria-label="Schema">
          {[...groups].map(([schema, list]) => (
            <div key={schema || '·'} role="none">
              {schema && (
                <div className={s.schema} role="none">
                  <span className={s.rowName}>{schema}</span>
                  <span className={s.num}>{formatNumber(list.length)}</span>
                </div>
              )}
              {list.map((t) => (
                <TableNode key={qualify(t)} t={t} family={family} selected={selected === qualify(t)} keyOf={keyOf} describe={describe} onSelect={onSelect} />
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
