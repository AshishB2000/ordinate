// STORY BLOCKS — how each kind of block looks, and how it is edited in place.
//
//   text     Markdown (storyText.ts), drawn as a document; click to edit the
//            source in an auto-growing field; `/` in an empty line opens the
//            block picker (storyPickers.ts).
//   visual   a LIVE chart: the saved visual computed by main under its own
//            filters plus any pinned to this block, with the app's caption
//            unless the author wrote one.
//   metric / metrics_row   live figures, formatted by main (metric:value).
//   image, divider, callout.
//
// Every figure is fetched when the block draws — a story stores ids, never
// numbers. Classic global-scope script — NO import/export; textContent only.

const ST_TONE_ICON: Record<string, string> = { info: 'info', success: 'check', warning: 'alert', danger: 'alert' };

/** Markdown tokens → DOM. textContent only; a link is text with its URL as a title. */
function stInlineDom(parent: HTMLElement, inl: Array<{ t: string; text: string; href?: string }>): void {
  inl.forEach((x) => {
    if (x.t === 'text') { parent.appendChild(document.createTextNode(x.text)); return; }
    const tag = x.t === 'b' ? 'strong' : x.t === 'i' ? 'em' : x.t === 'code' ? 'code' : 'span';
    const el = document.createElement(tag);
    el.textContent = x.text;
    if (x.t === 'link') { el.className = 'st-link'; if (x.href) el.title = x.href; }
    parent.appendChild(el);
  });
}

function stMarkdownDom(src: string): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'st-md';
  mdParse(src).forEach((n: any) => {
    let el: HTMLElement;
    if (n.t === 'h') {
      el = document.createElement('h' + Math.min(3, n.level));
      el.className = 'st-h st-h' + n.level;
      stInlineDom(el, n.inl);
    } else if (n.t === 'ul' || n.t === 'ol') {
      el = document.createElement(n.t);
      n.items.forEach((it: any) => { const li = document.createElement('li'); stInlineDom(li, it); el.appendChild(li); });
    } else if (n.t === 'quote') {
      el = document.createElement('blockquote');
      stInlineDom(el, n.inl);
    } else {
      el = document.createElement('p');
      stInlineDom(el, n.inl);
    }
    wrap.appendChild(el);
  });
  return wrap;
}

function stRenderBlock(body: HTMLElement, block: any): void {
  body.textContent = '';
  if (block.kind === 'text') stRenderText(body, block);
  else if (block.kind === 'callout') stRenderCallout(body, block);
  else if (block.kind === 'visual') void stRenderVisual(body, block);
  else if (block.kind === 'metric' || block.kind === 'metrics_row') void stRenderMetrics(body, block);
  else if (block.kind === 'image') stRenderImage(body, block);
  else if (block.kind === 'divider') body.appendChild(Object.assign(document.createElement('hr'), { className: 'st-hr' }));
}

// ── Text (and the text half of a callout) ────────────────────────────────────

function stRenderText(body: HTMLElement, block: any): void {
  if (stEditingId === block.id) { stTextEditor(body, block); return; }
  let view: HTMLElement;
  if (!block.text.trim()) {
    view = document.createElement('div');
    view.className = 'st-placeholder';
    view.textContent = 'Type / for charts, metrics and more — or just write. # makes a heading.';
  } else {
    view = stMarkdownDom(block.text);
  }
  view.classList.add('is-editable');
  view.tabIndex = 0;
  view.setAttribute('role', 'button');
  view.setAttribute('aria-label', 'Edit text');
  view.addEventListener('click', () => stEditBlock(block.id));
  view.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); stEditBlock(block.id); } });
  body.appendChild(view);
}

function stEditBlock(id: string): void {
  stEditingId = id;
  const row = document.getElementById('st-b-' + id);
  const block = stStory && stStory.blocks.find((b: any) => b.id === id);
  if (!row || !block) return;
  const body = row.querySelector('.st-block-body') as HTMLElement;
  stRenderBlock(body, block);
  const ta = body.querySelector('textarea') as HTMLTextAreaElement | null;
  if (ta) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }
}

function stAutoGrow(ta: HTMLTextAreaElement): void {
  ta.style.height = 'auto';
  ta.style.height = ta.scrollHeight + 'px';
}

function stTextEditor(body: HTMLElement, block: any): void {
  const ta = document.createElement('textarea');
  ta.className = 'st-text-input';
  ta.value = block.text;
  ta.rows = 1;
  ta.placeholder = block.kind === 'callout' ? 'Callout text' : 'Type / for blocks';
  ta.setAttribute('aria-label', block.kind === 'callout' ? 'Callout text' : 'Text');
  body.appendChild(ta);
  requestAnimationFrame(() => stAutoGrow(ta));
  let picking = false;
  ta.addEventListener('input', () => {
    block.text = ta.value;
    stAutoGrow(ta);
    stCommit('Edit text', { coalesce: true });
    if (ta.value.trim() && !/^\/\S*$/.test(ta.value)) stSyncTail();
    // `/` typed into an EMPTY text line opens the block picker, which then
    // filters by whatever follows the slash.
    if (block.kind === 'text' && /^\/\S*$/.test(ta.value)) {
      if (!picking) {
        picking = true;
        stOpenPicker(ta, (kind) => {
          picking = false;
          void stPickInto(block.id, kind);
        }, { filterFrom: ta, onClose: () => { picking = false; } });
      }
    }
  });
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !picking) { e.preventDefault(); ta.blur(); return; }
    // Backspace in an empty line removes it — unless it is the last one.
    if (e.key === 'Backspace' && ta.value === '' && block.kind === 'text') {
      const i = stIndexOf(block.id);
      if (i > 0 && i < stStory.blocks.length - 1) {
        e.preventDefault();
        const prev = stStory.blocks[i - 1];
        stStory.blocks.splice(i, 1);
        stEditingId = prev.kind === 'text' ? prev.id : '';
        stCommit('Delete block', { render: true });
        if (stEditingId) stEditBlock(stEditingId);
      }
    }
  });
  ta.addEventListener('blur', () => {
    // A click into the picker must not end the edit under it.
    setTimeout(() => {
      // A field that was REPLACED (the picker re-opened this same line's editor)
      // must not tear down its successor.
      if (!ta.isConnected || picking || document.activeElement === ta) return;
      if (stEditingId === block.id) stEditingId = '';
      if (document.body.contains(body)) stRenderBlock(body, block);
    }, 0);
  });
}

/** The / picker's choice for an empty line: text stays text, anything else replaces the line. */
async function stPickInto(id: string, kind: string): Promise<void> {
  const block = stStory && stStory.blocks.find((b: any) => b.id === id);
  if (!block) return;
  if (kind === 'text' || kind === 'heading') {
    block.text = kind === 'heading' ? '## ' : '';
    stCommit('Edit text');
    stEditBlock(id);
    return;
  }
  const made = await stMakeBlock(kind);
  if (!made) {
    block.text = '';
    stEditBlock(id);
    return;
  }
  stEditingId = '';
  stReplaceBlock(id, made, 'Add ' + (ST_KIND_LABEL[kind] || 'block').toLowerCase());
  if (made.kind === 'callout') stEditBlock(made.id);
}

function stRenderCallout(body: HTMLElement, block: any): void {
  const box = document.createElement('div');
  box.className = 'st-callout st-callout--' + block.tone;
  const tone = document.createElement('button');
  tone.type = 'button';
  tone.className = 'st-callout-icon';
  iconOnly(tone, ST_TONE_ICON[block.tone] || 'info', 'Change the callout style');
  tone.addEventListener('click', (e) => {
    e.stopPropagation();
    const order = ['info', 'success', 'warning', 'danger'];
    block.tone = order[(order.indexOf(block.tone) + 1) % order.length];
    stCommit('Callout style', { render: true });
  });
  box.appendChild(tone);
  const inner = document.createElement('div');
  inner.className = 'st-callout-body';
  box.appendChild(inner);
  body.appendChild(box);
  if (stEditingId === block.id) { stTextEditor(inner, block); return; }
  if (block.text.trim()) inner.appendChild(stMarkdownDom(block.text));
  else inner.appendChild(Object.assign(document.createElement('div'), { className: 'st-placeholder', textContent: 'Write the callout…' }));
  inner.classList.add('is-editable');
  inner.addEventListener('click', () => stEditBlock(block.id));
}

// ── Captions ─────────────────────────────────────────────────────────────────

/**
 * A block's caption: the author's words when written, else the app's own shown
 * as the placeholder — so clearing the field brings the app's caption back
 * rather than leaving a blank. A textarea sized to its content (CSS
 * `field-sizing`), so a long caption wraps instead of scrolling out of sight.
 */
function stCaptionField(block: any): HTMLTextAreaElement {
  const cap = document.createElement('textarea');
  cap.className = 'st-caption';
  cap.rows = 1;
  cap.setAttribute('aria-label', 'Caption');
  cap.value = typeof block.caption === 'string' ? block.caption : '';
  cap.addEventListener('input', () => {
    if (cap.value.trim()) block.caption = cap.value; else delete block.caption;
    stCommit('Edit caption', { coalesce: true });
  });
  cap.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); cap.blur(); } });
  return cap;
}

// ── Visual ───────────────────────────────────────────────────────────────────

/** The saved visual + its data under visual AND pinned filters. Shared by the page, present mode and the export. */
async function stVisualData(block: any): Promise<{ visual: any; data: any; caption: string } | null> {
  if (!currentProjectId) return null;
  let v: any = null;
  try { v = await window.hub.getVisual(currentProjectId, block.visualId); } catch (_) { v = null; }
  if (!v) return null;
  const filters = mergeDashFilters(block.filters || [], v.filters || []);
  let res: any = null;
  try { res = await window.hub.computeVisualData(currentProjectId, v.datasetId, v.encoding, filters); } catch (_) { res = null; }
  const data = res && res.ok !== false && res.data ? res.data : { labels: [], series: [] };
  let caption = '';
  try {
    caption = await window.hub.reportsCaption({ chartType: v.chartType, data, geo: data.geo || null, pivot: data.pivot || null,
      projectId: currentProjectId, datasetId: v.datasetId, overrides: v.overrides || {} });
  } catch (_) { caption = ''; }
  return { visual: v, data, caption: typeof caption === 'string' ? caption : '' };
}

async function stRenderVisual(body: HTMLElement, block: any): Promise<void> {
  const fig = document.createElement('figure');
  fig.className = 'st-figure';
  const head = document.createElement('div');
  head.className = 'st-fig-head';
  const title = document.createElement('div');
  title.className = 'st-fig-title';
  title.textContent = 'Loading chart…';
  head.appendChild(title);
  const chips = document.createElement('div');
  chips.className = 'st-fig-filters';
  head.appendChild(chips);
  fig.appendChild(head);
  const area = document.createElement('div');
  area.className = 'st-chart cv-viz-area';
  fig.appendChild(area);
  const cap = stCaptionField(block);
  fig.appendChild(cap);
  body.appendChild(fig);

  const got = await stVisualData(block);
  if (!got) {
    title.textContent = 'This chart no longer exists';
    fig.classList.add('is-missing');
    cap.hidden = true;
    return;
  }
  title.textContent = String(got.visual.name || 'Chart');
  // Empty means "the app's caption": shown as the placeholder, so clearing the
  // field brings it back rather than leaving a blank.
  cap.placeholder = got.caption || 'Add a caption';
  stPaintPinned(chips, block, got.visual);
  if (document.body.contains(area)) renderVizInArea(area, got.data, got.visual.chartType || 'column', null, '');
}

function stPaintPinned(host: HTMLElement, block: any, visual: any): void {
  host.textContent = '';
  (block.filters || []).forEach((f: any, i: number) => {
    const chip = document.createElement('span');
    chip.className = 'st-pin';
    const v = Array.isArray(f.values) ? f.values.join(', ') : f.value === undefined ? '' : String(f.value);
    chip.textContent = `${f.column} ${f.op}${v ? ' ' + v : ''}`;
    const x = document.createElement('button');
    x.type = 'button';
    x.className = 'st-pin-x';
    iconOnly(x, 'x', 'Remove this filter', 12);
    x.addEventListener('click', () => { block.filters.splice(i, 1); stCommit('Remove filter', { render: true }); });
    chip.appendChild(x);
    host.appendChild(chip);
  });
  const add = document.createElement('button');
  add.type = 'button';
  add.className = 'st-pin-add';
  iconLabel(add, 'filter', 'Pin a filter', 12);
  add.addEventListener('click', () => { void stPinFilter(add, block, visual); });
  host.appendChild(add);
}

// ── Metrics ──────────────────────────────────────────────────────────────────

async function stMetricFigures(block: any): Promise<Array<{ name: string; display: string; value: number | null }>> {
  const ids = block.kind === 'metric' ? [block.metricId] : block.metricIds || [];
  const out: Array<{ name: string; display: string; value: number | null }> = [];
  for (const id of ids) {
    let r: any = null;
    try { r = currentProjectId ? await window.hub.metricValue(currentProjectId, id, block.filters || []) : null; } catch (_) { r = null; }
    out.push(r && r.ok !== false && r.name
      ? { name: String(r.name), display: String(r.display ?? '—'), value: typeof r.value === 'number' ? r.value : null }
      : { name: 'Missing metric', display: '—', value: null });
  }
  return out;
}

async function stRenderMetrics(body: HTMLElement, block: any): Promise<void> {
  const row = document.createElement('div');
  row.className = 'st-metrics' + (block.kind === 'metric' ? ' st-metrics--one' : '');
  body.appendChild(row);
  const figs = await stMetricFigures(block);
  figs.forEach((f) => {
    const tile = document.createElement('div');
    tile.className = 'st-metric';
    tile.appendChild(Object.assign(document.createElement('div'), { className: 'st-metric-value', textContent: f.display }));
    tile.appendChild(Object.assign(document.createElement('div'), { className: 'st-metric-name', textContent: f.name }));
    row.appendChild(tile);
  });
  if (block.kind === 'metric') {
    const cap = stCaptionField(block);
    let app = '';
    try { app = await window.hub.reportsCaption({ kpis: figs.map((f) => ({ label: f.name, value: f.value })) }); } catch (_) { app = ''; }
    cap.placeholder = app || 'Add a caption';
    body.appendChild(cap);
  }
}

// ── Image ────────────────────────────────────────────────────────────────────

function stRenderImage(body: HTMLElement, block: any): void {
  const fig = document.createElement('figure');
  fig.className = 'st-figure st-figure--image';
  const img = document.createElement('img');
  img.className = 'st-img';
  img.src = block.src;
  img.alt = block.alt || '';
  fig.appendChild(img);
  const cap = stCaptionField(block);
  cap.placeholder = 'Add a caption';
  fig.appendChild(cap);
  body.appendChild(fig);
}
