// Home — the greeting header and the ask-bar hero. Classic global-scope renderer
// <script>: NO import/export. Loads before homeData.js (it owns the shared
// per-show orchestrator refreshHome() which calls into homeData) and both load
// before hub.js.
//
// This is the salvage of the retired Assistant page's greeting + suggestion-chip
// logic (explore.ts's xpGreetingText / xpRenderSuggests), adapted for Home:
//   - a time-of-day greeting into the header (name from the OS account),
//   - a subtitle naming the project and its dataset/dashboard counts,
//   - an ask bar whose submit opens the DOCK and sends the question (dkAsk),
//   - up to three suggestion chips built from REAL dataset names — a click FILLS
//     the ask bar, never auto-sends (a suggestion is a draft to edit).
//
// Nothing here computes a figure: the greeting name and the starter prompts are
// strings built from record NAMES, never from data. The app does the math when
// a question is actually asked.
//
// NAMING — `ha` is this surface's reserved prefix; DOM ids are `home-ask*` /
// `home-greet*`. The old page's `xp` prefix and `xp-` ids are gone with it.

// ── Project resolution (read-only, adopts) ──────────────────────────────────
// Home shows the session's active project, or — with none adopted yet — the
// most-recently-updated one, WITHOUT creating a project just to look at Home
// (create:false). resolveProjectId (projects.ts) adopts it as currentProjectId,
// which is what lets the ask bar, the data card and the live viz thumbnails
// (vizThumbs.ts reads the global currentProjectId) all speak to one project.
async function haEnsureHomeProject(): Promise<string> {
  if (currentProjectId) return currentProjectId;
  if (typeof resolveProjectId === 'function') {
    try { return await resolveProjectId({ create: false }); } catch (_) { return ''; }
  }
  return '';
}

// The one place Home resolves { id, name } from the project list. Both this file
// and homeData.ts read it; a project's name is not otherwise reachable in the
// renderer (adoptProject writes it only into #ws-project-name, which the current
// chrome does not render).
async function haHomeProject(): Promise<{ id: string; name: string }> {
  const id = await haEnsureHomeProject();
  if (!id) return { id: '', name: '' };
  let name = '';
  try {
    const list = await window.hub.listProjects();
    const p = Array.isArray(list) ? list.find((x: any) => String(x.id) === id) : null;
    name = p && p.name ? String(p.name) : '';
  } catch (_) { /* name stays empty — the subtitle just omits it */ }
  return { id, name };
}

// ── Greeting ────────────────────────────────────────────────────────────────
// The OS account name, fetched once (app:userName). null = not asked yet;
// '' = asked and unavailable, which pins the no-name fallback for the session.
let haUserName: string | null = null;

// Pure: pick the greeting line. Same time-of-day thresholds as the retired
// page's xpGreetingText (5/12/17/22); with no name there is nobody to greet, so
// "Welcome back" stands.
function haGreetingText(name: string, hour: number): string {
  if (!name) return 'Welcome back';
  if (hour >= 5 && hour < 12) return 'Good morning, ' + name;
  if (hour >= 12 && hour < 17) return 'Good afternoon, ' + name;
  if (hour >= 17 && hour < 22) return 'Good evening, ' + name;
  return 'Good to see you, ' + name; // late night — "Good night" reads as a goodbye
}

// Plural helper: "1 dataset" / "0 datasets".
function haPlural(n: number, word: string): string {
  return n + ' ' + word + (n === 1 ? '' : 's');
}

async function haPaintGreeting(proj: { id: string; name: string }): Promise<void> {
  const greet = document.getElementById('home-greet');
  const sub = document.getElementById('home-greet-sub');
  if (greet) {
    if (haUserName === null) {
      try {
        const res = window.hub && typeof window.hub.userName === 'function' ? await window.hub.userName() : '';
        haUserName = typeof res === 'string' ? res : '';
      } catch (_) { haUserName = ''; }
    }
    greet.textContent = haGreetingText(haUserName, new Date().getHours());
  }
  if (!sub) return;
  // "{project} · N datasets · M dashboards" — dataset:list and analysis:list
  // carry summaries only; "analysis" records ARE the user-facing dashboards.
  if (!proj.id) { sub.textContent = 'No project yet — bring some data in to begin.'; return; }
  let dsN = 0;
  let dbN = 0;
  try { const d = await window.hub.listDatasets(proj.id); dsN = Array.isArray(d) ? d.length : 0; } catch (_) { /* 0 */ }
  try { const a = await window.hub.listAnalyses(proj.id); dbN = Array.isArray(a) ? a.length : 0; } catch (_) { /* 0 */ }
  const parts = [proj.name || 'Workspace', haPlural(dsN, 'dataset'), haPlural(dbN, 'dashboard')];
  sub.textContent = parts.join('  ·  ');
}

// ── Starter suggestions ───────────────────────────────────────────────────────
// Up to three prompts from REAL dataset names (strings only, no model call, no
// figures). A click FILLS the ask bar and focuses it — never auto-sends.
//
// TWO SURFACES, ONE GENERATOR. The dock's empty state shows the same chips
// (dockHero.ts), so the prompt STRINGS are built by haSuggestPrompts() below and
// each surface renders its own button wired to its own input. A second generator
// would be two voices for one idea, and the sample-project special cases below
// would only ever be fixed in one of them.
const HA_SAMPLE_DATASET = 'Retail orders';
const HA_SAMPLE_PROMPTS = [
  'Which region had the worst month?',
  'Revenue by category this year',
];

/** The bundled sample, and nothing else the user has brought in yet. */
function haSampleOnly(names: string[]): boolean {
  return names.length === 1 && names[0] === HA_SAMPLE_DATASET;
}

/**
 * The prompt strings for a project — the ONE chip generator, shared with the
 * dock's empty state. Up to three, never a figure, never a model call.
 *
 * `preferred` is the dock's context: with the panel scoped to one dataset or
 * dashboard, that name leads the prompts instead of whatever happens to be the
 * project's first dataset. Home passes nothing and gets exactly what it did.
 */
async function haSuggestPrompts(pid: string, preferred?: string): Promise<string[]> {
  if (!pid) return [];
  let list: any[] = [];
  try { const res = await window.hub.listDatasets(pid); list = Array.isArray(res) ? res : []; } catch (_) { list = []; }
  let names = list.map((d) => String(d && d.name ? d.name : '').trim()).filter(Boolean);

  // The bundled sample gets questions written FOR it. "What stands out in Retail
  // orders?" is a fair generic prompt, but the sample exists to show what the app
  // can do, and it has a planted bad month for the first of these to find.
  // HA_SAMPLE_DATASET mirrors SAMPLE_DATASET_NAME in src/app/sampleProject.ts;
  // scripts/test-sampleProject.ts asserts the two spellings stay identical.
  if (haSampleOnly(names)) return HA_SAMPLE_PROMPTS.slice();

  if (!names.length) {
    // FIRST LAUNCH. The working project is the empty one seeded alongside the
    // sample (so the user's own imports never land inside it), which means this
    // project has no datasets and the bar would suggest nothing at all — a dead
    // ask bar on the one screen this whole feature exists to populate. The
    // sample lives in the OTHER project, and recentItems already flattens
    // datasets across every project, so one call finds it.
    let recent: any[] = [];
    try { const r = await window.hub.recentItems(); recent = Array.isArray(r) ? r : []; } catch (_) { recent = []; }
    const dsNames = recent.filter((r) => r && r.type === 'dataset').map((r) => String(r.name || '').trim());
    return haSampleOnly(dsNames) ? HA_SAMPLE_PROMPTS.slice() : [];
  }

  // A scoped dock leads with what the user is looking at. Deduped, so a preferred
  // name that IS the first dataset does not produce "How do X and X compare?".
  const lead = (preferred || '').trim();
  if (lead) names = [lead].concat(names.filter((n) => n !== lead));

  const prompts: string[] = ['What stands out in ' + names[0] + '?'];
  if (names.length > 1) prompts.push('How do ' + names[0] + ' and ' + names[1] + ' compare?');
  prompts.push('Summarise ' + names[0] + ' in plain terms');
  return prompts.slice(0, 3);
}

function haMakeSuggestChip(prompt: string): HTMLElement {
  const chip = document.createElement('button');
  chip.type = 'button';
  chip.className = 'home-ask-chip';
  chip.textContent = prompt;
  chip.addEventListener('click', () => {
    const input = document.getElementById('home-ask-input') as HTMLInputElement | null;
    if (!input) return;
    input.value = prompt;
    input.focus();
  });
  return chip;
}

async function haRenderSuggests(pid: string): Promise<void> {
  const host = document.getElementById('home-ask-suggests');
  if (!host) return;
  host.textContent = '';
  host.hidden = true;
  const prompts = await haSuggestPrompts(pid);
  if (!prompts.length) return;
  prompts.forEach((p) => host.appendChild(haMakeSuggestChip(p)));
  host.hidden = false;
}

// ── Ask ─────────────────────────────────────────────────────────────────────
// Submitting hands the question to the DOCK (dkAsk opens it and sends). We adopt
// a project first so the dock's send has a currentProjectId — the same reason
// openRecentItem adopts before opening an item.
async function haSubmitAsk(): Promise<void> {
  const input = document.getElementById('home-ask-input') as HTMLInputElement | null;
  if (!input) return;
  const q = input.value.trim();
  if (!q) return;
  await haEnsureHomeProject();
  input.value = '';
  if (typeof dkAsk === 'function') void dkAsk(q);
}

// ── Per-show refresh (the Home orchestrator) ──────────────────────────────────
// Called by selectSection('home') (workspace.ts). Resolves the project ONCE,
// then paints the greeting, the suggestions and — via homeData.ts — the data
// card and saved-visuals strip. One resolve, so the two halves never race to
// adopt a project.
async function refreshHome(): Promise<void> {
  const proj = await haHomeProject();
  await haPaintGreeting(proj);
  void haRenderSuggests(proj.id);
  if (typeof hdRender === 'function') void hdRender(proj.id);
}

// ── Boot wiring (once) ────────────────────────────────────────────────────────
function initHomeAsk(): void {
  const input = document.getElementById('home-ask-input') as HTMLInputElement | null;
  if (input) {
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); void haSubmitAsk(); }
    });
  }
  const send = document.getElementById('home-ask-send');
  if (send) send.addEventListener('click', () => void haSubmitAsk());
}
