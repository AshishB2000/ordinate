// Bringing data in: the parsed preview, the paste and file handlers, and saving
// the result as a dataset. The import surface itself is a dialog now
// (dataSection.ts); this is what fills it.
//
// Split verbatim out of datasets.ts — see .claude/rules/file-size.md. Classic
// global-scope renderer <script>: no import/export. Loads AFTER datasets.js,
// which keeps the module-local state every function here reads.

// ── Preview rendering ────────────────────────────────────────────────────────
function clearPreview(): void {
  dsPreview = null;
  dsSourceKind = '';
  dsSuggestedName = '';
  dsFilePath = '';
  const scroll = dsEl('ds-table-scroll');
  if (scroll) scroll.innerHTML = '';
  const warn = dsEl('ds-warnings');
  if (warn) warn.innerHTML = '';
  dsShow('ds-warnings', false);
  dsShow('ds-preview', false);
  dsShow('ds-save-bar', false);
  dsShow('ds-sheet-wrap', false);
  dsShow('ds-explorer', false); // close the saved-dataset explorer if open
  const nameInput = dsEl('ds-name-input') as HTMLInputElement | null;
  if (nameInput) nameInput.value = '';
}

// Fill #ds-warnings, the preview table, the sheet picker, and the save bar from a
// ParseResult. Read-only views (opening a saved dataset) pass showSave=false.
function renderPreview(res: any, showSave: boolean): void {
  dsShow('ds-explorer', false); // an import preview replaces any open explorer
  dsPreview = res || null;
  const columns: any[] = (res && Array.isArray(res.columns)) ? res.columns : [];
  const rows: any[] = (res && Array.isArray(res.rows)) ? res.rows : [];
  const warnings: any[] = (res && Array.isArray(res.warnings)) ? res.warnings : [];
  const rowCount: number = typeof (res && res.rowCount) === 'number' ? res.rowCount : rows.length;

  // Warnings.
  const warnBox = dsEl('ds-warnings');
  if (warnBox) {
    warnBox.innerHTML = '';
    warnings.forEach((w) => {
      const line = document.createElement('div');
      line.className = 'ds-warning';
      line.textContent = String(w);
      warnBox.appendChild(line);
    });
  }
  dsShow('ds-warnings', warnings.length > 0);

  // Sheet picker (xlsx multi-sheet only).
  const sheetNames: string[] = (res && Array.isArray(res.sheetNames)) ? res.sheetNames : [];
  const sheetSel = dsEl('ds-sheet-select') as HTMLSelectElement | null;
  if (sheetSel) {
    sheetSel.innerHTML = '';
    sheetNames.forEach((name) => {
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = name;
      sheetSel.appendChild(opt);
    });
  }
  dsShow('ds-sheet-wrap', sheetNames.length > 1 && !!dsFilePath);

  // Preview table.
  const scroll = dsEl('ds-table-scroll');
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
    const shown = rows.slice(0, DS_PREVIEW_ROWS);
    shown.forEach((row) => {
      const tr = document.createElement('tr');
      const cells: any[] = Array.isArray(row) ? row : [];
      // Pad/truncate to the column count so cells align with headers.
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

  const note = dsEl('ds-preview-note');
  if (note) {
    if (rowCount > DS_PREVIEW_ROWS) {
      note.textContent = 'Showing first ' + DS_PREVIEW_ROWS + ' of ' + rowCount + ' rows';
      note.hidden = false;
    } else {
      note.textContent = '';
      note.hidden = true;
    }
  }
  dsShow('ds-preview', columns.length > 0 || warnings.length === 0);

  // Save bar (hidden for read-only views).
  const nameInput = dsEl('ds-name-input') as HTMLInputElement | null;
  if (nameInput && showSave) nameInput.value = dsSuggestedName || '';
  dsShow('ds-save-bar', showSave && columns.length > 0);
}

// ── Import / paste handlers ──────────────────────────────────────────────────
async function handleImportFile(): Promise<void> {
  let res: any;
  try {
    res = await window.hub.pickAndParseDataset();
  } catch (_) {
    return;
  }
  if (!res || res.canceled) return;
  if (!res.ok) {
    window.alert(res.error || 'Could not read that file.');
    return;
  }
  dsSourceKind = String(res.sourceKind || 'csv');
  dsSuggestedName = defaultNameFrom(res.fileName);
  dsFilePath = typeof res.filePath === 'string' ? res.filePath : '';
  renderPreview(res.preview, true);
}

async function handleSheetChange(): Promise<void> {
  if (!dsFilePath) return;
  const sel = dsEl('ds-sheet-select') as HTMLSelectElement | null;
  if (!sel) return;
  let res: any;
  try {
    res = await window.hub.pickAndParseDataset(sel.value, dsFilePath);
  } catch (_) {
    return;
  }
  if (!res || !res.ok || res.canceled) return;
  renderPreview(res.preview, true);
}

async function handleParsePaste(): Promise<void> {
  const input = dsEl('ds-paste-input') as HTMLTextAreaElement | null;
  const text = input ? input.value : '';
  let res: any;
  try {
    res = await window.hub.parsePasteDataset(text);
  } catch (_) {
    return;
  }
  if (!res || !res.ok) {
    window.alert((res && res.error) || 'Could not parse the pasted text.');
    return;
  }
  dsSourceKind = 'paste';
  dsSuggestedName = 'Pasted data';
  dsFilePath = '';
  renderPreview(res.preview, true);
}

// The sheet the preview is currently showing, for an xlsx import. Undefined for
// csv/json (and for a single-sheet workbook, where the picker is hidden), so a
// stored origin only names a sheet when one was actually chosen.
function dsChosenSheet(): string | undefined {
  const sel = dsEl('ds-sheet-select') as HTMLSelectElement | null;
  const wrap = dsEl('ds-sheet-wrap');
  if (!sel || !wrap || wrap.hidden || !sel.value) return undefined;
  return sel.value;
}

// Strip the extension from a picked file name for the default dataset name.
function defaultNameFrom(fileName: any): string {
  const base = typeof fileName === 'string' ? fileName : '';
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
}

// ── Save ─────────────────────────────────────────────────────────────────────
async function handleSaveDataset(): Promise<void> {
  if (!currentProjectId) {
    window.alert('Open a project first.');
    return;
  }
  if (!dsPreview || !Array.isArray(dsPreview.columns) || dsPreview.columns.length === 0) return;
  const nameInput = dsEl('ds-name-input') as HTMLInputElement | null;
  const name = (nameInput && nameInput.value.trim()) || dsSuggestedName || 'Untitled dataset';
  let res: any;
  try {
    res = await window.hub.saveDataset({
      projectId: currentProjectId,
      name,
      sourceKind: dsSourceKind || 'csv',
      columns: dsPreview.columns,
      rows: dsPreview.rows,
      // A file import records WHERE it came from so it can be re-read later.
      // Pasted text gets none — there is nothing to re-fetch. The path came from
      // main's own open dialog, and main re-whitelists it before storing.
      origin: dsFilePath ? { kind: 'file', path: dsFilePath, sheetName: dsChosenSheet() } : undefined,
    });
  } catch (_) {
    window.alert('Failed to save the dataset.');
    return;
  }
  if (res && res.ok === false) {
    window.alert(res.error || 'Failed to save the dataset.');
    return;
  }
  clearPreview();
  const pasteInput = dsEl('ds-paste-input') as HTMLTextAreaElement | null;
  if (pasteInput) pasteInput.value = '';
  dsShow('ds-paste-wrap', false);
  await refreshDatasetList();
}

