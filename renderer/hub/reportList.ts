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

/** Dashboards | Reports — the same `.ds-tabs` strip the Data page uses. */
function rbSelectTab(tab: string): void {
  const isReports = tab === 'reports';
  const pair: Array<[string, boolean]> = [['rp-tab-dashboards', !isReports], ['rp-tab-reports', isReports]];
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
  if (head) head.hidden = isReports;
  // The section header follows the tab — the same swap captureList.ts makes for
  // Datasets/Captures. A "1 dashboard" chip over a list of reports is a header
  // describing the other tab.
  const count = rbEl('an-count');
  if (count) count.hidden = isReports || !count.textContent;
  const sub = document.querySelector('#an-list-view .viz-sub') as HTMLElement | null;
  if (sub) {
    sub.textContent = isReports
      ? 'Dashboards as files you can send — PDF, PowerPoint or Word — on demand or on a schedule.'
      : 'Sheets of charts, metrics and text over your datasets.';
  }
  if (isReports) {
    if (dash) dash.hidden = true;
    if (dashEmpty) dashEmpty.hidden = true;
    void rbRefreshList();
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
  const empty = rbEl('rp-empty');
  if (empty) empty.hidden = items.length > 0;
  grid.hidden = items.length === 0;
}

const RB_CADENCE_WORD: Record<string, string> = {
  daily: 'Every day', weekly: 'Every week', monthly: 'Every month',
};

function rbCard(r: any): HTMLElement {
  const card = document.createElement('div');
  card.className = 'rb-card';
  card.dataset.reportId = r.id;

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
  mark.src = REPORT_LOGO_PNG;
  mark.alt = '';
  thumb.appendChild(mark);
  const tTitle = document.createElement('span');
  tTitle.className = 'rb-card-thumb-title';
  tTitle.textContent = (r.cover && r.cover.title) || r.name || 'Report';
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
  h.textContent = r.name || 'Report';
  body.appendChild(h);

  const lines: string[] = [];
  lines.push(`${r.pageCount} ${r.pageCount === 1 ? 'page' : 'pages'}`);
  const cadence = r.schedule && RB_CADENCE_WORD[r.schedule.cadence];
  lines.push(cadence ? `${cadence} at ${r.schedule.at}` : 'No schedule');
  lines.push(r.lastRunAt
    ? 'Last generated ' + new Date(r.lastRunAt).toLocaleString()
    : 'Never generated');
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
  act('Generate now', 'btn btn-sm btn-primary', () => void rbGenerateFromList(r.id));
  act('Edit', 'btn btn-sm', () => void rbOpenReportById(r.id));
  act('History', 'rb-link', () => void vhOpen('report', String(r.id), r.name || 'Report'), secondary);
  act('Duplicate', 'rb-link', async () => {
    const res = await window.hub.reportsDuplicate(currentProjectId as string, r.id);
    if (!res || res.ok === false) { showToast((res && res.error) || 'Could not duplicate'); return; }
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
  if (!report) { showToast('That report is gone'); return; }
  const analysis = await window.hub.getAnalysis(currentProjectId, report.analysisId);
  if (!analysis) { showToast('The dashboard this report prints has been deleted'); return; }
  showToast('Building report…');
  const pages = await buildReportPages({
    projectId: currentProjectId, analysis,
    filters: Array.isArray(analysis.filters) ? analysis.filters : [], report,
  });
  if (!pages.length) { showToast('Every page is excluded — nothing to generate'); return; }
  const { base64, ext } = await reportBytes(pages, report);
  if (!base64) { showToast('Couldn’t build the report'); return; }
  const res = await window.hub.reportsSaveAs(currentProjectId, id, base64, ext);
  if (res && res.ok) {
    showToast('Saved: ' + String(res.dest).split(/[\\/]/).pop());
    void window.hub.reportsReveal(currentProjectId, id);
    await rbRefreshList();
  } else if (!res || !res.canceled) {
    showToast((res && res.error) || 'Save failed');
  }
}
