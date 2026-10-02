// STORY PICKERS — the `/` block picker, and the pickers behind it: a saved
// visual, one metric or a row of them, an image from disk, a filter pinned to a
// chart block. Each ends in a block handed back to storyPage.ts; nothing here
// saves anything itself.
//
// One popover primitive (stPopover) rather than openMiniMenu: that one aligns
// to its anchor's RIGHT edge, which is right for a ⋯ button and wrong for a
// menu opening from the start of a line of text.
//
// Classic global-scope script — NO import/export; textContent only.

const ST_KIND_LABEL: Record<string, string> = {
  text: t('common.text'), heading: t('common.heading'), visual: 'Chart', metric: t('common.metric'), metrics_row: t('storyPickers.metrics_row'),
  image: t('common.image'), divider: t('common.divider'), callout: t('storyPickers.callout'),
};
const ST_PICKER_ITEMS: Array<{ kind: string; icon: string; hint: string }> = [
  { kind: 'text', icon: 'type-text', hint: t('storyPickers.a_paragraph_markdown_works') },
  { kind: 'heading', icon: 'list', hint: t('storyPickers.a_section_it_opens_a_page') },
  { kind: 'visual', icon: 'chart-bar', hint: t('storyPickers.a_saved_chart_live') },
  { kind: 'metric', icon: 'zap', hint: t('storyPickers.one_named_number_live') },
  { kind: 'metrics_row', icon: 'columns', hint: t('storyPickers.up_to_four_metrics_side_by') },
  { kind: 'image', icon: 'camera', hint: t('storyPickers.a_picture_from_your_computer') },
  { kind: 'divider', icon: 'minus', hint: t('storyPickers.a_rule_across_the_page') },
  { kind: 'callout', icon: 'info', hint: t('storyPickers.a_highlighted_note') },
];

/** Max image size as a data: URL — the store's own bound (storyModel.MAX_IMAGE_CHARS). */
const ST_MAX_IMAGE_CHARS = 2_800_000;

let stPopoverClose: (() => void) | null = null;

/** A left-aligned popover under `anchor`. Outside click and Escape close it. */
function stPopover(anchor: HTMLElement, build: (el: HTMLElement, close: () => void) => void, onClose?: () => void): () => void {
  if (stPopoverClose) stPopoverClose();
  const el = document.createElement('div');
  el.className = 'chart-menu st-pop';
  el.setAttribute('role', 'menu');
  const ac = new AbortController();
  const close = (): void => {
    ac.abort();
    el.remove();
    if (stPopoverClose === close) stPopoverClose = null;
    if (onClose) onClose();
  };
  stPopoverClose = close;
  build(el, close);
  document.body.appendChild(el);
  const r = anchor.getBoundingClientRect();
  const w = el.offsetWidth || 260;
  const h = el.offsetHeight || 240;
  const left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8));
  let top = r.bottom + 4;
  if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 4);
  el.style.left = left + 'px';
  el.style.top = top + 'px';
  setTimeout(() => {
    document.addEventListener('mousedown', (e) => {
      if (!el.contains(e.target as Node) && e.target !== anchor) close();
    }, { capture: true, signal: ac.signal });
  }, 0);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); } },
    { capture: true, signal: ac.signal });
  return close;
}

/**
 * The block picker. With `filterFrom` (the `/` in a text line) it filters by
 * what follows the slash and takes ↑ ↓ Enter from that field, so typing never
 * leaves the line; from the "+" button it takes the keyboard itself.
 */
function stOpenPicker(
  anchor: HTMLElement,
  onPick: (kind: string) => void,
  opts: { filterFrom?: HTMLTextAreaElement; onClose?: () => void } = {},
): void {
  let active = 0;
  let rows: HTMLButtonElement[] = [];
  let picked = false;
  let unhook = (): void => { /* set once the field's listeners are attached */ };
  const input = opts.filterFrom;
  stPopover(anchor, (el, closeFn) => {
    el.classList.add('st-picker');
    const title = document.createElement('div');
    title.className = 'st-picker-h';
    title.textContent = t('storyPickers.add_a_block');
    el.appendChild(title);
    const paint = (): void => {
      el.querySelectorAll('.st-picker-row, .st-picker-none').forEach((n) => n.remove());
      const q = input ? input.value.replace(/^\//, '').toLowerCase() : '';
      const items = ST_PICKER_ITEMS.filter((it) => !q || ST_KIND_LABEL[it.kind].toLowerCase().includes(q) || it.kind.includes(q));
      active = Math.min(active, Math.max(0, items.length - 1));
      rows = items.map((it, i) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'chart-menu-item st-picker-row' + (i === active ? ' is-active' : '');
        b.dataset.kind = it.kind;
        b.appendChild(icon(it.icon, 16));
        const text = document.createElement('span');
        text.className = 'st-picker-text';
        text.appendChild(Object.assign(document.createElement('span'), { className: 'st-picker-label', textContent: ST_KIND_LABEL[it.kind] }));
        text.appendChild(Object.assign(document.createElement('span'), { className: 'st-picker-hint', textContent: it.hint }));
        b.appendChild(text);
        b.addEventListener('mousedown', (e) => e.preventDefault()); // keep the caret in the line
        b.addEventListener('click', () => { picked = true; closeFn(); onPick(it.kind); });
        el.appendChild(b);
        return b;
      });
      if (!rows.length) el.appendChild(Object.assign(document.createElement('div'), { className: 'st-picker-none', textContent: t('storyPickers.no_block_by_that_name') }));
    };
    paint();
    const move = (d: number): void => {
      if (!rows.length) return;
      active = (active + d + rows.length) % rows.length;
      rows.forEach((r, i) => r.classList.toggle('is-active', i === active));
      rows[active].scrollIntoView({ block: 'nearest' });
    };
    const keys = (e: KeyboardEvent): void => {
      if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
      else if (e.key === 'Enter' && rows[active]) { e.preventDefault(); rows[active].click(); }
    };
    if (input) {
      const onInput = (): void => { if (!/^\/\S*$/.test(input.value)) closeFn(); else paint(); };
      input.addEventListener('input', onInput);
      input.addEventListener('keydown', keys);
      unhook = () => { input.removeEventListener('input', onInput); input.removeEventListener('keydown', keys); };
    } else {
      el.addEventListener('keydown', keys);
      setTimeout(() => { if (rows[0]) rows[0].focus(); }, 0);
    }
  }, () => {
    unhook();
    if (!picked && opts.onClose) opts.onClose();
  });
}

/**
 * A picked kind → a new block, asking for whatever it references; null if the
 * user backed out. `any`: a story block's shape is owned by
 * src/analysis/storyModel.ts, which re-validates it on save.
 */
async function stMakeBlock(kind: string): Promise<any> {
  const id = stNewId();
  if (kind === 'text') return { id, kind: 'text', text: '' };
  if (kind === 'heading') return { id, kind: 'text', text: '## ' };
  if (kind === 'divider') return { id, kind: 'divider' };
  if (kind === 'callout') return { id, kind: 'callout', tone: 'info', text: '' };
  if (kind === 'visual') {
    const visualId = await stChooseVisual();
    return visualId ? { id, kind: 'visual', visualId, filters: [] } : null;
  }
  if (kind === 'metric' || kind === 'metrics_row') {
    const ids = await stChooseMetrics(kind === 'metrics_row' ? 4 : 1);
    if (!ids.length) return null;
    return kind === 'metric' || ids.length === 1
      ? { id, kind: 'metric', metricId: ids[0], filters: [] }
      : { id, kind: 'metrics_row', metricIds: ids, filters: [] };
  }
  if (kind === 'image') {
    const img = await stChooseImage();
    return img ? { id, kind: 'image', src: img.src, alt: img.alt } : null;
  }
  return null;
}

/** A modal list with a search box — the shape both record pickers share. */
function stChooser<T>(title: string, items: T[], label: (t: T) => string, sub: (t: T) => string, multi: number): Promise<T[]> {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'ws-modal-overlay';
    const box = document.createElement('div');
    box.className = 'ws-modal st-chooser';
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-label', title);
    box.appendChild(Object.assign(document.createElement('div'), { className: 'ws-modal-title', textContent: title }));
    const search = Object.assign(document.createElement('input'), { className: 'ws-modal-input', type: 'search', placeholder: t('common.search') });
    box.appendChild(search);
    const list = document.createElement('div');
    list.className = 'st-chooser-list';
    box.appendChild(list);
    const chosen: T[] = [];
    const actions = document.createElement('div');
    actions.className = 'ws-modal-actions';
    const cancel = Object.assign(document.createElement('button'), { type: 'button', className: 'btn', textContent: t('common.cancel') });
    const add = Object.assign(document.createElement('button'), { type: 'button', className: 'btn btn-primary', textContent: t('common.add') });
    add.disabled = true;
    actions.appendChild(cancel);
    if (multi > 1) actions.appendChild(add);
    box.appendChild(actions);
    overlay.appendChild(box);
    const done = (out: T[]): void => { overlay.remove(); resolve(out); };
    const paint = (): void => {
      list.textContent = '';
      const q = search.value.trim().toLowerCase();
      const shown = items.filter((t) => !q || label(t).toLowerCase().includes(q));
      if (!shown.length) list.appendChild(Object.assign(document.createElement('div'), { className: 'st-chooser-none', textContent: items.length ? t('storyPickers.nothing_matches') : t('storyPickers.nothing_saved_in_this_project_yet') }));
      shown.forEach((tv) => {
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'st-chooser-row' + (chosen.includes(tv) ? ' is-chosen' : '');
        row.appendChild(Object.assign(document.createElement('span'), { className: 'st-chooser-label', textContent: label(tv) }));
        row.appendChild(Object.assign(document.createElement('span'), { className: 'st-chooser-sub', textContent: sub(tv) }));
        row.addEventListener('click', () => {
          if (multi <= 1) { done([tv]); return; }
          const at = chosen.indexOf(tv);
          if (at >= 0) chosen.splice(at, 1); else if (chosen.length < multi) chosen.push(tv);
          add.disabled = chosen.length === 0;
          add.textContent = chosen.length ? t('storyPickers.add', { chosenCount: chosen.length }) : t('common.add');
          paint();
        });
        list.appendChild(row);
      });
    };
    search.addEventListener('input', paint);
    cancel.addEventListener('click', () => done([]));
    add.addEventListener('click', () => done(chosen.slice()));
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) done([]); });
    box.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); done([]); } });
    paint();
    document.body.appendChild(overlay);
    search.focus();
  });
}

async function stChooseVisual(): Promise<string> {
  let list: any[] = [];
  try { list = currentProjectId ? await window.hub.listVisuals(currentProjectId) : []; } catch (_) { list = []; }
  const got = await stChooser(t('storyPickers.add_a_chart'), Array.isArray(list) ? list : [], (v: any) => String(v.name || t('common.untitled_visual')),
    (v: any) => VIZ_LABELS[v.chartType] || String(v.chartType || ''), 1);
  return got[0] ? String((got[0] as any).id) : '';
}

async function stChooseMetrics(max: number): Promise<string[]> {
  let list: any[] = [];
  try { list = currentProjectId ? await window.hub.listMetrics(currentProjectId) : []; } catch (_) { list = []; }
  const got = await stChooser(max > 1 ? t('storyPickers.add_up_to_metrics', { max }) : t('common.add_a_metric'), Array.isArray(list) ? list : [],
    (m: any) => String(m.name || t('common.metric')), (m: any) => String(m.description || ''), max);
  return got.map((m: any) => String(m.id));
}

function stChooseImage(): Promise<{ src: string; alt: string } | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/png,image/jpeg,image/gif,image/webp';
    input.addEventListener('change', () => {
      const f = input.files && input.files[0];
      if (!f) { resolve(null); return; }
      const r = new FileReader();
      r.onload = () => {
        const src = String(r.result || '');
        if (src.length > ST_MAX_IMAGE_CHARS) { showToast(t('storyPickers.that_image_is_too_large_up')); resolve(null); return; }
        resolve({ src, alt: f.name.replace(/\.[a-z0-9]+$/i, '') });
      };
      r.onerror = () => resolve(null);
      r.readAsDataURL(f);
    });
    input.addEventListener('cancel', () => resolve(null));
    input.click();
  });
}

const ST_PIN_OPS = ['=', '!=', '>', '<', '>=', '<=', 'contains', 'in'];

/** Pin a filter to one chart block: column, operator, value — applied on top of the visual's own. */
async function stPinFilter(anchor: HTMLElement, block: any, visual: any): Promise<void> {
  let meta: any = null;
  try { meta = currentProjectId ? await window.hub.getDatasetMeta(currentProjectId, visual.datasetId) : null; } catch (_) { meta = null; }
  const cols: Array<{ name: string; type: string }> = meta && Array.isArray(meta.columns) ? meta.columns : [];
  if (!cols.length) { showToast(t('storyPickers.that_chart_s_dataset_could_not')); return; }
  stPopover(anchor, (el, close) => {
    el.classList.add('st-pinform');
    const col = document.createElement('select');
    col.className = 'st-pinform-field';
    cols.forEach((c) => col.appendChild(Object.assign(document.createElement('option'), { value: c.name, textContent: c.name })));
    const op = document.createElement('select');
    op.className = 'st-pinform-field';
    ST_PIN_OPS.forEach((o) => op.appendChild(Object.assign(document.createElement('option'), { value: o, textContent: o })));
    const val = Object.assign(document.createElement('input'), { className: 'st-pinform-field', type: 'text', placeholder: t('storyPickers.value_comma_separate_for_in') });
    const add = Object.assign(document.createElement('button'), { type: 'button', className: 'btn btn-primary btn-sm', textContent: t('storyPickers.pin_filter') });
    add.addEventListener('click', () => {
      const c = cols.find((x) => x.name === col.value);
      const raw = val.value.trim();
      if (!c || !raw) return;
      const cast = (s: string): string | number => (c.type === 'number' && s.trim() !== '' && Number.isFinite(Number(s)) ? Number(s) : s.trim());
      const step: any = { type: 'filter', column: c.name, op: op.value };
      if (op.value === 'in') step.values = raw.split(',').map(cast); else step.value = cast(raw);
      block.filters = (block.filters || []).concat([step]);
      close();
      stCommit(t('storyPickers.pin_filter'), { render: true });
    });
    val.addEventListener('keydown', (e) => { if (e.key === 'Enter') add.click(); });
    [col, op, val, add].forEach((n) => el.appendChild(n));
    setTimeout(() => val.focus(), 0);
  });
}
