'use strict';

// The Data page's EVENTS tab — the project's launches, campaigns, incidents and
// holidays, each a date or a date range. Every chart with a date axis marks
// them (chartEvents.ts); Insights and Key drivers name the one a change landed
// in. Classic global-scope renderer <script>: no import/export.
//
// Structure is borrowed, not invented: the table is `.ws-table` / `.ws-row`
// (the metrics tab's), the kind filter is the catalog's `.home-pill` row, the
// empty state is `.ws-empty`, the editor is a `.ws-modal` with the metric
// editor's `.me-field`s, the calendar toggles are the Format panel's
// `.cm-switch`. events.css holds this table's grid and the side cards.
//
// Nothing here matches a date: main (src/analysis/events.ts) does, and sends
// each event's "when" text with the list.

const EV_KINDS: Array<[string, string]> = [
  ['launch', t('common.launch')], ['campaign', t('common.campaign')], ['incident', t('common.incident')], ['holiday', t('common.holiday')], ['other', t('common.other')],
];
const EV_SVG = 'http://www.w3.org/2000/svg';

let evState: { events: any[]; calendars: string[]; available: any[]; datasets: any[] } = { events: [], calendars: [], available: [], datasets: [] };
let evKind = '';

function evEl(id: string): HTMLElement | null {
  return document.getElementById(id);
}

function evMk<T extends HTMLElement = HTMLElement>(tag: string, cls: string, text?: string): T {
  const el = document.createElement(tag) as T;
  if (cls) el.className = cls;
  if (text !== undefined) el.textContent = text;
  return el;
}

function evKindName(kind: string): string {
  const k = EV_KINDS.find((x) => x[0] === kind);
  return k ? k[1] : t('common.other');
}

/** The kind's mark — the SAME glyph a chart draws (chartEvents.evIcon), as SVG. */
function evKindMark(kind: string): SVGSVGElement {
  const svg = document.createElementNS(EV_SVG, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('width', '16');
  svg.setAttribute('height', '16');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', 'ev-mark ev-k-' + kind);
  const disc = document.createElementNS(EV_SVG, 'circle');
  disc.setAttribute('cx', '8'); disc.setAttribute('cy', '8'); disc.setAttribute('r', '8'); disc.setAttribute('fill', 'currentColor');
  svg.appendChild(disc);
  const glyph = document.createElementNS(EV_SVG, 'path');
  const d: Record<string, string> = {
    launch: 'M8 4 11.5 11h-7Z', campaign: 'M8 4 12 8 8 12 4 8Z',
    incident: 'M7.1 4h1.8l-.3 5.4H7.4ZM8 10.4a1 1 0 1 1 0 2 1 1 0 0 1 0-2Z',
    holiday: 'M8 3.6 9.1 6.6 12.2 6.6 9.7 8.5 10.6 11.6 8 9.8 5.4 11.6 6.3 8.5 3.8 6.6 6.9 6.6Z',
    other: 'M8 5.8a2.2 2.2 0 1 1 0 4.4 2.2 2.2 0 0 1 0-4.4Z',
  };
  glyph.setAttribute('d', d[kind] || d.other);
  glyph.setAttribute('fill', '#fff');
  svg.appendChild(glyph);
  return svg;
}

function evDatasetName(id: string): string {
  const d = evState.datasets.find((x) => x && x.id === id);
  return d ? String(d.name) : t('eventsPage.a_deleted_dataset');
}

/** "All charts" · "Orders" · "Orders · Region = West". */
function evScopeText(e: any): string {
  const s = e.scope || {};
  const parts: string[] = [];
  if (Array.isArray(s.datasetIds) && s.datasetIds.length) parts.push(s.datasetIds.map(evDatasetName).join(', '));
  for (const f of Array.isArray(s.filters) ? s.filters : []) parts.push(`${f.column} = ${(f.values || []).join(' or ')}`);
  return parts.length ? parts.join(' · ') : t('eventsPage.all_charts');
}

/** Inclusive day count of an event, for the When column's second line. */
function evDays(e: any): number {
  if (!e.end) return 1;
  return Math.round((Date.parse(e.end + 'T00:00:00Z') - Date.parse(e.date + 'T00:00:00Z')) / 86400000) + 1;
}

/** "Nov 28, 2024" in UTC — a stored ISO date, never shifted by the local zone. */
function evDateText(iso: string): string {
  const t = Date.parse(iso + 'T00:00:00Z');
  return Number.isFinite(t) ? new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : iso;
}

function evFlash(text: string, bad = false): void {
  const msg = evEl('ev-msg');
  if (!msg) return;
  msg.textContent = text;
  msg.classList.toggle('ev-msg--bad', bad);
}

async function evRefresh(): Promise<void> {
  if (!currentProjectId || !window.hubEvents) return;
  let res: any = null;
  let sets: any[] = [];
  try { res = await window.hubEvents.list(currentProjectId); } catch (_) { res = null; }
  try { sets = await window.hub.listDatasets(currentProjectId); } catch (_) { sets = []; }
  if (res && res.ok) evState = { events: res.events || [], calendars: res.calendars || [], available: res.available || [], datasets: Array.isArray(sets) ? sets : [] };
  evPaint();
}

function evPaint(): void {
  const list = evEl('ev-list');
  const empty = evEl('ev-empty');
  const head = evEl('ev-cols');
  const pills = evEl('ev-kinds');
  const count = evEl('ev-count');
  if (!list || !empty || !head || !pills) return;
  const all = evState.events;
  if (count) count.textContent = all.length ? `${all.length} event${all.length === 1 ? '' : 's'}` : '';

  pills.textContent = '';
  const counts = new Map<string, number>();
  all.forEach((e) => counts.set(e.kind, (counts.get(e.kind) || 0) + 1));
  if (evKind && !counts.get(evKind)) evKind = '';
  const opts: Array<[string, string, number]> = [['', t('common.all'), all.length]];
  EV_KINDS.forEach(([k, label]) => { if (counts.get(k)) opts.push([k, label, counts.get(k) || 0]); });
  if (all.length) {
    opts.forEach(([k, label, n]) => {
      const b = evMk<HTMLButtonElement>('button', 'home-pill ev-pill' + (k === evKind ? ' is-active' : ''), label);
      b.type = 'button';
      b.setAttribute('aria-pressed', String(k === evKind));
      b.appendChild(evMk('span', 'ct-kind-n', String(n)));
      b.addEventListener('click', () => { evKind = k; evPaint(); });
      pills.appendChild(b);
    });
  }

  list.textContent = '';
  const shown = all.filter((e) => !evKind || e.kind === evKind)
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : String(a.title).localeCompare(String(b.title))));
  shown.forEach((e) => list.appendChild(evRow(e)));
  head.hidden = all.length === 0;
  pills.hidden = all.length === 0;
  empty.hidden = all.length > 0;
  evPaintCalendars();
}

function evRow(e: any): HTMLElement {
  const row = evMk('div', 'ws-row ev-row');
  row.dataset.eventId = String(e.id);

  const name = evMk('div', 'ev-name');
  name.appendChild(evKindMark(e.kind));
  const btn = evMk<HTMLButtonElement>('button', 'mp-name ev-title', String(e.title));
  btn.type = 'button';
  btn.title = t('eventsPage.edit_this_event');
  btn.addEventListener('click', () => { void evEdit(e); });
  name.appendChild(btn);

  const kind = evMk('span', 'ev-chip ev-k-' + e.kind, evKindName(e.kind));

  const when = evMk('div', 'ev-when');
  when.appendChild(evMk('span', 'ev-when-main', e.end ? `${evDateText(e.date)} – ${evDateText(e.end)}` : evDateText(e.date)));
  when.appendChild(evMk('span', 'ev-when-sub', e.end ? t('eventsPage.days_drawn_as_a_band', { e: evDays(e) }) : t('eventsPage.one_day_drawn_as_a_marker')));

  const scope = evMk('span', 'ws-cell ev-scope', evScopeText(e));
  scope.title = scope.textContent || '';

  const actions = evMk('div', 'mp-actions');
  const edit = evMk<HTMLButtonElement>('button', 'btn btn-sm btn-ghost mp-more');
  edit.type = 'button';
  iconOnly(edit, 'pencil', t('eventsPage.edit', { title: e.title }));
  edit.addEventListener('click', () => { void evEdit(e); });
  const del = evMk<HTMLButtonElement>('button', 'btn btn-sm btn-ghost mp-more');
  del.type = 'button';
  iconOnly(del, 'trash', t('eventsPage.delete', { title: e.title }));
  del.addEventListener('click', () => { void evDelete(e); });
  actions.append(edit, del);

  row.append(name, kind, when, scope, actions);
  return row;
}

async function evDelete(e: any): Promise<void> {
  if (!currentProjectId) return;
  if (!window.confirm(t('eventsPage.delete_charts_stop_marking_it_and', { title: e.title }))) return;
  try { await window.hubEvents.remove(currentProjectId, e.id); } catch (_) { /* the reload reports it */ }
  evFlash(t('eventsPage.deleted', { title: e.title }));
  await evRefresh();
}

// ── holiday calendars ────────────────────────────────────────────────────────

function evPaintCalendars(): void {
  const host = evEl('ev-cals');
  if (!host) return;
  host.textContent = '';
  const on = new Set(evState.calendars);
  for (const c of evState.available) {
    const row = evMk('div', 'cm-toggle-row ev-cal');
    const text = evMk('div', 'ev-cal-text');
    text.appendChild(evMk('span', 'ev-cal-name', `${c.name}`));
    text.appendChild(evMk('span', 'ev-cal-sub', t('eventsPage.about_a_year', { code: c.code, p1: c.perYear || 0 })));
    if (c.note) text.title = c.note;
    const sw = evMk<HTMLButtonElement>('button', 'cm-switch' + (on.has(c.code) ? ' cm-switch-on' : ''));
    sw.type = 'button';
    sw.dataset.cal = c.code;
    sw.setAttribute('role', 'switch');
    sw.setAttribute('aria-checked', String(on.has(c.code)));
    sw.setAttribute('aria-label', `${c.name} holidays`);
    sw.appendChild(evMk('span', 'cm-switch-thumb'));
    sw.addEventListener('click', () => { void evToggleCalendar(c.code, !on.has(c.code)); });
    row.append(text, sw);
    host.appendChild(row);
  }
}

async function evToggleCalendar(code: string, on: boolean): Promise<void> {
  if (!currentProjectId) return;
  const next = evState.calendars.filter((c) => c !== code).concat(on ? [code] : []);
  let res: any = null;
  try { res = await window.hubEvents.setCalendars(currentProjectId, next); } catch (_) { res = null; }
  if (res && res.ok) {
    evState.calendars = res.calendars;
    const name = (evState.available.find((c) => c.code === code) || { name: code }).name;
    evFlash(on ? t('eventsPage.holidays_now_mark_every_date_axis', { name }) : t('eventsPage.holidays_switched_off', { name }));
  } else evFlash((res && res.error) || t('eventsPage.could_not_change_the_calendars'), true);
  evPaintCalendars();
}

// ── CSV import ───────────────────────────────────────────────────────────────

async function evImportFile(file: File | null): Promise<void> {
  if (!file || !currentProjectId) return;
  let res: any = null;
  try { res = await window.hubEvents.importCsv(currentProjectId, await file.text()); } catch (_) { res = null; }
  if (res && res.ok) {
    evFlash(t('eventsPage.imported_from', { added: res.added, name: file.name, p3: (res.skipped ? t('eventsPage.skipped_no_readable_date_or_title', { skipped: res.skipped }) : '') }));
  } else evFlash((res && res.error) || t('eventsPage.could_not_import_that_file'), true);
  await evRefresh();
}

// ── boot wiring (once) ───────────────────────────────────────────────────────

(function initEventsPage(): void {
  const tab = evEl('ds-tab-events');
  if (tab) tab.addEventListener('click', () => { clSelectTab('events'); evFlash(''); void evRefresh(); });
  for (const id of ['ev-new', 'ev-empty-new']) {
    const b = evEl(id);
    if (b) b.addEventListener('click', () => { void evEdit(null); });
  }
  const file = evEl('ev-file') as HTMLInputElement | null;
  for (const id of ['ev-import', 'ev-empty-import']) {
    const b = evEl(id);
    if (b && file) b.addEventListener('click', () => file.click());
  }
  if (file) file.addEventListener('change', () => { const f = file.files && file.files[0]; file.value = ''; void evImportFile(f || null); });
})();
