// One saved visual as a gallery card (vizGallery.makeVisualCard): the whole
// card is ONE button (one Tab stop) — tile, name, "Type · time" — with the
// star and the ⋯ menu as siblings over the tile (nested buttons are invalid).
// The tile's colour is the chart type's, so a grid reads as a palette.

import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { Icon } from '../../ui/icons/Icon';
import { Menu, type MenuEntry } from '../../ui/Menu';
import type { VisualSummary } from './api';
import { accentFor, shortTime, typeLabel } from './model';
import { Thumb } from './Thumb';
import { VizIcon } from './VizIcon';
import s from './Visuals.module.css';

export interface CardActions {
  open(v: VisualSummary): void;
  favorite(v: VisualSummary, next: boolean): void;
  rename(v: VisualSummary): void;
  duplicate(v: VisualSummary): void;
  explain(v: VisualSummary): void;
  history(v: VisualSummary): void;
  remove(v: VisualSummary): void;
}

/** True once the element has come within 160px of the viewport (and stays true). */
function useSeen<T extends Element>(): [(el: T | null) => void, boolean] {
  const [seen, setSeen] = useState(false);
  const io = useRef<IntersectionObserver | null>(null);
  const ref = useCallback((el: T | null) => {
    io.current?.disconnect();
    if (!el) return;
    if (typeof IntersectionObserver === 'undefined') return setSeen(true);
    io.current = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setSeen(true);
          io.current?.disconnect();
        }
      },
      { rootMargin: '160px' },
    );
    io.current.observe(el);
  }, []);
  useEffect(() => () => io.current?.disconnect(), []);
  return [ref, seen];
}

export function VisualCard({ projectId, v, actions }: { projectId: string; v: VisualSummary; actions: CardActions }) {
  const [tileRef, seen] = useSeen<HTMLSpanElement>();
  const [drawn, setDrawn] = useState(false);
  const onDrawn = useCallback(() => setDrawn(true), []); // the parent keys a card by updatedAt, so an edit starts over
  const items: MenuEntry[] = [
    { label: 'Open', icon: 'external-link', onSelect: () => actions.open(v) },
    { label: 'Rename', icon: 'pencil', onSelect: () => actions.rename(v) },
    { label: 'Duplicate', icon: 'copy', onSelect: () => actions.duplicate(v) },
    { label: 'Explain', icon: 'sparkles', onSelect: () => actions.explain(v) },
    { label: 'History', icon: 'history', onSelect: () => actions.history(v) },
    { kind: 'separator' },
    { label: 'Delete', icon: 'trash', danger: true, onSelect: () => actions.remove(v) },
  ];
  const name = v.name || 'Untitled visual';
  return (
    <div className={v.favorite ? `${s.card} ${s.fav}` : s.card} data-visual-id={v.id}>
      <button type="button" className={s.body} onClick={() => actions.open(v)}>
        <span ref={tileRef} className={drawn ? `${s.tile} ${s.drawn}` : s.tile} style={{ '--viz-accent': accentFor(v.chartType) } as CSSProperties}>
          <span className={s.glyph}>
            <VizIcon type={v.chartType} />
          </span>
          <Thumb projectId={projectId} v={v} visible={seen} onDrawn={onDrawn} />
        </span>
        <span className={s.name}>{name}</span>
        <span className={s.meta}>
          {typeLabel(v.chartType)} · {shortTime(v.updatedAt)}
        </span>
      </button>
      <button
        type="button"
        className={`${s.chip} ${s.star}`}
        aria-pressed={v.favorite}
        aria-label={v.favorite ? `Unfavourite ${name}` : `Favourite ${name}`}
        onClick={() => actions.favorite(v, !v.favorite)}
      >
        <Icon name={v.favorite ? 'star-filled' : 'star'} />
      </button>
      <Menu
        align="end"
        label={`${name} actions`}
        items={items}
        trigger={
          <button type="button" className={`${s.chip} ${s.menuBtn}`} aria-label={`More actions for ${name}`}>
            <Icon name="more-horizontal" />
          </button>
        }
      />
    </div>
  );
}
