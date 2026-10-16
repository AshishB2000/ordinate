// A run of KPI cards on a phone (docs/phone-dashboards): one row swiped
// sideways, two cards to a screen with the next one peeking, snapping card by
// card (CSS scroll-snap — the browser does the gesture). The dots under it
// say how far along the row is and take a tap to go there; they are the only
// script here.

import { useEffect, useRef, useState, type ReactNode } from 'react';
import s from './Phone.module.css';

const smooth = (): ScrollBehavior => (typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth');

/** How many screens wide a row is, and which one shows — from its scroll geometry, never from the cards. */
export function stripPages(scrollWidth: number, clientWidth: number, scrollLeft: number): { pages: number; at: number } {
  if (!(clientWidth > 0) || scrollWidth <= clientWidth + 1) return { pages: 1, at: 0 };
  const pages = Math.ceil((scrollWidth - 1) / clientWidth);
  const max = scrollWidth - clientWidth;
  return { pages, at: Math.min(pages - 1, Math.max(0, Math.round((scrollLeft / max) * (pages - 1)))) };
}

export function KpiStrip({ count, children }: { count: number; children: ReactNode }) {
  const track = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ pages: 1, at: 0 });
  useEffect(() => {
    const el = track.current;
    if (!el) return;
    let raf = 0;
    const measure = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const next = stripPages(el.scrollWidth, el.clientWidth, el.scrollLeft);
        setView((v) => (v.pages === next.pages && v.at === next.at ? v : next));
      });
    };
    measure();
    el.addEventListener('scroll', measure, { passive: true });
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null;
    ro?.observe(el);
    return () => {
      cancelAnimationFrame(raf);
      el.removeEventListener('scroll', measure);
      ro?.disconnect();
    };
  }, [count]);
  const go = (i: number) => {
    const el = track.current;
    if (!el) return;
    const max = el.scrollWidth - el.clientWidth;
    el.scrollTo({ left: view.pages > 1 ? (i / (view.pages - 1)) * max : 0, behavior: smooth() });
  };
  return (
    <div className={s.strip}>
      {/* Focusable, so a keyboard scrolls it with the arrows; named, so a screen reader says what the row is. */}
      <div ref={track} className={s.track} role="region" aria-label={`Key figures, ${count}`} tabIndex={0}>
        {children}
      </div>
      {view.pages > 1 && (
        <div className={s.dots}>
          {Array.from({ length: view.pages }, (_, i) => (
            <button
              key={i}
              type="button"
              className={i === view.at ? `${s.dot} ${s.dotOn}` : s.dot}
              aria-label={`Key figures, page ${i + 1} of ${view.pages}`}
              aria-current={i === view.at ? 'true' : undefined}
              onClick={() => go(i)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
