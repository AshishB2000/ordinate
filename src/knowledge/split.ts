// A document's text into passages (docs/knowledge-docs/00-design.md, "Passages and matching"). PURE, deterministic:
// the same text always gives the same passages.
//
// Break at Markdown headings and blank lines; carry the latest heading path ("Revenue › Refunds") onto every passage
// under it; merge small paragraphs up to MAX_PASSAGE_CHARS; cut an oversized paragraph at a sentence end (a hard cut
// only when it has none). A passage's text is one line: its whitespace is squeezed to single spaces.

import { MAX_PASSAGE_CHARS } from './limits';

export interface Passage {
  ord: number;
  /** The heading path, "Revenue › Refunds"; '' above the first heading. */
  heading: string;
  text: string;
}

const HEADING = /^ {0,3}(#{1,6})[ \t]+(.*?)[ \t]*#*[ \t]*$/;
const SENTENCE_END = /[.!?…][)"'”’\]]*\s/g;

/** `s` cut so it never ends inside a surrogate pair. */
const safeEnd = (s: string, end: number): number => {
  const c = s.charCodeAt(end - 1);
  return c >= 0xd800 && c <= 0xdbff ? end - 1 : end;
};

/** An over-long paragraph in pieces of at most `max`, each ending at a sentence end where one exists. */
function cut(par: string, max: number): string[] {
  const out: string[] = [];
  let rest = par;
  while (rest.length > max) {
    let end = 0;
    for (const m of rest.slice(0, max + 1).matchAll(SENTENCE_END)) end = m.index + m[0].length - 1; // the stop's own end; the space after it is dropped
    if (!end) end = safeEnd(rest, max);
    out.push(rest.slice(0, end).trim());
    rest = rest.slice(end).trim();
  }
  if (rest) out.push(rest);
  return out;
}

export function splitText(text: string, max: number = MAX_PASSAGE_CHARS): Passage[] {
  const out: Passage[] = [];
  const path: string[] = [];
  let heading = '';
  let pars: string[] = [];
  let lines: string[] = [];
  const endParagraph = (): void => {
    const p = lines.join(' ').replace(/\s+/g, ' ').trim();
    lines = [];
    if (p) pars.push(p);
  };
  const flush = (): void => {
    endParagraph();
    let cur = '';
    const push = (): void => {
      if (cur) out.push({ ord: out.length, heading, text: cur });
      cur = '';
    };
    for (const p of pars) {
      for (const piece of p.length > max ? cut(p, max) : [p]) {
        if (cur && cur.length + 1 + piece.length > max) push();
        cur = cur ? `${cur} ${piece}` : piece;
      }
    }
    push();
    pars = [];
  };
  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    const h = HEADING.exec(line);
    if (h) {
      flush();
      const level = h[1].length;
      path.length = Math.min(path.length, level - 1);
      while (path.length < level - 1) path.push(''); // a skipped level leaves a gap, not a made-up title
      if (h[2]) path[level - 1] = h[2];
      else path.length = level - 1;
      heading = path.filter(Boolean).join(' › ');
    } else if (!line.trim()) endParagraph();
    else lines.push(line);
  }
  flush();
  return out;
}
