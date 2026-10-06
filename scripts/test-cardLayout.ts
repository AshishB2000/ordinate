// Self-check for the layout card kinds: container geometry as children and the
// container move, tabs that persist through main's sanitizer, snapping,
// align/distribute, and the image bytes an Image card will accept.
//
//   npm run build:ts && node scripts/test-cardLayout.js

import { ok, failureCount, finish } from './selfcheck';
import { sanitizeCards } from '../src/analysis/dashboards';
import { sniffImage, unsafeSvg, imageSize } from '../src/app/projectAssets';

// ponytail: cardModel.js is a UMD script, not a TS module (see test-geo-match.ts)
const cm = require('../src/analysis/cardModel') as any;

const ID = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const L = (x: number, y: number, w: number, h: number): any => ({ x, y, w, h });
const same = (a: any, b: any): boolean => JSON.stringify(a) === JSON.stringify(b);

// ── Container geometry ───────────────────────────────────────────────────────
{
  const cards = [
    { id: ID(1), type: 'container', layout: L(0, 0, 8, 4), container: { title: 'KPIs' } },
    { id: ID(2), type: 'metric', layout: L(0, 1, 4, 3), parentId: ID(1) },
    { id: ID(3), type: 'metric', layout: L(4, 1, 4, 3), parentId: ID(1) },
    { id: ID(4), type: 'visual', layout: L(8, 0, 4, 4) },
  ];
  // The container dragged 2 right and 3 down: both children follow, the loose card does not.
  cards[0].layout = L(2, 3, 8, 4);
  const moved = cm.moveChildren(cards, ID(1), 2, 3);
  ok('move: exactly the two children move', same(moved.sort(), [ID(2), ID(3)]));
  ok('move: each child keeps its offset inside the container',
    same(cards[1].layout, L(2, 4, 4, 3)) && same(cards[2].layout, L(6, 4, 4, 3)), JSON.stringify(cards.map((c) => c.layout)));
  ok('move: a card outside the container stays put', same(cards[3].layout, L(8, 0, 4, 4)));
  ok('move: a child cannot be pushed past the page edge', (() => {
    const cs = [{ id: ID(1), type: 'container', layout: L(0, 0, 12, 3) }, { id: ID(2), type: 'text', layout: L(8, 1, 4, 2), parentId: ID(1) }];
    cm.moveChildren(cs, ID(1), 3, 0);
    return cs[1].layout.x === 8;
  })());
  ok('move: no delta, no change', cm.moveChildren(cards, ID(1), 0, 0).length === 0);

  // A child moves past the container's right and bottom edges: the container grows to hold it.
  cards[2].layout = L(8, 5, 4, 4);
  ok('fit: the container grows when a child overhangs it', cm.fitGroup(cards, ID(1)) === true);
  ok('fit: …to the child\'s right and bottom edges, keeping its own top-left',
    same(cards[0].layout, L(2, 3, 10, 6)), JSON.stringify(cards[0].layout));
  ok('fit: already holding everything → unchanged', cm.fitGroup(cards, ID(1)) === false);
  cards[1].layout = L(2, 3, 4, 3);
  cm.fitGroup(cards, ID(1));
  ok('fit: a child dragged into the title row is put back under it', cards[1].layout.y === 4);
  const wide = [{ id: ID(9), type: 'container', layout: L(6, 0, 6, 3) }, { id: ID(8), type: 'text', layout: L(2, 1, 3, 2), parentId: ID(9) }];
  cm.fitGroup(wide, ID(9));
  ok('fit: a child left of the container widens it leftward', same(wide[0].layout, L(2, 0, 10, 3)), JSON.stringify(wide[0].layout));

  // Dropping a card inside a container's content box makes it a child; its title row does not count.
  const loose = { id: ID(5), type: 'text', layout: L(3, 6, 2, 2) };
  const all = cards.concat([loose]);
  ok('drop: a card wholly inside the content box belongs to the container', cm.dropParent(all, loose) === ID(1));
  loose.layout = L(3, 3, 2, 2);
  ok('drop: a card over the title row does not', cm.dropParent(all, loose) === null);
  loose.layout = L(11, 6, 2, 2);
  ok('drop: a card hanging off the edge does not', cm.dropParent(all, loose) === null);
  ok('drop: a group never nests in a group', cm.dropParent(all, { id: ID(6), type: 'tabs', layout: L(3, 5, 2, 2) }) === null);

  cm.releaseChildren(all, ID(1));
  ok('release: removing the container leaves its children, ungrouped', all.every((c: any) => c.parentId === undefined));
}

// ── Wrapping a selection ─────────────────────────────────────────────────────
{
  const cards: any[] = [
    { id: ID(1), type: 'metric', layout: L(0, 0, 3, 2) },
    { id: ID(2), type: 'metric', layout: L(3, 0, 3, 2) },
    { id: ID(3), type: 'visual', layout: L(0, 2, 12, 5) },
    { id: ID(4), type: 'visual', layout: L(8, 0, 4, 2) },
  ];
  const g = { id: ID(10), type: 'container', container: {} };
  cm.wrapGroup(cards, [ID(1), ID(2)], g);
  ok('wrap: the container is the bounding box plus a title row', same((g as any).layout, L(0, 0, 6, 3)), JSON.stringify((g as any).layout));
  ok('wrap: members move down under the title and join', same(cards[0].layout, L(0, 1, 3, 2)) && cards[1].parentId === ID(10));
  ok('wrap: a card below that shares columns moves down too, so nothing is covered', cards[2].layout.y === 3);
  ok('wrap: a card beside it does not move', same(cards[3].layout, L(8, 0, 4, 2)));
  const t = { id: ID(11), type: 'tabs', tabs: cm.sanitizeTabs({ items: [{ id: ID(20), name: 'A' }, { id: ID(21), name: 'B' }] }) };
  const cs2: any[] = [{ id: ID(5), type: 'text', layout: L(0, 0, 4, 2) }];
  cm.wrapGroup(cs2, [ID(5)], t);
  ok('wrap: into tabs lands in the first tab', cs2[0].parentId === ID(11) && cs2[0].tabId === ID(20));
}

// ── Tabs persist ─────────────────────────────────────────────────────────────
{
  const raw = [
    { id: ID(30), type: 'tabs', layout: L(0, 0, 12, 6), tabs: { items: [{ id: ID(31), name: ' Sales ' }, { id: ID(32), name: '' }, { id: 'bad', name: 'X' }] } },
    { id: ID(33), type: 'metric', layout: L(0, 1, 4, 2), parentId: ID(30), tabId: ID(32), metric: { datasetId: ID(40), column: 'revenue', aggregation: 'sum' } },
    { id: ID(34), type: 'text', layout: L(4, 1, 4, 2), parentId: ID(30), tabId: ID(31), text: 'hi' },
    { id: ID(35), type: 'container', layout: L(0, 7, 12, 3), parentId: ID(30), container: { background: 'neon', padding: 'xl' } },
  ];
  const back = sanitizeCards(JSON.parse(JSON.stringify(raw)));
  const tabs: any = back.find((c) => c.id === ID(30));
  ok('tabs: a tabs card survives main\'s sanitizer', !!tabs && tabs.type === 'tabs');
  ok('tabs: names are trimmed and a blank one is named for its place', tabs.tabs.items[0].name === 'Sales' && tabs.tabs.items[1].name === 'Tab 2');
  ok('tabs: ids are kept, an invalid one replaced', tabs.tabs.items[0].id === ID(31) && tabs.tabs.items[2].id !== 'bad');
  const kpi: any = back.find((c) => c.id === ID(33));
  ok('tabs: a child keeps its parent and its tab through save and load', kpi.parentId === ID(30) && kpi.tabId === ID(32));
  const again = sanitizeCards(JSON.parse(JSON.stringify(back)));
  ok('tabs: a second round trip is identical — the record is stable', same(again, back));
  const cont: any = back.find((c) => c.id === ID(35));
  ok('tabs: a group cannot be a child; unknown options fall back', cont.parentId === undefined && cont.container.background === 'subtle' && cont.container.padding === 'md');
  ok('tabs: an empty tabs card still has one tab', cm.sanitizeTabs({}).items.length === 1);
  ok('active tab: a remembered tab that still exists wins', cm.activeTab(tabs, ID(32)) === ID(32));
  ok('active tab: a forgotten or removed one falls back to the first', cm.activeTab(tabs, ID(99)) === ID(31) && cm.activeTab(tabs, undefined) === ID(31));
  const cards = back.map((c) => ({ ...c }));
  const tabsLive: any = cards.find((c) => c.id === ID(30));
  cm.removeTab(cards, tabsLive, ID(32));
  ok('remove tab: its cards move to the first remaining tab, none vanish',
    tabsLive.tabs.items.length === 2 && cards.find((c: any) => c.id === ID(33))?.tabId === ID(31));
  cm.removeTab(cards, { ...tabsLive, tabs: { items: [tabsLive.tabs.items[0]] } }, tabsLive.tabs.items[0].id);
  ok('remove tab: the last tab cannot be removed', tabsLive.tabs.items.length === 2);
  const imgBad = sanitizeCards([{ type: 'image', layout: L(0, 0, 2, 2), image: { assetId: '../../etc/passwd' } }]);
  ok('image: a card whose asset id is not a UUID is dropped', imgBad.length === 0);
  const img: any = sanitizeCards([{ type: 'image', layout: L(0, 0, 2, 2), image: { assetId: ID(50), ext: 'exe', fit: 'weird', alt: 'Logo', aspect: 2 } }])[0];
  ok('image: an unknown extension and fit fall back; alt and aspect are kept', img.image.ext === 'png' && img.image.fit === 'contain' && img.image.alt === 'Logo' && img.image.aspect === 2);
}

// ── Snap, align, distribute ──────────────────────────────────────────────────
{
  const s = cm.snapRect(L(5, 6, 3, 2), [L(0, 0, 4, 3)], 1);
  ok('snap: a left edge one column past a neighbour\'s right edge lines up on it',
    s.x === 4 && s.guides.some((g: any) => g.axis === 'x' && g.at === 4), JSON.stringify(s));
  const exact = cm.snapRect(L(1, 4, 3, 2), [L(0, 0, 4, 3)], 1);
  ok('snap: an edge ALREADY aligned wins over a nearby one — no move, just the guide',
    exact.x === 1 && exact.guides.some((g: any) => g.axis === 'x' && g.at === 4), JSON.stringify(exact));
  const r = cm.snapRect(L(7, 0, 4, 3), [L(0, 0, 6, 3)], 1);
  ok('snap: a left edge meets a neighbour\'s right edge', r.x === 6, JSON.stringify(r));
  const c = cm.snapRect(L(5, 9, 2, 1), [L(4, 0, 4, 2)], 1);
  ok('snap: centres line up when a whole-unit position allows', c.x === 5 && c.guides.some((g: any) => g.at === 6));
  const far = cm.snapRect(L(3, 9, 2, 2), [L(8, 0, 2, 2)], 1);
  ok('snap: nothing within reach → no move, no guide', far.x === 3 && far.y === 9 && far.guides.length === 0);
  ok('snap: never past the page edge', cm.snapRect(L(10, 0, 2, 1), [L(11, 3, 3, 1)], 1).x <= 10);

  const ls = [L(1, 0, 2, 2), L(5, 3, 3, 1), L(9, 1, 2, 4)];
  const a = ls.map((l) => ({ ...l }));
  cm.alignLayouts(a, 'left');
  ok('align left: every card at the leftmost edge', a.every((l) => l.x === 1));
  const b = ls.map((l) => ({ ...l }));
  cm.alignLayouts(b, 'right');
  ok('align right: every right edge at the rightmost', b.every((l) => l.x + l.w === 11));
  const m = ls.map((l) => ({ ...l }));
  cm.alignLayouts(m, 'top');
  ok('align top', m.every((l) => l.y === 0));
  const d = [L(0, 0, 2, 1), L(3, 0, 2, 1), L(10, 0, 2, 1)];
  cm.distributeLayouts(d, 'x');
  ok('distribute: first and last stay, the middle gaps are equal', d[0].x === 0 && d[2].x === 10 && d[1].x === 5, JSON.stringify(d));
  const two = [L(0, 0, 2, 1), L(9, 0, 2, 1)];
  cm.distributeLayouts(two, 'x');
  ok('distribute: fewer than three is a no-op', two[1].x === 9);
}

// ── Image bytes ──────────────────────────────────────────────────────────────
{
  const png = Buffer.from('89504e470d0a1a0a0000000d494844520000014000000080', 'hex');
  ok('sniff: PNG by magic number', sniffImage(png) === 'png');
  ok('size: PNG width and height from IHDR', same(imageSize(png, 'png'), { w: 320, h: 128 }));
  ok('sniff: JPEG by magic number', sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0])) === 'jpg');
  const svg = Buffer.from('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100"><rect/></svg>');
  ok('sniff: SVG by its root element', sniffImage(svg) === 'svg');
  ok('size: SVG from its viewBox', same(imageSize(svg, 'svg'), { w: 200, h: 100 }));
  ok('sniff: a renamed text file is not an image', sniffImage(Buffer.from('hello, not an image')) === null);
  ok('sniff: an HTML file is not an SVG', sniffImage(Buffer.from('<html><svg></svg></html>')) === null);
  ok('svg: script is refused', unsafeSvg('<svg><script>alert(1)</script></svg>'));
  ok('svg: an event handler is refused', unsafeSvg('<svg><rect onload="x()"/></svg>'));
  ok('svg: foreignObject is refused', unsafeSvg('<svg><foreignObject/></svg>'));
  ok('svg: a plain drawing is fine', !unsafeSvg('<svg viewBox="0 0 1 1"><path d="M0 0"/></svg>'));
}

console.log(failureCount() ? `\n${failureCount()} card layout check(s) FAILED.` : '\nAll card layout checks passed.');
finish();
