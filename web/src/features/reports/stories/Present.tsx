// Present mode (storyPresent.ts): the story a page at a time — a new page at
// every # or ## heading, the same cut the outline and the PDF use
// (src/analysis/storyText.ts storyPages). → / Space / PageDown next, ← / PageUp
// back, Esc leaves. Full window, focus held inside (a Radix dialog, our styling).

import { useEffect, useState } from 'react';
import * as D from '@radix-ui/react-dialog';
import { storyPages } from '../../../../../src/analysis/storyText.ts';
import { IconButton } from '../../../ui/Button';
import { Icon } from '../../../ui/icons/Icon';
import { DrawnVisual } from '../../analyses/VisualTile';
import type { MetricFigure, StoryBlock, VisualFigure } from '../api';
import { Markdown } from './Markdown';
import pr from './Present.module.css';
import s from './Story.module.css';

export function Present({ projectId, name, blocks, figures, onExit }: { projectId: string; name: string; blocks: StoryBlock[]; figures: Record<string, VisualFigure | MetricFigure>; onExit: () => void }) {
  const pages = storyPages(blocks);
  const [i, setI] = useState(0);
  const go = (d: number) => setI((n) => Math.max(0, Math.min(pages.length - 1, n + d)));
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ') {
        e.preventDefault();
        go(1);
      } else if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
        e.preventDefault();
        go(-1);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });
  const page = pages[i] || pages[0];
  return (
    <D.Root open onOpenChange={(o) => !o && onExit()}>
      <D.Portal>
        <D.Content className={pr.present} aria-describedby={undefined}>
          <D.Title className={pr.srOnly}>Presenting {name}</D.Title>
          <div className={pr.presentPage} key={i}>
            {page.heading && (page.level === 1 ? <h1 className={pr.presentH}>{page.heading}</h1> : <h2 className={pr.presentH}>{page.heading}</h2>)}
            {page.items.map((it, j) => {
              const b = it.block;
              if (b.kind === 'text') return <Markdown key={j} src={it.text || ''} />;
              if (b.kind === 'callout') {
                return (
                  <div key={j} className={`${s.callout} ${s[`tone_${b.tone}`]}`}>
                    <span className={s.calloutIcon}>
                      <Icon name={b.tone === 'success' ? 'check' : b.tone === 'info' ? 'info' : 'alert'} />
                    </span>
                    <div className={s.calloutBody}>
                      <Markdown src={b.text} />
                    </div>
                  </div>
                );
              }
              if (b.kind === 'divider') return <hr key={j} className={s.hr} />;
              if (b.kind === 'image') {
                return (
                  <figure key={j} className={s.figure}>
                    <img className={s.img} src={b.src} alt={b.alt} />
                    {b.caption && <p className={pr.presentCaption}>{b.caption}</p>}
                  </figure>
                );
              }
              if (b.kind === 'visual') {
                const f = figures[b.id] as VisualFigure | undefined;
                if (!f || 'missing' in f) return null;
                const cap = b.caption && b.caption.trim() ? b.caption : f.caption;
                return (
                  <figure key={j} className={s.figure}>
                    <div className={s.figTitle}>{f.title}</div>
                    <div className={`${s.chart} ${s.chartPresent}`}>
                      {f.chart ? <DrawnVisual type={f.chart.type} data={f.chart.data} overrides={f.chart.overrides} label={f.title || 'Chart'} projectId={projectId} /> : <p className={s.figNote}>{f.note}</p>}
                    </div>
                    {cap && <p className={pr.presentCaption}>{cap}</p>}
                  </figure>
                );
              }
              const f = figures[b.id] as MetricFigure | undefined;
              return (
                <div key={j}>
                  <div className={b.kind === 'metric' ? `${s.metrics} ${s.metricsOne}` : s.metrics}>
                    {(f?.figures ?? []).map((m, k) => (
                      <div key={k} className={s.metric}>
                        <div className={s.metricValue}>{m.display}</div>
                        <div className={s.metricName}>{m.name}</div>
                      </div>
                    ))}
                  </div>
                  {b.kind === 'metric' && (b.caption || f?.caption) && <p className={pr.presentCaption}>{b.caption || f?.caption}</p>}
                </div>
              );
            })}
          </div>
          <div className={pr.presentBar}>
            <IconButton icon="chevron-left" label="Previous page" disabled={i === 0} onClick={() => go(-1)} />
            <span className={pr.presentCount} aria-live="polite">
              {i + 1} / {pages.length}
            </span>
            <IconButton icon="chevron-right" label="Next page" disabled={i >= pages.length - 1} onClick={() => go(1)} />
            <D.Close asChild>
              <IconButton icon="x" label="Exit presenting" />
            </D.Close>
          </div>
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}
