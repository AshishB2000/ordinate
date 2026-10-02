// The Reports tab — the card grid beside Dashboards.
//
// Split out of reportBuilder.ts under the 500-line guideline
// (.claude/rules/file-size.md): listing reports and editing one are two jobs.
// This file LISTS them (and runs the one action a list can complete on its own,
// "Generate now"); reportBuilder.ts owns the three-pane editor, and calling
// `rbOpenReportById` is the whole seam between them.
//
// Loads after reportBuilder.js, whose `rbOpenReportById` / `rbRefreshList`
// contract it implements against, and after reportWriters.js for `reportBytes`.

// ── the Reports tab ──────────────────────────────────────────────────────────

/** Which tab the strip shows — read by storyList.ts's guard on the dashboards list. */
let rbCurrentTab = 'dashboards';

/** Dashboards | Reports | Stories | Scorecards | Scenarios — the same `.ds-tabs` strip the Data page uses. */
function rbSelectTab(tab: string): void {
  const isReports = tab === 'reports';
  const isStories = tab === 'stories';
  const isScores = tab === 'scorecards';
  const isScen = tab === 'scenarios';
  const other = isReports || isStories || isScores || isScen;
  rbCurrentTab = other ? tab : 'dashboards';
  const pair: Array<[string, boolean]> = [
    ['rp-tab-dashboards', !other], ['rp-tab-reports', isReports], ['rp-tab-stories', isStories], ['rp-tab-scorecards', isScores],
    ['rp-tab-scenarios', isScen],
  ];
  const stories = rbEl('st-list-wrap');
  if (stories) stories.hidden = !isStories;
  const scores = rbEl('sc-list-wrap');
  if (scores) scores.hidden = !isScores;
  const scen = rbEl('sn-list-wrap');
  if (scen) scen.hidden = !isScen;
  for (const [id, on] of pair) {
    const el = rbEl(id);
    if (!el) continue;
    el.setAttribute('aria-selected', String(on));
    el.tabIndex = on ? 0 : -1;
  }
  const dash = rbEl('an-table');
  const dashEmpty = rbEl('an-list-empty');
  const reports = rbEl('rp-list-wrap');
  if (reports) reports.hidden = !isReports;
  const head = document.querySelector('.an-list-head-actions') as HTMLElement | null;
  if (head) head.hidden = other;
  // The section header follows the tab — the same swap captureList.ts makes for
  // Datasets/Captures. A "1 dashboard" chip over a list of reports is a header
  // describing the other tab.
  const count = rbEl('an-count');
  if (count) count.hidden = other || !count.textContent;
  const sub = document.querySelector('#an-list-view .viz-sub') as HTMLElement | null;
  if (sub) {
    sub.textContent = isReports
      ? t('reportList.dashboards_as_files_you_can_send')
      : isStories
        ? t('reportList.documents_you_read_top_to_bottom')
        : isScores
          ? t('reportList.metrics_against_their_targets_one_period')
          : isScen
            ? t('reportList.what_ifs_over_your_metrics_move')
            : t('common.sheets_of_charts_metrics_and_text');
  }
  if (other) {
    if (dash) dash.hidden = true;
    if (dashEmpty) dashEmpty.hidden = true;
    void (isReports ? rbRefreshList() : isStories ? stRefreshList() : isScen ? snRefreshList() : scRefreshList());
  } else {
    void refreshAnalysisList();
  }
}

async function rbRefreshList(): Promise<void> {
  const grid = rbEl('rp-grid');
  if (!grid || !currentProjectId) return;
  let items: any[] = [];
  try {
    items = await window.hub.reportsList(currentProjectId);
  } catch (_) { items = []; }
  if (!Array.isArray(items)) items = [];
  grid.textContent = '';
  for (const r of items) grid.appendChild(rbCard(r));
  void ctAfterPaint(grid); // catalog tag bar + chips
  const empty = rbEl('rp-empty');
  if (empty) empty.hidden = items.length > 0;
  grid.hidden = items.length === 0;
}

const RB_CADENCE_WORD: Record<string, string> = {
  daily: t('common.every_day'), weekly: t('common.every_week'), monthly: t('common.every_month'),
};

function rbCard(r: any): HTMLElement {
  const card = document.createElement('div');
  card.className = 'rb-card';
  card.dataset.reportId = r.id;
  card.dataset.recKind = 'report'; card.dataset.recId = String(r.id); // ⌘-click → background tab (tabStrip.ts)

  // The "cover thumbnail" is the cover itself, drawn small in CSS: a portrait
  // sheet of paper carrying the mark and the title, at the report's own paper
  // aspect. A RENDERED thumbnail would mean capturing every report's charts to
  // paint a list — a lot of work to show a picture of a title — and this way
  // the tile is honest about being a cover rather than a preview of page three.
  const band = document.createElement('div');
  band.className = 'rb-card-band';
  const thumb = document.createElement('div');
  thumb.className = 'rb-card-thumb';
  thumb.style.setProperty('--rb-thumb-aspect',
    r.format === 'pptx' ? '16 / 9' : (r.paper && r.paper.size === 'a4' ? '8.27 / 11.69' : '8.5 / 11'));
  const mark = document.createElement('img');
  mark.className = 'rb-card-thumb-mark';
  mark.src = wsLogoUrl || REPORT_LOGO_PNG;
  mark.alt = '';
  thumb.appendChild(mark);
  const tTitle = document.createElement('span');
  tTitle.className = 'rb-card-thumb-title';
  tTitle.textContent = (r.cover && r.cover.title) || r.name || t('common.report');
  thumb.appendChild(tTitle);
  band.appendChild(thumb);
  const badge = document.createElement('span');
  badge.className = 'rb-card-badge';
  badge.textContent = String(r.format || 'pdf').toUpperCase();
  band.appendChild(badge);
  card.appendChild(band);

  const body = document.createElement('div');
  body.className = 'rb-card-body';
  const h = document.createElement('h3');
  h.className = 'rb-card-name';
  h.textContent = r.name || t('common.report');
  body.appendChild(h);
  ctDecorate(card, 'report', String(r.id), body); // catalog tag chips

  const lines: string[] = [];
  lines.push(`${r.pageCount} ${r.pageCount === 1 ? 'page' : 'pages'}`);
  const cadence = r.schedule && RB_CADENCE_WORD[r.schedule.cadence];
  lines.push(cadence ? `${cadence} at ${r.schedule.at}` : t('reportList.no_schedule'));
  lines.push(r.lastRunAt
    ? t('reportList.last_generated') + new Date(r.lastRunAt).toLocaleString()
    : t('reportList.never_generated'));
  for (const line of lines) {
    const p = document.createElement('p');
    p.className = 'rb-card-line';
    p.textContent = line;
    body.appendChild(p);
  }
  card.appendChild(body);

  // Two rows on purpose rather than four buttons wrapping at whatever width the
  // grid happens to give a card: the two that DO something to a file are
  // buttons, and the two that manage the record are text actions under them.
  const actions = document.createElement('div');
  actions.className = 'rb-card-actions';
  const secondary = document.createElement('div');
  secondary.className = 'rb-card-actions-2';
  const act = (label: string, cls: string, fn: () => void, into?: HTMLElement) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = cls;
    b.textContent = label;
    b.addEventListener('click', fn);
    (into || actions).appendChild(b);
  };
  act(t('reportList.generate_now'), 'btn btn-sm btn-primary', () => void rbGenerateFromList(r.id));
  act(t('common.edit_2'), 'btn btn-sm', () => void rbOpenReportById(r.id));
  act(t('common.history'), 'rb-link', () => void vhOpen('report', String(r.id), r.name || t('common.report')), secondary);
  act(t('common.lineage'), 'rb-link', () => void lnOpen('report', String(r.id), r.name || t('common.report')), secondary);
  act(t('common.duplicate'), 'rb-link', async () => {
    const res = await window.hub.reportsDuplicate(currentProjectId as string, r.id);
    if (!res || res.ok === false) { showToast((res && res.error) || t('reportList.could_not_duplicate')); return; }
    await rbRefreshList();
  }, secondary);
  act('Delete', 'rb-link rb-link--danger', async () => {
    // To the Trash (trashPage.ts); the files it generated are never touched.
    const res = await window.hub.reportsDelete(currentProjectId as string, r.id);
    trDeletedToast('report', r.id, r.name || '', res, () => void rbRefreshList());
    await rbRefreshList();
  }, secondary);
  actions.appendChild(secondary);
  card.appendChild(actions);
  return card;
}

/** "Generate now" from the list: open it, build it, and stay where we are. */
async function rbGenerateFromList(id: string): Promise<void> {
  if (!currentProjectId) return;
  const report = await window.hub.reportsGet(currentProjectId, id);
  if (!report) { showToast(t('common.that_report_is_gone')); return; }
  const analysis = await reportAnalysisFor(currentProjectId, report); // a scorecard report has no dashboard
  if (!analysis) { showToast(t('common.the_dashboard_this_report_prints_has')); return; }
  if (!(await pvShareGate('report', await pvCardDatasetIds(analysis)))) return;
  showToast(t('common.building_report'));
  const pages = await buildReportPages({
    projectId: currentProjectId, analysis,
    filters: Array.isArray(analysis.filters) ? analysis.filters : [], report,
  });
  if (!pages.length) { showToast(t('common.every_page_is_excluded_nothing_to')); return; }
  const { base64, ext } = await reportBytes(pages, report);
  if (!base64) { showToast(t('common.couldn_t_build_the_report')); return; }
  const res = await window.hub.reportsSaveAs(currentProjectId, id, base64, ext);
  if (res && res.ok) {
    showToast(t('common.saved_3', { p0: String(res.dest).split(/[\\/]/).pop() }));
    void window.hub.reportsReveal(currentProjectId, id);
    await rbRefreshList();
  } else if (!res || !res.canceled) {
    showToast((res && res.error) || t('common.save_failed'));
  }
}
