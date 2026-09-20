// Ask activity chips — the app SHOWING ITS WORK while an answer is prepared.
// Classic global-scope renderer <script>: NO import/export. Loads after
// askCore.js (reuses xpScrollToBottom) and dock.js; dkSend() passes an askId to
// copilotAsk and drives the region through the helpers below.
//
// WHAT THESE CHIPS ARE. This app has NO agent loop and NO model tool-calls: an
// ask computes app-side facts (buildFacts) and makes ONE narration call. So the
// chips are NOT "the model thought / ran SQL" — inventing that would be fiction
// this app refuses to ship. Each chip is one real operation main performed this
// turn (src/ipc/copilot.ts emits them over copilot:ask:activity), with an
// app-authored label and a count — never model output, never a data value.
//
// EPHEMERAL, never persisted. The region is live scaffolding for the CURRENT
// ask only: it collapses to a quiet summary above the answer, and a new ask (or
// a reload) clears it. copilot turns on disk keep only text + provenance, so a
// past turn shows its provenance chips — not a replayed activity stream.
//
// ONE renderer, ONE mount — 'dk-messages' (the dock); the Ask page's own list
// went with the page in #117. `containerId` is a required argument here, the
// same discipline as xpAppendBubble(containerId). textContent ONLY here; the
// labels are app strings, but that rule is absolute for anything rendered.

/** Live state for the one in-flight ask per container. Keyed by askId. */
interface XpActState {
  askId: string;
  containerId: string;
  region: HTMLElement;
  list: HTMLElement;
  steps: ActivityStep[];
}
const xpActs: Map<string, XpActState> = new Map();

// The ask id is generated ONCE per ask by xpNewAskId() (askCore.ts) and shared
// with the streaming channel — one spine, one id, so a chip stream and a token
// stream for the same ask carry the same scope and a stale ask's late events
// (either kind) are dropped together.

/** Drop every activity region in a container — the pending one AND any collapsed
 *  summary from a previous turn. Ephemeral: this just detaches DOM, nothing is
 *  persisted. Called when a new ask starts and when a thread is rebuilt. */
function xpActivityClearContainer(containerId: string): void {
  for (const [id, st] of xpActs) if (st.containerId === containerId) xpActs.delete(id);
  const host = document.getElementById(containerId);
  if (host) host.querySelectorAll('.xp-activity').forEach((n) => n.remove());
}

/** Drop one ask's region — the failure/stale path, so no orphan chips linger
 *  under a bubble that was rolled back. */
function xpActivityClear(askId: string): void {
  const st = xpActs.get(askId);
  if (!st) return;
  st.region.remove();
  xpActs.delete(askId);
}

/** Begin a region for a new ask, mounted at the bottom of the container — right
 *  under the pending "Thinking…" bubble. One per container: any prior region is
 *  cleared first. */
function xpActivityStart(askId: string, containerId: string): void {
  if (!askId) return;
  xpActivityClearContainer(containerId);
  const host = document.getElementById(containerId);
  if (!host) return;
  const region = document.createElement('div');
  region.className = 'xp-activity';
  region.dataset.askId = askId;
  const list = document.createElement('div');
  list.className = 'xp-activity-chips';
  region.appendChild(list);
  host.appendChild(region);
  xpActs.set(askId, { askId, containerId, region, list, steps: [] });
  if (typeof xpScrollToBottom === 'function') xpScrollToBottom(containerId);
}

/** One chip element per step. detail (a count-string, never a value) rides along
 *  after a middot. */
function xpActivityChip(step: ActivityStep): HTMLElement {
  const chip = document.createElement('span');
  chip.className = 'xp-activity-chip xp-activity-' + (step.kind || 'read');
  chip.textContent = step.detail ? step.label + ' · ' + step.detail : step.label;
  return chip;
}

/** A live step arrived. Ignore it if its ask is no longer active (superseded or
 *  already collapsed) — that is how a stale ask's late events are dropped. */
function xpActivityStep(askId: string, step: ActivityStep): void {
  const st = askId ? xpActs.get(askId) : undefined;
  if (!st || !step || typeof step.label !== 'string') return;
  st.steps.push(step);
  st.list.appendChild(xpActivityChip(step));
  if (typeof xpScrollToBottom === 'function') xpScrollToBottom(st.containerId);
}

/** The answer is in. Collapse the region to a quiet one-line summary sitting
 *  just above the final assistant bubble, expandable to the full chip list. A
 *  deliberate collapse, not a disappearance — the work stays inspectable. */
function xpActivityCollapse(askId: string): void {
  const st = askId ? xpActs.get(askId) : undefined;
  if (!st) return;
  const host = document.getElementById(st.containerId);
  if (!host) { xpActivityClear(askId); return; }

  // xpRenderTurns rebuilt the transcript from disk (removing every .xp-msg); the
  // region is not a .xp-msg so it survived, but it floated above the whole
  // transcript. Re-anchor it directly above the latest answer bubble.
  const bubbles = host.querySelectorAll('.xp-msg-assistant');
  const lastAnswer = bubbles.length ? bubbles[bubbles.length - 1] : null;
  if (lastAnswer) host.insertBefore(st.region, lastAnswer);

  st.region.classList.add('xp-activity-collapsed');
  st.list.hidden = true;

  // Summary from the REAL steps, model step excluded (the visible answer IS the
  // model's output, so naming it again is noise). Labels only — never a value.
  const summaryText = st.steps.filter((s) => s.kind !== 'model').map((s) => s.label).join(' · ');

  const bar = document.createElement('button');
  bar.type = 'button';
  bar.className = 'xp-activity-summary';
  bar.setAttribute('aria-expanded', 'false');
  const caret = document.createElement('span');
  caret.className = 'xp-activity-caret';
  caret.setAttribute('aria-hidden', 'true');
  setIcon(caret, 'chevron-right');
  const text = document.createElement('span');
  text.className = 'xp-activity-summary-text';
  text.textContent = summaryText || 'Prepared the answer';
  bar.append(caret, text);
  bar.addEventListener('click', () => {
    const show = st.list.hidden;
    st.list.hidden = !show;
    bar.setAttribute('aria-expanded', show ? 'true' : 'false');
    setIcon(caret, show ? 'chevron-down' : 'chevron-right');
  });
  st.region.insertBefore(bar, st.list);

  // Finished: keep the collapsed DOM, but forget the live state so a late stale
  // event cannot reopen or append to it. The next ask (or reload) removes it.
  xpActs.delete(askId);
}

/** Wire the single main→renderer activity subscription, once. Routing by askId
 *  means one listener feeds the dock regardless of which ask is in flight. */
function initAskActivity(): void {
  if (window.hub && typeof window.hub.onAskActivity === 'function') {
    window.hub.onAskActivity((o) => {
      if (o && typeof o.askId === 'string') xpActivityStep(o.askId, o.step);
    });
  }
}
