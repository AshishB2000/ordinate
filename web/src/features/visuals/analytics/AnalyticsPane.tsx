// The builder's ANALYTICS section (analyticsPane.ts): reference lines, bands,
// targets, trends, moving averages, forecasts, annotations and highlights,
// each with an inline editor. It edits DEFINITIONS (saved as
// `Visual.analytics`) and shows the READOUTS the server sends back on
// `data.analytics` — "Average 12.3K", a forecast's 80% range, or why an
// overlay cannot be drawn. Every figure is the server's.

import { useState } from 'react';
import type { ChartDataShape, Cx } from '../../../charts/types';
import { resolveChartType } from '../../../charts/typeSpec';
import { Button, IconButton } from '../../../ui/Button';
import { Icon, type IconName } from '../../../ui/icons/Icon';
import { Popover } from '../../../ui/Popover';
import { typeLabel } from '../model';
import { OverlayEditor } from './OverlayEditor';
import s from './Analytics.module.css';

export type Overlay = Record<string, unknown> & { id: string; kind: string };

export const KINDS: { kind: string; label: string; icon: IconName; hint: string }[] = [
  { kind: 'reference', label: 'Reference line', icon: 'minus', hint: 'A line at a value or a statistic of the series' },
  { kind: 'band', label: 'Band', icon: 'columns', hint: 'Shade between two values, or mean ± σ' },
  { kind: 'target', label: 'Target', icon: 'target', hint: 'A goal line with attainment' },
  { kind: 'trend', label: 'Trend line', icon: 'trending-up', hint: 'Least-squares line with its slope and R²' },
  { kind: 'moving_average', label: 'Moving average', icon: 'chart-line', hint: 'Trailing average over N points' },
  { kind: 'forecast', label: 'Forecast', icon: 'chart-area', hint: 'Linear, seasonal naive or Holt-Winters, with an 80% interval' },
  { kind: 'annotation', label: 'Annotation', icon: 'pencil', hint: 'A note pinned to a category — or ⌥-click a mark' },
  { kind: 'highlight', label: 'Highlight', icon: 'star', hint: 'Outline the top, bottom, or points past a threshold' },
];
export const kindInfo = (kind: string) => KINDS.find((k) => k.kind === kind) ?? KINDS[0];

export const newId = (): string => crypto.randomUUID();

/** A new overlay's starting definition. A target starts at the series' maximum, resolved by the server. */
export function defaultsFor(kind: string, labels: readonly string[]): Overlay {
  const ov: Overlay = { id: newId(), kind };
  if (kind === 'reference') ov.value = { type: 'stat', stat: 'avg' };
  if (kind === 'target') ov.value = { type: 'stat', stat: 'max' };
  if (kind === 'band') ov.sd = 1;
  if (kind === 'moving_average') ov.window = 3;
  if (kind === 'forecast') Object.assign(ov, { method: 'linear', horizon: 3, season: 'auto' });
  if (kind === 'annotation') Object.assign(ov, { at: labels[labels.length - 1] ?? '', text: 'Note' });
  if (kind === 'highlight') Object.assign(ov, { rule: 'top', n: 3 });
  return ov;
}

export function AnalyticsPane({
  type,
  data,
  overlays,
  onChange,
}: {
  type: string;
  /** The last reply's data: its labels and series for the pickers, `analytics` for the readouts. */
  data: ChartDataShape | undefined;
  overlays: Overlay[];
  onChange: (next: Overlay[]) => void;
}) {
  const [open, setOpen] = useState('');
  const [adding, setAdding] = useState(false);
  const accepted = resolveChartType(type || 'column').overlayKinds;
  const resolved = new Map<string, Cx>((Array.isArray(data?.analytics) ? data.analytics : []).map((r: Cx) => [String(r.id), r]));
  const labels = (data?.labels ?? []).map(String);
  const series = (data?.series ?? []).filter((x) => x.role !== 'overlay').map((x, i) => String(x.name || `Series ${i + 1}`));
  const notDrawn = `Not drawn on ${typeLabel(type) || 'this chart'}`;

  const add = (kind: string) => {
    const ov = defaultsFor(kind, labels);
    setAdding(false);
    setOpen(ov.id);
    onChange([...overlays, ov]);
  };
  const update = (id: string, next: Overlay) => onChange(overlays.map((o) => (o.id === id ? next : o)));

  return (
    <section className={s.pane} aria-labelledby="anp-title">
      <div className={s.head}>
        <span className={s.title} id="anp-title">
          Analytics
        </span>
        {overlays.length > 0 && <span className={s.count}>{overlays.length}</span>}
        <Popover
          title="Add an overlay"
          align="end"
          open={adding}
          onOpenChange={setAdding}
          trigger={
            <Button size="sm" icon="plus" className={s.add}>
              Add
            </Button>
          }
        >
          <div className={s.menu} role="menu">
            {KINDS.map((k) => {
              const ok = accepted.includes(k.kind);
              return (
                <button key={k.kind} type="button" role="menuitem" className={s.menuItem} disabled={!ok} onClick={() => add(k.kind)}>
                  <Icon name={k.icon} />
                  <span className={s.menuText}>
                    <span className={s.menuName}>{k.label}</span>
                    <span className={s.menuHint}>{ok ? k.hint : notDrawn}</span>
                  </span>
                </button>
              );
            })}
          </div>
        </Popover>
      </div>
      {overlays.length === 0 ? (
        <p className={s.empty}>Lay a reference line, target, trend or forecast over the chart. Drag a line to move it; ⌥-click a mark to annotate it.</p>
      ) : (
        <div className={s.list}>
          {overlays.map((ov) => {
            const info = kindInfo(ov.kind);
            const res = resolved.get(ov.id);
            const drawn = accepted.includes(ov.kind);
            const isOpen = open === ov.id;
            const read = !drawn ? notDrawn : ov.hidden ? 'Hidden' : res?.warning ? String(res.warning) : res ? String(res.text ?? '') : 'Computing…';
            return (
              <div key={ov.id} className={[s.row, ov.hidden ? s.hidden : '', isOpen ? s.open : ''].join(' ')} data-overlay-id={ov.id} data-kind={ov.kind}>
                <div className={s.bar}>
                  <button type="button" className={s.main} aria-expanded={isOpen} onClick={() => setOpen(isOpen ? '' : ov.id)}>
                    <span className={s.glyph} style={typeof ov.color === 'string' ? { color: ov.color } : undefined}>
                      <Icon name={info.icon} />
                    </span>
                    <span className={s.text}>
                      <span className={s.name}>{(ov.label as string) || (res?.label as string) || info.label}</span>
                      <span className={!drawn || res?.warning ? `${s.read} ${s.warn}` : s.read}>{read}</span>
                    </span>
                  </button>
                  <IconButton
                    icon={ov.hidden ? 'eye-off' : 'eye'}
                    size="sm"
                    label={ov.hidden ? 'Show overlay' : 'Hide overlay'}
                    onClick={() => {
                      const { hidden, ...rest } = ov;
                      update(ov.id, hidden ? (rest as Overlay) : { ...ov, hidden: true });
                    }}
                  />
                  <IconButton icon="x" size="sm" label="Remove overlay" onClick={() => onChange(overlays.filter((o) => o.id !== ov.id))} />
                </div>
                {isOpen && <OverlayEditor ov={ov} res={res} labels={labels} series={series} onChange={(next) => update(ov.id, next)} />}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
