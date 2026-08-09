// Explore — the chart under an answer. Classic global-scope renderer <script>;
// no import/export. Split from explore.ts (which owns the surface and the ask)
// because this is a separate job: turning ONE answered question into one drawn
// chart, plus the two things you can do with it.
//
// THE CONTRACT, and the reason this file is small: the model proposes STRUCTURE
// (an encoding and a chart type) and nothing else. Every number on screen comes
// from window.hub.computeVisualData — the same `visual:data` channel a saved
// visual uses — and the chart is drawn by renderVizInArea, the same path
// dashGrid.renderVisualCard uses. Nothing here reads a figure out of a model
// reply, and there is no third chart-drawing route.
//
// A chart is a BONUS on top of the text answer: every failure below is silent.
// The answer already stands on its own, and an error card under it would just
// be noise about an extra the user never asked for.
//
// Not persisted, deliberately: the transcript is rebuilt from disk on each
// successful ask, so the chart belongs to the turn that produced it. "Save as
// visual" is how you keep one — which is also the only way it gains a name, an
// id, and a place in the Visuals section.

/** Longest visual name derived from a question before it is cut. */
const XP_NAME_MAX = 60;

/** The encoding the model proposed, kept only so the two action buttons can
 *  save it. Reset on every new suggestion — one suggestion per turn, never a
 *  gallery. */
let xpLastEncoding: any = null;
let xpLastChartType = '';
let xpLastQuestion = '';
/** Set once "Save as visual" succeeds, so "Add to analysis" reuses that record
 *  instead of saving a second copy of the same chart. */
let xpSavedVisualId = '';

/** A visual name from the user's own question, bounded. Falls back to the app's
 *  existing encoding-derived name when the question is unusable as a title. */
function xpVisualName(): string {
  const q = (xpLastQuestion || '').replace(/\s+/g, ' ').trim();
  if (q) return q.length > XP_NAME_MAX ? q.slice(0, XP_NAME_MAX) : q;
  return typeof suggestVisualName === 'function'
    ? suggestVisualName(xpLastEncoding || {}, xpLastChartType)
    : 'Untitled visual';
}

/** Save the drawn chart as a real Visual. Returns its id, or '' on failure. */
async function xpSaveVisual(): Promise<string> {
  if (xpSavedVisualId) return xpSavedVisualId;
  if (!currentProjectId || !xpDatasetId || !xpLastEncoding) return '';
  let visual: any = null;
  try {
    visual = await window.hub.saveVisual({
      projectId: currentProjectId,
      datasetId: xpDatasetId,
      name: xpVisualName(),
      chartType: xpLastChartType || 'column',
      encoding: xpLastEncoding,
      overrides: {},
      filters: [],
    });
  } catch (_) {
    visual = null;
  }
  // `visual:save` answers with the bare record on success and an { ok:false }
  // envelope on failure — hence all three guards.
  if (!visual || visual.ok === false || !visual.id) return '';
  xpSavedVisualId = String(visual.id);
  return xpSavedVisualId;
}

/** The two actions under a drawn chart. Both go through the app's existing
 *  paths: visual:save, then vizGallery's own add-to-analysis chooser. */
function xpBuildChartActions(): HTMLElement {
  const row = document.createElement('div');
  row.className = 'xp-chart-actions';

  const save = document.createElement('button');
  save.type = 'button';
  save.className = 'btn btn-sm';
  save.textContent = 'Save as visual';
  save.addEventListener('click', async () => {
    save.disabled = true;
    const id = await xpSaveVisual();
    if (id) {
      save.textContent = 'Saved';
      if (typeof showToast === 'function') showToast('Saved to Visuals');
    } else {
      save.disabled = false;
      if (typeof showToast === 'function') showToast('Could not save that visual');
    }
  });

  // An analysis is the app's mutable authoring surface; a dashboard is a
  // published, read-only snapshot of one. So "add it somewhere I can keep
  // working on it" means an analysis, and this reuses vizGallery's existing
  // chooser wholesale rather than growing a second one.
  const add = document.createElement('button');
  add.type = 'button';
  add.className = 'btn btn-sm';
  add.textContent = 'Add to analysis';
  add.addEventListener('click', async () => {
    add.disabled = true;
    const id = await xpSaveVisual();
    if (!id) {
      add.disabled = false;
      if (typeof showToast === 'function') showToast('Could not save that visual');
      return;
    }
    if (typeof handleAddVisualToAnalysis === 'function') await handleAddVisualToAnalysis(id);
    add.disabled = false;
  });

  row.append(save, add);
  return row;
}

/**
 * After a successful answer, offer ONE chart for the question just asked.
 *
 * Silent on every failure (no dataset in scope, no model, nothing suggested,
 * nothing drawable) — the text answer is the deliverable and this is an extra.
 */
async function xpMaybeRenderChart(question: string): Promise<void> {
  // Only with a dataset in scope: `visual:suggest` needs one, and a
  // whole-project question has no single table to chart.
  if (!currentProjectId || !xpDatasetId) return;

  const host = xpEl('xp-messages');
  if (!host) return;
  // Pin the chart to the turn that produced it before any await, so a fast
  // second question cannot land this chart under the wrong answer.
  const anchor = host.querySelector('.xp-msg:last-child');
  if (!anchor) return;

  let res: any = null;
  try {
    res = await window.hub.suggestVisual(currentProjectId, xpDatasetId, question);
  } catch (_) {
    return;
  }
  // notReady and every error are silent, per the contract above.
  if (!res || !res.ok || !Array.isArray(res.options) || !res.options.length) return;
  const option = res.options[0]; // one suggestion per turn, never a gallery
  if (!option || !option.encoding) return;

  // Every figure comes from here — never from the model reply.
  let dataRes: any = null;
  try {
    dataRes = await window.hub.computeVisualData(currentProjectId, xpDatasetId, option.encoding, []);
  } catch (_) {
    return;
  }
  if (!dataRes || dataRes.ok === false) return;
  const data = dataRes.data;
  if (!data || !Array.isArray(data.labels) || !data.labels.length) return;

  // Which type is actually drawn is CODE's decision, not the model's: if the
  // proposed type does not fit the data the app produced, the first eligible
  // one is used. Same eligibility check vizNew runs on its own suggestions.
  const eligible =
    typeof eligibleChartTypes === 'function'
      ? eligibleChartTypes(dataRes.recommendedShape, countNumericSeries(data), data.labels.length)
      : [];
  const type = eligible.indexOf(option.chartType) >= 0 ? option.chartType : (eligible[0] || 'table');

  // The anchor may have been replaced while we were awaiting (a second question
  // rebuilds the transcript from disk). Drop the chart rather than attach it to
  // a stale node.
  if (!anchor.isConnected) return;

  xpLastEncoding = option.encoding;
  xpLastChartType = type;
  xpLastQuestion = question;
  xpSavedVisualId = '';

  const wrap = document.createElement('div');
  wrap.className = 'xp-chart';
  const area = document.createElement('div');
  // cv-viz-area is what renderResult.ts sizes its canvas against.
  area.className = 'xp-chart-area cv-viz-area';
  wrap.appendChild(area);
  anchor.appendChild(wrap);

  // A null `entry` is what turns the ⋯ Customize menu off (renderResult.ts): an
  // unsaved suggestion owns no overrides, so it needs no override key either.
  renderVizInArea(area, data, type, null, 'xp', {
    projectId: currentProjectId,
    datasetId: xpDatasetId,
    encoding: option.encoding,
    filters: [],
  });

  wrap.appendChild(xpBuildChartActions());
  xpScrollToBottom();
}
