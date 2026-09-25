// The Assistant's EDIT DELTA card — changing a dashboard that is already open.
//
// Classic global-scope renderer <script>: NO import/export. Loads AFTER
// dockPropose.js (dkProposalCard / dkMkBtn / dkAppendProposal /
// dkRemoveProposalCard / dkAccumulateIntent), dashGrid.js (pushCard, removeCard,
// dashUuid, nextFreeRow, dashCurrentPage, renderDashPages, renderDashGrid,
// reapplyCardStyle, handleAddPage, handleRenamePage), dashboards.js
// (markDashDirty, dashCurrent, dashPageIdx) and anDraft.js (anDraftVisualEl,
// anDraftAppendDropped) — see the load-order comment in index.html.
//
// A FOURTH proposal type, in its own file because dockPropose.ts is already 626
// lines and the hard cap is 800 (.claude/rules/file-size.md). One file, one job:
// this one turns a validated delta into a diff the user can read, apply, and
// take back.
//
// ── What this file is NOT allowed to do ─────────────────────────────────────
// It does not decide anything. Every op it applies was resolved and validated in
// MAIN (src/analysis/dashboardDelta.ts) against the real dashboard and the real
// dataset columns; anything unresolvable arrived in `dropped` and is SHOWN. It
// computes no figure: a previewed new tile carries data that previewPlan already
// computed, and a tile with none shows its note.
//
// ── Why it reuses the editor's own mutation functions ───────────────────────
// pushCard/removeCard/handleAddPage/… mutate dashCurrent.pages in place and call
// markDashDirty(), which is the ONE debounced write (persistAnalysis). Reaching
// past them to window.hub.updateAnalysis would be a second write path that
// bypasses the dirty flag and the sanitizers, and would drift the moment the
// editor's own rules change.

/** The state Undo restores. Deep clones, not references — the ops mutate the
 *  live tree in place, so a reference would be the post-edit state by the time
 *  anyone clicked. */
interface DkDeltaSnapshot {
  pages: any[];
  name: string;
  pageIdx: number;
  /** visualId → the Visual record as it was, or null when the delta CREATED it
   *  (undo deletes those). A sheets-only snapshot silently fails to undo a
   *  retype, because a visual card holds an id and the encoding lives on the
   *  separate Visual record. */
  // `before` is a Visual record, or null when the delta CREATED it (undo
  // deletes those). any: the renderer types every hub record loosely.
  visuals: { id: string; before: any }[];
}

// ── Entry ────────────────────────────────────────────────────────────────────

/**
 * Ask main for an edit delta and offer it. Silent on everything that does not
 * pan out — no open dashboard, no model, nothing resolvable — because the text
 * answer already stands and a proposal is a bonus, exactly as the other three.
 */
async function dkOfferEditProposal(analysisId: string, intent: string, containerId = 'dk-messages'): Promise<void> {
  if (!currentProjectId || !analysisId) return;
  let res: any;
  try {
    res = await window.hub.editDashboard(currentProjectId, analysisId, intent);
  } catch (_) {
    return;
  }
  if (!res || res.ok === false || res.notReady) return;
  const ops: any[] = Array.isArray(res.ops) ? res.ops : [];
  const dropped: any[] = Array.isArray(res.dropped) ? res.dropped : [];
  // Nothing survived validation and nothing to explain — say nothing rather
  // than show an empty card.
  if (!ops.length && !dropped.length) return;
  dkRenderDeltaCard(res, containerId);
}

// ── The diff, in words ───────────────────────────────────────────────────────

/** Page label for an op that names one. 1-based, because the UI is. */
function dkPageLabel(pageIndex: unknown): string {
  const i = typeof pageIndex === 'number' && pageIndex >= 0 ? pageIndex : 0;
  const pages = dashCurrent && Array.isArray(dashCurrent.pages) ? dashCurrent.pages : [];
  const p = pages[i];
  return p && p.name ? String(p.name) : 'Page ' + (i + 1);
}

/** The title of an existing tile, for a line that names one. */
function dkTileTitle(cardId: string): string {
  const pages = dashCurrent && Array.isArray(dashCurrent.pages) ? dashCurrent.pages : [];
  for (const p of pages) {
    const cards = Array.isArray(p.cards) ? p.cards : [];
    for (const c of cards) {
      if (c && c.id === cardId) {
        if (c.type === 'metric' && c.metric) return String(c.metric.label || c.metric.column);
        if (c.type === 'text') return String(c.heading || 'Text');
        if (c.type === 'control' && c.control) return String(c.control.label || c.control.column);
        return 'this tile';
      }
    }
  }
  return 'this tile';
}

/** One op → { sign, text }. The sign carries the KIND of change; the text says
 *  what it does in words, so the glyph is never the only signal. */
function dkDeltaLine(op: any): { sign: string; cls: string; text: string } | null {
  if (!op || typeof op.op !== 'string') return null;
  switch (op.op) {
    case 'addTile':
      return {
        sign: '+', cls: 'dk-delta-add',
        text: `${op.name} (${op.chartType}) → ${dkPageLabel(op.pageIndex)}`,
      };
    case 'addMetric':
      return {
        sign: '+', cls: 'dk-delta-add',
        text: `${op.label} — ${op.aggregation} of ${op.column} → ${dkPageLabel(op.pageIndex)}`,
      };
    case 'addControl':
      return {
        sign: '+', cls: 'dk-delta-add',
        text: `${op.label} — ${op.kind.replace('_', ' ')} filter on ${op.column} → ${dkPageLabel(op.pageIndex)}`,
      };
    case 'addPage':
      return { sign: '+', cls: 'dk-delta-add', text: `New page "${op.name}"` };
    case 'replaceTileEncoding': {
      const bits: string[] = [];
      if (op.chartType) bits.push('now a ' + op.chartType);
      if (op.encoding && op.encoding.category) bits.push('by ' + op.encoding.category);
      return {
        sign: '~', cls: 'dk-delta-mod',
        text: `${op.title || dkTileTitle(op.cardId)}: ${bits.join(', ') || 'new encoding'}`,
      };
    }
    case 'moveTile': {
      const where = op.position === 'top' ? 'to the top'
        : op.position === 'bottom' ? 'to the bottom'
          : `${op.position} ${op.anchorTitle || dkTileTitle(op.anchorCardId)}`;
      return { sign: '~', cls: 'dk-delta-mod', text: `Move ${op.title || dkTileTitle(op.cardId)} ${where}` };
    }
    case 'renamePage':
      return { sign: '~', cls: 'dk-delta-mod', text: `Rename ${dkPageLabel(op.pageIndex)} to "${op.name}"` };
    case 'setTitle':
      return { sign: '~', cls: 'dk-delta-mod', text: `Rename this dashboard to "${op.name}"` };
    case 'removeTile':
      return { sign: '−', cls: 'dk-delta-del', text: op.title || dkTileTitle(op.cardId) };
    default:
      return null;
  }
}

function dkRenderDeltaCard(res: any, containerId = 'dk-messages'): void {
  const { card, actions } = dkProposalCard('Suggested change');
  const ops: any[] = Array.isArray(res.ops) ? res.ops : [];

  const list = document.createElement('div');
  list.className = 'dk-delta-list';
  ops.forEach((op) => {
    const line = dkDeltaLine(op);
    if (!line) return;
    const row = document.createElement('div');
    row.className = 'dk-delta-row ' + line.cls;
    const sign = document.createElement('span');
    sign.className = 'dk-delta-sign';
    sign.setAttribute('aria-hidden', 'true'); // the text says it too
    sign.textContent = line.sign;
    const text = document.createElement('span');
    text.className = 'dk-delta-text';
    text.textContent = line.text;
    row.append(sign, text);
    list.appendChild(row);
  });
  if (list.childNodes.length) card.appendChild(list);

  // A NEW tile is previewed with real, app-computed numbers (previewPlan), or
  // shows its note. Same renderer the draft modal and the plan card use.
  const previews: any[] = Array.isArray(res.previews) ? res.previews : [];
  if (previews.length) {
    const grid = document.createElement('div');
    grid.className = 'dk-plan-grid';
    previews.forEach((v: any) => {
      if (typeof anDraftVisualEl === 'function') grid.appendChild(anDraftVisualEl(v, true));
    });
    if (grid.childNodes.length) card.appendChild(grid);
  }

  // Always visible — one renderer, shared with the draft modal and plan card.
  if (typeof anDraftAppendDropped === 'function') anDraftAppendDropped(card, res && res.dropped);

  if (!ops.length) {
    // Everything was refused. The dropped list above is the whole message; an
    // Apply button here would do nothing and imply otherwise.
    const dismissOnly = dkMkBtn('Dismiss', false, () => dkRemoveProposalCard(card));
    actions.appendChild(dismissOnly);
    card.appendChild(actions);
    dkAppendProposal(card, containerId);
    return;
  }

  const apply = dkMkBtn('Apply', true, () => {
    void (async () => {
      apply.disabled = true;
      let snap: DkDeltaSnapshot | null = null;
      try {
        snap = await dkApplyDelta(ops);
      } catch (_) {
        snap = null;
      }
      if (!snap) {
        apply.disabled = false;
        showToast('Could not apply that change.');
        return;
      }
      dkMarkDeltaApplied(card, actions, snap, ops.length);
    })();
  });
  actions.appendChild(apply);

  const dismiss = dkMkBtn('Dismiss', false, () => dkRemoveProposalCard(card));
  actions.appendChild(dismiss);
  card.appendChild(actions);
  dkAppendProposal(card, containerId);
}

/** After Apply the card STAYS, says what happened, and offers the one way back.
 *  Removing it would leave the user with a changed dashboard and no undo. */
function dkMarkDeltaApplied(card: HTMLElement, actions: HTMLElement, snap: DkDeltaSnapshot, n: number): void {
  actions.textContent = '';
  const done = document.createElement('div');
  done.className = 'dk-delta-done';
  done.textContent = n === 1 ? 'Applied 1 change.' : `Applied ${n} changes.`;
  card.insertBefore(done, actions);

  const undo = dkMkBtn('Undo', false, () => {
    void (async () => {
      undo.disabled = true;
      try {
        await dkUndoDelta(snap);
      } catch (_) {
        undo.disabled = false;
        showToast('Could not undo that change.');
        return;
      }
      showToast('Change undone.');
      dkRemoveProposalCard(card);
    })();
  });
  actions.appendChild(undo);

  const close = dkMkBtn('Dismiss', false, () => dkRemoveProposalCard(card));
  actions.appendChild(close);
}

// ── Apply ────────────────────────────────────────────────────────────────────

function dkClonePages(): any[] {
  const pages = dashCurrent && Array.isArray(dashCurrent.pages) ? dashCurrent.pages : [];
  return JSON.parse(JSON.stringify(pages));
}

/** Find a card by id anywhere in the open dashboard. */
// any: a Card, typed loosely as every renderer record is.
function dkFindCard(cardId: string): any {
  const pages = dashCurrent && Array.isArray(dashCurrent.pages) ? dashCurrent.pages : [];
  for (const p of pages) {
    const cards = Array.isArray(p.cards) ? p.cards : [];
    for (const c of cards) if (c && c.id === cardId) return c;
  }
  return null;
}

/** Push a card onto a SPECIFIC page. pushCard() targets the open page only, so
 *  an op naming another page needs this — same shape, same markDashDirty. */
function dkPushCardOn(pageIndex: number, card: any): void {
  const pages = dashCurrent && Array.isArray(dashCurrent.pages) ? dashCurrent.pages : [];
  const p = pages[pageIndex] || pages[dashPageIdx] || pages[0];
  if (!p) return;
  if (!Array.isArray(p.cards)) p.cards = [];
  card.layout.y = nextFreeRow(p.cards);
  p.cards.push(card);
}

/**
 * Run the ops, returning the snapshot that reverses them.
 *
 * Order is deliberate: pages are created before tiles that target them, and
 * every op is applied through the editor's own mutation so the dirty flag, the
 * sanitizers and the repaint stay exactly as they are for a hand edit.
 */
async function dkApplyDelta(ops: any[]): Promise<DkDeltaSnapshot | null> {
  if (!dashCurrent || !currentProjectId) return null;
  const snap: DkDeltaSnapshot = {
    pages: dkClonePages(),
    name: String(dashCurrent.name || ''),
    pageIdx: dashPageIdx,
    visuals: [],
  };

  for (const op of ops) {
    if (!op || typeof op.op !== 'string') continue;
    if (op.op === 'addPage') {
      dashCurrent.pages.push({ id: dashUuid(), name: String(op.name), cards: [] });
    } else if (op.op === 'renamePage') {
      const p = dashCurrent.pages[op.pageIndex];
      if (p) p.name = String(op.name);
    } else if (op.op === 'setTitle') {
      try {
        await window.hub.renameAnalysis(currentProjectId, String(dashCurrent.id), String(op.name));
        dashCurrent.name = String(op.name);
      } catch (_) { /* the rest of the delta still stands */ }
    } else if (op.op === 'addTile') {
      // A visual card holds only an id, so the Visual record comes first —
      // sanitizeCard DROPS a visual card without one.
      let vis: any = null;
      try {
        vis = await window.hub.saveVisual({
          projectId: currentProjectId, datasetId: op.datasetId, name: op.name,
          chartType: op.chartType, encoding: op.encoding, overrides: {},
          filters: Array.isArray(op.filters) ? op.filters : [],
        });
      } catch (_) { vis = null; }
      if (vis && vis.ok !== false && vis.id) {
        // `before: null` — undo DELETES it, rather than leaving an orphan in
        // the Visuals gallery that the user never asked for.
        snap.visuals.push({ id: String(vis.id), before: null });
        dkPushCardOn(op.pageIndex, {
          id: dashUuid(), type: 'visual', visualId: String(vis.id),
          layout: { x: 0, y: 0, w: 6, h: 6 },
        });
      }
    } else if (op.op === 'addMetric') {
      // No Visual record to make: a metric card carries its own definition, and
      // the FIGURE is computed at render time by dashboard:metric — the same
      // path a hand-added KPI takes.
      dkPushCardOn(op.pageIndex, {
        id: dashUuid(), type: 'metric',
        metric: { datasetId: op.datasetId, column: op.column, aggregation: op.aggregation, label: op.label },
        layout: { x: 0, y: 0, w: 3, h: 2 },
      });
    } else if (op.op === 'addControl') {
      dkPushCardOn(op.pageIndex, {
        id: dashUuid(), type: 'control',
        control: { kind: op.kind, label: op.label, datasetId: op.datasetId, column: op.column },
        // Zeroed and ignored on read: a control is a filter-bar chip, not a
        // tile (dashControlBar.ts). Same layout the + Control button writes.
        layout: { x: 0, y: 0, w: 0, h: 0 },
      });
    } else if (op.op === 'removeTile') {
      const c = dkFindCard(op.cardId);
      if (c) removeCard(c);
    } else if (op.op === 'moveTile') {
      dkMoveTile(op);
    } else if (op.op === 'replaceTileEncoding') {
      await dkRetypeTile(op, snap);
    }
  }

  markDashDirty('Assistant change');
  renderDashPages();
  renderDashGrid();
  return snap;
}

/** Move a tile to the top/bottom of its page, or beside another tile. The APP
 *  computes the coordinates — the model named a position, never a grid slot. */
function dkMoveTile(op: any): void {
  const card = dkFindCard(op.cardId);
  if (!card || !card.layout) return;
  const pages = dashCurrent && Array.isArray(dashCurrent.pages) ? dashCurrent.pages : [];
  const page = pages.find((p: any) => (p.cards || []).some((c: any) => c && c.id === op.cardId));
  if (!page) return;
  const others = (page.cards || []).filter((c: any) => c && c.id !== op.cardId);

  if (op.position === 'top') {
    // Everything else moves down by this tile's height, so nothing overlaps.
    const h = card.layout.h || 1;
    others.forEach((c: any) => { if (c.layout) c.layout.y = (c.layout.y || 0) + h; });
    card.layout.y = 0;
  } else if (op.position === 'bottom') {
    card.layout.y = nextFreeRow(others);
  } else {
    const anchor = others.find((c: any) => c.id === op.anchorCardId);
    if (!anchor || !anchor.layout) return;
    const at = op.position === 'after' ? (anchor.layout.y || 0) + (anchor.layout.h || 1) : (anchor.layout.y || 0);
    others.forEach((c: any) => {
      if (c.layout && (c.layout.y || 0) >= at) c.layout.y = (c.layout.y || 0) + (card.layout.h || 1);
    });
    card.layout.y = at;
  }
  if (typeof reapplyCardStyle === 'function') reapplyCardStyle(card);
}

/** Retype/re-encode a visual tile. The encoding lives on the VISUAL record, not
 *  the card — which is exactly why the snapshot has to carry the record. */
async function dkRetypeTile(op: any, snap: DkDeltaSnapshot): Promise<void> {
  if (!currentProjectId) return;
  // The op names a CARD; the encoding lives on the Visual that card points at.
  // Main validated the card is a visual one, so this lookup is the last hop.
  const card = dkFindCard(op.cardId);
  const visualId = card && card.visualId ? String(card.visualId) : '';
  if (!visualId) return;

  let before: any = null;
  try {
    before = await window.hub.getVisual(currentProjectId, visualId);
  } catch (_) { before = null; }
  if (!before) return;
  snap.visuals.push({ id: visualId, before });
  try {
    // Only the fields the delta actually changed; everything else keeps the
    // record's own value, so a retype cannot silently reset an encoding.
    await window.hub.updateVisual(currentProjectId, visualId, {
      chartType: op.chartType || before.chartType,
      encoding: op.encoding || before.encoding,
      filters: op.filters || before.filters || [],
    });
  } catch (_) { /* the card stays as it was; the rest of the delta still stands */ }
}

// ── Undo ─────────────────────────────────────────────────────────────────────

/**
 * Put everything back: the sheets, the name, and every Visual the delta touched.
 *
 * The autosave has already written the change (markDashDirty schedules a 600ms
 * save), so this does NOT try to cancel a pending write — it restores the state
 * and marks dirty again, letting the same one write path persist the revert.
 */
async function dkUndoDelta(snap: DkDeltaSnapshot): Promise<void> {
  if (!dashCurrent || !currentProjectId || !snap) return;

  for (const v of snap.visuals) {
    try {
      // Taking back a visual the edit CREATED is not a delete to keep in Trash.
      if (v.before === null) await window.hub.deleteVisual(currentProjectId, v.id, { permanent: true });
      else {
        await window.hub.updateVisual(currentProjectId, v.id, {
          name: v.before.name, chartType: v.before.chartType, encoding: v.before.encoding,
          overrides: v.before.overrides || {}, filters: v.before.filters || [],
        });
      }
    } catch (_) { /* keep going — a partial undo beats an aborted one */ }
  }

  if (snap.name && snap.name !== dashCurrent.name) {
    try {
      await window.hub.renameAnalysis(currentProjectId, String(dashCurrent.id), snap.name);
      dashCurrent.name = snap.name;
    } catch (_) { /* the sheets still revert */ }
  }

  // Restore BOTH names of the one array — persistAnalysis reads `pages` and
  // sends it as `sheets`, and they must not become two arrays here.
  dashCurrent.pages = JSON.parse(JSON.stringify(snap.pages));
  dashCurrent.sheets = dashCurrent.pages;
  // A revert that drops a page must clamp the cursor, exactly as
  // persistAnalysis does after main sanitizes.
  if (dashPageIdx >= dashCurrent.pages.length) dashPageIdx = snap.pageIdx < dashCurrent.pages.length ? snap.pageIdx : 0;

  markDashDirty('Undo Assistant change');
  renderDashPages();
  renderDashGrid();
}
