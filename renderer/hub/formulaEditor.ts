'use strict';

// ONE formula editor — RENDERER ONLY. Every place a calculated field is written
// opens this: the Prepare pipeline, the analysis rail's ƒx button, and the
// Assistant's suggested field (prefilled, so a model's proposal is reviewed
// against real rows before it is accepted rather than after).
//
// WHAT IT REPLACES. A two-line form: a name box, an expression box, and a hint
// paragraph naming four of the eighty-two functions. It compiled nothing, knew
// nothing about the dataset's columns, and reported a bad formula by silently
// skipping the step — the warning surfaced in the pipeline list, after the save,
// phrased as "skipped". So the loop was: type, save, hunt for the warning,
// guess, retype. Everything here exists to close that loop while typing.
//
// ── The one rule this file obeys ─────────────────────────────────────────────
//
// IT DOES NOT KNOW WHETHER A FORMULA IS VALID. Not one character of the
// language is parsed here. Every verdict — the tokens it colours, the error and
// its position, the unknown columns, the result type, the eight preview rows —
// comes from `formula:check` in main, which runs the SAME `compile()` the
// pipeline runs on save. A second parser in the renderer would be a second
// opinion, and the day the two disagreed this panel would show a green preview
// for an expression the pipeline then skipped.
//
// ── The highlight layer ──────────────────────────────────────────────────────
//
// A <textarea> cannot colour its own text, so the usual mirrored-<pre> trick:
// a <pre> sits behind a transparent-text textarea, painting the same string
// with spans, and the two are pinned to the same font, size, padding and
// wrapping by `.fx-input, .fx-hl` sharing one CSS rule. If those ever diverge
// the colours slide out from under the characters — which is why they are ONE
// rule and not two that look alike. No editor library: the whole feature is a
// per-character class array (`highlightHtml`), and CodeMirror is 400 KB.
//
// ponytail: the autocomplete popover sits UNDER the editor rather than at the
// caret — caret coordinates in a wrapping textarea need a full mirror measure.
// Move it if anyone misses it.

interface FormulaEditorOpts {
  projectId: string;
  datasetId: string;
  /** Prefill — an existing step being edited, or a suggestion to review. */
  existing?: { name?: string; expression?: string; note?: string };
  /** Return false (or a promise of it) to keep the editor open on a failed save. */
  onSave: (field: { name: string; expression: string }) => any;
}

/** How long the typing has to stop before main is asked. One keystroke = one check. */
const FX_DEBOUNCE = 180;

/** Keyword operators — not functions, but they colour like them. */
const FX_KEYWORDS = ['if', 'then', 'elseif', 'else', 'end', 'case', 'when', 'and', 'or', 'not', 'in', 'true', 'false', 'null'];

/** The function catalog, fetched once per session and shared by every open. */
let fxDocs: any[] | null = null;

function fxEsc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * The class for one token.
 *
 * `name` is three different things in this language — a keyword, a function, or
 * a bare (unbracketed) column reference — and the tokenizer cannot tell them
 * apart, because which one it is depends on what follows and on what the
 * catalog holds. Resolving it HERE is why a bare `revenue` colours as a column
 * exactly like `[revenue]` does.
 */
function fxTokenClass(tok: any, names: Set<string>): string {
  if (tok.kind === 'col') return 'fx-t-col';
  if (tok.kind === 'param') return 'fx-t-param';
  if (tok.kind === 'str') return 'fx-t-str';
  if (tok.kind === 'num') return 'fx-t-num';
  if (tok.kind === 'punc' && (tok.value === '{' || tok.value === '}' || tok.value === ':')) return 'fx-t-lod';
  if (tok.kind === 'name') {
    const lower = String(tok.value).toLowerCase();
    if (lower === 'fixed' || lower === 'include' || lower === 'exclude') return 'fx-t-lod';
    if (lower === 'sum' || lower === 'avg' || lower === 'count' || lower === 'countd') return 'fx-t-fn'; // LOD aggregates
    if (FX_KEYWORDS.indexOf(lower) >= 0 || names.has(lower)) return 'fx-t-fn';
    return 'fx-t-col';
  }
  return '';
}

/**
 * The highlighted source, as HTML for the mirror <pre>.
 *
 * Built from a per-CHARACTER class array rather than by emitting a span per
 * token, because the error underline is its own range and overlaps the tokens
 * it covers. Painting spans directly would mean nesting or splitting them by
 * hand; a class array makes an overlap just two classes on one character, and
 * the coalescing pass below turns runs of identical classes back into spans.
 *
 * The trailing newline is load-bearing: a <pre> does not render a final empty
 * line, so without it the mirror is one line short of the textarea the moment
 * the expression ends in a line break, and every colour below sits too high.
 */
function fxHighlightHtml(src: string, tokens: any[], at: any, names: Set<string>): string {
  const cls: string[] = new Array(src.length).fill('');
  for (const tok of tokens || []) {
    const c = fxTokenClass(tok, names);
    if (!c) continue;
    for (let i = Math.max(0, tok.start); i < Math.min(src.length, tok.end); i += 1) cls[i] = c;
  }
  if (at && typeof at.start === 'number') {
    for (let i = Math.max(0, at.start); i < Math.min(src.length, at.end); i += 1) {
      cls[i] = cls[i] ? cls[i] + ' fx-t-err' : 'fx-t-err';
    }
  }
  let html = '';
  let i = 0;
  while (i < src.length) {
    let j = i;
    while (j < src.length && cls[j] === cls[i]) j += 1;
    const text = fxEsc(src.slice(i, j));
    html += cls[i] ? '<span class="' + cls[i] + '">' + text + '</span>' : text;
    i = j;
  }
  return html + '\n';
}

function fxRow(cls: string, parent: HTMLElement): HTMLDivElement {
  const el = document.createElement('div');
  el.className = cls;
  parent.appendChild(el);
  return el;
}

/**
 * Open the editor. Resolves when it closes; `onSave` is what actually applies
 * the field, so this file never touches a dataset.
 */
function openFormulaEditor(opts: FormulaEditorOpts): Promise<void> {
  return new Promise((resolve) => {
    const existing = opts.existing || {};
    const editingName = String(existing.name || '');

    // ── Shell ────────────────────────────────────────────────────────────────
    const overlay = document.createElement('div');
    overlay.className = 'ws-modal-overlay';
    const box = document.createElement('div');
    box.className = 'ws-modal fx-modal';
    overlay.appendChild(box);

    const title = document.createElement('div');
    title.className = 'ws-modal-title';
    title.textContent = editingName ? t('formulaEditor.edit_calculated_field') : t('formulaEditor.new_calculated_field');
    box.appendChild(title);

    if (existing.note) {
      const note = fxRow('fx-note', box);
      note.textContent = String(existing.note);
    }

    const body = fxRow('fx-body', box);
    const side = fxRow('fx-side', body);
    const main = fxRow('fx-main', body);

    // ── Left rail: columns, then functions by category ───────────────────────
    const search = document.createElement('input');
    search.type = 'search';
    search.className = 'ws-modal-input fx-search';
    search.placeholder = t('formulaEditor.search_columns_functions');
    search.setAttribute('aria-label', t('formulaEditor.search_columns_and_functions'));
    side.appendChild(search);
    const sideList = fxRow('fx-side-list', side);

    // ── Centre: name + type badge, then the editor ───────────────────────────
    const nameRow = fxRow('fx-name-row', main);
    const nameIn = document.createElement('input');
    nameIn.type = 'text';
    nameIn.className = 'ws-modal-input fx-name';
    nameIn.placeholder = t('common.new_column_name');
    nameIn.value = editingName;
    nameIn.setAttribute('aria-label', t('common.new_column_name'));
    nameRow.appendChild(nameIn);
    const badge = document.createElement('span');
    badge.className = 'fx-badge';
    badge.hidden = true;
    nameRow.appendChild(badge);

    const wrap = fxRow('fx-edit-wrap', main);
    const mirror = document.createElement('pre');
    mirror.className = 'fx-hl';
    mirror.setAttribute('aria-hidden', 'true');
    wrap.appendChild(mirror);
    const input = document.createElement('textarea');
    input.className = 'fx-input';
    input.spellcheck = false;
    input.value = String(existing.expression || '');
    input.setAttribute('aria-label', t('formulaEditor.expression'));
    wrap.appendChild(input);

    const pop = fxRow('fx-pop', main);
    pop.hidden = true;
    pop.setAttribute('role', 'listbox');
    const msg = fxRow('fx-msg', main);
    const preview = fxRow('fx-preview', main);

    // ── Actions ──────────────────────────────────────────────────────────────
    const actions = fxRow('ws-modal-actions fx-actions', box);
    const hint = document.createElement('span');
    hint.className = 'fx-hint';
    hint.textContent = t('formulaEditor.to_save');
    actions.appendChild(hint);
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'btn';
    cancel.textContent = t('common.cancel');
    actions.appendChild(cancel);
    // The Save button carries its own reason for being disabled, and so does the
    // span around it: a DISABLED button fires no pointer events, so its `title`
    // never opens. The wrapper is the only thing the cursor can actually reach.
    const saveWrap = document.createElement('span');
    saveWrap.className = 'fx-save-wrap';
    const save = document.createElement('button');
    save.type = 'button';
    save.className = 'btn btn-primary';
    save.textContent = t('common.save');
    saveWrap.appendChild(save);
    actions.appendChild(saveWrap);

    // ── State ────────────────────────────────────────────────────────────────
    let columns: any[] = [];
    let names: Set<string> = new Set();
    let last: any = null;
    let timer: any = null;
    let seq = 0;
    let popItems: Array<{ label: string; insert: string; sub: string }> = [];
    let popIndex = 0;
    let done = false;

    const close = (): void => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener('keydown', onKeyDown, true);
      overlay.remove();
      resolve();
    };

    // ── The left rail's list ─────────────────────────────────────────────────
    const insertAtCaret = (text: string, caretBack: number): void => {
      const at = input.selectionStart ?? input.value.length;
      input.value = input.value.slice(0, at) + text + input.value.slice(input.selectionEnd ?? at);
      const pos = at + text.length - caretBack;
      input.setSelectionRange(pos, pos);
      input.focus();
      scheduleCheck();
    };

    const renderSide = (): void => {
      const q = search.value.trim().toLowerCase();
      sideList.innerHTML = '';
      const group = (label: string): HTMLElement => {
        const h = document.createElement('div');
        h.className = 'fx-group';
        h.textContent = label;
        sideList.appendChild(h);
        return h;
      };
      const item = (label: string, sub: string, insert: string, caretBack: number, cls: string): void => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'fx-item ' + cls;
        b.textContent = label;
        if (sub) b.title = sub;
        b.addEventListener('click', () => insertAtCaret(insert, caretBack));
        sideList.appendChild(b);
      };

      const cols = columns.filter((c) => !q || String(c.name).toLowerCase().indexOf(q) >= 0);
      if (cols.length) {
        group(t('common.columns'));
        cols.forEach((c) => {
          const glyph = c.type === 'number' ? '#' : c.type === 'date' ? '⏱' : 'A';
          item(glyph + '  ' + c.name, c.type + ' column', '[' + c.name + ']', 0, 'fx-item-col');
        });
      }
      const docs = (fxDocs || []).filter(
        (d) => !q || d.name.indexOf(q) >= 0 || String(d.summary).toLowerCase().indexOf(q) >= 0,
      );
      let cat = '';
      docs.forEach((d) => {
        if (d.category !== cat) {
          cat = d.category;
          group(cat === 'lod' ? t('formulaEditor.level_of_detail') : cat.charAt(0).toUpperCase() + cat.slice(1));
        }
        if (d.insert) item(d.signature, d.summary + '\n' + d.example, d.insert, lodCaretBack(d), 'fx-item-fn fx-item-lod');
        else item(d.signature, d.summary, d.name + '(', 0, 'fx-item-fn');
      });
      if (!cols.length && !docs.length) {
        const none = document.createElement('div');
        none.className = 'fx-side-empty';
        none.textContent = t('formulaEditor.nothing_matches', { p0: search.value.trim() });
        sideList.appendChild(none);
      }
    };

    // ── Autocomplete ─────────────────────────────────────────────────────────
    // Two triggers, decided from the text BEFORE the caret. An unclosed `[` is
    // unambiguous — the user is naming a column and nothing else. Otherwise two
    // or more identifier characters are treated as the start of a function
    // name, which is why a single letter does not open a popover over an
    // expression the user is still typing.
    const popContext = (): { items: typeof popItems; from: number } | null => {
      const caret = input.selectionStart ?? 0;
      const before = input.value.slice(0, caret);
      const open = before.lastIndexOf('[');
      if (open >= 0 && before.indexOf(']', open) < 0) {
        const frag = before.slice(open + 1).toLowerCase();
        const items = columns
          .filter((c) => String(c.name).toLowerCase().indexOf(frag) >= 0)
          .slice(0, 12)
          .map((c) => ({ label: String(c.name), insert: '[' + c.name + ']', sub: String(c.type) }));
        return items.length ? { items, from: open } : null;
      }
      const dims = lodDimContext(before, columns);
      if (dims) return dims;
      const word = /[A-Za-z_][A-Za-z0-9_]*$/.exec(before);
      if (!word || word[0].length < 2) return null;
      const frag = word[0].toLowerCase();
      const braced = before.slice(0, caret - word[0].length).trimEnd().endsWith('{');
      const items = (fxDocs || [])
        // Right after `{` only FIXED / INCLUDE / EXCLUDE can follow.
        .filter((d) => (braced ? d.kind === 'keyword' : d.kind !== 'recipe') && d.name.indexOf(frag) === 0)
        .slice(0, 12)
        .map((d) => ({ label: d.signature, insert: lodKeywordInsert(d, braced) || d.name + '(', sub: d.summary }));
      return items.length ? { items, from: caret - word[0].length } : null;
    };

    let popFrom = 0;
    const renderPop = (): void => {
      pop.innerHTML = '';
      popItems.forEach((it, i) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'fx-pop-item' + (i === popIndex ? ' is-on' : '');
        b.setAttribute('role', 'option');
        b.setAttribute('aria-selected', i === popIndex ? 'true' : 'false');
        const l = document.createElement('span');
        l.className = 'fx-pop-label';
        l.textContent = it.label;
        b.appendChild(l);
        const s = document.createElement('span');
        s.className = 'fx-pop-sub';
        s.textContent = it.sub;
        b.appendChild(s);
        b.addEventListener('mousedown', (e) => { e.preventDefault(); acceptPop(i); });
        pop.appendChild(b);
      });
      pop.hidden = popItems.length === 0;
    };

    const closePop = (): void => {
      popItems = [];
      popIndex = 0;
      pop.hidden = true;
      pop.innerHTML = '';
    };

    const acceptPop = (i: number): void => {
      const it = popItems[i];
      if (!it) return;
      const caret = input.selectionStart ?? 0;
      input.value = input.value.slice(0, popFrom) + it.insert + input.value.slice(caret);
      const pos = popFrom + it.insert.length;
      input.setSelectionRange(pos, pos);
      closePop();
      input.focus();
      scheduleCheck();
    };

    const refreshPop = (): void => {
      const ctx = popContext();
      if (!ctx) { closePop(); return; }
      popItems = ctx.items;
      popFrom = ctx.from;
      popIndex = 0;
      renderPop();
    };

    // ── Check → paint ────────────────────────────────────────────────────────
    const nameProblem = (): string => {
      const n = nameIn.value.trim();
      if (!n) return t('formulaEditor.give_the_new_column_a_name');
      const clash = columns.some((c) => String(c.name) === n) && n !== editingName;
      return clash ? t('formulaEditor.is_already_a_column_in_this', { n }) : '';
    };

    const paint = (): void => {
      const src = input.value;
      const at = last && !last.ok ? last.at : null;
      mirror.innerHTML = fxHighlightHtml(src, (last && last.tokens) || [], at, names);

      // Messages, worst first. An unknown column outranks nothing else here —
      // the expression COMPILED, so this is the only sign that `[reveune]` will
      // quietly evaluate to null for every row instead of dividing anything.
      msg.innerHTML = '';
      msg.className = 'fx-msg';
      const say = (text: string, cls: string): void => {
        const p = document.createElement('div');
        p.className = cls;
        p.textContent = text;
        msg.appendChild(p);
      };
      if (last && !last.ok && src.trim()) say(String(last.error), 'fx-msg-err');
      if (last && last.ok) {
        (last.unknownRefs || []).forEach((u: any) => {
          say(
            t('formulaEditor.is_not_a_column', { name: u.name, p1: (u.didYouMean ? t('formulaEditor.did_you_mean', { didYouMean: u.didYouMean }) : '') }),
            'fx-msg-err',
          );
        });
      }
      const np = nameProblem();
      if (np && nameIn.value.trim()) say(np, 'fx-msg-err');

      // Type badge
      const rt = last && last.ok ? last.resultType : null;
      badge.hidden = !rt;
      if (rt) {
        badge.textContent = rt;
        badge.className = 'fx-badge fx-badge-' + rt;
      }

      // Preview
      preview.innerHTML = '';
      const sample = last && last.ok ? last.sample : null;
      if (sample && sample.rows && sample.rows.length) {
        const table = document.createElement('table');
        table.className = 'fx-table';
        const thead = document.createElement('thead');
        const hr = document.createElement('tr');
        // Whether a column reads as a number is decided from the SAMPLE, not
        // from the declared type: it is the values on screen that are being
        // aligned, and an empty first row simply leaves the header left-aligned
        // like the "—" underneath it.
        const first = sample.rows[0];
        const lodFrom = sample.columns.length - (sample.lodColumns || 0);
        sample.columns.forEach((c: string, i: number) => {
          const th = document.createElement('th');
          th.textContent = c;
          if (typeof first.inputs[i] === 'number') th.className = 'fx-num';
          if (i >= lodFrom) lodPreviewHeader(th, c);
          hr.appendChild(th);
        });
        const rth = document.createElement('th');
        rth.className = 'fx-res' + (typeof first.result === 'number' ? ' fx-num' : '');
        rth.textContent = nameIn.value.trim() || t('formulaEditor.result');
        hr.appendChild(rth);
        thead.appendChild(hr);
        table.appendChild(thead);
        const tbody = document.createElement('tbody');
        sample.rows.forEach((r: any) => {
          const tr = document.createElement('tr');
          const cell = (v: any, cls: string): void => {
            const td = document.createElement('td');
            td.className = cls + (typeof v === 'number' ? ' fx-num' : '');
            td.textContent = v === null || v === undefined ? '—' : String(v);
            tr.appendChild(td);
          };
          r.inputs.forEach((v: any, i: number) => cell(v, i >= lodFrom ? 'fx-lod-cell' : ''));
          cell(r.result, 'fx-res');
          tbody.appendChild(tr);
        });
        table.appendChild(tbody);
        preview.appendChild(table);
        if (sample.note) preview.appendChild(lodPreviewNote(sample.note));
      } else if (last && last.ok) {
        const none = document.createElement('div');
        none.className = 'fx-side-empty';
        none.textContent = t('formulaEditor.this_dataset_has_no_rows_to');
        preview.appendChild(none);
      }

      // Save gate — one reason, shown on hover of the button AND its wrapper.
      const reason = !src.trim()
        ? t('formulaEditor.write_an_expression_first')
        : last && !last.ok
          ? String(last.error)
          : !last
            ? t('common.checking')
            : np;
      save.disabled = !!reason;
      saveWrap.title = reason;
      save.title = reason;
    };

    const runCheck = async (): Promise<void> => {
      const mine = ++seq;
      const src = input.value;
      if (!src.trim()) {
        last = null;
        paint();
        return;
      }
      let res: any = null;
      try {
        res = await window.hub.checkFormula(opts.projectId, opts.datasetId, src);
      } catch (_) {
        res = { tokens: [], ok: false, error: t('formulaEditor.could_not_check_the_formula') };
      }
      // A slower earlier check must never overwrite a newer one — otherwise a
      // fast typist watches the panel flip back to a stale error.
      if (mine !== seq || done) return;
      last = res;
      paint();
    };

    function scheduleCheck(): void {
      if (timer) clearTimeout(timer);
      paint(); // repaint immediately from the old tokens so typing never flickers
      timer = setTimeout(runCheck, FX_DEBOUNCE);
    }

    // ── Events ───────────────────────────────────────────────────────────────
    const doSave = async (): Promise<void> => {
      if (save.disabled) return;
      save.disabled = true;
      let res: any;
      try {
        res = await opts.onSave({ name: nameIn.value.trim(), expression: input.value.trim() });
      } catch (_) {
        res = false;
      }
      if (res === false) { save.disabled = false; return; }
      close();
    };

    function onKeyDown(e: KeyboardEvent): void {
      if (done) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        if (!pop.hidden) { closePop(); return; }
        close();
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        doSave();
      }
    }

    input.addEventListener('input', () => { refreshPop(); scheduleCheck(); });
    input.addEventListener('click', () => refreshPop());
    input.addEventListener('blur', () => closePop());
    input.addEventListener('scroll', () => { mirror.scrollTop = input.scrollTop; });
    input.addEventListener('keydown', (e) => {
      if (pop.hidden) return;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        popIndex = (popIndex + (e.key === 'ArrowDown' ? 1 : popItems.length - 1)) % popItems.length;
        renderPop();
      } else if (e.key === 'Tab' || e.key === 'Enter') {
        e.preventDefault();
        acceptPop(popIndex);
      }
    });
    nameIn.addEventListener('input', () => paint());
    search.addEventListener('input', () => renderSide());
    cancel.addEventListener('click', () => close());
    save.addEventListener('click', () => doSave());
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
    document.addEventListener('keydown', onKeyDown, true);

    // ── Boot ─────────────────────────────────────────────────────────────────
    document.body.appendChild(overlay);
    paint();
    input.focus();

    (async () => {
      const [meta, docs] = await Promise.all([
        window.hub.getDatasetMeta(opts.projectId, opts.datasetId).catch(() => null),
        fxDocs ? Promise.resolve(fxDocs) : window.hub.formulaFunctions().catch(() => []),
      ]);
      if (done) return;
      fxDocs = docs || [];
      names = new Set(fxDocs.map((d: any) => String(d.name)));
      columns = meta && Array.isArray(meta.columns) ? meta.columns : [];
      renderSide();
      if (input.value.trim()) runCheck();
      else paint();
    })();
  });
}
