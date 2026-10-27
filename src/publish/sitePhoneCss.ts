// A published dashboard on a phone (docs/phone-dashboards) — the stylesheet
// half; ./site/publishPhone.ts builds what CSS cannot. Every rule that shows
// or moves anything is inside the phone media query (wider, the new elements
// are only ever `display: none` — siteHtml.sizeCss): the desktop and tablet
// pages are exactly what they were.
//
//   the title row      a sticky bar: the name, "Published …", Filters + badge
//   the tiles          one column in the phone layout's order (--pc-p-ord),
//                      charts at their phone rows of 40px (--pc-p-h), prose at
//                      its own height, KPI runs as swipeable strips
//   tables             scroll sideways, first column and header pinned
//   the filter bar     a bottom sheet: scrim, handle, Reset / Done, safe area
//   a tapped point     ppSheet's bottom sheet of what to do with it
//
// Every target is at least 44px; colours are the page's style tokens, so both
// a light and a dark dashboard style follow.

/** The phone rules, wrapped in the phone media query (`max` = the widest phone window, in px). */
export function phoneCss(max: number): string {
  const sheet = 'position: fixed; left: 0; right: 0; bottom: 0; z-index: 10; margin: 0 auto; width: 100%; max-height: 88vh; max-height: 88dvh;'
    + ' padding: 0 16px max(16px, env(safe-area-inset-bottom)); border: 0; border-radius: 18px 18px 0 0; background: var(--surface); color: var(--text);'
    + ' box-shadow: 0 -16px 48px -16px rgba(0,0,0,.35); animation: pub-rise .22s cubic-bezier(.2,0,0,1); transition: transform .22s cubic-bezier(.2,0,0,1);';
  return `
  @media (max-width: ${max}px) {
    .pub-head { position: static; padding: 10px 16px; gap: 8px; }
    .pub-nav { flex-wrap: nowrap; overflow-x: auto; scrollbar-width: none; width: calc(100% + 32px); margin: 0 -16px; padding: 0 16px; }
    .pub-nav-link { flex: 0 0 auto; display: inline-flex; align-items: center; min-height: 44px; }
    .pub-root { padding: 0 16px max(48px, env(safe-area-inset-bottom)); }
    .pub-dashhead { display: flex; align-items: center; gap: 8px; position: sticky; top: 0; z-index: 4; min-height: 56px;
      margin: 0 -16px; padding: max(6px, env(safe-area-inset-top)) 16px 6px; background: var(--surface); border-bottom: 1px solid var(--border); }
    .pub-dashhead-ident { display: flex; flex-direction: column; gap: 1px; flex: 1 1 auto; min-width: 0; }
    .pub-dashhead .pub-title { margin: 0; font-size: 15px; line-height: 1.3; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .pub-dashhead-stamp { display: block; margin: 0; font-size: 12px; line-height: 1.3; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .pub-filters-open { position: relative; display: inline-flex; align-items: center; gap: 6px; flex: 0 0 auto; height: 36px; margin: 4px 0; padding: 0 12px;
      border: 1px solid var(--border-2); border-radius: 999px; background: var(--surface); color: var(--text-strong); font: inherit; font-size: 13px; font-weight: 600; cursor: pointer; }
    .pub-filters-open::after { content: ''; position: absolute; inset: -4px 0; }
    .pub-icon { fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
    .pub-filters-open:has(.pub-filters-badge:not([hidden])) { border-color: var(--accent-line); background: var(--accent-soft); color: var(--accent); }
    .pub-filters-badge { display: inline-flex; align-items: center; justify-content: center; min-width: 18px; height: 18px; padding: 0 5px;
      border-radius: 999px; background: var(--accent); color: #fff; font-size: 11px; font-weight: 700; font-variant-numeric: tabular-nums; }
    .pub-filters-badge[hidden] { display: none; }
    .pub-filters { display: none; }
    .pub-takeaway { margin: 12px 0 0; font-size: 14px; }
    .pub-hint { margin: 10px 0 0; }
    .pub-tabs { flex-wrap: nowrap; overflow-x: auto; scrollbar-width: none; margin: 4px -16px 0; padding: 0 16px; }
    .pub-tab { flex: 0 0 auto; min-height: 44px; white-space: nowrap; }

    .pub-grid { display: flex; flex-direction: column; margin-top: 12px; }
    .pub-grid > .pub-card { flex: 0 0 auto; order: var(--pc-p-ord, 0); height: calc(var(--pc-p-h, 6) * 40px + (var(--pc-p-h, 6) - 1) * var(--gap)); }
    .pub-grid > .pub-card--metric { height: auto; min-height: 112px; }
    .pub-grid > .pub-card--text, .pub-grid > .pub-card--summary, .pub-grid > .pub-card--broken { height: auto; min-height: 40px; }
    .pub-grid > .pub-in-strip { display: none; }
    .pub-text-h, .pub-text-p { max-width: 68ch; }
    .pub-text-p { font-size: 15px; line-height: 1.55; }

    .pub-kpis { display: flex; flex-direction: column; gap: 4px; order: var(--pc-p-ord, 0); margin: 0 -16px; }
    .pub-kpis-track { display: flex; gap: var(--gap); overflow-x: auto; overscroll-behavior-x: contain; padding: 2px 16px;
      scroll-padding: 0 16px; scroll-snap-type: x mandatory; scrollbar-width: none; }
    .pub-kpis-track::-webkit-scrollbar, .pub-nav::-webkit-scrollbar, .pub-tabs::-webkit-scrollbar { display: none; }
    .pub-kpis-track > .pub-card { flex: 0 0 calc((100% - 32px - var(--gap)) / 2.2); min-height: 112px; padding: 12px 14px; scroll-snap-align: start; }
    .pub-kpis-track .pub-kpi-value { font-size: min(var(--kpi-size), 26px); }
    .pub-kpis-dots { display: flex; justify-content: center; min-height: 22px; }
    .pub-dot { position: relative; width: 22px; height: 22px; padding: 0; border: 0; background: none; cursor: pointer; }
    .pub-dot::before { content: ''; position: absolute; inset: -11px 0; }
    .pub-dot::after { content: ''; position: absolute; top: 8px; left: 8px; width: 6px; height: 6px; border-radius: 50%; background: var(--border-2); }
    .pub-dot--on::after { background: var(--accent); transform: scale(1.35); }

    .pub-table { font-size: 13px; border-collapse: separate; border-spacing: 0; }
    .pub-table th, .pub-table td { padding: 8px 12px; }
    .pub-table tr > :first-child { position: sticky; left: 0; z-index: 1; max-width: 45vw; overflow: hidden; text-overflow: ellipsis;
      background: var(--surface); box-shadow: inset -1px 0 0 var(--border); }
    .pub-table thead tr > :first-child { z-index: 2; }

    .pub-scrim:not(.pub-filters-scrim), .pub-filters-scrim.is-open { display: block; position: fixed; inset: 0; z-index: 9;
      background: rgba(0,0,0,.45); animation: pub-fade .22s ease-out; }
    .pub-filters.is-open { display: flex; flex-direction: column; align-items: stretch; gap: 12px; overflow-y: auto; ${sheet} }
    .pub-filters.is-open .pub-filter { min-width: 0; }
    .pub-filters.is-open .pub-filter-select { height: 44px; font-size: 16px; }
    .pub-filters.is-open .pub-filters-grab { display: block; position: sticky; top: 0; z-index: 1; padding: 8px 0 4px; background: var(--surface); touch-action: none; cursor: grab; }
    .pub-filters.is-open .pub-filters-foot { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; position: sticky; bottom: 0; padding-top: 8px; background: var(--surface); }
    .pub-filters-reset, .pub-filters.is-open .pub-filters-done, .pub-sheet-cancel { display: inline-flex; align-items: center; justify-content: center; min-height: 44px;
      border-radius: 10px; font: inherit; font-size: 15px; font-weight: 600; cursor: pointer; }
    .pub-filters-reset, .pub-sheet-cancel { border: 1px solid var(--border-2); background: var(--surface); color: var(--text-strong); }
    .pub-filters.is-open .pub-filters-done { border: 0; background: var(--accent); color: #fff; }
    .pub-sheet-handle { display: block; width: 36px; height: 5px; margin: 0 auto 8px; border-radius: 999px; background: var(--border-2); }
    .pub-sheet-title { margin: 0; font-size: 15px; font-weight: 600; line-height: 1.3; color: var(--text-strong); overflow-wrap: anywhere; }
    .pub-sheet-sub { margin: 2px 0 0; font-size: 13px; color: var(--muted); }
    .pub-sheet { display: flex; flex-direction: column; ${sheet} }
    .pub-sheet-grab { padding: 8px 0 12px; touch-action: none; cursor: grab; }
    .pub-sheet-actions { display: flex; flex-direction: column; gap: 8px; overflow-y: auto; }
    .pub-sheet-action { display: flex; flex-direction: column; justify-content: center; align-items: flex-start; gap: 2px; min-height: 56px; padding: 10px 14px;
      border: 1px solid var(--accent-line); border-radius: 12px; background: var(--accent-soft); color: var(--text-strong); font: inherit; text-align: left; cursor: pointer; }
    .pub-sheet-action-label { font-size: 15px; font-weight: 600; }
    .pub-sheet-action-hint { font-size: 12px; color: var(--muted); }
    @keyframes pub-rise { from { transform: translateY(100%); } }
    @keyframes pub-fade { from { opacity: 0; } }
  }
  @media (max-width: ${max}px) and (prefers-reduced-motion: reduce) {
    .pub-scrim, .pub-filters.is-open, .pub-sheet { animation: none; transition: none; }
    .pub-dot::after { transition: none; }
  }
`;
}
