// DIFFERENTIAL: src/analysis/storyText.ts (the server's and the browser's copy,
// T2.13) against the desktop's storyText.js. One corpus, every export, Object.is
// at every leaf — so the outline the web page draws, the pages present mode
// flips through and the pages the export prints are the desktop's.
//
// The desktop file went with the desktop app (T8.1); its answers over this
// corpus are the golden fixture scripts/fixtures/golden/storyText.json
// (scripts/golden.ts), the corpus included.
//
//   npm run build:ts && node scripts/test-storyTextPort.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import { golden } from './golden';
import * as port from '../src/analysis/storyText';

function same(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || !a || !b) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  return ka.join() === kb.join() && ka.every((k) => same((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

// any: block shapes as recorded (the port's StoryBlock type is wider than the corpus)
type Blocks = any[];
const G = golden<{
  texts: Array<{ text: string; inline: unknown[]; parse: unknown; plain: unknown }>;
  stories: Array<{ blocks: Blocks; outline: unknown; pages: unknown[] }>;
}>('storyText');

ok('the fixture holds the corpus (12 texts, 5 stories)', G.texts.length === 12 && G.stories.length === 5);
let inlineOk = true;
let parseOk = true;
let plainOk = true;
for (const t of G.texts) {
  t.text.split('\n').forEach((line, i) => { if (!same(port.mdInline(line), t.inline[i])) inlineOk = false; });
  if (!same(port.mdParse(t.text), t.parse)) parseOk = false;
  if (!same(port.mdPlain(t.text), t.plain)) plainOk = false;
}
ok('mdInline: every line of the corpus tokenizes identically', inlineOk);
ok('mdParse: every text parses to identical nodes', parseOk);
ok('mdPlain: identical plain words', plainOk);

let outlineOk = true;
let pagesOk = true;
for (const s of G.stories) {
  if (!same(port.storyOutline(s.blocks), s.outline)) outlineOk = false;
  if (!same(port.storyPages(s.blocks), s.pages)) pagesOk = false;
}
ok('storyOutline: identical outlines', outlineOk);
ok('storyPages: identical page cuts (headings, levels, items, split text)', pagesOk);
ok('storyPages: a page per # / ## heading, the intro its own page',
  port.storyPages(G.stories[3].blocks).length === G.stories[3].pages.length && port.storyPages(G.stories[4].blocks).length === 3);

// Negative control: the comparison sees a difference when there is one.
ok('a changed text does not compare equal (negative control)', !same(port.mdParse('**x**'), G.texts[2].parse));

// plainParagraphs is storyPresent.ts's stPlainParagraphs, pinned by value here (it lived in a DOM script).
ok('plainParagraphs: lists become bullet / numbered lines, headings their words',
  same(port.plainParagraphs('## Head\n- a\n- **b**\n\n1. x\n2. y\n\nPara *one*'), ['Head', '• a\n• b', '1. x\n2. y', 'Para one']));

finish();
