// Self-check for src/analysis/storyText.ts — the story's Markdown subset, the
// OUTLINE built from its headings, and the PAGE MAPPING present mode and the
// PDF export share. The server's report pages and the web story editor both
// import this module, so this is the code the page runs. (These checks pinned
// the desktop's storyText.js until the T8.1 cutover; test-storyTextPort.ts
// holds this module to that file's recorded answers.)
//
//   npm run build:ts && node scripts/test-storyText.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';

// any: the checks below index loosely into tokens, nodes and pages
const S = require('../src/analysis/storyText') as {
  mdInline: (s: string) => Array<{ t: string; text: string; href?: string }>;
  mdParse: (s: string) => any[];
  mdPlain: (s: string) => string;
  storyOutline: (b: any[]) => Array<{ blockId: string; level: number; text: string }>;
  storyPages: (b: any[]) => Array<{ heading: string; level: number; items: Array<{ block: any; text?: string }> }>;
};

// ── Inline ──────────────────────────────────────────────────────────────────
const inl = S.mdInline('Revenue **rose** in *Q3*, see `order_date` and [the docs](https://example.com).');
ok('inline: bold, italic, code and a link become tokens',
  JSON.stringify(inl.map((x) => x.t)) === '["text","b","text","i","text","code","text","link","text"]', JSON.stringify(inl));
ok('inline: a link keeps an http(s) URL', inl.find((x) => x.t === 'link')?.href === 'https://example.com');
ok('inline: a javascript: link keeps its text and loses its URL',
  S.mdInline('[x](javascript:alert(1))').some((x) => x.t === 'link' && x.href === ''));
ok('inline: markup is TEXT, never parsed as HTML', S.mdInline('<img src=x onerror=alert(1)>')[0].text === '<img src=x onerror=alert(1)>');
ok('inline: an unmatched marker stays literal', S.mdPlain('2 * 3 = 6 and **unclosed') === '2 * 3 = 6 and **unclosed');
ok('inline: _underscores_ are italic', S.mdInline('an _aside_').some((x) => x.t === 'i' && x.text === 'aside'));
ok('plain: markers stripped for exports', S.mdPlain('**West** leads *revenue*') === 'West leads revenue');

// ── Block level ─────────────────────────────────────────────────────────────
const nodes = S.mdParse('# Title\n\nFirst line\nsecond line\n\n- a\n- b\n1. one\n2. two\n> quoted\n### Small');
ok('parse: heading, a joined paragraph, a bullet list, a numbered list, a quote, a heading',
  JSON.stringify(nodes.map((n) => n.t)) === '["h","p","ul","ol","quote","h"]', JSON.stringify(nodes.map((n) => n.t)));
ok('parse: heading levels', nodes[0].level === 1 && nodes[5].level === 3);
ok('parse: a paragraph keeps its line break', nodes[1].inl[0].text === 'First line\nsecond line');
ok('parse: list items', nodes[2].items.length === 2 && nodes[3].items.length === 2);
ok('parse: #### is not a heading (the subset stops at three)', S.mdParse('#### deep')[0].t === 'p');
ok('parse: "#hashtag" with no space is not a heading', S.mdParse('#sales tag')[0].t === 'p');
ok('parse: empty source → nothing', S.mdParse('').length === 0 && S.mdParse('\n\n  \n').length === 0);

// ── Outline ─────────────────────────────────────────────────────────────────
const blocks = [
  { id: 'a', kind: 'text', text: '# Q4 review\nWhere the quarter landed.' },
  { id: 'b', kind: 'metrics_row', metricIds: [] },
  { id: 'c', kind: 'text', text: '## Revenue\nWest **leads**.\n### By category\nTechnology carries it.' },
  { id: 'd', kind: 'visual', visualId: 'v1' },
  { id: 'e', kind: 'callout', tone: 'info', text: '## Not a heading in a callout' },
  { id: 'f', kind: 'text', text: 'Intro to margin\n## Margin\nThin in Furniture.' },
  { id: 'g', kind: 'divider' },
  { id: 'h', kind: 'text', text: '' },
];
const outline = S.storyOutline(blocks);
ok('outline: every heading in reading order, with its level and block',
  JSON.stringify(outline) === JSON.stringify([
    { blockId: 'a', level: 1, text: 'Q4 review' },
    { blockId: 'c', level: 2, text: 'Revenue' },
    { blockId: 'c', level: 3, text: 'By category' },
    { blockId: 'f', level: 2, text: 'Margin' },
  ]), JSON.stringify(outline));
ok('outline: inline markers are stripped from entries', S.storyOutline([{ id: 'x', kind: 'text', text: '## **Bold** heading' }])[0].text === 'Bold heading');
ok('outline: a callout\'s "##" is its text, not a section', !outline.some((h) => h.blockId === 'e'));
ok('outline: none → empty', S.storyOutline([{ id: 'x', kind: 'text', text: 'just prose' }]).length === 0);

// ── Page mapping ────────────────────────────────────────────────────────────
const pages = S.storyPages(blocks);
ok('pages: one per # / ## heading — ### stays inside its section',
  JSON.stringify(pages.map((p) => [p.heading, p.level])) === '[["Q4 review",1],["Revenue",2],["Margin",2]]',
  JSON.stringify(pages.map((p) => [p.heading, p.level])));
ok('pages: the heading line is removed from the page body (the page prints it)',
  pages[0].items[0].text === 'Where the quarter landed.' && pages[1].items[0].text === 'West **leads**.\n### By category\nTechnology carries it.',
  JSON.stringify(pages.map((p) => p.items.map((i) => i.text))));
ok('pages: non-text blocks land on the page they follow', pages[0].items[1].block.id === 'b'
  && pages[1].items.map((i) => i.block.id).join() === 'c,d,e,f');
ok('pages: a text block holding a heading mid-way is SPLIT at it',
  pages[1].items[3].text === 'Intro to margin' && pages[2].items[0].block.id === 'f' && pages[2].items[0].text === 'Thin in Furniture.');
ok('pages: empty text contributes nothing', !pages[2].items.some((i) => i.block.id === 'h'));
ok('pages: the divider stays on its page', pages[2].items.some((i) => i.block.id === 'g'));
const lead = S.storyPages([{ id: 'p', kind: 'text', text: 'Before any heading' }, { id: 'q', kind: 'text', text: '## One' }]);
ok('pages: prose before the first heading is a page with no heading', lead[0].heading === '' && lead[0].items[0].text === 'Before any heading' && lead[1].heading === 'One');
ok('pages: an empty story still has one page to present', S.storyPages([]).length === 1 && S.storyPages([])[0].heading === '');
ok('pages: a heading with no body is still a page', S.storyPages([{ id: 'z', kind: 'text', text: '## Empty section' }])[0].items.length === 0);


// ── NV-56: linear on hostile text, same tokens as the regexes it replaced ────
// The reference is the parser as it was (one alternation, (.*) line rules, the
// edge-trim regex): agreement is checked on a seeded corpus of marker soup.
const OLD_INLINE = /(\*\*([^*]+?)\*\*)|(`([^`]+?)`)|(\[([^\]]+?)\]\(([^)\s]+?)\))|(\*([^*\s][^*]*?)\*)|(_([^_\s][^_]*?)_)/;
function oldInline(src: string): Array<{ t: string; text: string; href?: string }> {
  const out: Array<{ t: string; text: string; href?: string }> = [];
  let rest = String(src || '');
  while (rest) {
    const m = OLD_INLINE.exec(rest);
    if (!m) { out.push({ t: 'text', text: rest }); break; }
    if (m.index > 0) out.push({ t: 'text', text: rest.slice(0, m.index) });
    if (m[1]) out.push({ t: 'b', text: m[2] });
    else if (m[3]) out.push({ t: 'code', text: m[4] });
    else if (m[5]) out.push({ t: 'link', text: m[6], href: /^https?:\/\//i.test(m[7]) ? m[7] : '' });
    else if (m[8]) out.push({ t: 'i', text: m[9] });
    else out.push({ t: 'i', text: m[11] });
    rest = rest.slice(m.index + m[0].length);
  }
  return out.reduce((acc: Array<{ t: string; text: string; href?: string }>, x) => {
    const last = acc[acc.length - 1];
    if (last && last.t === 'text' && x.t === 'text') last.text += x.text;
    else acc.push({ ...x });
    return acc;
  }, []);
}
const OLD_LINE = [/^(#{1,3})\s+(.*)$/, /^\s*[-*]\s+(.*)$/, /^\s*\d+[.)]\s+(.*)$/];
const NEW_LINE = [/^(#{1,3})\s+(\S.*|)$/, /^\s*[-*]\s+(\S.*|)$/, /^\s*\d+[.)]\s+(\S.*|)$/];
let seed = 56;
const rnd = (n: number): number => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
const SOUP = ['[', ']', '(', ')', '*', '**', '_', '`', ' ', 'a', 'b', 'https://x.io/', '\r', ' ', '\t', '#', '-', '1.', '\n'];
let inlineSame = 0;
let lineSame = 0;
const CASES = 4000;
for (let c = 0; c < CASES; c++) {
  let t = '';
  for (let k = 1 + rnd(24); k > 0; k--) t += SOUP[rnd(SOUP.length)];
  if (JSON.stringify(S.mdInline(t)) === JSON.stringify(oldInline(t))) inlineSame++;
  const line = t.replace(/\n/g, '');
  if (OLD_LINE.every((re, i) => JSON.stringify(re.exec(line)) === JSON.stringify(NEW_LINE[i].exec(line)))) lineSame++;
}
ok(`NV-56: mdInline gives the old regex's tokens on ${CASES} marker-soup lines`, inlineSame === CASES, `${CASES - inlineSame} differ`);
ok('NV-56: the heading / bullet / number rules match exactly what they matched', lineSame === CASES, `${CASES - lineSame} differ`);
ok('NV-56: a link inside marker soup still parses', JSON.stringify(S.mdInline('[[x](https://a.io) *[b](c*')) === JSON.stringify(oldInline('[[x](https://a.io) *[b](c*')));

const ms = (fn: () => unknown): number => { const t0 = process.hrtime.bigint(); fn(); return Number(process.hrtime.bigint() - t0) / 1e6; };
const N = 20_000; // MAX_TEXT, one block's worst case
const hostile: Array<[string, () => unknown]> = [
  ["'['.repeat(n)", () => S.mdInline('['.repeat(N))],
  ["'[a](x'.repeat(n/5)", () => S.mdInline('[a](x'.repeat(N / 5))],
  ["'*[a](b'.repeat(n/7) + ')'", () => S.mdInline('*[a](b'.repeat(N / 7) + ')')],
  ['a run of blank lines inside a page', () => S.storyPages([{ id: 'b', kind: 'text', text: 'x' + '\n'.repeat(N) + 'x' }])],
  ['a heading with a \\r after its spaces', () => S.mdParse('# ' + ' '.repeat(N) + 'a\rb')],
  ['a bullet with a U+2028 after its spaces', () => S.mdParse('- ' + ' '.repeat(N) + 'a b')],
];
for (const [label, fn] of hostile) {
  const took = ms(fn);
  ok(`NV-56: ${label} at ${N} characters parses in well under a second`, took < 100, `${took.toFixed(1)} ms`);
}
const fresh = ms(() => S.mdInline('['.repeat(N)));
const control = ms(() => oldInline('['.repeat(N)));
ok("NV-56 control: the old regex on '['.repeat(n) is the n² case — many times slower", control > 10 * fresh, `${control.toFixed(1)} ms vs ${fresh.toFixed(2)} ms`);

finish();
