// The Scorecards tab — the fourth tab of the Dashboards section, beside
// Dashboards, Reports and Stories (reportList.ts owns the strip; rbSelectTab
// calls scRefreshList).
//
// Lists scorecards as cards (name, cadence, how many metrics, the groups they
// fall into), creates one — seeded with the project's metrics, so a new
// scorecard opens on figures rather than on an empty table — and deletes one.
// Opening a card hands over to scorecardPage.ts (scOpen); that call is the seam.
//
// Classic global-scope script — NO import/export. textContent only.

const SC_PERIOD_WORD: Record<string, string> = { week: t('common.weekly'), month: t('common.monthly'), quarter: t('common.quarterly'), year: t('common.yearly') };

function scEl<T extends HTMLElement = HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

async function scRefreshList(): Promise<void> {
  const grid = scEl('sc-grid');
  const empty = scEl('sc-empty');
  if (!grid) return;
  let items: any[] = [];
  try {
    items = currentProjectId ? await window.hubPower.scorecardList(currentProjectId) : [];
  } catch (_) {
    items = [];
  }
  if (!Array.isArray(items)) items = [];
  grid.textContent = '';
  items.forEach((s) => grid.appendChild(scCard(s)));
  grid.hidden = items.length === 0;
  if (empty) empty.hidden = items.length > 0;
  const bar = document.querySelector('#sc-list-wrap .sc-list-bar') as HTMLElement | null;
  if (bar) bar.hidden = items.length === 0;
}

function scCard(s: any): HTMLElement {
  const card = document.createElement('div');
  card.className = 'sc-card';
  card.tabIndex = 0;
  card.setAttribute('role', 'button');
  card.dataset.scorecardId = String(s.id);
  card.dataset.recKind = 'scorecard';
  card.dataset.recId = String(s.id);

  // The picture: a few rows of dots and bars, drawn small — what a scorecard IS.
  const art = document.createElement('div');
  art.className = 'sc-card-art';
  art.setAttribute('aria-hidden', 'true');
  ['good', 'warn', 'good', 'off'].forEach((st, i) => {
    const row = document.createElement('div');
    row.className = 'sc-card-art-row';
    const dot = document.createElement('span');
    dot.className = 'sc-dot sc-dot--' + st;
    const bar = document.createElement('span');
    bar.className = 'sc-card-art-bar';
    bar.style.width = [72, 48, 86, 34][i] + '%';
    row.append(dot, bar);
    art.appendChild(row);
  });
  card.appendChild(art);

  const body = document.createElement('div');
  body.className = 'sc-card-body';
  const title = document.createElement('div');
  title.className = 'sc-card-title';
  title.textContent = String(s.name || t('scorecardList.untitled_scorecard'));
  const meta = document.createElement('div');
  meta.className = 'sc-card-meta';
  const n = Number(s.rowCount) || 0;
  meta.textContent = t('scorecardList.text', { p0: SC_PERIOD_WORD[s.period] || t('common.monthly'), n, updatedAt: formatSidebarTime(s.updatedAt) });
  body.append(title, meta);
  if (Array.isArray(s.groups) && s.groups.length) {
    const chips = document.createElement('div');
    chips.className = 'sc-card-groups';
    for (const g of s.groups.slice(0, 4)) {
      const c = document.createElement('span');
      c.className = 'sc-chip';
      c.textContent = String(g);
      chips.appendChild(c);
    }
    body.appendChild(chips);
  }
  card.appendChild(body);

  const more = document.createElement('button');
  more.type = 'button';
  more.className = 'icon-btn sc-card-more';
  iconOnly(more, 'more-horizontal', t('scorecardList.scorecard_actions'));
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
      add(t('common.open'), () => { void scOpen(String(s.id)); });
      add(t('common.duplicate'), () => { void scDuplicate(String(s.id)); });
      add('Delete', () => { void scDelete(s); });
    });
  });
  card.appendChild(more);

  const open = (): void => { void scOpen(String(s.id)); };
  card.addEventListener('click', open);
  card.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
  return card;
}

/** A new scorecard: named, monthly, seeded with up to eight of the project's most recent metrics. */
async function scNew(): Promise<void> {
  if (!currentProjectId) return;
  const name = await promptModal(t('scorecardList.name_the_scorecard'), t('scorecardList.monthly_scorecard'), t('common.create'));
  if (name === null) return;
  let metrics: any[] = [];
  try { const r = await window.hub.listMetrics(currentProjectId); metrics = r && Array.isArray(r.metrics) ? r.metrics : []; } catch (_) { metrics = []; }
  // The metrics touched most recently first — the ones being worked on now.
  const rows = (Array.isArray(metrics) ? metrics : []).slice()
    .sort((a: any, b: any) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
    .slice(0, 8).map((m: any) => ({ metricId: String(m.id) }));
  let res: any = null;
  try {
    res = await window.hubPower.scorecardCreate(currentProjectId, { name: name.trim() || t('scorecardList.monthly_scorecard'), period: 'month', rows });
  } catch (_) {
    res = null;
  }
  if (!res || res.ok === false || !res.scorecard) { showToast(t('scorecardList.could_not_create_the_scorecard')); return; }
  await scOpen(String(res.scorecard.id));
  // A scorecard is only as good as its targets — go straight to setting them.
  if (rows.length) void scEditRows();
}

async function scDuplicate(id: string): Promise<void> {
  if (!currentProjectId) return;
  const res = await window.hubPower.scorecardDuplicate(currentProjectId, id);
  if (!res || res.ok === false) { showToast(t('scorecardList.could_not_duplicate_the_scorecard')); return; }
  void scRefreshList();
}

async function scDelete(s: any): Promise<void> {
  if (!currentProjectId) return;
  if (!window.confirm(t('scorecardList.delete_the_metrics_it_shows_are', { name: s.name }))) return;
  await window.hubPower.scorecardDelete(currentProjectId, String(s.id));
  if (scCurrent && scCurrent.id === s.id) await scClose();
  void scRefreshList();
}

function initScorecardList(): void {
  const tab = scEl('rp-tab-scorecards');
  if (tab) tab.addEventListener('click', () => rbSelectTab('scorecards'));
  ['sc-new-btn', 'sc-empty-new'].forEach((id) => {
    const b = scEl(id);
    if (b) b.addEventListener('click', () => { void scNew(); });
  });
  initScorecardPage();
}
