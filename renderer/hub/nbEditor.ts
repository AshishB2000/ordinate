'use strict';

// A notebook SQL cell's EDITOR — the Query tab's, per cell. Classic
// global-scope renderer <script>: no import/export.
//
// The same pieces queryEditor.ts is built from, reused rather than forked: the
// cosmetic lexer and mirror (`cwHighlightHtml`), the keyword list
// (`CW_KEYWORDS`), the `.cw-input` / `.cw-hl` pair that is ONE CSS rule so the
// colours sit under the characters, the `.cw-ac` completion list, and
// `qeIdent` for quoting. What differs is the vocabulary: besides the project's
// datasets (the Query tab's own `sql:schema`), a cell completes the VIEWS of
// the SQL cells above it and the columns their last results had.
//
// Keys match the Query tab — Tab indents, Escape then Tab leaves, ⌘↩ runs —
// plus ⇧↩ (run and move on), which nbPage.nbEditorKey owns.

let nbSchema: { pid: string; datasets: any[] } = { pid: '', datasets: [] };

async function nbLoadSchema(): Promise<void> {
  const pid = currentProjectId || '';
  if (!pid || nbSchema.pid === pid) return;
  try {
    const res = await window.hub.sqlSchema(pid);
    nbSchema = { pid, datasets: res && res.ok && Array.isArray(res.datasets) ? res.datasets : [] };
  } catch (_) {
    nbSchema = { pid, datasets: [] };
  }
}

/** The empty editor's placeholder: read the cell above if there is one, else a dataset. */
function nbSqlPlaceholder(id: string): string {
  if (nbDoc) {
    const i = nbDoc.cells.findIndex((c) => c.id === id);
    for (let j = i - 1; j >= 0; j -= 1) {
      const info = nbInfo(nbDoc.cells[j].id);
      if (info && info.view) return t('nbEditor.select_from', { view: info.view });
    }
  }
  const d = nbSchema.datasets.find((x) => x.queryable);
  return d ? t('common.select_from_limit_100', { slug: d.slug }) : t('nbEditor.select');
}

function nbAutoGrow(el: HTMLTextAreaElement): void {
  el.style.height = 'auto';
  el.style.height = Math.min(480, Math.max(72, el.scrollHeight + 2)) + 'px';
}

/** Completions for a SQL cell: views above and their columns first, then datasets, then keywords. */
function nbSqlCompletions(id: string, prefix: string, afterDot: boolean): Array<{ label: string; insert: string; sub: string }> {
  const q = prefix.toLowerCase();
  const out: Array<{ label: string; insert: string; sub: string }> = [];
  const seen = new Set<string>();
  const take = (label: string, insert: string, sub: string): void => {
    if (!label || seen.has(label) || !label.toLowerCase().startsWith(q)) return;
    seen.add(label);
    out.push({ label, insert, sub });
  };
  const i = nbDoc ? nbDoc.cells.findIndex((c) => c.id === id) : -1;
  const above = nbDoc ? nbDoc.cells.slice(0, Math.max(0, i)) : [];
  for (const c of above) {
    const info = nbInfo(c.id);
    const r = nbResults.get(c.id);
    if (!info || !info.view) continue;
    if (!afterDot) take(info.view, info.view, t('nbEditor.cell_above'));
    for (const col of (r && r.ok && r.columns) || []) take(col.name, qeIdent(col.name), `${col.type} · ${info.view}`);
  }
  if (!afterDot) for (const d of nbSchema.datasets) take(d.slug, d.slug, t('common.dataset_2', { name: d.name }));
  for (const d of nbSchema.datasets) for (const c of d.columns || []) take(c.name, qeIdent(c.name), `${c.type} · ${d.name}`);
  if (!afterDot) for (const k of CW_KEYWORDS) take(k.toUpperCase(), k.toUpperCase(), 'keyword');
  return out.slice(0, CW_AC_MAX);
}

function nbSqlEditor(c: NbCellDoc): HTMLElement {
  const box = document.createElement('div');
  box.className = 'cw-editor nb-sql';
  const wrap = document.createElement('div');
  wrap.className = 'cw-edit-wrap';
  const mirror = document.createElement('pre');
  mirror.className = 'cw-hl nb-sql-hl';
  mirror.setAttribute('aria-hidden', 'true');
  const input = document.createElement('textarea');
  input.className = 'cw-input nb-sql-input';
  input.spellcheck = false;
  input.autocomplete = 'off';
  input.setAttribute('autocapitalize', 'off');
  input.setAttribute('aria-label', t('nbEditor.sql_over_this_project_s_datasets'));
  input.dataset.tabIndents = '1';
  input.value = c.sql || '';
  input.placeholder = nbSqlPlaceholder(c.id);
  wrap.append(mirror, input);
  const pop = document.createElement('div');
  pop.className = 'cw-ac';
  pop.hidden = true;
  pop.setAttribute('role', 'listbox');
  pop.setAttribute('aria-label', t('common.completions'));
  box.append(wrap, pop);

  let items: Array<{ label: string; insert: string; sub: string }> = [];
  let index = -1;
  let from = -1;
  let escaped = false;
  const paint = (): void => {
    mirror.innerHTML = cwHighlightHtml(input.value);
    nbAutoGrow(input);
  };
  const closeAc = (): void => {
    items = [];
    index = -1;
    pop.hidden = true;
    pop.textContent = '';
  };
  const paintAc = (): void => {
    pop.textContent = '';
    items.forEach((it, k) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'cw-ac-item' + (k === index ? ' is-on' : '');
      b.setAttribute('role', 'option');
      b.setAttribute('aria-selected', String(k === index));
      b.append(
        Object.assign(document.createElement('span'), { className: 'cw-ac-label', textContent: it.insert }),
        Object.assign(document.createElement('span'), { className: 'cw-ac-sub', textContent: it.sub }),
      );
      // mousedown, not click: the textarea's blur would close the list first.
      b.addEventListener('mousedown', (e) => { e.preventDefault(); accept(k); });
      pop.appendChild(b);
    });
    pop.hidden = items.length === 0;
  };
  const changed = (): void => {
    c.sql = input.value;
    paint();
    nbTouch();
  };
  const accept = (k: number): void => {
    const it = items[k];
    if (!it || from < 0) return;
    const caret = input.selectionStart ?? 0;
    input.value = input.value.slice(0, from) + it.insert + input.value.slice(caret);
    const at = from + it.insert.length;
    input.setSelectionRange(at, at);
    closeAc();
    changed();
    input.focus();
  };
  const refreshAc = (): void => {
    const caret = input.selectionStart ?? 0;
    const text = input.value.slice(0, caret);
    const m = /[A-Za-z_][A-Za-z0-9_$]*$/.exec(text);
    if (!m || m[0].length < 2) { closeAc(); return; }
    from = caret - m[0].length;
    const afterDot = text[from - 1] === '.';
    if (text[from - 1] === '"') from -= 1;
    items = nbSqlCompletions(c.id, m[0], afterDot);
    if (!items.length || (items.length === 1 && items[0].label.toLowerCase() === m[0].toLowerCase())) { closeAc(); return; }
    index = 0;
    paintAc();
  };

  input.addEventListener('input', () => { changed(); refreshAc(); });
  input.addEventListener('blur', closeAc);
  input.addEventListener('click', closeAc);
  input.addEventListener('scroll', () => { mirror.scrollTop = input.scrollTop; mirror.scrollLeft = input.scrollLeft; });
  input.addEventListener('drop', () => { window.setTimeout(changed, 0); });
  input.addEventListener('keydown', (e) => {
    const mod = e.metaKey || e.ctrlKey;
    if (items.length && !mod) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        index = (index + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length;
        paintAc();
        return;
      }
      if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') { e.preventDefault(); accept(Math.max(0, index)); return; }
      if (e.key === 'Escape') { e.preventDefault(); closeAc(); return; }
    }
    if (e.key === 'Enter' && (e.shiftKey || mod)) { closeAc(); nbEditorKey(e, c.id); return; }
    // No keyboard trap (WCAG 2.1.2): Escape, then Tab, leaves the ordinary way.
    if (e.key === 'Escape') { escaped = true; nbEditorKey(e, c.id); return; }
    if (e.key === 'Tab' && escaped) { escaped = false; return; }
    if (e.key !== 'Shift') escaped = false;
    if (e.key === 'Tab' && !e.shiftKey) {
      e.preventDefault();
      const at = input.selectionStart ?? 0;
      input.value = input.value.slice(0, at) + '  ' + input.value.slice(input.selectionEnd ?? at);
      input.setSelectionRange(at + 2, at + 2);
      changed();
    }
  });
  // Painted once it is in the document: the auto-grow needs a laid-out box.
  window.requestAnimationFrame(paint);
  mirror.innerHTML = cwHighlightHtml(input.value);
  return box;
}
