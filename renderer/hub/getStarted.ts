// First-run guidance on Home: the Get-started card and its header pill.
// Classic global-scope renderer <script>: no import/export.
//
// Four things to do, each with the door to it. What is DONE comes from main
// (src/app/onboarding.ts), which reads it off the records themselves — a
// dataset that is not the sample, a visual the seed did not make — so the card
// cannot claim a step the user has not taken, and nothing here needs a model.
//
// The card folds into a "2 of 4" pill beside the header's New button and
// comes back from it; it goes for good when every step is done or when it is
// dismissed.

interface GsStep { id: string; icon: string; title: string; line: string; action: string; run: () => void }

let gsSample: { projectId: string; datasetId: string; analysisId: string } | null = null;

/** Make sure the project the step acts in is the current one. */
async function gsInProject(projectId?: string): Promise<boolean> {
  if (projectId && projectId !== currentProjectId && typeof adoptProject === 'function') return adoptProject(projectId);
  if (!currentProjectId && typeof resolveProjectId === 'function') return !!(await resolveProjectId());
  return true;
}

const GS_STEPS: GsStep[] = [
  {
    id: 'import', icon: 'upload', title: 'Import your data',
    line: 'Bring in a CSV or Excel file, paste a table, or connect a database.',
    action: 'Import', run: () => { void cmdImport('file'); },
  },
  {
    id: 'visual', icon: 'chart-bar', title: 'Build a visual',
    line: 'Chart the sample orders by month, region or category in a few clicks.',
    action: 'Open the builder',
    run: () => {
      void (async () => {
        if (!(await gsInProject(gsSample ? gsSample.projectId : undefined))) return;
        selectSection('visuals');
        await openVisualBuilder(gsSample ? gsSample.datasetId : undefined);
      })();
    },
  },
  {
    id: 'dashboard', icon: 'layout-dashboard', title: 'Create a dashboard',
    line: 'Start from a template and have a laid-out sheet in one step.',
    action: 'Browse templates',
    run: () => {
      void (async () => {
        if (!(await gsInProject(gsSample ? gsSample.projectId : undefined))) return;
        selectSection('analyses');
        await anCreateWizard(gsSample ? gsSample.datasetId : undefined, gsSample ? { step: 2 } : undefined);
      })();
    },
  },
  {
    id: 'assistant', icon: 'sparkles', title: 'Set up the Assistant',
    line: 'Pick a model to ask about your data in plain words. Everything else works without one.',
    action: 'Set up', run: () => { void showSettingsPanel('exec'); },
  },
];

async function gsRender(): Promise<void> {
  const card = document.getElementById('home-getstarted');
  const pill = document.getElementById('home-gs-pill') as HTMLButtonElement | null;
  if (!card || !pill) return;
  let st: any = null;
  try { st = await window.hub.onboardingStatus(); } catch (_) { st = null; }
  gsSample = st && st.sample ? st.sample : null;
  if (!st || !st.show) {
    card.hidden = true;
    pill.hidden = true;
    return;
  }
  const doneIds = new Set((st.steps || []).filter((s: any) => s.done).map((s: any) => s.id));
  const progress = `${st.doneCount} of ${st.total}`;
  pill.hidden = !st.collapsed;
  const pillText = pill.querySelector('.gs-pill-text');
  if (pillText) pillText.textContent = progress;
  pill.setAttribute('aria-label', `Get started: ${progress} done — show the checklist`);
  card.hidden = !!st.collapsed;
  if (st.collapsed) return;

  card.textContent = '';
  const head = document.createElement('div');
  head.className = 'gs-head';
  const mark = document.createElement('span');
  mark.className = 'gs-mark';
  mark.appendChild(icon('sparkles', 18));
  const text = document.createElement('div');
  text.className = 'gs-head-text';
  const h = document.createElement('h2');
  h.className = 'gs-title';
  h.textContent = 'Get started';
  const sub = document.createElement('p');
  sub.className = 'gs-sub';
  sub.textContent = 'Four things to try — with the sample data, or with your own.';
  text.append(h, sub);
  const meter = document.createElement('div');
  meter.className = 'gs-meter';
  const count = document.createElement('span');
  count.className = 'gs-count tnum';
  count.textContent = progress;
  const bar = document.createElement('span');
  bar.className = 'gs-bar';
  const fill = document.createElement('span');
  fill.className = 'gs-bar-fill';
  fill.style.width = Math.round((st.doneCount / st.total) * 100) + '%';
  bar.appendChild(fill);
  meter.append(count, bar);
  const fold = document.createElement('button');
  fold.type = 'button';
  fold.className = 'gs-icon-btn gs-fold';
  iconOnly(fold, 'chevron-up', 'Fold the checklist into a progress pill');
  fold.addEventListener('click', () => void gsSet({ collapsed: true }));
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'gs-icon-btn gs-dismiss';
  iconOnly(close, 'x', 'Hide Get started');
  close.addEventListener('click', () => void gsDismiss());
  head.append(mark, text, meter, fold, close);
  card.appendChild(head);

  const list = document.createElement('ol');
  list.className = 'gs-items';
  for (const step of GS_STEPS) {
    const done = doneIds.has(step.id);
    const li = document.createElement('li');
    li.className = 'gs-item' + (done ? ' is-done' : '');
    li.dataset.step = step.id;
    const top = document.createElement('div');
    top.className = 'gs-item-top';
    const tile = document.createElement('span');
    tile.className = 'gs-tile';
    tile.appendChild(icon(step.icon));
    const tick = document.createElement('span');
    tick.className = 'gs-tick';
    tick.appendChild(icon(done ? 'circle-check' : 'circle', 18));
    tick.setAttribute('aria-label', done ? 'Done' : 'Not done yet');
    top.append(tile, tick);
    const body = document.createElement('div');
    body.className = 'gs-item-body';
    const t = document.createElement('h3');
    t.className = 'gs-item-title';
    t.textContent = step.title;
    const l = document.createElement('p');
    l.className = 'gs-item-line';
    l.textContent = step.line;
    body.append(t, l);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn-sm btn-ghost gs-action';
    btn.textContent = done ? 'Done' : step.action;
    btn.disabled = done;
    btn.addEventListener('click', step.run);
    if (done) iconLabel(btn, 'check', 'Done');
    li.append(top, body, btn);
    list.appendChild(li);
  }
  card.appendChild(list);
}

async function gsSet(patch: { collapsed?: boolean; dismissed?: boolean }): Promise<void> {
  await window.hub.onboardingSet(patch);
  await gsRender();
}

async function gsDismiss(): Promise<void> {
  await gsSet({ dismissed: true });
  showToast('Get started is hidden. Everything it pointed to is in the sidebar and ⌘K.');
}

function initGetStarted(): void {
  const pill = document.getElementById('home-gs-pill');
  if (pill) pill.addEventListener('click', () => void gsSet({ collapsed: false }));
}
