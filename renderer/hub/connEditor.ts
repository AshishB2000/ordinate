// The workbench's SQL editor: the highlight layer, autocomplete, Run / Explain,
// and the saved-query library.
//
// Classic global-scope renderer <script>: no import/export. Loads after
// connWorkbench.js, whose panes it fills and whose `cw*` state (in
// connections.ts) it reads.
//
// ── The highlight layer ──────────────────────────────────────────────────────
//
// The same mirrored-<pre> technique formulaEditor.ts uses, reproduced rather
// than shared: a <pre> sits behind a transparent-text <textarea>, painting the
// same string with spans, and the two are pinned to identical font, size,
// padding and wrapping by `.cw-input, .cw-hl` being ONE CSS rule. If those ever
// diverge the colours slide out from under the characters — which is why they
// are one rule and not two that look alike.
//
// WHY COPIED AND NOT IMPORTED. formulaEditor's version is a projection of a
// TOKEN STREAM that main returns from `formula:check`, because the formula
// language has one compiler and a second opinion in the renderer would show a
// green preview for an expression the pipeline then skips. SQL here has no such
// authority: there are six dialects, the statement is the user's own, and
// nothing in the renderer is entitled to an opinion about whether it is valid —
// `Explain` asks the SERVER that. So this tokenizer is a purely COSMETIC
// lexer over five obvious shapes, with no verdict attached, and sharing code
// with a semantic highlighter would imply one.
//
// No editor library: the whole feature is a per-character class array.
// CodeMirror is 400 KB.

// ── The keyword set ──────────────────────────────────────────────────────────
//
// Deliberately the COMMON core, not any one dialect's reserved-word list: this
// drives a colour and a completion list, and a word that is a keyword in
// Postgres but a column name in MySQL costs nothing by being offered.
const CW_KEYWORDS: readonly string[] = [
  'select', 'from', 'where', 'group', 'by', 'order', 'having', 'limit', 'offset',
  'join', 'inner', 'left', 'right', 'full', 'outer', 'cross', 'on', 'using',
  'as', 'and', 'or', 'not', 'in', 'is', 'null', 'like', 'ilike', 'between',
  'case', 'when', 'then', 'else', 'end', 'distinct', 'union', 'all', 'with',
  'asc', 'desc', 'count', 'sum', 'avg', 'min', 'max', 'cast', 'coalesce',
  'over', 'partition', 'exists', 'any', 'true', 'false',
];
const CW_KEYWORD_SET: ReadonlySet<string> = new Set(CW_KEYWORDS);

/** How many completions the popover shows. More than this is a list to read,
 *  not a list to pick from. */
const CW_AC_MAX = 8;

/** Autocomplete state: the visible items and which one the keyboard is on. */
let cwAcItems: { text: string; kind: string; sub: string }[] = [];
let cwAcIndex = -1;
/** Where in the text the token being completed starts, so accepting replaces
 *  the partial word rather than appending to it. */
let cwAcFrom = -1;

function cwEsc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ── The cosmetic lexer ───────────────────────────────────────────────────────

interface CwToken { start: number; end: number; cls: string }

/**
 * Five shapes, scanned once: string literals, line and block comments, numbers,
 * quoted identifiers, and bare words (a keyword or an identifier).
 *
 * Strings and comments are consumed as whole spans BEFORE anything else looks
 * at their contents, so `-- select from x` and `'it''s'` colour as one thing
 * each instead of as the keywords they happen to contain. An unterminated
 * string runs to end-of-input, which is correct WHILE TYPING — the alternative
 * is the rest of the statement flickering as each quote is typed.
 */
function cwTokenize(src: string): CwToken[] {
  const out: CwToken[] = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const ch = src[i];

    if (ch === '-' && src[i + 1] === '-') {
      const end = src.indexOf('\n', i);
      out.push({ start: i, end: end < 0 ? n : end, cls: 'cw-t-com' });
      i = end < 0 ? n : end;
      continue;
    }
    if (ch === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      out.push({ start: i, end: end < 0 ? n : end + 2, cls: 'cw-t-com' });
      i = end < 0 ? n : end + 2;
      continue;
    }
    if (ch === "'") {
      let j = i + 1;
      // '' is an escaped quote inside a literal, in every dialect here.
      while (j < n) {
        if (src[j] === "'" && src[j + 1] === "'") { j += 2; continue; }
        if (src[j] === "'") { j += 1; break; }
        j += 1;
      }
      out.push({ start: i, end: j, cls: 'cw-t-str' });
      i = j;
      continue;
    }
    if (ch === '"' || ch === '`' || ch === '[') {
      const close = ch === '[' ? ']' : ch;
      let j = i + 1;
      while (j < n && src[j] !== close) j += 1;
      out.push({ start: i, end: Math.min(n, j + 1), cls: 'cw-t-id' });
      i = Math.min(n, j + 1);
      continue;
    }
    if (ch >= '0' && ch <= '9') {
      let j = i;
      while (j < n && /[0-9._]/.test(src[j])) j += 1;
      out.push({ start: i, end: j, cls: 'cw-t-num' });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < n && /[A-Za-z0-9_$]/.test(src[j])) j += 1;
      const word = src.slice(i, j).toLowerCase();
      if (CW_KEYWORD_SET.has(word)) out.push({ start: i, end: j, cls: 'cw-t-kw' });
      i = j;
      continue;
    }
    i += 1;
  }
  return out;
}

/**
 * The highlighted source, as HTML for the mirror <pre>.
 *
 * Built from a per-CHARACTER class array and then coalesced into spans, the
 * same way formulaEditor does, so overlapping ranges are just two classes on
 * one character rather than nested or hand-split spans.
 *
 * The trailing newline is load-bearing: a <pre> does not render a final empty
 * line, so without it the mirror is one line short of the textarea the moment
 * the statement ends in a line break, and every colour below sits too high.
 */
function cwHighlightHtml(src: string): string {
  const cls: string[] = new Array(src.length).fill('');
  for (const tok of cwTokenize(src)) {
    for (let i = Math.max(0, tok.start); i < Math.min(src.length, tok.end); i += 1) cls[i] = tok.cls;
  }
  let html = '';
  let i = 0;
  while (i < src.length) {
    let j = i;
    while (j < src.length && cls[j] === cls[i]) j += 1;
    const text = cwEsc(src.slice(i, j));
    html += cls[i] ? '<span class="' + cls[i] + '">' + text + '</span>' : text;
    i = j;
  }
  return html + '\n';
}

function cwPaintHighlight(): void {
  const input = connEl('conn-wb-sql') as HTMLTextAreaElement | null;
  const mirror = connEl('conn-wb-hl');
  if (!input || !mirror) return;
  mirror.innerHTML = cwHighlightHtml(input.value);
  mirror.scrollTop = input.scrollTop;
  mirror.scrollLeft = input.scrollLeft;
}

/** Replace the editor's contents and repaint. */
function cwSetSql(sql: string): void {
  const input = connEl('conn-wb-sql') as HTMLTextAreaElement | null;
  if (!input) return;
  input.value = sql || '';
  cwPaintHighlight();
}

function cwGetSql(): string {
  const input = connEl('conn-wb-sql') as HTMLTextAreaElement | null;
  return input ? input.value : '';
}

// ── Autocomplete ─────────────────────────────────────────────────────────────

/**
 * The vocabulary: the tree's tables, every column of every table already
 * described, and the common keywords.
 *
 * Columns come from `cwColumns`, which is filled as the tree is expanded and
 * whenever a table is selected — so the columns a user is actually working with
 * are the ones offered. Nothing here fetches: a keystroke must not open a
 * socket, and an editor that stalls mid-word is worse than one that completes
 * less.
 */
function cwCompletions(prefix: string): { text: string; kind: string; sub: string }[] {
  const q = prefix.toLowerCase();
  if (!q) return [];
  const out: { text: string; kind: string; sub: string }[] = [];
  const seen = new Set<string>();
  const take = (text: string, kind: string, sub: string): void => {
    const key = kind + ' ' + text;
    if (!text || seen.has(key)) return;
    if (!text.toLowerCase().startsWith(q)) return;
    seen.add(key);
    out.push({ text, kind, sub });
  };

  // Tables first, then columns, then keywords: in a schema browser the thing
  // being named is almost always the data, and a keyword is three characters
  // the user can finish themselves.
  for (const tv of cwTables) take(cwQualify(tv), 'table', tv.schema ? t('connEditor.table_in', { schema: tv.schema }) : 'table');
  for (const [table, cols] of cwColumns) for (const c of cols) take(c, 'column', table);
  for (const k of CW_KEYWORDS) take(k.toUpperCase(), 'keyword', '');
  return out.slice(0, CW_AC_MAX);
}

/** The bare word immediately before the caret, and where it starts. */
function cwWordBeforeCaret(): { word: string; from: number } {
  const input = connEl('conn-wb-sql') as HTMLTextAreaElement | null;
  if (!input) return { word: '', from: -1 };
  const caret = input.selectionStart ?? 0;
  const text = input.value.slice(0, caret);
  const m = /[A-Za-z_][A-Za-z0-9_$.]*$/.exec(text);
  if (!m) return { word: '', from: -1 };
  return { word: m[0], from: caret - m[0].length };
}

function cwRefreshAutocomplete(): void {
  const { word, from } = cwWordBeforeCaret();
  if (word.length < 2) { cwCloseAutocomplete(); return; }
  cwAcItems = cwCompletions(word);
  cwAcFrom = from;
  // An exact single match is nothing left to choose.
  if (cwAcItems.length === 0 || (cwAcItems.length === 1 && cwAcItems[0].text.toLowerCase() === word.toLowerCase())) {
    cwCloseAutocomplete();
    return;
  }
  cwAcIndex = 0;
  cwPaintAutocomplete();
}

function cwPaintAutocomplete(): void {
  const pop = connEl('conn-wb-ac');
  if (!pop) return;
  pop.innerHTML = '';
  cwAcItems.forEach((item, i) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'cw-ac-item' + (i === cwAcIndex ? ' is-on' : '');
    btn.setAttribute('role', 'option');
    btn.setAttribute('aria-selected', String(i === cwAcIndex));
    const label = document.createElement('span');
    label.className = 'cw-ac-label';
    label.textContent = item.text;
    btn.appendChild(label);
    const sub = document.createElement('span');
    sub.className = 'cw-ac-sub';
    sub.textContent = item.sub || item.kind;
    btn.appendChild(sub);
    // mousedown, not click: the textarea's blur would close the popover first.
    btn.addEventListener('mousedown', (e) => { e.preventDefault(); cwAcceptCompletion(i); });
    pop.appendChild(btn);
  });
  pop.hidden = cwAcItems.length === 0;
}

function cwCloseAutocomplete(): void {
  cwAcItems = [];
  cwAcIndex = -1;
  cwAcFrom = -1;
  const pop = connEl('conn-wb-ac');
  if (pop) { pop.hidden = true; pop.innerHTML = ''; }
}

function cwAcceptCompletion(i: number): void {
  const input = connEl('conn-wb-sql') as HTMLTextAreaElement | null;
  const item = cwAcItems[i];
  if (!input || !item || cwAcFrom < 0) return;
  const caret = input.selectionStart ?? 0;
  // A table or column goes in QUOTED, the way the tree's drag does — that is
  // the form that works for a name with a space, a hyphen or a reserved word,
  // and it is the same text either route produces.
  const insert = item.kind === 'keyword' ? item.text : cwQuote(item.text);
  input.value = input.value.slice(0, cwAcFrom) + insert + input.value.slice(caret);
  const at = cwAcFrom + insert.length;
  input.setSelectionRange(at, at);
  cwCloseAutocomplete();
  cwPaintHighlight();
  input.focus();
}

// ── Run / Explain ────────────────────────────────────────────────────────────

function cwSetMessage(text: string, isError: boolean, columns?: any[]): void {
  const row = connEl('conn-wb-msg-row');
  const msg = connEl('conn-wb-msg');
  const cols = connEl('conn-wb-cols');
  if (msg) {
    msg.textContent = text || '';
    msg.classList.toggle('is-error', !!isError);
  }
  if (cols) {
    cols.innerHTML = '';
    for (const c of columns || []) {
      const chip = document.createElement('span');
      chip.className = 'cw-col-chip';
      const name = document.createElement('span');
      name.className = 'cw-col-chip-name';
      name.textContent = String((c && c.name) || '');
      chip.appendChild(name);
      const type = document.createElement('span');
      type.className = 'cw-col-chip-type';
      type.textContent = String((c && c.type) || '');
      chip.appendChild(type);
      cols.appendChild(chip);
    }
  }
  if (row) row.hidden = !text && !(columns && columns.length);
}

/** Run the editor's statement, bounded to the 500-row preview. The import row
 *  limit is a separate choice and only applies at "Save as dataset". */
async function cwRunQuery(): Promise<void> {
  if (!cwConn) return;
  const sql = cwGetSql().trim();
  if (!sql) { cwSetMessage(t('common.write_a_query_first'), true); return; }
  cwSetError('');
  cwSetMessage(t('common.running'), false);
  const btn = connEl('conn-wb-run') as HTMLButtonElement | null;
  if (btn) btn.disabled = true;

  let res: any;
  try {
    res = await window.hub.runConnection(
      currentProjectId, String(cwConn.id), { query: sql }, CONN_PREVIEW_ROWS,
    );
  } catch (_) {
    res = { ok: false, error: t('connEditor.could_not_run_the_query') };
  }
  if (btn) btn.disabled = false;
  if (!cwConn) return;

  if (!res || res.ok === false) {
    // The dialect's own message, inline, where the query is — not a toast that
    // is gone before it has been read.
    cwSetMessage((res && res.error) || t('connEditor.could_not_run_the_query'), true);
    return;
  }
  cwSetMessage('', false);
  // A run deselects the tree: the grid is now showing the query's rows, and a
  // highlighted table row would claim otherwise.
  cwTable = '';
  document.querySelectorAll('.cw-row-table.is-on').forEach((el) => el.classList.remove('is-on'));
  cwShowResult(res.preview, { table: '', sql, name: cwQueryName() || t('common.query_result') });
}

/** Check the statement and report the columns it WOULD produce. No rows. */
async function cwExplainQuery(): Promise<void> {
  if (!cwConn) return;
  const sql = cwGetSql().trim();
  if (!sql) { cwSetMessage(t('common.write_a_query_first'), true); return; }
  cwSetError('');
  cwSetMessage(t('common.checking'), false);
  const btn = connEl('conn-wb-explain') as HTMLButtonElement | null;
  if (btn) btn.disabled = true;

  let res: any;
  try {
    res = await window.hub.explainConnectionSql(currentProjectId, String(cwConn.id), sql);
  } catch (_) {
    res = { ok: false, error: t('connEditor.could_not_check_the_query') };
  }
  if (btn) btn.disabled = false;
  if (!cwConn) return;

  if (!res || res.ok === false) {
    cwSetMessage((res && res.error) || t('connEditor.could_not_check_the_query'), true);
    return;
  }
  const columns: any[] = Array.isArray(res.columns) ? res.columns : [];
  cwSetMessage(
    columns.length === 1 ? t('connEditor.returns_1_column') : t('connEditor.returns_columns', { columnsCount: columns.length }),
    false,
    columns,
  );
}

// ── Saved queries ────────────────────────────────────────────────────────────

/** The name of the saved query currently loaded, or ''. */
function cwQueryName(): string {
  const list = (cwConn && Array.isArray(cwConn.queries)) ? cwConn.queries : [];
  const hit = list.find((q: any) => q && q.id === cwQueryId);
  return hit ? String(hit.name || '') : '';
}

function cwRenderQueryChips(): void {
  const host = connEl('conn-wb-queries');
  if (!host) return;
  host.innerHTML = '';
  const list = (cwConn && Array.isArray(cwConn.queries)) ? cwConn.queries : [];
  for (const q of list) host.appendChild(cwQueryChip(q));
}

function cwQueryChip(q: any): HTMLElement {
  const chip = document.createElement('span');
  chip.className = 'cw-chip' + (q && q.id === cwQueryId ? ' is-on' : '');

  const open = document.createElement('button');
  open.type = 'button';
  open.className = 'cw-chip-open';
  open.textContent = String(q.name || t('connEditor.untitled_query'));
  open.title = String(q.sql || '');
  open.addEventListener('click', () => {
    cwQueryId = String(q.id);
    cwSetSql(String(q.sql || ''));
    cwSetMessage('', false);
    cwRenderQueryChips();
  });
  chip.appendChild(open);

  const rename = document.createElement('button');
  rename.type = 'button';
  rename.className = 'cw-chip-act';
  iconOnly(rename, 'pencil', t('connEditor.rename', { p0: String(q.name || 'query') }), 12);
  rename.addEventListener('click', () => { void cwRenameQuery(q); });
  chip.appendChild(rename);

  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'cw-chip-act';
  iconOnly(del, 'x', t('common.delete', { p0: String(q.name || 'query') }), 12);
  del.addEventListener('click', () => { void cwDeleteQuery(q); });
  chip.appendChild(del);
  return chip;
}

/** Apply a saveQuery/deleteQuery reply: the handler returns the WHOLE list, so
 *  nothing here merges one in by hand. */
function cwApplyQueries(queries: any): void {
  if (!cwConn || !Array.isArray(queries)) return;
  cwConn.queries = queries;
  cwRenderQueryChips();
}

/**
 * Save the editor's statement onto the connection.
 *
 * With a saved query loaded this UPDATES it (its id, so a dataset built from it
 * keeps pointing at the same query); otherwise it prompts for a name and
 * creates one.
 */
async function cwSaveQuery(): Promise<void> {
  if (!cwConn) return;
  const sql = cwGetSql().trim();
  if (!sql) { cwSetMessage(t('common.write_a_query_first'), true); return; }

  let name = cwQueryName();
  if (!cwQueryId) {
    const suggested = cwPreviewTable || t('common.query');
    // promptModal, not window.prompt: Electron does NOT implement prompt() —
    // it is a no-op that returns null, so a native prompt here would silently
    // make ⌘S do nothing. See projects.ts.
    const typed = await promptModal(t('connEditor.name_this_query'), suggested, t('common.save'));
    if (typed === null) return; // cancelled
    name = typed.trim() || suggested;
  }

  let res: any;
  try {
    res = await window.hub.saveConnectionQuery(currentProjectId, String(cwConn.id), {
      id: cwQueryId || undefined,
      name,
      sql,
    });
  } catch (_) {
    res = { ok: false, error: t('connEditor.could_not_save_that_query') };
  }
  if (!res || res.ok === false) {
    cwSetMessage((res && res.error) || t('connEditor.could_not_save_that_query'), true);
    return;
  }
  // A brand-new query has to become the LOADED one, or the next ⌘S would make
  // a second copy of the same statement. It is `queries[0]`: main unshifts a
  // new entry and returns the whole list newest-first. Matching on name+sql
  // instead would miss the one case that matters — a statement long enough to
  // have been length-capped on the way in no longer equals what was sent.
  if (!cwQueryId && Array.isArray(res.queries) && res.queries[0]) {
    cwQueryId = String(res.queries[0].id);
  }
  cwApplyQueries(res.queries);
  cwSetMessage(t('connEditor.saved_as', { name }), false);
  void refreshConnectionList();
}

async function cwRenameQuery(q: any): Promise<void> {
  if (!cwConn || !q) return;
  const typed = await promptModal(t('connEditor.rename_this_query'), String(q.name || ''), t('common.rename'));
  if (typed === null) return;
  const name = typed.trim();
  if (!name) return;
  let res: any;
  try {
    // No `sql`, so main keeps the stored statement — a rename must not be able
    // to overwrite what a dataset was built from.
    res = await window.hub.saveConnectionQuery(currentProjectId, String(cwConn.id), { id: String(q.id), name });
  } catch (_) {
    res = { ok: false, error: t('connEditor.could_not_rename_that_query') };
  }
  if (!res || res.ok === false) {
    cwSetMessage((res && res.error) || t('connEditor.could_not_rename_that_query'), true);
    return;
  }
  cwApplyQueries(res.queries);
}

async function cwDeleteQuery(q: any): Promise<void> {
  if (!cwConn || !q) return;
  if (!window.confirm(t('connEditor.delete_the_query_datasets_built_from', { p0: String(q.name || '') }))) return;
  let res: any;
  try {
    res = await window.hub.deleteConnectionQuery(currentProjectId, String(cwConn.id), String(q.id));
  } catch (_) {
    res = { ok: false, error: t('connEditor.could_not_delete_that_query') };
  }
  if (!res || res.ok === false) {
    cwSetMessage((res && res.error) || t('connEditor.could_not_delete_that_query'), true);
    return;
  }
  if (cwQueryId === String(q.id)) cwQueryId = '';
  cwApplyQueries(res.queries);
  void refreshConnectionList();
}

// ── Boot wiring (once, from initConnections) ─────────────────────────────────

function initConnEditor(): void {
  const input = connEl('conn-wb-sql') as HTMLTextAreaElement | null;
  if (input) {
    input.addEventListener('input', () => { cwPaintHighlight(); cwRefreshAutocomplete(); });
    input.addEventListener('click', () => cwCloseAutocomplete());
    input.addEventListener('blur', () => cwCloseAutocomplete());
    input.addEventListener('scroll', () => {
      const mirror = connEl('conn-wb-hl');
      if (mirror) { mirror.scrollTop = input.scrollTop; mirror.scrollLeft = input.scrollLeft; }
    });
    // A drop lands as ordinary text; the paint has to happen after the browser
    // has inserted it, hence the microtask.
    input.addEventListener('drop', () => { setTimeout(cwPaintHighlight, 0); });
    input.addEventListener('keydown', (e) => cwEditorKeydown(e, input));
  }

  const run = connEl('conn-wb-run');
  if (run) run.addEventListener('click', () => { void cwRunQuery(); });
  const explain = connEl('conn-wb-explain');
  if (explain) explain.addEventListener('click', () => { void cwExplainQuery(); });
  const save = connEl('conn-wb-save-query');
  if (save) save.addEventListener('click', () => { void cwSaveQuery(); });
}

function cwEditorKeydown(e: KeyboardEvent, input: HTMLTextAreaElement): void {
  const mod = e.metaKey || e.ctrlKey;

  // The popover owns the arrows, Enter, Tab and Escape while it is open — but
  // NOT ⌘Enter, which must still run even mid-word.
  if (cwAcItems.length > 0 && !mod) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      cwAcIndex = (cwAcIndex + 1) % cwAcItems.length;
      cwPaintAutocomplete();
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      cwAcIndex = (cwAcIndex - 1 + cwAcItems.length) % cwAcItems.length;
      cwPaintAutocomplete();
      return;
    }
    if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      cwAcceptCompletion(cwAcIndex >= 0 ? cwAcIndex : 0);
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      cwCloseAutocomplete();
      return;
    }
  }

  if (mod && e.key === 'Enter') {
    e.preventDefault();
    cwCloseAutocomplete();
    void cwRunQuery();
    return;
  }
  if (mod && (e.key === 's' || e.key === 'S')) {
    e.preventDefault();
    cwCloseAutocomplete();
    void cwSaveQuery();
    return;
  }
  // A Tab in a SQL editor is an indent, not a way out of the field. The editor
  // is reachable and leavable by keyboard through the buttons around it.
  if (e.key === 'Tab' && !e.shiftKey && cwAcItems.length === 0) {
    e.preventDefault();
    const at = input.selectionStart ?? 0;
    input.value = input.value.slice(0, at) + '  ' + input.value.slice(input.selectionEnd ?? at);
    input.setSelectionRange(at + 2, at + 2);
    cwPaintHighlight();
  }
}
