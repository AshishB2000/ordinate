// One tile the model read, as the check screen shows it: its kind and chart
// type, its title, and each field it appears to use mapped to a column of the
// chosen dataset — with how sure the match is and a dropdown to change it. A
// ready tile shows its preview drawn from YOUR data by the server; one that
// cannot be built says why and can be fixed or dropped. Nothing here decides
// anything: every change goes back to `rebuild:match`, which re-checks it.

import { useState } from 'react';
import { fmtVal } from '../../../charts/format';
import { VIZ_LABELS, type VizId } from '../../../charts/vizLabels';
import { Badge, type BadgeTone } from '../../../ui/Badge';
import { Button } from '../../../ui/Button';
import { Select, type SelectOption } from '../../../ui/Select';
import { Icon, type IconName } from '../../../ui/icons/Icon';
import { DrawnVisual } from '../VisualTile';
import { AGG_LABEL } from '../api';
import type { Agg, Column, MatchedTile, Override, TileField } from './api';
import s from './Rebuild.module.css';

/** The chart types offered: the ones a category and its measures fully describe. */
const CHART_CHOICES: VizId[] = [
  'column', 'bar', 'clustered_column', 'clustered_bar', 'stacked_column', 'stacked_bar', 'line', 'line_markers', 'area', 'stacked_area',
  'pie', 'donut', 'combo', 'scatter', 'treemap', 'heatmap', 'funnel', 'waterfall', 'pareto', 'radar', 'bullet', 'gauge', 'table',
  'map_choropleth', 'map_bubble', 'word_cloud',
];
const KIND_ICON: Record<MatchedTile['kind'], IconName> = { kpi: 'target', chart: 'chart-bar', filter: 'filter', text: 'file-text' };
const ROLE: Record<TileField['role'], string> = { category: 'Category', value: 'Value', split: 'Split by', filter: 'Filter', date_filter: 'Date range' };
const CONF: Record<NonNullable<TileField['confidence']>, [string, BadgeTone]> = {
  exact: ['Exact', 'ok'],
  likely: ['Likely', 'accent'],
  guess: ['Guess', 'warn'],
  picked: ['Your pick', 'neutral'],
};
const STATUS: Record<MatchedTile['status'], [string, BadgeTone]> = { ready: ['Ready', 'ok'], unmapped: ['Needs you', 'warn'], dropped: ['Dropped', 'neutral'] };
const AGGS: Agg[] = ['sum', 'avg', 'count', 'min', 'max'];
const NONE = '\u0000none';

/** The columns a field may take: what the server accepts for its role, judged on the declared type. */
function choices(f: TileField, columns: Column[]): SelectOption[] {
  const fit = columns.filter((c) => (f.role === 'value' ? f.aggregation === 'count' || c.type === 'number' : f.role === 'date_filter' ? c.type === 'date' : true));
  const out = fit.map((c) => ({ value: c.name, label: `${c.name} · ${c.type}` }));
  return f.role === 'split' ? [{ value: NONE, label: 'No split' }, ...out] : out;
}

function FieldRow({ f, tileId, columns, onPick }: { f: TileField; tileId: number; columns: Column[]; onPick: (column: string | null, aggregation?: Agg) => void }) {
  const conf = f.confidence ? CONF[f.confidence] : null;
  return (
    <li className={s.field}>
      <span className={s.role}>{ROLE[f.role]}</span>
      <span className={s.said} title={f.said ? 'As the screenshot names it' : undefined}>
        {f.said ? `“${f.said}”` : <em>not named</em>}
      </span>
      <span className={s.arrow} aria-hidden="true">
        <Icon name="arrow-right" size={12} />
      </span>
      <span className={s.pick}>
        {f.role === 'value' && (
          <Select
            size="sm"
            aria-label={`Tile ${tileId}: how ${f.said || 'the value'} is aggregated`}
            value={f.aggregation ?? 'sum'}
            options={AGGS.map((a) => ({ value: a, label: AGG_LABEL[a] }))}
            onValueChange={(a) => onPick(f.column, a as Agg)}
            className={s.agg}
          />
        )}
        <Select
          size="sm"
          aria-label={`Tile ${tileId}: column for ${ROLE[f.role].toLowerCase()}${f.said ? ` “${f.said}”` : ''}`}
          value={f.column ?? (f.role === 'split' && f.confidence === null && !f.note ? NONE : null)}
          placeholder="Pick a column"
          options={choices(f, columns)}
          onValueChange={(v) => onPick(v === NONE ? null : v, f.aggregation)}
          className={s.colPick}
        />
      </span>
      <span className={s.conf}>{conf ? <Badge tone={conf[1]}>{conf[0]}</Badge> : f.role === 'split' ? null : <Badge tone="warn">No match</Badge>}</span>
      {f.note && <p className={s.fieldNote}>{f.note}</p>}
    </li>
  );
}

function Preview({ tile, projectId }: { tile: MatchedTile; projectId: string }) {
  if (tile.status !== 'ready') return null;
  if (tile.kind === 'kpi') {
    const v = tile.fields[0];
    if (tile.figure?.error) return <p className={s.reason}>{tile.figure.error}</p>;
    return (
      <div className={s.kpi}>
        <span className={s.kpiValue}>{tile.figure && tile.figure.value !== null ? fmtVal(tile.figure.value) : '—'}</span>
        <span className={s.kpiOf}>
          {v?.aggregation ? AGG_LABEL[v.aggregation] : ''} of {v?.column}
        </span>
      </div>
    );
  }
  if (tile.kind === 'chart') {
    if (!tile.preview?.data) return <p className={s.muted}>{tile.preview?.note || 'Ordinate draws this one once it is built.'}</p>;
    return (
      <div className={s.viz}>
        <DrawnVisual type={tile.chartType ?? 'column'} data={tile.preview.data} label={tile.title || 'Preview'} projectId={projectId} />
      </div>
    );
  }
  if (tile.kind === 'filter') {
    const f = tile.fields[0];
    return (
      <p className={s.chipLine}>
        <span className={s.chip}>
          <Icon name={f?.role === 'date_filter' ? 'calendar' : 'filter'} size={12} />
          {f?.column}
        </span>
        A filter in the dashboard’s bar{f?.role === 'date_filter' ? ', over a date range' : tile.multi ? ', several values at once' : ''}.
      </p>
    );
  }
  return <p className={s.muted}>A note across the dashboard.</p>;
}

export function RebuildTile({
  tile,
  columns,
  projectId,
  override,
  lit,
  onLight,
  onChange,
}: {
  tile: MatchedTile;
  columns: Column[];
  projectId: string;
  override: Override | undefined;
  lit: boolean;
  onLight: (id: number | null) => void;
  onChange: (next: Override) => void;
}) {
  const [title, setTitle] = useState(tile.title);
  const base: Override = override ?? { id: tile.id };
  const set = (patch: Partial<Override>) => onChange({ ...base, ...patch });
  const commitTitle = () => title.trim() !== tile.title && set({ title: title.trim() });
  const status = STATUS[tile.status];
  const typed = tile.kind === 'kpi' || tile.kind === 'chart';
  const typeValue = tile.kind === 'kpi' ? 'kpi' : tile.chartType;
  const typeOptions: SelectOption[] = [
    { value: 'kpi', label: 'KPI — one big number' },
    ...CHART_CHOICES.map((id) => ({ value: id, label: VIZ_LABELS[id] })),
    ...(tile.chartType && !CHART_CHOICES.includes(tile.chartType as VizId) ? [{ value: tile.chartType, label: VIZ_LABELS[tile.chartType as VizId] ?? tile.chartType }] : []),
  ];
  return (
    <article
      className={s.tile}
      data-status={tile.status}
      data-lit={lit || undefined}
      aria-label={`Tile ${tile.id}: ${tile.title || 'untitled'}`}
      onPointerEnter={() => onLight(tile.id)}
      onPointerLeave={() => onLight(null)}
    >
      <header className={s.tileHead}>
        <span className={s.no} aria-hidden="true">
          {tile.id}
        </span>
        <span className={s.kindIcon} aria-hidden="true">
          <Icon name={KIND_ICON[tile.kind]} size={16} />
        </span>
        <input
          className={s.titleInput}
          aria-label={`Tile ${tile.id} title`}
          value={title}
          maxLength={80}
          placeholder="Untitled"
          disabled={tile.status === 'dropped'}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={commitTitle}
          onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
        />
        <Badge tone={status[1]}>{status[0]}</Badge>
        <Button variant="ghost" size="sm" icon={tile.status === 'dropped' ? 'rotate-ccw' : 'x'} onClick={() => set({ dropped: tile.status !== 'dropped' })}>
          {tile.status === 'dropped' ? 'Restore' : 'Drop'}
        </Button>
      </header>
      {tile.status !== 'dropped' && (
        <>
          {typed && (
            <div className={s.typeRow}>
              <span className={s.role}>Type</span>
              <Select
                size="sm"
                aria-label={`Tile ${tile.id} chart type`}
                value={typeValue}
                placeholder="Pick a chart type"
                options={typeOptions}
                onValueChange={(v) => set({ chartType: v })}
                className={s.typePick}
              />
              {tile.said && tile.said !== typeValue && <span className={s.readAs}>Read as “{tile.said}”</span>}
            </div>
          )}
          {tile.fields.length > 0 && (
            <ul className={s.fields}>
              {tile.fields.map((f) => (
                <FieldRow
                  key={f.key}
                  f={f}
                  tileId={tile.id}
                  columns={columns}
                  onPick={(column, aggregation) => set({ fields: { ...base.fields, [f.key]: aggregation ? { column, aggregation } : { column } } })}
                />
              ))}
            </ul>
          )}
          {tile.status === 'unmapped' && tile.reason && (
            <p className={s.reason} role="note">
              <Icon name="alert" size={16} />
              {tile.reason}
            </p>
          )}
          <Preview tile={tile} projectId={projectId} />
        </>
      )}
    </article>
  );
}
