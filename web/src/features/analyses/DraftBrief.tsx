// The BRIEF: the two things settled before the Assistant drafts a dashboard —
// which shape it takes, and which look it gets. No model is asked to draw this;
// it is on screen at once, as DraftFlow's first step and inside the wizard's.
//
// The SHAPE goes to `analysis:draft`, where the server turns it into its own
// sentence for the model (src/analysis/dashboardShapes.ts) — or, left to the
// Assistant, the menu of shapes it picks one from. The LOOK goes to
// `analysis:buildPlan` and nowhere else: a preset id the server applies, never
// something the model is shown. "Workspace default" is no look at all — the
// server then starts the dashboard as Settings says new ones start.

import { PRESETS, styleClass, type DashStyle } from '../dashboards/DashboardChrome';
import { usePrefs } from '../settings/api';
import { AUTO_SHAPE, DASHBOARD_SHAPES, type ShapeBox } from '../../../../src/analysis/dashboardShapes.ts';
import { Icon } from '../../ui/icons/Icon';
import type { DraftShape, LookId } from './api';
import { CardRadios } from './CardRadios';
import s from './Draft.module.css';

export interface Brief {
  /** A shape by id, or "auto" to let the Assistant pick one. */
  shape: DraftShape;
  /** A look by preset id, or '' for the workspace's default. */
  look: LookId | '';
}
export const DEFAULT_BRIEF: Brief = { shape: AUTO_SHAPE, look: '' };

/** A shape's picture (dashboardShapes.ts `art`), in the review sketch's own boxes at the card's width. */
function ShapeArt({ boxes }: { boxes: readonly ShapeBox[] }) {
  return (
    <span className={s.kindArt}>
      {boxes.map(([kind, x, y, w, h], i) => (
        <span key={i} className={`${s.tile} ${s[`tile_${kind}`]}`} style={{ gridColumn: `${x + 1} / span ${w}`, gridRow: `${y + 1} / span ${h}` }} />
      ))}
    </span>
  );
}

// The looks a draft can be pinned to, by preset id (src/analysis/dashboards.ts
// DASHBOARD_STYLE_PRESETS). The three themes carry the Style dialog's own
// words. Dense is not a theme there — it is the app's look at compact density,
// which that dialog sets with its own control — so it is named here. `style` is
// only what the swatch is painted with; the server holds what a look IS.
const LOOKS: { id: LookId; title: string; hint: string; style: DashStyle }[] = [
  ...PRESETS.map((p) => ({ id: p.value, title: p.label, hint: p.hint, style: { theme: p.value, chosen: true as const, ...(p.value === 'executive' ? { accent: 'slate' as const } : {}) } })),
  { id: 'dense', title: 'Dense', hint: 'Compact rows', style: { density: 'compact' } },
];

/** A dashboard in miniature — a strip of KPIs over charts — painted under one look's tokens. */
function Swatch({ style }: { style: DashStyle }) {
  return (
    <span className={`${s.swatch} ${styleClass({ ...style })}`}>
      {Array.from({ length: 8 }, (_, i) => (
        <span key={i} />
      ))}
    </span>
  );
}

export function DraftBrief({ value, onChange }: { value: Brief; onChange: (next: Brief) => void }) {
  // Already in the cache (the shell reads it on load), so this asks nothing. A
  // reply is data: before it lands, or if it is not what it should be, the
  // default simply goes unnamed.
  const prefs = usePrefs().data as { branding?: { dashboardStyle?: unknown } } | null | undefined;
  const mine = LOOKS.find((l) => l.id === prefs?.branding?.dashboardStyle);
  return (
    <div className={s.body}>
      <CardRadios<DraftShape>
        label="Shape"
        hint="How the dashboard is built. Every figure and the takeaway sentence are computed by the app."
        value={value.shape}
        onChange={(shape) => onChange({ ...value, shape })}
        options={[
          {
            value: AUTO_SHAPE,
            title: 'Assistant picks',
            hint: 'The shape that best answers your request.',
            art: (
              <span className={s.autoArt}>
                <Icon name="sparkles" />
              </span>
            ),
          },
          ...DASHBOARD_SHAPES.map((x) => ({ value: x.id as DraftShape, title: x.title, hint: x.hint, art: <ShapeArt boxes={x.art} /> })),
        ]}
      />
      <CardRadios<Brief['look']>
        as="lead"
        label="Look"
        hint="How it is styled. You can change it later from the dashboard’s Style."
        value={value.look}
        onChange={(look) => onChange({ ...value, look })}
        options={[
          { value: '', title: 'Workspace default', hint: mine ? `${mine.title}, from Settings` : 'From Settings', art: <Swatch style={mine ? mine.style : {}} /> },
          // Auto is what a workspace that never chose gets — the default card above.
          ...LOOKS.filter((l) => l.id !== 'auto').map((l) => ({ value: l.id, title: l.title, hint: l.hint, art: <Swatch style={l.style} /> })),
        ]}
      />
    </div>
  );
}
