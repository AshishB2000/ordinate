'use strict';

// Tabs — the NAVIGATION half: which tab set is live, keeping it in step with
// the screen, and driving the record pages when a tab is clicked, closed or
// cycled. The pure bookkeeping is tabModel.ts; the kinds are tabKinds.ts; the
// strip is tabStrip.ts; side-by-side is tabSplit.ts.
//
// THE SCREEN IS THE TRUTH. Records are opened from everywhere — list rows,
// Home's Recent, the palette, search, "New visual from this dataset" — and
// wrapping every one of those openers would be a second copy of each. Instead
// dkSync() (dock.ts), which every opener, closer and section switch already
// calls, calls tabsSync(), and the sync asks the kinds what is on screen: a
// record showing gets its tab (added if new) and is lit; a list showing lights
// nothing. The tabs never assume what an opener did — they look.
//
// While the tabs THEMSELVES are driving an opener (`tabBusy`), the sync waits
// and runs once at the end, so the half-way states in between (the list
// flashing past on the way to the next record) never reach the strip.
//
// PERSISTENCE. The primary window saves its tab set per project in
// localStorage (`ordTabs:<projectId>`) on every change and restores it when
// that project is adopted — dropping records that are gone, silently. The
// first restore of a launch also reopens the active tab (and a saved split),
// but only if the user is still on Home: a restore never yanks someone off a
// page they already chose. A SECONDARY window (a tab's "Open in new window")
// starts on its one record and saves nothing — both windows share this
// origin's localStorage, and two windows writing one key would each silently
// overwrite the other's tabs.
//
// Classic global-scope renderer <script>: NO import/export.

const TAB_STORE = 'ordTabs:';
const TAB_QUERY = new URLSearchParams(location.search);
const TAB_SECONDARY = TAB_QUERY.get('secondary') === '1';

let tabState: TabState = tabEmpty();
let tabProject: string | null = null; // whose tab set tabState is
let tabBusy = 0;
let tabBooted = false; // the launch restore has had its one chance
let tabLoadSeq = 0;
let tabLoading = false; // a project's saved set is being checked; the sync waits for it
let tabSyncQueued = false;
let tabLeavingDash = false; // the focus-mode guard's Back is in flight
let tabQueue: Promise<void> = Promise.resolve();

function tabFind(key: string | null): TabRec | null {
  const i = tabIndexOf(tabState, key);
  return i >= 0 ? tabState.tabs[i] : null;
}

function tabKindOf(t: TabRec | null): TabKind | null {
  return (t && TAB_KINDS[t.kind]) || null;
}

/** Whether two records can share the screen: different pages. */
function tabFits(a: TabRec, b: TabRec): boolean {
  const ka = tabKindOf(a);
  const kb = tabKindOf(b);
  return !!ka && !!kb && ka.section !== kb.section;
}

/** Is this tab's record the one its page has open right now? */
function tabIsOpen(t: TabRec | null): boolean {
  const k = tabKindOf(t);
  const cur = k ? k.current() : null;
  return !!cur && !!t && cur.id === t.id;
}

/** The ONE writer: replace the state, save it, repaint. */
function tabSet(next: TabState, save = true): void {
  tabState = next;
  if (save) tabPersist();
  tabRender();
  tabApplySplit();
}

function tabPersist(): void {
  if (TAB_SECONDARY || !tabProject) return;
  try { localStorage.setItem(TAB_STORE + tabProject, tabSerialize(tabState)); } catch (_) { /* private mode / quota */ }
}

/** Serialise every tab-driven navigation, so two quick clicks cannot interleave their openers. */
function tabRun(fn: () => Promise<void>): Promise<void> {
  tabQueue = tabQueue.then(fn).catch((e) => console.warn('[tabs]', e));
  return tabQueue;
}

/** Drive a page while the sync waits; the sync runs once, after. */
async function tabDrive(fn: () => Promise<void>): Promise<void> {
  tabBusy++;
  try { await fn(); } finally { tabBusy--; }
  tabSyncNow();
}

// ── Following the screen ─────────────────────────────────────────────────────

/** The record on screen in the current section, if there is one. */
function tabVisible(): TabRec | null {
  for (const kind of Object.keys(TAB_KINDS)) {
    const k = TAB_KINDS[kind];
    if (k.section !== currentSection) continue;
    const cur = k.current();
    if (cur && cur.id) return { kind, id: cur.id, name: cur.name };
  }
  return null;
}

/** dock.ts's dkSync() calls this on every open, close and section switch. One pass per task. */
function tabsSync(): void {
  if (tabSyncQueued) return;
  tabSyncQueued = true;
  queueMicrotask(() => { tabSyncQueued = false; tabSyncNow(); });
}

function tabSyncNow(): void {
  if (currentProjectId !== tabProject) { void tabLoadProject(currentProjectId); return; }
  if (tabBusy || tabLoading || !tabProject) return;
  let s = tabState;
  const vis = tabVisible();
  if (s.split) {
    // The pane whose page is the section on screen, if either is.
    const pane = [s.split.left, s.split.right].find((k) => {
      const kd = tabKindOf(tabFind(k));
      return !!kd && kd.section === currentSection;
    });
    if (!pane || !vis) s = tabActivate(s, null); // left both panes, or a pane went back to its list
    else s = tabActivate(s, pane);
  }
  s = vis ? tabOpen(s, vis) : tabActivate(s, null);
  if (tabSerialize(s) !== tabSerialize(tabState)) tabSet(s);
  else tabApplySplit();
  // Focus mode belongs to an OPEN DASHBOARD ON SCREEN. Leaving its section any
  // other way than "‹ Back" (the palette, a tab of another kind, unsplitting)
  // used to strand body.an-focus — no sidebar, on a page that is not the
  // dashboard. Close it the way Back does, which also saves it.
  if (!s.split && !tabLeavingDash && currentSection !== 'analyses' && dashCurrent
    && document.body.classList.contains('an-focus')) {
    tabLeavingDash = true;
    void handleBackToList().finally(() => { tabLeavingDash = false; });
  }
}

// ── Restore ──────────────────────────────────────────────────────────────────

async function tabLoadProject(pid: string | null): Promise<void> {
  const seq = ++tabLoadSeq;
  tabProject = pid;
  tabLoading = false;
  tabSet(tabEmpty(), false);
  if (!pid || TAB_SECONDARY) { tabSyncNow(); return; }
  tabLoading = true;
  let raw: string | null = null;
  try { raw = localStorage.getItem(TAB_STORE + pid); } catch (_) { raw = null; }
  const saved = tabRestore(raw, () => true);
  const section = currentSection;
  const names = await Promise.all(saved.tabs.map((t) => {
    const k = tabKindOf(t);
    return k ? k.resolve(pid, t.id) : Promise.resolve(null);
  }));
  if (seq !== tabLoadSeq) return; // another project was adopted meanwhile
  tabLoading = false;
  const alive = new Map<string, string>();
  saved.tabs.forEach((t, i) => { if (names[i] !== null) alive.set(tabKeyOf(t), names[i] || t.name); });
  const restored = tabRestore(raw, (k) => alive.has(k));
  restored.tabs = restored.tabs.map((t) => ({ ...t, name: alive.get(tabKeyOf(t)) || t.name }));
  const launch = !tabBooted;
  tabBooted = true;
  // Nothing is on screen yet; the sync below lights whatever is.
  tabSet({ ...restored, active: null, split: null });
  if (launch && restored.active && section === 'home' && currentSection === 'home') {
    await tabRun(() => tabDrive(async () => {
      const sp = restored.split;
      if (sp) await tabShowSplit(sp.left, sp.right, restored.active as string, sp.ratio);
      else await tabShow(restored.active as string);
    }));
    return;
  }
  tabSyncNow();
}

// ── Actions ──────────────────────────────────────────────────────────────────

/** Open `key`'s record on its page (no-op if it already is) and mark it active. */
async function tabShow(key: string): Promise<boolean> {
  const t = tabFind(key);
  const k = tabKindOf(t);
  if (!t || !k) return false;
  if (!tabIsOpen(t) && tabProject) {
    // Deleted since the tab was made? Say so quietly and drop it, rather than
    // let the opener raise its own "could not be loaded" alert.
    const name = await k.resolve(tabProject, t.id);
    if (name === null) {
      tabSet(tabClose(tabState, key));
      showToast(`That ${k.label.toLowerCase()} no longer exists, so its tab was closed.`);
      return false;
    }
  }
  tabSet(tabActivate(tabState, key));
  if (!tabIsOpen(t) || currentSection !== k.section) {
    await k.open(t.id);
    tabApplySplit(); // the opener's selectSection hid the other pane
  }
  if (tabIsOpen(t)) return true;
  // The opener could not show it (deleted since, or unreadable): drop the tab.
  tabSet(tabClose(tabState, key));
  return false;
}

/** Click / ⌘⇧] / ⌘⇧[ — bring a tab's record on screen. */
async function tabSwitchTo(key: string): Promise<void> {
  const t = tabFind(key);
  if (!t || !tabKindOf(t)) return;
  const s = tabState;
  if (s.split && (key === s.split.left || key === s.split.right)) { tabFocusPane(key); return; }
  if (!s.split && s.active === key && tabIsOpen(t) && currentSection === tabKindOf(t)!.section) return;
  await tabDrive(async () => {
    // What this record displaces: in split view, the pane on its OWN page if
    // one is, else the pane with focus; otherwise simply the active record.
    let slot = s.active;
    if (s.split) {
      const same = [s.split.left, s.split.right].find((k) => {
        const other = tabFind(k);
        return !!other && !tabFits(other, t);
      });
      if (same) slot = same;
      tabState = tabActivate(tabState, slot);
    }
    const leaving = tabFind(slot);
    // A different kind lives on a different page, which goes back to its list
    // first — the same page is simply re-pointed by the opener.
    if (leaving && leaving.kind !== t.kind && tabIsOpen(leaving)) {
      if ((await tabKindOf(leaving)!.close()) === false) return;
    }
    await tabShow(key);
  });
}

/** ⌘W / × / middle-click. */
async function tabCloseKey(key: string): Promise<boolean> {
  const t = tabFind(key);
  if (!t) return false;
  const s = tabState;
  const wasActive = s.active === key;
  const wasSplit = !!s.split && (key === s.split.left || key === s.split.right);
  const next = tabClose(s, key);
  const successor = tabFind(next.active);
  let closed = false;
  await tabDrive(async () => {
    const k = tabKindOf(t);
    // The next record of the SAME kind re-points the page itself; anything
    // else puts the page back on its list. A dirty page is always asked.
    const handOver = wasActive && !wasSplit && !!successor && successor.kind === t.kind;
    if (k && tabIsOpen(t) && (!handOver || k.isDirty())) {
      if ((await k.close()) === false) return;
    }
    tabSet(tabClose(tabState, key));
    closed = true;
    if (!wasActive || !successor) return;
    if (wasSplit) tabFocusPane(tabKeyOf(successor)); // the survivor is already on screen
    else await tabShow(tabKeyOf(successor));
  });
  return closed;
}

/** "Close others" — keep one tab, open. */
async function tabCloseOthersKey(key: string): Promise<void> {
  const keep = tabFind(key);
  if (!keep) return;
  await tabSwitchTo(key);
  await tabDrive(async () => {
    for (const t of tabState.tabs) {
      if (tabKeyOf(t) === key || t.kind === keep.kind || !tabIsOpen(t)) continue;
      if ((await tabKindOf(t)!.close()) === false) return;
    }
    tabSet(tabCloseOthers(tabState, key));
  });
}

/** Add a tab without leaving the page — ⌘-click on a list row. */
async function tabOpenBackground(kind: string, id: string): Promise<void> {
  const k = TAB_KINDS[kind];
  const pid = currentProjectId;
  if (!k || !pid || !id) return;
  tabSet(tabOpen(tabState, { kind, id, name: '' }, true));
  tabFlash(tabKey(kind, id));
  const name = await k.resolve(pid, id);
  if (pid !== tabProject || !tabFind(tabKey(kind, id))) return;
  if (name === null) tabSet(tabClose(tabState, tabKey(kind, id)));
  else tabSet(tabOpen(tabState, { kind, id, name }, true));
}

/**
 * "Open in new window" — MOVES the tab: it closes here first, which also saves
 * an open dashboard, and only then does the new window read the record. Two
 * editors on one record would each autosave over the other.
 */
async function tabToNewWindow(key: string): Promise<void> {
  const t = tabFind(key);
  const pid = currentProjectId;
  if (!t || !pid) return;
  if (!(await tabCloseKey(key))) return;
  let res: { ok: boolean } | null = null;
  try { res = await window.hub.openRecordWindow(t.kind, t.id, pid); } catch (_) { res = null; }
  if (!res || !res.ok) {
    tabSet(tabOpen(tabState, t, true)); // put it back
    showToast("Couldn't open a new window", { kind: 'error' });
  }
}

// ── Boot ─────────────────────────────────────────────────────────────────────

/**
 * A secondary window: adopt its project SYNCHRONOUSLY, before Home's first
 * paint resolves one of its own (it would pick the newest project), then open
 * the one record it was created for. No splash — it is not a cold start.
 */
function tabBootSecondary(): void {
  const pid = TAB_QUERY.get('project') || '';
  const open = TAB_QUERY.get('open') || '';
  const cut = open.indexOf(':');
  const kind = cut > 0 ? open.slice(0, cut) : '';
  const id = cut > 0 ? open.slice(cut + 1) : '';
  const splash = document.getElementById('splash');
  if (splash) splash.hidden = true;
  if (!pid || !TAB_KINDS[kind] || !id) return;
  currentProjectId = pid;
  tabBooted = true;
  void (async () => {
    if (!(await adoptProject(pid))) return;
    tabProject = pid;
    tabSet(tabOpen(tabState, { kind, id, name: '' }, true));
    await tabRun(() => tabDrive(async () => { await tabShow(tabKey(kind, id)); }));
  })();
}

function initTabs(): void {
  registerCommand({
    id: 'tab.close', title: 'Close tab', group: 'View', icon: 'x', keys: 'mod+w',
    when: () => !!tabState.active,
    run: () => { const k = tabState.active; if (k) void tabRun(() => tabCloseKey(k).then(() => undefined)); },
  });
  registerCommand({
    id: 'tab.next', title: 'Next tab', group: 'Navigate', icon: 'chevron-right', keys: 'mod+shift+]',
    when: () => tabState.tabs.length > 0,
    run: () => { const k = tabNeighbour(tabState, 1); if (k) void tabRun(() => tabSwitchTo(k)); },
  });
  registerCommand({
    id: 'tab.prev', title: 'Previous tab', group: 'Navigate', icon: 'chevron-left', keys: 'mod+shift+[',
    when: () => tabState.tabs.length > 0,
    run: () => { const k = tabNeighbour(tabState, -1); if (k) void tabRun(() => tabSwitchTo(k)); },
  });
  registerCommand({
    id: 'tab.split', title: 'Toggle split view', group: 'View', icon: 'columns', keys: 'mod+\\',
    when: () => !!tabState.active,
    run: () => { void tabRun(() => tabSplitCommand()); },
  });
  registerCommand({
    id: 'tab.newWindow', title: 'Open tab in new window', group: 'View', icon: 'external-link',
    when: () => !!tabState.active,
    run: () => { const k = tabState.active; if (k) void tabRun(() => tabToNewWindow(k)); },
  });
  initTabStrip();
  initTabSplit();
  if (TAB_SECONDARY) tabBootSecondary();
}
