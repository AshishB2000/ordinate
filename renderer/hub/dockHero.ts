// The dock's starter chips, and the rule that hides them once a conversation has
// started. Classic global-scope renderer <script>: NO import/export. Loads after
// dock.js (dkRenderContext calls dkPaintHero with the context name) and after
// homeAsk.js (calls haSuggestPrompts).
//
// This file used to render a hero as well — a logo, a greeting and a sub line on
// a centred card. That was the wrong salvage from the retired Assistant page:
// what the dock wanted from it was the STAGE, the dotted lattice and accent
// washes covering the whole surface, and that is CSS on .dk-messages (hub.css),
// not markup. The chips are the only thing left that has to be built at runtime.
//
// TWO RULES IT KEEPS.
//
//  1. ONE CHIP GENERATOR. The prompt strings come from haSuggestPrompts()
//     (homeAsk.ts) — the same function Home's ask bar uses, including its
//     sample-project special cases. This file only renders the buttons and wires
//     them to the DOCK's composer. Nothing here writes a prompt.
//  2. NOTHING HERE IS A FIGURE. The chips are questions built from record NAMES;
//     the app does the math when one is actually asked.
//
// VISIBILITY IS OBSERVED, NOT CALLED. The strip shows only while #dk-messages
// holds no `.xp-msg`, and that changes from six places in dock.ts (send, load,
// new thread, switch thread, a failed ask's reload, and dockPropose clearing a
// card). Wiring six call sites is six chances to miss one, and a missed one
// leaves starter prompts hanging under a live transcript. A MutationObserver on
// the list cannot go out of sync with any of them, including ones added later.

/** The composer this file fills. Null before the panel is in the DOM. */
function dhInput(): HTMLTextAreaElement | null {
  return document.getElementById('dk-input') as HTMLTextAreaElement | null;
}

/** Whether the last prompt fetch produced anything. The strip stays hidden when
 *  it did not, so an empty project shows no strip rather than an empty gap. */
let dhHasPrompts = false;

/**
 * Show the chips only while the transcript is empty AND there are chips.
 *
 * Cheap enough to run on every mutation of the list: one querySelector against a
 * container that holds a handful of rows.
 */
function dkSyncHeroVisible(): void {
  const host = document.getElementById('dk-suggests');
  const list = document.getElementById('dk-messages');
  if (!host || !list) return;
  const busy = Boolean(list.querySelector('.xp-msg'));
  host.hidden = !dhHasPrompts || busy;
  // "Powered by <name>" belongs to the same empty stage. dock.ts fills its text
  // (and marks it ready); the rule for when it shows lives here, once.
  const powered = document.getElementById('dk-powered');
  if (powered) powered.hidden = busy || powered.dataset.ready !== '1';
}

/**
 * One line on the empty stage naming what is answering — the local app's own
 * display name, or the cloud provider's. Never a key, never a model id: the
 * point is "something is set up", not what it costs.
 *
 * `status` is a getKeyStatus() snapshot (dock.ts has one in hand); null paints
 * nothing. execActiveConnected is the SAME rule the header pill uses, so the
 * two can never name different things. The element is a sibling of #dk-hint —
 * xpRenderTurns only removes `.xp-msg`, so a rebuild from disk leaves it be —
 * and `data-ready` is what dkSyncHeroVisible reads, keeping the when in one
 * place with the chips' own rule.
 */
function dkPaintPoweredBy(status: any): void {
  const el = document.getElementById('dk-powered');
  if (!el) return;
  const active = status ? execActiveConnected(status) : null;
  el.textContent = active ? t('dockHero.powered_by', { label: active.label }) : '';
  el.dataset.ready = active ? '1' : '';
  dkSyncHeroVisible();
}

/** One starter chip. A click FILLS the composer and focuses it — never sends.
 *  A suggestion is a draft to edit, which is also how Home's chips behave. */
function dhMakeChip(prompt: string): HTMLElement {
  const chip = document.createElement('button');
  chip.type = 'button';
  chip.className = 'dk-suggest chip';
  chip.textContent = prompt;
  chip.title = prompt; // the panel is narrow; the chip ellipsises, the tooltip does not
  chip.addEventListener('click', () => {
    const input = dhInput();
    if (!input) return;
    input.value = prompt;
    input.focus();
  });
  return chip;
}

// The last (project, context) the chips were built for. dkRenderContext runs on
// every section switch and entity open — most of which change neither — and each
// rebuild is a listDatasets round-trip. Repaint only on a real change.
let dhChipKey: string | null = null;

async function dhRenderChips(pid: string, contextName: string): Promise<void> {
  const host = document.getElementById('dk-suggests');
  if (!host) return;
  const key = pid + ' ' + contextName;
  if (key === dhChipKey) return;
  dhChipKey = key;
  host.textContent = '';
  dhHasPrompts = false;
  host.hidden = true;
  if (!pid) return;
  let prompts: string[] = [];
  if (typeof haSuggestPrompts === 'function') {
    try { prompts = await haSuggestPrompts(pid, contextName); } catch (_) { prompts = []; }
  }
  // A late answer must not paint chips into a context the user has left.
  if (dhChipKey !== key || !prompts.length) return;
  prompts.forEach((p) => host.appendChild(dhMakeChip(p)));
  dhHasPrompts = true;
  dkSyncHeroVisible(); // …and not over a transcript that started while we awaited
}

/**
 * Rebuild the starter chips for the dock's CURRENT context.
 *
 * `contextName` is dkContextRef().name — the open dataset or dashboard, or '' for
 * the whole project — so a scoped dock leads with what you are looking at.
 * Called from dkRenderContext (dock.ts), the one function already invoked on
 * every section switch, entity open and project change.
 */
function dkPaintHero(contextName: string): void {
  void dhRenderChips(
    typeof currentProjectId === 'string' ? currentProjectId : '',
    (contextName || '').trim(),
  );
}

function initDockHero(): void {
  const list = document.getElementById('dk-messages');
  if (!list) return;
  new MutationObserver(dkSyncHeroVisible).observe(list, { childList: true });
  dkSyncHeroVisible();
}
