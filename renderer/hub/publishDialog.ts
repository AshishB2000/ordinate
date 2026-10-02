'use strict';

// Publish… — pick dashboards and stories, a folder and options; see the size
// before anything is written; publish as a job. Classic global-scope script,
// no import/export. Main does every part that matters (src/ipc/publish.ts):
// which folder may be written, what each page holds, how big it is. This file
// asks, shows the answer, and remembers nothing the main side does not.

let pdOverlay: HTMLElement | null = null;
let pdPlanTimer = 0;
let pdPlanSeq = 0;

interface PdState {
  projectId: string;
  dashboards: Array<{ id: string; name: string; sheets?: number }>;
  stories: Array<{ id: string; name: string }>;
  scorecards: Array<{ id: string; name: string }>;
  picked: Set<string>;
  outDir: string;
  title: string;
  maxCombos: number;
  afterRefresh: boolean;
  plan: any;
}

function pdEl(tag: string, cls?: string, text?: string): HTMLElement {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

/** The brand ramp each picked dashboard renders with — computed HERE, where the colour code lives. */
async function pdBrands(st: PdState): Promise<Record<string, { ramp: any }>> {
  const out: Record<string, { ramp: any }> = {};
  for (const d of st.dashboards) {
    if (!st.picked.has(d.id)) continue;
    let a: any = null;
    try { a = await window.hub.getAnalysis(st.projectId, d.id); } catch (_) { a = null; }
    const style = a && a.style ? a.style : {};
    const ramp = typeof brandExportRamp === 'function' ? brandExportRamp(style, style.theme === 'dark') : null;
    if (ramp) out[d.id] = { ramp };
  }
  return out;
}

function pdConfig(st: PdState, brands?: Record<string, { ramp: any }>): any {
  return {
    projectId: st.projectId,
    dashboardIds: st.dashboards.filter((d) => st.picked.has(d.id)).map((d) => d.id),
    storyIds: st.stories.filter((s) => st.picked.has(s.id)).map((s) => s.id),
    scorecardIds: st.scorecards.filter((s) => st.picked.has(s.id)).map((s) => s.id),
    outDir: st.outDir,
    options: { title: st.title || undefined, maxCombos: st.maxCombos, afterRefresh: st.afterRefresh },
    ...(brands ? { brands } : {}),
  };
}

function pdClose(): void {
  if (!pdOverlay) return;
  pdOverlay.remove();
  pdOverlay = null;
  window.clearTimeout(pdPlanTimer);
}

/** Open the dialog. `preselect` ticks one dashboard (the editor's own More menu). */
async function openPublishDialog(preselect?: string): Promise<void> {
  if (!currentProjectId || pdOverlay) return;
  let targets: any = null;
  let stored: any = null;
  try {
    [targets, stored] = await Promise.all([
      window.hubPlatform.publishTargets(currentProjectId),
      window.hubPlatform.publishConfig(currentProjectId),
    ]);
  } catch (_) { targets = null; }
  if (!targets || !targets.ok) { showToast((targets && targets.error) || t('publishDialog.could_not_open_publish')); return; }
  const cfg = stored && stored.config ? stored.config : null;
  const st: PdState = {
    projectId: currentProjectId,
    dashboards: targets.dashboards || [],
    stories: targets.stories || [],
    scorecards: targets.scorecards || [],
    picked: new Set<string>(cfg ? [...cfg.dashboardIds, ...cfg.storyIds, ...(cfg.scorecardIds || [])] : preselect ? [preselect] : (targets.dashboards || []).slice(0, 1).map((d: any) => d.id)),
    outDir: cfg ? cfg.outDir : '',
    title: cfg && cfg.options.title ? cfg.options.title : '',
    maxCombos: cfg && cfg.options.maxCombos ? cfg.options.maxCombos : 256,
    afterRefresh: !!(cfg && cfg.options.afterRefresh),
    plan: null,
  };
  if (preselect) st.picked.add(preselect);

  pdOverlay = pdEl('div', 'ws-modal-overlay');
  const box = pdEl('div', 'ws-modal pd-modal');
  pdOverlay.appendChild(box);
  document.body.appendChild(pdOverlay);

  const head = pdEl('div', 'pd-head');
  const ic = pdEl('span', 'pd-head-ic');
  ic.appendChild(icon('globe', 20));
  head.appendChild(ic);
  const ht = pdEl('div', 'pd-head-text');
  ht.appendChild(pdEl('h2', 'pd-title', t('publishDialog.publish_to_folder')));
  ht.appendChild(pdEl('p', 'pd-sub', t('publishDialog.a_static_site_anyone_can_open')));
  head.appendChild(ht);
  box.appendChild(head);

  const cols = pdEl('div', 'pd-cols');
  const left = pdEl('section', 'pd-col');
  const right = pdEl('section', 'pd-col');
  cols.append(left, right);
  box.appendChild(cols);

  // ── What to publish ──
  const pickList = (title: string, items: Array<{ id: string; name: string; sheets?: number }>, empty: string, glyph: string): HTMLElement => {
    const sec = pdEl('div', 'pd-group');
    const gh = pdEl('div', 'pd-group-head');
    gh.appendChild(pdEl('span', 'pd-group-title', title));
    if (items.length > 1) {
      const all = pdEl('button', 'pd-link', t('publishDialog.select_all')) as HTMLButtonElement;
      all.type = 'button';
      all.addEventListener('click', () => {
        const every = items.every((i) => st.picked.has(i.id));
        for (const i of items) { if (every) st.picked.delete(i.id); else st.picked.add(i.id); }
        sec.querySelectorAll('input[type=checkbox]').forEach((c) => { (c as HTMLInputElement).checked = !every; });
        all.textContent = every ? t('publishDialog.select_all') : t('publishDialog.select_none');
        pdReplan(st, box);
      });
      gh.appendChild(all);
    }
    sec.appendChild(gh);
    if (!items.length) { sec.appendChild(pdEl('p', 'pd-none', empty)); return sec; }
    for (const it of items) {
      const row = pdEl('label', 'pd-pick');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = st.picked.has(it.id);
      cb.dataset.id = it.id;
      cb.addEventListener('change', () => { if (cb.checked) st.picked.add(it.id); else st.picked.delete(it.id); pdReplan(st, box); });
      const g = pdEl('span', 'pd-pick-ic');
      g.appendChild(icon(glyph));
      const name = pdEl('span', 'pd-pick-name', it.name);
      row.append(cb, g, name);
      if (it.sheets && it.sheets > 1) row.appendChild(pdEl('span', 'pd-pick-meta', it.sheets + ' sheets'));
      sec.appendChild(row);
    }
    return sec;
  };
  left.appendChild(pdEl('h3', 'pd-col-title', t('publishDialog.what_to_publish')));
  left.appendChild(pickList(t('common.dashboards'), st.dashboards, t('publishDialog.no_dashboards_in_this_project_yet'), 'layout-dashboard'));
  left.appendChild(pickList(t('common.stories'), st.stories, t('publishDialog.no_stories_in_this_project_yet'), 'file-text'));
  left.appendChild(pickList(t('common.scorecards'), st.scorecards, t('publishDialog.no_scorecards_in_this_project_yet'), 'target'));

  // ── Where and how ──
  right.appendChild(pdEl('h3', 'pd-col-title', t('publishDialog.where_and_how')));
  const folder = pdEl('div', 'pd-field');
  folder.appendChild(pdEl('span', 'pd-label', t('publishDialog.output_folder')));
  const frow = pdEl('div', 'pd-folder');
  const fpath = pdEl('span', 'pd-folder-path', st.outDir ? pdShortPath(st.outDir) : t('common.no_folder_chosen'));
  if (st.outDir) fpath.title = st.outDir;
  fpath.classList.toggle('is-empty', !st.outDir);
  const choose = pdEl('button', 'btn btn-sm', st.outDir ? t('publishDialog.change') : t('common.choose')) as HTMLButtonElement;
  choose.type = 'button';
  choose.id = 'pd-choose';
  choose.addEventListener('click', async () => {
    let r: any = null;
    try { r = await window.hubPlatform.publishPickFolder(); } catch (_) { r = null; }
    if (!r || !r.ok) return;
    st.outDir = r.path;
    fpath.textContent = pdShortPath(r.path);
    fpath.title = r.path;
    fpath.classList.remove('is-empty');
    choose.textContent = t('publishDialog.change');
    pdReplan(st, box);
  });
  frow.append(fpath, choose);
  folder.appendChild(frow);
  folder.appendChild(pdEl('span', 'pd-help', t('publishDialog.index_html_one_page_per_dashboard')));
  right.appendChild(folder);

  const tfield = pdEl('label', 'pd-field');
  tfield.appendChild(pdEl('span', 'pd-label', t('publishDialog.site_title')));
  const tin = document.createElement('input');
  tin.type = 'text';
  tin.className = 'pd-input';
  tin.placeholder = t('publishDialog.the_project_s_name');
  tin.value = st.title;
  tin.addEventListener('input', () => { st.title = tin.value.trim(); });
  tfield.appendChild(tin);
  right.appendChild(tfield);

  const cfield = pdEl('label', 'pd-field');
  cfield.appendChild(pdEl('span', 'pd-label', t('publishDialog.filter_bar_combinations')));
  const csel = document.createElement('select');
  csel.className = 'pd-input';
  for (const n of [32, 64, 128, 256, 512, 1024]) {
    const o = document.createElement('option');
    o.value = String(n);
    o.textContent = t('publishDialog.up_to_per_dashboard', { p0: n.toLocaleString() });
    csel.appendChild(o);
  }
  csel.value = String(st.maxCombos);
  csel.addEventListener('change', () => { st.maxCombos = Number(csel.value); pdReplan(st, box); });
  cfield.appendChild(csel);
  cfield.appendChild(pdEl('span', 'pd-help', t('publishDialog.each_state_of_the_filter_bar')));
  right.appendChild(cfield);

  const arow = pdEl('label', 'pd-check');
  const acb = document.createElement('input');
  acb.type = 'checkbox';
  acb.checked = st.afterRefresh;
  acb.addEventListener('change', () => { st.afterRefresh = acb.checked; });
  arow.append(acb, pdEl('span', '', t('publishDialog.re_publish_after_data_refreshes')));
  right.appendChild(arow);
  // The Share policy on the publish path: "2 sensitive columns will be masked · Change".
  const share = pdEl('div', 'pd-share');
  right.appendChild(share);
  if (typeof pvMountShareNote === 'function') pvMountShareNote(share, 'publish', null, null);

  // ── The size, live ──
  const summary = pdEl('section', 'pd-summary');
  summary.setAttribute('aria-live', 'polite');
  box.appendChild(summary);

  const foot = pdEl('div', 'pd-foot');
  const cancel = pdEl('button', 'btn', t('common.cancel')) as HTMLButtonElement;
  cancel.type = 'button';
  cancel.addEventListener('click', pdClose);
  const go = pdEl('button', 'btn btn-primary', t('common.publish_2')) as HTMLButtonElement;
  go.type = 'button';
  go.id = 'pd-publish';
  go.addEventListener('click', () => { void pdPublish(st); });
  foot.append(cancel, go);
  box.appendChild(foot);

  const a11y = makeModalAccessible(box, t('publishDialog.publish_to_folder'), choose);
  pdOverlay.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); pdClose(); a11y.release(); }
    else a11y.onTabKey(e);
  });
  pdOverlay.addEventListener('mousedown', (e) => { if (e.target === pdOverlay) pdClose(); });
  pdReplan(st, box);
}

/** Ask main for the size — debounced — and paint it. */
function pdReplan(st: PdState, box: HTMLElement): void {
  window.clearTimeout(pdPlanTimer);
  const summary = box.querySelector('.pd-summary') as HTMLElement;
  const go = box.querySelector('#pd-publish') as HTMLButtonElement;
  const any = st.picked.size > 0;
  go.disabled = true;
  if (!any) {
    summary.textContent = '';
    summary.appendChild(pdEl('p', 'pd-summary-line is-muted', t('publishDialog.pick_at_least_one_dashboard_or')));
    return;
  }
  summary.classList.add('is-loading');
  pdPlanTimer = window.setTimeout(async () => {
    const seq = ++pdPlanSeq;
    let res: any = null;
    try { res = await window.hubPlatform.publishPlan(pdConfig(st)); } catch (_) { res = null; }
    if (seq !== pdPlanSeq || !pdOverlay) return;
    summary.classList.remove('is-loading');
    st.plan = res && res.ok ? res.plan : null;
    pdPaintSummary(st, summary);
    go.disabled = !st.plan || st.plan.tooBig || !st.outDir;
    go.title = !st.outDir ? t('publishDialog.choose_an_output_folder_first') : '';
  }, 250);
}

function pdPaintSummary(st: PdState, host: HTMLElement): void {
  host.textContent = '';
  const p = st.plan;
  if (!p) { host.appendChild(pdEl('p', 'pd-summary-line is-error', t('publishDialog.could_not_size_the_site'))); return; }
  host.classList.toggle('is-over', !!p.tooBig);
  const line = pdEl('p', 'pd-summary-line', p.summary);
  line.id = 'pd-summary-line';
  host.appendChild(line);
  const meter = pdEl('div', 'pd-meter');
  meter.setAttribute('role', 'meter');
  meter.setAttribute('aria-label', t('publishDialog.size_against_the_50_mb_limit'));
  meter.setAttribute('aria-valuemin', '0');
  meter.setAttribute('aria-valuemax', String(p.maxBytes));
  meter.setAttribute('aria-valuenow', String(p.bytes));
  const fill = pdEl('div', 'pd-meter-fill');
  fill.style.width = Math.min(100, (p.bytes / p.maxBytes) * 100).toFixed(1) + '%';
  meter.appendChild(fill);
  host.appendChild(meter);
  const list = pdEl('ul', 'pd-pages');
  for (const pg of p.pages) {
    const li = pdEl('li', 'pd-page');
    li.appendChild(pdEl('span', 'pd-page-name', pg.name));
    const bits = [pg.kind === 'story' ? t('common.story') : pg.kind === 'scorecard' ? t('common.scorecard') : pg.combos === 1 ? t('publishDialog.no_filter_bar') : pg.combos.toLocaleString() + ' combinations'];
    if (pg.mode === 'single') bits.push(t('publishDialog.one_filter_at_a_time'));
    bits.push(pdBytes(pg.bytes));
    li.appendChild(pdEl('span', 'pd-page-meta', bits.join(' · ')));
    list.appendChild(li);
    for (const d of pg.dropped || []) {
      list.appendChild(pdEl('li', 'pd-page-note', t('publishDialog.keeps_its_first_options_more_are', { control: d.control, optionsCount: d.options.length })));
    }
  }
  host.appendChild(list);
  if (p.tooBig) {
    host.appendChild(pdEl('p', 'pd-over', t('publishDialog.over_the_limit_to_fit_drop', { maxBytes: pdBytes(p.maxBytes) })));
    const sug = pdEl('ul', 'pd-suggest');
    for (const s of p.suggestions || []) sug.appendChild(pdEl('li', '', s));
    host.appendChild(sug);
  }
}

/** The END of a long path identifies it: "…/Reports/Site". The full path is the title. */
function pdShortPath(p: string): string {
  if (p.length <= 44) return p;
  const parts = p.split(/[\\/]/).filter(Boolean);
  let out = parts.pop() || p;
  while (parts.length && out.length + parts[parts.length - 1].length < 40) out = parts.pop() + '/' + out;
  return '…/' + out;
}

function pdBytes(n: number): string {
  if (n >= 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + ' MB';
  if (n >= 1024) return Math.round(n / 1024) + ' KB';
  return n + ' B';
}

async function pdPublish(st: PdState): Promise<void> {
  // Under 'include' the policy asks first; mask/drop is already on the dialog.
  if (typeof pvShareGate === 'function' && !(await pvShareGate('publish', null, { noted: true }))) return;
  const brands = await pdBrands(st);
  const config = pdConfig(st, brands);
  pdClose();
  showToast(t('publishDialog.publishing_follow_it_in_jobs'));
  let res: any = null;
  try { res = await window.hubPlatform.publishRun(config); } catch (_) { res = null; }
  if (res && res.canceled) return;
  if (!res || !res.ok) { showToast((res && res.error) || t('publishDialog.publishing_failed'), { kind: 'error' }); return; }
  const r = res.result;
  showToast(t('publishDialog.published_files', { filesCount: r.files.length, bytes: pdBytes(r.bytes) }), res.jobId
    ? { kind: 'success', action: { label: t('common.reveal'), onClick: () => { void window.hubPlatform.revealJob(res.jobId); } } }
    : { kind: 'success' });
}

/** "Re-publish": the remembered choices, with brand ramps recomputed here. */
async function republishSite(): Promise<void> {
  if (!currentProjectId) return;
  let stored: any = null;
  try { stored = await window.hubPlatform.publishConfig(currentProjectId); } catch (_) { stored = null; }
  const cfg = stored && stored.config;
  if (!cfg) { void openPublishDialog(); return; }
  if (typeof pvShareGate === 'function' && !(await pvShareGate('publish', null))) return;
  const st = { projectId: currentProjectId, dashboards: cfg.dashboardIds.map((id: string) => ({ id, name: '' })), picked: new Set<string>(cfg.dashboardIds) } as any;
  const brands = await pdBrands(st);
  showToast(t('publishDialog.re_publishing_follow_it_in_jobs'));
  let res: any = null;
  try { res = await window.hubPlatform.publishRepublish(currentProjectId, brands); } catch (_) { res = null; }
  if (res && res.canceled) return;
  if (!res || !res.ok) { showToast((res && res.error) || t('publishDialog.publishing_failed'), { kind: 'error' }); return; }
  showToast(t('publishDialog.re_published_files', { filesCount: res.result.files.length, bytes: pdBytes(res.result.bytes) }), { kind: 'success' });
}

/** The Dashboards header's ⋯ menu: Publish…, and Re-publish once there is something to redo. */
async function openDashboardsMoreMenu(btn: HTMLElement): Promise<void> {
  let stored: any = null;
  try { stored = currentProjectId ? await window.hubPlatform.publishConfig(currentProjectId) : null; } catch (_) { stored = null; }
  const cfg = stored && stored.config;
  openMiniMenu(btn, (el: HTMLElement, close: () => void) => {
    const pub = miniMenuRow(t('common.publish'));
    pub.addEventListener('click', () => { close(); void openPublishDialog(); });
    el.appendChild(pub);
    if (cfg) {
      const when = cfg.lastPublishedAt ? ' (last ' + new Date(cfg.lastPublishedAt).toLocaleDateString() + ')' : '';
      const re = miniMenuRow('Re-publish' + when);
      re.addEventListener('click', () => { close(); void republishSite(); });
      el.appendChild(re);
    }
  });
}

{
  const more = document.getElementById('an-list-more');
  if (more) more.addEventListener('click', () => { void openDashboardsMoreMenu(more); });
}
