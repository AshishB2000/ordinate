'use strict';

// Comments — the renderer's copy of the open project's threads, and the
// read-only questions every door asks of it (how many on this card, which
// pins on this chart, what is this target called). Classic global-scope
// script: no import/export.
//
// Main owns the record (src/app/comments.ts) and answers every call with the
// project's WHOLE live list, so this copy is replaced, never patched. It is
// refreshed on project open, on `comments:changed` (a change from this or
// another window, or a new display name / sync folder), and after every
// change made here. Painting reads it synchronously; a stale project id makes
// the next read fetch and repaint rather than show another project's counts.
//
// Every record carries `mine` (main decides — the renderer never names an
// author) and `targets` names each "kind:id" a thread points at.

let cmtList: any[] = [];
let cmtTargets: Record<string, { name: string; analysisId?: string }> = {};
let cmtProject = '';
let cmtSeq = 0;
/** The pins each chart was last BUILT with ("kind:id" → JSON), so a change redraws it. */
const cmtPinsDrawn = new Map<string, string>();

function cmtKey(kind: string, id: string): string {
  return kind + ':' + id;
}

async function cmtReload(): Promise<void> {
  const pid = currentProjectId;
  if (!pid || !window.hubPower) {
    cmtList = [];
    cmtProject = '';
    cmtRepaint();
    return;
  }
  const seq = ++cmtSeq;
  let res: any = null;
  try {
    res = await window.hubPower.listComments(pid);
  } catch (_) {
    res = null;
  }
  if (seq !== cmtSeq || pid !== currentProjectId) return; // a newer read, or another project, won
  cmtAccept(pid, res);
}

function cmtAccept(pid: string, res: any): void {
  if (res && res.ok) {
    cmtList = Array.isArray(res.comments) ? res.comments : [];
    cmtTargets = res.targets && typeof res.targets === 'object' ? res.targets : {};
  } else if (cmtProject !== pid) {
    cmtList = []; // a failed read for a new project shows nothing, never the last project's threads
    cmtTargets = {};
  }
  // Marked as read EVEN on a failure: otherwise every paint would ask again, forever.
  cmtProject = pid;
  cmtRepaint();
}

/** False (and a fetch under way) when the copy belongs to another project. */
function cmtFresh(): boolean {
  if (!currentProjectId) return false;
  if (cmtProject !== currentProjectId) {
    void cmtReload();
    return false;
  }
  return true;
}

/** The threads on one target, oldest first. */
function cmtOn(kind: string, id: string): any[] {
  if (!id || !cmtFresh()) return [];
  return cmtList.filter((c) => c.target && c.target.kind === kind && c.target.id === id);
}

function cmtOpenCount(kind: string, id: string): number {
  return cmtOn(kind, id).filter((c) => !c.resolvedAt).length;
}

/**
 * The numbered pins for a chart: every thread on the target that is pinned to
 * a point, numbered 1..n in the order they were written — the number the pin
 * shows on the chart and the "#n" its thread shows in the panel.
 */
function cmtPins(kind: string, id: string): Array<{ n: number; id: string; label: string; series?: string; resolved?: boolean }> {
  return cmtOn(kind, id).filter((c) => c.target.point).map((c, i) => {
    const pin: { n: number; id: string; label: string; series?: string; resolved?: boolean } = {
      n: i + 1, id: c.id, label: String(c.target.point.label),
    };
    if (c.target.point.series) pin.series = String(c.target.point.series);
    if (c.resolvedAt) pin.resolved = true;
    return pin;
  });
}

function cmtPinNumber(c: any): number {
  if (!c || !c.target || !c.target.point) return 0;
  const p = cmtPins(c.target.kind, c.target.id).find((x) => x.id === c.id);
  return p ? p.n : 0;
}

/**
 * The COMMENT PIN HOOK's helper: a chart's overrides with `commentPins` set to
 * this target's pins (or removed when it has none). A copy — the caller's
 * object, which may be a saved visual's overrides, is never touched — and
 * neither key reaches disk: main's sanitizeOverrides whitelists keys.
 * buildChart hands them to the annotations plugin, which draws the pins and
 * routes a pin click to openCommentThread(commentPinTarget.kind, .id, pin.id).
 */
function cmtWithPins(overrides: any, kind: string, id: string): any {
  const out = Object.assign({}, overrides || {});
  delete out.commentPins;
  delete out.commentPinTarget;
  const pins = id ? cmtPins(kind, id) : [];
  cmtPinsDrawn.set(cmtKey(kind, id), JSON.stringify(pins));
  if (pins.length) {
    out.commentPins = pins;
    out.commentPinTarget = { kind, id };
  }
  return out;
}

/** Redraw every chart on screen whose pins changed since it was built. */
function cmtRedrawPins(): void {
  const stale = (kind: string, id: string): boolean => {
    const k = cmtKey(kind, id);
    return cmtPinsDrawn.has(k) && cmtPinsDrawn.get(k) !== JSON.stringify(cmtPins(kind, id));
  };
  if (typeof dashCurrent !== 'undefined' && dashCurrent) {
    document.querySelectorAll('#dash-grid .dash-card--visual[data-card-id]').forEach((el) => {
      const id = (el as HTMLElement).dataset.cardId || '';
      if (!stale('card', id)) return;
      const card = cmtFindCard(dashCurrent, id);
      const body = el.querySelector('.dash-card-body') as HTMLElement | null;
      if (card && body) void renderVisualCard(card, body);
    });
  }
  const builder = document.getElementById('viz-builder');
  if (vizEditingId && builder && !builder.hidden && stale('visual', vizEditingId)) void recomputeVisual();
}

function cmtFindCard(dash: any, cardId: string): any {
  for (const page of (dash && (dash.pages || dash.sheets)) || []) {
    for (const card of (page && page.cards) || []) if (card && card.id === cardId) return card;
  }
  return null;
}

/**
 * Every thread that belongs to a dashboard: on the dashboard itself, on any of
 * its cards, or on a visual one of its cards draws. Open first, newest first.
 */
function cmtDashboardThreads(dash: any): any[] {
  if (!dash || !cmtFresh()) return [];
  const cards = new Set<string>();
  const visuals = new Set<string>();
  for (const page of dash.pages || dash.sheets || []) {
    for (const card of (page && page.cards) || []) {
      if (!card) continue;
      cards.add(card.id);
      if (card.visualId) visuals.add(card.visualId);
    }
  }
  return cmtList.filter((c) => {
    const t = c.target || {};
    return (t.kind === 'analysis' && t.id === dash.id) || (t.kind === 'card' && cards.has(t.id)) || (t.kind === 'visual' && visuals.has(t.id));
  }).sort(cmtByOpenThenNewest);
}

function cmtByOpenThenNewest(a: any, b: any): number {
  if (!a.resolvedAt !== !b.resolvedAt) return a.resolvedAt ? 1 : -1;
  return String(b.createdAt).localeCompare(String(a.createdAt));
}

const CMT_KIND_WORD: Record<string, string> = {
  analysis: 'Dashboard', card: 'Card', visual: 'Visual', dataset: 'Dataset', story: 'Story',
};

/** What a target is called: main's name for it, else the live page's, else its kind. */
function cmtTargetName(kind: string, id: string): string {
  const known = cmtTargets[cmtKey(kind, id)];
  if (known && known.name) return known.name;
  if (kind === 'card') {
    const el = document.querySelector('.dash-card[data-card-id="' + CSS.escape(id) + '"] .dash-card-title');
    if (el && el.textContent) return el.textContent;
  }
  if (kind === 'analysis' && typeof dashCurrent !== 'undefined' && dashCurrent && dashCurrent.id === id) return String(dashCurrent.name || 'Dashboard');
  return CMT_KIND_WORD[kind] || 'Comment';
}

/** A comment's text without its Markdown — for a one-line snippet or a printed page. */
function cmtPlain(body: string): string {
  const box = document.createElement('div');
  box.appendChild(mdRender(mdParse(body), document));
  // A list's items are blocks too — "check Q3 check Q4", not "check Q3check Q4".
  const blocks = [...box.children].flatMap((el) => (el.tagName === 'UL' || el.tagName === 'OL' ? [...el.children] : [el]));
  return blocks.map((el) => (el.textContent || '').trim()).filter(Boolean).join(' ');
}

/** "just now", "5 min ago", "3 h ago", "Yesterday", then a date. */
function cmtAgo(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 45) return 'just now';
  if (s < 3600) return Math.round(s / 60) + ' min ago';
  const d = new Date(t);
  if (d.toDateString() === new Date().toDateString()) return Math.round(s / 3600) + ' h ago';
  const y = new Date();
  y.setDate(y.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return 'Yesterday';
  const opts: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' };
  if (d.getFullYear() !== new Date().getFullYear()) opts.year = 'numeric';
  return d.toLocaleDateString([], opts);
}

/**
 * Run one change through main. The answer IS the new list, so it is taken as
 * is; a refusal ("Only the author can delete a comment.") is said, not thrown.
 */
async function cmtRun(call: Promise<any>): Promise<boolean> {
  let res: any = null;
  try {
    res = await call;
  } catch (_) {
    res = null;
  }
  if (!res || res.ok === false) {
    showToast((res && res.error) || 'Could not save the comment');
    return false;
  }
  if (currentProjectId) cmtAccept(currentProjectId, res);
  return true;
}

/** Every surface that shows comments, repainted from the copy. */
function cmtRepaint(): void {
  cmtPaintDoors();
  cmtPaintPanel();
  cmtPaintHome();
  cmtRedrawPins();
}

(function initCommentStore(): void {
  if (!window.hubPower) return;
  window.hubPower.onCommentsChanged((o) => {
    if (!o || !o.projectId || o.projectId === currentProjectId) void cmtReload();
  });
})();
