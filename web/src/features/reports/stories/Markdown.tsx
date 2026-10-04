// A story's Markdown subset drawn as React elements (storyBlocks.ts
// stMarkdownDom). The tokens come from the shared parser
// (src/analysis/storyText.ts) and are only ever TEXT here — no string becomes
// markup. A link is its text, with its URL as the title (it never navigates
// out of the app from inside an editable document).

import { mdParse, type Inl } from '../../../../../src/analysis/storyText.ts';
import s from './Story.module.css';

function Inline({ inl }: { inl: Inl[] }) {
  return inl.map((x, i) => {
    if (x.t === 'b') return <strong key={i}>{x.text}</strong>;
    if (x.t === 'i') return <em key={i}>{x.text}</em>;
    if (x.t === 'code') return <code key={i}>{x.text}</code>;
    if (x.t === 'link') return <span key={i} className={s.link} title={x.href || undefined}>{x.text}</span>;
    return <span key={i}>{x.text}</span>;
  });
}

export function Markdown({ src }: { src: string }) {
  return (
    <div className={s.md}>
      {mdParse(src).map((n, i) => {
        if (n.t === 'h') {
          const H = (`h${Math.min(3, n.level) + 1}`) as 'h2' | 'h3' | 'h4';
          return (
            <H key={i} className={s[`h${n.level}`]}>
              <Inline inl={n.inl} />
            </H>
          );
        }
        if (n.t === 'ul' || n.t === 'ol') {
          const L = n.t;
          return (
            <L key={i}>
              {n.items.map((it, j) => (
                <li key={j}>
                  <Inline inl={it} />
                </li>
              ))}
            </L>
          );
        }
        if (n.t === 'quote') {
          return (
            <blockquote key={i}>
              <Inline inl={n.inl} />
            </blockquote>
          );
        }
        return n.t === 'p' ? (
          <p key={i}>
            <Inline inl={n.inl} />
          </p>
        ) : null;
      })}
    </div>
  );
}
