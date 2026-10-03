// The composer's left half: the SOURCES (this import, the project's saved
// datasets — click or drag one onto the canvas) and the CANVAS, a horizontal
// chain of tables with a join badge between each pair (legacy composer.ts).
// A chain, never free 2-D placement: the engine is a left-to-right fold.

import { useState, type DragEvent, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { formatNumber } from '../../../../src/app/format.ts';
import { rpc } from '../../api/client';
import { useDatasets, type DatasetColumns } from '../../api/datasets';
import { Button, IconButton } from '../../ui/Button';
import { Dialog, DialogClose } from '../../ui/Dialog';
import { Popover } from '../../ui/Popover';
import { Select } from '../../ui/Select';
import { SkeletonRows } from '../../ui/Skeleton';
import { ErrorState } from '../../ui/States';
import { toast } from '../../ui/Toast';
import { columnsBefore, guessKeys, missingKey, MODES, type ChainTable, type Link, type Mode } from './composerModel';
import type { GridColumn } from '../../ui/DataGrid/DataGrid';
import cs from './Composer.module.css';

const DRAG_TYPE = 'application/x-ordinate-dataset';

/** The venn that marks a join (its fill says which rows survive), the stack that marks an append. */
export function ModeIcon({ mode, size = 18 }: { mode: Mode; size?: number }) {
  if (mode === 'append') {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
        <rect x="4" y="4" width="16" height="6" rx="1" fill="currentColor" stroke="none" />
        <rect x="4" y="14" width="16" height="6" rx="1" />
      </svg>
    );
  }
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
      {mode === 'left' && <circle cx="9.5" cy="12" r="6.5" fill="currentColor" stroke="none" opacity="0.9" />}
      {mode === 'inner' && <path d="M12 6.2a6.5 6.5 0 0 0 0 11.6 6.5 6.5 0 0 0 0-11.6z" fill="currentColor" stroke="none" />}
      <circle cx="9.5" cy="12" r="6.5" />
      <circle cx="14.5" cy="12" r="6.5" />
    </svg>
  );
}

interface Props {
  projectId: string;
  base: ChainTable | null;
  links: Link[];
  previewCols: readonly GridColumn[];
  sheet?: string;
  openJoin: number;
  onOpenJoin: (i: number) => void;
  onBase: (base: ChainTable) => void;
  onLinks: (links: Link[]) => void;
}

function Chip({ t, onRemove }: { t: ChainTable; onRemove?: () => void }) {
  return (
    <div className={cs.chip}>
      <span className={cs.chipName}>{t.label}</span>
      <span className={cs.chipMeta}>{formatNumber(t.rows)} rows</span>
      {t.kind && <span className={cs.chipKind}>{t.kind}</span>}
      {onRemove && <IconButton className={cs.chipX} icon="x" size="sm" label={`Remove ${t.label}`} onClick={onRemove} />}
    </div>
  );
}

function JoinEditor({ link, left, onChange }: { link: Link; left: string[]; onChange: (l: Link) => void }) {
  const keyOpts = (cols: readonly string[]) => [{ value: '', label: '—' }, ...cols.map((c) => ({ value: c, label: c }))];
  const setKey = (side: 'left' | 'right', v: string) => {
    const on = { left: link.on?.left ?? '', right: link.on?.right ?? '', [side]: v };
    onChange({ ...link, on: on.left && on.right ? on : undefined });
  };
  return (
    <>
      <div className={cs.modes} role="radiogroup" aria-label="Join type">
        {MODES.map((m) => (
          <button
            key={m.id}
            type="button"
            role="radio"
            aria-checked={link.mode === m.id}
            title={m.hint}
            className={link.mode === m.id ? `${cs.mode} ${cs.modeOn}` : cs.mode}
            onClick={() => onChange({ ...link, mode: m.id, on: m.id !== 'append' && !link.on ? guessKeys(left, link.table.columns) : link.on })}
          >
            <ModeIcon mode={m.id} size={16} />
            <span>{m.label}</span>
          </button>
        ))}
      </div>
      <p className={cs.popNote}>{MODES.find((m) => m.id === link.mode)?.hint}</p>
      {link.mode !== 'append' && (
        <div className={cs.keys}>
          <Select size="sm" aria-label="Left column" value={link.on?.left ?? ''} options={keyOpts(left)} onValueChange={(v) => setKey('left', v)} />
          <span className={cs.keyEq} aria-hidden="true">
            =
          </span>
          <Select size="sm" aria-label="Right column" value={link.on?.right ?? ''} options={keyOpts(link.table.columns)} onValueChange={(v) => setKey('right', v)} />
        </div>
      )}
      {missingKey(link) && <p className={cs.popWarn}>Choose a column on each side to join on.</p>}
    </>
  );
}

function Group({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className={cs.srcGroup}>
      <h3 className={cs.srcLabel}>{label}</h3>
      <div className={cs.srcList}>{children}</div>
    </div>
  );
}

export function ComposerChain({ projectId, base, links, previewCols, sheet, openJoin, onOpenJoin, onBase, onLinks }: Props) {
  const client = useQueryClient();
  const list = useDatasets(projectId);
  const [removing, setRemoving] = useState(-1);
  const [over, setOver] = useState(false);

  const add = async (id: string, label: string) => {
    let cols: DatasetColumns | null = null;
    try {
      cols = await client.fetchQuery({
        queryKey: ['dataset:columns', projectId, id],
        queryFn: async () => (await rpc('dataset:columns', { projectId, id })) as DatasetColumns | null,
      });
    } catch {
      cols = null;
    }
    if (!cols) {
      toast('That dataset could not be read.', { kind: 'error' });
      return;
    }
    const kind = list.data?.find((d) => d.id === id)?.sourceKind ?? '';
    const table: ChainTable = { label, rows: cols.rowCount, kind, ref: { datasetId: id }, columns: cols.columns.map((c) => c.name) };
    if (!base) return onBase(table);
    const left = columnsBefore(base, [...links, { table, mode: 'inner' }], links.length, previewCols);
    const on = guessKeys(left, table.columns);
    onLinks([...links, { table, mode: 'inner', on }]);
    // A new link with no key yet is the one thing worth opening for you.
    if (!on) onOpenJoin(links.length);
  };

  const drop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    const id = e.dataTransfer.getData(DRAG_TYPE);
    const d = list.data?.find((x) => x.id === id);
    if (d) void add(d.id, d.name);
  };

  const inline = base && 'inline' in base.ref ? base : null;
  const after = removing >= 0 ? links.length - 1 - removing : 0;
  return (
    <>
      <aside className={cs.sources} aria-label="Sources">
        {inline && (
          <Group label="This import">
            <div className={`${cs.src} ${cs.srcUsed}`} aria-disabled="true">
              <span className={cs.srcName}>{inline.label}</span>
              <span className={cs.srcMeta}>
                {formatNumber(inline.rows)} rows on the canvas{sheet ? ` · ${sheet}` : ''}
              </span>
            </div>
          </Group>
        )}
        <Group label="Saved datasets">
          {list.isPending ? (
            <SkeletonRows rows={4} label="Loading datasets" />
          ) : list.isError ? (
            <ErrorState compact heading={3} title="Datasets could not be loaded" message={list.error.message} onRetry={() => void list.refetch()} />
          ) : list.data.length === 0 ? (
            <p className={cs.srcEmpty}>No saved datasets yet.</p>
          ) : (
            list.data.map((d) => (
              <button
                key={d.id}
                type="button"
                className={cs.src}
                draggable
                onDragStart={(e) => e.dataTransfer.setData(DRAG_TYPE, d.id)}
                onClick={() => void add(d.id, d.name)}
              >
                <span className={cs.srcName}>{d.name}</span>
                <span className={cs.srcMeta}>{formatNumber(d.rowCount)} rows</span>
              </button>
            ))
          )}
        </Group>
      </aside>
      <div
        className={over ? `${cs.canvas} ${cs.canvasOver}` : cs.canvas}
        aria-label="Tables being combined"
        role="group"
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes(DRAG_TYPE)) return;
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={drop}
      >
        {!base ? (
          <p className={cs.canvasEmpty}>Pick a table on the left to start — then add more to join or append them.</p>
        ) : (
          <>
            <Chip t={base} />
            {links.map((link, i) => (
              <div key={i} className={cs.linkWrap}>
                <span className={cs.link}>
                  <Popover
                    title={`Join ${link.table.label}`}
                    heading
                    open={openJoin === i}
                    onOpenChange={(o) => onOpenJoin(o ? i : -1)}
                    trigger={
                      <button
                        type="button"
                        className={missingKey(link) ? `${cs.badge} ${cs.badgeWarn}` : cs.badge}
                        aria-label={`${MODES.find((m) => m.id === link.mode)?.label} join with ${link.table.label}${missingKey(link) ? ' — no key chosen' : ''}`}
                      >
                        <ModeIcon mode={link.mode} />
                      </button>
                    }
                  >
                    <JoinEditor
                      link={link}
                      left={columnsBefore(base, links, i, previewCols)}
                      onChange={(l) => onLinks(links.map((x, k) => (k === i ? l : x)))}
                    />
                  </Popover>
                </span>
                <Chip t={link.table} onRemove={() => setRemoving(i)} />
              </div>
            ))}
          </>
        )}
      </div>
      <Dialog
        open={removing >= 0}
        onOpenChange={(o) => !o && setRemoving(-1)}
        title={removing >= 0 ? `Remove “${links[removing]?.table.label}”?` : 'Remove'}
        description={
          after > 0
            ? `The ${after === 1 ? 'table joined after it goes' : `${after} tables joined after it go`} too — each join is computed over the ones before it.`
            : 'Its columns leave the preview.'
        }
        size="sm"
        footer={
          <>
            <DialogClose asChild>
              <Button variant="ghost">Cancel</Button>
            </DialogClose>
            <Button
              variant="danger"
              onClick={() => {
                onLinks(links.slice(0, removing));
                onOpenJoin(-1);
                setRemoving(-1);
              }}
            >
              Remove
            </Button>
          </>
        }
      />
    </>
  );
}
