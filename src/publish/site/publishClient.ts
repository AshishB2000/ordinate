'use strict';

// The published site's renderer, DOM half: the page itself. Reads the page's
// data block (#ordinate-page, a non-executed JSON <script>), lays out the
// header and nav, then the dashboard — filter bar, sheets, tiles — and redraws
// the tiles when a control changes, by LOOKING UP the app's pre-computed
// answer for that state (publishCore.ts), never by computing one. The tiles,
// maps and the other pages are publishTiles.ts, publishMaps.ts and
// publishPages.ts, inlined before this script. Every string goes in through
// textContent; nothing is parsed as HTML. No network: no fetch, no XHR, no
// external URL anywhere in the page.

// ── Header and nav ───────────────────────────────────────────────────────────

function pcHeader(page: any): HTMLElement {
  const head = pcEl('header', 'pub-head');
  const brand = pcEl('a', 'pub-brand');
  brand.setAttribute('href', 'index.html');
  if (page.site.logo) {
    const img = pcEl('img', 'pub-logo') as HTMLImageElement;
    img.src = page.site.logo;
    img.alt = '';
    brand.appendChild(img);
  }
  brand.appendChild(pcEl('span', 'pub-site', page.site.title));
  head.appendChild(brand);
  const nav = pcEl('nav', 'pub-nav');
  nav.setAttribute('aria-label', 'Pages');
  for (const n of page.site.nav || []) {
    const a = pcEl('a', 'pub-nav-link', n.name);
    a.setAttribute('href', n.file);
    if (location.pathname.endsWith('/' + n.file)) a.setAttribute('aria-current', 'page');
    nav.appendChild(a);
  }
  head.appendChild(nav);
  return head;
}

// ── Dashboard ────────────────────────────────────────────────────────────────

function pcDashboard(page: any, root: HTMLElement): void {
  const d = page.dashboard;
  const defaults: number[] = d.controls.map((c: any) => c.defaultIndex);
  let picks = defaults.slice();
  let sheet = 0;
  // An embedded page (src/publish/embedPage.ts) may leave out its title and its filter bar; the figures are the same.
  const embed = page.embed || {};
  // The title row. On a phone it is the page's sticky bar — the name, when it was published, Filters with a badge;
  // anywhere wider the wrapper is `display: contents` and only the title shows (sizeCss).
  const head = pcEl('div', 'pub-dashhead');
  const ident = pcEl('div', 'pub-dashhead-ident');
  if (!embed.hideTitle) {
    ident.appendChild(pcEl('h1', 'pub-title', d.name));
    const stamp = ppStamp(page);
    if (stamp) ident.appendChild(pcEl('p', 'pub-dashhead-stamp', stamp));
  }
  head.appendChild(ident);
  root.appendChild(head);
  const bar = pcEl('div', 'pub-filters');
  bar.setAttribute('role', 'group');
  bar.setAttribute('aria-label', 'Filters');
  const selects: HTMLSelectElement[] = [];
  // How many filters narrow the page now — the phone's Filters button wears it.
  const badge = pcEl('span', 'pub-filters-badge');
  // r10:views — the dashboard's saved views: each one sets every filter and the sheet.
  const views: any[] = Array.isArray(d.views) ? d.views : [];
  const viewSel = document.createElement('select');
  const putView = (i: number): void => {
    const v = views[i];
    if (!v) return;
    picks = d.controls.map((c: any, k: number) => (v.picks[k] < c.options.length ? v.picks[k] : defaults[k]));
    sheet = v.sheet < d.sheets.length ? v.sheet : 0;
  };
  if (views.length) {
    const lab = pcEl('label', 'pub-filter pub-view');
    lab.appendChild(pcEl('span', 'pub-filter-label', 'View'));
    viewSel.className = 'pub-filter-select pub-view-select';
    const none = document.createElement('option');
    none.value = '';
    none.textContent = 'Custom';
    viewSel.appendChild(none);
    views.forEach((v, j) => {
      const opt = document.createElement('option');
      opt.value = String(j);
      opt.textContent = v.name;
      viewSel.appendChild(opt);
    });
    const def = views.findIndex((v) => v.default);
    if (def >= 0) { putView(def); viewSel.value = String(def); }
    viewSel.addEventListener('change', () => { if (viewSel.value !== '') { putView(Number(viewSel.value)); draw(); } });
    lab.appendChild(viewSel);
    bar.appendChild(lab);
  }
  d.controls.forEach((c: any, i: number) => {
    const lab = pcEl('label', 'pub-filter');
    lab.appendChild(pcEl('span', 'pub-filter-label', c.label));
    const sel = document.createElement('select');
    sel.className = 'pub-filter-select';
    sel.dataset.control = String(i);
    c.options.forEach((o: string, j: number) => {
      const opt = document.createElement('option');
      opt.value = String(j);
      opt.textContent = o;
      sel.appendChild(opt);
    });
    sel.value = String(picks[i]);
    sel.addEventListener('change', () => { picks = pkNextPicks(d.mode, defaults, picks, i, Number(sel.value)); viewSel.value = ''; draw(); });
    selects.push(sel);
    lab.appendChild(sel);
    bar.appendChild(lab);
  });
  if ((d.controls.length || views.length) && !embed.hideFilters) {
    // On a phone the bar folds into one "Filters (N)" button that opens it as
    // a sheet. Which of the two shows is the stylesheet's call; this only
    // toggles the sheet open and shut.
    bar.id = 'pub-filters';
    const open = pcEl('button', 'pub-filters-open') as HTMLButtonElement;
    open.type = 'button';
    open.setAttribute('aria-controls', 'pub-filters');
    open.setAttribute('aria-expanded', 'false');
    open.appendChild(ppFilterIcon());
    open.appendChild(pcEl('span', '', d.controls.length ? 'Filters' : 'Views'));
    open.appendChild(badge);
    // The sheet's top — a handle to swipe it down by and its name — and its foot, shown only while it is a sheet.
    const grab = pcEl('div', 'pub-filters-grab');
    grab.appendChild(pcEl('span', 'pub-sheet-handle'));
    grab.appendChild(pcEl('p', 'pub-sheet-title', 'Filters'));
    bar.insertBefore(grab, bar.firstChild);
    const foot = pcEl('div', 'pub-filters-foot');
    const reset = pcEl('button', 'pub-filters-reset', 'Reset') as HTMLButtonElement;
    reset.type = 'button';
    reset.addEventListener('click', () => { picks = defaults.slice(); viewSel.value = ''; draw(); });
    const done = pcEl('button', 'pub-filters-done', 'Done') as HTMLButtonElement;
    done.type = 'button';
    foot.append(reset, done);
    const scrim = pcEl('div', 'pub-scrim pub-filters-scrim');
    const setOpen = (on: boolean): void => {
      bar.classList.toggle('is-open', on);
      scrim.classList.toggle('is-open', on);
      open.setAttribute('aria-expanded', String(on));
      if (on) { bar.setAttribute('role', 'dialog'); bar.setAttribute('aria-modal', 'true'); } else { bar.setAttribute('role', 'group'); bar.removeAttribute('aria-modal'); }
      if (on) (bar.querySelector('select') as HTMLElement | null)?.focus();
      else open.focus();
    };
    open.addEventListener('click', () => setOpen(!bar.classList.contains('is-open')));
    done.addEventListener('click', () => setOpen(false));
    scrim.addEventListener('click', () => setOpen(false));
    bar.addEventListener('keydown', (e) => { if (e.key === 'Escape' && bar.classList.contains('is-open')) setOpen(false); });
    ppSwipe(grab, bar, () => setOpen(false));
    bar.appendChild(foot);
    head.appendChild(open);
    root.appendChild(scrim);
    root.appendChild(bar);
    if (d.mode === 'single') root.appendChild(pcEl('p', 'pub-hint', 'This published copy changes one filter at a time.'));
  }
  const tabs = pcEl('div', 'pub-tabs');
  tabs.setAttribute('role', 'tablist');
  if (d.sheets.length > 1) {
    d.sheets.forEach((s: any, i: number) => {
      const b = pcEl('button', 'pub-tab', s.name) as HTMLButtonElement;
      b.type = 'button';
      b.setAttribute('role', 'tab');
      b.addEventListener('click', () => { sheet = i; viewSel.value = ''; draw(); });
      tabs.appendChild(b);
    });
    root.appendChild(tabs);
  }
  const grid = pcEl('div', 'pub-grid');
  root.appendChild(grid);

  // A click on a chart label selects that value in a control on the same column.
  const pick = (column: string, label: string, chart?: string): void => {
    const i = d.controls.findIndex((c: any) => c.column === column && c.kind !== 'parameter' && c.kind !== 'date_range');
    if (i < 0) return;
    const j = d.controls[i].options.indexOf(label);
    if (j < 0) return;
    const apply = (): void => {
      picks = pkNextPicks(d.mode, defaults, picks, i, picks[i] === j ? 0 : j);
      viewSel.value = '';
      draw();
    };
    // A phone: a tap asks first, in a sheet (docs/phone-dashboards) — a tooltip and a filter on one tap is a surprise.
    if (!ppIsPhone()) return apply();
    const on = picks[i] === j;
    ppSheet(label, chart || '', [{
      label: on ? 'Clear the ' + d.controls[i].label + ' filter' : 'Filter this page to “' + label + '”',
      hint: on ? 'Every card shows all of ' + d.controls[i].label + ' again' : 'Every card shows ' + d.controls[i].label + ': ' + label,
      run: apply,
    }]);
  };

  function draw(): void {
    selects.forEach((s, i) => { s.value = String(picks[i]); });
    Array.from(tabs.children).forEach((t, i) => t.setAttribute('aria-selected', String(i === sheet)));
    while (pcCharts.length) { try { pcCharts.pop().destroy(); } catch (_) { /* already gone */ } }
    grid.textContent = '';
    const combo = pkComboIndex(d.keys, picks);
    const s = d.sheets[sheet];
    if (!s || !s.cards.length) { grid.appendChild(pcEl('p', 'pub-empty', 'This sheet is empty.')); return; }
    // Controls moved to the filter bar, so the rows they sat on are empty: start
    // the grid at the first row a tile actually uses.
    const top = Math.min(...s.cards.map((c: any) => c.layout.y));
    const els: HTMLElement[] = s.cards.map((card: any) => grid.appendChild(pcCard(card, combo < 0 ? 0 : combo, page, pick, top)));
    // A phone reads the tiles in one column, in the phone layout's order, each run of KPIs one swipeable strip
    // (publishCore.ts pkPhoneBlocks). Every tile carries its place; the strips exist on every size and the
    // stylesheet shows them — and hides the KPIs they hold from the grid — only on a phone.
    pkPhoneBlocks(s.cards).forEach((b, k) => {
      if (b.kind === 'card') {
        els[b.at].style.setProperty('--pc-p-ord', String(k));
        return;
      }
      for (const i of b.at) els[i].classList.add('pub-in-strip');
      grid.appendChild(ppStrip(b.at.map((i) => pcCard(s.cards[i], combo < 0 ? 0 : combo, page, pick, top)), k));
    });
    const narrowed = picks.filter((v, i) => v !== defaults[i]).length;
    badge.textContent = narrowed ? String(narrowed) : '';
    badge.hidden = !narrowed;
    document.body.dataset.combo = String(combo);
  }
  draw();
  // Crossing the phone line redraws: a chart's legend moves under it, or back beside it.
  if (typeof matchMedia === 'function') {
    const mq = matchMedia(PP_PHONE_MQ);
    if (typeof mq.addEventListener === 'function') mq.addEventListener('change', draw);
  }
}

// ── Boot ─────────────────────────────────────────────────────────────────────

(function pcBoot() {
  const data = document.getElementById('ordinate-page');
  if (!data) return;
  let page: any;
  try { page = JSON.parse(data.textContent || '{}'); } catch (_) { return; }
  try { if (typeof OrdFormat === 'object' && page.formats) OrdFormat.setFormatPrefs(page.formats); } catch (_) { /* defaults */ }
  // An embed has no site around it: no header, no nav.
  if (!page.embed) document.body.appendChild(pcHeader(page));
  else document.body.classList.add('pub-embedded');
  const root = pcEl('main', 'pub-root');
  document.body.appendChild(root);
  if (page.kind === 'story') pcStory(page, root);
  else if (page.kind === 'scorecard') pcScorecard(page, root);
  else if (page.kind === 'index') pcIndex(page, root);
  else pcDashboard(page, root);
  document.body.dataset.ready = 'true';
})();
