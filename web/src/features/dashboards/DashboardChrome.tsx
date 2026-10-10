// The dashboard viewer's pieces around T2.8's canvas (T2.9): the Style dialog
// and how a style paints (dashStyle.ts), Present mode (dashShare.ts), the view
// controls — As of (snapshotAsOf.ts) and the dashboard's currency (fxUi.ts) —
// Export (dashShare.ts handleDashExport) and the comment panel's host.

import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { rpc } from '../../api/client';
import { startDownload } from '../../api/files';
import { brandTokens } from '../../charts/palette';
import { annotationHooks } from '../../charts/annotations';
import { Button } from '../../ui/Button';
import { Dialog, DialogClose } from '../../ui/Dialog';
import { Input } from '../../ui/Field';
import { Select } from '../../ui/Select';
import { toast } from '../../ui/Toast';
import { asOfView } from '../../ui/asOfView';
import { useThemes } from '../settings/api';
import { themeCssVars } from '../settings/themeModel';
import type { EditorApi } from '../analyses/editor/context';
import { useEditor } from '../analyses/editor/context';
import { CommentsPanel } from './CommentsPanel';
import { reason, useAsOfStamps, useCommentsLive, useFx, useSetDashboardCurrency } from './api';
import st from './Style.module.css';

// The head's Subscribe action (scheduled sends to Slack / Teams) lives with its dialog.
export { SubscribeButton } from '../subscriptions/SubscribeButton';
import s from './Dashboards.module.css';

export interface DashStyle {
  theme?: 'auto' | 'clean' | 'executive' | 'dark';
  density?: 'comfortable' | 'compact';
  accent?: 'blue' | 'teal' | 'slate';
  accentHex?: string;
  logo?: 'none' | 'custom';
  themeId?: string;
  chosen?: true;
}

/** The style's classes — theme, density, accent — and Present's (dashStyle.ts dashStyleClasses). */
export function styleClass(raw: Record<string, unknown>, presenting = false): string {
  const v = raw as DashStyle;
  const theme = v.theme === 'clean' && !v.chosen ? 'auto' : (v.theme ?? 'auto');
  return [theme !== 'auto' && st[`theme_${theme}`], st[`density_${v.density ?? 'comfortable'}`], st[`accent_${v.accentHex ? 'blue' : (v.accent ?? 'blue')}`], presenting && s.presenting]
    .filter(Boolean)
    .join(' ');
}

/** A custom accent's --brand-* ramp and a workspace theme's tokens, as custom properties on the sheet. */
export function useStyleVars(raw: Record<string, unknown>): CSSProperties {
  const v = raw as DashStyle;
  const themes = useThemes();
  return useMemo(() => {
    const out: Record<string, string> = {};
    const id = v.themeId || themes.data?.defaultId;
    const theme = id && id !== 'none' ? themes.data?.themes.find((t) => t.id === id) : undefined;
    if (theme) for (const [k, val] of themeCssVars(theme.tokens)) out[k] = val;
    const brand = v.accentHex ? brandTokens(v.accentHex) : null;
    if (brand) Object.assign(out, brand.light, brand.dark);
    return out as CSSProperties;
  }, [v.themeId, v.accentHex, themes.data]);
}

const PRESETS: { value: NonNullable<DashStyle['theme']>; label: string; hint: string }[] = [
  { value: 'auto', label: 'Auto', hint: 'Follows the app' },
  { value: 'clean', label: 'Light', hint: 'Always light' },
  { value: 'executive', label: 'Executive', hint: 'Slate, serif figures' },
  { value: 'dark', label: 'Dark', hint: 'Always dark' },
];
const SWATCHES: [string, string][] = [
  ['#2563eb', 'Blue'], ['#7c3aed', 'Violet'], ['#0d9488', 'Teal'], ['#16a34a', 'Green'],
  ['#ea580c', 'Orange'], ['#e11d48', 'Rose'], ['#db2777', 'Pink'], ['#475569', 'Slate'],
];

/** Dashboard style (dashStyle.ts): every pick previews on the sheet; Cancel puts the original back. */
export function StyleDialog({ onClose }: { onClose: () => void }) {
  const ed = useEditor();
  const [orig] = useState(() => ed.doc.style as DashStyle);
  const [v, setV] = useState<DashStyle>(orig);
  const [hex, setHex] = useState(orig.accentHex ?? '');
  const themes = useThemes();
  const preview = (next: DashStyle) => {
    setV(next);
    ed.edit('Change style', (d) => void (d.style = { ...next }), true);
  };
  const cancel = () => {
    if (JSON.stringify(v) !== JSON.stringify(orig)) ed.undo();
    onClose();
  };
  const theme = v.theme === 'clean' && !v.chosen ? 'auto' : (v.theme ?? 'auto');
  const hexOk = !hex || /^#[0-9a-f]{6}$/i.test(hex);
  const defName = themes.data?.themes.find((t) => t.id === themes.data?.defaultId)?.name;
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && cancel()}
      title="Dashboard style"
      description="Applies to this dashboard only — and to what you publish or export from it."
      footer={
        <>
          <Button variant="ghost" onClick={cancel}>
            Cancel
          </Button>
          <DialogClose asChild>
            <Button
              variant="primary"
              onClick={() => toast(`Style: ${PRESETS.find((p) => p.value === theme)?.label ?? 'Auto'}${defName && !v.themeId ? ` · ${defName}` : ''}`)}
            >
              Apply
            </Button>
          </DialogClose>
        </>
      }
    >
      <div className={s.presets} role="radiogroup" aria-label="Preset">
        {PRESETS.map((p) => (
          <button
            key={p.value}
            type="button"
            role="radio"
            aria-checked={theme === p.value}
            className={theme === p.value ? `${s.preset} ${s.presetOn}` : s.preset}
            onClick={() => preview({ ...v, theme: p.value, ...(p.value === 'clean' ? { chosen: true as const } : { chosen: undefined }) })}
          >
            <span className={`${s.mini} ${styleClass({ ...v, theme: p.value, chosen: true })}`} aria-hidden="true">
              <span />
              <span />
              <span />
            </span>
            <span className={s.presetName}>{p.label}</span>
            <span className={s.presetHint}>{p.hint}</span>
          </button>
        ))}
      </div>
      <div className={s.styleRow}>
        <Select
          label="Density"
          value={v.density ?? 'comfortable'}
          onValueChange={(d) => preview({ ...v, density: d as DashStyle['density'] })}
          options={[
            { value: 'comfortable', label: 'Comfortable' },
            { value: 'compact', label: 'Compact' },
          ]}
        />
        <Select
          label="Workspace theme"
          value={v.themeId ?? ''}
          onValueChange={(id) => preview({ ...v, themeId: id || undefined })}
          options={[{ value: '', label: `Workspace default${defName ? ` (${defName})` : ''}` }, { value: 'none', label: 'None' }, ...(themes.data?.themes ?? []).map((t) => ({ value: t.id, label: t.name }))]}
        />
      </div>
      <fieldset className={s.accentField}>
        <legend className={s.legend}>Accent</legend>
        <div className={s.swatches}>
          <button type="button" className={!v.accentHex ? `${s.swatch} ${s.swatchNone} ${s.swatchOn}` : `${s.swatch} ${s.swatchNone}`} aria-label="Workspace accent" aria-pressed={!v.accentHex}
            onClick={() => { setHex(''); preview({ ...v, accentHex: undefined }); }} />
          {SWATCHES.map(([h, name]) => (
            <button key={h} type="button" className={v.accentHex === h ? `${s.swatch} ${s.swatchOn}` : s.swatch} style={{ background: h }} aria-label={name} aria-pressed={v.accentHex === h}
              onClick={() => { setHex(h); preview({ ...v, accentHex: h }); }} />
          ))}
          <Input
            label="Hex"
            value={hex}
            placeholder="#2563eb"
            error={hexOk ? undefined : 'A colour like #1f6feb'}
            onChange={(e) => {
              setHex(e.target.value);
              if (/^#[0-9a-f]{6}$/i.test(e.target.value)) preview({ ...v, accentHex: e.target.value.toLowerCase() });
            }}
          />
        </div>
      </fieldset>
      <Select
        label="Logo on exports and published pages"
        value={v.logo === 'none' ? 'none' : 'workspace'}
        onValueChange={(l) => preview({ ...v, logo: l === 'none' ? 'none' : undefined })}
        options={[
          { value: 'workspace', label: 'Workspace logo' },
          { value: 'none', label: 'No logo' },
        ]}
      />
    </Dialog>
  );
}

/**
 * Present mode's row height: the whole sheet in the window, else it keeps its
 * pitch and scrolls (fitDashPresentRows). The floor is 44 px, not the desktop's
 * 28: a web card's head is 32 px, and a two-row KPI under 44 px rows cut its figure.
 */
export const PRESENT_MIN_ROW = 44;
export function presentRow(rows: number, height: number, gap: number): number | null {
  if (rows < 1) return null;
  const px = Math.floor((height - 1 - (rows - 1) * gap) / rows);
  return px >= PRESENT_MIN_ROW ? px : null;
}

/** As of + the dashboard's currency — shown only when there is something to pick. */
export function ViewControls() {
  const ed = useEditor();
  const cards = ed.doc.sheets.flatMap((p) => p.cards);
  const datasetIds = [...new Set(cards.flatMap((c) => [c.metric?.datasetId, c.visualId ? ed.visuals.get(c.visualId)?.datasetId : undefined]).filter((x): x is string => !!x))];
  const metricIds = [...new Set(cards.map((c) => c.metric?.metricId).filter((x): x is string => !!x))];
  const stamps = useAsOfStamps(ed.projectId, datasetIds, metricIds);
  const fx = useFx(ed.projectId);
  const setCurrency = useSetDashboardCurrency(ed.projectId);
  const items = stamps.data?.items ?? [];
  // "Latest" says how fresh latest is: the sheet's stalest dataset (L0.2).
  const latest = asOfView(stamps.data?.latest);
  const declared = fx.data ? Object.values(fx.data.settings.columns ?? {}).some((c) => c && Object.keys(c).length) : false;
  return (
    <>
      {(items.length > 0 || ed.view.asOf) && (
        <Select
          size="sm"
          aria-label="Show the data as of"
          className={ed.view.asOf ? s.asOfOn : undefined}
          value={ed.view.asOf ?? ''}
          onValueChange={(v) => ed.view.setAsOf(v || null)}
          options={[{ value: '', label: latest ? `Latest · ${latest.text.replace(/^As of/, 'as of')}` : 'Latest' }, ...items.map((it) => ({ value: it.at, label: `As of ${new Date(it.at).toLocaleString()}${datasetIds.length > 1 ? ` — ${it.datasets.join(', ')}` : ''}` }))]}
        />
      )}
      {declared && fx.data && (
        <Select
          size="sm"
          aria-label="This dashboard’s currency"
          value={ed.view.currency ?? ''}
          onValueChange={(code) =>
            setCurrency.mutate({ dashboardId: ed.analysisId, code: code || null }, { onError: (e) => toast(reason(e, 'Could not set the currency.'), { kind: 'error' }) })
          }
          options={[{ value: '', label: `Project (${fx.data.target || fx.data.workspaceCurrency})` }, ...fx.data.codes.map((c) => ({ value: c, label: c }))]}
        />
      )}
    </>
  );
}

/** Export HTML: the dashboard as one self-contained page, built by the server, downloaded. */
export async function exportHtml(ed: EditorApi): Promise<void> {
  ed.save.retry(); // what is on screen is what gets built
  toast('Building HTML…');
  try {
    const r = (await rpc('dashboard:exportHtml', { projectId: ed.projectId, id: ed.analysisId })) as { ok: boolean; downloadToken?: string; error?: string };
    if (!r.ok || !r.downloadToken) throw new Error(reason(r, 'Export failed'));
    startDownload(r.downloadToken);
    toast('HTML saved', { kind: 'success' });
  } catch (err) {
    toast(reason(err, 'Export failed'), { kind: 'error' });
  }
}

/** Above the head: Present's exit and Esc; the comment panel. */
export function DashboardChrome() {
  const ed = useEditor();
  const { presenting, setPresenting } = ed.view;
  useCommentsLive(ed.projectId);
  // A pin drawn on a tile opens its card's threads (the engine's hook; the builder sets its own).
  const open = ed.view.openComments;
  useEffect(() => {
    const prev = annotationHooks.onOpenPin;
    annotationHooks.onOpenPin = (kind, id) => {
      if (kind === 'card') open({ kind: 'card', id });
    };
    return () => {
      annotationHooks.onOpenPin = prev;
    };
  }, [open]);
  useEffect(() => {
    if (!presenting) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !document.querySelector('[role="dialog"]')) {
        e.preventDefault();
        setPresenting(false);
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [presenting, setPresenting]);
  return (
    <>
      {presenting && (
        <div className={s.presentBar}>
          <span className={s.presentName}>{ed.doc.name}</span>
          <Button size="sm" icon="x" onClick={() => setPresenting(false)}>
            Exit presentation
          </Button>
        </div>
      )}
      <CommentsPanel ed={ed} />
    </>
  );
}
