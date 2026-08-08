// The embedded AI actions on a sheet: summarise, and explain an anomaly. The
// app has already computed every figure involved (src/anomalies.ts is a pure
// detector); the model only puts those figures into words.
//
// Split verbatim out of dashboards.ts — see .claude/rules/file-size.md. Classic
// global-scope renderer <script>: no import/export. Loads AFTER dashboards.js,
// which keeps the module-local state (dashCurrent, dashMode, dashReadOnly,
// dashDirty, chartInstances, …) that every function here reads and writes —
// that state is NOT duplicated, and there is deliberately no accessor layer
// around it, because the renderer is one shared global scope by design.

// ── Embedded AI actions (Week 12) ─────────────────────────────────────────────
// Shared across every embedded AI panel (calc field, summary, anomalies) so all
// look identical: a badge + a label marking the block as AI interpretation, clearly
// distinct from the app-computed facts. Returns the head row; callers append a body.
function mkAiPanel(labelText: string): HTMLElement {
  const head = document.createElement('div');
  head.className = 'ai-interp-head';
  const badge = document.createElement('span');
  badge.className = 'ai-badge';
  badge.textContent = 'AI';
  const label = document.createElement('span');
  label.className = 'ai-interp-label';
  label.textContent = labelText;
  head.appendChild(badge);
  head.appendChild(label);
  return head;
}

// Render a labeled AI-interpretation panel (badge/label + prose body) into `out`.
function renderAiPanel(out: HTMLElement, labelText: string, bodyText: string): void {
  out.hidden = false;
  out.innerHTML = '';
  out.appendChild(mkAiPanel(labelText));
  const body = document.createElement('div');
  body.className = 'ai-interp-body';
  body.textContent = bodyText;
  out.appendChild(body);
}

// Render the anomaly panel: AI prose (interpretation) PLUS a visually separate
// block of the app-detected, app-computed anomaly facts.
function renderAnomaliesPanel(out: HTMLElement, anomalies: any[], proseText: string): void {
  out.hidden = false;
  out.innerHTML = '';
  out.appendChild(mkAiPanel('AI interpretation — figures are app-computed'));
  if (proseText) {
    const body = document.createElement('div');
    body.className = 'ai-interp-body';
    body.textContent = proseText;
    out.appendChild(body);
  }
  const list = Array.isArray(anomalies) ? anomalies : [];
  if (list.length) {
    const facts = document.createElement('div');
    facts.className = 'ai-facts';
    const flabel = document.createElement('div');
    flabel.className = 'ai-facts-label';
    flabel.textContent = 'App-detected (computed)';
    facts.appendChild(flabel);
    list.forEach((a: any) => {
      const item = document.createElement('div');
      item.className = 'ai-facts-item' + (a && a.severity === 'warn' ? ' ai-facts-warn' : '');
      item.textContent = a && a.detail ? String(a.detail) : '';
      facts.appendChild(item);
    });
    out.appendChild(facts);
  }
}

// The AI draft now lands on the ANALYSIS surface — see handleDraftAnalysis in
// analyses.ts. The channel (analysis:draft) always returned `sheets`; what was
// missing was somewhere to put them, and `dashboard:draft` no longer exists.

// Executive summary (editor): persist pending edits, then main recomputes every
// card's figure and feeds them as FACTS; the model only narrates. Prose renders as
// clearly-labeled AI interpretation above the grid.
async function handleDashSummary(): Promise<void> {
  if (!dashCurrent || !currentProjectId) return;
  if (dashDirty) await persistDashboard();
  const out = dashEl('dash-ai-out');
  if (!out) return;
  const lbl = 'AI interpretation — figures are app-computed';
  renderAiPanel(out, lbl, 'Thinking…');
  let res: any;
  try {
    res = await window.hub.summarizeDashboard(currentProjectId, dashCurrent.id);
  } catch (_) {
    res = { ok: false, error: 'Could not summarize the dashboard.' };
  }
  if (res && res.notReady) {
    renderAiPanel(out, lbl, 'Connect a model in Execution settings to summarize the dashboard.');
    return;
  }
  if (!res || res.ok === false) {
    renderAiPanel(out, lbl, (res && res.error) || 'Could not summarize the dashboard.');
    return;
  }
  renderAiPanel(out, lbl, res.text || 'No summary produced.');
}

// Explain anomalies (editor): the APP detects anomalies (pure, computed) and the
// model only contextualizes them. Show the AI prose plus the separate app-computed
// facts list. Empty → "No unusual changes detected." (no model needed).
async function handleDashAnomalies(): Promise<void> {
  if (!dashCurrent || !currentProjectId) return;
  if (dashDirty) await persistDashboard();
  const out = dashEl('dash-ai-out');
  if (!out) return;
  const lbl = 'AI interpretation — figures are app-computed';
  renderAiPanel(out, lbl, 'Thinking…');
  let res: any;
  try {
    res = await window.hub.explainDashboardAnomalies(currentProjectId, dashCurrent.id);
  } catch (_) {
    res = { ok: false, error: 'Could not explain anomalies.' };
  }
  if (res && res.notReady) {
    // The app may still have detected anomalies with no model configured — show the
    // computed facts alongside a gentle hint in place of the AI prose.
    renderAnomaliesPanel(out, res.anomalies, 'Connect a model in Execution settings to interpret these anomalies.');
    return;
  }
  if (!res || res.ok === false) {
    renderAiPanel(out, lbl, (res && res.error) || 'Could not explain anomalies.');
    return;
  }
  const list = Array.isArray(res.anomalies) ? res.anomalies : [];
  if (!res.text && list.length === 0) {
    renderAiPanel(out, lbl, 'No unusual changes detected.');
    return;
  }
  renderAnomaliesPanel(out, list, res.text || '');
}

