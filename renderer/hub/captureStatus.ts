'use strict';

// The capture page's two NON-RESULT states: the step list that runs while the
// model reads the screenshot, and the error card when it could not.
//
// Split out of hubCapture.ts under the 500-line smell line
// (.claude/rules/file-size.md). hubCapture.ts takes a capture, holds the
// session's entries and paints the page; this owns what the right-hand column
// shows when there is no result to show yet. Both drive static markup in
// index.html, so neither creates the elements it fills.
//
// Classic global-scope <script>: no import/export. Loads BEFORE hubCapture.js,
// which calls cvStartSteps/cvStopSteps/cvFinishSteps and capShowError.

/** The page's own element lookup, shared with hubCapture.ts. */
function capEl(id: string): HTMLElement | null {
  return document.getElementById(id);
}

// ── The "analyzing" step list ─────────────────────────────────────────────
const cvStepEls = Array.from(document.querySelectorAll('#cv-steps .cv-step'));

const CV_STEP_ICON: Record<string, string> = {
  done:    '<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><circle cx="7" cy="7" r="7" fill="var(--ok)"/><path d="M3.5 7.5L5.5 9.5L10.5 4.5" stroke="white" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  active:  '<div class="cv-step-dot cv-step-dot--active"></div>',
  pending: '<div class="cv-step-dot"></div>',
};

let cvStepTimer: any = null;
let cvActiveStep = 0;

function setCvStepStatus(el: Element, status: string): void {
  (el as HTMLElement).dataset.status = status;
  const icon = el.querySelector('.cv-step-icon');
  if (icon) icon.innerHTML = CV_STEP_ICON[status] || '';
}

function cvStartSteps(): void {
  clearInterval(cvStepTimer);
  cvActiveStep = 0;
  const box = capEl('cv-steps');
  if (box) box.hidden = false;
  cvStepEls.forEach((el, i) => setCvStepStatus(el, i === 0 ? 'active' : 'pending'));
  cvStepTimer = setInterval(() => {
    if (cvActiveStep < cvStepEls.length - 1) {
      setCvStepStatus(cvStepEls[cvActiveStep], 'done');
      cvActiveStep++;
      setCvStepStatus(cvStepEls[cvActiveStep], 'active');
    }
  }, 2500);
}

function cvStopSteps(): void {
  clearInterval(cvStepTimer);
  cvStepTimer = null;
  const box = capEl('cv-steps');
  if (box) box.hidden = true;
}

function cvFinishSteps(callback: () => void): void {
  clearInterval(cvStepTimer);
  cvStepTimer = null;
  function completeNext(): void {
    setCvStepStatus(cvStepEls[cvActiveStep], 'done');
    if (cvActiveStep < cvStepEls.length - 1) {
      cvActiveStep++;
      setCvStepStatus(cvStepEls[cvActiveStep], 'active');
      setTimeout(completeNext, 140);
    } else {
      setTimeout(() => { cvStopSteps(); callback(); }, 200);
    }
  }
  completeNext();
}

// ── The error card ────────────────────────────────────────────────────────
// Error type → large icon (28px, scaled by CSS) + title + warn tint flag.
const CVE_CONFIG: Record<string, { title: string; icon: string; warn: boolean }> = {
  network:    { title: 'No connection',          icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><line x1="1" y1="1" x2="23" y2="23"/><path d="M16.72 11.06A10.94 10.94 0 0 1 19 12.55"/><path d="M5 12.55a10.94 10.94 0 0 1 5.17-2.39"/><path d="M10.71 5.05A16 16 0 0 1 22.56 9"/><path d="M1.42 9a15.91 15.91 0 0 1 4.7-2.88"/><path d="M8.53 16.11a6 6 0 0 1 6.95 0"/><line x1="12" y1="20" x2="12.01" y2="20"/></svg>', warn: false },
  auth:       { title: 'Your API key was rejected', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="7.5" cy="15.5" r="4.5"/><path d="M21 2l-9.6 9.6"/><path d="M15.5 7.5l3 3L22 7l-3-3"/></svg>', warn: true  },
  rate_limit: { title: 'Rate limit reached',     icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>', warn: true  },
  provider:   { title: 'Provider error',         icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><line x1="1" y1="1" x2="23" y2="23"/><path d="M22.61 16.95A5 5 0 0 0 18 10h-1.26a8 8 0 0 0-7.05-6M5 5a8 8 0 0 0 4 15h9a5 5 0 0 0 1.7-.3"/></svg>', warn: false },
  bad_reply:  { title: 'Unreadable response',    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>', warn: false },
  truncated:  { title: 'Response cut off',       icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><line x1="20" y1="4" x2="8.12" y2="15.88"/><line x1="14.47" y1="14.48" x2="20" y2="20"/><line x1="8.12" y1="8.12" x2="12" y2="12"/></svg>', warn: true  },
  unknown:    { title: 'Something went wrong',   icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>', warn: false },
};

function capShowError(error: any): void {
  const panel = capEl('cap-error');
  if (panel) panel.hidden = false;
  const cfg = CVE_CONFIG[error.errorType] || CVE_CONFIG.unknown;
  const badge = capEl('cve-badge');
  if (badge) {
    badge.innerHTML = cfg.icon;
    badge.classList.toggle('cve-warn', cfg.warn);
  }
  const title = capEl('cve-title');
  if (title) title.textContent = cfg.title;
  const msg = capEl('cve-msg');
  if (msg) msg.textContent = error.message || 'Something went wrong. Try again.';
  const pill = capEl('cve-detail-pill');
  if (pill) {
    const text = capEl('cve-detail-text');
    if (error.detail && text) text.textContent = error.detail;
    pill.classList.toggle('cve-detail-pill-hidden', !error.detail);
  }
  const settings = capEl('cve-settings-btn') as HTMLButtonElement | null;
  if (settings) settings.hidden = (error.errorType !== 'auth');
}
