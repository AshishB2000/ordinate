// The Query tab's PARAMETERS ROW: one typed field per `[[name]]` in the SQL.
//
// Classic global-scope renderer <script>: no import/export. Split out of
// queryTab.ts (file-size.md); loads before it. It only COLLECTS values —
// main binds them (src/analysis/params.ts) and nothing here ever splices a
// value into SQL text.

interface QtParamEntry { kind: string; value: string }

let qtParamsTimer = 0;
/** What the user typed into each parameter, kept by name across edits. */
const qtParamState = new Map<string, QtParamEntry>();

// ── Parameters ───────────────────────────────────────────────────────────────

/** Called on every edit: repaint the parameters row (debounced), invalidate Save. */
function qtOnSqlChanged(): void {
  // A saved dataset must be the result the user SAW; an edit since the last
  // Run means they have not seen it.
  const save = qtEl('qt-save') as HTMLButtonElement | null;
  if (save) save.disabled = true;
  if (qtParamsTimer) window.clearTimeout(qtParamsTimer);
  qtParamsTimer = window.setTimeout(qtRenderParams, 150);
}

/** A first guess at a new parameter's type, from its name. The user can change it. */
function qtGuessKind(name: string): string {
  if (/date|day|from|since|until|start|end/i.test(name)) return 'date';
  if (/^(min|max|limit|top|n)$|min_|max_|_min|_max|threshold|amount|count/i.test(name)) return 'number';
  if (/s$|_list|_ids?$/i.test(name) && name.length > 3) return 'list';
  return 'text';
}

function qtRenderParams(): void {
  qtParamsTimer = 0;
  const wrap = qtEl('qt-params');
  const list = qtEl('qt-params-list');
  if (!wrap || !list) return;
  const names = qeScan(qeGetSql()).params;
  wrap.hidden = names.length === 0;
  // Rebuild only when the SET of names changed — never under the user's typing.
  if (list.dataset.names === names.join(',')) return;
  list.dataset.names = names.join(',');
  list.innerHTML = '';
  for (const n of names) {
    if (!qtParamState.has(n)) qtParamState.set(n, { kind: qtGuessKind(n), value: '' });
    list.appendChild(qtParamField(n, qtParamState.get(n) as QtParamEntry));
  }
}

function qtParamField(name: string, st: QtParamEntry): HTMLElement {
  const field = document.createElement('div');
  field.className = 'qt-param';
  const label = document.createElement('span');
  label.className = 'qt-param-name';
  label.textContent = name;

  const kind = document.createElement('select');
  kind.className = 'conn-input qt-param-kind';
  kind.setAttribute('aria-label', `Type of ${name}`);
  for (const [v, l] of [['text', 'Text'], ['number', 'Number'], ['date', 'Date'], ['list', 'List']]) {
    const o = document.createElement('option');
    o.value = v;
    o.textContent = l;
    kind.appendChild(o);
  }
  kind.value = st.kind;

  const value = document.createElement('input');
  value.className = 'conn-input qt-param-value';
  value.setAttribute('aria-label', `Value of ${name}`);
  const shape = (): void => {
    value.type = st.kind === 'number' ? 'number' : st.kind === 'date' ? 'date' : 'text';
    value.placeholder = st.kind === 'list' ? 'a, b, c' : st.kind === 'number' ? '0' : st.kind === 'date' ? '' : 'value';
  };
  shape();
  value.value = st.value;
  kind.addEventListener('change', () => { st.kind = kind.value; shape(); value.value = ''; st.value = ''; });
  value.addEventListener('input', () => {
    st.value = value.value;
    // Same rule as an SQL edit: Save keeps the result the user last SAW.
    const save = qtEl('qt-save') as HTMLButtonElement | null;
    if (save) save.disabled = true;
  });
  value.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); void qtRun(); }
  });
  field.append(label, kind, value);
  return field;
}

/** The parameters the SQL uses, typed for main — or the first one that is missing a value. */
function qtCollectParams(sql: string): { params: any[]; error: string } {
  const params: any[] = [];
  for (const name of qeScan(sql).params) {
    const st = qtParamState.get(name) || { kind: qtGuessKind(name), value: '' };
    const raw = st.value.trim();
    if (st.kind === 'list') {
      // Always TEXT elements: DuckDB casts a text value to a number column's
      // type, but a number against a text column is a conversion error.
      params.push({ name, kind: 'list', value: raw ? raw.split(',').map((s) => s.trim()).filter(Boolean) : [] });
      continue;
    }
    if (!raw && st.kind !== 'text') return { params, error: `Give [[${name}]] a value in the parameters row.` };
    params.push({ name, kind: st.kind, value: st.kind === 'number' ? Number(raw) : raw });
  }
  return { params, error: '' };
}
