// The create wizard's TEMPLATE gallery and MAP COLUMNS step (legacy
// anNewTemplates.ts). Thumbnails are real charts drawn by the shared engine
// from a fixed six-month fixture — a picture of the template's signature chart,
// not data. The mapping step's figures come from the server: the plan from
// `template:plan` (the factory Create runs), the tile count from
// `analysis:previewPlan` (the validator's verdict) and each KPI from
// `dashboard:metric` (the channel the built tile will call).

import { useEffect, useRef, useState } from 'react';
import { rpc } from '../../api/client';
import { Chart } from '../../charts/Chart';
import { fmtWith } from '../../charts/format';
import type { ChartDataShape } from '../../charts/types';
import { TypeBadge } from '../../ui/DataGrid/GridParts';
import { Select } from '../../ui/Select';
import type { Agg, PlanPreview, Template } from './api';
import { trimThumb } from './VisualTile';
import s from './Wizard.module.css';

/** Six periods and two series, the same for every card so the row reads as one family. */
const FIXTURE: ChartDataShape = {
  labels: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun'],
  series: [
    { name: 'This year', values: [38, 52, 46, 67, 74, 88] },
    { name: 'Last year', values: [30, 34, 41, 45, 52, 58] },
  ],
};
const THUMB = { showLegend: false, showGridlines: false, valueMode: 'off', noAnimate: true, showTooltips: false, title: '' };

/** "Needs: date, revenue, category" — the REQUIRED roles, lower-cased. */
function needsLine(t: Template): string {
  const req = t.roles.filter((r) => r.required).map((r) => r.label.toLowerCase());
  return req.length ? `Needs: ${req.join(', ')}` : '';
}

/** The subject cards. One whose required roles cannot map is dimmed, with the mapper's reason. */
export function TemplateGallery({ templates, picked, onPick }: { templates: Template[]; picked: string; onPick: (id: string) => void }) {
  return (
    <div className={s.tpls} role="radiogroup" aria-label="Templates">
      {templates.map((t) => {
        const blocked = !!t.reason;
        const on = !blocked && picked === t.id;
        return (
          <button
            key={t.id}
            type="button"
            role="radio"
            aria-checked={on}
            disabled={blocked}
            title={blocked ? t.reason : t.blurb}
            className={[s.tpl, on && s.selected, blocked && s.blocked].filter(Boolean).join(' ')}
            onClick={() => onPick(t.id)}
          >
            <span className={s.tplArt} aria-hidden="true">
              {t.thumb && <Chart type={t.thumb} data={FIXTURE} overrides={THUMB} onChart={trimThumb} />}
            </span>
            <span className={s.tplName}>{t.name}</span>
            <span className={s.tplNeeds}>{blocked ? t.reason : needsLine(t)}</span>
          </button>
        );
      })}
    </div>
  );
}

const SKIP = '';
/** A user walking down five selects should cost one refresh, not five (AN_TPL_DEBOUNCE_MS). */
const DEBOUNCE_MS = 220;
const CONFIDENCE: Record<string, string> = {
  high: 'Matched confidently',
  medium: 'Best match — worth a look',
  low: 'A guess — check this one',
  chosen: 'You chose this column',
  none: 'Not mapped',
};

type Kpi = { label: string; text: string };

/**
 * One row per role (a select over the dataset's columns, the column's type, a
 * confidence dot), a live line saying how much will be built, and a KPI strip
 * of REAL figures for the current mapping. `onPlan` hands up the plan the
 * server built for it — what Create builds.
 */
export function MapColumns({
  projectId,
  datasetId,
  template,
  columns,
  name,
  onPlan,
}: {
  projectId: string;
  datasetId: string;
  template: Template;
  columns: { name: string; type: string }[];
  name: string;
  onPlan: (plan: Record<string, unknown> | null) => void;
}) {
  const [picks, setPicks] = useState<Record<string, string>>(() => {
    const out: Record<string, string> = {};
    for (const m of template.matches) if (m.column) out[m.role] = m.column;
    // A required role with nothing mapped falls back to the first column, so Create is never blocked by a blank.
    for (const r of template.roles) if (r.required && !out[r.id] && columns[0]) out[r.id] = columns[0].name;
    return out;
  });
  const [summary, setSummary] = useState('Reading your data…');
  const [kpis, setKpis] = useState<Kpi[]>([]);
  // The denominator of "N skipped": the tiles the most complete (preselected) mapping builds.
  const maxTiles = useRef(0);
  const seq = useRef(0);
  const onPlanRef = useRef(onPlan);
  useEffect(() => {
    onPlanRef.current = onPlan;
  });

  useEffect(() => {
    const mine = ++seq.current;
    const timer = setTimeout(() => {
      void (async () => {
        const mapping = Object.fromEntries(Object.entries(picks).filter(([, v]) => v));
        const mapped = Object.keys(mapping).length;
        const total = template.roles.length;
        type PlanReply = { ok: boolean; plan?: Record<string, unknown>; error?: string };
        const res = (await rpc('template:plan', { projectId, datasetId, templateId: template.id, mapping, ...(name ? { name } : {}) }).catch(
          () => null,
        )) as PlanReply | null;
        if (mine !== seq.current) return;
        if (!res || !res.ok || !res.plan) {
          onPlanRef.current(null);
          setSummary((res && res.error) || 'This mapping cannot be built.');
          setKpis([]);
          return;
        }
        onPlanRef.current(res.plan);
        let preview: PlanPreview | null = null;
        try {
          const p = (await rpc('analysis:previewPlan', { projectId, plan: res.plan })) as PlanPreview | { ok: false };
          preview = p.ok ? p : null;
        } catch {
          preview = null;
        }
        if (mine !== seq.current) return;
        const sheets = (preview ? preview.sheets : (res.plan.sheets as PlanPreview['sheets'])) ?? [];
        const tiles = sheets.reduce((n, sh) => n + (sh.metrics ?? []).length + (sh.visuals ?? []).length + (sh.controls ?? []).length, 0);
        if (!maxTiles.current) maxTiles.current = tiles;
        const skipped = Math.max(0, maxTiles.current - tiles);
        setSummary(`${mapped} of ${total} mapped · ${tiles} ${tiles === 1 ? 'tile' : 'tiles'} will be built${skipped ? ` · ${skipped} skipped` : ''}`);
        const metrics = (preview && preview.sheets[0] && preview.sheets[0].metrics) || [];
        const shown = metrics.slice(0, 4);
        setKpis(shown.map((m) => ({ label: m.label || m.column, text: '…' })));
        const values = await Promise.all(
          shown.map(async (m) => {
            try {
              const r = (await rpc('dashboard:metric', { projectId, datasetId: m.datasetId, column: m.column, aggregation: m.aggregation as Agg })) as {
                ok: boolean;
                value?: number | null;
              };
              // A KPI over a column the plan is about to COMPUTE has no column yet: "—", never a made-up number.
              return r.ok && typeof r.value === 'number' ? fmtWith(r.value, 'auto') : '—';
            } catch {
              return '—';
            }
          }),
        );
        if (mine !== seq.current) return;
        setKpis(shown.map((m, i) => ({ label: m.label || m.column, text: values[i] ?? '—' })));
      })();
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [picks, projectId, datasetId, template, name]);

  const typeOf = new Map(columns.map((c) => [c.name, c.type]));
  return (
    <div className={s.map}>
      <div className={s.mapRows}>
        {template.roles.map((role) => {
          const value = picks[role.id] ?? SKIP;
          const match = template.matches.find((m) => m.role === role.id);
          // The dot reports how confident the MAPPER was; a column the user chose carries no claim.
          const conf = match && match.column === value ? match.confidence : value ? 'chosen' : 'none';
          const type = typeOf.get(value);
          const options = [
            ...(role.required ? [] : [{ value: SKIP, label: 'Skip' }]),
            ...columns.map((c) => ({ value: c.name, label: c.name })),
          ];
          return (
            <div key={role.id} className={s.mapRow}>
              <span className={s.role}>
                {role.label}
                {!role.required && <span className={s.optional}>Optional</span>}
              </span>
              <Select
                size="sm"
                aria-label={`${role.label} column`}
                value={value}
                options={options}
                onValueChange={(v) => setPicks((p) => ({ ...p, [role.id]: v }))}
              />
              <span className={s.glyph}>{type && value ? <TypeBadge type={type === 'number' || type === 'date' ? type : 'text'} /> : null}</span>
              <span className={s[`dot_${conf}`]} title={CONFIDENCE[conf]} aria-label={CONFIDENCE[conf]} role="img" />
            </div>
          );
        })}
      </div>
      <p className={s.summary} role="status">
        {summary}
      </p>
      {kpis.length > 0 && (
        <div className={s.preview}>
          <span className={s.previewH}>Preview</span>
          <div className={s.kpis}>
            {kpis.map((k, i) => (
              <span key={i} className={s.kpi}>
                <span className={s.kpiV}>{k.text}</span>
                <span className={s.kpiL}>{k.label}</span>
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
