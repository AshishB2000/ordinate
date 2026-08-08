'use strict';

// The capture surface, end to end: taking a capture, the sidebar history and its
// search, selecting an entry, the image lightbox, the step animation while the
// model works, the rendered result thread, the error card and the follow-up box.
//
// The two popover menus that sit ON a rendered result are hubResultMenus.ts;
// the shared number formatters they and everything else use (_fmtVal, fmtWith,
// histogramBins) stay in hub.ts.
//
// Split verbatim out of hub.ts — see .claude/rules/file-size.md. Classic
// global-scope <script>: no import/export.

// ── Capture ───────────────────────────────────────────────────────────────
// The readiness gate (executionReady) lives in main.js — if not ready, main
// opens the Execution mode settings instead of capturing. Renderer sends intent.
function doCapture() {
  if (window.hub && typeof window.hub.takeScreenshot === 'function') {
    window.hub.takeScreenshot();
  }
}

['take-shot-main', 'new-capture'].forEach(id => {
  const el = document.getElementById(id);
  if (el) el.addEventListener('click', doCapture);
});

// ── In-memory capture history ──────────────────────────────────────────────
// Each entry: { id, dataUrl, cropPath, state, result, error, title, turns, activeVizType, updatedAt }
// state: 'loading' | 'result' | 'error' | 'disk' (loaded from history, full data not yet fetched)
const entries = [];
let currentEntryId = null;
const captureHistoryEl = document.getElementById('capture-history');
const sideEmptyEl      = document.querySelector('.side-empty') as HTMLElement;

function getEntry(id) {
  return entries.find(e => e.id === id);
}

function formatSidebarTime(dateOrString) {
  const d = typeof dateOrString === 'string' ? new Date(dateOrString) : (dateOrString || new Date());
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' · ' +
    d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// Build a sidebar item. `entry` may have `dataUrl` (in-session) or `cropPath` (from disk).
// Appends to the list when `prepend` is false, otherwise inserts at top.
function renderSidebarItem(entry, prepend = true) {
  if (!captureHistoryEl) return;
  if (sideEmptyEl) sideEmptyEl.style.display = 'none';
  captureHistoryEl.style.display = 'flex';

  const item = document.createElement('div');
  item.className = 'cap-hist-item';
  item.dataset.entryId = String(entry.id);

  const thumb = document.createElement('img');
  thumb.className = 'cap-hist-thumb';
  if (entry.dataUrl) {
    thumb.src = entry.dataUrl;
  } else if (entry.cropPath) {
    thumb.src = 'file://' + entry.cropPath;
  }
  thumb.alt = '';
  thumb.draggable = false;

  const info = document.createElement('div');
  info.className = 'cap-hist-info';

  const summary = document.createElement('div');
  summary.className = 'cap-hist-summary';
  summary.id = 'hist-summary-' + entry.id;
  summary.textContent = entry.state === 'loading' ? 'Analyzing…'
    : (entry.title || (entry.state === 'error' ? 'Analysis failed' : 'Analysis'));

  const time = document.createElement('div');
  time.className = 'cap-hist-time';
  time.textContent = formatSidebarTime(entry.updatedAt || null);

  // Delete button (visible on hover via CSS)
  const delBtn = document.createElement('button');
  delBtn.className = 'cap-hist-del';
  delBtn.type = 'button';
  delBtn.setAttribute('aria-label', 'Delete');
  delBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4h6v2"/></svg>';
  delBtn.addEventListener('click', e => {
    e.stopPropagation();
    deleteEntry(entry.id);
  });

  info.appendChild(summary);
  info.appendChild(time);
  item.appendChild(thumb);
  item.appendChild(info);
  item.appendChild(delBtn);
  item.addEventListener('click', () => selectEntry(entry.id));

  if (prepend) {
    captureHistoryEl.insertBefore(item, captureHistoryEl.firstChild);
  } else {
    captureHistoryEl.appendChild(item);
  }
  filterSidebar();
}

// ── Sidebar search ─────────────────────────────────────────────────────────
const capSearchEl = document.getElementById('cap-search') as HTMLInputElement;

// Show only capture items whose title/summary contains the query (case-insensitive).
function filterSidebar() {
  if (!captureHistoryEl) return;
  const q = (capSearchEl ? capSearchEl.value : '').trim().toLowerCase();
  captureHistoryEl.querySelectorAll('.cap-hist-item').forEach(item => {
    const summary = item.querySelector('.cap-hist-summary');
    const text = (summary ? summary.textContent : '').toLowerCase();
    (item as HTMLElement).style.display = !q || text.includes(q) ? '' : 'none';
  });
}

if (capSearchEl) capSearchEl.addEventListener('input', filterSidebar);

function updateSidebarItem(entry) {
  const summaryEl = document.getElementById('hist-summary-' + entry.id);
  if (!summaryEl) return;
  if (entry.state === 'loading') {
    summaryEl.textContent = 'Analyzing…';
  } else if (entry.state === 'error') {
    summaryEl.textContent = 'Analysis failed';
  } else if (entry.state === 'result' || entry.state === 'disk') {
    summaryEl.textContent = entry.title || 'Analysis';
  }
  filterSidebar();
}

// Remove an entry from the sidebar and, if it's the current entry, show empty state.
function removeSidebarItem(id) {
  if (!captureHistoryEl) return;
  const item = captureHistoryEl.querySelector('[data-entry-id="' + String(id) + '"]');
  if (item) item.remove();
  if (captureHistoryEl.children.length === 0) {
    captureHistoryEl.style.display = 'none';
    if (sideEmptyEl) sideEmptyEl.style.display = '';
  }
}

// Wipe ALL entries from the in-memory list + sidebar and return to the empty
// state. Used after a "Delete capture history / everything" action.
function clearAllEntriesUI() {
  entries.length = 0;
  if (captureHistoryEl) { captureHistoryEl.innerHTML = ''; captureHistoryEl.style.display = 'none'; }
  if (sideEmptyEl) sideEmptyEl.style.display = '';
  showEmptyState();
}

// Delete a thread: confirm → IPC → remove from memory and sidebar.
function deleteEntry(id) {
  if (!window.confirm('Delete this capture and its analysis? This can\'t be undone.')) return;
  const idx = entries.findIndex(e => e.id === id);
  if (idx !== -1) entries.splice(idx, 1);
  removeSidebarItem(id);
  if (currentEntryId === id) showEmptyState();
  if (window.hub && typeof window.hub.deleteThread === 'function') {
    window.hub.deleteThread(id).catch(() => {});
  }
}

function selectEntry(id) {
  currentEntryId = id;
  const entry = getEntry(id);
  if (!entry) return;

  // Sidebar highlight
  if (captureHistoryEl) {
    captureHistoryEl.querySelectorAll('.cap-hist-item').forEach(el => {
      el.classList.toggle('cap-hist-item-active', (el as HTMLElement).dataset.entryId === String(id));
    });
  }

  // Image thumbnail — entry may have a dataUrl (in-session) or a cropPath (from disk)
  if (capViewImg) {
    const imgSrc = entry.dataUrl || (entry.cropPath ? 'file://' + entry.cropPath : '');
    capViewImg.src = imgSrc;
    capViewImg.onload = () => {
      if (cvThumbMeta) {
        const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        cvThumbMeta.textContent = `${capViewImg.naturalWidth} × ${capViewImg.naturalHeight} · ${time}`;
      }
    };
  }

  if (cvThread) cvThread.innerHTML = '';
  if (cvChipsEl) cvChipsEl.innerHTML = '';
  if (followupInp) followupInp.disabled = true;
  if (followupBtn) followupBtn.disabled = true;
  // Hidden by default; renderThread re-shows it only for a result entry that
  // carries a non-empty extracted table (Week 13 "Save as dataset").
  if (cvSaveDatasetBtn) cvSaveDatasetBtn.hidden = true;

  if (captureView) captureView.classList.remove('cap-view-hidden');

  if (entry.state === 'loading') {
    if (captureView) captureView.dataset.cvState = 'loading';
    if (mainTitleH) mainTitleH.textContent = 'Your capture';
    if (mainTitleSub) mainTitleSub.textContent = 'Analyzing…';
    cvStartSteps();
  } else if (entry.state === 'result' && entry.result) {
    cvStopSteps();
    if (captureView) captureView.dataset.cvState = 'result';
    if (mainTitleH) mainTitleH.textContent = entry.title || 'Analysis';
    if (mainTitleSub) mainTitleSub.textContent = 'Ready';
    renderThread(entry);
  } else if (entry.state === 'error' && entry.error) {
    cvStopSteps();
    if (captureView) captureView.dataset.cvState = 'error';
    if (mainTitleH) mainTitleH.textContent = 'Your capture';
    if (mainTitleSub) mainTitleSub.textContent = 'Analysis failed';
    _displayErrorContent(entry.error);
  } else if (entry.state === 'disk') {
    // Entry is in the sidebar but full data hasn't been loaded yet — fetch from disk.
    cvStopSteps();
    if (captureView) captureView.dataset.cvState = 'loading';
    if (mainTitleH) mainTitleH.textContent = entry.title || 'Analysis';
    if (mainTitleSub) mainTitleSub.textContent = 'Loading…';
    const snapId = id;
    if (window.hub && typeof window.hub.loadThread === 'function') {
      window.hub.loadThread(id).then(thread => {
        if (currentEntryId !== snapId || !thread) return;
        entry.state = 'result';
        entry.result = thread.result;
        entry.turns = (thread.turns || []).map(t => ({ ...t, activeVizType: null }));
        entry.title = thread.title || 'Analysis';
        entry.activeVizType = null;
        entry.chartOverrides = thread.chartOverrides || {};
        updateSidebarItem(entry);
        if (captureView) captureView.dataset.cvState = 'result';
        if (mainTitleH) mainTitleH.textContent = entry.title;
        if (mainTitleSub) mainTitleSub.textContent = 'Ready';
        renderThread(entry);
      }).catch(() => {
        if (currentEntryId !== snapId) return;
        if (captureView) captureView.dataset.cvState = 'error';
        if (mainTitleSub) mainTitleSub.textContent = 'Could not load';
      });
    }
  }
}

// ── Hub capture result ─────────────────────────────────────────────────────
const captureView   = document.getElementById('capture-view');
const capViewImg    = document.getElementById('cap-view-img') as HTMLImageElement;
const cvThumbMeta   = document.getElementById('cv-thumb-meta');
const cvThumbWrap   = document.getElementById('cv-thumb-wrap');
const imgLightbox   = document.getElementById('img-lightbox');
const lightboxImg   = document.getElementById('lightbox-img') as HTMLImageElement;
const lightboxClose = document.getElementById('lightbox-close');

// Focus management for the (static-markup) lightbox: move focus onto the close
// button on open, trap Tab, and return focus to whatever opened it on close.
let _lightboxA11y: { onTabKey: (e: KeyboardEvent) => void; release: () => void } | null = null;
function _lightboxKey(e: KeyboardEvent): void { if (_lightboxA11y) _lightboxA11y.onTabKey(e); }
function _openLightboxFocus(): void {
  if (_lightboxA11y) return; // already open
  _lightboxA11y = makeModalAccessible(imgLightbox as HTMLElement, 'Image preview', lightboxClose as HTMLElement | null);
  document.addEventListener('keydown', _lightboxKey, true);
}
function openLightbox() {
  if (!capViewImg || !capViewImg.src || !imgLightbox) return;
  lightboxImg.src = capViewImg.src;
  imgLightbox.hidden = false;
  _openLightboxFocus();
}
// Open the existing image lightbox for an ARBITRARY src (e.g. a dataset's stored
// capture crop) — captureDataset.js / datasets.js call this to "view original"
// without touching the current capture thumbnail. Reuses the same lightbox DOM.
function openLightboxSrc(src) {
  if (!src || !imgLightbox || !lightboxImg) return;
  lightboxImg.src = src;
  imgLightbox.hidden = false;
  _openLightboxFocus();
}
function closeLightbox() {
  if (imgLightbox) imgLightbox.hidden = true;
  document.removeEventListener('keydown', _lightboxKey, true);
  if (_lightboxA11y) { _lightboxA11y.release(); _lightboxA11y = null; } // return focus to the opener
}


const mainTitleH    = document.getElementById('main-title-h');
const mainTitleSub  = document.getElementById('main-title-sub');
const capViewNewBtn = document.getElementById('cap-view-new');
const cvSaveDatasetBtn = document.getElementById('cv-save-dataset');
const cvThread      = document.getElementById('cv-thread');
const cvChipsEl     = document.getElementById('cv-chips');
const cveBadge      = document.getElementById('cve-badge');
const cveTitle      = document.getElementById('cve-title');
const cveMsg        = document.getElementById('cve-msg');
const cveSettingsBtn  = document.getElementById('cve-settings-btn');
const cveRetryBtn     = document.getElementById('cve-retry-btn');
const cveDetailPill   = document.getElementById('cve-detail-pill');
const cveDetailText   = document.getElementById('cve-detail-text');
const followupInp   = document.getElementById('cv-followup-input') as HTMLInputElement;
const followupBtn   = document.getElementById('cv-followup-send') as HTMLButtonElement;


// Re-render all active charts on theme change.
new MutationObserver(() => {
  const entry = getEntry(currentEntryId);
  if (entry && entry.state === 'result') renderThread(entry);
}).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

// Returns the result from the last successful turn in the thread.
function getLastResult(entry) {
  if (!entry) return null;
  for (let i = (entry.turns || []).length - 1; i >= 0; i--) {
    if (entry.turns[i].state === 'result' && entry.turns[i].result) return entry.turns[i].result;
  }
  return entry.result;
}

// Render the full conversation thread for an entry into #cv-thread.
function renderThread(entry) {
  if (!cvThread || !entry || !entry.result) return;
  cvThread.innerHTML = '';

  // Week 13 — enable "Save as dataset" only when this result carries a usable
  // extracted table. captureHasExtractedTable is defined in captureDataset.js.
  if (cvSaveDatasetBtn) {
    const usable = typeof captureHasExtractedTable === 'function' && captureHasExtractedTable(entry);
    cvSaveDatasetBtn.hidden = !usable;
  }

  const label = document.createElement('div');
  label.className = 'cv-section-label';
  label.textContent = 'Analysis';
  cvThread.appendChild(label);

  cvThread.appendChild(renderTurnResult(entry.result, entry.activeVizType, entry, 'main'));

  (entry.turns || []).forEach((turn, ti) => {
    const qEl = document.createElement('div');
    qEl.className = 'cv-turn-question';
    qEl.textContent = turn.text;
    cvThread.appendChild(qEl);

    if (turn.state === 'loading') {
      const loadEl = document.createElement('div');
      loadEl.className = 'cv-turn-loading';
      loadEl.innerHTML = '<span class="cv-turn-spinner"></span><span>Thinking…</span>';
      cvThread.appendChild(loadEl);
    } else if (turn.state === 'result' && turn.result) {
      cvThread.appendChild(renderTurnResult(turn.result, turn.activeVizType, entry, ti));
    } else if (turn.state === 'error') {
      const errEl = document.createElement('div');
      errEl.className = 'cv-turn-error';
      errEl.textContent = (turn.error && turn.error.message) || 'Something went wrong. Try again.';
      cvThread.appendChild(errEl);
    }
  });

  const lastResult = getLastResult(entry);
  buildCvChips(lastResult ? lastResult.followups : []);

  const hasPending = (entry.turns || []).some(t => t.state === 'loading');
  if (followupInp) followupInp.disabled = hasPending;
  if (followupBtn) followupBtn.disabled = hasPending;
}

function buildCvChips(followups) {
  if (!cvChipsEl) return;
  cvChipsEl.innerHTML = '';
  (followups || []).forEach(q => {
    const btn = document.createElement('button');
    btn.className = 'cv-chip';
    btn.type = 'button';
    btn.textContent = q;
    btn.addEventListener('click', () => {
      if (followupInp) followupInp.value = q;
      sendFollowup();
    });
    cvChipsEl.appendChild(btn);
  });
}

// Error type → large icon (28px, scaled by CSS) + title + warn tint flag
const CVE_CONFIG = {
  network:    { title: 'No connection',          icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><line x1="1" y1="1" x2="23" y2="23"/><path d="M16.72 11.06A10.94 10.94 0 0 1 19 12.55"/><path d="M5 12.55a10.94 10.94 0 0 1 5.17-2.39"/><path d="M10.71 5.05A16 16 0 0 1 22.56 9"/><path d="M1.42 9a15.91 15.91 0 0 1 4.7-2.88"/><path d="M8.53 16.11a6 6 0 0 1 6.95 0"/><line x1="12" y1="20" x2="12.01" y2="20"/></svg>', warn: false },
  auth:       { title: 'Your API key was rejected', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="7.5" cy="15.5" r="4.5"/><path d="M21 2l-9.6 9.6"/><path d="M15.5 7.5l3 3L22 7l-3-3"/></svg>', warn: true  },
  rate_limit: { title: 'Rate limit reached',     icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>', warn: true  },
  provider:   { title: 'Provider error',         icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><line x1="1" y1="1" x2="23" y2="23"/><path d="M22.61 16.95A5 5 0 0 0 18 10h-1.26a8 8 0 0 0-7.05-6M5 5a8 8 0 0 0 4 15h9a5 5 0 0 0 1.7-.3"/></svg>', warn: false },
  bad_reply:  { title: 'Unreadable response',    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>', warn: false },
  truncated:  { title: 'Response cut off',       icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><line x1="20" y1="4" x2="8.12" y2="15.88"/><line x1="14.47" y1="14.48" x2="20" y2="20"/><line x1="8.12" y1="8.12" x2="12" y2="12"/></svg>', warn: true  },
  unknown:    { title: 'Something went wrong',   icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>', warn: false },
};

// ── Step animation ────────────────────────────────────────────────────────────
const cvStepEls = Array.from(document.querySelectorAll('#cv-steps .cv-step'));

const CV_STEP_ICON = {
  done:    '<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><circle cx="7" cy="7" r="7" fill="var(--ok)"/><path d="M3.5 7.5L5.5 9.5L10.5 4.5" stroke="white" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  active:  '<div class="cv-step-spinner"></div>',
  pending: '<div class="cv-step-dot"></div>',
};

let cvStepTimer  = null;
let cvActiveStep = 0;

function setCvStepStatus(el, status) {
  el.dataset.status = status;
  const icon = el.querySelector('.cv-step-icon');
  if (icon) icon.innerHTML = CV_STEP_ICON[status] || '';
}

function cvStartSteps() {
  clearInterval(cvStepTimer);
  cvActiveStep = 0;
  cvStepEls.forEach((el, i) => setCvStepStatus(el, i === 0 ? 'active' : 'pending'));
  cvStepTimer = setInterval(() => {
    if (cvActiveStep < cvStepEls.length - 1) {
      setCvStepStatus(cvStepEls[cvActiveStep], 'done');
      cvActiveStep++;
      setCvStepStatus(cvStepEls[cvActiveStep], 'active');
    }
  }, 2500);
}

function cvStopSteps() {
  clearInterval(cvStepTimer);
  cvStepTimer = null;
}

function cvFinishSteps(callback: () => void) {
  clearInterval(cvStepTimer);
  cvStepTimer = null;
  function completeNext() {
    setCvStepStatus(cvStepEls[cvActiveStep], 'done');
    if (cvActiveStep < cvStepEls.length - 1) {
      cvActiveStep++;
      setCvStepStatus(cvStepEls[cvActiveStep], 'active');
      setTimeout(completeNext, 140);
    } else {
      setTimeout(callback, 200);
    }
  }
  completeNext();
}


function _displayErrorContent(error) {
  const cfg = CVE_CONFIG[error.errorType] || CVE_CONFIG.unknown;
  if (cveBadge) {
    cveBadge.innerHTML = cfg.icon;
    cveBadge.classList.toggle('cve-warn', cfg.warn);
  }
  if (cveTitle) cveTitle.textContent = cfg.title;
  if (cveMsg)   cveMsg.textContent   = error.message || 'Something went wrong. Try again.';
  if (cveDetailPill) {
    if (error.detail) {
      if (cveDetailText) cveDetailText.textContent = error.detail;
      cveDetailPill.classList.remove('cve-detail-pill-hidden');
    } else {
      cveDetailPill.classList.add('cve-detail-pill-hidden');
    }
  }
  if (cveSettingsBtn) cveSettingsBtn.hidden = (error.errorType !== 'auth');
}

function showEmptyState() {
  cvStopSteps();
  currentEntryId = null;
  if (captureView) captureView.classList.add('cap-view-hidden');
  if (mainTitleH) mainTitleH.textContent = 'Welcome';
  if (mainTitleSub) mainTitleSub.textContent = 'Capture any data';
  if (captureHistoryEl) {
    captureHistoryEl.querySelectorAll('.cap-hist-item').forEach(el => el.classList.remove('cap-hist-item-active'));
  }
}

function showAnalyzeResult(entryId, result) {
  if (!captureView) return;
  const entry = getEntry(entryId);
  if (entry) {
    entry.state = result.ok ? 'result' : 'error';
    if (result.ok) {
      entry.result = result;
      entry.title = result.title || null;
    } else {
      entry.error = result;
    }
    updateSidebarItem(entry);
  }
  if (entryId !== currentEntryId) return;

  if (result.ok) {
    const snapId = entryId;
    cvFinishSteps(() => {
      if (currentEntryId !== snapId) return;
      captureView.dataset.cvState = 'result';
      if (mainTitleH) mainTitleH.textContent = entry ? (entry.title || 'Analysis') : 'Analysis';
      if (mainTitleSub) mainTitleSub.textContent = 'Ready';
      renderThread(entry);
    });
  } else {
    cvStopSteps();
    captureView.dataset.cvState = 'error';
    _displayErrorContent(result);
    if (mainTitleSub) mainTitleSub.textContent = 'Analysis failed';
  }
}

if (cveSettingsBtn) cveSettingsBtn.addEventListener('click', () => showSettingsPanel('exec'));
if (cveRetryBtn) cveRetryBtn.addEventListener('click', () => {
  if (!currentEntryId) return;
  const entry = getEntry(currentEntryId);
  if (!entry) return;
  entry.state = 'loading';
  entry.result = null;
  entry.error = null;
  entry.title = null;
  entry.turns = [];
  entry.activeVizType = null;
  updateSidebarItem(entry);
  if (captureView) captureView.dataset.cvState = 'loading';
  if (mainTitleH) mainTitleH.textContent = 'Your capture';
  if (mainTitleSub) mainTitleSub.textContent = 'Analyzing…';
  if (cvThread) cvThread.innerHTML = '';
  if (cvChipsEl) cvChipsEl.innerHTML = '';
  cvStartSteps();
  if (window.hub && window.hub.retry) window.hub.retry(currentEntryId);
});
if (capViewNewBtn)  capViewNewBtn.addEventListener('click', showEmptyState);
// Week 13 — open the review-and-correct grid for the current capture.
// openCaptureDatasetModal is defined in captureDataset.js (shared global scope).
if (cvSaveDatasetBtn) {
  cvSaveDatasetBtn.addEventListener('click', () => {
    const entry = getEntry(currentEntryId);
    if (entry && typeof openCaptureDatasetModal === 'function') openCaptureDatasetModal(entry);
  });
}

if (window.hub && typeof window.hub.onNewEntry === 'function') {
  window.hub.onNewEntry(async ({ entryId, dataUrl }) => {
    const entry = {
      id: entryId, dataUrl, state: 'loading',
      result: null, error: null,
      title: null, turns: [], activeVizType: null,
      chartOverrides: {},
    };
    entries.unshift(entry);
    // Quick-capture with no open project transparently uses/creates a default
    // project and shows the Sources surface (workspace.ts). Non-regressing: the
    // result surface renders exactly as before. Guarded so a project-layer
    // failure can never suppress the captured result (ensureWorkspaceForCapture
    // is already defensive; this is belt-and-suspenders).
    try { await ensureWorkspaceForCapture(); } catch (_) { /* render regardless */ }
    renderSidebarItem(entry);
    selectEntry(entryId);
  });
}

if (window.hub && typeof window.hub.onEntryResult === 'function') {
  window.hub.onEntryResult(({ entryId, ...result }) => {
    showAnalyzeResult(entryId, result);
    if (result && result.ok && notifPrefs.sound) playCompletionSound();
    // Week 13 — if a recapture (replace/append) is pending, auto-open the review
    // modal pre-set to that target. maybeResumeRecapture is defined in
    // captureDataset.js and no-ops when nothing is pending.
    if (typeof maybeResumeRecapture === 'function') maybeResumeRecapture(getEntry(entryId));
  });
}

// Populate sidebar with persisted threads from disk (sent by main on hub open).
// Historical entries are added after any in-session entries (session entries are prepended).
if (window.hub && typeof window.hub.onHistory === 'function') {
  window.hub.onHistory(summaries => {
    if (!Array.isArray(summaries)) return;
    if (summaries.length === 0) { clearAllEntriesUI(); return; } // e.g. after "delete history"
    summaries.forEach(summary => {
      // Don't duplicate an entry that was already captured in this session
      if (getEntry(summary.id)) return;
      const entry = {
        id: summary.id,
        dataUrl: null,
        cropPath: summary.cropPath || null,
        state: 'disk',
        result: null,
        error: null,
        title: summary.title || 'Analysis',
        turns: [],
        activeVizType: null,
        updatedAt: summary.updatedAt || null,
        chartOverrides: {},
      };
      entries.push(entry);
      // Append (not prepend) — session entries sit above history entries
      renderSidebarItem(entry, false);
      updateSidebarItem(entry);
    });
  });
}

function sendFollowup() {
  if (!currentEntryId) return;
  const text = (followupInp ? followupInp.value : '').trim();
  if (!text) return;
  const entry = getEntry(currentEntryId);
  if (!entry || entry.state !== 'result') return;

  const turn = { text, state: 'loading', result: null, error: null, activeVizType: null };
  entry.turns.push(turn);
  if (followupInp) followupInp.value = '';
  renderThread(entry);

  if (window.hub && typeof window.hub.followup === 'function') {
    window.hub.followup(currentEntryId, text);
  }
}

function showFollowupResult(entryId, result) {
  const entry = getEntry(entryId);
  if (!entry) return;

  const turn = entry.turns.find(t => t.state === 'loading');
  if (!turn) return;

  if (result.ok) {
    turn.state = 'result';
    turn.result = result;
    turn.activeVizType = null;
  } else {
    turn.state = 'error';
    turn.error = result;
  }

  if (entryId === currentEntryId) renderThread(entry);
}

if (window.hub && typeof window.hub.onFollowupResult === 'function') {
  window.hub.onFollowupResult(({ entryId, ...result }) => {
    showFollowupResult(entryId, result);
    if (result && result.ok && notifPrefs.sound) playCompletionSound();
  });
}

if (followupBtn) followupBtn.addEventListener('click', sendFollowup);
if (followupInp) {
  followupInp.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendFollowup(); }
  });
}

