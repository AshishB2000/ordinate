// A chart's control cluster (chartControls.ts addChartControls / openChartMenu):
// Values ▾ (which value labels to print), Periods ▾ / Series ▾ (hide some),
// a Sankey's one-period select, and ⋯ — copy or download the picture, copy the
// figures, explain, and Customize (title, colour, number format, a bullet's
// target, smooth lines, reset). Every edit is an override PATCH; a null drops
// the key so the default applies again.

import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { chartSeries } from '../../charts/build';
import type { ChartHandle } from '../../charts/Chart';
import { canvasToPng } from '../../charts/png';
import { chartHasPeriodDropdown, chartIsSmallMultiple, NO_VALUE_LABEL_TYPES } from '../../charts/traits';
import type { ChartDataShape, Overrides } from '../../charts/types';
import { Button, IconButton } from '../../ui/Button';
import { Checkbox, Switch } from '../../ui/Choice';
import { Input } from '../../ui/Field';
import { Icon } from '../../ui/icons/Icon';
import { Menu } from '../../ui/Menu';
import { Popover } from '../../ui/Popover';
import { Select } from '../../ui/Select';
import { toast } from '../../ui/Toast';
import { FormatPanel, type FormatCtx } from './format/FormatPanel';
import b from './Builder.module.css';
import s from './Controls.module.css';

export type Patch = Record<string, unknown>;

const VALUE_MODES = [
  { value: 'off', label: 'Off' },
  { value: 'all', label: 'All' },
  { value: 'maxmin', label: 'Max & min' },
  { value: 'max', label: 'Max' },
  { value: 'min', label: 'Min' },
];
const LINE_TYPES = new Set(['line', 'area', 'stacked_area', 'line_markers', 'combo']);
export const CURATED_COLORS = [
  { hex: '#4f7cd4', label: 'Blue' },
  { hex: '#13a99e', label: 'Teal' },
  { hex: '#e8960c', label: 'Amber' },
  { hex: '#7c52e8', label: 'Violet' },
  { hex: '#e83859', label: 'Rose' },
  { hex: '#0ea5e9', label: 'Sky' },
  { hex: '#22c55e', label: 'Green' },
  { hex: '#f97316', label: 'Orange' },
];
const NUMBER_FORMATS = [
  { value: 'auto', label: 'Auto (K/M/B)' },
  { value: 'plain', label: 'Plain' },
  { value: 'thousands', label: 'Thousands (1,234)' },
  { value: 'compact', label: 'Compact (1.2K)' },
  { value: 'percent', label: 'Percent (12%)' },
  { value: 'currency', label: 'Currency ($1,234)' },
];

/** {labels, series} as tab-separated text: the header row, then one row per label. */
export function dataToTsv(data: ChartDataShape): string {
  const labels = data.labels ?? [];
  const series = data.series ?? [];
  const head = ['Label', ...series.map((x) => x.name ?? '')].join('\t');
  return [head, ...labels.map((l, i) => [l, ...series.map((x) => (x.values?.[i] ?? '') as unknown)].join('\t'))].join('\n');
}

export interface MenuActions {
  /** The figures as the Share policy shapes them for leaving the app. */
  sharedData(): Promise<ChartDataShape>;
  explain(): void;
  /** Open the rows behind the whole visual (drill.ts, the ⋯ route — the only one a map or table has). */
  drill(): void;
  /** File name for a downloaded picture. */
  name: string;
  /** What the Format panel edits (./format). */
  format: Omit<FormatCtx, "overrides" | "patch" | "type">;
}

export function ChartControls({
  type,
  data,
  overrides,
  chart,
  onPatch,
  menu,
}: {
  type: string;
  data: ChartDataShape & { dataShape?: string };
  overrides: Overrides;
  chart: ChartHandle | null;
  onPatch: (p: Patch) => void;
  menu: MenuActions;
}) {
  const series = chartSeries(data);
  const valueMode = (overrides.valueMode as string) || (overrides.showValues ? 'all' : 'maxmin');
  const hidden = new Set<number>(Array.isArray(overrides.hiddenSeries) ? (overrides.hiddenSeries as number[]) : []);
  const periods = chartHasPeriodDropdown(type, series.length) || chartIsSmallMultiple(type, series.length);
  const sankeyIdx = Number.isInteger(overrides.periodIdx) ? Math.max(0, Math.min(overrides.periodIdx as number, series.length - 1)) : series.length - 1;

  const toggle = (i: number) => {
    const next = new Set(hidden);
    if (next.has(i)) next.delete(i);
    else if (series.length - next.size > 1) next.add(i); // keep one visible
    const arr = [...next].sort((a, b) => a - b);
    onPatch({ hiddenSeries: arr.length ? arr : null });
  };

  return (
    <div className={s.controls}>
      {!NO_VALUE_LABEL_TYPES.has(type) && (
        <Menu
          align="end"
          label="Value labels"
          items={[{ kind: 'radio', label: 'Value labels', value: valueMode, options: VALUE_MODES, onChange: (m) => onPatch({ valueMode: m }) }]}
          trigger={
            <button type="button" className={valueMode !== 'off' ? `${s.pill} ${s.pillOn}` : s.pill} aria-label="Value labels">
              Values <Icon name="chevron-down" />
            </button>
          }
        />
      )}
      {periods && (
        <Popover
          align="end"
          title={data.dataShape === 'time_series' ? 'Periods' : 'Series'}
          trigger={
            <button type="button" className={hidden.size ? `${s.pill} ${s.pillOn}` : s.pill}>
              {data.dataShape === 'time_series' ? 'Periods' : 'Series'} <Icon name="chevron-down" />
            </button>
          }
        >
          <div className={s.checks}>
            <Checkbox label="All" checked={hidden.size === 0} onCheckedChange={() => hidden.size && onPatch({ hiddenSeries: null })} />
            {series.map((x, i) => (
              <Checkbox key={i} label={x.name || `Series ${i + 1}`} checked={!hidden.has(i)} onCheckedChange={() => toggle(i)} />
            ))}
          </div>
        </Popover>
      )}
      {type === 'sankey' && series.length >= 2 && (
        <Select
          aria-label="Select period"
          size="sm"
          value={String(sankeyIdx)}
          options={series.map((x, i) => ({ value: String(i), label: x.name || `Period ${i + 1}` }))}
          onValueChange={(v) => onPatch({ periodIdx: Number(v) || 0 })}
        />
      )}
      <ChartMenu type={type} overrides={overrides} chart={chart} onPatch={onPatch} menu={menu} />
    </div>
  );
}

function ChartMenu({ type, overrides, chart, onPatch, menu }: { type: string; overrides: Overrides; chart: ChartHandle | null; onPatch: (p: Patch) => void; menu: MenuActions }) {
  const [open, setOpen] = useState(false);
  const [custom, setCustom] = useState(false);
  const [title, setTitle] = useState((overrides.title as string) || '');
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const close = () => setOpen(false);

  const png = () => (chart ? canvasToPng(chart.canvas) : null);
  const copyImage = async () => {
    close();
    const url = png();
    if (!url) return;
    try {
      const blob = await (await fetch(url)).blob();
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      toast('Chart copied to clipboard', { kind: 'success' });
    } catch {
      toast('This browser would not copy the picture. Download it instead.', { kind: 'error' });
    }
  };
  const download = () => {
    close();
    const url = png();
    if (!url) return;
    const a = document.createElement('a');
    a.href = url;
    a.download = `${menu.name.replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'chart'}.png`;
    a.click();
  };
  const copyData = async () => {
    close();
    try {
      await navigator.clipboard.writeText(dataToTsv(await menu.sharedData()));
      toast('Data copied to clipboard', { kind: 'success' });
    } catch (e) {
      toast(e instanceof Error && e.message ? e.message : 'Could not copy the data.', { kind: 'error' });
    }
  };
  const item = (icon: Parameters<typeof Icon>[0]['name'], label: string, run: () => void, disabled = false) => (
    <button type="button" className={s.menuItem} disabled={disabled} onClick={run}>
      <Icon name={icon} />
      {label}
    </button>
  );

  return (
    <Popover
      align="end"
      title="Chart options"
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (o) setTitle((overrides.title as string) || '');
      }}
      trigger={<IconButton icon="more-horizontal" label="Chart options" size="sm" />}
    >
      <div className={s.menu}>
        {item('copy', 'Copy chart as image', () => void copyImage(), !chart)}
        {item('download', 'Download chart (PNG)', download, !chart)}
        {item('file-text', 'Copy data', () => void copyData())}
        {item('table', 'Show underlying rows', () => {
          close();
          menu.drill();
        })}
        {item('message-square', 'Explain', () => {
          close();
          menu.explain();
        })}
        <div className={s.sep} />
        <button type="button" className={s.customHead} aria-expanded={custom} onClick={() => setCustom(!custom)}>
          Customize <Icon name={custom ? 'chevron-up' : 'chevron-down'} />
        </button>
        {custom && (
          <div className={s.custom}>
            <Input
              label="Title"
              size="sm"
              placeholder="Chart title"
              value={title}
              autoComplete="off"
              onChange={(e) => {
                const v = e.target.value;
                setTitle(v);
                window.clearTimeout(timer.current);
                timer.current = window.setTimeout(() => onPatch({ title: v.trim() || null }), 300);
              }}
            />
            <div className={s.field}>
              <span className={b.label} id="cm-color">
                Color
              </span>
              <div className={s.swatches} role="group" aria-labelledby="cm-color">
                {CURATED_COLORS.map((c) => (
                  <button
                    key={c.hex}
                    type="button"
                    className={s.swatch}
                    aria-label={c.label}
                    aria-pressed={overrides.color === c.hex}
                    style={{ '--sw-color': c.hex } as CSSProperties}
                    onClick={() => onPatch({ color: overrides.color === c.hex ? null : c.hex })}
                  />
                ))}
              </div>
            </div>
            <Select
              label="Number format"
              size="sm"
              value={(overrides.numberFormat as string) || 'auto'}
              options={NUMBER_FORMATS}
              onValueChange={(v) => onPatch({ numberFormat: v === 'auto' ? null : v })}
            />
            {type === 'bullet' && (
              <Input
                label="Target value"
                size="sm"
                type="number"
                step="any"
                placeholder="Second measure, if any"
                defaultValue={typeof overrides.bulletTarget === 'number' ? String(overrides.bulletTarget) : ''}
                onChange={(e) => {
                  const n = parseFloat(e.target.value);
                  onPatch({ bulletTarget: Number.isFinite(n) ? n : null });
                }}
              />
            )}
            {LINE_TYPES.has(type) && (
              <Switch label="Smooth lines" checked={overrides.smooth !== false} onCheckedChange={(on) => onPatch({ smooth: on ? null : false })} />
            )}
            <FormatPanel ctx={{ ...menu.format, type, overrides, patch: onPatch }} />
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                onPatch({ reset: true });
                close();
              }}
            >
              Reset to default
            </Button>
          </div>
        )}
      </div>
    </Popover>
  );
}
