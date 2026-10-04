// Format → Colours (fmtColorsUi.ts). Three kinds of colour, each written where
// it belongs:
//   · a DIMENSION VALUE's colour ("Technology") is the PROJECT's — the colour
//     map every chart, legend, map and export in the project draws from;
//   · a MEASURE series' colour ("sum of profit") is this visual's own —
//     `overrides.seriesColors`;
//   · a VALUE PALETTE (sequential / diverging) colours one measure's marks by
//     their value — `overrides.measurePalettes`.
// A colour is a ramp SLOT ('chart-3') from the eight the theme draws now; Auto
// forgets the choice.

import { useState } from 'react';
import { COLOR_TOKENS, type ColorMap, type ColorToken } from '../../../../../src/analysis/colorMap.ts';
import { chartSeries } from '../../../charts/build';
import { fmtColorsByCategory, fmtHex } from '../../../charts/fmtApply';
import { CHART_PALETTE, getCSSVar, paletteFromSeed, valueRamp } from '../../../charts/palette';
import { PER_SERIES_DATASET_TYPES } from '../../../charts/traits';
import { resolveChartType } from '../../../charts/typeSpec';
import { Button } from '../../../ui/Button';
import { Switch } from '../../../ui/Choice';
import { Select } from '../../../ui/Select';
import { toast } from '../../../ui/Toast';
import { Note, type FormatCtx } from './FormatPanel';
import s from './Format.module.css';

export interface ColourScope {
  category: string;
  series: string;
  map: ColorMap;
  edit: {
    set(column: string, value: string, token: ColorToken | null): Promise<void>;
    reset(column: string): Promise<void>;
    palette(column: string, values: (string | number | null)[]): Promise<void>;
  };
}

/** Rows a list shows before pointing at the column's profile for the rest. */
const ROWS = 24;

function themePalette(seed: unknown): string[] {
  const theme = CHART_PALETTE.map((fallback, i) => getCSSVar(`--chart-${i + 1}`) || fallback);
  return typeof seed === 'string' && seed ? paletteFromSeed(seed, theme.length) : theme;
}

function ColourRow({ label, token, palette, onPick }: { label: string; token: string | null; palette: string[]; onPick: (t: ColorToken | null) => void }) {
  const [open, setOpen] = useState(false);
  const name = label === '' ? '(empty)' : label;
  return (
    <>
      <div className={s.colorRow}>
        <button
          type="button"
          className={token ? s.swatch : `${s.swatch} ${s.auto}`}
          style={token ? { background: fmtHex(token, palette) } : undefined}
          aria-expanded={open}
          aria-label={`Colour of ${name}${token ? `: colour ${COLOR_TOKENS.indexOf(token as ColorToken) + 1}` : ': not set'}`}
          onClick={() => setOpen(!open)}
        />
        <span className={s.colorName} title={name}>
          {name}
        </span>
      </div>
      {open && (
        <div className={s.slots}>
          {COLOR_TOKENS.map((t, i) => (
            <button
              key={t}
              type="button"
              className={s.slot}
              aria-pressed={t === token}
              aria-label={`Colour ${i + 1}`}
              style={{ background: palette[i % palette.length] }}
              onClick={() => {
                setOpen(false);
                onPick(t);
              }}
            />
          ))}
          <Button
            size="sm"
            variant="ghost"
            title="Forget this colour — it is dealt again when next drawn"
            onClick={() => {
              setOpen(false);
              onPick(null);
            }}
          >
            Auto
          </Button>
        </div>
      )}
    </>
  );
}

/** A COLUMN's values, coloured from and written to the project's map. */
function ProjectList({ scope, column, values, palette }: { scope: ColourScope; column: string; values: unknown[]; palette: string[] }) {
  const shown = values.slice(0, ROWS);
  const tokenOf = (v: unknown): string | null => scope.map[column]?.[v == null ? '' : String(v)] ?? null;
  const fail = (e: unknown) => toast(e instanceof Error ? e.message : 'Could not change the colours.', { kind: 'error' });
  return (
    <>
      <div className={s.sub}>“{column}” colours</div>
      <Note>Shared by every chart in this project.</Note>
      <div className={s.colorList}>
        {shown.map((v) => (
          <ColourRow key={String(v)} label={String(v ?? '')} token={tokenOf(v)} palette={palette} onPick={(t) => void scope.edit.set(column, String(v ?? ''), t).catch(fail)} />
        ))}
      </div>
      {values.length > shown.length && <Note>{values.length - shown.length} more — every value is in the column’s profile, under Data.</Note>}
      <div className={s.actions}>
        <Button size="sm" title="Deal the palette out again, in this chart’s order" onClick={() => void scope.edit.palette(column, values.map((v) => (typeof v === 'number' ? v : v == null ? null : String(v)))).catch(fail)}>
          Apply palette
        </Button>
        <Button size="sm" title="Forget these colours — each value is dealt one when next drawn" onClick={() => void scope.edit.reset(column).catch(fail)}>
          Reset
        </Button>
      </div>
    </>
  );
}

export function Colours({ ctx }: { ctx: FormatCtx }) {
  const { type, overrides: ov, scope, data } = ctx;
  if (!data) return <Note>Reading the chart…</Note>;
  const series = chartSeries(data).filter((x) => x.role !== 'overlay');
  const spec = resolveChartType(type);
  const palette = themePalette(ov.color);
  const canByCategory = fmtColorsByCategory(type, series, { colorByCategory: true }) && !fmtColorsByCategory(type, series, {});
  const perSeries = PER_SERIES_DATASET_TYPES.has(type);
  const own: Record<string, string> = (ov.seriesColors as Record<string, string>) || {};
  const barLike = spec.chartType === 'bar' && !spec.isFunnel && !spec.isHistogram && !spec.isWaterfall && !spec.isBullet && !spec.isPareto;
  const targets = spec.isMatrix ? ctx.measures.slice(0, 1) : barLike && !scope?.series ? series.map((x) => String(x.name || '')) : [];
  const mp: Record<string, string> = (ov.measurePalettes as Record<string, string>) || {};
  const accent = getCSSVar('--accent') || CHART_PALETTE[0];
  const surface = getCSSVar('--surface') || '#ffffff';

  return (
    <>
      {canByCategory && <Switch label="Colour bars by category" checked={!!ov.colorByCategory} onCheckedChange={(on) => ctx.patch({ colorByCategory: on || null })} />}
      {fmtColorsByCategory(type, series, ov) &&
        (scope?.category ? <ProjectList scope={scope} column={scope.category} values={data.labels ?? []} palette={palette} /> : <Note>Save this chart as a visual to give its categories project colours.</Note>)}
      {perSeries && scope?.series ? (
        <ProjectList scope={scope} column={scope.series} values={series.map((x) => x.name)} palette={palette} />
      ) : (
        perSeries &&
        series.length > 0 &&
        !ov.colorByCategory && (
          <>
            <div className={s.sub}>{series.length > 1 ? 'Series colours' : 'Series colour'}</div>
            <div className={s.colorList}>
              {series.map((x) => {
                const name = String(x.name || '');
                return (
                  <ColourRow
                    key={name}
                    label={name}
                    token={own[name] || null}
                    palette={palette}
                    onPick={(t) => {
                      const next = { ...own };
                      if (t) next[name] = t;
                      else delete next[name];
                      ctx.patch({ seriesColors: Object.keys(next).length ? next : null });
                    }}
                  />
                );
              })}
            </div>
          </>
        )
      )}
      {targets.length > 0 && (
        <>
          <div className={s.sub}>Colour by value</div>
          {targets.map((m) => (
            <div key={m} className={s.rampField}>
              <Select
                label={m}
                size="sm"
                value={mp[m] || ''}
                options={[
                  { value: '', label: 'Categorical' },
                  { value: 'sequential', label: 'Sequential' },
                  { value: 'diverging', label: 'Diverging' },
                ]}
                onValueChange={(v) => {
                  const next = { ...mp };
                  if (v) next[m] = v;
                  else delete next[m];
                  ctx.patch({ measurePalettes: Object.keys(next).length ? next : null });
                }}
              />
              {mp[m] && (
                <div className={s.ramp} aria-hidden="true">
                  {valueRamp(mp[m], accent, surface).map((c, i) => (
                    <span key={i} style={{ background: c }} />
                  ))}
                </div>
              )}
            </div>
          ))}
        </>
      )}
    </>
  );
}
