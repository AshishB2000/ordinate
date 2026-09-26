'use strict';

// The TAB SET — pure. State in, state out: no DOM, no window, no storage, no
// record lookups. Everything that touches the page (the strip, the openers,
// the split layout, localStorage) is tabStrip.ts / tabSplit.ts; this file is
// the part with no excuse for being wrong, and scripts/test-tabModel.ts
// evaluates it in a bare vm realm to prove it stays that way.
//
// A tab is a RECORD (kind + id), never a place: Home and the section lists are
// not tabs. `active` is the tab whose record is on screen — null while a list
// is showing, which is how "Back" leaves the tabs intact with none lit.
// `split` names the two records shown side by side; while it is set, `active`
// is always one of its two sides (the pane with focus).
//
// Every function returns a NEW state (shallow copies) and never mutates its
// argument, so the glue can compare before/after and a test can hold on to an
// old state.
//
// Classic global-scope renderer <script>: NO import/export.

interface TabRec { kind: string; id: string; name: string }
interface TabSplit { left: string; right: string; ratio: number }
interface TabState { tabs: TabRec[]; active: string | null; split: TabSplit | null }

const TAB_RATIO_MIN = 0.2;
const TAB_RATIO_MAX = 0.8;

function tabKey(kind: string, id: string): string {
  return kind + ':' + id;
}

function tabKeyOf(t: TabRec): string {
  return tabKey(t.kind, t.id);
}

function tabEmpty(): TabState {
  return { tabs: [], active: null, split: null };
}

function tabIndexOf(s: TabState, key: string | null): number {
  if (!key) return -1;
  for (let i = 0; i < s.tabs.length; i++) if (tabKeyOf(s.tabs[i]) === key) return i;
  return -1;
}

function tabClampRatio(r: unknown): number {
  const n = typeof r === 'number' && Number.isFinite(r) ? r : 0.5;
  return Math.min(TAB_RATIO_MAX, Math.max(TAB_RATIO_MIN, n));
}

/**
 * Focus a tab. In split view a tab that is not one of the two panes REPLACES
 * the pane with focus — the other pane stays put. `null` means "a list is
 * showing": nothing is lit, and a split cannot survive that.
 */
function tabActivate(s: TabState, key: string | null): TabState {
  if (key === null) return { ...s, active: null, split: null };
  if (tabIndexOf(s, key) < 0) return s;
  let split = s.split;
  if (split && key !== split.left && key !== split.right) {
    split = s.active === split.left ? { ...split, left: key } : { ...split, right: key };
  }
  return { ...s, active: key, split };
}

/**
 * Open a record's tab. An existing tab is focused (and its name refreshed when
 * one is given); a new one goes right after the focused tab — or at the end
 * when nothing is focused. `background` adds (or renames) without focusing and
 * always appends, so a run of ⌘-clicks lands in click order.
 */
function tabOpen(s: TabState, t: TabRec, background?: boolean): TabState {
  const key = tabKeyOf(t);
  const i = tabIndexOf(s, key);
  const tabs = s.tabs.slice();
  if (i >= 0) {
    if (t.name && t.name !== tabs[i].name) tabs[i] = { ...tabs[i], name: t.name };
  } else {
    const at = background ? -1 : tabIndexOf(s, s.active);
    tabs.splice(at >= 0 ? at + 1 : tabs.length, 0, { kind: t.kind, id: t.id, name: t.name || '' });
  }
  const next = { ...s, tabs };
  return background ? next : tabActivate(next, key);
}

/**
 * Close a tab. Closing the focused tab focuses its right-hand neighbour, else
 * its left, else nothing. Closing either side of a split ends the split and
 * leaves the OTHER side focused — it is still on screen.
 */
function tabClose(s: TabState, key: string): TabState {
  const i = tabIndexOf(s, key);
  if (i < 0) return s;
  const tabs = s.tabs.filter((_t, j) => j !== i);
  let active = s.active;
  let split = s.split;
  if (split && (key === split.left || key === split.right)) {
    active = key === split.left ? split.right : split.left;
    split = null;
  } else if (active === key) {
    const n = tabs[i] || tabs[i - 1] || null; // the right neighbour now sits at i
    active = n ? tabKeyOf(n) : null;
  }
  return { tabs, active, split };
}

/** "Close others": keep one tab, focused, unsplit. */
function tabCloseOthers(s: TabState, key: string): TabState {
  const i = tabIndexOf(s, key);
  if (i < 0) return s;
  return { tabs: [s.tabs[i]], active: key, split: null };
}

/** Move the tab at `from` so it ends up at index `to`. Out of range is a no-op. */
function tabMove(s: TabState, from: number, to: number): TabState {
  const n = s.tabs.length;
  if (from === to || from < 0 || to < 0 || from >= n || to >= n) return s;
  const tabs = s.tabs.slice();
  const [t] = tabs.splice(from, 1);
  tabs.splice(to, 0, t);
  return { ...s, tabs };
}

/** The key ⌘⇧] (dir > 0) or ⌘⇧[ (dir < 0) would focus. Wraps; from no focus it
 *  starts at the matching end. */
function tabNeighbour(s: TabState, dir: number): string | null {
  const n = s.tabs.length;
  if (!n) return null;
  const i = tabIndexOf(s, s.active);
  const j = i < 0 ? (dir > 0 ? 0 : n - 1) : (i + (dir > 0 ? 1 : -1) + n) % n;
  return tabKeyOf(s.tabs[j]);
}

function tabCycle(s: TabState, dir: number): TabState {
  return tabActivate(s, tabNeighbour(s, dir));
}

/**
 * The tab ⌘\ would put beside the focused one: the first tab after it
 * (wrapping) that `fits` beside it. Two records can share the screen only if
 * they live on different pages — the glue decides that, not this file.
 */
function tabSplitPartner(s: TabState, fits: (a: TabRec, b: TabRec) => boolean): string | null {
  const i = tabIndexOf(s, s.active);
  if (i < 0) return null;
  const n = s.tabs.length;
  for (let k = 1; k < n; k++) {
    const t = s.tabs[(i + k) % n];
    if (fits(s.tabs[i], t)) return tabKeyOf(t);
  }
  return null;
}

/**
 * ⌘\. Split: the focused tab on the left, `right` beside it, focus moving to
 * the new pane. Unsplit: the pane with focus stays. A split needs a focused
 * tab and a different, existing right-hand one; anything else is a no-op.
 */
function tabSplitToggle(s: TabState, right?: string | null): TabState {
  if (s.split) return { ...s, split: null };
  if (!s.active || !right || right === s.active || tabIndexOf(s, right) < 0) return s;
  return { ...s, split: { left: s.active, right, ratio: 0.5 }, active: right };
}

function tabSplitSetRatio(s: TabState, ratio: number): TabState {
  if (!s.split) return s;
  return { ...s, split: { ...s.split, ratio: tabClampRatio(ratio) } };
}

function tabSerialize(s: TabState): string {
  return JSON.stringify({ v: 1, tabs: s.tabs, active: s.active, split: s.split });
}

/**
 * Rebuild a saved state, dropping every tab whose record `exists` says is
 * gone — silently, as the spec asks. Anything malformed (bad JSON, a tab with
 * no id, a duplicate) is skipped, never thrown on: a corrupt entry must cost
 * the tabs, not the launch. A split survives only if both sides do; if the
 * focused side vanished, focus falls to the survivor.
 */
function tabRestore(raw: unknown, exists: (key: string) => boolean): TabState {
  let o: any = raw; // ponytail: untrusted JSON from localStorage, validated field by field below
  if (typeof raw === 'string') {
    try { o = JSON.parse(raw); } catch (_) { return tabEmpty(); }
  }
  if (!o || !Array.isArray(o.tabs)) return tabEmpty();
  const tabs: TabRec[] = [];
  const kept = new Set<string>();
  for (const t of o.tabs) {
    if (!t || typeof t.kind !== 'string' || typeof t.id !== 'string' || !t.kind || !t.id) continue;
    const key = tabKey(t.kind, t.id);
    if (kept.has(key) || !exists(key)) continue;
    kept.add(key);
    tabs.push({ kind: t.kind, id: t.id, name: typeof t.name === 'string' ? t.name : '' });
  }
  const has = (k: unknown): k is string => typeof k === 'string' && kept.has(k);
  const sp = o.split;
  let active: string | null = has(o.active) ? o.active : null;
  let split: TabSplit | null = null;
  if (sp && typeof sp === 'object') {
    if (has(sp.left) && has(sp.right) && sp.left !== sp.right && (active === sp.left || active === sp.right)) {
      split = { left: sp.left, right: sp.right, ratio: tabClampRatio(sp.ratio) };
    } else if (!active && (sp.left === o.active || sp.right === o.active)) {
      active = has(sp.left) ? sp.left : has(sp.right) ? sp.right : null;
    }
  }
  return { tabs, active, split };
}
