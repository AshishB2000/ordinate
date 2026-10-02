'use strict';

// The Catalog tab (Data · Catalog) — every record of every kind with its
// description, tags, owner, last update, how much uses it, and whether a
// scheduled dataset has gone stale. Classic global-scope renderer <script>.
//
// The rows come from main in one call (`catalog:list`, src/app/catalogIndex.ts)
// — usage and staleness are main's arithmetic, not this file's. Filtering is
// three layers over those rows: kind pills, a text box, and the shared tag bar
// (catalogUi.ts), which is the same bar every other list mounts.
//
// The table is `.ws-table` / `.ws-table-cols` / `.ws-row` like every other
// list; the empty state is `.ws-empty`.

let ctRows: any[] = [];
let ctKindFilter = '';
let ctText = '';
let ctPageSeq = 0;

function ctPageEl(id: string): HTMLElement | null {
  return document.getElementById(id);
}

/** Fetch and paint. Called when the tab is selected and after any edit. */
async function ctRefreshCatalog(): Promise<void> {
  const seq = ++ctPageSeq;
  const projectId = currentProjectId;
  let res: any = null;
  if (projectId) {
    try { res = await window.hub.catalogList(projectId); } catch (_) { res = null; }
  }
  await ctLoadTags(true);
  if (seq !== ctPageSeq || projectId !== currentProjectId) return;
  ctRows = res && res.ok !== false && Array.isArray(res.rows) ? res.rows : [];
  ctPaintKinds();
  ctPaintCatalog();
}

/** Repaint from the rows in hand — the tag bar calls this on a filter change. */
function ctCatalogRepaint(): void {
  const list = ctPageEl('ct-list');
  if (list && list.isConnected && !(ctPageEl('ct-wrap') as HTMLElement).hidden) ctPaintCatalog();
}

function ctPaintKinds(): void {
  const host = ctPageEl('ct-kinds');
  if (!host) return;
  host.textContent = '';
  const counts = new Map<string, number>();
  ctRows.forEach((r) => counts.set(r.kind, (counts.get(r.kind) || 0) + 1));
  const pills: Array<[string, string, number]> = [['', t('common.all'), ctRows.length]];
  CT_KINDS.forEach((k) => { if (counts.get(k.kind)) pills.push([k.kind, k.label.endsWith('y') ? k.label.slice(0, -1) + 'ies' : k.label + 's', counts.get(k.kind) || 0]); });
  if (ctKindFilter && !counts.get(ctKindFilter)) ctKindFilter = '';
  pills.forEach(([kind, label, n]) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'home-pill ct-kind-pill' + (kind === ctKindFilter ? ' is-active' : '');
    b.setAttribute('aria-pressed', String(kind === ctKindFilter));
    b.textContent = label;
    const count = document.createElement('span');
    count.className = 'ct-kind-n';
    count.textContent = String(n);
    b.appendChild(count);
    b.addEventListener('click', () => { ctKindFilter = kind; ctPaintKinds(); ctPaintCatalog(); });
    host.appendChild(b);
  });
}

function ctMatches(r: any): boolean {
  if (ctKindFilter && r.kind !== ctKindFilter) return false;
  const q = ctText.trim().toLowerCase();
  if (!q) return true;
  if (q.charAt(0) === '#') return (r.tags || []).some((t: any) => t.name.indexOf(ctNormTag(q)) === 0);
  return [r.name, r.description, r.owner, r.type].some((s) => String(s || '').toLowerCase().indexOf(q) >= 0);
}

function ctPaintCatalog(): void {
  const list = ctPageEl('ct-list');
  const empty = ctPageEl('ct-empty');
  const none = ctPageEl('ct-none');
  const table = ctPageEl('ct-table');
  if (!list) return;
  list.textContent = '';
  const rows = ctRows.filter(ctMatches);
  rows.forEach((r) => list.appendChild(ctMakeRow(r)));
  if (empty) empty.hidden = ctRows.length > 0;
  if (table) table.hidden = ctRows.length === 0;
  const count = ctPageEl('ct-count');
  if (count) {
    count.hidden = ctRows.length === 0;
    count.textContent = ctRows.length === 1 ? t('catalogPage.1_record') : `${ctRows.length} records`;
  }
  void ctAfterPaint(list, list.previousElementSibling as HTMLElement | null).then(() => {
    const shown = list.querySelectorAll('[data-ct-ref]:not([hidden])').length;
    if (none) none.hidden = ctRows.length === 0 || shown > 0;
  });
}

function ctMakeRow(r: any): HTMLElement {
  const row = document.createElement('div');
  row.className = 'ws-row ct-row';
  row.tabIndex = 0;
  row.setAttribute('role', 'button');
  row.setAttribute('aria-label', t('catalogPage.open', { type: r.type, name: r.name }));
  const open = (): void => { void ctOpenRecord(r.kind, r.id, currentProjectId || '', r.name); };
  row.addEventListener('click', open);
  row.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target === row) open(); });

  // Name: the kind's icon, the name (+ stale badge), and a dim line under it.
  const nameCell = document.createElement('span');
  nameCell.className = 'ct-name-cell';
  const ic = document.createElement('span');
  ic.className = 'ct-kind-ic ct-kind-ic--' + r.kind;
  ic.appendChild(icon((ctKind(r.kind) || { icon: 'folder' }).icon, 16));
  nameCell.appendChild(ic);
  const text = document.createElement('span');
  text.className = 'ct-name-text';
  const top = document.createElement('span');
  top.className = 'ct-name-top';
  const name = document.createElement('span');
  name.className = 'ct-name';
  name.textContent = r.name || t('common.untitled');
  top.appendChild(name);
  if (r.stale) {
    const stale = document.createElement('span');
    stale.className = 'ct-stale';
    stale.textContent = t('common.stale');
    stale.title = t('catalogPage.on_a_refresh_schedule_but_no');
    top.appendChild(stale);
  }
  text.appendChild(top);
  const sub = document.createElement('span');
  sub.className = 'ct-sub';
  const kindSub = r.kind === 'visual' && typeof VIZ_LABELS === 'object' ? VIZ_LABELS[r.sub] || r.sub : r.sub;
  sub.textContent = [r.type, kindSub].filter(Boolean).join(' · ') + (r.description ? ' — ' + r.description : '');
  if (r.description) sub.title = r.description;
  text.appendChild(sub);
  nameCell.appendChild(text);

  const tags = document.createElement('span');
  tags.className = 'ws-cell ct-tags-cell';

  const owner = document.createElement('span');
  owner.className = 'ws-cell ct-owner';
  owner.textContent = r.owner || '—';
  if (!r.owner) owner.classList.add('ct-muted');

  const updated = document.createElement('span');
  updated.className = 'ws-cell ct-updated';
  updated.textContent = r.updatedAt ? aiAgo(r.updatedAt) : '—';
  if (r.updatedAt) {
    updated.title = new Date(r.updatedAt).toLocaleString() + (r.updatedBy ? t('catalogPage.docs_by', { updatedBy: r.updatedBy }) : '');
  }

  const usage = document.createElement('span');
  usage.className = 'ws-cell ct-usage tnum' + (r.usage ? '' : ' ct-muted');
  usage.textContent = r.usage ? String(r.usage) : t('catalogPage.unused');
  usage.title = r.usage ? t('catalogPage.used_by_other', { usage: r.usage }) : t('catalogPage.nothing_in_this_project_uses_it');

  const actions = document.createElement('span');
  actions.className = 'ws-col-action';
  const details = document.createElement('button');
  details.type = 'button';
  details.className = 'btn btn-sm btn-ghost ct-row-details';
  iconOnly(details, 'info', t('catalogPage.details_for', { name: r.name }));
  details.addEventListener('click', (e) => {
    e.stopPropagation();
    void ctOpenDetails(details, { kind: r.kind, id: r.id, name: r.name }, { onSaved: () => void ctRefreshCatalog() });
  });
  actions.appendChild(details);

  [nameCell, tags, owner, updated, usage, actions].forEach((c) => row.appendChild(c));
  ctDecorate(row, r.kind, r.id, tags);
  return row;
}

/** "Show everything tagged #sales" — the palette's way in. */
function ctShowTag(tag: string): void {
  selectSection('datasets');
  clSelectTab('catalog');
  ctSetActiveTag(ctNormTag(tag));
}

// ── The dataset page's Columns tab ───────────────────────────────────────────
//
// The column docs as a table you edit in place: every cell is an input that
// reads as text until it is focused, and saves on blur or Enter. The example
// defaults to the first non-empty value in the window the grid holds — shown
// as a placeholder, app-computed, and stored only once someone types one.

async function ctPaintColumnsTab(): Promise<void> {
  const host = document.getElementById('ct-coldoc');
  if (!host || !expId) return;
  const datasetId = expId;
  const docs = await ctLoadColumnDocs(datasetId, true);
  if (datasetId !== expId) return;
  host.textContent = '';

  const documented = expColumns.filter((c) => { const d = docs[c.name]; return d && (d.description || d.displayName); }).length;
  const flagged = expColumns.filter((c) => docs[c.name] && docs[c.name].sensitivity && docs[c.name].sensitivity !== 'none').length;
  const lead = document.createElement('p');
  lead.className = 'ct-coldoc-lead';
  lead.textContent = t('catalogPage.columns_documented_descriptions_show_as', { expColumnsCount: expColumns.length, documented, p2: (flagged ? t('catalogPage.sensitive', { flagged }) : '') });
  host.appendChild(lead);

  if (!expColumns.length) {
    host.appendChild(makeEmptyState({ variant: 'search', iconName: 'table', title: t('catalogPage.no_columns'), line: t('catalogPage.this_dataset_has_no_columns_to') }));
    return;
  }

  const wrap = document.createElement('div');
  wrap.className = 'ds-quality-table ct-coldoc-table';
  const table = document.createElement('table');
  table.className = 'ds-quality-grid';
  const head = document.createElement('tr');
  [t('common.column'), t('common.type'), t('common.display_name'), t('common.description'), t('common.example'), t('common.sensitivity')].forEach((h) => {
    const th = document.createElement('th');
    th.textContent = h;
    head.appendChild(th);
  });
  const thead = document.createElement('thead');
  thead.appendChild(head);
  table.appendChild(thead);
  const body = document.createElement('tbody');
  expColumns.forEach((col, c) => body.appendChild(ctColumnRow(datasetId, col, c, docs[col.name] || {})));
  table.appendChild(body);
  wrap.appendChild(table);
  host.appendChild(wrap);
}

function ctColumnRow(datasetId: string, col: { name: string; type: string }, c: number, doc: CtColDoc): HTMLElement {
  const tr = document.createElement('tr');
  tr.dataset.column = col.name;
  const name = document.createElement('td');
  name.className = 'dsq-name ct-coldoc-name';
  name.textContent = col.name;
  tr.appendChild(name);
  const type = document.createElement('td');
  const chip = document.createElement('span');
  chip.className = 'dsq-type';
  chip.textContent = col.type;
  type.appendChild(chip);
  tr.appendChild(type);

  const saved: Record<string, string> = {
    displayName: doc.displayName || '', description: doc.description || '', example: doc.example || '',
  };
  const cell = (field: string, placeholder: string, label: string): void => {
    const td = document.createElement('td');
    td.className = 'ct-coldoc-cell ct-coldoc-cell--' + field;
    const box = ctTextBox(field === 'description', saved[field], placeholder, (v) => {
      const next = v.trim();
      if (next === saved[field]) return;
      saved[field] = next;
      void ctSaveColumn(datasetId, col.name, { [field]: next });
    });
    box.classList.add('ct-cell-input');
    if (box instanceof HTMLTextAreaElement) box.rows = 1;
    box.setAttribute('aria-label', `${label} of ${col.name}`);
    td.appendChild(box);
    tr.appendChild(td);
  };
  cell('displayName', col.name, t('common.display_name'));
  cell('description', t('catalogPage.add_a_description'), t('common.description'));
  cell('example', ctFirstValue(c) || '—', t('common.example'));

  const sens = document.createElement('td');
  const sel = document.createElement('select');
  sel.className = 'ct-cell-select';
  sel.setAttribute('aria-label', t('catalogPage.sensitivity_of', { name: col.name }));
  CT_SENSITIVITY.forEach(([v, label, hint]) => {
    const o = document.createElement('option');
    o.value = v;
    o.textContent = label;
    o.title = hint;
    sel.appendChild(o);
  });
  sel.value = doc.sensitivity || 'none';
  sel.dataset.sensitivity = sel.value;
  sel.addEventListener('change', () => {
    sel.dataset.sensitivity = sel.value;
    void ctSaveColumn(datasetId, col.name, { sensitivity: sel.value });
  });
  sens.appendChild(sel);
  tr.appendChild(sens);
  return tr;
}

// ── Boot wiring (once) ──────────────────────────────────────────────────────
(function initCatalogPage(): void {
  const tab = ctPageEl('ds-tab-catalog');
  if (tab) tab.addEventListener('click', () => clSelectTab('catalog'));
  const search = ctPageEl('ct-search') as HTMLInputElement | null;
  if (search) search.addEventListener('input', () => { ctText = search.value; ctPaintCatalog(); });
  const clear = ctPageEl('ct-none-clear');
  if (clear) {
    clear.addEventListener('click', () => {
      ctText = '';
      ctKindFilter = '';
      if (search) search.value = '';
      ctPaintKinds();
      ctSetActiveTag('');
    });
  }
  const importBtn = ctPageEl('ct-empty-import');
  if (importBtn) importBtn.addEventListener('click', () => { clSelectTab('datasets'); (ctPageEl('ds-import-open') as HTMLElement | null)?.click(); });
  initCatalogDetails();
})();
