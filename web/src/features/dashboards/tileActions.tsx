// What a visual TILE does when it is clicked, opened from its ⋯ menu or
// hovered — the runtime of `card.actions` (legacy tileActions.ts, with
// cardModel.ts carrySteps / actionUrl). The actions are authored on the card;
// this is where the dashboard is READ:
//
//   navigate        open another dashboard or sheet, carrying a selection
//   url             open https://…{{value}} in a new tab, the value URL-encoded
//   filter_target   narrow NAMED tiles instead of the whole sheet
//   tooltip_visual  draw another visual, filtered to the hovered mark, in a tooltip
//
// And the selection strip above the sheet (dashSelection.ts): the carried or
// clicked selection as removable chips, the narrowings, "From …" ← Back.

import { useMemo } from 'react';
import { useNavigate } from 'react-router';
import { Button, IconButton } from '../../ui/Button';
import type { MenuEntry } from '../../ui/Menu';
import { toast } from '../../ui/Toast';
import { Icon } from '../../ui/icons/Icon';
import { useTile, type Card, type Step, type VisualDef, type VisualTile } from '../analyses/api';
import type { EditorApi } from '../analyses/editor/context';
import { DrawnVisual, mergeFilters, vizLabel } from '../analyses/VisualTile';
import { stashNavigation, stepKey } from './useViewer';
import s from './Dashboards.module.css';

export interface TileAction {
  kind: 'navigate' | 'url' | 'filter_target' | 'tooltip_visual';
  trigger?: 'click' | 'menu';
  label?: string;
  carry?: 'clicked_value' | 'all_selection' | 'none';
  target?: { analysisId?: string; page?: string };
  url?: string;
  tiles?: string[];
  tooltipVisualId?: string;
}

export const actionsOf = (card: Card): TileAction[] => (card.type === 'visual' && Array.isArray(card.actions) ? (card.actions as TileAction[]) : []);

/** The https:// address a `url` action opens, `{{value}}` URL-encoded (cardModel.actionUrl). */
export function actionUrl(template: unknown, value: unknown): { ok: true; url: string } | { ok: false; error: string } {
  const t = typeof template === 'string' ? template.trim() : '';
  if (!t) return { ok: false, error: 'Enter an https:// address.' };
  const filled = t.replace(/\{\{\s*value\s*\}\}/g, encodeURIComponent(value == null ? '' : String(value)));
  let u: URL;
  try {
    u = new URL(filled);
  } catch {
    return { ok: false, error: 'That is not a web address.' };
  }
  if (u.protocol !== 'https:' || !u.hostname) return { ok: false, error: 'Only https:// links can open from a dashboard.' };
  return { ok: true, url: u.href };
}

/**
 * What an action carries, as filter steps (cardModel.carrySteps): nothing; the
 * clicked mark's `column = value`; or the sheet's filters and selection then
 * the click — a click on a column the sheet already filters by `=` REPLACES it.
 */
export function carrySteps(action: TileAction, clicked: { column: string; value: unknown } | null, filters: readonly Step[]): Step[] {
  const click: Step[] = clicked && clicked.column && clicked.value !== undefined ? [{ type: 'filter', column: clicked.column, op: '=', value: clicked.value }] : [];
  const mode = action.carry === 'none' || action.carry === 'all_selection' ? action.carry : 'clicked_value';
  if (mode === 'none') return [];
  if (mode === 'clicked_value') return click;
  const replaced = new Set(click.map((x) => x.column));
  const seen = new Set<string>();
  const out: Step[] = [];
  for (const st of filters) {
    if (!st || st.type !== 'filter' || typeof st.column !== 'string') continue;
    if (replaced.has(st.column) && st.op === '=') continue;
    const k = stepKey(st);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(st);
  }
  return [...out, ...click];
}

export function actionLabel(a: TileAction): string {
  if (a.label) return a.label;
  if (a.kind === 'navigate') return 'Open linked dashboard';
  if (a.kind === 'url') return 'Open link';
  if (a.kind === 'filter_target') return 'Narrow linked tiles';
  return 'Show tooltip visual';
}

/** Runs one action, from a click (with the mark's category) or the menu (without). */
export function useRunAction(ed: EditorApi) {
  const navigate = useNavigate();
  return (action: TileAction, card: Card, def: VisualDef | undefined, category?: string | number) => {
    const column = def?.encoding.category;
    const clicked = category !== undefined && column ? { column, value: category } : null;
    if (action.kind === 'navigate') {
      const to = action.target?.analysisId;
      if (!to) return void toast('This action has no dashboard to open.');
      const steps = carrySteps(action, clicked, ed.filters);
      if (to === ed.analysisId) {
        const i = action.target?.page ? ed.doc.sheets.findIndex((p) => p.id === action.target?.page) : -1;
        if (i >= 0) ed.setSheet(i);
        ed.view.addSelection(steps);
        return;
      }
      // The autosave flushes on the way out (Editor's unmount); the target opens with the carry and a way back.
      stashNavigation({ to, carry: steps, crumb: { fromId: ed.analysisId, fromName: ed.doc.name, fromSheet: ed.doc.sheets[ed.sheet]?.id }, sheet: action.target?.page });
      void navigate(`/analyses/${ed.projectId}/${to}`);
      return;
    }
    if (action.kind === 'url') {
      const r = actionUrl(action.url, category === undefined ? '' : category);
      if (!r.ok) return void toast(r.error, { kind: 'error' });
      window.open(r.url, '_blank', 'noopener,noreferrer');
      return;
    }
    if (action.kind === 'filter_target') {
      const tiles = (action.tiles ?? []).filter((t) => t !== card.id);
      if (!tiles.length) return void toast('This action has no tiles to narrow.');
      ed.view.narrow(tiles, clicked ? [{ type: 'filter', column: clicked.column, op: '=', value: clicked.value }] : carrySteps(action, null, ed.filters));
    }
  };
}

/** The ⋯-menu entries of a tile's `menu`-triggered actions. */
export function actionMenu(card: Card, def: VisualDef | undefined, run: ReturnType<typeof useRunAction>): MenuEntry[] {
  return actionsOf(card)
    .filter((a) => a.trigger === 'menu' && a.kind !== 'tooltip_visual')
    .map((a) => ({ label: actionLabel(a), icon: a.kind === 'url' ? 'external-link' : a.kind === 'navigate' ? 'arrow-right' : 'filter', onSelect: () => run(a, card, def) }));
}

/** tooltip_visual: another visual, filtered to the hovered mark, drawn beside the pointer. */
export function TooltipVisual({ ed, tip, column, category, at }: { ed: EditorApi; tip: VisualDef | undefined; column: string; category: string | number; at: { x: number; y: number } }) {
  const req = useMemo(
    () =>
      tip
        ? {
            kind: 'visual' as const,
            datasetId: tip.datasetId,
            encoding: tip.encoding,
            filters: [...mergeFilters(ed.filters, tip.filters), ...(column ? [{ type: 'filter', column, op: '=', value: category }] : [])],
          }
        : undefined,
    [tip, ed.filters, column, category],
  );
  const q = useTile<VisualTile>(ed.projectId, ed.params, req);
  const x = Math.min(at.x + 16, window.innerWidth - 288);
  const y = Math.min(at.y + 16, window.innerHeight - 220);
  return (
    <div className={s.tip} role="tooltip" style={{ left: x, top: y }}>
      <div className={s.tipHead}>{String(category)}</div>
      {!tip ? (
        <p className={s.tipNote}>The tooltip visual was deleted.</p>
      ) : q.data && q.data.ok ? (
        <>
          <div className={s.tipSub}>{tip.name || vizLabel(tip.chartType)}</div>
          <div className={s.tipChart}>
            <DrawnVisual type={tip.chartType.startsWith('map_') ? 'column' : tip.chartType} data={q.data.data} overrides={{ showLegend: false, valueMode: 'off', noAnimate: true, showTooltips: false }} label={tip.name} projectId={ed.projectId} />
          </div>
        </>
      ) : (
        <p className={s.tipNote}>{q.isPending ? 'Loading…' : `No data for ${String(category)}`}</p>
      )}
    </div>
  );
}

/** One filter step as a chip's words (dashSelStepLabel). */
export function stepLabel(st: Step): string {
  if (st.op === 'period') return `${String(st.column)}: a period`;
  if (Array.isArray(st.values)) return `${String(st.column)}${st.op === 'not in' ? ' not' : ''}: ${st.values.join(', ')}`;
  const sign: Record<string, string> = { '!=': '≠', '>=': '≥', '<=': '≤' };
  const v = st.value == null ? '' : String(st.value as string);
  return st.op === '=' ? `${String(st.column)} = ${v}` : `${String(st.column)} ${sign[String(st.op)] || String(st.op)} ${v}`.trim();
}

export function SelectionStrip({ ed }: { ed: EditorApi }) {
  const v = ed.view;
  const navigate = useNavigate();
  const groups = new Map<string, { steps: Step[]; tiles: string[] }>();
  for (const [tile, steps] of v.narrowed) {
    const k = JSON.stringify(steps.map(stepKey));
    const g = groups.get(k) ?? { steps, tiles: [] };
    g.tiles.push(tile);
    groups.set(k, g);
  }
  if (!v.crumb && !v.selection.length && !groups.size) return null;
  const back = () => {
    const c = v.crumb;
    if (!c) return;
    stashNavigation({ to: c.fromId, carry: [], crumb: null, sheet: c.fromSheet });
    void navigate(`/analyses/${ed.projectId}/${c.fromId}`);
  };
  return (
    <div className={s.selStrip} role="region" aria-label="Selection">
      {v.crumb && (
        <nav className={s.crumb} aria-label="Breadcrumb">
          <Button size="sm" icon="arrow-left" aria-label={`Back to ${v.crumb.fromName}`} onClick={back}>
            Back
          </Button>
          <span className={s.crumbFrom}>From {v.crumb.fromName}</span>
        </nav>
      )}
      {(v.selection.length > 0 || groups.size > 0) && <span className={s.selLabel}>Selection</span>}
      {v.selection.map((st) => (
        <span key={stepKey(st)} className={s.chip}>
          <span>{stepLabel(st)}</span>
          <IconButton icon="x" size="sm" label={`Remove selection ${stepLabel(st)}`} onClick={() => v.removeSelection(st)} />
        </span>
      ))}
      {[...groups.values()].map((g) => (
        <span key={JSON.stringify(g.steps.map(stepKey))} className={`${s.chip} ${s.chipNarrow}`}>
          <Icon name="filter" size={12} />
          <span>
            {g.steps.map(stepLabel).join(', ')} · {g.tiles.length === 1 ? '1 tile' : `${g.tiles.length} tiles`}
          </span>
          <IconButton icon="x" size="sm" label="Stop narrowing those tiles" onClick={() => v.unnarrow(g.tiles)} />
        </span>
      ))}
      {v.selection.length + v.narrowed.size > 1 && (
        <Button size="sm" variant="ghost" onClick={v.clearSelection}>
          Clear selection
        </Button>
      )}
    </div>
  );
}
