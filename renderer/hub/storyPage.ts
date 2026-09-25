// THE STORY PAGE — one scrolling document at a 760px reading width, a left
// outline built from its headings, edited in place.
//
// This file owns the open story as a whole: opening and closing it, the name,
// the outline, saving (debounced, like the dashboard editor's autosave), undo
// and redo, and the block LIST — order, the drag handle, the "+" and the
// trailing empty line you type into. What each block looks like and how it is
// edited is storyBlocks.ts; the / picker and the chart/metric pickers are
// storyPickers.ts; present mode and the PDF are storyPresent.ts.
//
// ⌘Z is the dashboards' own history: the same pure stack (dashHistory.ts —
// dashHistNew/Push/Undo/Redo) holding story snapshots, reached through the same
// `dash.undo` / `dash.redo` commands (commandDefs.ts), which dispatch here while
// a story is open. One history implementation, one keybinding.
//
// Classic global-scope script — NO import/export. textContent only.

let stStory: any = null;
let stHist: any = null;
let stHistBusy = false;
let stSaveTimer: any = 0;
let stSaving: Promise<void> | null = null;
/** The block whose text is being edited — kept across a re-render so the caret survives. */
let stEditingId = '';

function stIsOpen(): boolean {
  const page = stEl('st-page');
  return !!stStory && !!page && !page.hidden;
}

function stNewId(): string {
  return dashUuid();
}

function stSnapshot(): any {
  return { name: stStory.name, blocks: stStory.blocks };
}

/**
 * Open a story. From the list, a tab, the palette or a fresh build: the
 * Dashboards section is shown with its Stories tab under the page, so Back
 * lands where a reader expects.
 */
async function stOpen(id: string, opts: { focusEnd?: boolean } = {}): Promise<void> {
  if (!currentProjectId) return;
  if (stStory) await stFlush();
  let s: any = null;
  try {
    s = await window.hub.getStory(currentProjectId, id);
  } catch (_) {
    s = null;
  }
  if (!s || !s.id) { showToast('That story could not be opened.'); return; }
  // The dashboard editor lives on the same section: leave it (saved) first.
  if (dashCurrent) await handleBackToList();
  if (currentSection !== 'analyses') selectSection('analyses');
  rbSelectTab('stories');
  stStory = { id: s.id, name: s.name, blocks: Array.isArray(s.blocks) ? s.blocks : [] };
  stEnsureTail();
  stHist = dashHistNew(stSnapshot());
  stEditingId = '';
  const list = stEl('an-list-view');
  const rb = stEl('rp-builder');
  if (list) list.hidden = true;
  if (rb) rb.hidden = true;
  const page = stEl('st-page');
  if (page) page.hidden = false;
  const name = stEl<HTMLInputElement>('st-name');
  if (name) name.value = stStory.name;
  stSetStatus('');
  stRender();
  if (typeof dkSync === 'function') dkSync();
  if (opts.focusEnd) {
    const last = stStory.blocks[stStory.blocks.length - 1];
    if (last) stEditBlock(last.id);
  }
}

async function stClose(): Promise<void> {
  if (!stStory) return;
  await stFlush();
  ansTeardown(stEl('st-doc'));
  stStory = null;
  stHist = null;
  const page = stEl('st-page');
  if (page) page.hidden = true;
  const list = stEl('an-list-view');
  if (list) list.hidden = false;
  rbSelectTab('stories');
  if (typeof dkSync === 'function') dkSync();
}

// ── Saving ───────────────────────────────────────────────────────────────────

function stSetStatus(text: string): void {
  const el = stEl('st-status');
  if (el) el.textContent = text;
}

function stScheduleSave(): void {
  clearTimeout(stSaveTimer);
  stSetStatus('Saving…');
  stSaveTimer = setTimeout(() => { void stFlush(); }, 600);
}

/** Write now, if anything is waiting. Awaitable, so closing never drops the last edit. */
async function stFlush(): Promise<void> {
  if (stSaving) await stSaving;
  if (!stSaveTimer || !stStory || !currentProjectId) return;
  clearTimeout(stSaveTimer);
  stSaveTimer = 0;
  const story = stStory;
  stSaving = (async () => {
    let res: any = null;
    try {
      res = await window.hub.updateStory(currentProjectId, story.id, { name: story.name, blocks: story.blocks });
    } catch (_) {
      res = null;
    }
    if (stStory === story) stSetStatus(res && res.id ? 'Saved' : 'Could not save');
  })();
  await stSaving;
  stSaving = null;
}

/**
 * Record a change: onto the undo stack, into the save queue, into the outline.
 * `coalesce` merges keystrokes into one undo, exactly as the dashboard editor
 * does for typing (DASH_HIST_COALESCE_MS).
 */
function stCommit(label: string, opts: { coalesce?: boolean; render?: boolean } = {}): void {
  if (!stStory || stHistBusy) return;
  if (stHist) dashHistPush(stHist, label, stSnapshot(), Date.now(), !!opts.coalesce);
  stScheduleSave();
  if (opts.render) stRender();
  else stRenderOutline();
  stPaintUndo();
}

function stPaintUndo(): void {
  const u = stEl<HTMLButtonElement>('st-undo');
  const r = stEl<HTMLButtonElement>('st-redo');
  const ul = dashHistUndoLabel(stHist);
  const rl = dashHistRedoLabel(stHist);
  if (u) { u.disabled = !ul; u.title = ul ? 'Undo ' + ul.toLowerCase() : 'Nothing to undo'; }
  if (r) { r.disabled = !rl; r.title = rl ? 'Redo ' + rl.toLowerCase() : 'Nothing to redo'; }
}

function stHistStep(dir: 'undo' | 'redo'): void {
  if (!stStory || !stHist) return;
  const e = dir === 'undo' ? dashHistUndo(stHist) : dashHistRedo(stHist);
  if (!e) return;
  stHistBusy = true;
  try {
    stStory.name = e.snap.name;
    stStory.blocks = e.snap.blocks;
    const name = stEl<HTMLInputElement>('st-name');
    if (name) name.value = stStory.name;
    stEditingId = '';
    stRender();
  } finally {
    stHistBusy = false;
  }
  stScheduleSave();
  stPaintUndo();
  showToast((dir === 'undo' ? 'Undid ' : 'Redid ') + e.label.toLowerCase());
}
function stUndo(): void { stHistStep('undo'); }
function stRedo(): void { stHistStep('redo'); }

// ── The block list ───────────────────────────────────────────────────────────

/** There is always an empty text line at the end to type into — the page never ends on a chart. */
function stEnsureTail(): void {
  const blocks = stStory.blocks;
  const last = blocks[blocks.length - 1];
  if (!last || last.kind !== 'text' || last.text.trim() !== '') blocks.push({ id: stNewId(), kind: 'text', text: '' });
}

/**
 * Typing into the last empty line makes it a line of content, so a new empty
 * one is appended under it — drawn in place, without re-rendering the page
 * (which would take the caret out of the line being typed in).
 */
function stSyncTail(): void {
  if (!stStory) return;
  const before = stStory.blocks.length;
  stEnsureTail();
  if (stStory.blocks.length === before) return;
  const doc = stEl('st-doc');
  if (doc) doc.appendChild(stBlockRow(stStory.blocks[before], before));
}

function stIndexOf(id: string): number {
  return stStory ? stStory.blocks.findIndex((b: any) => b.id === id) : -1;
}

function stInsertAfter(id: string, block: any): void {
  const i = stIndexOf(id);
  stStory.blocks.splice(i < 0 ? stStory.blocks.length : i + 1, 0, block);
}

/** Replace a block in place (the / picker turns an empty line into a chart). */
function stReplaceBlock(id: string, block: any, label: string): void {
  const i = stIndexOf(id);
  if (i < 0) return;
  stStory.blocks[i] = block;
  stEnsureTail();
  stCommit(label, { render: true });
}

function stRemoveBlock(id: string): void {
  const i = stIndexOf(id);
  if (i < 0) return;
  stStory.blocks.splice(i, 1);
  stEnsureTail();
  stCommit('Delete block', { render: true });
}

function stMoveBlock(id: string, toIndex: number): void {
  const from = stIndexOf(id);
  if (from < 0) return;
  const [b] = stStory.blocks.splice(from, 1);
  const to = Math.max(0, Math.min(toIndex > from ? toIndex - 1 : toIndex, stStory.blocks.length));
  stStory.blocks.splice(to, 0, b);
  stEnsureTail();
  stCommit('Move block', { render: true });
}

function stRender(): void {
  const doc = stEl('st-doc');
  if (!doc || !stStory) return;
  ansTeardown(doc);
  doc.textContent = '';
  stStory.blocks.forEach((b: any, i: number) => doc.appendChild(stBlockRow(b, i)));
  stRenderOutline();
  stPaintUndo();
}

function stBlockRow(block: any, index: number): HTMLElement {
  const row = document.createElement('div');
  row.className = 'st-block st-block--' + block.kind;
  row.id = 'st-b-' + block.id;
  row.dataset.blockId = block.id;

  const gutter = document.createElement('div');
  gutter.className = 'st-gutter';
  const add = document.createElement('button');
  add.type = 'button';
  add.className = 'st-gutter-btn st-add';
  iconOnly(add, 'plus', 'Add a block below');
  add.addEventListener('click', () => stOpenPicker(add, (kind) => { void stAddAfter(block.id, kind); }));
  const handle = document.createElement('button');
  handle.type = 'button';
  handle.className = 'st-gutter-btn st-handle';
  iconOnly(handle, 'more-vertical', 'Drag to move · click for options');
  handle.addEventListener('mousedown', () => { row.draggable = true; });
  handle.addEventListener('click', () => stBlockMenu(handle, block, index));
  gutter.appendChild(add);
  gutter.appendChild(handle);
  row.appendChild(gutter);

  const body = document.createElement('div');
  body.className = 'st-block-body';
  row.appendChild(body);
  stRenderBlock(body, block);

  // Drag to reorder — armed only from the handle, so selecting text in a
  // paragraph never starts a drag.
  row.addEventListener('dragstart', (e) => {
    if (!row.draggable) { e.preventDefault(); return; }
    row.classList.add('is-dragging');
    if (e.dataTransfer) { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/x-story-block', block.id); }
  });
  row.addEventListener('dragend', () => { row.draggable = false; row.classList.remove('is-dragging'); stClearDropMarks(); });
  row.addEventListener('dragover', (e) => {
    if (!e.dataTransfer || !e.dataTransfer.types.includes('text/x-story-block')) return;
    e.preventDefault();
    const r = row.getBoundingClientRect();
    stClearDropMarks();
    row.classList.add(e.clientY < r.top + r.height / 2 ? 'drop-before' : 'drop-after');
  });
  row.addEventListener('drop', (e) => {
    const id = e.dataTransfer ? e.dataTransfer.getData('text/x-story-block') : '';
    if (!id) return;
    e.preventDefault();
    const r = row.getBoundingClientRect();
    const before = e.clientY < r.top + r.height / 2;
    const target = stIndexOf(block.id);
    stClearDropMarks();
    if (id !== block.id && target >= 0) stMoveBlock(id, before ? target : target + 1);
  });
  return row;
}

function stClearDropMarks(): void {
  document.querySelectorAll('.st-block.drop-before, .st-block.drop-after')
    .forEach((n) => n.classList.remove('drop-before', 'drop-after'));
}

function stBlockMenu(anchor: HTMLElement, block: any, index: number): void {
  openMiniMenu(anchor, (menu: HTMLElement, close: () => void) => {
    const add = (label: string, run: () => void, disabled = false): void => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'chart-menu-item';
      b.textContent = label;
      b.disabled = disabled;
      b.addEventListener('click', () => { close(); run(); });
      menu.appendChild(b);
    };
    add('Move up', () => stMoveBlock(block.id, index - 1), index === 0);
    add('Move down', () => stMoveBlock(block.id, index + 2), index >= stStory.blocks.length - 1);
    add('Duplicate', () => {
      stInsertAfter(block.id, Object.assign(JSON.parse(JSON.stringify(block)), { id: stNewId() }));
      stCommit('Duplicate block', { render: true });
    });
    if (block.kind === 'visual') add('Open visual', () => { selectSection('visuals'); void openSavedVisual(block.visualId); });
    add('Delete', () => stRemoveBlock(block.id));
  });
}

/** "+" on a block: add the picked kind BELOW it. */
async function stAddAfter(id: string, kind: string): Promise<void> {
  const block = await stMakeBlock(kind);
  if (!block) return;
  stInsertAfter(id, block);
  stEnsureTail();
  stCommit('Add block', { render: true });
  if (block.kind === 'text' || block.kind === 'callout') stEditBlock(block.id);
}

// ── The outline ──────────────────────────────────────────────────────────────

function stRenderOutline(): void {
  const list = stEl('st-outline-list');
  const empty = stEl('st-outline-empty');
  if (!list || !stStory) return;
  const heads = storyOutline(stStory.blocks);
  list.textContent = '';
  heads.forEach((h) => {
    const li = document.createElement('li');
    li.className = 'st-outline-item st-outline-item--h' + h.level;
    const a = document.createElement('button');
    a.type = 'button';
    a.className = 'st-outline-link';
    a.textContent = h.text;
    a.title = h.text;
    a.addEventListener('click', () => {
      const el = document.getElementById('st-b-' + h.blockId);
      if (!el) return;
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      el.classList.remove('is-flash');
      void el.offsetWidth;
      el.classList.add('is-flash');
    });
    li.appendChild(a);
    list.appendChild(li);
  });
  if (empty) empty.hidden = heads.length > 0;
}

// ── Boot wiring (once) ───────────────────────────────────────────────────────

function initStoryPage(): void {
  const back = stEl('st-back');
  if (back) back.addEventListener('click', () => { void stClose(); });
  const name = stEl<HTMLInputElement>('st-name');
  if (name) {
    name.addEventListener('input', () => {
      if (!stStory) return;
      stStory.name = name.value.replace(/\s+/g, ' ').trim() || 'Untitled story';
      stCommit('Rename', { coalesce: true });
    });
    name.addEventListener('keydown', (e) => { if (e.key === 'Enter') name.blur(); });
  }
  const undo = stEl('st-undo');
  if (undo) undo.addEventListener('click', () => stUndo());
  const redo = stEl('st-redo');
  if (redo) redo.addEventListener('click', () => stRedo());
  const present = stEl('st-present');
  if (present) present.addEventListener('click', () => { void stEnterPresent(); });
  const exp = stEl('st-export');
  if (exp) exp.addEventListener('click', () => { void stExportPdf(); });
  const more = stEl('st-more');
  if (more) {
    more.addEventListener('click', () => {
      openMiniMenu(more, (menu: HTMLElement, close: () => void) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'chart-menu-item dash-card-menu-rm';
        b.textContent = 'Delete story';
        b.addEventListener('click', () => {
          close();
          if (!stStory || !window.confirm(`Delete “${stStory.name}”? The charts and metrics it shows are not deleted.`)) return;
          const id = stStory.id;
          clearTimeout(stSaveTimer);
          stSaveTimer = 0;
          void window.hub.deleteStory(currentProjectId, id).then(() => stClose());
        });
        menu.appendChild(b);
      });
    });
  }
  // Anything that brings the Dashboards list back (the nav, a section refresh,
  // a closed dashboard) is leaving the story: save it and step aside, rather
  // than leave the page drawn over the list.
  const list = stEl('an-list-view');
  if (list) {
    new MutationObserver(() => {
      if (!list.hidden && stIsOpen()) {
        const page = stEl('st-page');
        if (page) page.hidden = true;
        void stFlush().then(() => { stStory = null; stHist = null; });
      }
    }).observe(list, { attributes: true, attributeFilter: ['hidden'] });
  }
  initStoryList();
}
