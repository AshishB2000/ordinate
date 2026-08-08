// Publishing, and knowing whether you need to: the editor's publish state, and
// publish / republish itself.
//
// A published dashboard is a SNAPSHOT, copied BY VALUE. Main refuses every
// non-publish write to one, and the frozen card.visual wins over card.visualId
// — that precedence is the whole guarantee, so nothing here may weaken it.
//
// Split verbatim out of analyses.ts — see .claude/rules/file-size.md. Classic
// global-scope renderer <script>: no import/export.

// ── Publish state (editor) ──────────────────────────────────────────────────
// Called by dashboards.ts on open and after every analysis save.
function renderAnalysisPubState(): void {
  const el = dashEl('an-pubstate');
  const republish = dashEl('an-republish-btn');
  if (!el) return;
  if (dashMode !== 'analysis' || !dashCurrent) {
    el.hidden = true;
    if (republish) republish.hidden = true;
    return;
  }
  const ids: any[] = Array.isArray(dashCurrent.publishedDashboardIds) ? dashCurrent.publishedDashboardIds : [];
  if (republish) republish.hidden = ids.length === 0;

  el.hidden = false;
  el.innerHTML = '';
  const line = document.createElement('span');
  if (!dashCurrent.lastPublishedAt) {
    line.textContent = 'Not published yet. Publishing takes a snapshot of these sheets as a dashboard — the read-only surface people open.';
  } else {
    line.textContent =
      'Published ' + formatSidebarTime(dashCurrent.lastPublishedAt) +
      (anLastPublishedName ? ' to “' + anLastPublishedName + '”' : '') +
      ' · ' + ids.length + (ids.length === 1 ? ' dashboard' : ' dashboards');
  }
  el.appendChild(line);
  if (analysisHasUnpublishedChanges(dashCurrent)) {
    const dirty = document.createElement('span');
    dirty.className = 'an-pubstate-dirty';
    dirty.textContent = ' · Unpublished changes — republish to update the dashboard.';
    el.appendChild(dirty);
  }
  // Focus mode hides this line — it was a paragraph of chrome sitting on the
  // sheet — so the same words become the Publish button's tooltip. Same fact,
  // no canvas space.
  const pubBtn = dashEl('an-publish-btn');
  if (pubBtn) pubBtn.title = el.textContent || '';
  anRenderPubPill();
}

/**
 * The publish state as a PILL next to the button — the three states the list
 * already computes, from the same `analysisHasUnpublishedChanges`, never a
 * second derivation.
 *
 * It exists because focus mode hides #an-pubstate: the state was reachable
 * only by hovering Publish for its tooltip, which is not an affordance.
 */
function anRenderPubPill(): void {
  const pill = dashEl('an-pubpill');
  if (!pill) return;
  if (dashMode !== 'analysis' || !dashCurrent) {
    pill.hidden = true;
    return;
  }
  pill.hidden = false;
  pill.classList.remove('an-pubpill--draft', 'an-pubpill--live', 'an-pubpill--dirty');
  if (!dashCurrent.lastPublishedAt) {
    pill.classList.add('an-pubpill--draft');
    pill.textContent = 'Draft';
    pill.title = 'Not published yet.';
  } else if (analysisHasUnpublishedChanges(dashCurrent)) {
    pill.classList.add('an-pubpill--dirty');
    pill.textContent = 'Unpublished changes';
    pill.title = 'This analysis has changed since it was last published — republish to update the dashboard.';
  } else {
    pill.classList.add('an-pubpill--live');
    pill.textContent = 'Published';
    pill.title = 'Published ' + formatSidebarTime(dashCurrent.lastPublishedAt) + ' · up to date.';
  }
}

// ── Publish / republish ─────────────────────────────────────────────────────
// A snapshot, not a link: each referenced visual's DEFINITION is copied by value
// into the published card, so editing the analysis (or the visual) afterwards
// cannot move the dashboard. The DATA is deliberately NOT snapshotted — the
// dashboard keeps reading live rows through the frozen definition — which is
// stated on the confirmation because "snapshot" could reasonably be read the
// other way.
async function handlePublishAnalysis(chooseTarget: boolean): Promise<void> {
  if (!currentProjectId || !dashCurrent || dashMode !== 'analysis') return;
  const analysisId = String(dashCurrent.id);
  // Publish WHAT YOU SEE: flush any debounced edit before main reads the file.
  if (dashSaveTimer !== null || dashDirty) await handleSaveDashboard();

  let dashboardId: string | undefined;
  if (chooseTarget) {
    const ids: string[] = Array.isArray(dashCurrent.publishedDashboardIds)
      ? dashCurrent.publishedDashboardIds.map(String) : [];
    let all: any[] = [];
    try { all = await window.hub.listDashboards(currentProjectId); } catch (_) { all = []; }
    if (!Array.isArray(all)) all = [];
    const options = ids
      .map((id) => all.find((d: any) => String(d.id) === id))
      .filter(Boolean)
      .map((d: any) => ({ value: String(d.id), label: 'Replace “' + (d.name || 'Untitled dashboard') + '”' }));
    options.push({ value: '', label: 'Publish as a new dashboard' });
    const pick = await dashChooseModal('Republish this analysis', options, 'Publish');
    if (pick === null) return;
    if (pick) dashboardId = pick;
  }

  const btn = dashEl(chooseTarget ? 'an-republish-btn' : 'an-publish-btn') as HTMLButtonElement | null;
  const label = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = 'Publishing…'; }
  let res: any;
  try {
    res = await window.hub.publishAnalysis(currentProjectId, analysisId, dashboardId ? { dashboardId } : {});
  } catch (_) {
    res = { ok: false, error: 'Could not publish this analysis.' };
  }
  if (btn) { btn.disabled = false; btn.textContent = label || 'Publish'; }

  if (!res || res.ok === false || !res.dashboard) {
    window.alert((res && res.error) || 'Could not publish this analysis.');
    return;
  }

  // Reflect the new provenance locally (main wrote it; we are not re-reading the
  // file just to repaint one line).
  const d = res.dashboard;
  anLastPublishedName = d.name ? String(d.name) : 'Untitled dashboard';
  dashCurrent.lastPublishedAt = d.publishedAt || new Date().toISOString();
  if (!Array.isArray(dashCurrent.publishedDashboardIds)) dashCurrent.publishedDashboardIds = [];
  if (!dashCurrent.publishedDashboardIds.includes(d.id)) dashCurrent.publishedDashboardIds.push(d.id);
  renderAnalysisPubState();
  await refreshAnalysisListKeepEditor();
  showToast((res.created ? 'Published to a new dashboard “' : 'Republished over “') + anLastPublishedName + '”');
}

