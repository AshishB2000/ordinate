// The Assistant's STORY proposal — the dashboard proposal's sibling.
//
// Same loop (dockPropose.ts dkRenderPlanCard): the model proposes STRUCTURE,
// main validates and previews it (`story:draft` → draftAnalysisPlan), the card
// shows everything that will be built — here as an OUTLINE, a section per
// sheet with its KPIs, its charts previewed from app-computed data, and its
// note — and nothing is created until Build (`story:build`). Then the new
// story opens.
//
// Classic global-scope script — NO import/export; textContent only.

async function stProposeStory(intent: string, datasetId: string, containerId = 'dk-messages'): Promise<void> {
  if (!currentProjectId) return;
  let res: any = null;
  try {
    res = await window.hub.draftStory(currentProjectId, intent, datasetId || undefined);
  } catch (_) {
    res = null;
  }
  if (!res || res.notReady) {
    if (res && res.notReady) showToast('Set up the Assistant in Settings to draft a story.');
    return;
  }
  if (res.ok === false) { showToast(res.error ? String(res.error) : 'Could not draft a story.'); return; }
  const sheets: any[] = Array.isArray(res.sheets) ? res.sheets : [];
  if (!sheets.length && !(Array.isArray(res.dropped) && res.dropped.length)) return;
  stRenderStoryProposal(res, containerId);
}

function stRenderStoryProposal(res: any, containerId: string): void {
  const { card, actions } = dkProposalCard('Suggested story');
  card.classList.add('st-proposal');
  card.appendChild(Object.assign(document.createElement('div'), {
    className: 'dk-plan-name', textContent: res.name ? String(res.name) : 'Assistant story',
  }));
  if (typeof res.rationale === 'string' && res.rationale.trim()) {
    card.appendChild(Object.assign(document.createElement('div'), { className: 'ai-interp-body', textContent: String(res.rationale) }));
  }

  const outline = document.createElement('ol');
  outline.className = 'st-prop-outline';
  (Array.isArray(res.sheets) ? res.sheets : []).forEach((sheet: any) => {
    const li = document.createElement('li');
    li.className = 'st-prop-section';
    li.appendChild(Object.assign(document.createElement('div'), { className: 'st-prop-h', textContent: String(sheet.name || 'Section') }));
    const kpis: any[] = Array.isArray(sheet.metrics) ? sheet.metrics : [];
    if (kpis.length) {
      const row = document.createElement('div');
      row.className = 'dk-plan-kpis';
      kpis.forEach((m: any) => {
        const chip = document.createElement('span');
        chip.className = 'dk-plan-kpi';
        chip.appendChild(Object.assign(document.createElement('span'), { className: 'dk-plan-kpi-name', textContent: String(m.label || m.column || 'KPI') }));
        chip.appendChild(Object.assign(document.createElement('span'), { className: 'dk-plan-kpi-how', textContent: `${m.aggregation || 'sum'} of ${m.column || ''}` }));
        row.appendChild(chip);
      });
      li.appendChild(row);
    }
    const visuals: any[] = Array.isArray(sheet.visuals) ? sheet.visuals : [];
    if (visuals.length) {
      const grid = document.createElement('div');
      grid.className = 'dk-plan-grid';
      visuals.forEach((v: any) => { if (typeof anDraftVisualEl === 'function') grid.appendChild(anDraftVisualEl(v, true)); });
      li.appendChild(grid);
    }
    (Array.isArray(sheet.texts) ? sheet.texts : []).forEach((t: any) => {
      const text = [t && t.heading, t && t.text].filter(Boolean).join(' — ');
      if (text) li.appendChild(Object.assign(document.createElement('div'), { className: 'dk-plan-note', textContent: text }));
    });
    outline.appendChild(li);
  });
  card.appendChild(outline);
  if (typeof anDraftAppendDropped === 'function') anDraftAppendDropped(card, res.dropped);

  const build = dkMkBtn('Build story', true, () => {
    void (async () => {
      if (!currentProjectId) return;
      build.disabled = true;
      let out: any = null;
      try {
        out = await window.hub.buildStory(currentProjectId, res.plan);
      } catch (_) {
        out = null;
      }
      if (!out || !out.ok || !out.story) {
        build.disabled = false;
        showToast(out && out.error ? String(out.error) : 'Could not build that story.');
        return;
      }
      dkRemoveProposalCard(card);
      await stOpen(String(out.story.id));
    })();
  });
  actions.appendChild(build);
  actions.appendChild(dkMkBtn('Dismiss', false, () => dkRemoveProposalCard(card)));
  card.appendChild(actions);
  dkAppendProposal(card, containerId);
}
