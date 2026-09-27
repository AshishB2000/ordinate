'use strict';

// NEW DATASET → INPUT TABLE, and EDIT COLUMNS — one dialog for defining an input
// table's columns (name, type, required, lookup), and the doors into it.
// Classic global-scope renderer <script>: no import/export.
//
// Doors: the Data section's "Input table" action beside Import / Paste, the
// empty Data list's "Type a table", and the palette's "New dataset: input
// table". Each opens this dialog; Create writes an ordinary dataset
// (`sourceKind: 'input'`) through main and opens it on its grid.
//
// A LOOKUP names another dataset's column; its values become the cell's
// dropdown, and anything else typed there is flagged. The column's type follows
// the key's, so the two always compare. Main re-checks every definition — the
// checks here only shape the form. Shell, focus trap and Escape are the shared
// `.ws-modal` + `makeModalAccessible`; fields are the metric editor's `meField`.

interface ItColDraft {
  name: string;
  type: string;
  required: boolean;
  lookup: { datasetId: string; column: string } | null;
  /** The column this one was in the saved table, or -1 for a new one (Edit columns). */
  from: number;
}

const IT_TEMPLATES: Array<{ id: string; label: string; hint: string; columns: Array<Partial<ItColDraft>> }> = [
  { id: 'Targets', label: 'Targets', hint: 'A goal per region and month', columns: [
    { name: 'region', type: 'text', required: true }, { name: 'month', type: 'date' }, { name: 'target', type: 'number', required: true },
  ] },
  { id: 'Budget', label: 'Budget', hint: 'Planned spend by department', columns: [
    { name: 'department', type: 'text', required: true }, { name: 'month', type: 'date' },
    { name: 'amount', type: 'number', required: true }, { name: 'owner', type: 'text' },
  ] },
  { id: 'Mapping', label: 'Mapping', hint: 'Translate one code to another', columns: [
    { name: 'from', type: 'text', required: true }, { name: 'to', type: 'text', required: true },
  ] },
  { id: 'Notes', label: 'Notes', hint: 'Dated notes to annotate charts', columns: [
    { name: 'date', type: 'date', required: true }, { name: 'note', type: 'text' },
  ] },
];

/** Every other dataset's columns, for the lookup pickers. */
async function itLookupChoices(selfId: string): Promise<Array<{ id: string; name: string; columns: any[] }>> {
  if (!currentProjectId) return [];
  let list: any[] = [];
  try { list = await window.hub.listDatasets(currentProjectId); } catch (_) { list = []; }
  const out: Array<{ id: string; name: string; columns: any[] }> = [];
  for (const d of (Array.isArray(list) ? list : []).filter((x: any) => x && x.id !== selfId)) {
    let meta: any = null;
    try { meta = await window.hub.getDatasetMeta(currentProjectId, String(d.id)); } catch (_) { meta = null; }
    if (meta && Array.isArray(meta.columns) && meta.columns.length) out.push({ id: String(d.id), name: String(d.name || 'Untitled dataset'), columns: meta.columns });
  }
  return out;
}

/**
 * Open the dialog. `create` resolves with `{ ok, id }` of the new table; `edit`
 * with main's reply to the column change (the reloaded table). Null when
 * cancelled. A refused save is shown IN the dialog, with the work kept.
 */
function itColumnsDialog(opts: { mode: 'create' | 'edit'; name?: string; columns?: any[]; datasetId?: string }): Promise<any> {
  return new Promise((resolve) => {
    const creating = opts.mode === 'create';
    let done = false;
    let a11y: { onTabKey: (e: KeyboardEvent) => void; release: () => void } | null = null;
    let choices: Array<{ id: string; name: string; columns: any[] }> = [];
    let drafts: ItColDraft[] = (opts.columns || []).map((c: any, i: number) => ({
      name: String(c.name || ''), type: String(c.type || 'text'), required: !!c.required,
      lookup: c.lookup ? { datasetId: String(c.lookup.datasetId), column: String(c.lookup.column) } : null, from: i,
    }));

    const overlay = itMk('div', 'ws-modal-overlay');
    const box = itMk('div', 'ws-modal it-modal');
    const title = creating ? 'New input table' : 'Edit columns';
    box.appendChild(itMk('div', 'ws-modal-title', title));
    box.appendChild(itMk('p', 'it-modal-sub', creating
      ? 'A small table you type into Ordinate — targets, budgets, mappings, notes. Up to 10,000 rows, saved as an ordinary dataset that metrics, relationships and alerts use like any other.'
      : 'Rename, retype or add columns. Values move with their column; anything a new type cannot hold is kept and flagged, and the previous layout stays in History.'));

    const nameInput = itMk<HTMLInputElement>('input', 'ws-modal-input');
    nameInput.type = 'text';
    nameInput.placeholder = 'e.g. Regional targets';
    nameInput.value = opts.name || '';
    nameInput.maxLength = 120;
    if (creating) box.appendChild(meField('Name', nameInput));

    if (creating) {
      const tiles = itMk('div', 'it-templates');
      tiles.setAttribute('role', 'group');
      tiles.setAttribute('aria-label', 'Start from');
      for (const t of IT_TEMPLATES) {
        const b = itMk<HTMLButtonElement>('button', 'dc-kind-tile it-template');
        b.type = 'button';
        b.append(itMk('span', 'dc-kind-tile-label', t.label), itMk('span', 'dc-kind-tile-hint', t.hint));
        b.addEventListener('click', () => {
          drafts = t.columns.map((c) => ({ name: String(c.name), type: String(c.type), required: !!c.required, lookup: null, from: -1 }));
          if (!nameInput.value.trim()) nameInput.value = t.id;
          paint();
          tiles.querySelectorAll('.it-template').forEach((x) => x.classList.toggle('is-on', x === b));
        });
        tiles.appendChild(b);
      }
      box.appendChild(meField('Start from', tiles));
    }

    const colsHead = itMk('div', 'it-cols-head');
    ['Column', 'Type', 'Required', 'Values from', ''].forEach((t) => colsHead.appendChild(itMk('span', '', t)));
    const list = itMk('div', 'it-cols');
    list.setAttribute('role', 'list');
    list.setAttribute('aria-label', 'Columns');
    const add = itMk<HTMLButtonElement>('button', 'btn btn-sm btn-ghost it-add-col');
    add.type = 'button';
    iconLabel(add, 'plus', 'Add column');
    const warn = itMk('p', 'it-modal-warn');
    warn.hidden = true;
    const err = itMk('p', 'it-modal-err');
    err.setAttribute('role', 'alert');
    err.hidden = true;
    box.append(colsHead, list, add, warn, err);

    const actions = itMk('div', 'ws-modal-actions');
    const cancel = itMk<HTMLButtonElement>('button', 'btn btn-ghost', 'Cancel');
    cancel.type = 'button';
    const save = itMk<HTMLButtonElement>('button', 'btn btn-primary', creating ? 'Create table' : 'Save columns');
    save.type = 'button';
    actions.append(cancel, save);
    box.appendChild(actions);

    const keyType = (lk: { datasetId: string; column: string }): string | null => {
      const d = choices.find((x) => x.id === lk.datasetId);
      const col = d && d.columns.find((c: any) => c && c.name === lk.column);
      return col ? String(col.type) : null;
    };

    function row(d: ItColDraft, i: number): HTMLElement {
      const r = itMk('div', 'it-col-row');
      r.setAttribute('role', 'listitem');
      const n = i + 1;
      const name = itMk<HTMLInputElement>('input', 'ws-modal-input it-col-name');
      name.type = 'text';
      name.value = d.name;
      name.maxLength = 100;
      name.placeholder = `column${n}`;
      name.setAttribute('aria-label', `Column ${n} name`);
      name.addEventListener('input', () => { d.name = name.value; });
      const type = itMk<HTMLSelectElement>('select', 'ws-modal-input it-col-type');
      type.setAttribute('aria-label', `Column ${n} type`);
      [['text', 'Text'], ['number', 'Number'], ['date', 'Date']].forEach(([v, t]) => {
        const o = itMk<HTMLOptionElement>('option', '', t);
        o.value = v;
        type.appendChild(o);
      });
      type.value = d.type;
      type.addEventListener('change', () => { d.type = type.value; });
      const req = itMk<HTMLLabelElement>('label', 'it-col-req');
      const box2 = itMk<HTMLInputElement>('input');
      box2.type = 'checkbox';
      box2.checked = d.required;
      box2.setAttribute('aria-label', `Column ${n} required`);
      box2.addEventListener('change', () => { d.required = box2.checked; });
      req.append(box2, itMk('span', '', 'Required'));
      const lk = itMk<HTMLSelectElement>('select', 'ws-modal-input it-col-lookup');
      lk.setAttribute('aria-label', `Column ${n} values from another dataset`);
      const none = itMk<HTMLOptionElement>('option', '', 'Any value');
      none.value = '';
      lk.appendChild(none);
      for (const c of choices) {
        const g = document.createElement('optgroup');
        g.label = c.name;
        for (const col of c.columns) {
          const o = itMk<HTMLOptionElement>('option', '', `${c.name} · ${col.name}`);
          o.value = JSON.stringify([c.id, String(col.name)]);
          g.appendChild(o);
        }
        lk.appendChild(g);
      }
      lk.value = d.lookup ? JSON.stringify([d.lookup.datasetId, d.lookup.column]) : '';
      const syncType = (): void => {
        const kt = d.lookup ? keyType(d.lookup) : null;
        if (kt) { d.type = kt; type.value = kt; }
        type.disabled = !!kt;
        type.title = kt ? 'Follows the type of the column it looks up' : '';
      };
      lk.addEventListener('change', () => {
        let pair: any = null;
        try { pair = lk.value ? JSON.parse(lk.value) : null; } catch (_) { pair = null; }
        d.lookup = Array.isArray(pair) ? { datasetId: String(pair[0]), column: String(pair[1]) } : null;
        syncType();
      });
      syncType();
      const x = itMk<HTMLButtonElement>('button', 'btn btn-sm btn-ghost it-col-x');
      x.type = 'button';
      iconOnly(x, 'trash', `Remove column ${n}`);
      x.addEventListener('click', () => { drafts.splice(i, 1); paint(); });
      r.append(name, type, req, lk, x);
      return r;
    }

    function paint(): void {
      list.textContent = '';
      colsHead.hidden = drafts.length === 0;
      if (!drafts.length) {
        list.appendChild(makeEmptyState({
          variant: 'columns',
          iconName: 'table',
          title: 'Define your columns',
          line: 'Pick a starting point above, or add columns one by one — a name, a type, and whether it is required or takes its values from another dataset.',
          actionLabel: 'Add column',
          onAction: () => { addColumn(); },
        }));
      }
      drafts.forEach((d, i) => list.appendChild(row(d, i)));
      const removed = (opts.columns || []).length - drafts.filter((d) => d.from >= 0).length;
      warn.textContent = removed > 0 ? `Removing ${removed === 1 ? 'a column deletes its values' : removed + ' columns deletes their values'} — the table before this change stays in History.` : '';
      warn.hidden = removed <= 0;
    }

    function addColumn(): void {
      drafts.push({ name: '', type: 'text', required: false, lookup: null, from: -1 });
      paint();
      const names = list.querySelectorAll<HTMLInputElement>('.it-col-name');
      if (names.length) names[names.length - 1].focus();
    }
    add.addEventListener('click', addColumn);

    const finish = (value: any): void => {
      if (done) return;
      done = true;
      if (a11y) a11y.release();
      overlay.remove();
      resolve(value);
    };
    cancel.addEventListener('click', () => finish(null));
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) finish(null); });
    box.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); finish(null); return; }
      if (a11y) a11y.onTabKey(e);
    });
    save.addEventListener('click', async () => {
      err.hidden = true;
      if (!currentProjectId) return;
      const columns = drafts.map((d) => {
        const c: any = { name: d.name.trim(), type: d.type };
        if (d.required) c.required = true;
        if (d.lookup) c.lookup = d.lookup;
        return c;
      });
      save.disabled = true;
      let res: any;
      try {
        res = creating
          ? await window.hubInput.create(currentProjectId, nameInput.value.trim(), columns)
          : await window.hubInput.setColumns(currentProjectId, String(opts.datasetId), columns, drafts.map((d) => d.from));
      } catch (e: any) {
        res = { ok: false, error: (e && e.message) || 'Could not save' };
      }
      save.disabled = false;
      if (!res || !res.ok) {
        err.textContent = (res && res.error) || 'Could not save the columns.';
        err.hidden = false;
        return;
      }
      finish(res);
    });

    overlay.appendChild(box);
    document.body.appendChild(overlay);
    paint();
    a11y = makeModalAccessible(box, title, creating ? nameInput : (list.querySelector('.it-col-name') as HTMLElement | null));
    void itLookupChoices(opts.datasetId || '').then((c) => {
      if (done) return;
      choices = c;
      paint();
    });
  });
}

// ── History and Edit columns ─────────────────────────────────────────────────

async function itOpenHistory(): Promise<void> {
  const s = itS;
  if (!s) return;
  await itFlush();
  if (spIsOpen('history') && vhState && vhState.id === s.id) { spClose(); return; }
  await vhOpen('dataset', s.id, s.name, 'Table');
}

async function itEditColumns(): Promise<void> {
  const s = itS;
  if (!s) return;
  itCancelEdit();
  await itFlush();
  if (s.pending.length || s.error) { showToast('Save the table first — ' + (s.error || 'edits are still being saved'), { kind: 'error' }); return; }
  const res = await itColumnsDialog({ mode: 'edit', name: s.name, columns: s.columns, datasetId: s.id });
  if (!res || itS !== s) return;
  itAdopt(res, true);
  s.hist = OrdInputEdits.histNew(); // cell positions moved with the columns
  s.sel = { r0: 0, c0: 0, r1: 0, c1: 0 };
  itRender();
  itPaintBar();
  showToast('Columns saved — the previous layout is in History');
  if (typeof expId === 'string' && expId === s.id) void openSavedDataset(s.id);
}

/** New dataset → Input table: define it, create it, land on its grid ready to type. */
async function itNewInputTable(): Promise<void> {
  if (!currentProjectId) { showToast('Open a project first.'); return; }
  const res = await itColumnsDialog({ mode: 'create' });
  if (!res || !res.ok) return;
  if (currentSection !== 'datasets') selectSection('datasets');
  await refreshDatasetList();
  await openSavedDataset(String(res.id));
  itFocusGrid();
  showToast('Input table created — type or paste your rows');
}

// The doors, built at load beside the ones they sit with.
(function itMountDoors(): void {
  const paste = document.getElementById('ds-paste-open');
  if (paste && !document.getElementById('ds-input-open')) {
    const b = itMk<HTMLButtonElement>('button', 'btn btn-ghost');
    b.type = 'button';
    b.id = 'ds-input-open';
    iconLabel(b, 'table', 'Input table');
    b.title = 'New dataset you type in — targets, budgets, mappings, notes';
    b.addEventListener('click', () => { void itNewInputTable(); });
    paste.after(b);
  }
  const emptyActions = document.querySelector('#ds-saved-empty .ws-empty-actions');
  if (emptyActions && !document.getElementById('ds-empty-input')) {
    const b = itMk<HTMLButtonElement>('button', 'btn btn-ghost', 'Type a table');
    b.type = 'button';
    b.id = 'ds-empty-input';
    b.addEventListener('click', () => { void itNewInputTable(); });
    emptyActions.appendChild(b);
  }
  registerCommand({
    id: 'create.input', title: 'New dataset: input table', group: 'Create', icon: 'table',
    when: () => !!currentProjectId, run: () => itNewInputTable(),
  });
})();
