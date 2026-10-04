// DIFFERENTIAL: this port of the sheet geometry against the legacy pure
// modules the server still sanitizes with (renderer/hub/cardModel.ts and
// sizeLayout.ts, as `npm run build:ts` emits them), on the same seeded random
// sheets — every result deep-equal with Object.is at the leaves
// (node:assert deepStrictEqual). Plus findSlot against dashGrid's rule.

import { deepStrictEqual, notDeepStrictEqual } from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, it } from 'vitest';
import type { Card, SizeItem } from '../api';
import * as g from './geometry';

const ROOT = path.resolve(process.cwd(), '..');
const require = createRequire(path.join(ROOT, 'package.json'));
// any: the legacy modules are untyped CommonJS
const legacyCards: any = require(path.join(ROOT, 'renderer', 'hub', 'cardModel.js'));
const legacySizes: any = require(path.join(ROOT, 'renderer', 'hub', 'sizeLayout.js'));

/** mulberry32: the same sheets on every run. */
function rng(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const TYPES = ['visual', 'metric', 'text', 'divider', 'image', 'nav', 'stats', 'control', 'container', 'tabs'];

function sheet(seed: number): Card[] {
  const r = rng(seed);
  const int = (n: number) => Math.floor(r() * n);
  const cards: Card[] = [];
  const n = 2 + int(14);
  for (let i = 0; i < n; i++) {
    const type = TYPES[int(TYPES.length)];
    const w = 1 + int(12);
    const c: Card = { id: `c${seed}-${i}`, type, layout: { x: int(13 - w), y: int(20), w, h: 1 + int(8) } };
    if (type === 'text') {
      c.heading = 'H'.repeat(int(40));
      c.text = 'x'.repeat(int(900));
    }
    if (type === 'tabs') c.tabs = { items: [{ id: `t${i}a`, name: 'A' }, { id: `t${i}b`, name: 'B' }] };
    cards.push(c);
  }
  // Nest some cards in the groups.
  const groups = cards.filter((c) => c.type === 'container' || c.type === 'tabs');
  for (const c of cards) {
    if (!groups.length || g.isGroup(c) || c.type === 'control' || r() < 0.5) continue;
    const grp = groups[int(groups.length)];
    c.parentId = grp.id;
    if (grp.tabs) c.tabId = grp.tabs.items[int(2)].id;
  }
  return cards;
}

function stored(cards: Card[], seed: number): { items: SizeItem[] } | undefined {
  const r = rng(seed * 7 + 1);
  if (r() < 0.3) return undefined;
  const ids = cards.filter((c) => c.type !== 'control').map((c) => c.id);
  const items: SizeItem[] = [];
  for (const id of ids) {
    if (r() < 0.3) continue; // a card the stored layout has never seen
    const it: SizeItem = { id };
    if (r() < 0.25) it.hidden = true;
    if (r() < 0.25) it.h = Math.floor(r() * 30) - 2;
    items.splice(Math.floor(r() * (items.length + 1)), 0, it);
  }
  if (r() < 0.2) items.push({ id: 'ghost' });
  return { items };
}

const clone = <T>(v: T): T => structuredClone(v);
const SEEDS = Array.from({ length: 120 }, (_, i) => i + 1);

describe('layouts for every size = sizeLayout.ts', () => {
  it('resolve / materialize / readingOrder on 120 random sheets, all three sizes', () => {
    for (const seed of SEEDS) {
      const cards = sheet(seed);
      const st = stored(cards, seed);
      const hidden = new Set(cards.filter((_, i) => i % 5 === 0).map((c) => c.id));
      deepStrictEqual(g.readingOrder(cards).map((c) => c.id), legacySizes.readingOrder(cards).map((c: Card) => c.id), `order ${seed}`);
      for (const size of g.SIZES) {
        deepStrictEqual(g.resolve(cards, st, size, hidden), legacySizes.resolve(cards, st, size, hidden), `resolve ${seed} ${size}`);
        deepStrictEqual(g.resolve(cards, st, size), legacySizes.resolve(cards, st, size), `resolve ${seed} ${size} (no view)`);
      }
      deepStrictEqual(g.materialize(cards, st), legacySizes.materialize(cards, st), `materialize ${seed}`);
      for (const w of [0, -1, 300, 599, 600, 899, 900, 2000]) deepStrictEqual(g.pickSize(w), legacySizes.pickSize(w));
    }
  });

  it('moveItem / setHidden / setHeight edit the same way', () => {
    for (const seed of SEEDS.slice(0, 40)) {
      const cards = sheet(seed);
      const base = g.materialize(cards, stored(cards, seed));
      const ids = base.items.map((i) => i.id);
      if (ids.length < 2) continue;
      const [a, b] = [ids[seed % ids.length], ids[(seed * 3) % ids.length]];
      for (const after of [true, false]) {
        const mine = clone(base);
        const theirs = clone(base);
        deepStrictEqual(g.moveItem(mine, a, b, after), legacySizes.moveItem(theirs, a, b, after));
        deepStrictEqual(mine, theirs);
      }
      const m2 = clone(base);
      const t2 = clone(base);
      deepStrictEqual(g.setHidden(m2, a, true), legacySizes.setHidden(t2, a, true));
      deepStrictEqual(g.setHeight(m2, b, seed - 3), legacySizes.setHeight(t2, b, seed - 3));
      deepStrictEqual(m2, t2);
    }
  });
});

describe('card geometry = cardModel.ts', () => {
  it('snapRect / align / distribute', () => {
    for (const seed of SEEDS) {
      const cards = sheet(seed).filter((c) => c.type !== 'control');
      const [first, ...rest] = cards.map((c) => c.layout);
      for (const within of [0, 1, 2]) deepStrictEqual(g.snapRect(first, rest, within), legacyCards.snapRect(first, rest, within), `snap ${seed}`);
      for (const mode of ['left', 'center', 'right', 'top', 'middle', 'bottom'] as const) {
        const mine = clone(cards.map((c) => c.layout));
        const theirs = clone(mine);
        g.alignLayouts(mine, mode);
        legacyCards.alignLayouts(theirs, mode);
        deepStrictEqual(mine, theirs, `align ${seed} ${mode}`);
      }
      for (const axis of ['x', 'y'] as const) {
        const mine = clone(cards.map((c) => c.layout));
        const theirs = clone(mine);
        g.distributeLayouts(mine, axis);
        legacyCards.distributeLayouts(theirs, axis);
        deepStrictEqual(mine, theirs, `distribute ${seed} ${axis}`);
      }
    }
  });

  it('groups: wrap, fit, drop, move, release, remove tab, active tab', () => {
    for (const seed of SEEDS) {
      const cards = sheet(seed);
      const ids = cards.filter((_, i) => i % 3 === 0).map((c) => c.id);
      for (const type of ['container', 'tabs']) {
        const grp = (): Card => ({ id: 'grp', type, layout: { x: 0, y: 0, w: 12, h: 5 }, ...(type === 'tabs' ? { tabs: { items: [{ id: 'g1', name: '1' }, { id: 'g2', name: '2' }] } } : {}) });
        const mine = clone(cards);
        const theirs = clone(cards);
        const gm = grp();
        const gt = grp();
        g.wrapGroup(mine, ids, gm);
        legacyCards.wrapGroup(theirs, ids, gt);
        deepStrictEqual([mine, gm], [theirs, gt], `wrap ${seed} ${type}`);
      }
      for (const c of cards) deepStrictEqual(g.dropParent(cards, c), legacyCards.dropParent(cards, c), `drop ${seed}`);
      for (const grp of cards.filter(g.isGroup)) {
        const mine = clone(cards);
        const theirs = clone(cards);
        deepStrictEqual(g.fitGroup(mine, grp.id), legacyCards.fitGroup(theirs, grp.id));
        deepStrictEqual(g.moveChildren(mine, grp.id, 2, -1), legacyCards.moveChildren(theirs, grp.id, 2, -1));
        deepStrictEqual(mine, theirs, `fit/move ${seed}`);
        deepStrictEqual(g.activeTab(grp, 'nope'), legacyCards.activeTab(grp, 'nope'));
        if (grp.tabs) {
          const tab = grp.tabs.items[0].id;
          const m = clone(cards);
          const t = clone(cards);
          g.removeTab(m, m.find((c) => c.id === grp.id) as Card, tab);
          legacyCards.removeTab(t, t.find((c: Card) => c.id === grp.id), tab);
          deepStrictEqual(m, t, `removeTab ${seed}`);
        }
        const m = clone(cards);
        const t = clone(cards);
        g.releaseChildren(m, grp.id);
        legacyCards.releaseChildren(t, grp.id);
        deepStrictEqual(m, t);
      }
    }
  });

  it('negative control: a sabotaged port is caught', () => {
    const cards = sheet(3);
    const off = g.resolve(cards, undefined, 'phone');
    off.items[0] = { ...off.items[0], h: off.items[0].h + 1 };
    notDeepStrictEqual(off, legacySizes.resolve(cards, undefined, 'phone'));
  });
});

describe('findSlot (dashGrid dashFindSlot)', () => {
  it('fills the first free cell, scanning rows, and ignores controls', () => {
    const at = (x: number, y: number, w: number, h: number, type = 'visual'): Card => ({ id: `${x}${y}`, type, layout: { x, y, w, h } });
    deepStrictEqual(g.findSlot([], 6, 6), { x: 0, y: 0 });
    deepStrictEqual(g.findSlot([at(0, 0, 6, 6)], 6, 6), { x: 6, y: 0 });
    deepStrictEqual(g.findSlot([at(0, 0, 6, 6), at(6, 0, 6, 6)], 3, 2), { x: 0, y: 6 });
    deepStrictEqual(g.findSlot([at(0, 0, 0, 0, 'control')], 12, 2), { x: 0, y: 0 });
    deepStrictEqual(g.findSlot([at(0, 0, 12, 3)], 13, 1), { x: 0, y: 3 });
  });
});
