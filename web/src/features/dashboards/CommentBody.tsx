// A comment's body with its @mentions (docs/notifications/00-design.md §5.1).
// The address never reaches the Markdown parser: every `@(address)` is swapped
// for a private-use placeholder first (src/app/mentionToken.ts — the parser the
// server uses too), the text is parsed, and ONE walk over the tree puts the
// mentions back — as a chip in ordinary text, and as plain words inside a code
// span, a code block or a link. A name comes only from the server's `people`
// (current readers of the project); anyone else is "@former member".

import type { ReactNode } from 'react';
import { PLACEHOLDER, protectMentions } from '../../../../src/app/mentionToken.ts';
import { MarkdownBlocks } from './Markdown';
import { mdParse, type Block, type Inline } from './mdParse';
import s from './Mentions.module.css';

const FORMER = 'former member';
/** The text card's `{{token}}` reads as typed in a comment. */
const plain = (name: string) => ({ text: `{{${name}}}` });
const SPLIT = /(\d+)/;

function walk(nodes: Inline[], words: (v: string) => string, inLink: boolean): Inline[] {
  return nodes.map((n): Inline => {
    if (n.t === 'text') return inLink ? { t: 'text', v: words(n.v) } : n;
    if (n.t === 'code') return { t: 'code', v: words(n.v) };
    if (n.t === 'b' || n.t === 'i') return { t: n.t, c: walk(n.c, words, inLink) };
    if (n.t === 'a') return { ...n, c: walk(n.c, words, true) };
    return n;
  });
}

/** The tree with every placeholder outside ordinary text turned into words. */
function settle(blocks: Block[], words: (v: string) => string): Block[] {
  return blocks.map((b): Block => {
    if (b.t === 'pre') return { t: 'pre', v: words(b.v) };
    if (b.t === 'h' || b.t === 'p') return { ...b, c: walk(b.c, words, false) };
    return { ...b, items: b.items.map((it) => walk(it, words, false)) };
  });
}

export function CommentBody({ text, people }: { text: string; people?: Record<string, string> }) {
  const { text: safe, addresses } = protectMentions(text);
  const nameOf = (n: number): string | null => {
    const a = addresses[n];
    return a !== undefined && people && Object.hasOwn(people, a) ? (people[a] as string) : null;
  };
  const words = (v: string) => v.replace(PLACEHOLDER, (_m, n: string) => '@' + (nameOf(Number(n)) ?? FORMER));
  const chips = (v: string): ReactNode => {
    if (!v.includes('')) return v;
    return v.split(SPLIT).map((part, i) => {
      if (i % 2 === 0) return part;
      const n = Number(part);
      const name = nameOf(n);
      return name !== null ? (
        <span key={i} className={s.chip} title={addresses[n]}>
          @{name}
        </span>
      ) : (
        <span key={i} className={s.chipGone}>
          @{FORMER}
        </span>
      );
    });
  };
  return <MarkdownBlocks blocks={settle(mdParse(safe), words)} token={plain} text={chips} />;
}
