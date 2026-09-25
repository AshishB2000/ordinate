// The sample dashboard's first-open tour: three coach marks, one sentence each,
// anchored to the filter bar, a chart tile's ⋯ and the Assistant button.
// Classic global-scope renderer <script>: no import/export.
//
// ONCE, EVER: main records the tour as seen the moment it starts
// (onboarding.ts `coachSeen`), so a reopen — or a crash mid-tour — never shows
// it again. It never blocks the page either: the card lets clicks through
// everywhere but its own two buttons, and a click anywhere else ends it, which
// is how someone who would rather explore says so without hunting for Skip.

interface CmStep { anchor: () => HTMLElement | null; text: () => string }

let cmCard: HTMLElement | null = null;
let cmSteps: CmStep[] = [];
let cmIdx = 0;
let cmAnchorEl: HTMLElement | null = null;

function cmVisible(el: Element | null): el is HTMLElement {
  if (!el) return false;
  const r = (el as HTMLElement).getBoundingClientRect();
  return r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < window.innerHeight;
}

const CM_STEPS: CmStep[] = [
  {
    // The filter bar when the sheet has one; otherwise the Filters panel's door,
    // which is where one is made.
    anchor: () => {
      const bar = document.getElementById('dash-control-bar');
      if (bar && !bar.hidden && cmVisible(bar)) return bar;
      const rail = document.querySelector('.an-rail-btn[data-pane="an-pane-filter"]');
      return cmVisible(rail) ? rail : null;
    },
    text: () => (document.getElementById('dash-control-bar') as HTMLElement | null)?.hidden === false
      ? 'Filter every tile at once from this bar — the whole sheet follows your pick.'
      : 'Filters live here: add a control and every tile on the sheet follows it.',
  },
  {
    anchor: () => {
      for (const card of document.querySelectorAll('#dash-grid .dash-card--visual')) {
        const btn = card.querySelector('.dash-card-ctrls button');
        if (cmVisible(btn)) return btn as HTMLElement;
      }
      return null;
    },
    text: () => 'The menu on each tile holds what you can do with it — open the visual, resize it, or take it off the sheet.',
  },
  {
    anchor: () => {
      const b = document.getElementById('side-ai-btn');
      return cmVisible(b) ? b : null;
    },
    text: () => 'Ask the Assistant about this dashboard in plain words. It works on whatever you are looking at.',
  },
];

function cmEnd(): void {
  if (cmCard) cmCard.remove();
  cmCard = null;
  if (cmAnchorEl) cmAnchorEl.classList.remove('cm-target');
  cmAnchorEl = null;
  cmSteps = [];
  document.removeEventListener('mousedown', cmOnOutside, true);
  window.removeEventListener('resize', cmPlace);
}

function cmOnOutside(e: MouseEvent): void {
  if (cmCard && (e.target as HTMLElement).closest('.cm-card button')) return;
  cmEnd();
}

/** Beside the anchor, on whichever side has room: below, above, then right. */
function cmPlace(): void {
  if (!cmCard || !cmAnchorEl) return;
  const a = cmAnchorEl.getBoundingClientRect();
  const w = cmCard.offsetWidth;
  const h = cmCard.offsetHeight;
  const gap = 10;
  let side: 'below' | 'above' | 'right' = 'below';
  if (a.bottom + gap + h > window.innerHeight - 8) side = a.top - gap - h > 8 ? 'above' : 'right';
  if (a.width < 80 && a.height > 24 && a.left < 120) side = 'right'; // a rail button: point sideways
  let left: number;
  let top: number;
  if (side === 'right') {
    left = a.right + gap;
    top = Math.min(Math.max(8, a.top + a.height / 2 - 24), window.innerHeight - h - 8);
  } else {
    left = Math.min(Math.max(8, a.left + a.width / 2 - 36), window.innerWidth - w - 8);
    top = side === 'below' ? a.bottom + gap : a.top - gap - h;
  }
  cmCard.dataset.side = side;
  cmCard.style.left = left + 'px';
  cmCard.style.top = top + 'px';
  // The arrow points at the anchor's centre, wherever the card had to slide to.
  if (side === 'right') cmCard.style.setProperty('--cm-arrow', Math.max(12, a.top + a.height / 2 - top) + 'px');
  else cmCard.style.setProperty('--cm-arrow', Math.min(w - 16, Math.max(12, a.left + a.width / 2 - left)) + 'px');
}

function cmShow(i: number): void {
  // Skip any step whose anchor is not on screen (a sheet with no chart tile).
  while (i < cmSteps.length && !cmSteps[i].anchor()) i++;
  if (i >= cmSteps.length) { cmEnd(); return; }
  cmIdx = i;
  if (cmAnchorEl) cmAnchorEl.classList.remove('cm-target');
  cmAnchorEl = cmSteps[i].anchor();
  if (cmAnchorEl) cmAnchorEl.classList.add('cm-target');
  if (!cmCard) {
    cmCard = document.createElement('div');
    cmCard.className = 'cm-card';
    cmCard.setAttribute('role', 'dialog');
    cmCard.setAttribute('aria-live', 'polite');
    document.body.appendChild(cmCard);
  }
  cmCard.textContent = '';
  const step = document.createElement('span');
  step.className = 'cm-step';
  step.textContent = `Tip ${i + 1} of ${cmSteps.length}`;
  const p = document.createElement('p');
  p.className = 'cm-text';
  p.textContent = cmSteps[i].text();
  cmCard.setAttribute('aria-label', p.textContent || 'Tip');
  const row = document.createElement('div');
  row.className = 'cm-actions';
  const last = i === cmSteps.length - 1;
  if (!last) {
    const skip = document.createElement('button');
    skip.type = 'button';
    skip.className = 'btn btn-sm btn-ghost cm-skip';
    skip.textContent = 'Skip';
    skip.addEventListener('click', () => cmEnd());
    row.appendChild(skip);
  }
  const next = document.createElement('button');
  next.type = 'button';
  next.className = 'btn btn-sm btn-primary cm-next';
  next.textContent = last ? 'Got it' : 'Next';
  next.addEventListener('click', () => { if (last) cmEnd(); else cmShow(cmIdx + 1); });
  row.appendChild(next);
  cmCard.append(step, p, row);
  cmPlace();
}

/**
 * Called when a dashboard opens (dashGrid.ts openAnalysisFrom). Starts the tour
 * if this is the SAMPLE dashboard and it has never been shown.
 */
async function cmMaybeStart(analysisId: string): Promise<void> {
  if (cmCard) return;
  let st: any = null;
  try { st = await window.hub.onboardingStatus(); } catch (_) { st = null; }
  if (!st || !st.coachPending || !st.sample || st.sample.analysisId !== analysisId) return;
  await window.hub.onboardingSet({ coachSeen: true }); // once, ever — before it shows
  // Wait for the tiles to draw, so the chart tile's ⋯ is there to point at.
  for (let t = 0; t < 30 && !document.querySelector('#dash-grid .dash-card--visual'); t++) {
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!dashCurrent || String(dashCurrent.id) !== analysisId) return; // left already
  cmSteps = CM_STEPS.slice();
  cmShow(0);
  setTimeout(() => {
    document.addEventListener('mousedown', cmOnOutside, true);
    window.addEventListener('resize', cmPlace);
  }, 0);
}
