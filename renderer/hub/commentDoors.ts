'use strict';

// Comments — every way INTO a thread. Classic global-scope script: no
// import/export. The panel itself is commentPanel.ts; the data commentStore.ts.
//
//   • a comment icon on each dashboard card head, with the card's open count
//   • a Comments button on the dashboard head (every thread on the dashboard),
//     the Visual builder head, the dataset page and the story page
//   • ⌘-click (Ctrl-click) on a chart mark — a dashboard tile or the builder —
//     opens the composer pinned to that point
//   • Home's "Recent comments" row, shown only while threads are open
//
// The head buttons are added here at boot rather than written into
// index.html, so the pages that carry them need no markup of their own; each
// button reads its record at click time (dashCurrent, vizEditingId, expId,
// stStory) and repaints its count whenever the comments or that page change.

/** The card head's icon: count of OPEN threads, reachable on hover/focus when 0. */
function cmtCardButton(card: any): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'dash-card-btn cmt-card-btn';
  b.dataset.cmtTarget = cmtKey('card', String(card.id));
  b.appendChild(icon('message-square', 14));
  b.appendChild(Object.assign(document.createElement('span'), { className: 'cmt-count tnum' }));
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    if (cmtPanelShows('thread', 'card', String(card.id))) { spClose(); return; }
    openCommentThread('card', String(card.id));
  });
  cmtPaintCount(b, cmtOpenCount('card', String(card.id)), cmtOn('card', String(card.id)).length);
  return b;
}

/** One button's count, name and state. `open` is shown; `total` decides "has any". */
function cmtPaintCount(b: HTMLElement, open: number, total: number): void {
  const n = b.querySelector('.cmt-count');
  if (n) n.textContent = open ? String(open) : '';
  b.classList.toggle('is-empty', total === 0);
  b.classList.toggle('has-open', open > 0);
  const label = 'Comments (' + open + ')';
  b.setAttribute('aria-label', label);
  b.title = open ? open + (open === 1 ? ' open comment' : ' open comments') : total ? 'Comments — all resolved' : 'Comment on this';
}

/** A page-head Comments button, inserted before `beforeId`. */
function cmtHeadButton(id: string, beforeId: string, onClick: () => void): HTMLButtonElement | null {
  const before = document.getElementById(beforeId);
  if (!before || !before.parentElement || document.getElementById(id)) return null;
  const b = document.createElement('button');
  b.type = 'button';
  b.id = id;
  b.className = 'btn btn-sm cmt-head-btn';
  b.appendChild(icon('message-square', 16));
  b.appendChild(Object.assign(document.createElement('span'), { className: 'cmt-head-label', textContent: 'Comments' }));
  b.appendChild(Object.assign(document.createElement('span'), { className: 'cmt-count tnum' }));
  b.addEventListener('click', onClick);
  before.parentElement.insertBefore(b, before);
  return b;
}

/** Repaint every count on screen, and which door is "on". */
function cmtPaintDoors(): void {
  document.querySelectorAll('.cmt-card-btn[data-cmt-target]').forEach((b) => {
    const [kind, id] = String((b as HTMLElement).dataset.cmtTarget).split(':');
    cmtPaintCount(b as HTMLElement, cmtOpenCount(kind, id), cmtOn(kind, id).length);
    b.classList.toggle('is-on', cmtPanelShows('thread', kind, id));
  });
  const dash = document.getElementById('dash-comments-btn');
  if (dash) {
    const threads = dashCurrent ? cmtDashboardThreads(dashCurrent) : [];
    cmtPaintCount(dash, threads.filter((c) => !c.resolvedAt).length, threads.length);
    dash.classList.toggle('is-on', !!dashCurrent && cmtPanelShows('all', 'analysis', String(dashCurrent.id)));
  }
  const heads: Array<[string, string, string]> = [
    ['viz-comments-btn', 'visual', vizEditingId || ''],
    ['ds-comments-btn', 'dataset', expId],
    ['st-comments-btn', 'story', stStory ? String(stStory.id) : ''],
  ];
  for (const [bid, kind, id] of heads) {
    const b = document.getElementById(bid);
    if (!b) continue;
    cmtPaintCount(b, cmtOpenCount(kind, id), cmtOn(kind, id).length);
    b.classList.toggle('is-on', !!id && cmtPanelShows('thread', kind, id));
  }
  const viz = document.getElementById('viz-comments-btn');
  const hist = document.getElementById('viz-history-btn');
  // A draft has nothing to hang a thread on until it is saved — the History rule.
  if (viz && hist) viz.hidden = hist.hidden || !vizEditingId;
}

let cmtDoorsQueued = false;
function cmtQueueDoors(): void {
  if (cmtDoorsQueued) return;
  cmtDoorsQueued = true;
  requestAnimationFrame(() => { cmtDoorsQueued = false; cmtPaintDoors(); });
}

// ── ⌘-click a chart mark ─────────────────────────────────────────────────────

/**
 * Capture phase, so it runs before the tile's own click (a drill, a
 * cross-filter, a tile action) — and only stops that click when it actually
 * lands on a mark. chartMarkAt (chartControls.ts) is the same hit test the
 * drill uses, so the label is the category exactly as the chart shows it.
 */
function cmtOnChartClick(e: MouseEvent): void {
  if (!(e.metaKey || e.ctrlKey) || e.button !== 0) return;
  const canvas = e.target as HTMLElement;
  if (!(canvas instanceof HTMLCanvasElement)) return;
  const area = canvas.closest('.cv-viz-area') as HTMLElement | null;
  if (!area) return;
  const card = area.closest('.dash-card') as HTMLElement | null;
  const inBuilder = !card && !!area.closest('#viz-builder');
  if (!card && !inBuilder) return;
  const mark = chartMarkAt(area, e);
  if (!mark) return;
  e.preventDefault();
  e.stopPropagation();
  const point: { label: string; series?: string } = { label: String(mark.category) };
  if (mark.series) point.series = String(mark.series);
  if (card) { openCommentThread('card', String(card.dataset.cardId || ''), undefined, { point }); return; }
  if (!vizEditingId) { showToast('Save this visual first — then ⌘-click a mark to comment on it'); return; }
  openCommentThread('visual', vizEditingId, undefined, { point });
}

// ── Home: "Recent comments" ──────────────────────────────────────────────────

const CMT_HOME_MAX = 4;

function cmtPaintHome(): void {
  const anchor = document.getElementById('home-insights');
  if (!anchor || !anchor.parentElement) return;
  let sec = document.getElementById('home-comments');
  if (!sec) {
    sec = document.createElement('section');
    sec.id = 'home-comments';
    sec.className = 'home-sec home-comments';
    sec.setAttribute('aria-label', 'Recent comments');
    // Above "What stands out": a question waiting on someone outranks a finding.
    anchor.parentElement.insertBefore(sec, anchor);
  }
  const open = cmtFresh() ? cmtList.filter((c) => !c.resolvedAt) : [];
  sec.hidden = open.length === 0;
  sec.textContent = '';
  if (!open.length) return;
  const head = document.createElement('div');
  head.className = 'home-sec-head';
  const h = document.createElement('h2');
  h.className = 'home-sec-h';
  h.textContent = 'Recent comments';
  h.appendChild(Object.assign(document.createElement('span'), { className: 'home-sec-count', textContent: open.length + ' open' }));
  head.appendChild(h);
  const row = document.createElement('div');
  row.className = 'cmt-home-row';
  row.id = 'home-comments-row';
  open.slice().sort((a, b) => String(cmtLastAt(b)).localeCompare(String(cmtLastAt(a)))).slice(0, CMT_HOME_MAX)
    .forEach((c) => row.appendChild(cmtHomeCard(c)));
  sec.append(head, row);
}

/** When a thread last moved: its newest reply, else when it was written. */
function cmtLastAt(c: any): string {
  const last = c.replies && c.replies.length ? c.replies[c.replies.length - 1] : null;
  return last ? last.createdAt : c.createdAt;
}

function cmtHomeCard(c: any): HTMLElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'cmt-home-card';
  b.dataset.commentId = c.id;
  const top = document.createElement('span');
  top.className = 'cmt-home-top';
  top.append(cmtAvatar(c.author || '?', true),
    Object.assign(document.createElement('span'), { className: 'cmt-author', textContent: c.author || 'Someone' }),
    cmtWhen(cmtLastAt(c)));
  const snippet = Object.assign(document.createElement('span'), { className: 'cmt-home-snippet', textContent: cmtPlain(c.body) });
  const on = document.createElement('span');
  on.className = 'cmt-home-on';
  const name = cmtTargetName(c.target.kind, c.target.id);
  on.append(icon(c.target.kind === 'dataset' ? 'database' : c.target.kind === 'story' ? 'file-text' : 'layout-dashboard', 14),
    Object.assign(document.createElement('span'), { textContent: name }));
  const replies = c.replies ? c.replies.length : 0;
  if (replies) on.appendChild(Object.assign(document.createElement('span'), { className: 'cmt-home-replies', textContent: replies + (replies === 1 ? ' reply' : ' replies') }));
  b.append(top, snippet, on);
  b.setAttribute('aria-label', (c.author || 'Someone') + ' on ' + name + ': ' + cmtPlain(c.body).slice(0, 120));
  b.addEventListener('click', () => void cmtGoTo(c));
  return b;
}

/** Open the record a thread is on, then the thread. */
async function cmtGoTo(c: any): Promise<void> {
  const t = c.target;
  if (t.kind === 'dataset') { selectSection('datasets'); await openSavedDataset(t.id); }
  else if (t.kind === 'visual') { selectSection('visuals'); await openSavedVisual(t.id); }
  else if (t.kind === 'story') await stOpen(t.id);
  else {
    const info = cmtTargets[cmtKey(t.kind, t.id)];
    const aid = t.kind === 'analysis' ? t.id : info && info.analysisId;
    if (!aid) { showToast('That card is no longer on a dashboard'); return; }
    selectSection('analyses');
    await openAnalysis(aid);
    if (t.kind === 'analysis') { cmtOpenDashboardThreads(c.id); return; }
    cmtJumpToTarget(c);
    return;
  }
  openCommentThread(t.kind, t.id, c.id);
}

// ── boot ─────────────────────────────────────────────────────────────────────

(function initCommentDoors(): void {
  const dashBtn = cmtHeadButton('dash-comments-btn', 'dash-history-btn', () => {
    if (!dashCurrent) return;
    if (cmtPanelShows('all', 'analysis', String(dashCurrent.id))) { spClose(); return; }
    cmtOpenDashboardThreads();
  });
  if (dashBtn) dashBtn.classList.add('dash-comments-btn');
  const thread = (kind: string, id: () => string) => (): void => {
    const rid = id();
    if (!rid) return;
    if (cmtPanelShows('thread', kind, rid)) { spClose(); return; }
    openCommentThread(kind, rid);
  };
  cmtHeadButton('viz-comments-btn', 'viz-history-btn', thread('visual', () => vizEditingId || ''));
  cmtHeadButton('ds-comments-btn', 'ds-act-more', thread('dataset', () => expId));
  cmtHeadButton('st-comments-btn', 'st-more', thread('story', () => (stStory ? String(stStory.id) : '')));

  // A page showing a different record repaints its button's count.
  const watch = new MutationObserver(cmtQueueDoors);
  for (const [id, attrs] of [['dash-name', false], ['viz-builder-name', false], ['ds-explorer-title', false],
    ['st-outline-list', false], ['viz-history-btn', true]] as Array<[string, boolean]>) {
    const el = document.getElementById(id);
    if (el) watch.observe(el, attrs ? { attributes: true, attributeFilter: ['hidden'] } : { childList: true, characterData: true, subtree: true });
  }
  document.addEventListener('click', cmtOnChartClick, true);
  cmtPaintDoors();
})();
