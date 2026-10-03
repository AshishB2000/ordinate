// What one saved version holds, read-only (legacy versionsPanel.ts preview):
// the record's own fields, in words. A dashboard or visual version previews
// here as facts and a layout sketch — opening it on its own page, read-only,
// arrives with those pages (T2.7 / T2.8). Nothing here computes a figure.

import { VIZ_LABELS } from '../../charts/vizLabels';
import type { VersionMeta, VersionType } from './api';
import s from './Versions.module.css';

type Rec = Record<string, unknown>;
// ponytail: a version's record is its store's own shape; read field by field, never trusted.
const str = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');
const arr = (v: unknown): Rec[] => (Array.isArray(v) ? v.filter((x): x is Rec => !!x && typeof x === 'object') : []);
const obj = (v: unknown): Rec => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : {});

function filterWords(filters: Rec[]): string {
  return filters
    .map((f) => `${str(f.column)} ${str(f.op)} ${Array.isArray(f.values) ? f.values.map(str).join(', ') : str(f.value)}`.trim())
    .join('; ');
}

export function stepWords(st: Rec): string {
  switch (st.type) {
    case 'calculated_field':
      return `Calculated field ${str(st.name)} = ${str(st.expression)}`;
    case 'filter':
      return `Filter ${filterWords([st])}`;
    case 'rename_column':
      return `Rename ${str(st.from)} → ${str(st.to)}`;
    case 'drop_column':
      return `Drop ${str(st.column)}`;
    case 'fill_empty':
      return `Fill empty ${str(st.column)} with ${str(st.value)}`;
    case 'trim':
      return st.column ? `Trim ${str(st.column)}` : 'Trim text columns';
    case 'dedupe':
      return 'Remove duplicate rows';
    case 'group_aggregate':
      return `Group by ${(Array.isArray(st.groupBy) ? st.groupBy : []).map(str).join(', ')}`;
    default:
      return str(st.type) || 'Step';
  }
}

/** A dashboard version's first sheet, drawn from the snapshot: each tile a rounded rect on the 12-column grid. */
export function LayoutThumb({ tiles, width = 64, height = 44 }: { tiles: NonNullable<VersionMeta['thumb']>; width?: number; height?: number }) {
  const rows = Math.max(8, ...tiles.map((t) => t.y + t.h));
  const cw = (width - 4) / 12;
  const rh = (height - 4) / rows;
  return (
    <svg className={s.thumb} viewBox={`0 0 ${width} ${height}`} width={width} height={height} aria-hidden="true">
      {tiles.map((t, i) => (
        <rect
          key={i}
          x={2 + t.x * cw + 0.6}
          y={2 + t.y * rh + 0.6}
          width={Math.max(1, t.w * cw - 1.2)}
          height={Math.max(1, t.h * rh - 1.2)}
          rx={1.5}
          className={s.tile}
          data-type={t.type || 'visual'}
        />
      ))}
    </svg>
  );
}

function Facts({ rows }: { rows: [string, string][] }) {
  const shown = rows.filter(([, v]) => v);
  return (
    <dl className={s.facts}>
      {shown.map(([k, v]) => (
        <div key={k} className={s.fact}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

function TablePreview({ table, steps }: { table: Rec; steps: Rec[] }) {
  const cols = arr(table.columns);
  const rows = (Array.isArray(table.rows) ? table.rows : []) as unknown[][];
  return (
    <>
      <Facts rows={[['Columns', cols.map((c) => str(c.name)).join(', ')], ['Prepare steps', steps.length ? steps.map(stepWords).join('; ') : '']]} />
      {rows.length > 0 && (
        <div className={s.tableWrap}>
          <table className={s.table}>
            <caption className={s.caption}>The table’s first rows, as they were</caption>
            <thead>
              <tr>
                {cols.map((c, i) => (
                  <th key={i} scope="col">
                    {str(c.name)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, 8).map((r, i) => (
                <tr key={i}>
                  {cols.map((_c, j) => (
                    <td key={j}>{Array.isArray(r) && r[j] != null ? str(r[j]) : ''}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

export function VersionPreview({ type, record, meta }: { type: VersionType; record: Rec; meta: VersionMeta | undefined }) {
  const filters = arr(record.filters);
  const filterText = filters.length ? filterWords(filters) : 'None';
  if (type === 'dashboard') {
    const sheets = arr(record.sheets);
    return (
      <>
        {meta?.thumb && meta.thumb.length > 0 && <LayoutThumb tiles={meta.thumb} width={240} height={160} />}
        <Facts rows={[['Name', str(record.name)], ['Sheets', sheets.map((x) => str(x.name)).join(', ')], ['Filters', filterText]]} />
      </>
    );
  }
  if (type === 'visual') {
    const enc = obj(record.encoding);
    const values = arr(enc.values).map((v) => `${str(v.aggregation) || 'sum'}(${str(v.column)})`);
    return (
      <Facts
        rows={[
          ['Name', str(record.name)],
          ['Chart', (VIZ_LABELS as Record<string, string>)[str(record.chartType)] ?? str(record.chartType)],
          ['Category', str(enc.category)],
          ['Values', values.join(', ')],
          ['Filters', filterText],
        ]}
      />
    );
  }
  if (type === 'metric') {
    const def = obj(record.definition);
    const f = obj(record.format);
    return (
      <Facts
        rows={[
          ['Name', str(record.name)],
          ['Definition', def.formula ? str(def.formula) : `${str(def.aggregation) || 'sum'}(${str(def.column)})`],
          ['Filters', filterText],
          ['Format', [str(f.kind), f.decimals !== undefined ? `${str(f.decimals)} dp` : '', f.compact ? 'compact' : ''].filter(Boolean).join(' · ')],
          ['Description', str(record.description)],
        ]}
      />
    );
  }
  if (type === 'report') {
    const pages = arr(record.pages);
    const sched = obj(record.schedule);
    return (
      <Facts
        rows={[
          ['Name', str(record.name)],
          ['Format', str(record.format).toUpperCase()],
          ['Pages', pages.map((p) => `${str(p.kind) || 'page'}${p.include === false ? ' (left out)' : ''}`).join(', ')],
          ['Cover', str(obj(record.cover).title)],
          ['Schedule', sched.cadence && sched.cadence !== 'off' ? `${str(sched.cadence)} at ${str(sched.at)}` : 'Off'],
        ]}
      />
    );
  }
  const steps = arr(record.steps);
  if (record.table && typeof record.table === 'object') return <TablePreview table={obj(record.table)} steps={steps} />;
  return steps.length ? (
    <ol className={s.steps} aria-label="Prepare steps">
      {steps.map((st, i) => (
        <li key={i}>{stepWords(st)}</li>
      ))}
    </ol>
  ) : (
    <Facts rows={[['Steps', 'None — the source as imported']]} />
  );
}
