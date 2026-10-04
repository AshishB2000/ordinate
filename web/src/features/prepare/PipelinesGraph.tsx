// The Pipelines graph (legacy pipelinesGraph.ts): six stage columns of step
// cards — the browser lays the cards out — and the edges drawn over them in one
// SVG, measured off the laid-out cards and redrawn when the graph resizes. The
// server already ordered each column to keep crossings down. Hovering (or
// selecting) a card lights its whole path, upstream and down.

import { useLayoutEffect, useRef, useState } from 'react';
import { Icon } from '../../ui/icons/Icon';
import type { PipelineNode, PipelineView } from './pipelinesApi';
import { dur, iconFor, KIND, nextText, relTime, STATUS, statusOf } from './pipelineFormat';
import s from './Pipelines.module.css';

/** Every node on `id`'s path: itself, all it feeds, all that feeds it. */
function pathOf(id: string | null, edges: PipelineView['edges']): Set<string> {
  const rel = new Set<string>();
  if (!id) return rel;
  rel.add(id);
  for (const dir of ['down', 'up'] as const) {
    const stack = [id];
    while (stack.length) {
      const cur = stack.pop()!;
      for (const e of edges) {
        const [here, next] = dir === 'down' ? [e.from, e.to] : [e.to, e.from];
        if (here === cur && !rel.has(next)) {
          rel.add(next);
          stack.push(next);
        }
      }
    }
  }
  return rel;
}

function Card({ n, live, selected, onSelect, onHover }: { n: PipelineNode; live: Record<string, string>; selected: boolean; onSelect: () => void; onHover: (on: boolean) => void }) {
  const st = statusOf(n, live);
  const status = STATUS[st] ?? STATUS.never;
  const kind = KIND[n.kind] ?? KIND.dataset;
  return (
    <div
      role="button"
      tabIndex={0}
      data-node-id={n.id}
      aria-pressed={selected}
      aria-label={`${kind.word}: ${n.name}. ${status.word}. ${n.schedule.text}.`}
      className={[s.node, s[`is_${st}`], selected && s.selected].filter(Boolean).join(' ')}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect();
        }
      }}
      onMouseEnter={() => onHover(true)}
      onMouseLeave={() => onHover(false)}
    >
      <div className={s.nodeTop}>
        <span className={s.nodeIc}>
          <Icon name={iconFor(n)} />
        </span>
        <div className={s.nodeId}>
          <div className={s.nodeName} title={n.name}>
            {n.name}
          </div>
          <div className={s.nodeSub}>{n.sub || kind.word}</div>
        </div>
      </div>
      <span className={`${s.pill} ${s[`pill_${st}`] ?? ''}`}>
        <Icon name={status.icon} size={12} />
        <span>{status.word}</span>
      </span>
      <div className={s.meta}>
        <div className={s.metaLine}>
          <Icon name="calendar" size={12} />
          <span>{n.schedule.text}</span>
        </div>
        <div className={s.metaLine}>
          <Icon name="history" size={12} />
          <span>{n.lastRun ? `${relTime(n.lastRun.at)}${n.lastRun.durationMs !== undefined ? ` · ${dur(n.lastRun.durationMs)}` : ''}` : 'Never run'}</span>
        </div>
        <div className={n.nextRunAt ? s.metaLine : `${s.metaLine} ${s.dim}`}>
          <Icon name="arrow-right" size={12} />
          <span>{n.nextRunAt ? `Next ${nextText(n.nextRunAt)}` : 'No run planned'}</span>
        </div>
      </div>
    </div>
  );
}

interface Path {
  d: string;
  from: string;
  to: string;
}

export function PipelinesGraph({ view, live, selected, onSelect }: { view: PipelineView; live: Record<string, string>; selected: string | null; onSelect: (id: string | null) => void }) {
  const cols = useRef<HTMLDivElement>(null);
  const [paths, setPaths] = useState<{ w: number; h: number; list: Path[] }>({ w: 0, h: 0, list: [] });
  const [hover, setHover] = useState<string | null>(null);

  // Measure the laid-out cards; again whenever the graph's box changes size.
  useLayoutEffect(() => {
    const el = cols.current;
    if (!el) return;
    const draw = () => {
      const base = el.getBoundingClientRect();
      const box = new Map<string, DOMRect>();
      el.querySelectorAll<HTMLElement>('[data-node-id]').forEach((c) => box.set(c.dataset.nodeId ?? '', c.getBoundingClientRect()));
      const list: Path[] = [];
      for (const e of view.edges) {
        const a = box.get(e.from);
        const b = box.get(e.to);
        if (!a || !b) continue;
        let d: string;
        if (Math.abs(a.left - b.left) < 4) {
          // Same column (a SQL dataset over another): a loop out to the right.
          const x = a.right - base.left;
          const y1 = a.top + a.height / 2 - base.top;
          const y2 = b.top + b.height / 2 - base.top;
          d = `M${x} ${y1} C${x + 22} ${y1}, ${x + 22} ${y2}, ${x} ${y2}`;
        } else {
          const x1 = a.right - base.left;
          const y1 = a.top + a.height / 2 - base.top;
          const x2 = b.left - base.left;
          const y2 = b.top + b.height / 2 - base.top;
          const dx = Math.max(18, (x2 - x1) / 2);
          d = `M${x1} ${y1} C${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
        }
        list.push({ d, from: e.from, to: e.to });
      }
      setPaths({ w: el.scrollWidth, h: el.scrollHeight, list });
    };
    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(el);
    return () => ro.disconnect();
  }, [view]);

  const trace = hover ?? selected;
  const rel = pathOf(trace, view.edges);
  const statusById = new Map(view.nodes.map((n) => [n.id, statusOf(n, live)]));
  const tracks = view.stages.map((_, i) => (view.nodes.some((n) => n.stage === i) ? 'minmax(150px, 1fr)' : '100px')).join(' ');

  return (
    <div className={s.graph}>
      <div ref={cols} className={trace ? `${s.cols} ${s.tracing}` : s.cols} style={{ gridTemplateColumns: tracks }}>
        <svg className={s.edges} width={paths.w} height={paths.h} viewBox={`0 0 ${paths.w || 1} ${paths.h || 1}`} aria-hidden="true">
          {paths.list.map((p) => {
            const to = statusById.get(p.to);
            const cls = [s.edge, to === 'blocked' && s.edgeBlocked, (to === 'running' || to === 'queued') && s.edgeLive, rel.has(p.from) && rel.has(p.to) && s.related];
            return <path key={`${p.from}>${p.to}`} d={p.d} className={cls.filter(Boolean).join(' ')} />;
          })}
        </svg>
        {view.stages.map((stage, i) => {
          const inStage = view.nodes.filter((n) => n.stage === i);
          return (
            <div key={stage} className={s.col} role="group" aria-label={stage}>
              <div className={s.colH}>
                <span>{stage}</span>
                <span className={s.colN}>{inStage.length}</span>
              </div>
              {inStage.length === 0 && <div className={s.colNone}>None</div>}
              {inStage.map((n) => (
                <div key={n.id} className={trace && !rel.has(n.id) ? s.faded : undefined}>
                  <Card
                    n={n}
                    live={live}
                    selected={n.id === selected}
                    onSelect={() => onSelect(n.id === selected ? null : n.id)}
                    onHover={(on) => setHover(on ? n.id : null)}
                  />
                </div>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}
