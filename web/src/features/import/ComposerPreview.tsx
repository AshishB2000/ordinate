// The composer's PREVIEW (legacy composerGrid.ts): the folded chain in the
// DataGrid, paged from the server, and the field mapper on its header — a
// header opens a menu to rename, retype or drop its column. A dropped column
// is never silently gone: it waits in the strip above the grid with a restore.
//
// For a screenshot capture (and only there, on a bare base) the cells are
// editable: they are a model's reading of an image and can simply be wrong.
// An edit lands in the base's own rows and the preview is asked again — the
// server types the corrected value exactly as it would an original one.

import { useEffect, useMemo, useRef, useState } from 'react';
import type { UseQueryResult } from '@tanstack/react-query';
import { Button } from '../../ui/Button';
import { DataGrid, type CellEdit, type GridColumn } from '../../ui/DataGrid/DataGrid';
import { Input } from '../../ui/Field';
import { Popover } from '../../ui/Popover';
import { Select } from '../../ui/Select';
import { SkeletonTable } from '../../ui/Skeleton';
import { EmptyState, ErrorState } from '../../ui/States';
import { Icon } from '../../ui/icons/Icon';
import { composePreview, type ColType, type JoinRef, type PreviewReply } from './api';
import { keptIndexes, mapFor, withCell, type ChainTable, type ColMap } from './composerModel';
import cs from './Composer.module.css';
import s from './Import.module.css';

const TYPES: readonly { value: ColType; label: string }[] = [
  { value: 'text', label: 'Text' },
  { value: 'number', label: 'Number' },
  { value: 'date', label: 'Date' },
];

interface Props {
  projectId: string;
  base: ChainTable | null;
  joins: JoinRef[];
  chainKey: string;
  head: UseQueryResult<Extract<PreviewReply, { ok: true }> | null>;
  map: Record<string, ColMap>;
  onMap: (map: Record<string, ColMap>) => void;
  notes: readonly string[];
  editable: boolean;
  onEditBase: (base: ChainTable) => void;
}

function ColumnMenu({ col, m, onChange, onDrop }: { col: GridColumn; m: ColMap; onChange: (m: ColMap) => void; onDrop: () => void }) {
  const [draft, setDraft] = useState(m.name);
  const commit = () => onChange({ ...m, name: draft.trim() || col.name });
  return (
    <>
      <Input
        label="Name"
        size="sm"
        value={draft}
        maxLength={512}
        autoFocus
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === 'Enter' && commit()}
        hint={m.name !== col.name ? `Renamed from “${col.name}”` : undefined}
      />
      <Select label="Type" size="sm" value={m.type} options={TYPES} onValueChange={(v) => onChange({ ...m, name: draft.trim() || col.name, type: v as ColType })} />
      <Button size="sm" variant="ghost" icon="trash" onClick={onDrop}>
        Drop column
      </Button>
    </>
  );
}

export function ComposerPreview({ projectId, base, joins, chainKey, head, map, onMap, notes, editable, onEditBase }: Props) {
  const raw = useMemo(() => head.data?.columns ?? [], [head.data]);
  // Stable while the SET of kept columns is (a rename keeps the rows the grid has).
  const keptKey = keptIndexes(raw, map).join();
  const kept = useMemo(() => (keptKey ? keptKey.split(',').map(Number) : []), [keptKey]);
  // The header shows the MAPPED name and type; the rows stay the server's.
  const columns = useMemo<GridColumn[]>(
    () => kept.map((i) => ({ name: mapFor(map, raw[i]).name, type: mapFor(map, raw[i]).type })),
    [kept, map, raw],
  );
  const source = useMemo(
    () => async (offset: number, limit: number) => {
      if (!base) return { rows: [], total: 0 };
      const r = await composePreview({ projectId, base: base.ref, joins, offset, limit });
      if (!r.ok) throw new Error(r.error);
      return { rows: r.rows.map((row) => kept.map((i) => row[i] ?? null)), total: r.total };
    },
    [projectId, base, joins, kept],
  );

  const [menu, setMenu] = useState<number | null>(null);
  const anchor = useRef<HTMLElement | null>(null);
  const gridHost = useRef<HTMLDivElement | null>(null);
  useEffect(() => setMenu(null), [chainKey]);
  const menuCol = menu !== null ? raw[kept[menu]] : undefined;
  const setCol = (col: GridColumn, m: ColMap) => onMap({ ...map, [col.name]: m });
  const closeMenu = () => {
    setMenu(null);
    gridHost.current?.querySelector<HTMLElement>('[role="grid"]')?.focus();
  };

  const onEdit = (e: CellEdit) => {
    if (!base) return;
    const ref = withCell(base.ref, e.row, kept[e.column], e.value);
    if (ref) onEditBase({ ...base, ref });
  };

  const dropped = raw.filter((c) => mapFor(map, c).dropped);
  return (
    <div className={cs.preview}>
      {notes.length > 0 && (
        <ul className={cs.warnings} aria-label="Notes on this import">
          {notes.map((w, i) => (
            <li key={i} className={cs.warning}>
              <Icon name="alert" size={12} />
              {w}
            </li>
          ))}
        </ul>
      )}
      {dropped.length > 0 && (
        <div className={cs.dropped} role="group" aria-label="Dropped columns">
          <span className={cs.droppedLabel}>Dropped</span>
          {dropped.map((c) => (
            <Button key={c.name} size="sm" variant="ghost" icon="undo" onClick={() => setCol(c, { ...mapFor(map, c), dropped: false })} title={`Restore ${c.name}`}>
              {c.name}
            </Button>
          ))}
        </div>
      )}
      {editable && <p className={s.hint}>These cells are the model’s reading of the screenshot. Double-click or type over a cell to correct it before you save.</p>}
      <div className={s.gridHost} ref={gridHost}>
        {!base ? (
          <EmptyState icon="table" title="Nothing to preview yet" heading={3}>
            Add a saved dataset from the left — the preview fills in as the chain grows.
          </EmptyState>
        ) : head.isPending ? (
          <SkeletonTable label="Building the preview" />
        ) : head.isError ? (
          <ErrorState title="The preview could not be built" message={head.error.message} onRetry={() => void head.refetch()} heading={3} />
        ) : (
          <DataGrid
            columns={columns}
            source={source}
            label="Preview"
            editable={editable}
            onEdit={onEdit}
            onHeaderActivate={(i, el) => {
              anchor.current = el;
              setMenu(i);
            }}
            emptyTitle={kept.length === 0 ? 'Every column is dropped' : 'No rows'}
            emptyBody={kept.length === 0 ? 'Restore a column above to see the preview.' : 'This combination produced no rows.'}
          />
        )}
      </div>
      {menuCol && (
        <Popover title={`Column ${menuCol.name}`} heading anchorRef={anchor} open onOpenChange={(o) => !o && closeMenu()}>
          <ColumnMenu
            key={menuCol.name}
            col={menuCol}
            m={mapFor(map, menuCol)}
            onChange={(m) => setCol(menuCol, m)}
            onDrop={() => {
              setCol(menuCol, { ...mapFor(map, menuCol), dropped: true });
              closeMenu();
            }}
          />
        </Popover>
      )}
    </div>
  );
}
