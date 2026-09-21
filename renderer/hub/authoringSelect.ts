// Selecting a card, and moving one: the click/Escape selection model, and
// direct manipulation (drag to move, drag an edge to resize).
//
// Selection is what opens Properties, and deselection closes it only when the
// selection opened it — a pane opened from the rail belongs to the user.
//
// Split verbatim out of authoring.ts — see .claude/rules/file-size.md. Classic
// global-scope renderer <script>: no import/export.

// ── Selection ───────────────────────────────────────────────────────────────
function anCardById(id: string | null): any {
  if (!id) return null;
  const page = dashCurrentPage();
  const cards = page && Array.isArray(page.cards) ? page.cards : [];
  return cards.find((c: any) => c && c.id === id) || null;
}

/** Paint the selection ring. Called after every grid render, which rebuilds cards. */
function anPaintSelection(): void {
  document.querySelectorAll('#dash-grid .dash-card').forEach((el) => {
    el.classList.toggle('is-selected', (el as HTMLElement).dataset.cardId === anSelectedCardId);
  });
}

/**
 * Bind the panels to a card. `null` clears them.
 *
 * Only ever does anything in analysis mode — see the invariant at the top.
 */
async function anSelectCard(cardId: string | null): Promise<void> {
  if (dashMode !== 'analysis') return;
  anSelectedCardId = cardId;
  anPaintSelection();

  const card = anCardById(cardId);
  anRenderProps(card);
  anRenderInteractions(card);
  // Selecting a card OPENS Properties — editing the card is why it was
  // clicked, and hunting the rail for the right flyout was the complaint.
  // Deselecting closes it again only when this auto-open put it there; a pane
  // the user opened from the rail is theirs and stays. Yanking is no longer a
  // concern now the field list lives in the Build tab permanently: opening
  // Properties cannot move it out from under a drag.
  if (card) {
    if (anFlyout !== 'an-pane-props') {
      anPropsAuto = anFlyout === null; // remember whether WE opened it over nothing
      anSetFlyout('an-pane-props');
    }
  } else if (anFlyout === 'an-pane-props' && anPropsAuto) {
    anSetFlyout(null);
    anPropsAuto = false;
  }

  // Fields + wells are a VISUAL card's business. A text or metric card still
  // selects, and still gets Properties — it just has no encoding to edit.
  if (!card || card.type !== 'visual' || !card.visualId || !currentProjectId) {
    anVisual = null;
    anColumns = [];
    anShowEncoding(false, card ? 'That card has no fields to edit.' : 'Select a visual card to see its fields.');
    return;
  }

  let visual: any = null;
  try {
    visual = await window.hub.getVisual(currentProjectId, String(card.visualId));
  } catch (_) {
    visual = null;
  }
  if (!visual) {
    anVisual = null;
    anShowEncoding(false, 'That visual could not be loaded.');
    return;
  }
  // The click may have moved on while the two awaits ran; a stale bind would
  // show one card's fields against another's selection ring.
  if (anSelectedCardId !== cardId) return;

  anVisual = visual;
  let meta: any = null;
  try {
    meta = await window.hub.getDatasetMeta(currentProjectId, String(visual.datasetId || ''));
  } catch (_) {
    meta = null;
  }
  if (anSelectedCardId !== cardId) return;
  anDataset = meta
    ? { name: String(meta.name || 'Dataset'), kind: String(meta.sourceKind || 'data') }
    : null;
  anColumns = meta && Array.isArray(meta.columns)
    ? meta.columns.map((c: any) => ({
        name: c && c.name != null ? String(c.name) : '',
        type: c && (c.type === 'number' || c.type === 'date') ? c.type : 'text',
      }))
    : [];

  anRenderFields();
  // Repaint Properties now that anVisual is loaded: the first call above ran
  // before the awaits, so the title field had no name to show.
  anRenderProps(card);
  anRenderInteractions(card);
  anEnsureForm();
  anForm!.setColumns(anColumns, visual.encoding, Array.isArray(visual.filters) ? visual.filters : []);
  // A PIVOT's shelves are authored in the Visuals builder, not here — this
  // panel has one encoding form and a pivot needs three ordered shelves. So its
  // chart fields are hidden rather than shown editing a mirror of themselves
  // that changes nothing, and Filters stays, because a filter means the same
  // thing to a pivot as to a chart. `anWriteVisual` carries the pivot block
  // through untouched, so nothing here can downgrade a pivot to a bar chart.
  const isPivot = anIsPivot();
  anForm!.showFields(!isPivot);
  setAnPropsNote(isPivot ? AN_PIVOT_NOTE : '');
  anShowEncoding(true, '');
  await anRenderAiSlot();
  await anRenderSwitcher();
}

function anShowEncoding(on: boolean, hint: string): void {
  const inner = anEl('an-props-inner');
  const propsHint = anEl('an-props-hint');
  const fields = anEl('an-fields');
  if (inner) inner.hidden = !on;
  if (propsHint) {
    propsHint.hidden = on;
    propsHint.textContent = hint || 'Select a visual card to edit it.';
  }
  if (fields) fields.hidden = !on;
  const search = anEl('an-field-search');
  if (search) search.hidden = !on;
  if (!on && fields) fields.innerHTML = '';
  // The browse render reads the same state, so a cleared selection empties it
  // and puts its own hint back.
  anRenderBrowseFields();
}


// ── Direct manipulation: drag to move, drag an edge to resize ───────────────
// QuickSight moves a visual by dragging it and resizes it by its edges, and that
// is what a sheet layout wants — stepper buttons make you aim at a target four
// clicks away.
//
// Pointer Events, not HTML5 drag-and-drop. HTML5 drag gives no continuous
// position (dragover fires coarsely, and the drag image is the browser's), which
// is exactly what a snap-to-grid preview needs. setPointerCapture also keeps the
// gesture alive when the pointer leaves the card, which a fast drag always does.
//
// Nothing moves until the pointer is released: a ghost shows the target cell
// while the card stays put. Re-laying out the real card mid-drag would re-render
// its chart on every frame.
let anGhost: HTMLElement | null = null;
let anGesture: any = null;

/** Column pitch: 12 tracks with 11 gaps between them, so pitch = (w + gap) / 12. */
function anColPitch(grid: HTMLElement): number {
  return (grid.getBoundingClientRect().width + dashGapPx()) / DASH_GRID_COLS;
}

function anRowPitch(): number {
  return dashRowPx() + dashGapPx();
}

function anShowGhost(grid: HTMLElement, x: number, y: number, w: number, h: number): void {
  if (!anGhost) {
    anGhost = document.createElement('div');
    anGhost.className = 'an-ghost';
    grid.appendChild(anGhost);
  }
  anGhost.style.gridColumn = x + 1 + ' / span ' + w;
  anGhost.style.gridRow = y + 1 + ' / span ' + h;
}

function anClearGhost(): void {
  if (anGhost) anGhost.remove();
  anGhost = null;
}

function anBeginGesture(e: PointerEvent, card: any, el: HTMLElement, mode: string): void {
  const grid = anEl('dash-grid');
  if (!grid || dashMode !== 'analysis') return;
  const l = card.layout || (card.layout = { x: 0, y: 0, w: 6, h: 4 });
  anGesture = {
    card, el, mode,
    startX: e.clientX, startY: e.clientY,
    x0: l.x || 0, y0: l.y || 0, w0: l.w || 1, h0: l.h || 1,
    next: { x: l.x || 0, y: l.y || 0, w: l.w || 1, h: l.h || 1 },
    grid,
  };
  el.classList.add('is-dragging');
  document.body.classList.add('an-grabbing');
  // Keeps the gesture alive when the pointer leaves the card, which a fast drag
  // always does. It THROWS for a pointer id the browser has no active pointer
  // for, and capture is an optimisation here — the window listeners carry the
  // gesture either way — so a failure must not take the drag down with it.
  try {
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  } catch (_) { /* no active pointer for that id */ }
  e.preventDefault();
}

function anMoveGesture(e: PointerEvent): void {
  if (!anGesture) return;
  const g = anGesture;
  const dx = Math.round((e.clientX - g.startX) / anColPitch(g.grid));
  const dy = Math.round((e.clientY - g.startY) / anRowPitch());
  if (g.mode === 'move') {
    g.next.x = clampInt(g.x0 + dx, 0, DASH_GRID_COLS - g.w0, g.x0);
    g.next.y = Math.max(0, g.y0 + dy);
    g.next.w = g.w0;
    g.next.h = g.h0;
  } else {
    // Resize from the right/bottom edge: x,y are fixed and w,h follow the pointer.
    g.next.x = g.x0;
    g.next.y = g.y0;
    g.next.w = g.mode === 'e' || g.mode === 'se'
      ? clampInt(g.w0 + dx, 1, DASH_GRID_COLS - g.x0, g.w0) : g.w0;
    g.next.h = g.mode === 's' || g.mode === 'se'
      ? Math.max(1, g.h0 + dy) : g.h0;
  }
  anShowGhost(g.grid, g.next.x, g.next.y, g.next.w, g.next.h);
}

function anEndGesture(): void {
  if (!anGesture) return;
  const g = anGesture;
  anGesture = null;
  g.el.classList.remove('is-dragging');
  document.body.classList.remove('an-grabbing');
  anClearGhost();
  const l = g.card.layout;
  const changed = l.x !== g.next.x || l.y !== g.next.y || l.w !== g.next.w || l.h !== g.next.h;
  if (!changed) return;
  l.x = g.next.x; l.y = g.next.y; l.w = g.next.w; l.h = g.next.h;
  reapplyCardStyle(g.card);
  // ONE commit for the whole gesture: anMoveGesture only moves a ghost, so the
  // record is not touched until the pointer comes up, right here.
  markDashDirty(g.mode === 'move' ? 'Move card' : 'Resize card');
}

/**
 * Attach the gesture to every card. Called after each grid render, because
 * renderDashGrid rebuilds the card elements.
 */
function anWireCards(): void {
  if (dashMode !== 'analysis') return;
  const grid = anEl('dash-grid');
  if (!grid) return;
  document.querySelectorAll('#dash-grid .dash-card').forEach((node) => {
    const el = node as HTMLElement;
    if (el.dataset.anWired === '1') return;
    el.dataset.anWired = '1';
    const card = anCardById(el.dataset.cardId || null);
    if (!card) return;

    // The native HTML5 drag the dashboard editor uses would fight the pointer
    // gesture — both start from the same press.
    const head = el.querySelector('.dash-card-head') as HTMLElement | null;
    if (head) {
      head.draggable = false;
      head.addEventListener('pointerdown', (e) => {
        if ((e as PointerEvent).button !== 0) return;
        anSelectCard(card.id);
        anBeginGesture(e as PointerEvent, card, el, 'move');
      });

      // The card's own way into Properties. Added here rather than in
      // dashboards.ts because the whole panel is analysis-only — a published
      // dashboard has no card properties to edit.
      const gear = document.createElement('button');
      gear.type = 'button';
      gear.className = 'an-card-props';
      gear.title = 'Properties';
      gear.setAttribute('aria-label', 'Card properties');
      // Sliders, not a cogwheel: a circle ringed by radial ticks is the
      // universal BRIGHTNESS glyph and read as one on the sheet. This is the
      // same mark the old props rail button used, so the vocabulary is unchanged.
      gear.innerHTML =
        '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true">'
        + '<path d="M5 7h14M5 12h14M5 17h14" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>'
        + '<circle cx="9" cy="7" r="2" fill="currentColor"/><circle cx="15" cy="12" r="2" fill="currentColor"/>'
        + '<circle cx="8" cy="17" r="2" fill="currentColor"/></svg>';
      gear.addEventListener('pointerdown', (e) => e.stopPropagation()); // not a drag
      gear.addEventListener('click', (e) => {
        e.stopPropagation();
        anSelectCard(card.id);
        anSetProps(true);
      });
      head.appendChild(gear);
    }

    // Eight selection squares, as the reference draws them. Decoration only —
    // aria-hidden, no listeners: the resize GESTURE lives on the three edge
    // handles below, and eight draggable corners would be eight more code paths
    // to test for one that already works.
    // ponytail: visual only. Wire nw/n/ne/w/e drag if someone asks to resize
    // from the top or left; today every resize grows right/down.
    const marks = document.createElement('span');
    marks.className = 'an-marks';
    marks.setAttribute('aria-hidden', 'true');
    ['nw', 'n', 'ne', 'w', 'e', 'sw', 's', 'se'].forEach((pos) => {
      const m = document.createElement('span');
      m.className = 'an-mark an-mark--' + pos;
      marks.appendChild(m);
    });
    el.appendChild(marks);

    // Edge + corner handles. Right = width, bottom = height, corner = both.
    (['e', 's', 'se'] as const).forEach((mode) => {
      const h = document.createElement('span');
      h.className = 'an-resize an-resize--' + mode;
      h.setAttribute('aria-hidden', 'true'); // keyboard resize is on the card itself
      h.addEventListener('pointerdown', (e) => {
        if ((e as PointerEvent).button !== 0) return;
        e.stopPropagation();
        anSelectCard(card.id);
        anBeginGesture(e as PointerEvent, card, el, mode);
      });
      el.appendChild(h);
    });

    // The keyboard path. Dragging is a mouse gesture, and it cannot be the ONLY
    // way to lay out a sheet — arrows move, shift+arrows resize.
    el.tabIndex = 0;
    el.addEventListener('keydown', (e) => {
      const k = (e as KeyboardEvent).key;
      const d = k === 'ArrowLeft' ? [-1, 0] : k === 'ArrowRight' ? [1, 0]
        : k === 'ArrowUp' ? [0, -1] : k === 'ArrowDown' ? [0, 1] : null;
      if (!d) return;
      e.preventDefault();
      anSelectCard(card.id);
      if ((e as KeyboardEvent).shiftKey) resizeCard(card, d[0], d[1]);
      else nudgeCard(card, d[0], d[1]);
    });
  });

  // One listener pair for the whole gesture, not one per card.
  if (!grid.dataset.anGestures) {
    grid.dataset.anGestures = '1';
    window.addEventListener('pointermove', anMoveGesture);
    window.addEventListener('pointerup', anEndGesture);
    window.addEventListener('pointercancel', anEndGesture);
  }
}

