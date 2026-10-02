'use strict';

// LAYOUTS FOR EVERY SIZE — the filter bar on a phone. Classic global-scope
// renderer <script>; loads after layoutSizes.js.
//
// A row of filter chips does not fit a phone, so on the phone layout the bar
// folds into ONE button — "Filters (N)", N being the page's controls, with how
// many are narrowing the figures beside it — that opens the chips in a sheet.
// The chips are the SAME element (#dash-fb-chips) moved into the sheet and back
// on close, the one-element-two-hosts trick the editor itself uses, so every
// widget, popover and Clear keeps working with no second copy of any handler.

let lySheet: { close: () => void; paint: () => void } | null = null;

/** lyAfterGrid: fold or unfold the bar for the size on screen. */
function lyPaintFilterBar(): void {
  const bar = dashEl('dash-control-bar');
  if (!bar) return;
  const on = lyShown === 'phone' && !dashPresenting && !!dashCurrent;
  bar.classList.toggle('ly-fb--sheet', on);
  let btn = bar.querySelector('.ly-fb-open') as HTMLButtonElement | null;
  if (!on) {
    if (lySheet) lySheet.close();
    if (btn) btn.hidden = true;
    return;
  }
  if (!btn) {
    btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn-sm ly-fb-open';
    btn.setAttribute('aria-haspopup', 'dialog');
    btn.addEventListener('click', () => lyOpenFilterSheet());
    bar.insertBefore(btn, bar.firstChild);
  }
  btn.hidden = false;
  const controls = dashBarControls();
  const active = controls.filter((c) => !controlIsAll(c)).length;
  iconLabel(btn, 'filter', t('layoutFilters.filters', { controlsCount: controls.length }));
  if (active) {
    const badge = document.createElement('span');
    badge.className = 'ly-fb-badge';
    badge.textContent = active + ' on';
    btn.appendChild(badge);
  }
  btn.classList.toggle('is-on', active > 0);
  btn.setAttribute('aria-label', t('layoutFilters.filters_2') + controls.length + (controls.length === 1 ? ' control' : ' controls')
    + (active ? ', ' + active + ' active' : ''));
  if (lySheet) lySheet.paint();
}

function lyOpenFilterSheet(): void {
  const bar = dashEl('dash-control-bar');
  const chips = dashEl('dash-fb-chips');
  if (lySheet || !bar || !chips) return;
  const overlay = document.createElement('div');
  overlay.className = 'ws-modal-overlay ly-sheet-overlay';
  const box = document.createElement('div');
  box.className = 'ws-modal ly-sheet';
  const grab = document.createElement('span');
  grab.className = 'ly-sheet-grab';
  grab.setAttribute('aria-hidden', 'true');
  const title = document.createElement('div');
  title.className = 'ws-modal-title ly-sheet-title';
  const sub = document.createElement('p');
  sub.className = 'ly-sheet-sub';
  const body = document.createElement('div');
  body.className = 'ly-sheet-body';
  body.appendChild(chips); // the live chips, moved — see the header
  const actions = document.createElement('div');
  actions.className = 'ws-modal-actions ly-sheet-actions';
  const clear = document.createElement('button');
  clear.type = 'button';
  clear.className = 'btn';
  clear.textContent = t('common.clear_all');
  clear.addEventListener('click', () => clearAllControlsToAll());
  const done = document.createElement('button');
  done.type = 'button';
  done.className = 'btn btn-primary';
  done.textContent = t('common.done');
  actions.append(clear, done);
  box.append(grab, title, sub, body, actions);
  overlay.appendChild(box);
  document.body.appendChild(overlay);

  const paint = (): void => {
    const controls = dashBarControls();
    const active = controls.filter((c) => !controlIsAll(c)).length;
    title.textContent = t('common.filters');
    sub.textContent = t('layoutFilters.on_this_page', { controlsCount: controls.length, p2: (active ? t('layoutFilters.narrowing_the_figures', { active }) : t('layoutFilters.showing_everything')) });
    clear.disabled = active === 0;
  };
  paint();

  let a11y: { onTabKey: (e: KeyboardEvent) => void; release: () => void } | null = null;
  const onKey = (e: KeyboardEvent): void => {
    // A control's own popover (the multi list, the period picker) closes first.
    if (e.key === 'Escape' && !openControlPopover) { e.preventDefault(); close(); }
    else if (a11y) a11y.onTabKey(e);
  };
  const close = (): void => {
    if (!lySheet) return;
    lySheet = null;
    document.removeEventListener('keydown', onKey, true);
    if (openControlPopover) openControlPopover();
    // Home again, where renderDashControlBar expects it: before the spacer.
    bar.insertBefore(chips, bar.querySelector('.dash-fb-spacer'));
    overlay.remove();
    if (a11y) a11y.release();
  };
  done.addEventListener('click', () => close());
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
  document.addEventListener('keydown', onKey, true);
  lySheet = { close, paint };
  a11y = makeModalAccessible(box, t('common.filters'), done);
}
