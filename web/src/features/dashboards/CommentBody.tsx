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
const SPLIT = /\uE000(\d+)\uE001/;

/** How a placeholder is put back: as words (code, a link's text, a `{{token}}`), or as the token itself (a link's target). */
interface Back {
  words: (v: string) => string;
  token: (href: string) => string;
}

function walk(nodes: Inline[], back: Back, inLink: boolean): Inline[] {
  return nodes.map((n): Inline => {
    if (n.t === 'text') return inLink ? { t: 'text', v: back.words(n.v) } : n;
    if (n.t === 'code') return { t: 'code', v: back.words(n.v) };
    if (n.t === 'token') return { t: 'token', name: back.words(n.name) };
    if (n.t === 'a') return { t: 'a', href: back.token(n.href), c: walk(n.c, back, true) };
    return { t: n.t, c: walk(n.c, back, inLink) };
  });
}

/** The tree with every placeholder outside ordinary text put back. */
function settle(blocks: Block[], back: Back): Block[] {
  return blocks.map((b): Block => {
    if (b.t === 'pre') return { t: 'pre', v: back.words(b.v) };
    if (b.t === 'h' || b.t === 'p') return { ...b, c: walk(b.c, back, false) };
    return { ...b, items: b.items.map((it) => walk(it, back, false)) };
  });
}

/** A placeholder in a link's target, as the URL parser left it (percent-encoded) or as typed. */
const IN_HREF = /(?:%EE%80%80|\uE000)(\d+)(?:%EE%80%81|\uE001)/gi;

export function CommentBody({ text, people }: { text: string; people?: Record<string, string> }) {
  const { text: safe, addresses } = protectMentions(text);
  const nameOf = (n: number): string | null => {
    const a = addresses[n];
    return a !== undefined && people && Object.hasOwn(people, a) ? (people[a] as string) : null;
  };
  const words = (v: string) => v.replace(PLACEHOLDER, (_m, n: string) => '@' + (nameOf(Number(n)) ?? FORMER));
  const chips = (v: string): ReactNode => {
    if (!v.includes('\uE000')) return v;
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
  // In a link's target the mention is put back as it was typed, so the link goes where its author meant.
  const token = (href: string) => href.replace(IN_HREF, (_m, n: string) => (addresses[Number(n)] !== undefined ? `@(${addresses[Number(n)]})` : ''));
  return <MarkdownBlocks blocks={settle(mdParse(safe), { words, token })} token={plain} text={chips} />;
}
