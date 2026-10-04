// The builder's left pane: the pages in order — include, select, reorder (drag,
// or ↑ ↓ from the keyboard), remove — and "+ Notes" / "+ Tile" (reportBuilder.ts
// rbRenderPageList / rbInitDrag / rbPickTile).

import { useState } from 'react';
import { Button, IconButton } from '../../../ui/Button';
import { Menu } from '../../../ui/Menu';
import type { OpenReport, ReportPage } from '../api';
import { KIND_LABEL, pageSubtitle } from './model';
import s from './Builder.module.css';

export function PageList({
  pages,
  selected,
  sheets,
  onSelect,
  onChange,
  onAdd,
}: {
  pages: ReportPage[];
  selected: number;
  sheets: OpenReport['sheets'];
  onSelect: (i: number) => void;
  onChange: (pages: ReportPage[], select?: number) => void;
  onAdd: (kind: 'notes' | 'tile', cardId?: string) => void;
}) {
  const [drag, setDrag] = useState(-1);
  const move = (from: number, to: number) => {
    if (to < 0 || to >= pages.length) return;
    const out = pages.slice();
    const [m] = out.splice(from, 1);
    out.splice(to, 0, m);
    onChange(out, to);
  };
  const cards = sheets.flatMap((sh) => sh.cards);
  return (
    <aside className={s.pagesPane} aria-label="Pages">
      <div className={s.paneHead}>
        <span className={s.paneTitle}>Pages</span>
        <span className={s.paneCount}>{pages.filter((p) => p.include !== false).length} of {pages.length} included</span>
      </div>
      <ol className={s.pageList}>
        {pages.map((page, i) => {
          const sub = pageSubtitle(page, sheets);
          return (
            <li
              key={page.id}
              className={[s.page, i === selected && s.pageActive, page.include === false && s.pageOff, drag === i && s.pageDrag].filter(Boolean).join(' ')}
              draggable
              onDragStart={(e) => {
                setDrag(i);
                e.dataTransfer.effectAllowed = 'move';
              }}
              onDragEnd={() => setDrag(-1)}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                if (drag >= 0) move(drag, i);
                setDrag(-1);
              }}
            >
              <input
                type="checkbox"
                className={s.pageInc}
                checked={page.include !== false}
                aria-label={`Include ${KIND_LABEL[page.kind]}${sub ? ' ' + sub : ''}`}
                onChange={(e) => onChange(pages.map((p, j) => (j === i ? { ...p, include: e.target.checked } : p)))}
              />
              <button type="button" className={s.pageBtn} onClick={() => onSelect(i)} aria-current={i === selected ? 'true' : undefined}>
                <span className={s.pageNum}>{i + 1}</span>
                <span className={s.pageText}>
                  <span className={s.pageKind}>{KIND_LABEL[page.kind] || page.kind}</span>
                  {sub && <span className={s.pageSub}>{sub}</span>}
                </span>
              </button>
              <span className={s.pageTools}>
                <IconButton icon="arrow-up" size="sm" label="Move page up" disabled={i === 0} onClick={() => move(i, i - 1)} />
                <IconButton icon="arrow-down" size="sm" label="Move page down" disabled={i === pages.length - 1} onClick={() => move(i, i + 1)} />
                {page.kind !== 'cover' && (
                  <IconButton
                    icon="x"
                    size="sm"
                    label="Remove this page"
                    onClick={() => onChange(pages.filter((_, j) => j !== i), Math.min(selected, pages.length - 2))}
                  />
                )}
              </span>
            </li>
          );
        })}
      </ol>
      <div className={s.paneAdd}>
        <Button size="sm" icon="plus" onClick={() => onAdd('notes')}>
          Notes
        </Button>
        <Menu
          label="Add a tile page"
          trigger={
            <Button size="sm" icon="plus" disabled={!cards.length} title={cards.length ? undefined : 'This dashboard has no charts yet'}>
              Tile
            </Button>
          }
          items={cards.map((c, i) => ({ label: c.name || `Chart ${i + 1}`, icon: 'chart-bar' as const, onSelect: () => onAdd('tile', c.id) }))}
        />
      </div>
    </aside>
  );
}
