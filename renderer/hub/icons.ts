/* ═══════════════════════════════════════════════════════════════════════
   icons — ONE hand-authored SVG sprite for the whole hub.

   Before this file the hub drew icons two ways and neither was a system:
   74 inline <svg> blocks pasted into index.html with stroke widths spread
   across 1.4–2.2 and sizes across 12–18px, and ~120 Unicode glyphs
   (🗑 ✕ ⋯ ✨ ✎ ★ ▾ ›) set as a control's textContent. A glyph is not an
   icon: it renders in whatever the font decides, ignores stroke weight,
   sits on a text baseline rather than an optical centre, changes shape per
   platform, and is read aloud by a screen reader as its Unicode name. That
   is the single loudest "unfinished" signal in the product.

   The house style is Lucide's: a 24-unit viewBox, 1.5 stroke, round caps
   and joins, currentColor. Icons are authored ONCE as <symbol> bodies in
   ICONS below and icon() stamps a <use> reference, which is why the sprite
   is injected from TypeScript rather than pasted into index.html — the
   geometry has one home and index.html does not grow 400 lines of paths.

   Sizes are 16 by default and 20 in the sidebar. There is no other size: a
   13px icon beside a 15px one is what "a bit rough" actually looks like.
   ═══════════════════════════════════════════════════════════════════════ */

/* The symbol bodies. Keys are the public names; `i-<key>` is the element id.
   Children inherit fill/stroke from the <svg> that <use>s them, so a stroked
   icon carries no paint attributes at all and a FILLED one opts out locally
   with fill="currentColor" stroke="none". */
const ICONS: Record<string, string> = {
  /* ── actions ── */
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  trash:
    '<path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M10 11v6M14 11v6"/>',
  pencil: '<path d="M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
  copy:
    '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>',
  upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12"/>',
  undo: '<path d="M9 14 4 9l5-5M4 9h10.5A5.5 5.5 0 0 1 14.5 20H11"/>',
  redo: '<path d="m15 14 5-5-5-5M20 9H9.5A5.5 5.5 0 0 0 9.5 20H13"/>',
  refresh:
    '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8M21 3v5h-5M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16M8 16H3v5"/>',
  play: '<path d="M7 4.5 19 12 7 19.5Z" fill="currentColor" stroke="none"/>',
  send: '<path d="M22 2 11 13M22 2l-7 20-4-9-9-4Z"/>',
  maximize:
    '<path d="M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3M16 21h3a2 2 0 0 0 2-2v-3"/>',
  link:
    '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
  'external-link':
    '<path d="M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',

  /* ── menus, disclosure, direction ── */
  'more-horizontal':
    '<circle cx="12" cy="12" r="1.3" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1.3" fill="currentColor" stroke="none"/><circle cx="5" cy="12" r="1.3" fill="currentColor" stroke="none"/>',
  'more-vertical':
    '<circle cx="12" cy="12" r="1.3" fill="currentColor" stroke="none"/><circle cx="12" cy="5" r="1.3" fill="currentColor" stroke="none"/><circle cx="12" cy="19" r="1.3" fill="currentColor" stroke="none"/>',
  'chevron-down': '<path d="m6 9 6 6 6-6"/>',
  'chevron-up': '<path d="m18 15-6-6-6 6"/>',
  'chevron-left': '<path d="m15 18-6-6 6-6"/>',
  'chevron-right': '<path d="m9 18 6-6-6-6"/>',
  'chevrons-left': '<path d="m11 17-5-5 5-5M18 17l-5-5 5-5"/>',
  'chevrons-right': '<path d="m13 17 5-5-5-5M6 17l5-5-5-5"/>',
  'arrow-up': '<path d="M12 19V5M5 12l7-7 7 7"/>',
  'arrow-down': '<path d="M12 5v14M19 12l-7 7-7-7"/>',
  'arrow-left': '<path d="M19 12H5M12 19l-7-7 7-7"/>',
  'arrow-right': '<path d="M5 12h14M12 5l7 7-7 7"/>',

  /* ── status ── */
  star: '<path d="m12 2.6 2.9 5.9 6.5.9-4.7 4.6 1.1 6.4-5.8-3-5.8 3 1.1-6.4-4.7-4.6 6.5-.9Z"/>',
  'star-filled':
    '<path d="m12 2.6 2.9 5.9 6.5.9-4.7 4.6 1.1 6.4-5.8-3-5.8 3 1.1-6.4-4.7-4.6 6.5-.9Z" fill="currentColor"/>',
  alert:
    '<path d="m10.3 3.9-8.5 14.1A2 2 0 0 0 3.5 21h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0ZM12 9v4M12 17h.01"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 16v-5M12 8h.01"/>',
  lock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  bell: '<path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0"/>',
  eye: '<path d="M2.1 12a11 11 0 0 1 19.8 0 11 11 0 0 1-19.8 0Z"/><circle cx="12" cy="12" r="3"/>',
  'eye-off':
    '<path d="M10.7 5.1A10.4 10.4 0 0 1 12 5c7 0 10 7 10 7a13.2 13.2 0 0 1-1.7 2.7M6.6 6.6A13.5 13.5 0 0 0 2 12s3 7 10 7a9.7 9.7 0 0 0 5.4-1.6M14.1 14.1a3 3 0 1 1-4.2-4.2M2 2l20 20"/>',

  /* ── the workspace nouns ── */
  home: '<path d="M4 11.5 12 5l8 6.5M6 10v9h12v-9"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20.5 20.5-4.2-4.2"/>',
  settings:
    '<path d="M20 7h-9M14 17H5"/><circle cx="17" cy="17" r="3"/><circle cx="7" cy="7" r="3"/>',
  sliders: '<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/>',
  filter: '<path d="M22 3H2l8 9.5V19l4 2v-8.5Z"/>',
  sparkles:
    '<path d="M12 3.2l1.9 5.1 5.1 1.9-5.1 1.9L12 17.2l-1.9-5.1L5 10.2l5.1-1.9Z" fill="currentColor" stroke="none"/><path d="M18.6 15.4l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7Z" fill="currentColor" stroke="none"/>',
  database:
    '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/>',
  table: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M3 15h18M12 3v18"/>',
  /* a query: the SQL-sourced dataset badge and the Data → Query tab */
  code: '<path d="m16 18 6-6-6-6M8 6l-6 6 6 6"/>',
  grid:
    '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01"/>',
  columns: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M12 3v18"/>',
  'layout-dashboard':
    '<rect x="3" y="3" width="7" height="9" rx="1"/><rect x="14" y="3" width="7" height="5" rx="1"/><rect x="14" y="12" width="7" height="9" rx="1"/><rect x="3" y="16" width="7" height="5" rx="1"/>',
  'chart-bar': '<path d="M3 3v18h18M8 17v-5M13 17V8M18 17v-8"/>',
  'chart-line': '<path d="M3 3v18h18M19 9l-5 5-4-4-3 3"/>',
  'chart-area': '<path d="M3 3v18h18M7 15l4-4 3 3 5-6v7Z"/>',
  'chart-pie': '<path d="M21 12A9 9 0 1 1 12 3v9Z"/><path d="M21 12h-9"/>',
  'trending-up': '<path d="m22 7-8.5 8.5-5-5L2 17"/><path d="M16 7h6v6"/>',
  target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/>',
  map: '<path d="m9 4-6 2.5v13L9 17l6 3 6-2.5v-13L15 7Z"/><path d="M9 4v13M15 7v13"/>',
  layers: '<path d="m12 2 9 5-9 5-9-5Z"/><path d="m3 12 9 5 9-5M3 17l9 5 9-5"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>',
  'file-text':
    '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6M8 13h8M8 17h5"/>',
  clipboard:
    '<rect x="8" y="2" width="8" height="4" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/>',
  camera:
    '<path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3Z"/><circle cx="12" cy="13" r="3.5"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 11h18"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21v-1a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v1"/>',
  plug: '<path d="M9 2v6M15 2v6M6 8h12v3a6 6 0 0 1-12 0ZM12 17v5"/>',
  zap: '<path d="M13 2 4 14h7l-1 8 9-12h-7Z"/>',

  /* ── workspace: history, trash, lineage, projects, first run ── */
  history: '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5M12 7v5l4 2"/>',
  'rotate-ccw': '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/>',
  lineage:
    '<rect x="2.5" y="3" width="7" height="6" rx="1.5"/><rect x="14.5" y="3" width="7" height="6" rx="1.5"/><rect x="14.5" y="15" width="7" height="6" rx="1.5"/><path d="M9.5 6h5M12 6v12h2.5"/>',
  archive: '<rect x="2" y="3" width="20" height="5" rx="1"/><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8M10 12h4"/>',
  package:
    '<path d="m7.5 4.27 9 5.15M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5M12 22V12"/>',
  'circle-check': '<circle cx="12" cy="12" r="9.5"/><path d="m8.5 12 2.5 2.5 4.5-5"/>',
  circle: '<circle cx="12" cy="12" r="9.5"/>',
  function:
    '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 17c2 0 2.8-1 2.8-2.8V10c0-2 1-3.3 3.2-3M9 11.2h5.7"/>',
  gauge: '<path d="m12 14 4-4M3.34 19a10 10 0 1 1 17.32 0"/>',
  /* comments (commentDoors.ts / commentPanel.ts) */
  'message-square': '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2Z"/>',
  'map-pin': '<path d="M20 10c0 5-8 12-8 12s-8-7-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/>',

  /* ── platform: jobs, publish, privacy, automation, backups ── */
  activity: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
  loader: '<path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/>',
  globe: '<circle cx="12" cy="12" r="9.5"/><path d="M2.5 12h19M12 2.5a14.5 14.5 0 0 1 0 19M12 2.5a14.5 14.5 0 0 0 0 19"/>',
  shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10"/>',
  terminal: '<path d="m4 17 6-6-6-6M12 19h8"/>',
  'hard-drive': '<path d="M22 12H2M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11M6 16h.01M10 16h.01"/>',
  cloud: '<path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9"/>',

  /* ── column types (the dataset grid header) ── */
  'type-text': '<path d="M4 6V4h16v2M12 4v16M9 20h6"/>',
  'type-number': '<path d="M4 9h16M4 15h16M10 3 8 21M16 3l-2 18"/>',
  'type-date':
    '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 11h18M8 15h3"/>',
  'type-bool': '<rect x="2" y="7" width="20" height="10" rx="5"/><circle cx="8" cy="12" r="2.6"/>',
};

/* The sprite lives in the document ONCE. `.ic-sprite` is `display:none` in
   hub.css rather than an inline style="" — the hub CSP is `style-src 'self'`
   and drops the attribute, which would leave 65 icons painted down the page. */
let icSpriteEl: SVGSVGElement | null = null;

function icInstallSprite(): void {
  if (icSpriteEl && icSpriteEl.isConnected) return;
  const host = document.body || document.documentElement;
  if (!host) return;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'ic-sprite');
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = Object.keys(ICONS)
    .map((name) => `<symbol id="i-${name}" viewBox="0 0 24 24">${ICONS[name]}</symbol>`)
    .join('');
  host.insertBefore(svg, host.firstChild);
  icSpriteEl = svg;
}

/* Unknown names are the one failure mode worth being loud about: a typo'd
   name renders nothing at all, which looks exactly like "we forgot an icon
   here". Warn once per name and fall back to `info`, so the control is still
   visibly a control. */
const icMissing = new Set<string>();

function icResolve(name: string): string {
  if (ICONS[name]) return name;
  if (!icMissing.has(name)) {
    icMissing.add(name);
    console.warn(`[icons] unknown icon "${name}"`);
  }
  return 'info';
}

/** True if the sprite defines this name — for tests and defensive callers. */
function iconExists(name: string): boolean {
  return Boolean(ICONS[name]);
}

/** The markup for one icon, for call sites assembling a string of HTML. */
function iconHTML(name: string, size = 16): string {
  return (
    `<svg class="ic" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" ` +
    `stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" ` +
    `aria-hidden="true"><use href="#i-${icResolve(name)}"/></svg>`
  );
}

/** One icon as an element. 16px unless asked otherwise; 20 in the sidebar. */
function icon(name: string, size = 16): SVGSVGElement {
  icInstallSprite();
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'ic');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.5');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#i-${icResolve(name)}`);
  svg.appendChild(use);
  return svg;
}

/**
 * An icon + label control body, which is what nearly every call site wants:
 * `iconLabel(btn, 'plus', 'New visual')` replaces `btn.textContent = '+ New
 * visual'`. The label is a <span> so the 8px icon gap is a flex gap rather
 * than a space character inside a text node — a space does not hold its
 * width consistently between the icon and the first letter.
 */
function iconLabel(el: Element, name: string, label: string, size = 16): void {
  el.textContent = '';
  el.appendChild(icon(name, size));
  const span = document.createElement('span');
  span.textContent = label;
  el.appendChild(span);
}

/**
 * An icon-only control: the icon plus the accessible name the glyph used to
 * (badly) carry. Every icon button needs both — `aria-hidden` on the svg
 * means without the label the control announces as "button", unnamed.
 */
function iconOnly(el: Element, name: string, label: string, size = 16): void {
  el.textContent = '';
  el.appendChild(icon(name, size));
  el.setAttribute('aria-label', label);
  if (!el.getAttribute('title')) el.setAttribute('title', label);
}

/** Swap the icon inside an already-built control (a chevron on expand, a
    star on favourite) without rebuilding its label. */
function setIcon(el: Element, name: string, size = 16): void {
  const existing = el.querySelector('svg.ic');
  const next = icon(name, size);
  if (existing) existing.replaceWith(next);
  else el.insertBefore(next, el.firstChild);
}

/* index.html loads this first, so the sprite is in the document before any
   panel renders. The guard covers being loaded from <head> instead. */
if (typeof document !== 'undefined') {
  if (document.body) icInstallSprite();
  else document.addEventListener('DOMContentLoaded', icInstallSprite, { once: true });
}
