'use strict';

// Settings → Privacy, for the CURRENT project: the Share policy (what exports,
// reports, publish and bundles do with a sensitive column), the proposals
// waiting for review across every dataset, the columns already marked, and
// where the masking key lives. Every export dialog's "Change" link lands here
// (privacyShare.ts pvOpenPolicy).
//
// Built into #stp-privacy each time the pane is SHOWN — hub.ts's
// selectSettingsCat flips the section's `hidden`, and a MutationObserver on it
// is the whole hook, so hub.ts carries one CAT_TITLES line for this and nothing
// else. Classic global-scope renderer <script>: no import/export.

const PV_PATHS: Array<{ key: string; title: string; desc: string }> = [
  { key: 'export', title: t('privacySettings.exports'), desc: t('privacySettings.dashboard_and_visual_exports_exported') },
  { key: 'report', title: t('privacySettings.reports_and_stories'), desc: t('privacySettings.generated_reports_scheduled_ones') },
  { key: 'publish', title: t('common.publish_2'), desc: t('privacySettings.dashboards_published_as_a_site') },
  { key: 'bundle', title: t('privacySettings.project_bundles'), desc: t('privacySettings.ordinate_files_a_dataset_with_sensitive') },
];
const PV_ACTIONS: Array<[string, string, string]> = [
  ['mask', t('privacySettings.mask'), t('privacySettings.replace_each_value_with_this_project')],
  ['drop', t('privacySettings.drop'), t('privacySettings.leave_the_column_out_hide_a')],
  ['include', t('privacySettings.include'), t('privacySettings.keep_the_values_and_ask_before')],
];

let pvSettingsSeq = 0;

function pvSettingsHost(): HTMLElement | null {
  return document.getElementById('stp-privacy');
}

function pvSubhead(title: string, desc?: string): HTMLElement {
  const h = pvEl('div', 'stp-subhead');
  h.appendChild(pvEl('div', 'stp-subhead-t', title));
  if (desc) h.appendChild(pvEl('div', 'stp-subhead-d', desc));
  return h;
}

function pvRow(title: string, desc: string, right: HTMLElement | null): HTMLElement {
  const row = pvEl('div', 'stp-row');
  const l = pvEl('div', 'stp-rl');
  l.appendChild(pvEl('div', 'stp-rt', title));
  if (desc) l.appendChild(pvEl('div', 'stp-rd', desc));
  row.appendChild(l);
  if (right) {
    const r = pvEl('div', 'stp-rr');
    r.appendChild(right);
    row.appendChild(r);
  }
  return row;
}

/** The three-way choice for one path. Saves on click; repaints from what main stored. */
function pvActionSeg(pathKey: string, current: string): HTMLElement {
  const seg = pvEl('div', 'stp-seg pv-seg');
  seg.setAttribute('role', 'radiogroup');
  seg.setAttribute('aria-label', PV_PATHS.find((p) => p.key === pathKey)?.title || pathKey);
  const paint = (v: string): void => {
    seg.querySelectorAll<HTMLElement>('.stp-seg-opt').forEach((b) => {
      const on = b.dataset.value === v;
      b.classList.toggle('active', on);
      b.setAttribute('aria-checked', String(on));
    });
  };
  for (const [v, label, hint] of PV_ACTIONS) {
    const b = pvBtn('stp-seg-opt pv-seg-opt--' + v, label, async () => {
      if (!currentProjectId) return;
      paint(v);
      let r: any = null;
      try { r = await window.hubPrivacy.setPolicy(currentProjectId, { [pathKey]: v }); } catch (_) { r = null; }
      if (!r || !r.ok) { showToast(t('privacySettings.could_not_save_the_share_policy')); return; }
      paint(r.policy[pathKey]);
    });
    b.dataset.value = v;
    b.title = hint;
    b.setAttribute('role', 'radio');
    seg.appendChild(b);
  }
  paint(current);
  return seg;
}

async function pvSettingsDecide(datasetId: string, column: string, level: string): Promise<void> {
  if (!currentProjectId) return;
  let r: any = null;
  try { r = await window.hubPrivacy.decide(currentProjectId, datasetId, column, level); } catch (_) { r = null; }
  if (!r || !r.ok) { showToast(t('common.could_not_save_that')); return; }
  if (typeof ctLoadColumnDocs === 'function') void ctLoadColumnDocs(datasetId, true);
  if (datasetId === expId) { await pvLoadReview(expId); pvPaintBannerNow(); }
  await pvRenderSettings();
}

async function pvRenderSettings(): Promise<void> {
  const host = pvSettingsHost();
  if (!host) return;
  const seq = ++pvSettingsSeq;
  if (!currentProjectId || !window.hubPrivacy) {
    host.innerHTML = '';
    host.appendChild(pvEl('p', 'pv-empty-note', t('privacySettings.open_a_project_to_set_what')));
    return;
  }
  let o: any = null;
  try { o = await window.hubPrivacy.overview(currentProjectId); } catch (_) { o = null; }
  if (seq !== pvSettingsSeq) return;
  host.innerHTML = '';
  if (!o || !o.ok) {
    host.appendChild(pvEl('p', 'pv-empty-note', (o && o.error) || t('privacySettings.could_not_read_this_project_s')));
    return;
  }

  // ── The share policy ──
  const intro = pvEl('div', 'pv-intro');
  intro.appendChild(icon('shield', 18));
  const introText = pvEl('div', 'pv-intro-text');
  introText.appendChild(pvEl('div', 'pv-intro-t', t('privacySettings.share_policy_for', { projectName: o.projectName })));
  introText.appendChild(pvEl('div', 'pv-intro-d', t('privacySettings.what_happens_to_columns_marked_personal')));
  intro.appendChild(introText);
  host.appendChild(intro);
  const policy = pvEl('div', 'stp-group pv-policy');
  for (const p of PV_PATHS) policy.appendChild(pvRow(p.title, p.desc, pvActionSeg(p.key, o.policy[p.key])));
  host.appendChild(policy);

  // ── Waiting for review ──
  const pendingSets = (o.datasets || []).filter((d: any) => d.pending && d.pending.length);
  const pendingCount = pendingSets.reduce((n: number, d: any) => n + d.pending.length, 0);
  if (pendingCount) {
    host.appendChild(pvSubhead(t('privacySettings.to_review', { pendingCount }), t('privacySettings.columns_that_look_personal_or_financial')));
    const box = pvEl('div', 'pv-card-list');
    for (const d of pendingSets) {
      const card = pvEl('div', 'pv-ds-card');
      card.appendChild(pvEl('div', 'pv-ds-name', d.name));
      for (const p of d.pending) {
        const row = pvEl('div', 'pv-review-row');
        const ident = pvEl('div', 'pv-review-ident');
        ident.appendChild(pvEl('span', 'pv-review-col', p.column));
        ident.appendChild(pvEl('span', 'pv-level pv-level--' + p.level, PV_LEVEL_LABEL[p.level] + '?')); // a proposal, not a mark
        ident.appendChild(pvEl('div', 'pv-review-reason', `${pvProposalTitle(p)}. ${p.reason}`));
        row.appendChild(ident);
        const acts = pvEl('div', 'pv-review-acts');
        acts.appendChild(pvBtn('btn btn-sm btn-primary', t('common.mark_as', { level: p.level }), () => void pvSettingsDecide(d.id, p.column, p.level)));
        acts.appendChild(pvBtn('btn btn-sm pv-quiet', t('common.not_sensitive'), () => void pvSettingsDecide(d.id, p.column, 'none')));
        row.appendChild(acts);
        card.appendChild(row);
      }
      box.appendChild(card);
    }
    host.appendChild(box);
  }

  // ── Marked columns ──
  const markedSets = (o.datasets || []).filter((d: any) => d.sensitive && d.sensitive.length);
  const markedCount = markedSets.reduce((n: number, d: any) => n + d.sensitive.length, 0);
  host.appendChild(pvSubhead(markedCount ? t('privacySettings.sensitive_columns', { markedCount }) : t('privacySettings.sensitive_columns_2')));
  if (!markedCount) {
    const empty = pvEl('div', 'pv-empty');
    const glyph = pvEl('div', 'pv-empty-glyph');
    glyph.appendChild(icon('shield', 22));
    empty.appendChild(glyph);
    empty.appendChild(pvEl('div', 'pv-empty-t', t('privacySettings.no_columns_are_marked_sensitive_yet')));
    empty.appendChild(pvEl('div', 'pv-empty-d', o.datasetCount
      ? t('privacySettings.ordinate_flags_likely_personal_and')
      : t('privacySettings.import_a_dataset_and_ordinate_will')));
    if (o.datasetCount) empty.appendChild(pvScanButton(o.datasetCount));
    host.appendChild(empty);
  } else {
    const box = pvEl('div', 'pv-card-list');
    for (const d of markedSets) {
      const card = pvEl('div', 'pv-ds-card');
      card.appendChild(pvEl('div', 'pv-ds-name', d.name));
      const chips = pvEl('div', 'pv-col-chips');
      for (const c of d.sensitive) {
        const chip = pvEl('span', 'pv-col-chip');
        chip.appendChild(pvEl('span', 'pv-col-name', c.column));
        chip.appendChild(pvEl('span', 'pv-level pv-level--' + c.level, PV_LEVEL_LABEL[c.level] || c.level));
        if (c.maskedInPrepare) chip.appendChild(pvEl('span', 'pv-tag', t('privacySettings.masked_in_prepare')));
        chips.appendChild(chip);
      }
      card.appendChild(chips);
      box.appendChild(card);
    }
    host.appendChild(box);
    const again = pvEl('div', 'pv-scan-again');
    again.appendChild(pvScanButton(o.datasetCount));
    host.appendChild(again);
  }

  // ── The key ──
  host.appendChild(pvSubhead(t('privacySettings.masking_key')));
  const key = pvEl('div', 'stp-group');
  key.appendChild(pvRow(t('privacySettings.kept_in_this_project_s_folder'),
    t('privacySettings.hash_steps_and_masked_exports_use'), null));
  host.appendChild(key);
}

function pvScanButton(count: number): HTMLElement {
  const b = pvBtn('btn btn-sm', t('privacySettings.check_for_sensitive_columns', { count }), async () => {
    if (!currentProjectId) return;
    b.disabled = true;
    b.textContent = t('common.checking');
    let r: any = null;
    try { r = await window.hubPrivacy.scan(currentProjectId); } catch (_) { r = null; }
    if (r && r.ok) showToast(r.found ? t('privacySettings.to_review_2', { found: r.found }) : t('privacySettings.nothing_new_looks_sensitive'));
    if (expId) { await pvLoadReview(expId); pvPaintBannerNow(); }
    await pvRenderSettings();
  });
  return b;
}

// Repaint when the pane is shown: when its tab is picked (the section's
// `hidden` flips) and when the panel opens already ON it (the panel's style
// flips) — the project may have changed since it was last drawn.
function initPrivacySettings(): void {
  const pane = document.querySelector('.settings-pane[data-cat="privacy"]') as HTMLElement | null;
  const panel = document.getElementById('settings-panel');
  if (!pane) return;
  const shown = (): boolean => !pane.hidden && !!panel && panel.style.display !== 'none' && panel.style.display !== '';
  const obs = new MutationObserver(() => { if (shown()) void pvRenderSettings(); });
  obs.observe(pane, { attributes: true, attributeFilter: ['hidden'] });
  if (panel) obs.observe(panel, { attributes: true, attributeFilter: ['style'] });
}
initPrivacySettings();
