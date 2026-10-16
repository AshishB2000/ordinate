// The phone's reading order (docs/phone-dashboards): the grid read row by row,
// then column — spans, gaps and overlapping rows — and the KPI runs folded
// into strips. Then DIFFERENTIAL: the app's fold against the published page's
// (src/publish/site/publishCore.ts pkPhoneBlocks, as `npm run build:ts` emits
// it) over the cells the server publishes (sizeLayout.publishCells), on seeded
// random sheets — the same blocks, compared with Object.is at the leaves.

import { deepStrictEqual } from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import type { Card, SizeItem } from '../../analyses/api';
import { readingOrder, resolve } from '../../analyses/editor/geometry';
import { isPhoneReader, phoneBlocks } from './phoneBlocks';

const card = (id: string, type: string, x: number, y: number, w: number, h: number, extra: Partial<Card> = {}): Card => ({ id, type, layout: { x, y, w, h }, ...extra });
const order = (cards: Card[]) => readingOrder(cards).map((c) => c.id);

describe('reading order: the grid, row by row, then column', () => {
  it('reads a row left to right before the next row, whatever the order cards were added in', () => {
    expect(order([card('c', 'visual', 6, 4, 6, 4), card('b', 'visual', 0, 4, 6, 4), card('a', 'metric', 0, 0, 12, 2)])).toEqual(['a', 'b', 'c']);
  });

  it('spans: a card spanning many rows is read where it STARTS, a short one beside it after it', () => {
    // tall | top-right
    //      | bottom-right
    expect(order([card('br', 'visual', 6, 3, 6, 3), card('tall', 'visual', 0, 0, 6, 6), card('tr', 'visual', 6, 0, 6, 3)])).toEqual(['tall', 'tr', 'br']);
  });

  it('gaps: empty rows and columns change nothing but where a card starts', () => {
    expect(order([card('far', 'text', 9, 40, 3, 2), card('near', 'text', 11, 2, 1, 1), card('first', 'text', 4, 0, 2, 1)])).toEqual(['first', 'near', 'far']);
  });

  it('overlapping rows: a card starting INSIDE another card’s rows is read after the earlier start, left before right on a tie', () => {
    expect(
      order([card('x', 'visual', 0, 2, 4, 6), card('y', 'visual', 4, 0, 4, 4), card('z', 'visual', 8, 2, 4, 2), card('w', 'visual', 0, 0, 4, 2)]),
    ).toEqual(['w', 'y', 'x', 'z']);
  });

  it('controls are filter-bar chips, never tiles; a group is followed by its own children in tab order', () => {
    const tabs = card('g', 'tabs', 0, 4, 12, 6, { tabs: { items: [{ id: 't1', name: 'One' }, { id: 't2', name: 'Two' }] } });
    expect(
      order([
        card('ctl', 'control', 0, 0, 3, 1),
        tabs,
        card('k2', 'visual', 0, 5, 12, 4, { parentId: 'g', tabId: 't2' }),
        card('k1', 'visual', 0, 9, 12, 4, { parentId: 'g', tabId: 't1' }),
        card('top', 'metric', 0, 1, 3, 2),
      ]),
    ).toEqual(['top', 'g', 'k1', 'k2']);
  });
});

describe('phoneBlocks: KPI runs fold into strips', () => {
  const sheet = [
    card('k1', 'metric', 0, 0, 3, 2),
    card('k2', 'metric', 3, 0, 3, 2),
    card('k3', 'metric', 6, 0, 3, 2),
    card('chart', 'visual', 0, 2, 12, 6),
    card('lone', 'metric', 0, 8, 3, 2),
    card('note', 'text', 3, 8, 9, 2),
  ];

  it('a run of KPIs is one strip; a lone KPI stays a card; everything else is a card in order', () => {
    expect(phoneBlocks(resolve(sheet, undefined, 'phone').items, sheet)).toEqual([
      { kind: 'strip', ids: ['k1', 'k2', 'k3'] },
      { kind: 'card', id: 'chart' },
      { kind: 'card', id: 'lone' },
      { kind: 'card', id: 'note' },
    ]);
  });

  it('follows an edited phone order and leaves hidden cards out', () => {
    const stored: { items: SizeItem[] } = { items: [{ id: 'chart' }, { id: 'k1' }, { id: 'lone' }, { id: 'k2', hidden: true }, { id: 'k3' }, { id: 'note' }] };
    expect(phoneBlocks(resolve(sheet, stored, 'phone').items, sheet)).toEqual([
      { kind: 'card', id: 'chart' },
      { kind: 'strip', ids: ['k1', 'lone', 'k3'] },
      { kind: 'card', id: 'note' },
    ]);
  });

  it('a run never crosses into a group: a container’s KPIs strip together under its heading', () => {
    const grouped = [
      card('k1', 'metric', 0, 0, 3, 2),
      card('box', 'container', 0, 2, 12, 4, { container: { title: 'Box', background: 'subtle', padding: 'md', collapsible: false } }),
      card('in1', 'metric', 0, 3, 3, 2, { parentId: 'box' }),
      card('in2', 'metric', 3, 3, 3, 2, { parentId: 'box' }),
    ];
    // Order: k1, box, in1, in2 — k1 alone before the group's heading, the group's two as a strip.
    expect(phoneBlocks(resolve(grouped, undefined, 'phone').items, grouped)).toEqual([
      { kind: 'card', id: 'k1' },
      { kind: 'card', id: 'box' },
      { kind: 'strip', ids: ['in1', 'in2'] },
    ]);
  });

  it('ids the layout names but the sheet lacks are skipped, never drawn as holes', () => {
    expect(phoneBlocks([{ id: 'ghost' }, { id: 'k1' }], sheet)).toEqual([{ kind: 'card', id: 'k1' }]);
  });
});

describe('isPhoneReader', () => {
  it('is the phone size the author did NOT pin', () => {
    expect([isPhoneReader({ size: 'phone', pinned: null }), isPhoneReader({ size: 'phone', pinned: 'phone' }), isPhoneReader({ size: 'tablet', pinned: null })]).toEqual([true, false, false]);
  });
});

// ── The app and the published page fold the same way ─────────────────────

const ROOT = path.resolve(process.cwd(), '..');
const require = createRequire(path.join(ROOT, 'package.json'));
// any: the legacy layout module is untyped CommonJS
const sizeLayout: any = require(path.join(ROOT, 'src', 'analysis', 'sizeLayout.js'));
type PkBlock = { kind: 'strip'; at: number[] } | { kind: 'card'; at: number };
const core: { pkPhoneBlocks(cards: unknown[]): PkBlock[] } = (() => {
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(readFileSync(path.join(ROOT, 'src', 'publish', 'site', 'publishCore.js'), 'utf8'), ctx);
  return ctx as { pkPhoneBlocks(cards: unknown[]): PkBlock[] };
})();

function rng(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A published sheet's tiles: the kinds a page draws (no groups — a page draws none), KPIs often in runs. */
function sheetOf(seed: number): { cards: Card[]; stored?: { items: SizeItem[] } } {
  const r = rng(seed);
  const int = (n: number) => Math.floor(r() * n);
  const types = ['metric', 'metric', 'metric', 'visual', 'text', 'stats'];
  const cards: Card[] = [];
  for (let i = 0, n = 1 + int(14); i < n; i++) {
    const w = 1 + int(12);
    cards.push(card(`c${seed}-${i}`, types[int(types.length)], int(13 - w), int(16), w, 1 + int(6)));
  }
  if (r() < 0.5) return { cards };
  const items: SizeItem[] = [];
  for (const c of cards) {
    if (r() < 0.2) continue;
    items.splice(int(items.length + 1), 0, r() < 0.2 ? { id: c.id, hidden: true } : { id: c.id });
  }
  return { cards, stored: { items } };
}

describe('the published page folds the same way (differential)', () => {
  it('pkPhoneBlocks over the published cells = phoneBlocks over the resolved phone layout, 200 sheets', () => {
    for (let seed = 1; seed <= 200; seed++) {
      const { cards, stored } = sheetOf(seed);
      const cells = sizeLayout.publishCells(cards, stored ? { phone: stored } : undefined);
      // A published card has no id (sanitize.ts): the page's fold names cards by index; named back here to compare.
      const published = cards.map((c) => ({ kind: c.type === 'metric' ? 'metric' : 'chart', layout: c.layout, sizes: cells[c.id] }));
      const named = core.pkPhoneBlocks(published).map((b) => (b.kind === 'strip' ? { kind: 'strip', ids: b.at.map((i) => cards[i].id) } : { kind: 'card', id: cards[b.at].id }));
      deepStrictEqual(JSON.parse(JSON.stringify(named)), phoneBlocks(resolve(cards, stored, 'phone').items, cards), `seed ${seed}`);
    }
  });
});
