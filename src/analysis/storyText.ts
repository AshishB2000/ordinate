// STORY TEXT — the Markdown subset a story's text blocks are written in, the
// outline built from their headings, and the page mapping present mode and the
// export share. PURE: no DOM, no Node imports, so the server (a story's export
// pages, src/analysis/reportPages.ts) and the browser (web/src/features/
// reports/stories) import the SAME file and cannot disagree about where a page
// starts.
//
// A port of the desktop's storyText.ts as an ES module; scripts/
// test-storyTextPort.ts runs both over one corpus and compares with Object.is.
// The legacy copy goes with the renderer at cutover (T8.1).
//
// THE SUBSET. Block level: `#`, `##`, `###` headings; paragraphs (lines joined,
// blank line between); `- ` / `* ` bullets; `1. ` numbered items; `> ` quotes.
// Inline: **bold**, *italic* / _italic_, `code`, [text](url). Anything else is
// literal text. The parser returns TOKENS, never HTML — a renderer builds
// elements from them as text, so no text in a story can become markup.

export type Inl = { t: 'text' | 'b' | 'i' | 'code' | 'link'; text: string; href?: string };
export type MdNode =
  | { t: 'h'; level: number; text: string; inl: Inl[] }
  | { t: 'p'; inl: Inl[] }
  | { t: 'quote'; inl: Inl[] }
  | { t: 'ul' | 'ol'; items: Inl[][] };

/** The fields of a story block this file reads (src/analysis/storyModel.ts owns the shape). */
export interface StoryBlockLike {
  id: string;
  kind: string;
  text?: string;
}
export interface StoryPageItem<B extends StoryBlockLike = StoryBlockLike> {
  block: B;
  text?: string;
}
export interface StoryPage<B extends StoryBlockLike = StoryBlockLike> {
  heading: string;
  level: number;
  items: StoryPageItem<B>[];
}

const INLINE_RE = /(\*\*([^*]+?)\*\*)|(`([^`]+?)`)|(\[([^\]]+?)\]\(([^)\s]+?)\))|(\*([^*\s][^*]*?)\*)|(_([^_\s][^_]*?)_)/;

/** One line of inline Markdown → tokens. Unmatched markers stay literal. */
export function mdInline(src: string): Inl[] {
  const out: Inl[] = [];
  let rest = String(src || '');
  while (rest) {
    const m = INLINE_RE.exec(rest);
    if (!m) {
      out.push({ t: 'text', text: rest });
      break;
    }
    if (m.index > 0) out.push({ t: 'text', text: rest.slice(0, m.index) });
    if (m[1]) out.push({ t: 'b', text: m[2] });
    else if (m[3]) out.push({ t: 'code', text: m[4] });
    else if (m[5]) out.push({ t: 'link', text: m[6], href: /^https?:\/\//i.test(m[7]) ? m[7] : '' });
    else if (m[8]) out.push({ t: 'i', text: m[9] });
    else out.push({ t: 'i', text: m[11] });
    rest = rest.slice(m.index + m[0].length);
  }
  // Merge neighbouring plain runs so a renderer draws one text node per run.
  return out.reduce((acc: Inl[], x) => {
    const last = acc[acc.length - 1];
    if (last && last.t === 'text' && x.t === 'text') last.text += x.text;
    else acc.push({ ...x });
    return acc;
  }, []);
}

const HEADING_RE = /^(#{1,3})\s+(.*)$/;
const BULLET_RE = /^\s*[-*]\s+(.*)$/;
const NUMBER_RE = /^\s*\d+[.)]\s+(.*)$/;
const QUOTE_RE = /^\s*>\s?(.*)$/;

/** A text block's source → block-level tokens. */
export function mdParse(src: string): MdNode[] {
  const nodes: MdNode[] = [];
  let para: string[] = [];
  let list: { t: 'ul' | 'ol'; items: Inl[][] } | null = null;
  const flushPara = (): void => {
    if (para.length) nodes.push({ t: 'p', inl: mdInline(para.join('\n')) });
    para = [];
  };
  const flushList = (): void => {
    if (list) nodes.push(list);
    list = null;
  };
  for (const raw of String(src || '').split('\n')) {
    const line = raw.trimEnd(); // not /\s+$/: quadratic on a long run of spaces (T6.4: 100k spaces + x = 28 s); same character set
    let m: RegExpExecArray | null;
    if (!line.trim()) {
      flushPara();
      flushList();
      continue;
    }
    if ((m = HEADING_RE.exec(line))) {
      flushPara();
      flushList();
      nodes.push({ t: 'h', level: m[1].length, text: mdPlain(m[2]), inl: mdInline(m[2]) });
    } else if ((m = BULLET_RE.exec(line)) || (m = NUMBER_RE.exec(line))) {
      const kind: 'ul' | 'ol' = BULLET_RE.test(line) ? 'ul' : 'ol';
      flushPara();
      if (!list || list.t !== kind) {
        flushList();
        list = { t: kind, items: [] };
      }
      list.items.push(mdInline(m[1]));
    } else if ((m = QUOTE_RE.exec(line))) {
      flushPara();
      flushList();
      nodes.push({ t: 'quote', inl: mdInline(m[1]) });
    } else {
      flushList();
      para.push(line.trim());
    }
  }
  flushPara();
  flushList();
  return nodes;
}

/** Markdown → the plain words, for excerpts, exports and search. */
export function mdPlain(src: string): string {
  return mdInline(String(src || ''))
    .map((x) => x.text)
    .join('');
}

/** Every heading in a story, in reading order — the left outline. */
export function storyOutline(blocks: readonly StoryBlockLike[]): { blockId: string; level: number; text: string }[] {
  const out: { blockId: string; level: number; text: string }[] = [];
  for (const b of Array.isArray(blocks) ? blocks : []) {
    if (!b || b.kind !== 'text') continue;
    for (const n of mdParse(b.text || '')) {
      if (n.t === 'h' && n.text.trim()) out.push({ blockId: String(b.id), level: n.level, text: n.text.trim() });
    }
  }
  return out;
}

/**
 * The story cut into PAGES: a new page at every `#` or `##` heading, `###`
 * staying inside its section. A text block holding a heading mid-way is split
 * at it, so the heading always OPENS its page. Anything before the first
 * heading is a page with no heading of its own. A text item carries its text
 * with that page's own heading line removed, since the page prints it.
 */
export function storyPages<B extends StoryBlockLike>(blocks: readonly B[]): StoryPage<B>[] {
  const pages: StoryPage<B>[] = [];
  let cur: StoryPage<B> | null = null;
  const open = (heading: string, level: number): StoryPage<B> => {
    const p: StoryPage<B> = { heading, level, items: [] };
    pages.push(p);
    return p;
  };
  for (const b of Array.isArray(blocks) ? blocks : []) {
    if (!b) continue;
    if (b.kind !== 'text') {
      cur = cur || open('', 0);
      cur.items.push({ block: b });
      continue;
    }
    let buf: string[] = [];
    const flush = (): void => {
      const text = buf.join('\n').replace(/^\n+|\n+$/g, '');
      if (text.trim()) {
        cur = cur || open('', 0);
        cur.items.push({ block: b, text });
      }
      buf = [];
    };
    for (const line of String(b.text || '').split('\n')) {
      const m = HEADING_RE.exec(line.trimEnd());
      if (m && m[1].length <= 2 && m[2].trim()) {
        flush();
        cur = open(mdPlain(m[2]).trim(), m[1].length);
      } else {
        buf.push(line);
      }
    }
    flush();
  }
  // A story with no content at all still has one (empty) page to present.
  return pages.length ? pages : [{ heading: '', level: 0, items: [] }];
}

/** A text item's Markdown → the paragraphs a report page prints (lists as bullets). storyPresent.ts stPlainParagraphs. */
export function plainParagraphs(src: string): string[] {
  const out: string[] = [];
  const plain = (inl: Inl[]): string => inl.map((x) => x.text).join('');
  for (const n of mdParse(src)) {
    if (n.t === 'ul' || n.t === 'ol') out.push(n.items.map((it, i) => (n.t === 'ol' ? `${i + 1}. ` : '• ') + plain(it)).join('\n'));
    else if (n.t === 'h') out.push(n.text);
    else if (n.t === 'p' || n.t === 'quote') out.push(plain(n.inl));
  }
  return out;
}
