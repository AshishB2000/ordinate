// Self-check for the text card's Markdown subset (renderer/hub/markdown.ts):
// every construct, and the injection cases — rendered into a tiny fake DOM so
// the test sees exactly which elements and attributes the real one would get.
//
//   npm run build:ts && node scripts/test-markdown.js

import { ok, failureCount, finish } from './selfcheck';

// ponytail: markdown.js is a renderer UMD script, not a TS module (see test-geo-match.ts)
const md = require('../renderer/hub/markdown') as any;

class FakeEl {
  tag: string;
  children: any[] = [];
  attrs: Record<string, string> = {};
  className = '';
  private text: string | null = null;
  constructor(tag: string) { this.tag = tag; }
  appendChild(n: any): any { this.children.push(n); return n; }
  setAttribute(k: string, v: string): void { this.attrs[k] = String(v); }
  set textContent(v: string) { this.children = []; this.text = String(v); }
  get textContent(): string { return this.text !== null ? this.text : this.children.map((c) => c.textContent).join(''); }
}
const doc = {
  createElement: (t: string) => new FakeEl(t),
  createTextNode: (v: string) => ({ tag: '#text', textContent: v, children: [] }),
  createDocumentFragment: () => new FakeEl('#frag'),
};

/** A readable serialisation: tags and attributes, text escaped as the DOM would show it. */
function html(n: any): string {
  if (n.tag === '#text') return n.textContent.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const inner = n.children.length ? n.children.map(html).join('') : html({ tag: '#text', textContent: n.textContent });
  if (n.tag === '#frag') return inner;
  const all: Record<string, string> = n.className ? { ...n.attrs, class: n.className } : n.attrs;
  const attrs = Object.keys(all).sort().map((k) => ` ${k}="${all[k]}"`).join('');
  return `<${n.tag}${attrs}>${inner}</${n.tag}>`;
}
const render = (src: string, hooks?: any): string => html(md.mdRender(md.mdParse(src), doc, hooks));

function walk(n: any, visit: (el: any) => void): void {
  visit(n);
  for (const c of n.children || []) walk(c, visit);
}

// ── Every construct ──────────────────────────────────────────────────────────
ok('h1 renders as a card-level h3', render('# Title') === '<h3 class="md-h md-h1">Title</h3>', render('# Title'));
ok('## and ### step down', render('## A\n### B') === '<h4 class="md-h md-h2">A</h4><h5 class="md-h md-h3">B</h5>');
ok('a paragraph joins its lines', render('one\ntwo') === '<p>one two</p>');
ok('a blank line starts a new paragraph', render('one\n\ntwo') === '<p>one</p><p>two</p>');
ok('**bold** and __bold__', render('**a** __b__') === '<p><strong>a</strong> <strong>b</strong></p>');
ok('*italic* and _italic_', render('*a* _b_') === '<p><em>a</em> <em>b</em></p>');
ok('bold holds italic', render('**x *y***').startsWith('<p><strong>x <em>y</em>'), render('**x *y***'));
ok('`code` is literal', render('`**not bold**`') === '<p><code>**not bold**</code></p>');
ok('- * + are bullets', render('- a\n* b\n+ c') === '<ul><li>a</li><li>b</li><li>c</li></ul>');
ok('1. and 2) are numbered', render('1. a\n2) b') === '<ol><li>a</li><li>b</li></ol>');
ok('a list item carries inline markup', render('- **a** `b`') === '<ul><li><strong>a</strong> <code>b</code></li></ul>');
ok('a list ends at a non-item line', render('- a\nnext') === '<ul><li>a</li></ul><p>next</p>');
ok('a fence is a code block, verbatim', render('```\n# not a heading\n<b>\n```') === '<pre><code># not a heading\n&lt;b&gt;</code></pre>');
ok('an https link', render('[docs](https://example.com/a?b=1)') === '<p><a href="https://example.com/a?b=1" rel="noopener noreferrer">docs</a></p>', render('[docs](https://example.com/a?b=1)'));
ok('a link text keeps its markup', render('[**x**](https://e.org)').includes('<strong>x</strong>'));
ok('\\* escapes a delimiter', render('\\*not italic\\*') === '<p>*not italic*</p>');
ok('an unmatched delimiter is plain text', render('2 * 3 and a_b') === '<p>2 * 3 and a_b</p>');
ok('{{token}} is a token span', render('Revenue {{ Revenue }}') === '<p>Revenue <span class="md-token" data-token="Revenue">{{Revenue}}</span></p>', render('Revenue {{ Revenue }}'));
ok('a bold token', render('**{{Revenue}}**') === '<p><strong><span class="md-token" data-token="Revenue">{{Revenue}}</span></strong></p>');
ok('mdTokens lists names once, in order', JSON.stringify(md.mdTokens('{{A}} **{{B}}** - {{A}}\n1. [x {{C}}](https://e.org)')) === '["A","B","C"]');
{
  const seen: string[] = [];
  render('**{{Revenue}}** and {{Profit}}', { token: (n: string, el: any) => { seen.push(n); el.textContent = n === 'Revenue' ? '$5.2M' : '—'; } });
  const out = render('**{{Revenue}}**', { token: (_n: string, el: any) => { el.textContent = '$5.2M'; } });
  ok('the token hook fills the span — 5.2M in bold', out.includes('<strong><span class="md-token" data-token="Revenue">$5.2M</span></strong>'), out);
  ok('…and is called once per token', seen.join() === 'Revenue,Profit');
}
{
  const links: string[] = [];
  render('[a](https://a.org) [b](https://b.org)', { link: (_a: any, href: string) => links.push(href) });
  ok('the link hook sees every safe link', links.join() === 'https://a.org/,https://b.org/', links.join());
}
ok('empty input renders nothing', render('') === '' && render('\n\n') === '');
ok('CRLF line endings parse like LF', render('# A\r\n- b') === '<h3 class="md-h md-h1">A</h3><ul><li>b</li></ul>');

// ── Injection ────────────────────────────────────────────────────────────────
const nasty = [
  '<script>alert(1)</script>',
  '<img src=x onerror=alert(1)>',
  '[click](javascript:alert(1))',
  '[click](JaVaScRiPt:alert(1))',
  '[x](data:text/html;base64,PHNjcmlwdD4=)',
  '[x](//evil.example/path)',
  '[x](vbscript:msgbox)',
  '[x](https://ok.org" onclick="alert(1))',
  '**<b onmouseover=alert(1)>**',
  '{{<img src=x onerror=alert(1)>}}',
  '<a href="javascript:alert(1)">x</a>',
  '```\n</code><script>alert(1)</script>\n```',
  '# <iframe src=https://evil.org>',
];
const TAGS = new Set(['#frag', '#text', 'h3', 'h4', 'h5', 'p', 'strong', 'em', 'code', 'pre', 'ul', 'ol', 'li', 'a', 'span']);
const ATTRS = new Set(['href', 'rel', 'data-token']);
for (const src of nasty) {
  const tree = md.mdRender(md.mdParse(src), doc);
  let bad = '';
  walk(tree, (el) => {
    if (!TAGS.has(el.tag)) bad = 'tag ' + el.tag;
    for (const k of Object.keys(el.attrs || {})) if (!ATTRS.has(k)) bad = 'attribute ' + k;
    if (el.attrs && el.attrs.href !== undefined && !/^https?:\/\/[^\s"<>]+$/.test(el.attrs.href)) bad = 'href ' + el.attrs.href;
  });
  ok(`injection: ${JSON.stringify(src)} builds only safe elements`, bad === '', bad);
}
ok('injection: <script> is seven characters of text', render('<script>alert(1)</script>') === '<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>');
ok('injection: a javascript: link keeps its words and loses the link', render('[click](javascript:alert(1))') === '<p>click</p>');
ok('injection: a quoted payload inside an https link is refused whole', !render('[x](https://ok.org" onclick="alert(1))').includes('<a'));
ok('injection: a protocol-relative link is not a link', render('[x](//evil.example/path)') === '<p>x</p>');
ok('safeHref: only http and https survive', md.safeHref('https://a.b/c') === 'https://a.b/c' && md.safeHref('mailto:a@b.c') === null && md.safeHref('ftp://a.b') === null);

console.log(failureCount() ? `\n${failureCount()} markdown check(s) FAILED.` : '\nAll markdown checks passed.');
finish();
