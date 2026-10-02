// The Query tab's SQL editor: the highlight mirror, completion and keys.
//
// Classic global-scope renderer <script>: no import/export. Loads after
// connEditor.js and REUSES its pure pieces rather than forking them — the
// cosmetic lexer (`cwTokenize`), the mirror HTML (`cwHighlightHtml`) and the
// keyword list (`CW_KEYWORDS`). The same `.cw-input`/`.cw-hl` pair is one CSS
// rule, so the colours sit exactly under the characters here as they do in the
// connection workbench. What is NOT shared is the vocabulary: the workbench
// completes a remote catalog it discovers table by table; this one completes
// the project's datasets, which the Query tab already holds (`qtSchema`).
//
// Nothing here decides whether SQL is valid or safe — main does, on Run.

let qeAcItems: { label: string; insert: string; sub: string }[] = [];
let qeAcIndex = -1;
let qeAcFrom = -1;

function qeInput(): HTMLTextAreaElement | null {
  return document.getElementById('qt-sql') as HTMLTextAreaElement | null;
}

function qePaint(): void {
  const input = qeInput();
  const mirror = document.getElementById('qt-hl');
  if (!input || !mirror) return;
  mirror.innerHTML = cwHighlightHtml(input.value);
  mirror.scrollTop = input.scrollTop;
  mirror.scrollLeft = input.scrollLeft;
}

function qeGetSql(): string {
  const input = qeInput();
  return input ? input.value : '';
}

function qeSetSql(sql: string): void {
  const input = qeInput();
  if (!input) return;
  input.value = sql || '';
  qePaint();
}

/** A name as SQL should spell it: bare when DuckDB reads it as written, "quoted" otherwise. */
function qeIdent(name: string): string {
  const n = String(name || '');
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(n) && !CW_KEYWORD_SET.has(n.toLowerCase())
    ? n
    : '"' + n.replace(/"/g, '""') + '"';
}

/**
 * The names and `[[params]]` in `sql`, outside strings and comments (the
 * cosmetic lexer's idea of them). A `[[x]]` inside a "quoted name" is part of
 * that name. Approximate by design — main re-lexes for real.
 */
function qeScan(sql: string): { names: string[]; params: string[] } {
  const skip = new Uint8Array(sql.length);
  for (const t of cwTokenize(sql)) {
    if (t.cls === 'cw-t-str' || t.cls === 'cw-t-com') skip.fill(1, t.start, t.end);
  }
  const names: string[] = [];
  const params: string[] = [];
  const re = /\[\[\s*([A-Za-z_][A-Za-z0-9_]*)\s*\]\]|"((?:[^"]|"")*)"|[A-Za-z_][A-Za-z0-9_$]*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql))) {
    if (skip[m.index]) continue;
    if (m[1] !== undefined) {
      if (!params.includes(m[1])) params.push(m[1]);
    } else if (m[2] !== undefined) names.push(m[2].replace(/""/g, '"'));
    else names.push(m[0]);
  }
  return { names, params };
}

/** Insert at the caret, replacing any selection, spaced so it never runs into a word. */
function qeInsert(text: string): void {
  const input = qeInput();
  if (!input) return;
  const a = input.selectionStart ?? input.value.length;
  const b = input.selectionEnd ?? a;
  const before = input.value.slice(0, a);
  const after = input.value.slice(b);
  const pre = before && !/[\s(,.]$/.test(before) ? ' ' : '';
  const post = after && !/^[\s),.;]/.test(after) ? ' ' : '';
  input.value = before + pre + text + post + after;
  const at = (before + pre + text).length;
  input.focus();
  input.setSelectionRange(at, at);
  qePaint();
  qtOnSqlChanged();
}

// ── Completion ───────────────────────────────────────────────────────────────

/**
 * Columns of the datasets the SQL already names come first — the next word is
 * most likely one of them — then dataset names (slug and "exact"), the other
 * datasets' columns, and keywords. After a `.` only columns are offered.
 */
function qeCompletions(prefix: string, afterDot: boolean): { label: string; insert: string; sub: string }[] {
  const q = prefix.toLowerCase();
  const out: { label: string; insert: string; sub: string }[] = [];
  const seen = new Set<string>();
  const take = (label: string, insert: string, sub: string): void => {
    if (!label || seen.has(label) || !label.toLowerCase().startsWith(q)) return;
    seen.add(label);
    out.push({ label, insert, sub });
  };
  const referenced = qtReferencedIds(qeGetSql());
  const first = qtSchema.filter((d) => referenced.includes(d.id));
  const rest = qtSchema.filter((d) => !referenced.includes(d.id));
  for (const d of first) for (const c of d.columns) take(c.name, qeIdent(c.name), `${c.type} · ${d.name}`);
  if (!afterDot) {
    for (const d of qtSchema) {
      take(d.slug, d.slug, t('common.dataset_2', { name: d.name }));
      // The exact name only when it is a DIFFERENT identifier from the slug.
      if (d.alias && qtFold(d.alias) !== d.slug) take(d.alias, qeIdent(d.alias), 'dataset');
    }
  }
  for (const d of rest) for (const c of d.columns) take(c.name, qeIdent(c.name), `${c.type} · ${d.name}`);
  if (!afterDot) for (const k of CW_KEYWORDS) take(k.toUpperCase(), k.toUpperCase(), 'keyword');
  return out.slice(0, CW_AC_MAX);
}

function qeRefreshAc(): void {
  const input = qeInput();
  if (!input) return;
  const caret = input.selectionStart ?? 0;
  const text = input.value.slice(0, caret);
  const m = /[A-Za-z_][A-Za-z0-9_$]*$/.exec(text);
  if (!m || m[0].length < 2) { qeCloseAc(); return; }
  let from = caret - m[0].length;
  const afterDot = text[from - 1] === '.';
  // Completing inside an opened quote replaces the quote too, so accepting
  // `"Retail orders"` never leaves `""Retail orders"`.
  if (text[from - 1] === '"') from -= 1;
  qeAcItems = qeCompletions(m[0], afterDot);
  qeAcFrom = from;
  if (!qeAcItems.length || (qeAcItems.length === 1 && qeAcItems[0].label.toLowerCase() === m[0].toLowerCase())) {
    qeCloseAc();
    return;
  }
  qeAcIndex = 0;
  qePaintAc();
}

function qePaintAc(): void {
  const pop = document.getElementById('qt-ac');
  if (!pop) return;
  pop.innerHTML = '';
  qeAcItems.forEach((item, i) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'cw-ac-item' + (i === qeAcIndex ? ' is-on' : '');
    btn.setAttribute('role', 'option');
    btn.setAttribute('aria-selected', String(i === qeAcIndex));
    const label = document.createElement('span');
    label.className = 'cw-ac-label';
    label.textContent = item.insert;
    const sub = document.createElement('span');
    sub.className = 'cw-ac-sub';
    sub.textContent = item.sub;
    btn.append(label, sub);
    // mousedown, not click: the textarea's blur would close the list first.
    btn.addEventListener('mousedown', (e) => { e.preventDefault(); qeAccept(i); });
    pop.appendChild(btn);
  });
  pop.hidden = qeAcItems.length === 0;
}

function qeCloseAc(): void {
  qeAcItems = [];
  qeAcIndex = -1;
  qeAcFrom = -1;
  const pop = document.getElementById('qt-ac');
  if (pop) { pop.hidden = true; pop.innerHTML = ''; }
}

function qeAccept(i: number): void {
  const input = qeInput();
  const item = qeAcItems[i];
  if (!input || !item || qeAcFrom < 0) return;
  const caret = input.selectionStart ?? 0;
  input.value = input.value.slice(0, qeAcFrom) + item.insert + input.value.slice(caret);
  const at = qeAcFrom + item.insert.length;
  input.setSelectionRange(at, at);
  qeCloseAc();
  qePaint();
  qtOnSqlChanged();
  input.focus();
}

// ── Keys ─────────────────────────────────────────────────────────────────────

// Set by Escape: the NEXT Tab moves focus on instead of indenting.
let qeEscaped = false;

function qeKeydown(e: KeyboardEvent, input: HTMLTextAreaElement): void {
  const mod = e.metaKey || e.ctrlKey;
  if (qeAcItems.length > 0 && !mod) {
    const n = qeAcItems.length;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      qeAcIndex = (qeAcIndex + (e.key === 'ArrowDown' ? 1 : n - 1)) % n;
      qePaintAc();
      return;
    }
    if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      qeAccept(Math.max(0, qeAcIndex));
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      qeCloseAc();
      return;
    }
  }
  if (mod && e.key === 'Enter') {
    e.preventDefault();
    qeCloseAc();
    void qtRun();
    return;
  }
  // No keyboard trap (WCAG 2.1.2): Escape, then Tab, leaves the editor the
  // ordinary way — Tab alone still indents, which is what a SQL editor is for.
  if (e.key === 'Escape') { qeEscaped = true; return; }
  if (e.key === 'Tab' && qeEscaped) { qeEscaped = false; return; }
  if (e.key !== 'Shift') qeEscaped = false;
  // A Tab in a SQL editor indents; Shift+Tab, or Escape then Tab, is how you leave.
  if (e.key === 'Tab' && !e.shiftKey && qeAcItems.length === 0) {
    e.preventDefault();
    const at = input.selectionStart ?? 0;
    input.value = input.value.slice(0, at) + '  ' + input.value.slice(input.selectionEnd ?? at);
    input.setSelectionRange(at + 2, at + 2);
    qePaint();
  }
}

function initQueryEditor(): void {
  const input = qeInput();
  if (!input) return;
  // Say how the Tab key behaves here, since it is not the page's usual one.
  const hint = document.createElement('span');
  hint.id = 'qt-sql-keys';
  hint.className = 'sr-only';
  hint.textContent = t('queryEditor.tab_indents_press_escape_then_tab');
  input.after(hint);
  input.setAttribute('aria-describedby', hint.id);
  input.dataset.tabIndents = '1';
  input.addEventListener('input', () => { qePaint(); qeRefreshAc(); qtOnSqlChanged(); });
  input.addEventListener('click', () => qeCloseAc());
  input.addEventListener('blur', () => qeCloseAc());
  input.addEventListener('scroll', () => {
    const mirror = document.getElementById('qt-hl');
    if (mirror) { mirror.scrollTop = input.scrollTop; mirror.scrollLeft = input.scrollLeft; }
  });
  // A drop lands as ordinary text; paint once the browser has inserted it.
  input.addEventListener('drop', () => { setTimeout(() => { qePaint(); qtOnSqlChanged(); }, 0); });
  input.addEventListener('keydown', (e) => qeKeydown(e, input));
  qePaint();
}
