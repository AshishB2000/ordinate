// What a finished move or resize means for a sheet (legacy gridArrange.ts
// authoringAfterGesture / authoringAfterRemove, layoutKinds.ts handleAddGroup):
// a group takes its children along; a card dropped inside a group joins it and
// one dragged out leaves; a group grows to keep a child that overhangs it.
// Mutates a Doc draft inside `edit()`, so undo covers all of it.

import type { Card, Layout } from '../api';
import { activeTab, contentRect, dropParent, fitGroup, isGroup, moveChildren, overlaps, releaseChildren, wrapGroup, findSlot } from './geometry';
import { uuid } from './doc';

export type GestureMode = 'move' | 'e' | 's' | 'se';

export function afterGesture(cards: Card[], id: string, mode: GestureMode, dx: number, dy: number, tabOf: (groupId: string) => string | undefined): void {
  const live = cards.find((c) => c.id === id);
  if (!live) return;
  if (isGroup(live)) {
    if (mode === 'move') moveChildren(cards, live.id, dx, dy);
    else fitGroup(cards, live.id);
    return;
  }
  const parent = live.parentId ? cards.find((c) => c.id === live.parentId) : undefined;
  const overlapsParent = !!parent && overlaps(live.layout, contentRect(parent));
  const target = mode === 'move' ? dropParent(cards, live) : null;
  if (target && target !== live.parentId) {
    live.parentId = target;
    const g = cards.find((c) => c.id === target);
    if (g && g.type === 'tabs') live.tabId = activeTab(g, tabOf(g.id));
    else delete live.tabId;
  } else if (parent && mode === 'move' && !overlapsParent) {
    delete live.parentId;
    delete live.tabId;
  } else if (parent) {
    fitGroup(cards, parent.id);
  }
}

/** Set a card's layout and apply what the gesture means (one undo step). */
export function applyLayout(cards: Card[], id: string, next: Layout, mode: GestureMode, tabOf: (groupId: string) => string | undefined): void {
  const c = cards.find((x) => x.id === id);
  if (!c) return;
  const dx = next.x - c.layout.x;
  const dy = next.y - c.layout.y;
  c.layout = { ...next };
  afterGesture(cards, id, mode, dx, dy, tabOf);
}

/** A card removed: a group's children stay, ungrouped. */
export function removeCards(cards: Card[], ids: readonly string[]): Card[] {
  for (const id of ids) releaseChildren(cards, id);
  return cards.filter((c) => !ids.includes(c.id));
}

/** A new container / tabs card `id` around the multi-selection, or empty at a free slot. */
export function addGroup(cards: Card[], kind: 'container' | 'tabs', around: readonly string[], id: string): void {
  const g: Card = { id, type: kind, layout: { x: 0, y: 0, w: 12, h: 5 } };
  if (kind === 'container') g.container = { title: 'Container', background: 'subtle', padding: 'md', collapsible: true };
  else g.tabs = { items: [{ id: uuid(), name: 'Tab 1' }, { id: uuid(), name: 'Tab 2' }] };
  const picked = around.filter((id) => cards.some((c) => c.id === id));
  if (picked.length) wrapGroup(cards, picked, g);
  else {
    const w = kind === 'tabs' ? 12 : 6;
    g.layout = { ...findSlot(cards, w, 5), w, h: 5 };
  }
  // A group sits BEFORE its children in the list, so it draws beneath them.
  const first = cards.findIndex((c) => picked.includes(c.id));
  cards.splice(first >= 0 ? first : cards.length, 0, g);
}
