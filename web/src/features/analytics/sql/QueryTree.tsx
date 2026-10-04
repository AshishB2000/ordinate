// The Query tab's dataset tree (queryTab.ts qtRenderTree): the project's
// datasets, each expandable to its DECLARED columns with their type glyphs, a
// search over names and columns, and click / Enter / drag to insert a name
// into the editor. Row counts are the server's.

import { useState, type DragEvent } from 'react';
import { formatNumber } from '../../../../../src/app/format.ts';
import { Input } from '../../../ui/Field';
import { Icon } from '../../../ui/icons/Icon';
import { ident, type SchemaColumn, type SchemaDataset } from './sqlText';
import w from '../../connections/Workbench.module.css';
import s from './Sql.module.css';

const GLYPH: Record<string, 'type-number' | 'type-date' | 'type-text'> = { number: 'type-number', date: 'type-date' };

function drag(text: string) {
  return {
    draggable: true,
    onDragStart: (e: DragEvent) => {
      e.dataTransfer.setData('text/plain', text);
      e.dataTransfer.effectAllowed = 'copy';
    },
  };
}

function ColumnRow({ c, onInsert }: { c: SchemaColumn; onInsert: (t: string) => void }) {
  const id = ident(c.name);
  return (
    <div
      className={`${w.row} ${w.colRow}`}
      role="treeitem"
      tabIndex={0}
      title={`Insert ${id}`}
      onClick={() => onInsert(id)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onInsert(id);
        }
      }}
      {...drag(id)}
    >
      <span className={c.type === 'number' ? `${w.glyph} ${w.glyphNum}` : w.glyph} aria-hidden="true">
        <Icon name={GLYPH[c.type] ?? 'type-text'} size={16} />
      </span>
      <span className={w.rowName}>{c.name}</span>
      <span className={w.colType}>{c.type}</span>
    </div>
  );
}

export function QueryTree({ schema, onInsert }: { schema: readonly SchemaDataset[]; onInsert: (text: string) => void }) {
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const [q, setQ] = useState('');
  const needle = q.trim().toLowerCase();
  const toggle = (id: string) => setOpen((cur) => {
    const next = new Set(cur);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });
  const shown = schema
    .map((d) => {
      const hitName = !needle || d.name.toLowerCase().includes(needle) || d.slug.includes(needle);
      const cols = hitName ? d.columns : d.columns.filter((c) => c.name.toLowerCase().includes(needle));
      return { d, cols, force: !!needle && !hitName, show: hitName || cols.length > 0 };
    })
    .filter((x) => x.show);
  return (
    <div className={`${w.pane} ${w.treePane}`}>
      <div className={w.schema}>
        <span>Datasets</span>
        <span className={w.num}>{schema.length}</span>
      </div>
      <Input size="sm" icon="search" aria-label="Search datasets and columns" placeholder="Search" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className={w.tree} role="tree" aria-label="Datasets and columns">
        {shown.map(({ d, cols, force }) => {
          const isOpen = force || open.has(d.id);
          const title = d.queryable
            ? `Insert ${d.slug}${d.alias && d.alias.toLowerCase() !== d.slug ? ` — or query it as ${ident(d.alias)}` : ''}`
            : 'Saved before datasets were stored as Parquet — import it again to query it.';
          return (
            <div key={d.id}>
              <div
                className={d.queryable ? `${w.row} ${s.dsRow}` : `${w.row} ${s.dsRow} ${s.off}`}
                role="treeitem"
                aria-expanded={isOpen}
                tabIndex={0}
                title={title}
                onClick={() => d.queryable && onInsert(d.slug)}
                onKeyDown={(e) => {
                  if ((e.key === 'Enter' || e.key === ' ') && d.queryable) {
                    e.preventDefault();
                    onInsert(d.slug);
                  } else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
                    e.preventDefault();
                    toggle(d.id);
                  }
                }}
                {...(d.queryable ? drag(d.slug) : {})}
              >
                <button
                  type="button"
                  className={isOpen ? `${w.caret} ${w.caretOpen}` : w.caret}
                  aria-label={`${isOpen ? 'Hide' : 'Show'} columns of ${d.name}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    toggle(d.id);
                  }}
                >
                  <Icon name="chevron-right" size={16} />
                </button>
                <span className={s.dsText}>
                  <span className={w.rowName}>{d.name}</span>
                  <span className={s.slug}>{d.queryable ? d.slug : 'not queryable — re-import'}</span>
                </span>
                <span className={w.num} title={`${formatNumber(d.rowCount)} rows`}>
                  {formatNumber(d.rowCount)}
                </span>
              </div>
              {isOpen && (
                <div className={w.cols} role="group">
                  {cols.map((c) => (
                    <ColumnRow key={c.name} c={c} onInsert={onInsert} />
                  ))}
                </div>
              )}
            </div>
          );
        })}
        {shown.length === 0 && <p className={w.loading}>No dataset or column matches that search.</p>}
      </div>
    </div>
  );
}
