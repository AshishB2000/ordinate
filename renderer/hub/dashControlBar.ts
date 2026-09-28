// WHERE CONTROLS LIVE: the filter-bar strip between the page tabs and the grid.
//
// A control used to be a 3x1 grid TILE. `dashFindSlot(cards, 3, 1)` placed it
// in the first free cell, which on a full sheet is the row below the last card
// — so `+ Control` on the sample dashboard put the filter underneath the notes
// at the very bottom, and the card body's own `overflow` clipped the <select>
// inside it. The filtering itself was never wrong: `controlStepsRenderer` and
// `controlState` (dashboards.ts) did exactly the right thing to every other
// card. Only placement and chrome were.
//
// THE RECORD IS UNCHANGED. Control cards are still `type: 'control'` cards on a
// page, so `effectiveFilters()`, `dashboardExport`'s controls summary, the
// Assistant's `addControl` op and the number-fidelity tests all keep working
// untouched. Only this renderer routes them to the bar instead of the grid
// (dashGrid.ts skips them when it paints cells), and `layout` is ignored on
// read — new controls are written with a zeroed one rather than reserving a
// cell nothing draws in.
//
// Split out of dashControls.ts rather than added to it (.claude/rules/
// file-size.md: one file = one job). That file owns the three WIDGETS — the
// native select, the checkbox-list popover, the date pair. This one owns where
// they sit and what surrounds them. Classic global-scope renderer <script>: no
// import/export. Loads AFTER dashControls.js (whose renderDropdownControl /
// renderMultiControl / renderDateRangeControl it calls) and reuses
// `openRowMenu` from projects.js for the chip menu.

// The open page's control cards, in reading order. `layout` no longer places
// anything, but it still records the order an author built them in, which is
// the only ordering that will not surprise them. A COPY is sorted — never
// `page.cards` itself, which would reorder the record as a side effect of
// painting it.
function dashBarControls(): any[] {
  const page = dashCurrentPage();
  const cards = page && Array.isArray(page.cards) ? page.cards : [];
  return cards
    .filter((c: any) => c && c.type === 'control' && c.control)
    .slice()
    .sort((a: any, b: any) => {
      const la = a.layout || {};
      const lb = b.layout || {};
      return (la.y || 0) - (lb.y || 0) || (la.x || 0) - (lb.x || 0);
    });
}

/** Whether a control has anything selected at all — "not All", which is what
 *  the × and Clear all act on. Distinct from `controlIsAtDefault`, which asks
 *  the different question of whether it matches what the AUTHOR published. */
function controlIsAll(card: any): boolean {
  // A parameter is never "All": it always has a value. Its × and Clear all
  // put it back to the value the dashboard was saved with.
  if (card.control && card.control.kind === 'parameter') return paramIsAtDefault(card);
  const v = controlState.get(card.id);
  if (v === undefined) return true;
  const kind = card.control && card.control.kind;
  if (kind === 'multi') return !Array.isArray(v.values) || v.values.length === 0;
  if (kind === 'date_range') return !ppIsRelative(v) && !v.from && !v.to;
  return !v.value;
}

function anyControlActive(): boolean {
  return dashBarControls().some((c) => !controlIsAll(c));
}

/** Back to All — unset, which `controlSteps` already reads as "filters
 *  nothing". NOT `clearOneControl`, which reverts to the author's default. */
function clearControlToAll(card: any): void {
  if (card.control && card.control.kind === 'parameter') paramState.delete(card.control.paramId);
  else controlState.delete(card.id);
  renderDashGrid();
}

function clearAllControlsToAll(): void {
  dashBarControls().forEach((card) => controlState.delete(card.id));
  paramState = new Map();
  renderDashGrid();
}

function renderDashControlBar(): void {
  const bar = dashEl('dash-control-bar');
  const chips = dashEl('dash-fb-chips');
  if (!bar || !chips) return;
  // The multi popover anchors to a chip button inside this strip, so wiping it
  // would leave the popover pointing at a detached element — same reason
  // renderDashGrid closes it before emptying the grid.
  if (openControlPopover) openControlPopover();
  chips.innerHTML = '';
  const cards = dashBarControls();
  bar.hidden = cards.length === 0 && !bar.querySelector('.ft-box'); // the typed-filter box (filterType.ts) keeps it up
  cards.forEach((card) => chips.appendChild(makeControlChip(card)));
  dashShow('dash-fb-clear', cards.length > 0 && anyControlActive());
}

function makeControlChip(card: any): HTMLElement {
  const control = card.control;
  const chip = document.createElement('div');
  chip.className = 'dash-fb-chip chip';
  chip.dataset.cardId = card.id;
  const active = !controlIsAll(card);
  chip.classList.toggle('dash-fb-chip--on', active);

  const label = document.createElement('span');
  label.className = 'dash-fb-chip-label';
  const param = control.kind === 'parameter' ? dashParamById(control.paramId) : null;
  label.textContent = control.label || (param ? param.name : 'Filter');
  if (control.kind === 'parameter') {
    chip.classList.add('dash-fb-chip--param');
    label.prepend(icon('sliders', 12));
  }
  chip.appendChild(label);

  const wrap = document.createElement('div');
  wrap.className = 'dash-ctrl-widget';
  // Authoring mode wires an arrow-key nudge handler that preventDefault()s
  // unconditionally; stop it here so arrows move the cursor inside the widget.
  wrap.addEventListener('keydown', (e) => e.stopPropagation());
  chip.appendChild(wrap);

  if (control.kind === 'parameter') {
    renderParamControl(card, wrap);
  } else if (!control.datasetId || !control.column) {
    dashCardMissing(wrap, 'No source column.');
  } else if (control.kind === 'multi') {
    renderMultiControl(card, wrap);
  } else if (control.kind === 'date_range') {
    renderDateRangeControl(card, wrap);
  } else if (control.kind === 'radius') {
    renderRadiusControl(card, wrap); // geoRadius.ts (r6:geo)
  } else {
    renderDropdownControl(card, wrap);
  }

  // The × is only there when there is something to clear — a chip already
  // reading "All" would offer a no-op.
  if (active) {
    const x = document.createElement('button');
    x.type = 'button';
    x.className = 'dash-fb-chip-x';
    iconOnly(x, 'x', 'Clear ' + (control.label || 'filter'));
    x.addEventListener('click', () => clearControlToAll(card));
    chip.appendChild(x);
  }

  // Hidden by CSS for a reader (`.dash-editor--readonly`) and while presenting
  // — both are "filtering is a read, editing is not", the same rule
  // `.dash-card-ctrls` already follows for every other card type.
  const menu = document.createElement('button');
  menu.type = 'button';
  menu.className = 'dash-fb-chip-menu';
  menu.setAttribute('aria-haspopup', 'true');
  iconOnly(menu, 'more-horizontal', 'Actions for ' + (control.label || 'filter'));
  menu.addEventListener('click', (e) => {
    e.stopPropagation();
    openControlChipMenu(card, menu);
  });
  chip.appendChild(menu);
  return chip;
}

// Edit / Set as default / Remove, in `openRowMenu` (projects.js) — the same
// popup, positioning and one-menu-at-a-time slot as the dashboards list's ⋯,
// so there is one row-menu implementation in the renderer, not two.
function openControlChipMenu(card: any, trigger: HTMLElement): void {
  const atAll = controlIsAll(card);
  if (card.control && card.control.kind === 'parameter') {
    // "Save as default" is the ONLY way a reader's value reaches the record.
    const items: any[] = [{ label: 'Edit parameter…', onClick: () => { void editParameterControl(card); } }];
    if (!atAll) items.push({ label: 'Save as default', onClick: () => saveParamDefault(card) });
    items.push({ label: 'Remove', danger: true, onClick: () => removeParameterControl(card) });
    openRowMenu(trigger, items);
    return;
  }
  openRowMenu(trigger, [
    { label: 'Edit…', onClick: () => { void handleEditControl(card); } },
    {
      // Greyed-out menu items do not exist in this popup's vocabulary, so an
      // unselected control offers "Clear default" instead of a no-op "Set as
      // default" — the same click, the honest label for what it will do.
      label: atAll ? 'Clear default' : 'Set as default',
      onClick: () => setControlDefaultFromCurrent(card),
    },
    { label: 'Remove', danger: true, onClick: () => removeCard(card) },
  ]);
}

/** Publish the live selection as the control's default: what the next reader
 *  opens it on, and what `Reset controls` returns it to. */
function setControlDefaultFromCurrent(card: any): void {
  if (dashReadOnly) return; // a published snapshot is not editable
  const cur = controlState.get(card.id);
  if (controlIsAll(card) || cur === undefined) delete card.control.default;
  else card.control.default = cur;
  markDashDirty('Set control default');
  renderDashGrid();
}

async function handleEditControl(card: any): Promise<void> {
  if (dashReadOnly || !currentProjectId) return;
  let datasets: any[] = [];
  try {
    datasets = await window.hub.listDatasets(currentProjectId);
  } catch (_) {
    datasets = [];
  }
  if (!Array.isArray(datasets)) datasets = [];
  if (card.control.kind === 'radius') { await editRadiusControl(card, datasets); return; } // geoRadius.ts
  const next = await openControlDialog(datasets, card.control);
  if (!next) return;
  card.control = next;
  // The live selection was made against the OLD column; keeping it would filter
  // the new one by a value that may not exist in it.
  controlState.delete(card.id);
  if (next.default) controlState.set(card.id, next.default);
  markDashDirty('Edit control');
  renderDashGrid();
}
