// The tool rail down the side of the workbench and the flyout it opens. One
// job: which pane is showing, and getting out of the way when it is not.
//
// Split verbatim out of authoring.ts — see .claude/rules/file-size.md. Classic
// global-scope renderer <script>: no import/export. Loads AFTER authoring.js,
// which keeps the module-local state every function here reads.

// ── The flyout ──────────────────────────────────────────────────────────────
// ONE panel at a time, hung off the rail. Two panels stacked in a column is what
// made this surface feel stuffed: the wells and the field list each want the
// full height, and neither got it. Closing the flyout entirely (click the lit
// icon again) collapses its grid track to zero, so the sheet takes the window.
let anFlyout: string | null = null;
// True while the Properties flyout is open because SELECTING a card opened it
// (over a closed rail) — deselecting then closes it again. A pane the user
// opened from the rail sets this false and survives deselection.
let anPropsAuto = false;

function anSetFlyout(pane: string | null): void {
  anFlyout = pane && AN_PANES.indexOf(pane) >= 0 ? pane : null;
  try {
    localStorage.setItem(AN_FLYOUT_KEY, anFlyout || '');
  } catch (_) { /* private mode — the flyout still works, it just forgets */ }
  AN_PANES.forEach((id) => {
    const el = anEl(id);
    if (el) el.hidden = id !== anFlyout;
  });
  const side = anEl('an-side-left');
  if (side) side.hidden = !anFlyout;
  document.querySelectorAll('#an-rail .an-rail-btn').forEach((b) => {
    const el = b as HTMLElement;
    const on = !!anFlyout && el.dataset.pane === anFlyout;
    el.classList.toggle('is-on', on);
    el.setAttribute('aria-expanded', on ? 'true' : 'false');
  });
  // Painted on open rather than once at startup: which tiles read as recommended
  // depends on the selected card's data, which changes under it.
  if (anFlyout === 'an-pane-visuals') anRenderGallery();
  // Same reason, and the same cost argument as the dataset tab: a scan runs when
  // the user asks to see it, never on every dashboard open.
  if (anFlyout === 'an-pane-insights' && typeof insRenderRail === 'function') void insRenderRail();
}


// ── The tool rail ───────────────────────────────────────────────────────────
function anWireRail(): void {
  document.querySelectorAll('#an-rail .an-rail-btn').forEach((b) => {
    const pane = (b as HTMLElement).dataset.pane || '';
    b.addEventListener('click', () => {
      anPropsAuto = false; // a rail open is the user's, and survives deselection
      anSetFlyout(anFlyout === pane ? null : pane);
    });
  });
}

function initAuthoring(): void {
  anWireRail();
  let saved = '';
  try {
    saved = localStorage.getItem(AN_FLYOUT_KEY) || '';
  } catch (_) { /* private mode — start closed */ }
  anSetFlyout(saved || null);

  document.querySelectorAll('#an-tabs .an-tab').forEach((b) => {
    b.addEventListener('click', () => anSetTab((b as HTMLElement).dataset.tab || ''));
  });
  let savedTab = '';
  try {
    savedTab = localStorage.getItem(AN_TAB_KEY) || '';
  } catch (_) { /* private mode — start on Build */ }
  anSetTab(savedTab || AN_TABS[0]);

  // The name is the rename control; the separate Rename button is hidden in
  // focus mode but still owns the handler.
  const nameEl = anEl('dash-name');
  if (nameEl) {
    const rename = (): void => { if (dashMode === 'analysis') anClick('dash-rename-btn'); };
    nameEl.addEventListener('click', rename);
    nameEl.addEventListener('keydown', (e) => {
      const k = (e as KeyboardEvent).key;
      if (k === 'Enter' || k === ' ') { e.preventDefault(); rename(); }
    });
  }

  // ⋯ overflow: Style… / Present / Export… / Create report… / Share. openMiniMenu
  // (chartControls.ts) is the hub's existing popover — positioned, outside-click
  // and Esc already done.
  const more = anEl('an-more-btn');
  if (more) {
    more.addEventListener('click', () => {
      openMiniMenu(more, (menu: HTMLElement, close: () => void) => {
        ([
          [t('common.style'), 'dash-style-btn'],
          [t('common.present'), 'dash-present-btn'],
          [t('common.export'), 'dash-export-btn'],
          [t('common.create_report'), 'dash-report-btn'],
          [t('common.share'), 'dash-share-btn'],
        ] as Array<[string, string]>).forEach(([label, target]) => {
          const row = document.createElement('button');
          row.type = 'button';
          row.className = 'chart-menu-item';
          row.textContent = label;
          row.addEventListener('click', () => { close(); anClick(target); });
          menu.appendChild(row);
        });
        // Lineage opens a panel rather than pressing a toolbar button.
        const lin = document.createElement('button');
        lin.type = 'button';
        lin.className = 'chart-menu-item';
        lin.textContent = t('common.lineage');
        lin.addEventListener('click', () => {
          close();
          if (dashCurrent) void lnOpen('dashboard', String(dashCurrent.id), String(dashCurrent.name || ''));
        });
        menu.appendChild(lin);
        // Publish this dashboard (with any others) as a static site (publishDialog.ts).
        const pub = document.createElement('button');
        pub.type = 'button';
        pub.className = 'chart-menu-item';
        pub.textContent = t('common.publish');
        pub.addEventListener('click', () => {
          close();
          if (typeof openPublishDialog === 'function') void openPublishDialog(dashCurrent ? String(dashCurrent.id) : undefined);
        });
        menu.appendChild(pub);
        // r7:templates — this dashboard as a template in the gallery's "Yours".
        const tpl = document.createElement('button');
        tpl.type = 'button';
        tpl.className = 'chart-menu-item';
        tpl.textContent = t('common.save_as_template');
        tpl.addEventListener('click', () => { close(); if (dashCurrent) void utSaveAsTemplate(String(dashCurrent.id)); });
        menu.appendChild(tpl);
      });
    });
  }

  // Selection, by delegation — the grid rebuilds its cards on every render, so
  // per-card listeners would have to be re-attached each time.
  const grid = anEl('dash-grid');
  if (grid) {
    grid.addEventListener('click', (e) => {
      if (dashMode !== 'analysis') return;
      const card = (e.target as HTMLElement).closest('.dash-card') as HTMLElement | null;
      // Clicks on the card's own controls are that control's business.
      if ((e.target as HTMLElement).closest('.dash-card-ctrls')) return;
      anSelectCard(card ? card.dataset.cardId || null : null);
    });
  }

  const search = anEl('an-field-search');
  if (search) search.addEventListener('input', () => anRenderFields());
  const browseSearch = anEl('an-browse-search');
  if (browseSearch) browseSearch.addEventListener('input', () => anRenderBrowseFields());

  // Escape deselects, matching the click on empty canvas. Bubble phase and
  // defaultPrevented-gated, so every surface that already owns its Escape —
  // modals, the drill panel, mini menus, presentation mode — wins first.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || e.defaultPrevented) return;
    if (dashMode !== 'analysis' || !anSelectedCardId) return;
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
    // An open overlay owns the key even if its handler did not preventDefault.
    const overlayOpen = [...document.querySelectorAll('.ws-modal-overlay')]
      .some((o) => (o as HTMLElement).getClientRects().length > 0);
    if (overlayOpen) return;
    anSelectCard(null);
  });

  const calc = anEl('an-calc-btn');
  if (calc) {
    calc.addEventListener('click', () => {
      if (!anVisual || !anVisual.datasetId) {
        window.alert(t('authoringRail.select_a_visual_card_first_a'));
        return;
      }
      // A calculated field belongs to the DATASET, so this still writes a
      // pipeline step — but the user no longer has to leave the analysis to
      // write one. It is the SAME editor prepare.ts opens, against the same
      // IPC, so there is still exactly one formula surface in the app.
      const datasetId = String(anVisual.datasetId);
      openFormulaEditor({
        projectId: currentProjectId || '',
        datasetId,
        onSave: async (field) => {
          const res = await window.hub.addDatasetStep(currentProjectId, datasetId, {
            type: 'calculated_field',
            name: field.name,
            expression: field.expression,
          });
          if (!res || res.ok === false) {
            window.alert((res && res.error) || t('authoringRail.failed_to_add_the_calculated_field'));
            return false;
          }
          showToast(t('authoringRail.added_to_this_dataset', { name: field.name }));
          return true;
        },
      });
    });
  }
}
