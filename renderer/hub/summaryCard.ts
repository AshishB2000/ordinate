'use strict';

// The Summary card — three to five sentences about what the dashboard's own
// tiles say under the current filters, selection, parameters and "as of" time.
// Classic global-scope renderer <script>; main composes every sentence
// (src/ipc/summary.ts → src/analysis/summaryCard.ts) and this file only draws
// them. The card stores nothing: renderDashGrid re-renders it on every filter,
// selection, parameter and "as of" change, and each render asks main again.
//
// Each sentence links to the tile it came from (scroll + pulse). "Rewrite"
// asks a model to narrate the same facts, audited against their ledger in
// main; the app's sentences are what shows without a model and whenever a
// rewrite is refused.

const SUM_ICONS: Record<string, string> = {
  kpi: 'trending-up', driver: 'chart-bar', insight: 'sparkles', quality: 'shield', alert: 'bell',
};
const SUM_KIND_LABEL: Record<string, string> = {
  kpi: 'Headline', driver: 'Largest contributor', insight: 'Insight', quality: 'Data quality', alert: 'Alert',
};
/** A summary card's grid footprint: the full width, room for five sentences. */
const SUM_LAYOUT = { x: 0, y: 0, w: 12, h: 4 };

/** Prose a Rewrite returned, per card — shown while the facts it narrates are unchanged. */
const sumProse = new Map<string, { key: string; text: string }>();

/** One request shape for every caller: the card, an export, a report run. */
function sumRequest(opts: { projectId?: string; analysis?: any; pages?: any[]; filters?: any[]; params?: any[]; asOf?: string | null; outbound?: boolean } = {}): any {
  const a = opts.analysis || dashCurrent || {};
  return {
    projectId: opts.projectId || currentProjectId,
    analysisId: a.id ? String(a.id) : '',
    name: a.name || '',
    pages: opts.pages || a.pages || a.sheets || [],
    filters: opts.filters || effectiveFilters(),
    params: opts.params || dashParamPayload(),
    asOf: opts.asOf !== undefined ? opts.asOf : (typeof snapDashAsOf === 'string' ? snapDashAsOf : null),
    outbound: opts.outbound === true,
  };
}

/** Scroll to a tile and pulse it — on its own page if it sits on another. */
function sumJump(cardId: string): void {
  if (!dashCurrent) return;
  const pages = dashCurrent.pages || [];
  const i = pages.findIndex((p: any) => (p.cards || []).some((x: any) => x && x.id === cardId));
  if (i >= 0 && i !== dashPageIdx) { dashPageIdx = i; renderDashPages(); renderDashGrid(); }
  const el = document.querySelector('.dash-card[data-card-id="' + CSS.escape(cardId) + '"]') as HTMLElement | null;
  if (!el) return;
  el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  el.classList.remove('sum-pulse');
  void el.offsetWidth; // restart the animation on a second click
  el.classList.add('sum-pulse');
  setTimeout(() => el.classList.remove('sum-pulse'), 1600);
}

function sumStamp(at: string): string {
  const t = new Date(at);
  const time = Number.isNaN(t.getTime()) ? '' : t.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const asOf = typeof snapDashAsOf === 'string' && snapDashAsOf
    ? ' · data as of ' + new Date(snapDashAsOf).toLocaleString([], { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })
    : '';
  return 'Updated ' + time + asOf;
}

function sumList(sentences: any[]): HTMLElement {
  const list = document.createElement('ol');
  list.className = 'sum-list';
  for (const s of sentences) {
    const li = document.createElement('li');
    li.className = 'sum-item is-' + (s.tone || 'info');
    const ic = document.createElement('span');
    ic.className = 'sum-ic';
    ic.setAttribute('aria-hidden', 'true');
    ic.appendChild(icon(s.kind === 'kpi' && s.tone === 'bad' ? 'arrow-down' : SUM_ICONS[s.kind] || 'info', 14));
    const text = document.createElement(s.cardId ? 'button' : 'span');
    text.className = 'sum-text';
    text.textContent = s.text;
    if (s.cardId) {
      (text as HTMLButtonElement).type = 'button';
      text.title = 'Show the ' + (SUM_KIND_LABEL[s.kind] || 'source').toLowerCase() + ' tile';
      text.addEventListener('click', () => sumJump(String(s.cardId)));
    }
    li.append(ic, text);
    list.appendChild(li);
  }
  return list;
}

async function renderSummaryCard(card: any, body: HTMLElement): Promise<void> {
  skelTable(body, 4, 1);
  let res: any;
  try {
    res = await window.hubSummary.compute(sumRequest());
  } catch (_) {
    res = { ok: false, error: 'Could not summarise this dashboard.' };
  } finally {
    skelClear(body);
  }
  if (!body.isConnected) return; // the grid re-rendered while this was in flight
  if (!res || !res.ok) { dashCardMissing(body, (res && res.error) || 'Could not summarise this dashboard.', false); return; }
  sumPaint(card, body, res);
}

function sumPaint(card: any, body: HTMLElement, res: any): void {
  body.textContent = '';
  const box = document.createElement('div');
  box.className = 'sum-card';
  body.appendChild(box);
  const sentences: any[] = res.sentences || [];
  if (!sentences.length) {
    box.appendChild(makeEmptyState({
      variant: 'summary', iconName: 'sparkles', title: 'Nothing to summarise yet',
      line: 'Add a KPI card or a chart. This card then says what moved, what drove it, and what needs a look.',
    }));
    return;
  }
  const key = sentences.map((s) => s.text).join('\n');
  const prose = sumProse.get(card.id);
  const rewritten = !!prose && prose.key === key;
  if (prose && !rewritten) sumProse.delete(card.id); // the facts moved on; so does the prose
  if (rewritten) {
    const p = document.createElement('p');
    p.className = 'sum-prose';
    p.textContent = prose.text;
    box.appendChild(p);
  } else {
    box.appendChild(sumList(sentences));
  }

  const foot = document.createElement('div');
  foot.className = 'sum-foot';
  const stamp = document.createElement('span');
  stamp.className = 'sum-stamp tnum';
  stamp.textContent = sumStamp(res.computedAt) + (rewritten ? ' · rewritten by the Assistant from these facts' : '');
  foot.appendChild(stamp);
  if (rewritten) {
    const back = document.createElement('button');
    back.type = 'button';
    back.className = 'btn btn-ghost btn-sm sum-btn';
    iconLabel(back, 'list', 'Show the sentences', 14);
    back.addEventListener('click', () => { sumProse.delete(card.id); sumPaint(card, body, res); });
    foot.appendChild(back);
  } else if (res.canRewrite) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn-ghost btn-sm sum-btn sum-rewrite';
    iconLabel(btn, 'sparkles', 'Rewrite', 14);
    btn.title = 'Narrate these facts as prose. The Assistant may only restate the figures above.';
    btn.addEventListener('click', () => void sumRewrite(card, body, res, key, btn));
    foot.appendChild(btn);
  } else {
    const note = document.createElement('span');
    note.className = 'sum-note';
    note.textContent = 'Rewrite needs a model';
    note.title = res.rewriteReason || '';
    foot.appendChild(note);
  }
  box.appendChild(foot);
}

async function sumRewrite(card: any, body: HTMLElement, res: any, key: string, btn: HTMLButtonElement): Promise<void> {
  btn.disabled = true;
  btn.classList.add('is-busy');
  iconLabel(btn, 'loader', 'Rewriting…', 14);
  let out: any;
  try { out = await window.hubSummary.rewrite(sumRequest()); } catch (_) { out = null; }
  if (!body.isConnected) return;
  if (!out || !out.ok) {
    showToast((out && out.error) || 'Could not rewrite the summary. The app’s sentences stay.');
    sumPaint(card, body, res);
    return;
  }
  sumProse.set(card.id, { key, text: String(out.text) });
  sumPaint(card, body, res);
}

/** The card in a dashboard export (dashShare.ts via cardKinds.exportAuthoringCard): its sentences as a text block. */
async function sumExportCard(layout: any): Promise<any> {
  let res: any;
  try { res = await window.hubSummary.compute(sumRequest({ asOf: null, outbound: true })); } catch (_) { res = null; }
  if (!res || !res.ok) return { kind: 'broken', layout, reason: (res && res.error) || 'Could not summarise this dashboard' };
  return { kind: 'text', layout, heading: 'Summary', text: (res.sentences || []).map((s: any) => s.text).join('\n\n') };
}

/**
 * A report's first block (reportRender.ts): the Summary card's sentences, when
 * the dashboard has one, ahead of every tile's caption.
 */
async function sumReportLines(ctx: any): Promise<string[]> {
  const sheets = (ctx && ctx.analysis && Array.isArray(ctx.analysis.sheets)) ? ctx.analysis.sheets : [];
  if (!sheets.some((s: any) => (s.cards || []).some((c: any) => c && c.type === 'summary'))) return [];
  let res: any;
  try {
    res = await window.hubSummary.compute(sumRequest({
      projectId: ctx.projectId, analysis: ctx.analysis, pages: sheets, filters: ctx.filters || [], params: ctx.params || [], asOf: null, outbound: true,
    }));
  } catch (_) { res = null; }
  return res && res.ok ? (res.sentences || []).map((s: any) => String(s.text)) : [];
}

/**
 * Put a Summary card at the top of the open sheet, moving every tile down to
 * make room. The template gallery calls it for every dashboard it creates
 * (anNew.ts); "More → Summary" puts one back after it was removed.
 */
function sumAddToTop(): void {
  const page = dashCurrentPage();
  if (!page) return;
  if (!Array.isArray(page.cards)) page.cards = [];
  if (page.cards.some((c: any) => c && c.type === 'summary')) { showToast('This sheet already has a Summary'); return; }
  for (const c of page.cards) if (c && c.type !== 'control' && c.layout) c.layout.y = (c.layout.y || 0) + SUM_LAYOUT.h;
  page.cards.unshift({ id: dashUuid(), type: 'summary', layout: { ...SUM_LAYOUT } });
  markDashDirty('Add summary');
  renderDashGrid();
}
