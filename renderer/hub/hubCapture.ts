'use strict';

// The capture PAGE: taking a capture, and rendering one inside the workspace.
//
// This used to be a shell of its own — a second sidebar with its own search and
// settings gear, its own empty state, its own conversation thread and its own
// follow-up box. All of that is gone. A capture is a project record now, so:
//
//   • the list lives under Data as a tab (captureList.ts),
//   • the page is a `.ws-panel` laid out like the dataset page (index.html),
//   • the narration is the first assistant turn of an ordinary dock
//     conversation, seeded in MAIN — there is no thread widget here, and no
//     follow-up box, because a follow-up about a capture is a dock ask.
//
// What is left is: fire a capture, hold the session's entries, paint the page,
// and the shared image lightbox the dataset list reuses for "view original".
// The page's two non-result states — the step list and the error card — are
// captureStatus.ts.
//
// Classic global-scope <script>: no import/export.

// ── Taking one ────────────────────────────────────────────────────────────
// The readiness gate (executionReady) lives in main.js — if not ready, main
// opens the Execution mode settings instead of capturing. Renderer sends intent.
function doCapture() {
  if (window.hub && typeof window.hub.takeScreenshot === 'function') {
    window.hub.takeScreenshot();
  }
}

// ── Session entries ───────────────────────────────────────────────────────
// Each entry: { id, dataUrl, cropPath, state, result, error, title, datasetId,
// copilotThreadId }. state: 'loading' | 'result' | 'error' | 'disk'.
// ponytail: analysis results are model-shaped JSON envelopes — any.
const entries: any[] = [];
let currentEntryId: any = null;

function getEntry(id: any): any {
  return entries.find((e) => e.id === id);
}

// The app's shared short-timestamp formatter — "2:14 PM" today, "Mar 4 · 2:14
// PM" otherwise. Named for the capture sidebar it was written for; that sidebar
// is gone and a dozen surfaces now call it, so the name is the only thing left
// of it. Renaming it is a rename across ten files, not a fix.
function formatSidebarTime(dateOrString: any): string {
  const d = typeof dateOrString === 'string' ? new Date(dateOrString) : (dateOrString || new Date());
  const now = new Date();
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === now.toDateString()) return time;
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' · ' + time;
}

// ── The image lightbox ────────────────────────────────────────────────────
// Shared: the capture page opens it on its own frame, and dsList.ts /
// dsExplorer.ts open it on a saved dataset's stored crop ("view original").
const imgLightbox = document.getElementById('img-lightbox');
const lightboxImg = document.getElementById('lightbox-img') as HTMLImageElement;
const lightboxClose = document.getElementById('lightbox-close');

// Focus management for the (static-markup) lightbox: move focus onto the close
// button on open, trap Tab, and return focus to whatever opened it on close.
let _lightboxA11y: { onTabKey: (e: KeyboardEvent) => void; release: () => void } | null = null;
function _lightboxKey(e: KeyboardEvent): void { if (_lightboxA11y) _lightboxA11y.onTabKey(e); }
function openLightboxSrc(src: string): void {
  if (!src || !imgLightbox || !lightboxImg) return;
  lightboxImg.src = src;
  imgLightbox.hidden = false;
  if (_lightboxA11y) return; // already open
  _lightboxA11y = makeModalAccessible(imgLightbox as HTMLElement, t('hubCapture.image_preview'), lightboxClose as HTMLElement | null);
  document.addEventListener('keydown', _lightboxKey, true);
}
function openLightbox(): void {
  const img = capEl('cap-view-img') as HTMLImageElement | null;
  if (img && img.src) openLightboxSrc(img.src);
}
function closeLightbox(): void {
  if (imgLightbox) imgLightbox.hidden = true;
  document.removeEventListener('keydown', _lightboxKey, true);
  if (_lightboxA11y) { _lightboxA11y.release(); _lightboxA11y = null; } // return focus to the opener
}

// The step list and the error card — the page's two non-result states — are
// captureStatus.ts, which loads first. It also owns capEl(), the element lookup
// both files use.

// ── The page ──────────────────────────────────────────────────────────────

/** Reset every region of the page, so no state leaks between two captures. */
function capResetPage(): void {
  cvStopSteps();
  const result = capEl('cap-result');
  if (result) result.innerHTML = '';
  const err = capEl('cap-error');
  if (err) err.hidden = true;
  const hint = capEl('cap-hint');
  if (hint) { hint.hidden = true; hint.textContent = ''; }
}

/**
 * Paint the header: title, "Dataset" badge, the image's size + time, and which
 * of the three actions are live.
 *
 * "New visual" needs a dataset, which is the honest gate — there is nothing to
 * chart before one exists — and "Save as dataset" needs a result that carries a
 * table, which is `captureHasExtractedTable` (captureDataset.ts). A capture that
 * yielded only a chart with no table stays an entry, exactly as the model says.
 */
function capPaintHeader(entry: any): void {
  const title = capEl('cap-title');
  if (title) {
    title.textContent = entry.state === 'loading'
      ? t('hubCapture.analyzing_your_capture')
      : (entry.title || (entry.state === 'error' ? t('hubCapture.analysis_failed') : t('common.capture')));
  }
  const badge = capEl('cap-badge');
  if (badge) badge.hidden = !entry.datasetId;

  const img = capEl('cap-view-img') as HTMLImageElement | null;
  const meta = capEl('cap-meta');
  const stamp = formatSidebarTime(entry.updatedAt || null);
  if (meta) {
    meta.textContent = img && img.naturalWidth
      ? `${img.naturalWidth} × ${img.naturalHeight} · ${stamp}`
      : stamp;
  }

  const saveBtn = capEl('cap-act-dataset') as HTMLButtonElement | null;
  const hasTable = typeof captureHasExtractedTable === 'function' && captureHasExtractedTable(entry);
  if (saveBtn) saveBtn.disabled = !hasTable;
  const vizBtn = capEl('cap-act-visual') as HTMLButtonElement | null;
  if (vizBtn) vizBtn.disabled = !entry.datasetId;
  const askBtn = capEl('cap-act-ask') as HTMLButtonElement | null;
  if (askBtn) askBtn.disabled = entry.state !== 'result';
}

/**
 * The table the model READ off the screenshot, as a table.
 *
 * This is the page's subject: it is what "Save as dataset" will save, so the
 * user has to be able to check it against the image beside it. It is NOT the
 * same thing as the charted figures below — those are the app's own analysis
 * of it.
 *
 * The rows come from `captureDraft` (captureDataset.ts), the SAME projection
 * the composer is handed on save — an extraction is object-keyed and ragged,
 * and projecting it a second time here would be a second answer to "what did
 * the model read". Quiet: opening a page is not the moment to be toasted about
 * ragged rows. Built with the Explore grid's own `.ds-table`/`.ds-th`/`.ds-td`,
 * and `textContent` only.
 */
async function capRenderExtracted(entry: any, host: HTMLElement): Promise<void> {
  if (typeof captureDraft !== 'function') return;
  const snapId = entry.id;
  const draft = await captureDraft(entry, { quiet: true });
  // A chart with no numbers under it is a real outcome; so is the user having
  // moved on while main was drafting.
  if (!draft || currentEntryId !== snapId) return;

  const box = document.createElement('section');
  box.className = 'cap-extracted';
  const head = document.createElement('h4');
  head.className = 'cap-sec-h';
  head.textContent = t('hubCapture.what_the_app_read');
  box.appendChild(head);
  const note = document.createElement('p');
  note.className = 'cap-sec-p';
  const r = draft.rows.length;
  const c = draft.columns.length;
  note.textContent = t('hubCapture.check_them_against_the_screenshot_before', { r, c });
  box.appendChild(note);

  const scroll = document.createElement('div');
  scroll.className = 'ds-table-scroll';
  const table = document.createElement('table');
  table.className = 'ds-table';
  const thead = document.createElement('thead');
  const htr = document.createElement('tr');
  draft.columns.forEach((col: any) => {
    const th = document.createElement('th');
    th.className = 'ds-th';
    th.textContent = String((col && col.name) ?? '');
    htr.appendChild(th);
  });
  thead.appendChild(htr);
  table.appendChild(thead);
  const tbody = document.createElement('tbody');
  draft.rows.forEach((row: any[]) => {
    const tr = document.createElement('tr');
    draft.columns.forEach((_: any, i: number) => {
      const td = document.createElement('td');
      td.className = 'ds-td';
      const v = Array.isArray(row) ? row[i] : undefined;
      td.textContent = v == null ? '' : String(v);
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  scroll.appendChild(table);
  box.appendChild(scroll);
  host.insertBefore(box, host.firstChild);
}

/**
 * Paint the right column for a finished capture: the extracted table, then the
 * app-computed figures.
 *
 * `renderTurnResult` (renderResult.ts) is the ONE renderer for an analysis
 * result and it already draws the second half — the chart chips, the computed
 * metrics. The only thing removed from it is the narration paragraph: that
 * prose is the dock conversation's first turn now, and printing it twice would
 * be the duplicate surface this change exists to delete.
 */
function capRenderResult(entry: any): void {
  const host = capEl('cap-result');
  if (!host || !entry.result) return;
  host.innerHTML = '';
  const node = renderTurnResult(entry.result, entry.activeVizType, entry, 'main');
  const prose = node.querySelector('.cv-analysis-text');
  if (prose) prose.remove();
  host.appendChild(node);
  // Async (main does the projection) and prepended when it lands, so the
  // figures paint immediately rather than waiting on a round trip.
  void capRenderExtracted(entry, host);
}

/** Open a capture as a page in the workspace. */
function openCapture(id: any): void {
  currentEntryId = id;
  const entry = getEntry(id);
  if (!entry) return;
  if (typeof selectSection === 'function') selectSection('capture');
  capResetPage();

  const img = capEl('cap-view-img') as HTMLImageElement | null;
  if (img) {
    img.src = entry.dataUrl || (entry.cropPath ? 'file://' + entry.cropPath : '');
    img.onload = () => capPaintHeader(entry);
  }
  capPaintHeader(entry);

  if (entry.state === 'loading') {
    cvStartSteps();
    return;
  }
  if (entry.state === 'result' && entry.result) {
    capRenderResult(entry);
    return;
  }
  if (entry.state === 'error' && entry.error) {
    capShowError(entry.error);
    return;
  }
  if (entry.state === 'disk') void capLoadFromDisk(entry);
}

/** A capture opened from the Captures tab: fetch its stored result. */
async function capLoadFromDisk(entry: any): Promise<void> {
  const snapId = entry.id;
  let thread: any = null;
  try {
    thread = await window.hub.loadThread(entry.id);
  } catch (_) { thread = null; }
  if (currentEntryId !== snapId) return;
  if (!thread) {
    capShowError({ errorType: 'unknown', message: t('hubCapture.could_not_load_this_capture') });
    return;
  }
  entry.state = 'result';
  entry.result = thread.result;
  entry.title = thread.title || t('common.capture');
  // The full record is the truth about both links — a Home "Recent" row
  // carries neither, so taking them from the summary alone would leave "Ask"
  // opening a blank conversation and "New visual" disabled on a capture that
  // does have a dataset.
  entry.datasetId = thread.datasetId || entry.datasetId || null;
  entry.copilotThreadId = thread.copilotThreadId || entry.copilotThreadId || null;
  entry.activeVizType = null;
  entry.chartOverrides = thread.chartOverrides || {};
  capPaintHeader(entry);
  capRenderResult(entry);
}

/**
 * Open (or adopt) a capture entry by id, whichever surface asked for it.
 *
 * captureList.ts hands over a summary row from disk; the capture may also
 * already be in this session's list, in which case its live result is kept.
 */
function openCaptureFromSummary(summary: any): void {
  const existing = getEntry(summary.id);
  if (existing) {
    // Disk knows about a dataset saved in a previous session; the live entry may not.
    if (summary.datasetId) existing.datasetId = summary.datasetId;
    if (summary.copilotThreadId) existing.copilotThreadId = summary.copilotThreadId;
    openCapture(summary.id);
    return;
  }
  entries.push({
    id: summary.id,
    dataUrl: null,
    cropPath: summary.cropPath || null,
    state: 'disk',
    result: null,
    error: null,
    title: summary.title || t('common.capture'),
    datasetId: summary.datasetId || null,
    copilotThreadId: summary.copilotThreadId || null,
    updatedAt: summary.updatedAt || null,
    activeVizType: null,
    chartOverrides: {},
  });
  openCapture(summary.id);
}

// Re-render the page's charts on theme change — the same repaint every other
// chart surface does.
new MutationObserver(() => {
  const entry = getEntry(currentEntryId);
  if (entry && entry.state === 'result') capRenderResult(entry);
}).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

// ── Results arriving from main ────────────────────────────────────────────

function showAnalyzeResult(entryId: any, result: any): void {
  const entry = getEntry(entryId);
  if (entry) {
    entry.state = result.ok ? 'result' : 'error';
    entry.updatedAt = new Date().toISOString();
    if (result.ok) {
      entry.result = result;
      entry.title = result.title || null;
      entry.copilotThreadId = result.copilotThreadId || null;
    } else {
      entry.error = result;
    }
  }
  if (typeof refreshCaptureList === 'function') void refreshCaptureList();
  if (entryId !== currentEntryId || !entry) return;

  if (result.ok) {
    const snapId = entryId;
    cvFinishSteps(() => {
      if (currentEntryId !== snapId) return;
      capPaintHeader(entry);
      capRenderResult(entry);
    });
  } else {
    cvStopSteps();
    capPaintHeader(entry);
    capShowError(result);
  }
}

if (window.hub && typeof window.hub.onNewEntry === 'function') {
  window.hub.onNewEntry(async ({ entryId, dataUrl }: any) => {
    entries.unshift({
      id: entryId, dataUrl, state: 'loading',
      result: null, error: null,
      title: null, datasetId: null, copilotThreadId: null,
      updatedAt: new Date().toISOString(),
      activeVizType: null, chartOverrides: {},
    });
    // A capture fired with no project open transparently uses/creates one
    // (workspace.ts). Guarded so a project-layer failure can never suppress the
    // captured result.
    try { await ensureWorkspaceForCapture(); } catch (_) { /* render regardless */ }
    openCapture(entryId);
  });
}

if (window.hub && typeof window.hub.onEntryResult === 'function') {
  window.hub.onEntryResult(({ entryId, ...result }: any) => {
    showAnalyzeResult(entryId, result);
    if (result && result.ok && notifPrefs.sound) playCompletionSound();
    // A recapture (replace/append) reopens the review flow pre-set to its
    // target; no-ops when nothing is pending (captureDataset.ts).
    if (typeof maybeResumeRecapture === 'function') maybeResumeRecapture(getEntry(entryId));
  });
}

// ── Wiring ────────────────────────────────────────────────────────────────

const capFrame = capEl('cap-frame');
if (capFrame) {
  capFrame.addEventListener('click', openLightbox);
  capFrame.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openLightbox(); }
  });
}

const capBack = capEl('cap-back');
if (capBack) {
  capBack.addEventListener('click', () => {
    if (typeof showCaptureList === 'function') showCaptureList();
  });
}

const capSettingsBtn = capEl('cve-settings-btn');
if (capSettingsBtn) capSettingsBtn.addEventListener('click', () => showSettingsPanel('exec'));

const capRetryBtn = capEl('cve-retry-btn');
if (capRetryBtn) {
  capRetryBtn.addEventListener('click', () => {
    const entry = getEntry(currentEntryId);
    if (!entry) return;
    entry.state = 'loading';
    entry.result = null;
    entry.error = null;
    entry.title = null;
    entry.activeVizType = null;
    capResetPage();
    capPaintHeader(entry);
    cvStartSteps();
    if (window.hub && window.hub.retry) window.hub.retry(currentEntryId);
  });
}

// The three header actions, in the order the dataset page puts them.
const capActDataset = capEl('cap-act-dataset');
if (capActDataset) {
  capActDataset.addEventListener('click', () => {
    const entry = getEntry(currentEntryId);
    if (entry && typeof openCaptureComposer === 'function') void openCaptureComposer(entry);
  });
}

const capActVisual = capEl('cap-act-visual');
if (capActVisual) {
  capActVisual.addEventListener('click', () => {
    const entry = getEntry(currentEntryId);
    // The dataset this capture produced is the visual's dataset — the same door
    // the dataset page's "New visual" opens (dsNewVisualFromDataset), with the
    // dataset already chosen. Switch section first: handleNewVisual ends in the
    // builder, which lives inside #ws-visuals.
    if (!entry || !entry.datasetId || typeof handleNewVisual !== 'function') return;
    if (typeof selectSection === 'function') selectSection('visuals');
    void handleNewVisual({ datasetId: String(entry.datasetId) });
  });
}

const capActAsk = capEl('cap-act-ask');
if (capActAsk) {
  capActAsk.addEventListener('click', () => {
    const entry = getEntry(currentEntryId);
    if (!entry) return;
    // The conversation main seeded with this capture's analysis, if there is
    // one; otherwise just the dock, scoped to the capture by dkContextRef().
    if (entry.copilotThreadId && typeof dkOpenThread === 'function') {
      if (typeof dkSetOpen === 'function') dkSetOpen(true);
      void dkOpenThread(String(entry.copilotThreadId));
      return;
    }
    if (typeof dkSetOpen === 'function') dkSetOpen(true);
  });
}
