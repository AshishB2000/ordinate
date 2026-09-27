// The Scenarios tab — the fifth tab of the Dashboards section, beside
// Dashboards, Reports, Stories and Scorecards (reportList.ts owns the strip;
// rbSelectTab calls snRefreshList).
//
// Lists scenarios as cards (name, the drivers in words, how many metrics),
// creates one — seeded with the project's first metrics, so a new scenario
// opens on figures rather than on an empty page — duplicates and deletes one.
// Opening a card hands over to scenarioPage.ts (snOpen); Compare opens
// scenarioCompare.ts. Every figure is computed in main.
//
// Classic global-scope script — NO import/export. textContent only.

function snEl<T extends HTMLElement = HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

let snListCache: any[] = [];

async function snRefreshList(): Promise<void> {
  const grid = snEl('sn-grid');
  const empty = snEl('sn-empty');
  if (!grid) return;
  let items: any[] = [];
  try {
    items = currentProjectId ? await window.hubScenarios.list(currentProjectId) : [];
  } catch (_) {
    items = [];
  }
  if (!Array.isArray(items)) items = [];
  snListCache = items;
  grid.textContent = '';
  items.forEach((s) => grid.appendChild(snCard(s)));
  grid.hidden = items.length === 0;
  if (empty) empty.hidden = items.length > 0;
  const bar = document.querySelector('#sn-list-wrap .sn-list-bar') as HTMLElement | null;
  if (bar) bar.hidden = items.length === 0;
  const cmp = snEl<HTMLButtonElement>('sn-compare-btn');
  if (cmp) cmp.disabled = items.length === 0;
}

/** The card's picture: a small tornado — bars of different lengths about one line. */
function snTornadoArt(): HTMLElement {
  const art = document.createElement('div');
  art.className = 'sn-card-art';
  art.setAttribute('aria-hidden', 'true');
  [[38, 44], [26, 30], [16, 12], [8, 10]].forEach(([lo, hi]) => {
    const row = document.createElement('div');
    row.className = 'sn-art-row';
    const l = document.createElement('span');
    l.className = 'sn-art-bar sn-art-bar--low';
    l.style.width = lo * 2 + '%'; // of its half of the row
    const h = document.createElement('span');
    h.className = 'sn-art-bar sn-art-bar--high';
    h.style.width = hi * 2 + '%';
    row.append(l, h);
    art.appendChild(row);
  });
  return art;
}

function snCard(s: any): HTMLElement {
  const card = document.createElement('div');
  card.className = 'sn-card';
  card.tabIndex = 0;
  card.setAttribute('role', 'button');
  card.setAttribute('aria-label', 'Open scenario ' + String(s.name || ''));
  card.dataset.scenarioId = String(s.id);
  card.dataset.recKind = 'scenario';
  card.dataset.recId = String(s.id);
  card.appendChild(snTornadoArt());

  const body = document.createElement('div');
  body.className = 'sn-card-body';
  const title = document.createElement('div');
  title.className = 'sn-card-title';
  title.textContent = String(s.name || 'Untitled scenario');
  const meta = document.createElement('div');
  meta.className = 'sn-card-meta';
  const d = Number(s.driverCount) || 0;
  const m = Number(s.metricCount) || 0;
  meta.textContent = `${d} driver${d === 1 ? '' : 's'} · ${m} metric${m === 1 ? '' : 's'} · ${formatSidebarTime(s.updatedAt)}`;
  body.append(title, meta);
  const names: string[] = Array.isArray(s.driverNames) ? s.driverNames : [];
  const chips = document.createElement('div');
  chips.className = 'sn-card-drivers';
  for (const n of names.slice(0, 3)) {
    const c = document.createElement('span');
    c.className = 'sn-chip';
    c.textContent = String(n);
    chips.appendChild(c);
  }
  if (names.length > 3) {
    const more = document.createElement('span');
    more.className = 'sn-chip sn-chip--more';
    more.textContent = '+' + (names.length - 3);
    chips.appendChild(more);
  }
  if (!names.length) {
    const none = document.createElement('span');
    none.className = 'sn-card-none';
    none.textContent = 'No drivers yet — the baseline';
    chips.appendChild(none);
  }
  body.appendChild(chips);
  card.appendChild(body);

  const more = document.createElement('button');
  more.type = 'button';
  more.className = 'icon-btn sn-card-more';
  iconOnly(more, 'more-horizontal', 'Scenario actions');
  more.addEventListener('click', (e) => {
    e.stopPropagation();
    openMiniMenu(more, (menu: HTMLElement, close: () => void) => {
      const add = (label: string, run: () => void): void => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'chart-menu-item';
        b.textContent = label;
        b.addEventListener('click', () => { close(); run(); });
        menu.appendChild(b);
      };
      add('Open', () => { void snOpen(String(s.id)); });
      add('Compare…', () => { void snOpenCompare([String(s.id)]); });
      add('Duplicate', () => { void snDuplicate(String(s.id)); });
      add('Delete', () => { void snDelete(s); });
    });
  });
  card.appendChild(more);

  const open = (): void => { void snOpen(String(s.id)); };
  card.addEventListener('click', open);
  card.addEventListener('keydown', (e) => {
    if (e.target !== card) return;
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
  });
  return card;
}

/**
 * A new scenario: named, seeded with up to four of the project's metrics — the
 * ones a column driver moves directly (sum/avg/min/max) first, then a formula
 * built on them, counts last (no value driver moves a count).
 */
async function snNew(): Promise<void> {
  if (!currentProjectId) return;
  const name = await promptModal('Name the scenario', 'Price +5%', 'Create');
  if (name === null) return;
  let list: any[] = [];
  try { const r = await window.hub.listMetrics(currentProjectId); list = r && Array.isArray(r.metrics) ? r.metrics : []; } catch (_) { list = []; }
  const rank = (m: any): number => (m.definition && m.definition.formula ? 1 : m.definition && m.definition.aggregation === 'count' ? 2 : 0);
  const simple = list.filter((m: any) => rank(m) === 0).slice(0, 3);
  const baseMetricIds = simple.concat(list.filter((m: any) => rank(m) > 0).sort((a: any, b: any) => rank(a) - rank(b)))
    .slice(0, 4).map((m: any) => String(m.id));
  let res: any = null;
  try {
    res = await window.hubScenarios.create(currentProjectId, { name: name.trim() || 'Untitled scenario', baseMetricIds, drivers: [] });
  } catch (_) {
    res = null;
  }
  if (!res || res.ok === false || !res.scenario) { showToast('Could not create the scenario.'); return; }
  await snOpen(String(res.scenario.id));
}

async function snDuplicate(id: string): Promise<void> {
  if (!currentProjectId) return;
  const res = await window.hubScenarios.duplicate(currentProjectId, id);
  if (!res || res.ok === false) { showToast('Could not duplicate the scenario.'); return; }
  void snRefreshList();
}

async function snDelete(s: any): Promise<void> {
  if (!currentProjectId) return;
  if (!window.confirm(`Delete “${s.name}”? The metrics and data it reads are not changed.`)) return;
  await window.hubScenarios.remove(currentProjectId, String(s.id));
  if (snCurrent && snCurrent.id === s.id) await snClose();
  void snRefreshList();
}

function initScenarioList(): void {
  const tab = snEl('rp-tab-scenarios');
  if (tab) tab.addEventListener('click', () => rbSelectTab('scenarios'));
  ['sn-new-btn', 'sn-empty-new'].forEach((id) => {
    const b = snEl(id);
    if (b) b.addEventListener('click', () => { void snNew(); });
  });
  const cmp = snEl('sn-compare-btn');
  if (cmp) cmp.addEventListener('click', () => { void snOpenCompare([]); });
  initScenarioPage();
  initScenarioCompare();
}
