'use strict';

// Comments — the right panel: a thread list, replies, Resolve / Reopen, and
// the composer. Classic global-scope script: no import/export.
//
// It is the shared side panel (sidePanel.ts — History and Lineage open in the
// same shell), in one of two modes:
//   thread  every thread on ONE target (a card, a visual, a dataset, a story),
//           open first, resolved below; the composer writes a new one there,
//           pinned to a chart point when a ⌘-click opened it.
//   all     every thread on a dashboard — the dashboard, its cards and the
//           visuals they draw — filterable Open / Resolved / All, each linking
//           to its card; the composer writes on the dashboard itself.
//
// Bodies are the text card's Markdown subset (markdown.ts): parsed, never
// HTML, links opened through main's shell-safe openExternal. The panel paints
// from commentStore's copy and repaints whenever it changes; what someone is
// typing (the composer, a reply, an edit) lives in the state below, so a
// repaint — a change from another window, say — never eats a draft.

interface CmtPanelState {
  mode: 'thread' | 'all';
  kind: string;
  id: string;
  filter: 'open' | 'resolved' | 'all';
  /** A chart point the next new thread is pinned to — set by a ⌘-click. */
  point: { label: string; series?: string } | null;
  /** The thread to scroll to and highlight once. */
  focusId: string;
  /** Whose reply box is open, and what is in it. */
  replying: string;
  replyDraft: string;
  /** Which thread is being edited, and the edit. */
  editing: string;
  editDraft: string;
  /** The delete button that has been clicked once and waits for a second. */
  armed: string;
  el: HTMLElement;
  body: HTMLElement;
  foot: HTMLElement;
}
let cmtPanel: CmtPanelState | null = null;

/**
 * Open the thread panel for one target — the door every surface uses, and the
 * one the chart annotations plugin calls when a pin is clicked. `commentId`
 * scrolls to that thread; `opts.point` arms the composer to pin a new one.
 */
function openCommentThread(targetKind: string, targetId: string, commentId?: string, opts: { point?: { label: string; series?: string } } = {}): void {
  if (!currentProjectId || !targetId || !CMT_KIND_WORD[targetKind]) return;
  cmtOpenPanel('thread', targetKind, targetId, cmtTargetName(targetKind, targetId), t('commentPanel.comments', { p0: CMT_KIND_WORD[targetKind] }));
  if (!cmtPanel) return;
  cmtPanel.focusId = commentId || '';
  cmtPanel.point = opts.point || null;
  cmtPaintPanel();
  cmtPaintComposer();
  if (cmtPanel.point) (cmtPanel.foot.querySelector('.cmt-input') as HTMLTextAreaElement | null)?.focus();
}

/** Every thread on the open dashboard. */
function cmtOpenDashboardThreads(commentId?: string): void {
  if (!dashCurrent) return;
  cmtOpenPanel('all', 'analysis', String(dashCurrent.id), String(dashCurrent.name || t('common.dashboard')), t('commentPanel.comments_dashboard'));
  if (!cmtPanel) return;
  cmtPanel.focusId = commentId || '';
  cmtPaintPanel();
}

/** Is the panel showing exactly this? For the doors' toggle behaviour. */
function cmtPanelShows(mode: 'thread' | 'all', kind: string, id: string): boolean {
  return !!cmtPanel && spIsOpen('comments') && cmtPanel.mode === mode && cmtPanel.kind === kind && cmtPanel.id === id;
}

function cmtOpenPanel(mode: 'thread' | 'all', kind: string, id: string, title: string, sub: string): void {
  const panel = spOpen({ kind: 'comments', title, sub, onClose: () => { cmtPanel = null; cmtPaintDoors(); } });
  panel.el.classList.add('cmt-panel');
  panel.el.dataset.target = cmtKey(kind, id);
  panel.foot.hidden = false;
  panel.foot.classList.add('cmt-foot');
  cmtPanel = {
    mode, kind, id, filter: 'open', point: null, focusId: '',
    replying: '', replyDraft: '', editing: '', editDraft: '', armed: '',
    el: panel.el, body: panel.body, foot: panel.foot,
  };
  cmtPaintComposer();
  cmtPaintDoors();
}

function cmtEl<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text != null) el.textContent = text;
  return el;
}

function cmtBtn(label: string, cls: string, run: () => void, iconName?: string): HTMLButtonElement {
  const b = cmtEl('button', cls);
  b.type = 'button';
  if (iconName) iconLabel(b, iconName, label, 14);
  else b.textContent = label;
  b.addEventListener('click', (e) => { e.stopPropagation(); run(); });
  return b;
}

/** ⌘↩ / Ctrl+↩ submits. */
function cmtOnSubmitKey(box: HTMLTextAreaElement, submit: () => void): void {
  box.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submit(); }
  });
}

// ── the list ─────────────────────────────────────────────────────────────────

function cmtPanelThreads(): any[] {
  const st = cmtPanel as CmtPanelState;
  if (st.mode === 'all') return dashCurrent && String(dashCurrent.id) === st.id ? cmtDashboardThreads(dashCurrent) : [];
  return cmtOn(st.kind, st.id).slice().sort(cmtByOpenThenNewest);
}

function cmtPaintPanel(): void {
  const st = cmtPanel;
  if (!st || !st.el.isConnected) return;
  const scroll = st.body.scrollTop;
  st.body.textContent = '';
  const all = cmtPanelThreads();
  const open = all.filter((c) => !c.resolvedAt);
  const done = all.filter((c) => c.resolvedAt);

  if (st.mode === 'all') st.body.appendChild(cmtFilterBar(open.length, done.length, all.length));
  const shown = st.mode === 'all' ? (st.filter === 'open' ? open : st.filter === 'resolved' ? done : all) : all;

  if (!shown.length) {
    st.body.appendChild(cmtEmpty(all.length, st.mode === 'all' ? st.filter : 'all'));
  } else {
    const list = cmtEl('div', 'cmt-list');
    list.setAttribute('role', 'list');
    let headed = false;
    for (const c of shown) {
      // Thread mode: resolved threads sit under their own small heading.
      if (st.mode === 'thread' && c.resolvedAt && !headed) {
        headed = true;
        list.appendChild(cmtEl('div', 'cmt-divider', t('commentPanel.resolved', { doneCount: done.length })));
      }
      list.appendChild(cmtThread(c));
    }
    st.body.appendChild(list);
  }
  st.body.scrollTop = scroll;
  if (st.focusId) {
    const hit = st.body.querySelector('[data-comment-id="' + CSS.escape(st.focusId) + '"]') as HTMLElement | null;
    st.focusId = '';
    if (hit) {
      hit.classList.add('is-focus');
      hit.scrollIntoView({ block: 'nearest' });
    }
  }
  // Restore a draft's caret after the rebuild took its box away.
  const live = st.body.querySelector('.cmt-reply-box .cmt-input, .cmt-edit .cmt-input') as HTMLTextAreaElement | null;
  if (live && document.activeElement === document.body) {
    live.focus();
    live.setSelectionRange(live.value.length, live.value.length);
  }
}

function cmtFilterBar(open: number, done: number, total: number): HTMLElement {
  const st = cmtPanel as CmtPanelState;
  const bar = cmtEl('div', 'cmt-filter');
  bar.setAttribute('role', 'radiogroup');
  bar.setAttribute('aria-label', t('common.show'));
  ([['open', t('common.open'), open], ['resolved', t('common.resolved'), done], ['all', t('common.all'), total]] as Array<[CmtPanelState['filter'], string, number]>)
    .forEach(([value, label, n]) => {
      const b = cmtEl('button', 'cmt-filter-opt' + (st.filter === value ? ' is-on' : ''));
      b.type = 'button';
      b.dataset.filter = value;
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', String(st.filter === value));
      b.setAttribute('aria-label', label + ' (' + n + ')');
      b.append(cmtEl('span', '', label), cmtEl('span', 'cmt-filter-n tnum', String(n)));
      b.addEventListener('click', () => { st.filter = value; cmtPaintPanel(); });
      bar.appendChild(b);
    });
  return bar;
}

function cmtEmpty(total: number, filter: string): HTMLElement {
  if (filter === 'resolved') {
    return makeEmptyState({ variant: 'starred', iconName: 'circle-check', title: t('commentPanel.nothing_resolved_yet'), line: t('commentPanel.threads_you_resolve_move_here_and') });
  }
  if (filter === 'open' && total) {
    return makeEmptyState({ variant: 'starred', iconName: 'circle-check', title: t('commentPanel.all_caught_up'), line: t('commentPanel.every_thread_on_this_dashboard_is') });
  }
  return makeEmptyState({
    variant: 'starred',
    iconName: 'message-square',
    title: t('commentPanel.no_comments_yet_start_the_discussion'),
    line: t('commentPanel.ask_a_question_flag_a_number'),
  });
}

function cmtAvatar(name: string, small?: boolean): HTMLElement {
  const a = cmtEl('span', 'cmt-avatar' + (small ? ' cmt-avatar--sm' : ''), (name.trim()[0] || '?').toUpperCase());
  a.setAttribute('aria-hidden', 'true');
  // A stable hue per name, so a thread reads as a conversation between people.
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) % 360;
  a.style.setProperty('--cmt-hue', String(h));
  return a;
}

function cmtWhen(iso: string): HTMLElement {
  const t = cmtEl('time', 'cmt-when tnum', cmtAgo(iso));
  t.dateTime = iso;
  t.title = new Date(iso).toLocaleString();
  return t;
}

function cmtMarkdown(body: string): HTMLElement {
  const box = cmtEl('div', 'cmt-body md-card');
  box.appendChild(mdRender(mdParse(body), document, {
    link: (a: HTMLAnchorElement, href: string) => {
      a.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); window.hub.openExternal(href); });
    },
  }));
  return box;
}

function cmtPointText(p: any): string {
  return p ? String(p.label) + (p.series ? ' · ' + p.series : '') : '';
}

function cmtThread(c: any): HTMLElement {
  const st = cmtPanel as CmtPanelState;
  const el = cmtEl('article', 'cmt-thread' + (c.resolvedAt ? ' is-resolved' : ''));
  el.dataset.commentId = c.id;
  el.setAttribute('role', 'listitem');

  const head = cmtEl('header', 'cmt-head');
  const who = cmtEl('span', 'cmt-who');
  who.append(cmtEl('span', 'cmt-author', c.author || t('common.someone')), cmtWhen(c.createdAt));
  if (c.updatedAt) who.appendChild(cmtEl('span', 'cmt-edited', 'edited'));
  head.append(cmtAvatar(c.author || '?'), who);
  if (c.resolvedAt) {
    const done = cmtEl('span', 'cmt-state');
    iconLabel(done, 'circle-check', t('common.resolved'), 14);
    head.appendChild(done);
  }
  el.appendChild(head);

  // Where it is: the pinned point, and (on the dashboard list) which card.
  const n = cmtPinNumber(c);
  if (n || st.mode === 'all') {
    const where = cmtEl('div', 'cmt-where');
    if (n) {
      const pin = cmtEl('span', 'cmt-pin', '#' + n);
      pin.title = t('commentPanel.pinned_to', { point: cmtPointText(c.target.point) });
      where.append(pin, cmtEl('span', 'cmt-pin-label', cmtPointText(c.target.point)));
    }
    if (st.mode === 'all' && c.target.kind !== 'analysis') {
      where.appendChild(cmtBtn('on ' + cmtTargetName(c.target.kind, c.target.id), 'cmt-on', () => cmtJumpToTarget(c)));
    }
    if (where.childNodes.length) el.appendChild(where);
  }

  if (st.editing === c.id) el.appendChild(cmtEditBox(c));
  else el.appendChild(cmtMarkdown(c.body));

  if (c.replies && c.replies.length) {
    const replies = cmtEl('div', 'cmt-replies');
    for (const r of c.replies) replies.appendChild(cmtReply(c, r));
    el.appendChild(replies);
  }

  const actions = cmtEl('div', 'cmt-actions');
  if (!c.resolvedAt) actions.appendChild(cmtBtn(t('commentPanel.reply'), 'cmt-act', () => { st.replying = c.id; st.replyDraft = ''; cmtPaintPanel(); cmtFocusIn(c.id, '.cmt-reply-box .cmt-input'); }));
  actions.appendChild(c.resolvedAt
    ? cmtBtn(t('commentPanel.reopen'), 'cmt-act', () => void cmtRun(window.hubPower.reopenComment(currentProjectId as string, c.id)), 'rotate-ccw')
    : cmtBtn(t('commentPanel.resolve'), 'cmt-act cmt-act--resolve', () => void cmtRun(window.hubPower.resolveComment(currentProjectId as string, c.id)), 'check'));
  if (c.mine) {
    actions.appendChild(cmtBtn(t('common.edit_2'), 'cmt-act', () => { st.editing = c.id; st.editDraft = c.body; cmtPaintPanel(); cmtFocusIn(c.id, '.cmt-edit .cmt-input'); }));
    actions.appendChild(cmtDeleteBtn('del:' + c.id, () => window.hubPower.deleteComment(currentProjectId as string, c.id)));
  }
  el.appendChild(actions);
  if (st.replying === c.id && !c.resolvedAt) el.appendChild(cmtReplyBox(c));
  return el;
}

function cmtReply(c: any, r: any): HTMLElement {
  const el = cmtEl('div', 'cmt-reply');
  el.dataset.replyId = r.id;
  const head = cmtEl('div', 'cmt-head cmt-head--reply');
  const who = cmtEl('span', 'cmt-who');
  who.append(cmtEl('span', 'cmt-author', r.author || t('common.someone')), cmtWhen(r.createdAt));
  head.append(cmtAvatar(r.author || '?', true), who);
  if (r.mine) head.appendChild(cmtDeleteBtn('rep:' + r.id, () => window.hubPower.deleteCommentReply(currentProjectId as string, c.id, r.id), true));
  el.append(head, cmtMarkdown(r.body));
  return el;
}

/** Delete asks twice: the first click arms it, the second deletes. A thread's
 *  delete is a tombstone that also removes it from every synced machine. */
function cmtDeleteBtn(key: string, call: () => Promise<any>, compact?: boolean): HTMLButtonElement {
  const st = cmtPanel as CmtPanelState;
  const armed = st.armed === key;
  const b = cmtBtn(armed ? t('commentPanel.delete') : 'Delete', 'cmt-act cmt-act--danger' + (armed ? ' is-armed' : '') + (compact ? ' cmt-act--compact' : ''), () => {
    if (st.armed !== key) {
      st.armed = key;
      cmtPaintPanel();
      setTimeout(() => { if (cmtPanel === st && st.armed === key) { st.armed = ''; cmtPaintPanel(); } }, 4000);
      return;
    }
    st.armed = '';
    void cmtRun(call());
  });
  b.setAttribute('aria-label', armed ? t('commentPanel.click_again_to_delete') : 'Delete');
  return b;
}

function cmtFocusIn(commentId: string, sel: string): void {
  const st = cmtPanel;
  const box = st && st.body.querySelector('[data-comment-id="' + CSS.escape(commentId) + '"] ' + sel) as HTMLTextAreaElement | null;
  if (box) { box.focus(); box.setSelectionRange(box.value.length, box.value.length); }
}

function cmtTextarea(value: string, placeholder: string, onInput: (v: string) => void, rows = 2): HTMLTextAreaElement {
  const box = cmtEl('textarea', 'cmt-input');
  box.rows = rows;
  box.value = value;
  box.placeholder = placeholder;
  box.setAttribute('aria-label', placeholder);
  box.addEventListener('input', () => onInput(box.value));
  return box;
}

function cmtReplyBox(c: any): HTMLElement {
  const st = cmtPanel as CmtPanelState;
  const wrap = cmtEl('div', 'cmt-reply-box');
  const box = cmtTextarea(st.replyDraft, t('commentPanel.reply_2'), (v) => { st.replyDraft = v; });
  const send = async (): Promise<void> => {
    if (!st.replyDraft.trim()) return;
    const text = st.replyDraft;
    st.replying = '';
    st.replyDraft = '';
    if (!(await cmtRun(window.hubPower.replyComment(currentProjectId as string, c.id, text)))) { st.replying = c.id; st.replyDraft = text; cmtPaintPanel(); }
  };
  cmtOnSubmitKey(box, () => void send());
  const row = cmtEl('div', 'cmt-box-row');
  row.append(cmtEl('span', 'cmt-hint', t('commentPanel.to_reply')),
    cmtBtn(t('common.cancel'), 'btn btn-sm btn-ghost', () => { st.replying = ''; cmtPaintPanel(); }),
    cmtBtn(t('commentPanel.reply'), 'btn btn-sm btn-primary', () => void send()));
  wrap.append(box, row);
  return wrap;
}

function cmtEditBox(c: any): HTMLElement {
  const st = cmtPanel as CmtPanelState;
  const wrap = cmtEl('div', 'cmt-edit');
  const box = cmtTextarea(st.editDraft, t('commentPanel.edit_comment'), (v) => { st.editDraft = v; }, 3);
  const save = async (): Promise<void> => {
    if (!st.editDraft.trim()) return;
    const text = st.editDraft;
    st.editing = '';
    if (text.trim() !== c.body && !(await cmtRun(window.hubPower.editComment(currentProjectId as string, c.id, text)))) st.editing = c.id;
    cmtPaintPanel();
  };
  cmtOnSubmitKey(box, () => void save());
  const row = cmtEl('div', 'cmt-box-row');
  row.append(cmtEl('span', 'cmt-hint', t('commentPanel.to_save')),
    cmtBtn(t('common.cancel'), 'btn btn-sm btn-ghost', () => { st.editing = ''; cmtPaintPanel(); }),
    cmtBtn(t('common.save'), 'btn btn-sm btn-primary', () => void save()));
  wrap.append(box, row);
  return wrap;
}

// ── the composer (pinned under the list) ─────────────────────────────────────

function cmtPaintComposer(): void {
  const st = cmtPanel;
  if (!st) return;
  const prev = st.foot.querySelector('.cmt-input') as HTMLTextAreaElement | null;
  const draft = prev ? prev.value : '';
  st.foot.textContent = '';
  const wrap = cmtEl('div', 'cmt-compose');
  if (st.point) {
    const chip = cmtEl('div', 'cmt-compose-pin');
    chip.append(icon('map-pin', 14), cmtEl('span', '', t('commentPanel.pinned_to_2')), cmtEl('strong', '', cmtPointText(st.point)));
    const x = cmtEl('button', 'cmt-compose-unpin');
    x.type = 'button';
    iconOnly(x, 'x', t('commentPanel.don_t_pin'), 14);
    x.addEventListener('click', () => { st.point = null; cmtPaintComposer(); });
    chip.appendChild(x);
    wrap.appendChild(chip);
  }
  const placeholder = st.mode === 'all' ? t('commentPanel.comment_on_this_dashboard') : st.point ? t('commentPanel.what_about_this_point') : t('commentPanel.add_a_comment');
  const box = cmtTextarea(draft, placeholder, () => { /* read at send time */ }, 3);
  const post = cmtBtn(t('common.comment'), 'btn btn-sm btn-primary cmt-post', () => void cmtPost(box));
  cmtOnSubmitKey(box, () => void cmtPost(box));
  const row = cmtEl('div', 'cmt-box-row');
  row.append(cmtEl('span', 'cmt-hint', t('commentPanel.bold_italic_code_lists_to_post')), post);
  wrap.append(box, row);
  st.foot.appendChild(wrap);
}

async function cmtPost(box: HTMLTextAreaElement): Promise<void> {
  const st = cmtPanel;
  const text = box.value;
  if (!st || !text.trim() || !currentProjectId) return;
  const target: any = { kind: st.kind, id: st.id };
  if (st.point) target.point = st.point;
  box.disabled = true;
  const ok = await cmtRun(window.hubPower.addComment(currentProjectId, target, text));
  box.disabled = false;
  if (!ok || cmtPanel !== st) return;
  box.value = '';
  st.point = null;
  cmtPaintComposer();
  if (st.mode === 'all' && st.filter === 'resolved') { st.filter = 'open'; cmtPaintPanel(); }
}

/** From the dashboard list to the card a thread is on: its page, a flash, its thread. */
function cmtJumpToTarget(c: any): void {
  const t = c.target;
  if (t.kind === 'card' && dashCurrent) {
    const pages = dashCurrent.pages || [];
    const i = pages.findIndex((p: any) => (p.cards || []).some((x: any) => x && x.id === t.id));
    if (i >= 0 && i !== dashPageIdx) { dashPageIdx = i; renderDashPages(); renderDashGrid(); }
    const card = document.querySelector('.dash-card[data-card-id="' + CSS.escape(t.id) + '"]') as HTMLElement | null;
    if (card) {
      card.scrollIntoView({ block: 'nearest' });
      card.classList.add('cmt-flash');
      setTimeout(() => card.classList.remove('cmt-flash'), 1400);
    }
  }
  openCommentThread(t.kind, t.id, c.id);
}
