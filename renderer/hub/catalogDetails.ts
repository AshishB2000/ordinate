'use strict';

// The "Details" popover — description, tags and owner for a record; display
// name, description, example and sensitivity for a column. Saves on blur and
// on Enter, with no Save button; Escape (or a click outside) closes, and
// closing commits whatever was being typed. Classic global-scope renderer
// <script>: no import/export.
//
// The shell is `openMiniMenu` (chartControls.ts) — the hub's one popover, so
// positioning, Escape and outside-click are already solved. Every string a
// person typed goes in with textContent / .value, never innerHTML.

interface CtTarget { kind: string; id: string; name?: string }

/** Mirrors catalog.normalizeTag in main (main is the authority; this is for the chip before the round trip). */
function ctNormTag(raw: string): string {
  return String(raw || '').trim().replace(/^#+/, '').toLowerCase().replace(/\s+/g, '-')
    .replace(/[^a-z0-9_-]/g, '').slice(0, 32);
}

function ctEl<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  el.className = cls;
  if (text) el.textContent = text;
  return el;
}

function ctField(label: string, control: HTMLElement): HTMLElement {
  const row = ctEl('label', 'ct-field');
  row.appendChild(ctEl('span', 'ct-field-label', label));
  row.appendChild(control);
  return row;
}

/** "Updated by ash · 3m ago" — or an honest "Not documented yet". */
function ctStamp(el: HTMLElement, doc: { updatedBy?: string; updatedAt?: string } | null): void {
  const at = doc && doc.updatedAt ? aiAgo(doc.updatedAt) : '';
  el.textContent = at
    ? t('catalogDetails.updated_by', { p0: (doc && doc.updatedBy) || 'someone', at })
    : t('catalogDetails.not_documented_yet_anything_you_add');
}

/** A text box that commits on blur and on Enter (Shift+Enter is a newline in a textarea). */
function ctTextBox(multiline: boolean, value: string, placeholder: string, commit: (v: string) => void): HTMLInputElement | HTMLTextAreaElement {
  const box = multiline ? ctEl('textarea', 'ct-input ct-input--area') : ctEl('input', 'ct-input');
  if (box instanceof HTMLTextAreaElement) box.rows = 3;
  else box.type = 'text';
  box.value = value || '';
  box.placeholder = placeholder;
  box.addEventListener('blur', () => commit(box.value));
  box.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); commit(box.value); }
  });
  return box;
}

/**
 * The tag field: chips with ×, a box, and suggestions from the project's own
 * tags (with their colours). Enter or comma adds; Backspace on an empty box
 * removes the last chip. Every change is a save.
 */
function ctTagEditor(initial: string[], onChange: (tags: string[]) => void): HTMLElement {
  let tags = initial.slice();
  let pick = -1;
  // A tag created here has no stored colour until main answers; show the one it will get.
  const fresh = new Map<string, number>();
  const colorOf = (t: string): number => (ctTagsCache && ctTagsCache.tags.some((x) => x.name === t) ? ctColorOf(t) : fresh.get(t) || 0);
  const wrap = ctEl('div', 'ct-tagedit');
  const chips = ctEl('span', 'ct-tagedit-chips');
  const input = ctEl('input', 'ct-tag-input');
  input.type = 'text';
  input.placeholder = t('catalogDetails.add_a_tag');
  input.setAttribute('aria-label', t('catalogDetails.add_a_tag_2'));
  const sugg = ctEl('div', 'ct-sugg');
  sugg.setAttribute('role', 'listbox');
  sugg.hidden = true;

  const paint = (): void => {
    chips.textContent = '';
    tags.forEach((tv) => {
      const chip = ctEl('span', 'ct-chip tag-c' + colorOf(tv), tv);
      const x = ctEl('button', 'ct-chip-x');
      x.type = 'button';
      x.setAttribute('aria-label', t('catalogDetails.remove_tag', { t: tv }));
      x.appendChild(icon('x', 12));
      x.addEventListener('click', () => { tags = tags.filter((n) => n !== tv); paint(); onChange(tags); });
      chip.appendChild(x);
      chips.appendChild(chip);
    });
  };
  const add = (raw: string): void => {
    const t = ctNormTag(raw);
    input.value = '';
    sugg.hidden = true;
    if (!t || tags.indexOf(t) >= 0 || tags.length >= 12) return;
    if (!fresh.has(t)) fresh.set(t, ctNextColor());
    tags = tags.concat(t);
    paint();
    onChange(tags);
  };
  const options = (): string[] => {
    const q = ctNormTag(input.value);
    const known = (ctTagsCache ? ctTagsCache.tags : []).map((t) => t.name).filter((n) => tags.indexOf(n) < 0);
    const hits = known.filter((n) => !q || n.indexOf(q) >= 0).slice(0, 6);
    if (q && known.indexOf(q) < 0 && tags.indexOf(q) < 0) hits.push(q);
    return hits;
  };
  const paintSugg = (): void => {
    const list = options();
    sugg.textContent = '';
    sugg.hidden = !list.length || document.activeElement !== input;
    if (pick >= list.length) pick = list.length - 1;
    const known = new Set((ctTagsCache ? ctTagsCache.tags : []).map((t) => t.name));
    list.forEach((name, i) => {
      const row = ctEl('button', 'ct-sugg-row' + (i === pick ? ' is-on' : ''));
      row.type = 'button';
      row.setAttribute('role', 'option');
      if (known.has(name)) row.appendChild(ctTagChips([name], 1));
      else {
        row.appendChild(ctEl('span', 'ct-sugg-new', t('common.create')));
        row.appendChild(ctTagChips([{ name, color: ctNextColor() }], 1));
      }
      // mousedown, not click: the box's blur would take the list away first.
      row.addEventListener('mousedown', (e) => { e.preventDefault(); add(name); input.focus(); });
      sugg.appendChild(row);
    });
  };
  input.addEventListener('input', () => { pick = -1; paintSugg(); });
  input.addEventListener('focus', paintSugg);
  // Blur does NOT add: a half-typed tag left behind by Escape or a click away
  // is a draft, not a decision. Enter, comma or a suggestion adds.
  input.addEventListener('blur', () => { sugg.hidden = true; });
  wrap.addEventListener('mousedown', (e) => { if (e.target === wrap || e.target === chips) { e.preventDefault(); input.focus(); } });
  input.addEventListener('keydown', (e: KeyboardEvent) => {
    const list = options();
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      pick = list.length ? (pick + (e.key === 'ArrowDown' ? 1 : list.length - 1)) % list.length : -1;
      paintSugg();
    } else if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      add(pick >= 0 && list[pick] ? list[pick] : input.value);
      paintSugg();
    } else if (e.key === 'Backspace' && !input.value && tags.length) {
      tags = tags.slice(0, -1);
      paint();
      onChange(tags);
    }
  });
  paint();
  wrap.appendChild(chips);
  wrap.appendChild(input);
  wrap.appendChild(sugg);
  return wrap;
}

/** The colour a brand-new tag would get — the preview in "Create"; main assigns the real one. */
function ctNextColor(): number {
  const used = new Set((ctTagsCache ? ctTagsCache.tags : []).map((t) => t.color));
  for (let i = 0; i < 8; i += 1) if (!used.has(i)) return i;
  return (ctTagsCache ? ctTagsCache.tags.length : 0) % 8;
}

function ctPopHead(el: HTMLElement, kicker: string, name: string): void {
  const head = ctEl('div', 'ct-pop-head');
  head.appendChild(ctEl('span', 'ct-pop-kicker', kicker));
  head.appendChild(ctEl('span', 'ct-pop-name', name));
  el.appendChild(head);
}

/**
 * Details for a record. `description: false` hides the description — the
 * metric editor has its own box for it, and two boxes for one field would race.
 */
async function ctOpenDetails(anchor: HTMLElement, target: CtTarget, opts: { description?: boolean; onSaved?: () => void } = {}): Promise<void> {
  const projectId = currentProjectId;
  if (!projectId) return;
  const ref = target.kind + ':' + target.id;
  let res: any = null;
  try { res = await window.hub.catalogGet(projectId, ref); } catch (_) { res = null; }
  if (!res || res.ok === false) { showToast(t('catalogDetails.could_not_read_the_details')); return; }
  await ctLoadTags();
  const doc = res.doc || {};
  const saved = { description: String(doc.description || ''), owner: String(doc.owner || '') };
  const kindLabel = (ctKind(target.kind) || { label: t('common.record') }).label;
  let desc: HTMLInputElement | HTMLTextAreaElement | null = null;
  let owner: HTMLInputElement | HTMLTextAreaElement | null = null;
  let tagField: HTMLElement | null = null;
  const stamp = ctEl('p', 'ct-stamp');

  const save = async (patch: Record<string, unknown>): Promise<void> => {
    let r: any = null;
    try { r = await window.hub.catalogSet(projectId, ref, patch); } catch (_) { r = null; }
    if (!r || r.ok === false) { showToast((r && r.error) || t('catalogDetails.could_not_save_the_details')); return; }
    ctStamp(stamp, r.doc);
    if (patch.tags !== undefined) await ctTagsChanged();
    if (opts.onSaved) opts.onSaved();
  };
  const commitText = (field: 'description' | 'owner', value: string): void => {
    const v = value.trim();
    if (v === saved[field]) return;
    saved[field] = v;
    void save({ [field]: v });
  };

  anchor.setAttribute('aria-expanded', 'true');
  openMiniMenu(anchor, (el: HTMLElement) => {
    el.classList.add('ct-pop');
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-label', t('catalogDetails.details_for', { p0: target.name || kindLabel }));
    ctPopHead(el, kindLabel + ' details', target.name || '');
    if (opts.description !== false) {
      desc = ctTextBox(true, saved.description, t('catalogDetails.what_is_this_and_when_should'), (v) => commitText('description', v));
      el.appendChild(ctField(t('common.description'), desc));
    }
    const tagNames = (Array.isArray(doc.tags) ? doc.tags : []).map((t: any) => String(t && t.name ? t.name : t));
    tagField = ctTagEditor(tagNames, (tags) => void save({ tags }));
    el.appendChild(ctField(t('common.tags'), tagField));
    owner = ctTextBox(false, saved.owner, t('catalogDetails.who_to_ask_about_this'), (v) => commitText('owner', v));
    el.appendChild(ctField(t('common.owner'), owner));
    ctStamp(stamp, doc);
    el.appendChild(stamp);
  }, () => {
    // Closing IS the blur: a removed element does not reliably fire one.
    if (desc) commitText('description', desc.value);
    if (owner) commitText('owner', owner.value);
    anchor.setAttribute('aria-expanded', 'false');
  });
  const first = desc || (tagField && tagField.querySelector('input')) || owner;
  if (first) (first as HTMLElement).focus();
}

// ── Columns ──────────────────────────────────────────────────────────────────

const CT_SENSITIVITY: Array<[string, string, string]> = [
  ['none', t('common.none'), t('catalogDetails.nothing_sensitive')],
  ['personal', t('common.personal'), t('catalogDetails.identifies_a_person_names_emails')],
  ['financial', t('common.financial'), t('catalogDetails.money_a_person_or_the_business')],
];

/** Save one column's notes and repaint what shows them. Returns the stored doc. */
async function ctSaveColumn(datasetId: string, column: string, patch: Record<string, unknown>): Promise<CtColDoc | null> {
  if (!currentProjectId) return null;
  let r: any = null;
  try { r = await window.hub.catalogSetColumn(currentProjectId, datasetId, column, patch); } catch (_) { r = null; }
  if (!r || r.ok === false) { showToast((r && r.error) || t('catalogDetails.could_not_save_the_column_notes')); return null; }
  const docs = await ctLoadColumnDocs(datasetId);
  docs[column] = r.column;
  // The grid's header tooltips read this cache; repaint from the window in hand.
  if (datasetId === expId && typeof paintExplorerTable === 'function') paintExplorerTable();
  if (datasetId === expId) ctPaintProfileDoc();
  return r.column;
}

/** The sensitivity choice as three segments — one click, no dropdown. */
function ctSensitivityControl(value: string, onPick: (v: string) => void): HTMLElement {
  const seg = ctEl('div', 'ct-seg');
  seg.setAttribute('role', 'radiogroup');
  seg.setAttribute('aria-label', t('common.sensitivity'));
  const paint = (cur: string): void => {
    seg.querySelectorAll<HTMLElement>('.ct-seg-btn').forEach((b) => {
      const on = b.dataset.value === cur;
      b.classList.toggle('is-on', on);
      b.setAttribute('aria-checked', String(on));
    });
  };
  CT_SENSITIVITY.forEach(([v, label, hint]) => {
    const b = ctEl('button', 'ct-seg-btn ct-seg-btn--' + v, label);
    b.type = 'button';
    b.setAttribute('role', 'radio');
    b.dataset.value = v;
    b.title = hint;
    b.addEventListener('click', () => { paint(v); onPick(v); });
    seg.appendChild(b);
  });
  paint(value || 'none');
  return seg;
}

async function ctOpenColumnDetails(anchor: HTMLElement, datasetId: string, column: string, example = ''): Promise<void> {
  if (!currentProjectId || !datasetId || !column) return;
  const docs = await ctLoadColumnDocs(datasetId, true);
  const doc: CtColDoc = Object.prototype.hasOwnProperty.call(docs, column) ? docs[column] : {};
  const saved: Record<string, string> = {
    displayName: doc.displayName || '', description: doc.description || '', example: doc.example || '',
  };
  const stamp = ctEl('p', 'ct-stamp');
  const boxes: Array<[string, HTMLInputElement | HTMLTextAreaElement]> = [];
  const commit = async (field: string, value: string): Promise<void> => {
    const v = value.trim();
    if (v === saved[field]) return;
    saved[field] = v;
    const d = await ctSaveColumn(datasetId, column, { [field]: v });
    if (d) ctStamp(stamp, d);
  };
  const box = (field: string, multiline: boolean, placeholder: string): HTMLInputElement | HTMLTextAreaElement => {
    const b = ctTextBox(multiline, saved[field], placeholder, (v) => void commit(field, v));
    boxes.push([field, b]);
    return b;
  };

  anchor.setAttribute('aria-expanded', 'true');
  openMiniMenu(anchor, (el: HTMLElement) => {
    el.classList.add('ct-pop');
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-label', t('catalogDetails.details_for_column', { column }));
    ctPopHead(el, t('catalogDetails.column_details'), column);
    el.appendChild(ctField(t('common.display_name'), box('displayName', false, column)));
    el.appendChild(ctField(t('common.description'), box('description', true, t('catalogDetails.what_does_one_value_in_this'))));
    el.appendChild(ctField(t('common.example'), box('example', false, example || t('catalogDetails.a_typical_value'))));
    el.appendChild(ctField(t('common.sensitivity'), ctSensitivityControl(doc.sensitivity || 'none', (v) => {
      void ctSaveColumn(datasetId, column, { sensitivity: v }).then((d) => { if (d) ctStamp(stamp, d); });
    })));
    ctStamp(stamp, doc.updatedAt ? doc : null);
    el.appendChild(stamp);
  }, () => {
    boxes.forEach(([field, b]) => void commit(field, b.value));
    anchor.setAttribute('aria-expanded', 'false');
  });
  if (boxes[0]) boxes[0][1].focus();
}

/** The profile panel's description line, under the column name. */
function ctPaintProfileDoc(): void {
  const host = document.querySelector('#ds-profile .js-dsp-doc') as HTMLElement | null;
  if (!host) return;
  const col = dsProfileCol >= 0 ? expColumns[dsProfileCol] : null;
  const doc = col ? ctColumnDoc(expId, col.name) : null;
  host.textContent = doc && doc.description ? doc.description : '';
  host.hidden = !host.textContent;
}

/** The first non-empty value in the window the grid holds — an example, not a claim. */
function ctFirstValue(c: number): string {
  for (const row of expPageRows) {
    const v = row ? row[c] : null;
    if (v != null && String(v).trim()) return String(v);
  }
  return '';
}

// ── Where the button lives ───────────────────────────────────────────────────
//
// One entry per record header: the button's id and how to read the record
// that header is showing. A story page is one more line here.

const CT_HEADERS: Array<{ btn: string; target: () => CtTarget | null; empty?: string }> = [
  { btn: 'ds-act-details', target: () => (expId ? { kind: 'dataset', id: expId, name: expName } : null) },
  {
    btn: 'viz-details-btn',
    target: () => (vizEditingId ? { kind: 'visual', id: vizEditingId, name: (vizEl('viz-builder-name') || { textContent: '' }).textContent || '' } : null),
    empty: t('catalogDetails.save_the_visual_first_then_it'),
  },
  { btn: 'dash-details-btn', target: () => (dashCurrent && dashCurrent.id ? { kind: 'analysis', id: String(dashCurrent.id), name: String(dashCurrent.name || '') } : null) },
  { btn: 'rp-details-btn', target: () => (rbReport && rbReport.id ? { kind: 'report', id: String(rbReport.id), name: String(rbReport.name || '') } : null) },
  { btn: 'st-details-btn', target: () => (stStory && stStory.id ? { kind: 'story', id: String(stStory.id), name: String(stStory.name || '') } : null) },
];

/** The metric editor's row — tags and owner (its own Description box is right above). */
function ctMetricDetailsRow(metricId: string, name: string): HTMLElement {
  const row = ctEl('div', 'me-field ct-me-row');
  row.appendChild(ctEl('span', 'me-field-label', t('catalogDetails.tags_owner')));
  const line = ctEl('div', 'ct-me-line');
  const chips = ctEl('span', 'ct-me-chips');
  const paint = async (): Promise<void> => {
    await ctLoadTags();
    chips.textContent = '';
    const tags = ctTagsOf('metric:' + metricId);
    chips.appendChild(tags.length ? ctTagChips(tags, 6) : ctEl('span', 'ct-muted', t('catalogDetails.no_tags_yet')));
  };
  const btn = ctEl('button', 'btn btn-sm btn-ghost ct-details-btn', t('common.edit'));
  btn.type = 'button';
  btn.setAttribute('aria-haspopup', 'dialog');
  btn.addEventListener('click', () => void ctOpenDetails(btn, { kind: 'metric', id: metricId, name }, { description: false, onSaved: () => void paint() }));
  line.appendChild(chips);
  line.appendChild(btn);
  row.appendChild(line);
  void paint();
  return row;
}

function initCatalogDetails(): void {
  CT_HEADERS.forEach((h) => {
    const b = document.getElementById(h.btn);
    if (!b) return;
    b.setAttribute('aria-haspopup', 'dialog');
    b.addEventListener('click', () => {
      const tv = h.target();
      if (!tv) { showToast(h.empty || t('catalogDetails.nothing_to_describe_yet')); return; }
      void ctOpenDetails(b, tv, {
        onSaved: () => { if (tv.kind === 'dataset') void ctPaintHeaderChips(document.getElementById('ds-explorer-tags'), 'dataset:' + tv.id); },
      });
    });
  });
  const colBtn = document.querySelector('#ds-profile .js-dsp-details-btn') as HTMLElement | null;
  if (colBtn) {
    colBtn.setAttribute('aria-haspopup', 'dialog');
    colBtn.addEventListener('click', () => {
      const col = dsProfileCol >= 0 ? expColumns[dsProfileCol] : null;
      if (col && expId) void ctOpenColumnDetails(colBtn, expId, col.name, ctFirstValue(dsProfileCol));
    });
  }
}
