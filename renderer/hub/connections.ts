// Connected data sources UI. Classic global-scope renderer <script> — NO
// import/export; symbols are shared with the other hub scripts. Consumes
// window.hub.* (the connection:* bridge) and the shared currentProjectId
// (workspace.ts), formatSidebarTime (hub.ts), and refreshDatasetList
// (datasets.ts).
//
// THE FORM IS DATA-DRIVEN. There is no per-connector code in this file. The
// picker and every input are built from the `connectors:catalog` contract, so
// adding a data source is adding a connector definition in main — not editing a
// <select>, a field block, and a value-collector here, which is what the
// hardcoded Postgres/URL form forced.
//
// GRACEFUL DEGRADATION: if window.hub.connectorCatalog is missing or throws,
// CONN_FALLBACK_CATALOG describes the two sources main has always supported, in
// exactly the field keys src/ipc/connections.ts already reads. An old main and a
// new renderer therefore behave identically to before, rather than rendering an
// empty panel.
//
// SECURITY: a value typed into a `secret: true` field travels ONE-WAY to main
// inside the `secret` argument of testAndSaveConnection and is NEVER read back.
// connRenderFields refuses to write a secret key into the DOM even when handed
// one — the renderer is not supposed to receive stored secrets at all, so a
// value arriving there is a main-process bug, not something to display. All
// names/values are rendered as textContent only. No inline style= (CSP);
// toggles use .hidden.

// ── The connector contract, as the renderer sees it ──────────────────────────
// Mirrors src/connectors/types.ts (ConnectorField / ConnectorDef minus the
// main-only methods). Duplicated rather than imported because renderer files are
// classic scripts with no module system.
interface ConnFieldDef {
  key: string;
  label: string;
  type: 'text' | 'number' | 'password' | 'select' | 'checkbox' | 'textarea';
  required?: boolean;
  placeholder?: string;
  default?: string | number | boolean;
  options?: { value: string; label: string }[];
  secret?: boolean;
  help?: string;
}

interface ConnDef {
  id: string;
  label: string;
  family: string;
  category: string;
  blurb?: string;
  fields: ConnFieldDef[];
}

// Fixed display order; anything with an unrecognised category is appended under
// its own heading rather than dropped.
const CONN_CATEGORY_ORDER = ['Databases', 'Cloud warehouses', 'Query engines', 'Files & local'];

// What main has always supported, in main's own field keys. Used only when the
// catalog channel is unavailable.
const CONN_FALLBACK_CATALOG: ConnDef[] = [
  {
    id: 'postgres',
    label: 'PostgreSQL',
    family: 'postgres',
    category: 'Databases',
    blurb: 'Read-only access to a Postgres database.',
    fields: [
      { key: 'host', label: 'Host', type: 'text', default: 'localhost', placeholder: 'localhost' },
      { key: 'port', label: 'Port', type: 'number', default: 5432, placeholder: '5432' },
      { key: 'database', label: 'Database', type: 'text', required: true, placeholder: 'mydb' },
      { key: 'user', label: 'User', type: 'text', placeholder: 'postgres' },
      { key: 'password', label: 'Password', type: 'password', secret: true, placeholder: '••••••••' },
      { key: 'ssl', label: 'SSL', type: 'checkbox', default: false },
      {
        key: 'table',
        label: 'Table',
        type: 'text',
        placeholder: 'schema.table (optional)',
        help: 'Optional. You can also pick a table after connecting.',
      },
      { key: 'query', label: 'Query', type: 'text', placeholder: 'select … (optional; overrides table)' },
    ],
  },
  {
    id: 'url',
    label: 'URL / API (JSON)',
    family: 'http',
    category: 'Files & local',
    blurb: 'Fetch JSON from an https endpoint.',
    fields: [
      { key: 'url', label: 'URL', type: 'text', required: true, placeholder: 'https://api.example.com/data.json' },
      {
        key: 'token',
        label: 'Auth token',
        type: 'password',
        secret: true,
        placeholder: 'Optional Bearer token',
        help: 'Sent as a Bearer header. Stored outside the shareable project folder.',
      },
    ],
  },
];

// ── Module-local state ───────────────────────────────────────────────────────
let connRunConnId = ''; // connId whose result is shown in the run area
let connRunKind = ''; // connector id of the connection being run
let connRunFamily = ''; // its family ('postgres' | 'http' | …) — drives the run UI
let connRunPreview: any = null; // last run ParseResult, held for "save as dataset"

let connCatalog: ConnDef[] = []; // resolved once per panel open
let connCatalogLoaded = false;
// True when the catalogue channel was unavailable or errored and the two-source
// fallback is in use. Drives the on-screen notice; see loadConnCatalog().
let connCatalogDegraded = false;
let connSelected: ConnDef | null = null; // the connector whose form is showing
let connSearch = ''; // current picker filter
// Non-secret answers kept per connector id so "Change source" and back is not
// destructive. NEVER holds a secret — see connShowPicker.
const connDraftValues: Record<string, Record<string, unknown>> = {};

const CONN_PREVIEW_ROWS = 500; // display-only slice (full capped rows stay in connRunPreview)

type ConnLogo = { path?: string; color?: string; title?: string; src?: string };
const CONN_LOGOS: Record<string, ConnLogo> =
  (window.hub && window.hub.connectorLogos) || {};
const CONN_ACTION_LOGOS: Record<string, ConnLogo> = {
  'home-paste': {
    path: 'M9 2h6a2 2 0 0 1 2 2h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2a2 2 0 0 1 2-2Zm0 4h6V4H9v2Zm-2 3v2h10V9H7Zm0 4v2h10v-2H7Zm0 4v2h7v-2H7Z',
    color: 'currentColor',
    title: 'Paste data',
  },
  'home-capture': {
    path: 'M4 3h5v2H5v4H3V4a1 1 0 0 1 1-1Zm11 0h5a1 1 0 0 1 1 1v5h-2V5h-4V3ZM3 15h2v4h4v2H4a1 1 0 0 1-1-1v-5Zm16 0h2v5a1 1 0 0 1-1 1h-5v-2h4v-4Zm-7-7a4 4 0 1 1 0 8 4 4 0 0 1 0-8Z',
    color: 'currentColor',
    title: 'Screenshot',
  },
};

// ── Small DOM helpers ────────────────────────────────────────────────────────
function connEl(id: string): HTMLElement | null {
  return document.getElementById(id);
}

function connShow(id: string, show: boolean): void {
  const el = connEl(id);
  if (el) el.hidden = !show;
}

function connSetError(msg: string): void {
  const box = connEl('conn-error');
  if (!box) return;
  if (msg) {
    box.textContent = msg;
    box.hidden = false;
  } else {
    box.textContent = '';
    box.hidden = true;
  }
}

function connVal(id: string): string {
  const el = connEl(id) as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | null;
  return el && typeof el.value === 'string' ? el.value.trim() : '';
}

// ── Panel open/close ─────────────────────────────────────────────────────────
async function openConnPanel(): Promise<void> {
  connSetError('');
  connShow('conn-panel', true);
  await loadConnCatalog();
  connShowPicker();
  await refreshConnectionList();
}

function closeConnPanel(): void {
  connShow('conn-panel', false);
}

// ── The catalog ──────────────────────────────────────────────────────────────
// The bridge method is typed here rather than on the window.hub interface: the
// core agent owns that declaration, and a duplicate member would be a conflict.
// A structural cast keeps this file type-checking against either version.
type ConnCatalogBridge = { connectorCatalog?: () => Promise<unknown> };

// The brief specified a bare array; the shipped handler returns
// `{ ok, connectors: [...] }`. Accept either rather than silently degrading to
// two connectors because of an envelope — the fallback exists for a MISSING
// channel, not for a working one whose reply is wrapped.
function connUnwrapCatalog(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (!raw || typeof raw !== 'object') return [];
  const obj = raw as Record<string, unknown>;
  for (const key of ['connectors', 'catalog', 'items', 'list', 'data']) {
    if (Array.isArray(obj[key])) return obj[key] as unknown[];
  }
  for (const v of Object.values(obj)) if (Array.isArray(v)) return v;
  return [];
}

// Accept only well-formed entries. A connector missing an id/label/fields is
// skipped, not rendered as a blank tile — the picker's job is to be scannable.
function connCoerceCatalog(raw: unknown): ConnDef[] {
  const out: ConnDef[] = [];
  for (const item of connUnwrapCatalog(raw)) {
    const d = item as Partial<ConnDef> | null;
    if (!d || typeof d.id !== 'string' || !d.id) continue;
    if (typeof d.label !== 'string' || !d.label) continue;
    if (!Array.isArray(d.fields)) continue;
    const fields: ConnFieldDef[] = [];
    for (const f of d.fields as Partial<ConnFieldDef>[]) {
      if (!f || typeof f.key !== 'string' || !f.key) continue;
      fields.push({
        key: f.key,
        label: typeof f.label === 'string' && f.label ? f.label : f.key,
        type:
          f.type === 'number' || f.type === 'password' || f.type === 'select' ||
          f.type === 'checkbox' || f.type === 'textarea'
            ? f.type
            : 'text',
        required: f.required === true,
        placeholder: typeof f.placeholder === 'string' ? f.placeholder : undefined,
        default: f.default,
        options: Array.isArray(f.options) ? f.options : undefined,
        secret: f.secret === true,
        help: typeof f.help === 'string' ? f.help : undefined,
      });
    }
    out.push({
      id: d.id,
      label: d.label,
      family: typeof d.family === 'string' ? d.family : '',
      category: typeof d.category === 'string' && d.category ? d.category : 'Other',
      blurb: typeof d.blurb === 'string' ? d.blurb : undefined,
      fields,
    });
  }
  return out;
}

async function loadConnCatalog(): Promise<void> {
  if (connCatalogLoaded) return;
  const bridge = window.hub as unknown as ConnCatalogBridge;
  let list: ConnDef[] = [];
  if (typeof bridge.connectorCatalog === 'function') {
    try {
      list = connCoerceCatalog(await bridge.connectorCatalog());
    } catch (_) {
      list = [];
    }
  }
  // An old main (or a channel that errored) still gets the two sources it can
  // actually serve, rather than an empty panel — but it must SAY SO.
  //
  // Silently degrading to two is how a stale build looks like a missing
  // feature: the picker renders, the search works, and typing "red" simply
  // finds nothing because Redshift was never in the list. That happened to a
  // real user, and nothing on screen explained it. A fallback that hides its
  // own failure is worse than no fallback.
  connCatalogDegraded = list.length === 0;
  connCatalog = list.length > 0 ? list : CONN_FALLBACK_CATALOG;
  connCatalogLoaded = true;
}

// Look up a connector by the id stored on a saved connection (its `kind`).
function connDefById(id: string): ConnDef | null {
  for (const d of connCatalog) if (d.id === id) return d;
  return null;
}

// Family drives the run UI (table picker + SQL box vs. neither). Falls back to
// the legacy pair so a saved connection still works before the catalog loads.
function connFamilyOf(id: string): string {
  const d = connDefById(id);
  if (d && d.family) return d.family;
  return id === 'url' ? 'http' : 'postgres';
}

// ── Step 1: the picker ───────────────────────────────────────────────────────
function connShowPicker(keepValues?: boolean): void {
  // Going "back" should not retype a host and a port. Only the NON-SECRET half
  // is remembered — connCollectValues keeps secrets in a separate bag, which is
  // then simply dropped here.
  if (keepValues && connSelected) connDraftValues[connSelected.id] = connCollectValues(connSelected).config;
  connSelected = null;
  connShow('conn-picker', true);
  connShow('conn-form', false);
  connRenderPicker();
  const search = connEl('conn-search') as HTMLInputElement | null;
  if (search) search.focus();
}

function connMatches(d: ConnDef, q: string): boolean {
  if (!q) return true;
  return d.label.toLowerCase().includes(q) || d.id.toLowerCase().includes(q);
}

function connRenderPicker(): void {
  const host = connEl('conn-groups');
  if (!host) return;
  host.innerHTML = '';
  const q = connSearch.trim().toLowerCase();
  const shown = connCatalog.filter((d) => connMatches(d, q));

  // Group in the fixed order, then any unrecognised categories alphabetically —
  // an unknown category must still be reachable.
  const cats: string[] = CONN_CATEGORY_ORDER.slice();
  for (const d of connCatalog) if (!cats.includes(d.category)) cats.push(d.category);

  for (const cat of cats) {
    const items = shown.filter((d) => d.category === cat);
    if (items.length === 0) continue;

    const group = document.createElement('div');
    group.className = 'conn-group';

    const h = document.createElement('h4');
    h.className = 'conn-group-h';
    // Count reflects what is VISIBLE, so it stays truthful while filtering.
    h.textContent = cat + ' (' + items.length + ')';
    group.appendChild(h);

    const grid = document.createElement('div');
    grid.className = 'conn-grid';
    for (const d of items) grid.appendChild(connMakeTile(d));
    group.appendChild(grid);
    host.appendChild(group);
  }

  // Three distinct states: no catalogue at all, a catalogue with no match, and
  // results. Collapsing the first two would hide a broken channel behind a
  // message that reads like a typo.
  const emptyCatalog = connCatalog.length === 0;
  connShow('conn-picker-unavailable', emptyCatalog);
  connShow('conn-picker-none', !emptyCatalog && shown.length === 0);
  // Visible whenever the full list could not be fetched, whether or not the
  // current search matches — the reason the list is short is the point.
  connShow('conn-picker-degraded', connCatalogDegraded);

  const count = connEl('conn-search-count');
  if (count) {
    count.textContent = emptyCatalog
      ? ''
      : q
        ? shown.length + ' of ' + connCatalog.length + ' sources'
        : connCatalog.length + ' sources';
  }
}

function connInitials(label: string): string {
  const words = label.replace(/\([^)]*\)/g, '').trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

function connMakeLogoFor(id: string, label: string): HTMLElement {
  const host = document.createElement('span');
  host.className = 'conn-logo';
  host.setAttribute('aria-hidden', 'true');
  const logo = CONN_LOGOS[id] || CONN_ACTION_LOGOS[id];
  if (logo?.src) {
    const img = document.createElement('img');
    img.addEventListener('error', () => {
      const currentHost = img.parentElement;
      if (!(currentHost instanceof HTMLElement)) return;
      currentHost.replaceChildren();
      currentHost.classList.add('conn-logo-fallback');
      currentHost.textContent = connInitials(label);
    }, { once: true });
    img.src = logo.src;
    img.alt = '';
    host.appendChild(img);
  } else if (logo?.path) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', logo.path);
    path.setAttribute('fill', logo.color || 'currentColor');
    svg.appendChild(path);
    host.appendChild(svg);
  } else {
    host.classList.add('conn-logo-fallback');
    host.textContent = connInitials(label);
  }
  return host;
}

function connMakeLogo(d: ConnDef): HTMLElement {
  return connMakeLogoFor(d.id, d.label);
}

function connRenderChosenLogo(d: ConnDef): void {
  const host = connEl('conn-chosen-logo');
  if (!host) return;
  const logo = connMakeLogo(d);
  host.replaceChildren(...logo.childNodes);
  host.className = logo.className;
  host.setAttribute('aria-hidden', 'true');
}

function connMakeTile(d: ConnDef): HTMLElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'conn-tile';
  btn.dataset.connectorId = d.id;

  btn.appendChild(connMakeLogo(d));
  const copy = document.createElement('span');
  copy.className = 'conn-tile-copy';

  const label = document.createElement('span');
  label.className = 'conn-tile-label';
  label.textContent = d.label; // textContent — a label is never HTML
  copy.appendChild(label);

  if (d.blurb) {
    const blurb = document.createElement('span');
    blurb.className = 'conn-tile-blurb';
    blurb.textContent = d.blurb;
    copy.appendChild(blurb);
  }
  btn.appendChild(copy);
  // A <button> already answers Enter and Space; the arrow keys are wired once on
  // the container in initConnections.
  btn.addEventListener('click', () => connSelectConnector(d, connDraftValues[d.id]));
  return btn;
}

// Arrow keys move focus across the whole (filtered) tile set, so the grid reads
// as one list regardless of how the groups fall.
function connPickerKeydown(e: KeyboardEvent): void {
  const keys = ['ArrowDown', 'ArrowUp', 'ArrowRight', 'ArrowLeft', 'Home', 'End'];
  if (!keys.includes(e.key)) return;
  const host = connEl('conn-groups');
  if (!host) return;
  const tiles = Array.from(host.querySelectorAll('.conn-tile')) as HTMLElement[];
  if (tiles.length === 0) return;
  const here = tiles.indexOf(document.activeElement as HTMLElement);
  if (here < 0) return; // focus is elsewhere; don't hijack the key
  let next = here;
  if (e.key === 'Home') next = 0;
  else if (e.key === 'End') next = tiles.length - 1;
  else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = Math.min(here + 1, tiles.length - 1);
  else next = Math.max(here - 1, 0);
  e.preventDefault();
  tiles[next].focus();
}

// ── Step 2: the generic form ─────────────────────────────────────────────────
function connSelectConnector(d: ConnDef, values?: Record<string, unknown>): void {
  connRenderChosenLogo(d);
  connSetError('');
  connSelected = d;

  const name = connEl('conn-chosen-name');
  if (name) name.textContent = d.label;
  const blurb = connEl('conn-chosen-blurb');
  if (blurb) blurb.textContent = d.blurb || '';

  connRenderFields(d, values);
  connShow('conn-picker', false);
  connShow('conn-form', true);

  const nameInput = connEl('conn-name') as HTMLInputElement | null;
  if (nameInput) nameInput.focus();
}

// The one renderer. `values` prefills NON-SECRET fields only.
function connRenderFields(d: ConnDef, values?: Record<string, unknown>): void {
  const host = connEl('conn-fields');
  if (!host) return;
  host.innerHTML = '';

  for (const f of d.fields) {
    const row = document.createElement('div');
    row.className = 'conn-field-row';

    const inputId = 'conn-f-' + f.key;

    const label = document.createElement('label');
    label.className = 'conn-label';
    label.htmlFor = inputId;
    label.textContent = f.label;
    if (f.required) {
      const star = document.createElement('span');
      star.className = 'conn-req';
      star.textContent = '*';
      star.setAttribute('aria-hidden', 'true');
      label.appendChild(star);
    }
    row.appendChild(label);

    // A secret is NEVER prefilled. The renderer is not given stored secrets; if
    // one ever arrives here it is a leak in main, so this drops it on the floor
    // rather than painting it into an input where a DOM dump would reveal it.
    const prefill = f.secret ? undefined : values ? values[f.key] : undefined;

    let control: HTMLElement;
    if (f.type === 'select') {
      const sel = document.createElement('select');
      sel.className = 'conn-input';
      sel.id = inputId;
      for (const opt of f.options || []) {
        const o = document.createElement('option');
        o.value = String(opt && opt.value != null ? opt.value : '');
        o.textContent = String(opt && opt.label != null ? opt.label : o.value);
        sel.appendChild(o);
      }
      const initial = prefill != null ? String(prefill) : f.default != null ? String(f.default) : '';
      if (initial) sel.value = initial;
      if (f.required) sel.required = true;
      control = sel;
    } else if (f.type === 'textarea') {
      // A SQL statement is not a one-line value. Before this branch the Postgres
      // `query` field rendered as a single-line <input> — a downgrade from the
      // textarea it replaced, and unusable for anything real.
      const ta = document.createElement('textarea');
      ta.className = 'conn-input conn-textarea';
      ta.id = inputId;
      ta.rows = 4;
      ta.spellcheck = false;
      if (f.placeholder) ta.placeholder = f.placeholder;
      if (f.required) ta.required = true;
      if (!f.secret && prefill != null) ta.value = String(prefill);
      else if (!f.secret && f.default != null) ta.value = String(f.default);
      control = ta;
    } else if (f.type === 'checkbox') {
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.className = 'conn-check';
      box.id = inputId;
      box.checked = prefill != null ? Boolean(prefill) : f.default === true;
      control = box;
    } else {
      const input = document.createElement('input');
      // `secret` and `password` both mean "do not show what is typed".
      input.type = f.secret || f.type === 'password' ? 'password' : f.type === 'number' ? 'number' : 'text';
      input.className = 'conn-input';
      input.id = inputId;
      input.autocomplete = 'off';
      if (f.placeholder) input.placeholder = f.placeholder;
      if (f.required) input.required = true;
      if (!f.secret) {
        if (prefill != null) input.value = String(prefill);
        else if (f.default != null) input.value = String(f.default);
      }
      control = input;
    }
    control.dataset.connKey = f.key;
    if (f.secret) control.dataset.connSecret = '1';
    control.dataset.connType = f.type;
    row.appendChild(control);
    host.appendChild(row);

    if (f.help) {
      const help = document.createElement('p');
      help.className = 'conn-help';
      help.textContent = f.help;
      host.appendChild(help);
    }
  }
}

interface ConnCollected {
  config: Record<string, unknown>;
  secret: Record<string, string>;
  missing: string[]; // labels of unfilled required fields
  firstMissingEl: HTMLElement | null;
}

// Read the rendered form back out, splitting secrets from metadata.
function connCollectValues(d: ConnDef): ConnCollected {
  const out: ConnCollected = { config: {}, secret: {}, missing: [], firstMissingEl: null };
  const host = connEl('conn-fields');
  if (!host) return out;

  for (const f of d.fields) {
    const el = host.querySelector('#conn-f-' + CSS.escape(f.key)) as
      | HTMLInputElement
      | HTMLSelectElement
      | null;
    if (!el) continue;
    el.classList.remove('conn-input-invalid');

    let value: unknown;
    if (f.type === 'checkbox') {
      value = (el as HTMLInputElement).checked;
    } else if (f.type === 'number') {
      const raw = el.value.trim();
      const n = Number(raw);
      value = raw === '' ? '' : Number.isFinite(n) ? n : raw;
    } else {
      value = el.value.trim();
    }

    const blank = value === '' || value == null;
    if (f.required && blank && f.type !== 'checkbox') {
      out.missing.push(f.label);
      el.classList.add('conn-input-invalid');
      if (!out.firstMissingEl) out.firstMissingEl = el;
    }

    if (f.secret) {
      if (typeof value === 'string' && value) out.secret[f.key] = value;
    } else if (!blank || f.type === 'checkbox') {
      out.config[f.key] = value;
    }
  }
  return out;
}

// ── Test & Save ──────────────────────────────────────────────────────────────
async function handleConnTestAndSave(): Promise<void> {
  connSetError('');
  if (!currentProjectId) {
    connSetError('Open a project first.');
    return;
  }
  const def = connSelected;
  if (!def) {
    connSetError('Pick a data source first.');
    return;
  }

  const collected = connCollectValues(def);
  if (collected.missing.length > 0) {
    connSetError(
      collected.missing.length === 1
        ? collected.missing[0] + ' is required.'
        : 'These fields are required: ' + collected.missing.join(', ') + '.',
    );
    if (collected.firstMissingEl) collected.firstMissingEl.focus();
    return;
  }

  const btn = connEl('conn-test-btn') as HTMLButtonElement | null;
  if (btn) btn.disabled = true;

  // `name` is the panel's own input, not a connector field; a connector that
  // declares its own `name` field wins, hence the ordering.
  const config: Record<string, unknown> = { name: connVal('conn-name'), ...collected.config };

  let res: any;
  try {
    // The connector id IS the kind. For 'postgres'/'url' this is byte-identical
    // to what this form has always sent.
    res = await window.hub.testAndSaveConnection(currentProjectId, def.id, config, collected.secret);
  } catch (_) {
    res = { ok: false, error: 'Could not reach the connection.' };
  } finally {
    if (btn) btn.disabled = false;
  }

  if (!res || res.ok === false) {
    connSetError((res && res.error) || 'Could not connect.');
    return;
  }
  // Success: clear the whole form (secrets included — they are write-only) and
  // return to the picker so the next connection starts from a clean slate.
  const nameInput = connEl('conn-name') as HTMLInputElement | null;
  if (nameInput) nameInput.value = '';
  delete connDraftValues[def.id];
  connShowPicker();
  await refreshConnectionList();
}

// ── Saved-connections list ───────────────────────────────────────────────────
async function refreshConnectionList(): Promise<void> {
  const list = connEl('conn-saved-list');
  const empty = connEl('conn-saved-empty');
  if (!list) return;
  list.innerHTML = '';
  if (!currentProjectId) {
    if (empty) empty.hidden = false;
    return;
  }
  let items: any[] = [];
  try {
    items = await window.hub.listConnections(currentProjectId);
  } catch (_) {
    items = [];
  }
  if (!Array.isArray(items)) items = [];
  if (empty) empty.hidden = items.length > 0;
  items.forEach((c) => list.appendChild(makeConnItem(c)));
}

function makeConnItem(c: any): HTMLElement {
  const row = document.createElement('div');
  row.className = 'conn-saved-item';

  const mainCol = document.createElement('div');
  mainCol.className = 'conn-saved-main';

  const name = document.createElement('span');
  name.className = 'conn-saved-name';
  name.textContent = c && c.name ? String(c.name) : 'Untitled connection';

  const meta = document.createElement('span');
  meta.className = 'conn-saved-meta';
  const status = c && c.lastStatus ? String(c.lastStatus) : 'untested';
  const statusBadge = document.createElement('span');
  statusBadge.className = 'conn-status conn-status-' + (status === 'ok' ? 'ok' : status === 'error' ? 'error' : 'untested');
  statusBadge.textContent = status;
  // The stored `kind` is a connector id; name it from the catalogue so a saved
  // Redshift connection does not read "Postgres". Unknown ids show verbatim.
  const kindId = c && typeof c.kind === 'string' ? c.kind : '';
  const kindDef = connDefById(kindId);
  const kind = kindDef ? kindDef.label : kindId === 'url' ? 'URL' : kindId || 'Connection';
  const when = c && c.lastRefreshedAt ? 'refreshed ' + formatSidebarTime(c.lastRefreshedAt) : 'never refreshed';
  const metaText = document.createElement('span');
  metaText.textContent = kind + ' · ' + when;
  meta.appendChild(statusBadge);
  meta.appendChild(metaText);

  mainCol.appendChild(name);
  mainCol.appendChild(meta);

  const runBtn = document.createElement('button');
  runBtn.type = 'button';
  runBtn.className = 'conn-run-btn';
  runBtn.textContent = 'Run';
  runBtn.addEventListener('click', () => openRunArea(c));

  const refreshBtn = document.createElement('button');
  refreshBtn.type = 'button';
  refreshBtn.className = 'conn-refresh';
  refreshBtn.textContent = 'Refresh';
  refreshBtn.addEventListener('click', () => handleConnRefresh(c));

  const delBtn = document.createElement('button');
  delBtn.type = 'button';
  delBtn.className = 'conn-del';
  delBtn.setAttribute('aria-label', 'Delete connection');
  delBtn.textContent = '🗑';
  delBtn.addEventListener('click', () => handleConnDelete(c));

  row.appendChild(mainCol);
  row.appendChild(runBtn);
  row.appendChild(refreshBtn);
  row.appendChild(delBtn);
  return row;
}

// ── Run area (per saved connection) ──────────────────────────────────────────
async function openRunArea(c: any): Promise<void> {
  if (!currentProjectId || !c || !c.id) return;
  connSetError('');
  connRunConnId = String(c.id);
  connRunKind = typeof c.kind === 'string' ? c.kind : 'postgres';
  connRunFamily = connFamilyOf(connRunKind);
  connRunPreview = null;

  const title = connEl('conn-run-title');
  if (title) title.textContent = 'Run — ' + (c.name || 'connection');

  // Reset preview + save bar.
  const scroll = connEl('conn-run-table-scroll');
  if (scroll) scroll.innerHTML = '';
  connShow('conn-run-preview', false);
  connShow('conn-save-bar', false);
  connShow('conn-run-warnings', false);

  // Table + query belong to anything SQL-shaped. The dividing line is NOT the
  // family: every HTTP engine here (ClickHouse, Trino, Druid, …) implements
  // listTables and is queried in SQL. The one source with neither is `url`,
  // which fetches a single document. Gating on family cost seven connectors
  // their table picker.
  const isPg = connRunKind !== 'url';
  connShow('conn-run-table-row', isPg);
  connShow('conn-run-query-row', isPg);

  // Prefill the query textarea with any saved query.
  const qEl = connEl('conn-run-query') as HTMLTextAreaElement | null;
  if (qEl) qEl.value = isPg && typeof c.query === 'string' ? c.query : '';

  connShow('conn-run-area', true);

  if (isPg) {
    const sel = connEl('conn-table-select') as HTMLSelectElement | null;
    if (sel) {
      sel.innerHTML = '';
      const loading = document.createElement('option');
      loading.value = '';
      loading.textContent = 'Loading tables…';
      sel.appendChild(loading);
    }
    let tRes: any;
    try {
      tRes = await window.hub.listConnectionTables(currentProjectId, connRunConnId);
    } catch (_) {
      tRes = { ok: false, error: 'Could not list tables.' };
    }
    if (sel) {
      sel.innerHTML = '';
      if (tRes && tRes.ok && Array.isArray(tRes.tables)) {
        const blank = document.createElement('option');
        blank.value = '';
        blank.textContent = c.table ? c.table : 'Choose a table…';
        sel.appendChild(blank);
        tRes.tables.forEach((t: any) => {
          const qualified = (t && t.schema ? String(t.schema) + '.' : '') + (t && t.name ? String(t.name) : '');
          const opt = document.createElement('option');
          opt.value = qualified;
          opt.textContent = qualified;
          if (c.table && qualified === c.table) opt.selected = true;
          sel.appendChild(opt);
        });
      } else {
        const err = document.createElement('option');
        err.value = '';
        err.textContent = (tRes && tRes.error) || 'Could not list tables';
        sel.appendChild(err);
      }
    }
  }
}

function closeRunArea(): void {
  connShow('conn-run-area', false);
  connRunConnId = '';
  connRunKind = '';
  connRunFamily = '';
  connRunPreview = null;
}

async function handleConnRun(): Promise<void> {
  if (!currentProjectId || !connRunConnId) return;
  connSetError('');
  const btn = connEl('conn-run-btn') as HTMLButtonElement | null;
  if (btn) btn.disabled = true;

  let tableOrQuery: any = {};
  if (connRunKind !== 'url') {
    const query = connVal('conn-run-query');
    if (query) tableOrQuery = { query };
    else {
      const table = connVal('conn-table-select');
      if (table) tableOrQuery = { table };
    }
  }

  let res: any;
  try {
    res = await window.hub.runConnection(currentProjectId, connRunConnId, tableOrQuery);
  } catch (_) {
    res = { ok: false, error: 'Could not run the connection.' };
  } finally {
    if (btn) btn.disabled = false;
  }

  if (!res || res.ok === false) {
    connSetError((res && res.error) || 'Could not run the connection.');
    connShow('conn-run-preview', false);
    connShow('conn-save-bar', false);
    return;
  }
  connRunPreview = res.preview || null;
  connRenderRunPreview(connRunPreview);
}

// Build the preview table into #conn-run-table-scroll (reuses the .ds-table CSS).
function connRenderRunPreview(res: any): void {
  const columns: any[] = res && Array.isArray(res.columns) ? res.columns : [];
  const rows: any[] = res && Array.isArray(res.rows) ? res.rows : [];
  const warnings: any[] = res && Array.isArray(res.warnings) ? res.warnings : [];
  const rowCount: number = typeof (res && res.rowCount) === 'number' ? res.rowCount : rows.length;

  // Warnings.
  const warnBox = connEl('conn-run-warnings');
  if (warnBox) {
    warnBox.innerHTML = '';
    warnings.forEach((w) => {
      const line = document.createElement('div');
      line.className = 'ds-warning';
      line.textContent = String(w);
      warnBox.appendChild(line);
    });
  }
  connShow('conn-run-warnings', warnings.length > 0);

  // Table.
  const scroll = connEl('conn-run-table-scroll');
  if (scroll) {
    scroll.innerHTML = '';
    const table = document.createElement('table');
    table.className = 'ds-table';

    const thead = document.createElement('thead');
    const htr = document.createElement('tr');
    columns.forEach((col) => {
      const th = document.createElement('th');
      th.className = 'ds-th';
      const nameSpan = document.createElement('span');
      nameSpan.className = 'ds-th-name';
      nameSpan.textContent = col && col.name != null ? String(col.name) : '';
      const type = col && col.type ? String(col.type) : 'text';
      const badge = document.createElement('span');
      badge.className = 'ds-type ds-type-' + type;
      badge.textContent = type;
      th.appendChild(nameSpan);
      th.appendChild(badge);
      htr.appendChild(th);
    });
    thead.appendChild(htr);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    rows.slice(0, CONN_PREVIEW_ROWS).forEach((row) => {
      const tr = document.createElement('tr');
      const cells: any[] = Array.isArray(row) ? row : [];
      for (let i = 0; i < columns.length; i++) {
        const td = document.createElement('td');
        td.className = 'ds-td';
        const v = cells[i];
        td.textContent = v == null ? '' : String(v);
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    scroll.appendChild(table);
  }

  const note = connEl('conn-run-note');
  if (note) {
    if (rowCount > CONN_PREVIEW_ROWS) {
      note.textContent = 'Showing first ' + CONN_PREVIEW_ROWS + ' of ' + rowCount + ' rows';
      note.hidden = false;
    } else {
      note.textContent = '';
      note.hidden = true;
    }
  }

  connShow('conn-run-preview', columns.length > 0);

  // Save bar — suggest a dataset name from the connection/table.
  const nameInput = connEl('conn-ds-name') as HTMLInputElement | null;
  if (nameInput && !nameInput.value) {
    const table = connVal('conn-table-select');
    nameInput.value = table || 'Connection data';
  }
  connShow('conn-save-bar', columns.length > 0);
}

// Save the current run result as a dataset, then link the connection to it (so
// Refresh has a target). Reuses the existing dataset:save channel.
async function handleConnSaveAsDataset(): Promise<void> {
  if (!currentProjectId || !connRunConnId) return;
  if (!connRunPreview || !Array.isArray(connRunPreview.columns) || connRunPreview.columns.length === 0) return;
  const nameInput = connEl('conn-ds-name') as HTMLInputElement | null;
  const name = (nameInput && nameInput.value.trim()) || 'Connection data';
  // Dataset.sourceKind is a closed union, so 35 connector ids collapse onto the
  // two it already has: an http source is 'url', everything else 'postgres'.
  const sourceKind = connRunKind === 'url' ? 'url' : 'postgres';

  let saved: any;
  try {
    saved = await window.hub.saveDataset({
      projectId: currentProjectId,
      name,
      sourceKind,
      columns: connRunPreview.columns,
      rows: connRunPreview.rows,
    });
  } catch (_) {
    connSetError('Failed to save the dataset.');
    return;
  }
  if (saved && saved.ok === false) {
    connSetError(saved.error || 'Failed to save the dataset.');
    return;
  }
  // Link the connection to the new dataset so Refresh can re-run into it.
  if (saved && saved.id) {
    try {
      await window.hub.refreshConnection(currentProjectId, connRunConnId, String(saved.id));
    } catch (_) {
      /* best-effort link; ignore */
    }
  }
  closeRunArea();
  await refreshConnectionList();
  // The new dataset also appears in the Datasets section list.
  if (typeof refreshDatasetList === 'function') await refreshDatasetList();
}

// ── Refresh / Delete ─────────────────────────────────────────────────────────
async function handleConnRefresh(c: any): Promise<void> {
  if (!currentProjectId || !c || !c.id) return;
  connSetError('');
  if (!c.linkedDatasetId) {
    connSetError('Run this connection and save the result as a dataset first, then Refresh will keep it up to date.');
    return;
  }
  let res: any;
  try {
    res = await window.hub.refreshConnection(currentProjectId, String(c.id), String(c.linkedDatasetId));
  } catch (_) {
    res = { ok: false, error: 'Could not refresh the connection.' };
  }
  if (!res || res.ok === false) {
    connSetError((res && res.error) || 'Could not refresh the connection.');
  }
  await refreshConnectionList();
  if (typeof refreshDatasetList === 'function') await refreshDatasetList();
}

async function handleConnDelete(c: any): Promise<void> {
  if (!currentProjectId || !c || !c.id) return;
  if (!window.confirm('Delete this connection? Its saved dataset is not removed.')) return;
  try {
    await window.hub.deleteConnection(currentProjectId, String(c.id));
  } catch (_) {
    /* ignore */
  }
  if (connRunConnId === String(c.id)) closeRunArea();
  await refreshConnectionList();
}

// ── Boot wiring (once) ───────────────────────────────────────────────────────
function initConnections(): void {
  const openBtn = connEl('conn-connect-btn');
  if (openBtn) openBtn.addEventListener('click', () => openConnPanel());

  const closeBtn = connEl('conn-close-btn');
  if (closeBtn) closeBtn.addEventListener('click', () => closeConnPanel());

  const search = connEl('conn-search') as HTMLInputElement | null;
  if (search) {
    search.addEventListener('input', () => {
      connSearch = search.value;
      connRenderPicker();
    });
  }

  const groups = connEl('conn-groups');
  if (groups) groups.addEventListener('keydown', (e) => connPickerKeydown(e as KeyboardEvent));

  // Back to the picker. Non-secret answers survive the round trip; secrets do
  // not, because connRenderFields refuses to prefill them.
  const changeBtn = connEl('conn-change-btn');
  if (changeBtn) changeBtn.addEventListener('click', () => connShowPicker(true));

  const testBtn = connEl('conn-test-btn');
  if (testBtn) testBtn.addEventListener('click', () => handleConnTestAndSave());

  const runBtn = connEl('conn-run-btn');
  if (runBtn) runBtn.addEventListener('click', () => handleConnRun());

  const runClose = connEl('conn-run-close');
  if (runClose) runClose.addEventListener('click', () => closeRunArea());

  const saveBtn = connEl('conn-save-ds-btn');
  if (saveBtn) saveBtn.addEventListener('click', () => handleConnSaveAsDataset());
}
