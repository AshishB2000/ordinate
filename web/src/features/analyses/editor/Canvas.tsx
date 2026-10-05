// The sheet (legacy dashGrid.ts render + authoringSelect.ts direct
// manipulation + gridArrange.ts + layoutSizes/layoutEdit.ts): the 12-column
// grid of cards on desktop, the derived (or edited) tablet / phone layout on a
// small size. Drag a card's head to move it, its right / bottom edge to resize;
// a ghost shows the target cell with snap guides and nothing moves until the
// pointer comes up — ONE undo step per gesture. With a card focused, arrows
// move it and shift+arrows resize it (on a small size: reorder / height).

import { useRef, useState, type CSSProperties } from 'react';
import type { MenuEntry } from '../../../ui/Menu';
import { toast } from '../../../ui/Toast';
import { Icon } from '../../../ui/icons/Icon';
import type { Card, Layout } from '../api';
import { applyLayout, removeCards, type GestureMode } from './arrange';
import { ArrangeBar } from './ArrangeBar';
import { CardView } from './CardView';
import { useEditor } from './context';
import { EmptySheet } from './EmptySheet';
import { FilterBar } from './FilterBar';
import { childrenOf, clampInt, COLS, FRAME_WIDTH, isGroup, materialize, MAX_H, moveItem, resolve, setHeight, setHidden, SIZE_LABEL, snapRect, type Guide } from './geometry';
import { lockedRows, type ImageSpec } from './KindCards';
import { HiddenTray, SizeNote } from './SizeNote';
import s from './Canvas.module.css';
import { useCardRuntime } from '../../dashboards/CardRuntime';
import { SelectionStrip } from '../../dashboards/tileActions';

/** Desktop: move / resize. A small size: drag the head to reorder, the bottom edge to change height (layoutEdit.ts). */
type Mode = GestureMode | 'reorder' | 'height';

interface Gesture {
  id: string;
  mode: Mode;
  x0: number;
  y0: number;
  start: Layout;
  next: Layout;
  colP: number;
  rowP: number;
  moved: boolean;
}

function px(el: HTMLElement, name: string, dflt: number): number {
  const v = parseFloat(getComputedStyle(el).getPropertyValue(name));
  return Number.isFinite(v) ? v : dflt;
}

export function Canvas() {
  const ed = useEditor();
  const gridRef = useRef<HTMLDivElement>(null);
  const gesture = useRef<Gesture | null>(null);
  const [ghost, setGhost] = useState<{ id: string; layout: Layout; guides: Guide[] } | null>(null);
  // Visual cards shown as their figures' table (view state, never saved).
  const [tables, setTables] = useState<ReadonlySet<string>>(() => new Set());
  const toggleTable = (id: string) =>
    setTables((t) => {
      const n = new Set(t);
      if (!n.delete(id)) n.add(id);
      return n;
    });
  // Where a small-size reorder would drop: before or after this card, across (same row) or down.
  const [drop, setDrop] = useState<{ id: string; target: string; after: boolean; across: boolean } | null>(null);
  const runtime = useCardRuntime(ed, gridRef);
  const page = ed.doc.sheets[ed.sheet];
  const cards = page.cards;
  const small = ed.size !== 'desktop';
  const tabOf = (g: string) => ed.groupTab.get(g);

  // What the VIEW hides now: a folded container's cards, an inactive tab's (layoutKinds.ts).
  const viewHidden = new Set<string>();
  for (const g of cards.filter(isGroup)) {
    const folded = g.type === 'container' && !!g.container?.collapsible && ed.folded.has(g.id);
    const tab = g.type === 'tabs' ? (g.tabs?.items.some((t) => t.id === tabOf(g.id)) ? tabOf(g.id) : g.tabs?.items[0]?.id) : undefined;
    for (const c of childrenOf(cards, g.id)) if (folded || (g.type === 'tabs' && c.tabId !== tab)) viewHidden.add(c.id);
  }
  const stored = small ? page.layouts?.[ed.size as 'tablet' | 'phone'] : undefined;
  const placed = resolve(cards, stored, ed.size, viewHidden);
  const cell = new Map(placed.items.map((it) => [it.id, it]));
  // Full-width folds give their rows back on desktop: everything below moves up.
  const folds = small
    ? []
    : cards.filter((g) => g.type === 'container' && g.container?.collapsible && ed.folded.has(g.id) && g.layout.x === 0 && g.layout.w === COLS).map((g) => ({ bottom: g.layout.y + g.layout.h, rows: g.layout.h - 1 }));

  const editSize = (label: string, change: (draft: { items: { id: string; hidden?: true; h?: number }[] }) => boolean) => {
    if (!small) return;
    const size = ed.size as 'tablet' | 'phone';
    ed.edit(`${label} (${SIZE_LABEL[size].toLowerCase()})`, (d) => {
      const sh = d.sheets[ed.sheet];
      const draft = materialize(sh.cards, sh.layouts?.[size]);
      if (change(draft)) sh.layouts = { ...sh.layouts, [size]: draft };
    });
  };
  const step = (id: string, dir: number) => {
    const vis = placed.items.map((i) => i.id);
    const i = vis.indexOf(id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= vis.length) return;
    editSize('Reorder card', (dr) => moveItem(dr, id, vis[j], dir > 0));
  };
  const height = (id: string, dh: number) => {
    const it = cell.get(id);
    if (it) editSize('Change height', (dr) => setHeight(dr, id, it.h + dh));
  };
  const hide = (id: string, on: boolean) => editSize(on ? 'Hide card' : 'Show card', (dr) => setHidden(dr, id, on));

  const commit = (id: string, next: Layout, mode: GestureMode, label: string) =>
    ed.edit(label, (d) => {
      const list = d.sheets[ed.sheet].cards;
      applyLayout(list, id, next, mode, tabOf);
      // An image whose aspect is locked follows its width (layoutKinds.ts imgLockAspect).
      const c = list.find((x) => x.id === id);
      const img = c?.image as ImageSpec | undefined;
      if (c && mode !== 'move' && img?.lockAspect && img.aspect) c.layout.h = lockedRows(c.layout.w, img.aspect, c.layout.h);
    });

  const remove = (card: Card) => {
    ed.edit('Remove card', (d) => {
      const sh = d.sheets[ed.sheet];
      sh.cards = removeCards(sh.cards, [card.id]);
    });
    ed.select(null);
    toast('Card removed', { action: { label: 'Undo', onClick: ed.undo } });
  };

  const nudge = (card: Card, dx: number, dy: number, resize: boolean) => {
    const l = card.layout;
    const next = resize
      ? { ...l, w: clampInt(l.w + dx, 1, COLS - l.x, l.w), h: clampInt(l.h + dy, 1, 100000, l.h) }
      : { ...l, x: clampInt(l.x + dx, 0, COLS - l.w, l.x), y: Math.max(0, l.y + dy) };
    commit(card.id, next, resize ? 'se' : 'move', resize ? 'Resize card' : 'Move card');
  };

  const begin = (e: React.PointerEvent, card: Card, mode: Mode) => {
    if (e.button !== 0 || e.shiftKey || ed.view.presenting) return;
    if ((e.target as HTMLElement).closest('button, a, input, select, textarea, [role="tab"]')) return;
    const grid = gridRef.current;
    if (!grid) return;
    const gap = px(grid, '--dash-gap', 12);
    const row = px(grid, '--dash-row', 48);
    // On a small size the gesture works on the size's own cell, never the desktop layout.
    const at = small ? (cell.get(card.id) as Layout | undefined) : card.layout;
    if (!at) return;
    gesture.current = {
      id: card.id, mode: small ? (mode === 'move' ? 'reorder' : 'height') : mode, x0: e.clientX, y0: e.clientY, start: { ...at }, next: { ...at },
      colP: (grid.getBoundingClientRect().width + gap) / placed.cols, rowP: row + gap, moved: false,
    };
    ed.select(card.id);
    try {
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
    } catch {
      // no active pointer for that id — the handlers below still carry it
    }
    e.preventDefault();
  };
  const move = (e: React.PointerEvent) => {
    const g = gesture.current;
    if (!g) return;
    const dx = Math.round((e.clientX - g.x0) / g.colP);
    const dy = Math.round((e.clientY - g.y0) / g.rowP);
    if (!g.moved && Math.hypot(e.clientX - g.x0, e.clientY - g.y0) < 4) return;
    g.moved = true;
    const l = g.start;
    if (g.mode === 'reorder') return setDrop(dropTarget(g.id, e.clientX, e.clientY));
    if (g.mode === 'height') {
      g.next = { ...l, h: clampInt(l.h + dy, 1, MAX_H, l.h) };
      return setGhost({ id: g.id, layout: g.next, guides: [] });
    }
    let guides: Guide[] = [];
    if (g.mode === 'move') {
      g.next = { x: clampInt(l.x + dx, 0, COLS - l.w, l.x), y: Math.max(0, l.y + dy), w: l.w, h: l.h };
      const skip = new Set([g.id, ...childrenOf(cards, g.id).map((c) => c.id)]);
      const snap = snapRect(g.next, cards.filter((c) => c.type !== 'control' && !skip.has(c.id)).map((c) => c.layout), 1);
      g.next = { ...g.next, x: snap.x, y: snap.y };
      guides = snap.guides;
    } else {
      g.next = {
        x: l.x,
        y: l.y,
        w: g.mode === 's' ? l.w : clampInt(l.w + dx, 1, COLS - l.x, l.w),
        h: g.mode === 'e' ? l.h : Math.max(1, l.h + dy),
      };
    }
    setGhost({ id: g.id, layout: g.next, guides });
  };
  // layoutEdit.ts lyDropTarget: the nearest other card; a card sharing its row splits left / right, else top / bottom.
  const dropTarget = (id: string, x: number, y: number) => {
    let best: { id: string; d: number; r: DOMRect } | null = null;
    for (const el of gridRef.current?.querySelectorAll<HTMLElement>(':scope > [data-card-id]') ?? []) {
      const cid = el.dataset.cardId as string;
      if (cid === id) continue;
      const r = el.getBoundingClientRect();
      const d = Math.hypot(Math.max(r.left - x, 0, x - r.right), Math.max(r.top - y, 0, y - r.bottom));
      if (!best || d < best.d) best = { id: cid, d, r };
    }
    if (!best) return null;
    const across = (cell.get(best.id)?.w ?? placed.cols) < placed.cols;
    const after = across ? x > best.r.left + best.r.width / 2 : y > best.r.top + best.r.height / 2;
    return { id, target: best.id, after, across };
  };

  const end = () => {
    const g = gesture.current;
    gesture.current = null;
    setGhost(null);
    const d = drop;
    setDrop(null);
    if (!g || !g.moved) return;
    if (g.mode === 'reorder') {
      if (d) editSize('Reorder card', (dr) => moveItem(dr, g.id, d.target, d.after));
      return;
    }
    if (g.mode === 'height') {
      if (g.next.h !== g.start.h) editSize('Change height', (dr) => setHeight(dr, g.id, g.next.h));
      return;
    }
    const { start: a, next: b } = g;
    if (a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h) return;
    commit(g.id, b, g.mode, g.mode === 'move' ? 'Move card' : 'Resize card');
  };

  const onKey = (card: Card) => (e: React.KeyboardEvent) => {
    if (e.target !== e.currentTarget) return;
    // Enter selects the focused card (Properties follows); ⇧Enter adds it to the multi-selection — ⇧-click from the keyboard.
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (e.shiftKey && !small) {
        const next = new Set(ed.multi);
        if (!next.size && ed.selected && ed.selected !== card.id) next.add(ed.selected);
        if (!next.delete(card.id)) next.add(card.id);
        ed.setMulti(next);
      } else {
        if (!ed.multi.has(card.id)) ed.setMulti(new Set());
        ed.select(card.id);
      }
      return;
    }
    const d = e.key === 'ArrowLeft' ? [-1, 0] : e.key === 'ArrowRight' ? [1, 0] : e.key === 'ArrowUp' ? [0, -1] : e.key === 'ArrowDown' ? [0, 1] : null;
    if (!d) return;
    e.preventDefault();
    ed.select(card.id);
    if (small) {
      if (e.shiftKey) {
        if (d[1]) height(card.id, d[1]);
      } else step(card.id, d[0] + d[1] < 0 ? -1 : 1);
    } else nudge(card, d[0], d[1], e.shiftKey);
  };

  const menuFor = (card: Card): MenuEntry[] => {
    // The chart's figures as an accessible table, and back (tileActions.ts a11yToggleTable).
    const def = card.type === 'visual' && card.visualId ? ed.visuals.get(card.visualId) : undefined;
    const view: MenuEntry[] =
      def && !def.chartType.startsWith('map_') && def.chartType !== 'table'
        ? [{ label: tables.has(card.id) ? 'View as chart' : 'View as table', icon: tables.has(card.id) ? 'chart-bar' : 'table', onSelect: () => toggleTable(card.id) }]
        : [];
    view.push(...runtime.menu(card, def));
    if (ed.view.presenting) return view;
    if (small) {
      const name = SIZE_LABEL[ed.size].toLowerCase();
      return [
        ...view,
        { label: 'Move earlier', icon: 'arrow-up', onSelect: () => step(card.id, -1) },
        { label: 'Move later', icon: 'arrow-down', onSelect: () => step(card.id, 1) },
        { label: 'Taller', icon: 'plus', onSelect: () => height(card.id, 1) },
        { label: 'Shorter', icon: 'minus', onSelect: () => height(card.id, -1) },
        { label: `Hide on ${name}`, icon: 'eye-off', onSelect: () => hide(card.id, true) },
        { kind: 'separator' },
        { label: 'Remove', icon: 'trash', danger: true, onSelect: () => remove(card) },
      ];
    }
    return [
      { label: 'Properties', icon: 'sliders', onSelect: () => ed.select(card.id) },
      ...view,
      { label: 'Wider', icon: 'arrow-right', onSelect: () => nudge(card, 1, 0, true) },
      { label: 'Narrower', icon: 'arrow-left', onSelect: () => nudge(card, -1, 0, true) },
      { label: 'Taller', icon: 'arrow-down', onSelect: () => nudge(card, 0, 1, true) },
      { label: 'Shorter', icon: 'arrow-up', onSelect: () => nudge(card, 0, -1, true) },
      { kind: 'separator' },
      { label: 'Remove card', icon: 'trash', danger: true, onSelect: () => remove(card) },
    ];
  };

  // A folded container's cards and an inactive tab's are not drawn (small sizes: resolve already left them out).
  // In the SHOWN layout's reading order, so Tab walks the cards as they read (layoutSizes.ts lyPosition).
  const byId = new Map(cards.map((c) => [c.id, c]));
  const tiles = placed.items.map((it) => byId.get(it.id) as Card).filter((c) => c && c.type !== 'control' && !viewHidden.has(c.id));
  const frame = !!ed.pinned && small;
  const gridStyle = { '--cols': String(placed.cols), ...runtime.gridVars(placed.items) } as CSSProperties;

  return (
    <div className={s.canvas} onClick={(e) => e.target === e.currentTarget && ed.select(null)}>
      <FilterBar />
      <SelectionStrip ed={ed} />
      {!ed.view.presenting && (
        <>
          <SizeNote />
          <ArrangeBar />
        </>
      )}
      {tiles.length === 0 && placed.hidden.length === 0 ? (
        <EmptySheet />
      ) : (
        <div className={frame ? s.frame : s.unframed} style={frame ? ({ '--frame-w': `${FRAME_WIDTH[ed.size]}px` } as CSSProperties) : undefined}>
          <div
            ref={gridRef}
            data-sheet-grid=""
            className={s.grid}
            style={gridStyle}
            onPointerMove={move}
            onPointerUp={end}
            onPointerCancel={end}
            onClick={(e) => e.target === e.currentTarget && ed.select(null)}
          >
            {tiles.length === 0 && (
              <p className={s.allHidden}>
                <Icon name="eye-off" size={16} />
                Every card is hidden on {SIZE_LABEL[ed.size].toLowerCase()}. Show one from the list below, or reset this size.
              </p>
            )}
            {tiles.map((card) => {
              const it = cell.get(card.id) as Layout;
              const lift = folds.reduce((n, f) => n + (card.layout.y >= f.bottom ? f.rows : 0), 0);
              const foldedGroup = !small && card.type === 'container' && !!card.container?.collapsible && ed.folded.has(card.id);
              const style: CSSProperties = { gridColumn: `${it.x + 1} / span ${it.w}`, gridRow: `${it.y + 1 - lift} / span ${foldedGroup ? 1 : Math.min(it.h, small ? MAX_H : it.h)}` };
              const cls = [
                s.card,
                isGroup(card) && s.group,
                card.type === 'container' && s[`bg_${card.container?.background ?? 'subtle'}`],
                card.parentId && s.inGroup,
                card.parentId && s[`pad_${byId.get(card.parentId)?.container?.padding ?? 'md'}`],
                drop?.target === card.id && (drop.after ? s.dropAfter : s.dropBefore),
                drop?.target === card.id && drop.across && s.dropX,
                drop?.id === card.id && s.dragging,
                ed.selected === card.id && s.selected,
                ed.multi.has(card.id) && s.multi,
                ghost?.id === card.id && s.dragging,
              ]
                .filter(Boolean)
                .join(' ');
              return (
                <CardView
                  key={card.id}
                  card={card}
                  className={cls}
                  style={style}
                  menu={menuFor(card)}
                  onHide={small ? { label: `Hide on ${SIZE_LABEL[ed.size].toLowerCase()}`, run: () => hide(card.id, true) } : undefined}
                  asTable={tables.has(card.id)}
                  onKeyDown={onKey(card)}
                  onHeadPointerDown={(e) => begin(e, card, 'move')}
                  handles={
                    small ? (
                      <span className={`${s.handle} ${s.h_s}`} aria-hidden="true" onPointerDown={(e) => {
                        e.stopPropagation();
                        begin(e, card, 's');
                      }} />
                    ) : (
                      <>
                        {(['e', 's', 'se'] as const).map((m) => (
                          <span key={m} className={`${s.handle} ${s[`h_${m}`]}`} aria-hidden="true" onPointerDown={(e) => {
                            e.stopPropagation();
                            begin(e, card, m);
                          }} />
                        ))}
                      </>
                    )
                  }
                />
              );
            })}
            {ghost && (
              <>
                <div className={s.ghost} style={{ gridColumn: `${ghost.layout.x + 1} / span ${ghost.layout.w}`, gridRow: `${ghost.layout.y + 1} / span ${ghost.layout.h}` }} aria-hidden="true" />
                {ghost.guides.map((g, i) => (
                  <div
                    key={i}
                    aria-hidden="true"
                    className={g.axis === 'x' ? `${s.guide} ${s.guideX}` : `${s.guide} ${s.guideY}`}
                    style={g.axis === 'x' ? { left: `${(g.at / COLS) * 100}%` } : { top: `calc(${g.at} * (var(--dash-row) + var(--dash-gap)) - var(--dash-gap) / 2)` }}
                  />
                ))}
              </>
            )}
          </div>
        </div>
      )}
      {small && !ed.view.presenting && <HiddenTray hidden={placed.hidden} onShow={(id) => hide(id, false)} />}
      {runtime.overlays}
    </div>
  );
}
