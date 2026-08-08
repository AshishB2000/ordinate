// Adding a connection: the catalog of 35 sources, the picker, the generic form
// built from the connector's field list, and Test & Save.
//
// Secrets never leave main. What the renderer holds is what the user typed,
// on its way to a main-process handler — nothing is read back.
//
// Split verbatim out of connections.ts — see .claude/rules/file-size.md.
// Classic global-scope renderer <script>: no import/export. Loads AFTER
// connections.js, which keeps the module-local state and the connector
// contract every function here reads.

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

