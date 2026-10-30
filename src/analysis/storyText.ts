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

// **bold**, `code`, *italic*, _italic_. Each scan stops at the next marker of
// its own kind, so one pass over a line is linear however many markers it holds.
const MARK_RE = /(\*\*([^*]+?)\*\*)|(`([^`]+?)`)|(\*([^*\s][^*]*?)\*)|(_([^_\s][^_]*?)_)/g;
const WS_RE = /\s/;

interface LinkHit { index: number; end: number; text: string; href: string }

/**
 * [text](url), found exactly as /\[([^\]]+?)\]\(([^)\s]+?)\)/ would — that regex
 * rescans to the end of the line from every '[' (n² on '['.repeat(n), NV-56).
 * Tables of the next '[', ']' and ')'-or-space make each '[' an O(1) check, and
 * every '[' before one ']' shares its fate, so finding links is one pass.
 */
function linkFinder(s: string): (from: number) => LinkHit | null {
  const n = s.length;
  const nextOpen = new Int32Array(n + 1).fill(-1);
  const nextClose = new Int32Array(n + 1).fill(-1);
  const nextStop = new Int32Array(n + 1).fill(-1);
  for (let i = n - 1; i >= 0; i--) {
    const c = s[i];
    nextOpen[i] = c === '[' ? i : nextOpen[i + 1];
    nextClose[i] = c === ']' ? i : nextClose[i + 1];
    nextStop[i] = c === ')' || WS_RE.test(c) ? i : nextStop[i + 1];
  }
  return (from) => {
    for (let i = nextOpen[from]; i !== -1; ) {
      const j = nextClose[i + 1];
      if (j === -1) return null;
      if (j > i + 1 && s[j + 1] === '(') {
        const k = nextStop[j + 2];
        if (k > j + 2 && s[k] === ')') return { index: i, end: k + 1, text: s.slice(i + 1, j), href: s.slice(j + 2, k) };
      }
      i = nextOpen[j + 1]; // every '[' before j reads the same ']', '(' and url: they fail too
    }
    return null;
  };
}

/** One line of inline Markdown → tokens. Unmatched markers stay literal. */
export function mdInline(src: string): Inl[] {
  const s = String(src || '');
  const out: Inl[] = [];
  const linkFrom = s.includes('[') ? linkFinder(s) : (): null => null;
  // The leftmost marker and the leftmost link from `pos`; kept while still ahead of it.
  let mark: RegExpExecArray | null | undefined;
  let link: LinkHit | null | undefined;
  let pos = 0;
  while (pos < s.length) {
    if (mark === undefined || (mark && mark.index < pos)) {
      MARK_RE.lastIndex = pos;
      mark = MARK_RE.exec(s);
    }
    if (link === undefined || (link && link.index < pos)) link = linkFrom(pos);
    if (!mark && !link) {
      out.push({ t: 'text', text: s.slice(pos) });
      break;
    }
    // Never a tie: a link starts with '[', every marker with another character.
    const hit = link && (!mark || link.index < mark.index) ? link : null;
    const at = hit ? hit.index : (mark as RegExpExecArray).index;
    if (at > pos) out.push({ t: 'text', text: s.slice(pos, at) });
    if (hit) {
      out.push({ t: 'link', text: hit.text, href: /^https?:\/\//i.test(hit.href) ? hit.href : '' });
      pos = hit.end;
    } else {
      const m = mark as RegExpExecArray;
      if (m[1]) out.push({ t: 'b', text: m[2] });
      else if (m[3]) out.push({ t: 'code', text: m[4] });
      else if (m[5]) out.push({ t: 'i', text: m[6] });
      else out.push({ t: 'i', text: m[8] });
      pos = m.index + m[0].length;
    }
  }
  // Merge neighbouring plain runs so a renderer draws one text node per run.
  return out.reduce((acc: Inl[], x) => {
    const last = acc[acc.length - 1];
    if (last && last.t === 'text' && x.t === 'text') last.text += x.text;
    else acc.push({ ...x });
    return acc;
  }, []);
}

// `(\S.*|)`, not `(.*)`: the same matches, but a \r or U+2028 inside a line fails
// at once instead of retrying (.*) from every space before it (n², NV-56).
const HEADING_RE = /^(#{1,3})\s+(\S.*|)$/;
const BULLET_RE = /^\s*[-*]\s+(\S.*|)$/;
const NUMBER_RE = /^\s*\d+[.)]\s+(\S.*|)$/;
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
      const text = trimNewlines(buf.join('\n'));
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

/** Leading and trailing newlines off; by index — /^\n+|\n+$/g is n² on a run of blank lines inside (NV-56). */
function trimNewlines(s: string): string {
  let a = 0;
  let b = s.length;
  while (a < b && s[a] === '\n') a++;
  while (b > a && s[b - 1] === '\n') b--;
  return s.slice(a, b);
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
