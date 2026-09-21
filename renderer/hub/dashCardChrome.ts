// A dashboard card's CHROME — the element, the header row, the ⋯ menu and the
// title. Not what is inside it: `renderDashCardBody` and the per-type renderers
// stay in dashGrid.ts, which is where the grid, the layout arithmetic and the
// drag/drop live.
//
// Split out of dashGrid.ts when it crossed the 800-line cap
// (.claude/rules/file-size.md). It is one job — "what a card looks like before
// anything is drawn in it" — and it is also where the two per-card-type menu
// prepends meet: `alCardMenuItems` (alerts.ts) and `pivotMenuItems`
// (pivotRender.ts), each absent on the card types it does not apply to.
//
// Loads after dashGrid.js, whose nudge/resize/remove it calls at CLICK time.
// Classic global-scope renderer <script>: no import/export.

function makeDashCardEl(card: any): HTMLElement {
  const el = document.createElement('div');
  el.className = 'dash-card dash-card--' + card.type;
  el.dataset.cardId = card.id;
  applyDashCardStyle(el, card.layout);

  // Header: drag handle + title + layout controls + remove.
  const head = document.createElement('div');
  head.className = 'dash-card-head';
  head.draggable = !dashReadOnly; // a snapshot cannot be rearranged
  head.addEventListener('dragstart', (e) => {
    dashDragId = card.id;
    if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
  });
  head.addEventListener('dragend', () => { dashDragId = null; });

  const title = document.createElement('span');
  title.className = 'dash-card-title';
  title.textContent = dashCardTitle(card);
  head.appendChild(title);

  // The bell a watched KPI wears, and the "something fired" mark (alerts.ts).
  alAttachCardBell(el, head, card);

  const ctrls = document.createElement('div');
  ctrls.className = 'dash-card-ctrls';
  // ONE ⋯, not nine glyphs. Drag and the resize handles (authoringSelect.ts)
  // are the primary gestures now, so the cluster was nine permanently-visible
  // buttons for the fallback path — and ' ◀▶▲▼ W−W+H−H+ ' read as a puzzle at
  // 11px. The FUNCTIONS are untouched; only the chrome in front of them changed,
  // so the keyboard path (arrows / shift+arrows) still calls the same two.
  ctrls.appendChild(dashCardMenuBtn(card));
  head.appendChild(ctrls);
  // A THIRD sibling, deliberately not inside .dash-card-ctrls: that cluster is
  // hidden for a reader of a published dashboard and in present mode, and the
  // chart's own controls are not layout editing.
  const slot = document.createElement('div');
  slot.className = 'cv-controls-slot';
  head.appendChild(slot);
  el.appendChild(head);

  const body = document.createElement('div');
  body.className = 'dash-card-body';
  el.appendChild(body);
  return el;
}

// The card's ⋯ menu: move, resize, remove. openMiniMenu (chartControls.ts) is
// the hub's existing popover — positioned, outside-click and Esc already done.
function dashCardMenuBtn(card: any): HTMLButtonElement {
  const btn = dashCtrlBtn('more-horizontal', 'Card actions', () => {
    openMiniMenu(btn, (menu: HTMLElement, close: () => void) => {
      // The chart's own controls popover is a .chart-menu too — this one needs
      // a hook of its own, or a selector for either finds both.
      menu.classList.add('dash-card-menu');
      // Two per-card-type prepends above the layout ones, mutually exclusive by
      // construction: "Alert me…" is about a metric card's NUMBER (alerts.ts),
      // Copy as table / Export CSV about a pivot's FIGURES (pivotRender.ts).
      (alCardMenuItems(card).concat(pivotMenuItems(btn.closest('.dash-card'), dashCardTitle(card))).concat([
        ['Move up', () => nudgeCard(card, 0, -1)],
        ['Move down', () => nudgeCard(card, 0, 1)],
        ['Move left', () => nudgeCard(card, -1, 0)],
        ['Move right', () => nudgeCard(card, 1, 0)],
        ['Wider', () => resizeCard(card, 1, 0)],
        ['Narrower', () => resizeCard(card, -1, 0)],
        ['Taller', () => resizeCard(card, 0, 1)],
        ['Shorter', () => resizeCard(card, 0, -1)],
        ['Remove', () => removeCard(card)],
      ] as Array<[string, () => void]>)).forEach(([label, run], i, all) => {
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'chart-menu-item' + (i === all.length - 1 ? ' dash-card-menu-rm' : '');
        row.textContent = label;
        // close() FIRST: Remove re-renders the grid, which destroys the anchor
        // this menu is positioned against.
        row.addEventListener('click', () => { close(); run(); });
        menu.appendChild(row);
      });
    });
  });
  btn.classList.add('dash-card-menu-btn');
  btn.setAttribute('aria-haspopup', 'true');
  return btn;
}

function dashCtrlBtn(name: string, aria: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'dash-card-btn';
  iconOnly(b, name, aria);
  b.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
  return b;
}

function dashCardTitle(card: any): string {
  // A card's own inline snapshot (published) carries the name; an authoring
  // card only has an id, so this is the placeholder renderVisualCard replaces
  // once resolveCardVisual() answers — no second fetch, no cache.
  if (card.type === 'visual') return (card.visual && card.visual.name) || 'Visual';
  if (card.type === 'metric') {
    const m = card.metric || {};
    return m.label || ((DASH_AGG_LABELS[m.aggregation as DashAgg] || m.aggregation) + ' of ' + (m.column || ''));
  }
  // The control's "Label above" (task-3 brief) IS the header title — every
  // other card type's "what is this" text lives there, not duplicated in the
  // body, and renderControlCard (dashControls.ts) owns nothing but the widget.
  if (card.type === 'control') return (card.control && card.control.label) || 'Filter';
  return card.heading || 'Text';
}
