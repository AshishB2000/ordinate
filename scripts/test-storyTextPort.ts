// DIFFERENTIAL: src/analysis/storyText.ts (the server's and the browser's copy,
// T2.13) against renderer/hub/storyText.js (the desktop's, which
// scripts/test-storyText.ts pins to exact behaviour). One corpus, every export,
// Object.is at every leaf — so the outline the web page draws, the pages present
// mode flips through and the pages the export prints are the desktop's.
//
//   npm run build:ts && node scripts/test-storyTextPort.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import * as port from '../src/analysis/storyText';

// any: the legacy module is an untyped IIFE export
const legacy = require('../renderer/hub/storyText.js') as Record<string, (x: any) => unknown>;

function same(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || !a || !b) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  return ka.join() === kb.join() && ka.every((k) => same((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

const TEXTS = [
  '',
  '\n\n  \n',
  'Revenue **rose** in *Q3*, see `order_date` and [the docs](https://example.com).',
  '[x](javascript:alert(1))',
  '<img src=x onerror=alert(1)>',
  '2 * 3 = 6 and **unclosed',
  'an _aside_ and __double__ and ***triple***',
  '# Title\n\nFirst line\nsecond line\n\n- a\n- b\n1. one\n2. two\n> quoted\n### Small',
  '#### deep\n#sales tag\n##  spaced  heading  ',
  'Intro before any heading\n## Section one\nBody of one\n\n## Section two\n- x\n* y\n3) three',
  '# One\n### stays inside\ntext\n# Two',
  'trailing spaces   \n\t\n> q1\n> q2\nplain',
];

let inlineOk = true;
let parseOk = true;
let plainOk = true;
for (const t of TEXTS) {
  for (const line of t.split('\n')) if (!same(port.mdInline(line), legacy.mdInline(line))) inlineOk = false;
  if (!same(port.mdParse(t), legacy.mdParse(t))) parseOk = false;
  if (!same(port.mdPlain(t), legacy.mdPlain(t))) plainOk = false;
}
ok('mdInline: every line of the corpus tokenizes identically', inlineOk);
ok('mdParse: every text parses to identical nodes', parseOk);
ok('mdPlain: identical plain words', plainOk);

const STORIES = [
  [],
  [{ id: 'a', kind: 'text', text: '' }],
  [{ id: 'a', kind: 'visual', visualId: 'v' }, { id: 'b', kind: 'text', text: 'Hello' }],
  TEXTS.map((text, i) => ({ id: 't' + i, kind: 'text', text })),
  [
    { id: 'h', kind: 'text', text: '# Revenue\nIt grew.\n## By region\nWest leads.' },
    { id: 'v', kind: 'visual', visualId: 'v1' },
    { id: 'm', kind: 'metrics_row', metricIds: ['m1'] },
    { id: 'c', kind: 'callout', tone: 'info', text: '# not a page break' },
    { id: 'd', kind: 'divider' },
    { id: 'z', kind: 'text', text: '### small\nstill section two\n# Close\n' },
  ],
];
let outlineOk = true;
let pagesOk = true;
for (const blocks of STORIES) {
  if (!same(port.storyOutline(blocks), legacy.storyOutline(blocks))) outlineOk = false;
  if (!same(port.storyPages(blocks), legacy.storyPages(blocks))) pagesOk = false;
}
ok('storyOutline: identical outlines', outlineOk);
ok('storyPages: identical page cuts (headings, levels, items, split text)', pagesOk);
ok('storyPages: a page per # / ## heading, the intro its own page', port.storyPages(STORIES[3]).length === (legacy.storyPages(STORIES[3]) as unknown[]).length && port.storyPages(STORIES[4]).length === 3);

// plainParagraphs is storyPresent.ts's stPlainParagraphs, pinned by value here (it lived in a DOM script).
ok('plainParagraphs: lists become bullet / numbered lines, headings their words',
  same(port.plainParagraphs('## Head\n- a\n- **b**\n\n1. x\n2. y\n\nPara *one*'), ['Head', '• a\n• b', '1. x\n2. y', 'Para one']));

finish();
