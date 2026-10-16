'use strict';

// The published site's phone pieces (docs/phone-dashboards), DOM half — a
// classic script inlined between publishCore.js and publishClient.js (every
// name prefixed `pp`). The LAYOUT is the stylesheet's (src/publish/siteHtml.ts
// sizeCss, inside its phone media query); this file only builds what CSS
// cannot: a bottom sheet a finger swipes away, the KPI strip's page dots, and
// the "Published …" stamp. Every string goes in through textContent. Nothing
// here computes a figure.

/** The phone breakpoint — sizeCss's phone media query, to the pixel (scripts/test-publishSite.ts checks the two agree). */
const PP_PHONE_MQ = '(max-width: 639px)';

function ppIsPhone(): boolean {
  return typeof matchMedia === 'function' && matchMedia(PP_PHONE_MQ).matches;
}

function ppSmooth(): ScrollBehavior {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
}

function ppEl(tag: string, cls?: string, text?: string): HTMLElement {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

/** "Published Oct 15, 2:02 PM" — when the figures on the page were computed. */
function ppStamp(page: any): string {
  const at = page && page.site && page.site.generatedAt ? new Date(page.site.generatedAt) : null;
  if (!at || isNaN(at.getTime())) return '';
  return 'Published ' + at.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

/**
 * Swipe a sheet down to close it: the grab zone follows the finger; far
 * enough (96px) or fast enough closes, anything less springs back. The sheet
 * moves through the CSSOM — the page's CSP refuses style attributes.
 */
function ppSwipe(grab: HTMLElement, panel: HTMLElement, close: () => void): void {
  let drag: { id: number; y0: number; t0: number; dy: number } | null = null;
  const place = (dy: number, settle: boolean): void => {
    panel.style.transition = settle ? '' : 'none';
    panel.style.transform = dy > 0 ? 'translateY(' + dy + 'px)' : '';
  };
  grab.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest('button, select, a')) return;
    drag = { id: e.pointerId, y0: e.clientY, t0: e.timeStamp, dy: 0 };
    try { grab.setPointerCapture(e.pointerId); } catch (_) { /* the moves still arrive */ }
  });
  grab.addEventListener('pointermove', (e) => {
    if (!drag || drag.id !== e.pointerId) return;
    drag.dy = Math.max(0, e.clientY - drag.y0);
    place(drag.dy, false);
  });
  const up = (e: PointerEvent): void => {
    const d = drag;
    drag = null;
    if (!d || d.id !== e.pointerId) return;
    const speed = d.dy / Math.max(1, e.timeStamp - d.t0);
    if (e.type === 'pointerup' && (d.dy >= 96 || (d.dy > 24 && speed >= 0.6))) { place(0, true); close(); return; }
    place(0, true);
  };
  grab.addEventListener('pointerup', up);
  grab.addEventListener('pointercancel', up);
}

/**
 * A bottom sheet of actions (a tapped chart point's): the scrim, a grab
 * handle, a title and what it is about, one 52px row per action. Esc, the
 * scrim, a swipe or an action closes it; focus goes back where it was.
 */
function ppSheet(title: string, sub: string, items: Array<{ label: string; hint?: string; run: () => void }>): void {
  const back = document.activeElement as HTMLElement | null;
  const scrim = ppEl('div', 'pub-scrim');
  const panel = ppEl('div', 'pub-sheet');
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'true');
  panel.setAttribute('aria-label', title);
  const grab = ppEl('div', 'pub-sheet-grab');
  grab.appendChild(ppEl('span', 'pub-sheet-handle'));
  grab.appendChild(ppEl('p', 'pub-sheet-title', title));
  if (sub) grab.appendChild(ppEl('p', 'pub-sheet-sub', sub));
  panel.appendChild(grab);
  const list = ppEl('div', 'pub-sheet-actions');
  const close = (): void => {
    scrim.remove();
    panel.remove();
    document.removeEventListener('keydown', onKey, true);
    if (back && back.isConnected) back.focus();
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') { e.preventDefault(); close(); }
  };
  for (const it of items) {
    const b = ppEl('button', 'pub-sheet-action') as HTMLButtonElement;
    b.type = 'button';
    b.appendChild(ppEl('span', 'pub-sheet-action-label', it.label));
    if (it.hint) b.appendChild(ppEl('span', 'pub-sheet-action-hint', it.hint));
    b.addEventListener('click', () => { close(); it.run(); });
    list.appendChild(b);
  }
  const cancel = ppEl('button', 'pub-sheet-cancel', 'Cancel') as HTMLButtonElement;
  cancel.type = 'button';
  cancel.addEventListener('click', close);
  list.appendChild(cancel);
  panel.appendChild(list);
  scrim.addEventListener('click', close);
  document.addEventListener('keydown', onKey, true);
  ppSwipe(grab, panel, close);
  document.body.append(scrim, panel);
  (list.querySelector('button') as HTMLElement | null)?.focus();
}

/** How many screens wide a row is and which one shows — from its scroll geometry, never from the cards. */
function ppPages(el: HTMLElement): { pages: number; at: number } {
  const w = el.clientWidth;
  if (!(w > 0) || el.scrollWidth <= w + 1) return { pages: 1, at: 0 };
  const pages = Math.ceil((el.scrollWidth - 1) / w);
  const max = el.scrollWidth - w;
  return { pages, at: Math.min(pages - 1, Math.max(0, Math.round((el.scrollLeft / max) * (pages - 1)))) };
}

/**
 * A run of KPI cards as one swipeable row (shown on a phone only — the
 * stylesheet's call): two cards to a screen and a peek, snapping card by
 * card, with page dots a tap moves along.
 */
function ppStrip(cards: HTMLElement[], order: number): HTMLElement {
  const strip = ppEl('div', 'pub-kpis');
  strip.style.setProperty('--pc-p-ord', String(order));
  const track = ppEl('div', 'pub-kpis-track');
  track.setAttribute('role', 'region');
  track.setAttribute('aria-label', 'Key figures, ' + cards.length);
  track.tabIndex = 0;
  for (const c of cards) track.appendChild(c);
  const dots = ppEl('div', 'pub-kpis-dots');
  strip.append(track, dots);
  let shown = '';
  const paint = (): void => {
    const v = ppPages(track);
    const key = v.pages + ':' + v.at;
    if (key === shown) return;
    shown = key;
    dots.textContent = '';
    if (v.pages < 2) return;
    for (let i = 0; i < v.pages; i++) {
      const d = ppEl('button', i === v.at ? 'pub-dot pub-dot--on' : 'pub-dot') as HTMLButtonElement;
      d.type = 'button';
      d.setAttribute('aria-label', 'Key figures, page ' + (i + 1) + ' of ' + v.pages);
      if (i === v.at) d.setAttribute('aria-current', 'true');
      d.addEventListener('click', () => track.scrollTo({ left: (i / (v.pages - 1)) * (track.scrollWidth - track.clientWidth), behavior: ppSmooth() }));
      dots.appendChild(d);
    }
  };
  let raf = 0;
  const later = (): void => { cancelAnimationFrame(raf); raf = requestAnimationFrame(paint); };
  track.addEventListener('scroll', later, { passive: true });
  if (typeof ResizeObserver === 'function') new ResizeObserver(later).observe(track);
  later();
  return strip;
}
