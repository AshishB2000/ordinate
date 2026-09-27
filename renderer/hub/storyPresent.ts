// STORY — present mode and the PDF.
//
// Both read the story through storyText.storyPages: a new page at every `#` or
// `##` heading. So the sections a presenter flips through are exactly the
// pages the PDF prints, and exactly the entries in the outline.
//
// The PDF goes THROUGH the reports pipeline (reportWriters.reportBytes), the
// way the capture export does: a story is handed over as one report record
// with one RenderedPage per heading — its prose, its metric table, its charts
// as pictures with their captions. No second document writer.
//
// Classic global-scope script — NO import/export; textContent only.

let stPresentPages: any[] = [];
let stPresentIdx = 0;
let stPresentKeys: ((e: KeyboardEvent) => void) | null = null;

async function stEnterPresent(): Promise<void> {
  if (!stStory) return;
  await stFlush();
  stPresentPages = storyPages(stStory.blocks);
  stPresentIdx = 0;
  const view = stEl('st-present-view');
  if (!view) return;
  view.hidden = false;
  document.documentElement.classList.add('st-presenting');
  stPresentKeys = (e: KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); stExitPresent(); }
    else if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ') { e.preventDefault(); stPresentGo(1); }
    else if (e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); stPresentGo(-1); }
  };
  document.addEventListener('keydown', stPresentKeys, true);
  await stPresentPaint();
}

function stExitPresent(): void {
  const view = stEl('st-present-view');
  if (view) view.hidden = true;
  document.documentElement.classList.remove('st-presenting');
  if (stPresentKeys) document.removeEventListener('keydown', stPresentKeys, true);
  stPresentKeys = null;
  ansTeardown(stEl('st-present-page'));
}

function stPresentGo(d: number): void {
  const next = Math.max(0, Math.min(stPresentPages.length - 1, stPresentIdx + d));
  if (next === stPresentIdx) return;
  stPresentIdx = next;
  void stPresentPaint();
}

/** Bumped per paint: a page flipped while the last one was still fetching its charts must not draw into this one. */
let stPresentSeq = 0;

async function stPresentPaint(): Promise<void> {
  const host = stEl('st-present-page');
  const count = stEl('st-present-count');
  if (!host) return;
  const seq = ++stPresentSeq;
  ansTeardown(host);
  host.textContent = '';
  const page = stPresentPages[stPresentIdx] || { heading: '', level: 0, items: [] };
  if (page.heading) {
    const h = document.createElement(page.level === 1 ? 'h1' : 'h2');
    h.className = 'st-present-h';
    h.textContent = page.heading;
    host.appendChild(h);
  }
  if (count) count.textContent = `${stPresentIdx + 1} / ${stPresentPages.length}`;
  const prev = stEl<HTMLButtonElement>('st-present-prev');
  const next = stEl<HTMLButtonElement>('st-present-next');
  if (prev) prev.disabled = stPresentIdx === 0;
  if (next) next.disabled = stPresentIdx >= stPresentPages.length - 1;
  for (const it of page.items) {
    const b = it.block;
    const slot = document.createElement('div');
    slot.className = 'st-present-item st-block--' + b.kind;
    host.appendChild(slot);
    if (b.kind === 'text') slot.appendChild(stMarkdownDom(it.text || ''));
    else if (b.kind === 'callout') {
      const box = document.createElement('div');
      box.className = 'st-callout st-callout--' + b.tone;
      const ic = document.createElement('span');
      ic.className = 'st-callout-icon';
      ic.appendChild(icon(ST_TONE_ICON[b.tone] || 'info', 16));
      box.appendChild(ic);
      const inner = document.createElement('div');
      inner.className = 'st-callout-body';
      inner.appendChild(stMarkdownDom(b.text));
      box.appendChild(inner);
      slot.appendChild(box);
    } else if (b.kind === 'visual') {
      const got = await stVisualData(b);
      if (seq !== stPresentSeq) return;
      if (!got) continue;
      slot.appendChild(Object.assign(document.createElement('div'), { className: 'st-fig-title', textContent: got.visual.name || '' }));
      const area = document.createElement('div');
      area.className = 'st-chart st-chart--present cv-viz-area';
      slot.appendChild(area);
      const cap = typeof b.caption === 'string' && b.caption.trim() ? b.caption : got.caption;
      if (cap) slot.appendChild(Object.assign(document.createElement('p'), { className: 'st-present-caption', textContent: cap }));
      renderVizInArea(area, got.data, got.visual.chartType || 'column', null, '');
    } else if (b.kind === 'metric' || b.kind === 'metrics_row') {
      await stRenderMetrics(slot, b);
      if (seq !== stPresentSeq) return;
      slot.querySelectorAll('textarea').forEach((n) => { (n as HTMLTextAreaElement).readOnly = true; });
    } else if (b.kind === 'image') {
      const img = document.createElement('img');
      img.className = 'st-img';
      img.src = b.src;
      img.alt = b.alt || '';
      slot.appendChild(img);
      if (b.caption) slot.appendChild(Object.assign(document.createElement('p'), { className: 'st-present-caption', textContent: b.caption }));
    } else if (b.kind === 'divider') slot.appendChild(Object.assign(document.createElement('hr'), { className: 'st-hr' }));
  }
}

// ── Export ───────────────────────────────────────────────────────────────────

/** A text item's Markdown → the paragraphs a report page prints (lists as bullets). */
function stPlainParagraphs(src: string): string[] {
  const out: string[] = [];
  stMdParse(src).forEach((n: any) => {
    const plain = (inl: any[]) => inl.map((x: any) => x.text).join('');
    if (n.t === 'ul' || n.t === 'ol') out.push(n.items.map((it: any, i: number) => (n.t === 'ol' ? `${i + 1}. ` : '• ') + plain(it)).join('\n'));
    else if (n.t === 'h') out.push(n.text);
    else out.push(plain(n.inl));
  });
  return out;
}

/** The story's pages → the RenderedPage list reportBytes takes. Exported shape documented in reportRender.ts. */
async function stReportPages(report: any): Promise<any[]> {
  const box = reportPageBox(report);
  const frame = { themeClasses: [] as string[], width: Math.round(box.width * 0.84), height: Math.round(box.height * 0.36) };
  const out: any[] = [];
  for (const page of storyPages(stStory.blocks)) {
    const rp: any = { kind: 'sheet', layout: 'full', title: page.heading || stStory.name };
    const paras: string[] = [];
    const kpis: Array<{ label: string; value: string }> = [];
    const pics: Array<{ title: string; png: string | null; caption: string }> = [];
    for (const it of page.items) {
      const b = it.block;
      if (b.kind === 'text') paras.push(...stPlainParagraphs(it.text || ''));
      else if (b.kind === 'callout') paras.push(...stPlainParagraphs(b.text).map((p) => '▍ ' + p));
      else if (b.kind === 'metric' || b.kind === 'metrics_row') {
        (await stMetricFigures(b)).forEach((f) => kpis.push({ label: f.name, value: f.display }));
      } else if (b.kind === 'visual') {
        const got = await stVisualData(b, 'report');
        if (!got) continue;
        let png: string | null = null;
        if (!got.hidden) {
          try { png = await captureChartPNG(got.visual.chartType || 'column', got.data, got.visual.overrides || {}, frame); } catch (_) { png = null; }
        }
        pics.push({ title: got.visual.name || '', png, caption: got.hidden || (typeof b.caption === 'string' && b.caption.trim() ? b.caption : got.caption) });
      } else if (b.kind === 'image') {
        pics.push({ title: b.caption || b.alt || '', png: b.src, caption: b.caption || '' });
      }
    }
    if (paras.length) rp.body = paras.join('\n\n');
    if (kpis.length) rp.kpis = kpis;
    if (pics.length === 1) { rp.png = pics[0].png; rp.caption = pics[0].caption; }
    if (pics.length > 1) {
      rp.tiles = pics.map((p) => ({ title: p.title, png: p.png }));
      rp.caption = pics.map((p) => p.caption).filter(Boolean).join(' ');
    }
    out.push(rp);
  }
  return out;
}

/** The datasets the story's visual blocks draw from — what the share policy is asked about. */
async function stDatasetIds(): Promise<string[]> {
  const ids = new Set<string>();
  for (const b of (stStory && Array.isArray(stStory.blocks) ? stStory.blocks : [])) {
    if (!b || b.kind !== 'visual' || !b.visualId || !currentProjectId) continue;
    try {
      const v = await window.hub.getVisual(currentProjectId, b.visualId);
      if (v && v.datasetId) ids.add(String(v.datasetId));
    } catch (_) { /* a removed visual exports nothing */ }
  }
  return [...ids];
}

/** Export the open story as ONE report, a page per heading, and save it through the native panel. */
async function stExportPdf(): Promise<void> {
  if (!stStory) return;
  await stFlush();
  if (!(await pvShareGate('report', await stDatasetIds()))) return;
  const report = {
    name: stStory.name, format: 'pdf',
    paper: { size: 'letter', orientation: 'portrait' },
    cover: { title: stStory.name },
  };
  showToast('Building the PDF…');
  let base64 = '';
  try {
    base64 = (await reportBytes(await stReportPages(report), report)).base64;
  } catch (e) {
    console.error('[story] export failed', e);
  }
  if (!base64) { showToast('Couldn’t build the PDF.'); return; }
  try {
    const res = await window.hub.savePdf(base64, reportFilename(stStory.name, 'pdf'));
    if (res && res.ok) showToast(`Saved: ${String(res.dest).split(/[\\/]/).pop()}`);
    else if (!res || !res.canceled) showToast('Save failed');
  } catch (_) {
    showToast('Save failed');
  }
}

function initStoryPresent(): void {
  const prev = stEl('st-present-prev');
  if (prev) prev.addEventListener('click', () => stPresentGo(-1));
  const next = stEl('st-present-next');
  if (next) next.addEventListener('click', () => stPresentGo(1));
  const exit = stEl('st-present-exit');
  if (exit) exit.addEventListener('click', () => stExitPresent());
}
